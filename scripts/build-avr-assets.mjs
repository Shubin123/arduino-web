// SPDX-License-Identifier: AGPL-3.0-or-later
// Precompiles the Arduino AVR core and bundled libraries with the native
// Arduino avr-gcc toolchain, and records the exact flags the native GCC driver
// passes to cc1plus/as/ld so the WebAssembly builds of those same tools can be
// driven identically in the browser.
//
// Inputs (installed with `arduino-cli core install arduino:avr@1.8.8`):
//   ARDUINO_AVR_CORE  path to packages/arduino/hardware/avr/1.8.8
//   ARDUINO_AVR_GCC   path to packages/arduino/tools/avr-gcc/7.3.0-atmel3.6.1-arduino7
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { encodePack } from './pack.mjs';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const data = path.join(root, '.runtime', 'data', 'packages', 'arduino');
const candidateCores = [
  process.env.ARDUINO_AVR_CORE,
  path.join(homedir(), '.arduino15', 'packages', 'arduino', 'hardware', 'avr', '1.8.8'),
  path.join(homedir(), 'Library', 'Arduino15', 'packages', 'arduino', 'hardware', 'avr', '1.8.8'),
  path.join(data, 'hardware', 'avr', '1.8.8'),
].filter(Boolean);
const core = candidateCores.find(existsSync) || candidateCores[0];

const candidateGccs = [
  process.env.ARDUINO_AVR_GCC,
  path.join(homedir(), '.arduino15', 'packages', 'arduino', 'tools', 'avr-gcc', '7.3.0-atmel3.6.1-arduino7'),
  path.join(homedir(), 'Library', 'Arduino15', 'packages', 'arduino', 'tools', 'avr-gcc', '7.3.0-atmel3.6.1-arduino7'),
  path.join(data, 'tools', 'avr-gcc', '7.3.0-atmel3.6.1-arduino7'),
].filter(Boolean);
const gcc = candidateGccs.find(existsSync) || candidateGccs[0];
const out = path.join(root, 'web', 'public', 'avr');
const bin = (tool) => path.join(gcc, 'bin', `avr-${tool}`);
const CORE_VERSION = '1.8.8';
const IDE_VERSION = '10607';

const usbFlags = (pid, product) => [
  '-DUSB_VID=0x2341',
  `-DUSB_PID=${pid}`,
  '-DUSB_MANUFACTURER="Unknown"',
  `-DUSB_PRODUCT="${product}"`,
];

// Values copied from boards.txt of Arduino AVR Boards 1.8.8.
const profiles = {
  uno: { mcu: 'atmega328p', variant: 'standard', board: 'AVR_UNO', extra: [] },
  nano: { mcu: 'atmega328p', variant: 'eightanaloginputs', board: 'AVR_NANO', extra: [] },
  mega: { mcu: 'atmega2560', variant: 'mega', board: 'AVR_MEGA2560', extra: [] },
  leonardo: { mcu: 'atmega32u4', variant: 'leonardo', board: 'AVR_LEONARDO', extra: usbFlags('0x8036', 'Arduino Leonardo') },
  micro: { mcu: 'atmega32u4', variant: 'micro', board: 'AVR_MICRO', extra: usbFlags('0x8037', 'Arduino Micro') },
};

const boards = [
  {
    id: 'uno', name: 'Arduino UNO', fqbn: 'arduino:avr:uno', profile: 'uno',
    upload: { protocol: 'stk500v1', speed: 115200 }, maximumSize: 32256, maximumDataSize: 2048,
    usb: [[0x2341, 0x0043], [0x2341, 0x0001], [0x2a03, 0x0043], [0x2341, 0x0243], [0x2341, 0x006a]],
  },
  {
    id: 'nano', name: 'Arduino Nano', fqbn: 'arduino:avr:nano', profile: 'nano',
    upload: { protocol: 'stk500v1', speed: 115200 }, maximumSize: 30720, maximumDataSize: 2048, usb: [],
    options: {
      cpu: {
        label: 'Processor',
        values: [
          { id: 'atmega328', label: 'ATmega328P', upload: { speed: 115200 } },
          { id: 'atmega328old', label: 'ATmega328P (Old Bootloader)', upload: { speed: 57600 } },
        ],
      },
    },
  },
  {
    id: 'mega', name: 'Arduino Mega or Mega 2560', fqbn: 'arduino:avr:mega:cpu=atmega2560', profile: 'mega',
    upload: { protocol: 'stk500v2', speed: 115200 }, maximumSize: 253952, maximumDataSize: 8192,
    usb: [[0x2341, 0x0010], [0x2341, 0x0042], [0x2a03, 0x0010], [0x2a03, 0x0042], [0x2341, 0x0210], [0x2341, 0x0242]],
  },
  {
    id: 'leonardo', name: 'Arduino Leonardo', fqbn: 'arduino:avr:leonardo', profile: 'leonardo',
    upload: { protocol: 'avr109', speed: 57600, touch1200: true, bootloaderPids: [0x0036] },
    maximumSize: 28672, maximumDataSize: 2560,
    usb: [[0x2341, 0x0036], [0x2341, 0x8036], [0x2a03, 0x0036], [0x2a03, 0x8036]],
  },
  {
    id: 'micro', name: 'Arduino Micro', fqbn: 'arduino:avr:micro', profile: 'micro',
    upload: { protocol: 'avr109', speed: 57600, touch1200: true, bootloaderPids: [0x0037] },
    maximumSize: 28672, maximumDataSize: 2560,
    usb: [[0x2341, 0x0037], [0x2341, 0x8037], [0x2a03, 0x0037], [0x2a03, 0x8037]],
  },
];

const signatures = { atmega328p: [0x1e, 0x95, 0x0f], atmega2560: [0x1e, 0x98, 0x01], atmega32u4: [0x1e, 0x95, 0x87] };
const pageSizes = { atmega328p: 128, atmega2560: 256, atmega32u4: 128 };

function run(file, args, options = {}) {
  return execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options });
}

async function walk(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full)));
    else files.push(full);
  }
  return files;
}

// Parse the shell-quoted command lines printed by `avr-gcc -###`.
function tokens(line) {
  return [...line.matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)].map((m) => (m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2]));
}

function captureFlags(mcu, work) {
  const probe = path.join(work, 'probe.cpp');
  const stderr = execFileSync('sh', ['-c', `"${bin('g++')}" -### -mmcu=${mcu} -c "${probe}" -o "${path.join(work, 'probe.o')}" 2>&1`], { encoding: 'utf8' });
  const ccLine = stderr.split('\n').find((line) => /\/cc1plus"? /.test(line));
  const asLine = stderr.split('\n').find((line) => /\/as"? /.test(line));
  const cc = tokens(ccLine).slice(1);
  const drop = new Set(['-iprefix', '-dumpbase', '-auxbase-strip', '-o']);
  const cc1plus = [];
  for (let i = 0; i < cc.length; i++) {
    if (drop.has(cc[i])) { i++; continue; }
    if (cc[i] === probe || cc[i] === '-quiet') continue;
    if (!cc1plus.includes(cc[i]) || cc[i].startsWith('-D') || cc[i] === '-imultilib') cc1plus.push(cc[i]);
  }
  const as = tokens(asLine).slice(1).filter((arg, i, all) => arg.startsWith('-m') && all[i - 1] !== '-o');
  const link = execFileSync('sh', ['-c', `"${bin('gcc')}" -### -mmcu=${mcu} -Wl,--gc-sections "${path.join(work, 'probe.o')}" -o x.elf 2>&1`], { encoding: 'utf8' });
  const ld = tokens(link.split('\n').find((line) => /collect2"? /.test(line))).slice(1);
  const emulation = ld.find((arg) => /^-mavr/.test(arg)).slice(2);
  const dataStart = ld[ld.indexOf('-Tdata') + 1];
  const crt = path.basename(ld.find((arg) => /crt[^/]+\.o$/.test(arg)));
  const libs = ld.filter((arg) => /^-l/.test(arg));
  return { cc1plus, as, ld: { emulation, dataStart, crt, libs }, multilib: cc1plus[cc1plus.indexOf('-imultilib') + 1] };
}

async function main() {
  const work = await mkdtemp(path.join(tmpdir(), 'avr-assets-'));
  await writeFile(path.join(work, 'probe.cpp'), 'int main() { return 0; }\n');
  await writeFile(path.join(work, 'probe.o'), '');
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  const builtinLibraries = (await readdir(path.join(core, 'libraries'))).sort();
  const includeFlags = (variant) => [
    '-I', path.join(core, 'cores', 'arduino'),
    '-I', path.join(core, 'variants', variant),
    ...builtinLibraries.flatMap((name) => ['-I', path.join(core, 'libraries', name, 'src')]),
  ];

  // Shared header sysroot: generic avr-libc headers, GCC headers, the core,
  // the used variants, and built-in library headers. Device headers are only
  // included for the MCUs we support (discovered from the preprocessor).
  const sysroot = new Map();
  const add = (virtual, bytes) => sysroot.set(virtual, bytes);
  const avrInclude = path.join(gcc, 'avr', 'include');
  const gccInclude = path.join(gcc, 'lib', 'gcc', 'avr', '7.3.0');
  for (const file of await walk(avrInclude)) {
    const rel = path.relative(avrInclude, file);
    if (/^avr\/io[^/]*\.h$/.test(rel) && rel !== 'avr/io.h') continue;
    add(`/sysroot/avr/include/${rel}`, await readFile(file));
  }
  for (const dir of ['include', 'include-fixed']) {
    for (const file of await walk(path.join(gccInclude, dir))) add(`/sysroot/gcc/${dir}/${path.relative(path.join(gccInclude, dir), file)}`, await readFile(file));
  }
  const mcus = [...new Set(Object.values(profiles).map((p) => p.mcu))];
  for (const mcu of mcus) {
    const deps = run(bin('gcc'), ['-M', `-mmcu=${mcu}`, '-x', 'c', '-'], { input: '#include <avr/io.h>\n#include <avr/eeprom.h>\n#include <avr/boot.h>\n', stdio: ['pipe', 'pipe', 'pipe'] });
    for (const dep of deps.replace(/\\\n/g, ' ').split(/\s+/)) {
      const full = path.resolve(dep);
      if (full.startsWith(avrInclude + path.sep)) add(`/sysroot/avr/include/${path.relative(avrInclude, full)}`, await readFile(full));
    }
  }
  const sourceTree = new Map();
  const usedVariants = new Set(Object.values(profiles).map((p) => p.variant));
  for (const sub of ['cores/arduino', ...[...usedVariants].map((v) => `variants/${v}`), 'libraries']) {
    for (const file of await walk(path.join(core, sub))) {
      const rel = path.relative(core, file);
      const bytes = await readFile(file);
      if (/\.(h|hpp)$|\/new$/.test(rel)) add(`/arduino/${rel}`, bytes);
      sourceTree.set(rel, bytes);
    }
  }
  await writeFile(path.join(out, 'sysroot.pack'), encodePack([...sysroot].sort()));

  // Keep the complete LGPL source of the core alongside its object code.
  const sourceDir = path.join(root, 'web', 'public', 'third_party', `ArduinoCore-avr-${CORE_VERSION}`);
  await rm(sourceDir, { recursive: true, force: true });
  for (const sub of ['cores', 'variants', 'libraries', 'boards.txt', 'platform.txt', 'programmers.txt', 'README.md']) {
    await cp(path.join(core, sub), path.join(sourceDir, sub), { recursive: true });
  }
  await cp(path.join(root, 'licenses', 'LGPL-2.1.txt'), path.join(sourceDir, 'COPYING.LGPL-2.1.txt'));

  const manifest = { core: { version: CORE_VERSION, ideVersion: IDE_VERSION }, sysroot: 'sysroot.pack', multilibs: {}, profiles: {}, boards: [], builtinLibraries: [] };
  for (const name of builtinLibraries) {
    const headers = (await readdir(path.join(core, 'libraries', name, 'src'))).filter((f) => f.endsWith('.h'));
    manifest.builtinLibraries.push({ name, headers, include: `/arduino/libraries/${name}/src` });
  }

  const multilibFiles = new Map();
  for (const [id, profile] of Object.entries(profiles)) {
    const flags = captureFlags(profile.mcu, work);
    const defines = [`-DF_CPU=16000000L`, `-DARDUINO=${IDE_VERSION}`, `-DARDUINO_${profile.board}`, '-DARDUINO_ARCH_AVR', ...profile.extra];
    const objDir = path.join(work, id);
    await mkdir(objDir, { recursive: true });
    const compileNative = (source, object) => {
      const isC = source.endsWith('.c');
      const isAsm = source.endsWith('.S');
      const common = ['-c', '-Os', '-w', `-mmcu=${profile.mcu}`, ...defines, ...includeFlags(profile.variant), source, '-o', object];
      if (isAsm) run(bin('gcc'), ['-x', 'assembler-with-cpp', ...common]);
      else if (isC) run(bin('gcc'), ['-std=gnu11', '-ffunction-sections', '-fdata-sections', ...common]);
      else run(bin('g++'), ['-std=gnu++11', '-fpermissive', '-fno-exceptions', '-ffunction-sections', '-fdata-sections', '-fno-threadsafe-statics', '-Wno-error=narrowing', ...common]);
    };
    const archive = async (name, sources) => {
      const objects = [];
      for (const source of sources) {
        const object = path.join(objDir, `${name}-${path.basename(source)}.o`);
        compileNative(source, object);
        objects.push(object);
      }
      const file = path.join(objDir, `${name}.a`);
      run(bin('ar'), ['rcs', file, ...objects]);
      run(bin('strip'), ['--strip-debug', file]);
      return readFile(file);
    };
    const coreSources = (await readdir(path.join(core, 'cores', 'arduino'))).filter((f) => /\.(c|cpp|S)$/.test(f)).map((f) => path.join(core, 'cores', 'arduino', f));
    const files = [['/board/core.a', await archive('core', coreSources)]];
    const libraries = [];
    for (const name of builtinLibraries) {
      const sources = (await walk(path.join(core, 'libraries', name, 'src'))).filter((f) => /\.(c|cpp|S)$/.test(f));
      if (!sources.length) continue;
      files.push([`/board/lib${name}.a`, await archive(name, sources)]);
      libraries.push(`/board/lib${name}.a`);
    }
    await writeFile(path.join(out, `core-${id}.pack`), encodePack(files));

    if (!multilibFiles.has(flags.multilib)) {
      const libDir = path.join(gcc, 'avr', 'lib', flags.multilib);
      const entries = [];
      for (const name of ['libc.a', 'libm.a']) entries.push([`/lib/${name}`, await readFile(path.join(libDir, name))]);
      const libgcc = path.join(objDir, 'libgcc.a');
      await cp(path.join(gccInclude, flags.multilib, 'libgcc.a'), libgcc);
      run(bin('strip'), ['--strip-debug', libgcc]);
      entries.push(['/lib/libgcc.a', await readFile(libgcc)]);
      for (const file of await readdir(libDir)) {
        if (/^crt.+\.o$|^libatmega.+\.a$|^libat.+\.a$/.test(file) && mcus.some((m) => file.includes(m))) entries.push([`/lib/${file}`, await readFile(path.join(libDir, file))]);
      }
      const scripts = path.join(gcc, 'avr', 'lib', 'ldscripts');
      for (const file of await readdir(scripts)) {
        if (file.startsWith(`${flags.multilib}.`)) entries.push([`/ldscripts/${file}`, await readFile(path.join(scripts, file))]);
      }
      multilibFiles.set(flags.multilib, entries);
    }
    manifest.profiles[id] = {
      mcu: profile.mcu,
      variant: profile.variant,
      pack: `core-${id}.pack`,
      multilib: flags.multilib,
      defines,
      includes: ['/arduino/cores/arduino', `/arduino/variants/${profile.variant}`],
      cc1plus: flags.cc1plus,
      as: flags.as,
      ld: flags.ld,
      libraries,
      signature: signatures[profile.mcu],
      pageSize: pageSizes[profile.mcu],
    };
  }
  for (const [multilib, entries] of multilibFiles) {
    await writeFile(path.join(out, `lib-${multilib}.pack`), encodePack(entries));
    manifest.multilibs[multilib] = `lib-${multilib}.pack`;
  }
  manifest.boards = boards;
  manifest.keywords = await keywords();
  manifest.toolchain = await toolchainIntegrity();
  await writeFile(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  await rm(work, { recursive: true, force: true });
  console.log(`AVR assets written to ${path.relative(root, out)}`);
}

// Arduino API identifiers for editor completion, from the core's keywords.txt files.
async function keywords() {
  const words = new Set();
  const files = [path.join(core, 'keywords.txt'), ...(await walk(path.join(core, 'libraries'))).filter((f) => f.endsWith('keywords.txt'))];
  for (const file of files) {
    let text;
    try { text = await readFile(file, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      const word = line.split(/\s+/)[0];
      if (/^[A-Za-z_]\w*$/.test(word)) words.add(word);
    }
  }
  return [...words].sort();
}

// Subresource-integrity hashes for the WebAssembly toolchain fetched from the CDN.
async function toolchainIntegrity() {
  const pkgDir = path.join(root, 'node_modules', '@horang-corp', 'avr-gcc-wasm');
  const pkg = JSON.parse(await readFile(path.join(pkgDir, 'package.json'), 'utf8'));
  const files = {};
  for (const tool of ['cc1plus', 'avr-as', 'avr-ld', 'avr-objcopy']) {
    for (const ext of ['mjs', 'wasm']) {
      const rel = `tools/${tool}.${ext}`;
      files[rel] = 'sha384-' + createHash('sha384').update(await readFile(path.join(pkgDir, rel))).digest('base64');
    }
  }
  return { package: pkg.name, version: pkg.version, base: `https://cdn.jsdelivr.net/npm/${pkg.name}@${pkg.version}/`, files };
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
