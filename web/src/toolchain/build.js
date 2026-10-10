// SPDX-License-Identifier: AGPL-3.0-or-later
// Builds an Arduino sketch with the WebAssembly builds of GCC (cc1plus) and
// GNU binutils (as, ld, objcopy), linking against the Arduino core that was
// precompiled by scripts/build-avr-assets.mjs. Environment-neutral: the caller
// supplies `loadPack(name)` and `runTool(name, args, inputs, outputPath)`.
import { includedHeaders, preprocessSketch } from './preprocess.js';
import { programSize } from './binary.js';

const WARNINGS = { none: ['-w'], default: [], more: ['-Wall'], all: ['-Wall', '-Wextra'] };
const CPP_FLAGS = ['-Os', '-std=gnu++11', '-fpermissive', '-fno-exceptions', '-ffunction-sections', '-fdata-sections', '-fno-threadsafe-statics', '-Wno-error=narrowing'];
const SOURCE = /\.(cpp|cc|cxx|c)$/;
const encoder = new TextEncoder();
const bytesOf = (value) => (typeof value === 'string' ? encoder.encode(value) : value);

export class BuildError extends Error {
  constructor(message, diagnostics = []) {
    super(message);
    this.diagnostics = diagnostics;
  }
}

export function parseDiagnostics(lines) {
  const diagnostics = [];
  for (const line of lines) {
    const m = line.match(/^(.*?):(\d+):(?:(\d+):)?\s*(fatal error|error|warning|note):\s*(.*)$/);
    if (m) diagnostics.push({ file: m[1].replace(/^\/sketch\//, ''), line: Number(m[2]), column: Number(m[3] || 1), severity: m[4] === 'fatal error' ? 'error' : m[4], message: m[5] });
  }
  return diagnostics;
}

// Library layout as defined by the Arduino library specification (1.0 flat, 1.5 src/).
export function libraryLayout(library) {
  const files = Object.keys(library.files);
  const recursive = files.some((f) => f.startsWith('src/'));
  const root = recursive ? 'src/' : '';
  const headers = files.filter((f) => f.startsWith(root) && !f.slice(root.length).includes('/') && /\.(h|hpp|hh)$/.test(f)).map((f) => f.slice(root.length));
  const sources = files.filter((f) => SOURCE.test(f) && (recursive ? f.startsWith('src/') : !f.includes('/') || f.startsWith('utility/')));
  const includes = recursive ? [`src`] : ['', 'utility'];
  return { headers, sources, includes };
}

async function digest(...parts) {
  const data = encoder.encode(parts.join('\u0000'));
  const hash = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * @param {object} o
 * @param {Record<string,string>} o.files sketch files by relative path
 * @param {string} o.sketchName main .ino without extension
 * @param {object} o.manifest avr/manifest.json
 * @param {string} o.boardId board id from the manifest
 * @param {Array<{name:string,version:string,files:Record<string,string|Uint8Array>}>} o.libraries installed user libraries
 */
export async function buildSketch({ files, sketchName, manifest, boardId, libraries = [], warnings = 'default', verbose = false, loadPack, runTool, log = () => {}, cache = new Map() }) {
  const board = manifest.boards.find((b) => b.id === boardId);
  if (!board) throw new BuildError(`Board ${boardId} is not supported by the in-browser compiler`);
  const profile = manifest.profiles[board.profile];
  const [sysroot, corePack, libPack] = await Promise.all([loadPack(manifest.sysroot), loadPack(profile.pack), loadPack(manifest.multilibs[profile.multilib])]);

  // Sketch sources: merged .ino plus .c/.cpp in the sketch root and src/ (recursive).
  const sketchFiles = new Map(Object.entries(files).map(([name, content]) => [`/sketch/${name}`, bytesOf(content)]));
  const sources = [[`/sketch/${sketchName}.ino.cpp`, preprocessSketch(files, `${sketchName}.ino`), 'sketch']];
  for (const [name, content] of Object.entries(files)) {
    if (SOURCE.test(name) && (!name.includes('/') || name.startsWith('src/'))) sources.push([`/sketch/${name}`, content, 'sketch']);
  }

  // Resolve libraries from #include directives, transitively.
  const libraryInfo = libraries.map((lib) => ({ lib, ...libraryLayout(lib), dir: `/libraries/${lib.name.replace(/[^\w.-]/g, '_')}` }));
  const builtinHeaders = new Map();
  for (const lib of manifest.builtinLibraries) for (const header of lib.headers) builtinHeaders.set(header, lib.name);
  const sketchHeaders = new Set(Object.keys(files));
  const used = new Map();
  const pending = sources.map(([, text]) => text);
  const builtinUsed = new Set();
  while (pending.length) {
    for (const header of includedHeaders(pending.pop())) {
      if (sketchHeaders.has(header)) continue;
      const found = libraryInfo.find((info) => info.headers.includes(header));
      if (found && !used.has(found.lib.name)) {
        used.set(found.lib.name, found);
        for (const file of found.sources) pending.push(typeof found.lib.files[file] === 'string' ? found.lib.files[file] : new TextDecoder().decode(found.lib.files[file]));
        for (const [file, content] of Object.entries(found.lib.files)) if (/\.(h|hpp|hh)$/.test(file)) pending.push(typeof content === 'string' ? content : new TextDecoder().decode(content));
      } else if (!found && builtinHeaders.has(header)) builtinUsed.add(builtinHeaders.get(header));
    }
  }
  const libraryFiles = new Map();
  const libraryIncludes = [];
  for (const info of used.values()) {
    for (const [file, content] of Object.entries(info.lib.files)) libraryFiles.set(`${info.dir}/${file}`, bytesOf(content));
    for (const include of info.includes) libraryIncludes.push(include ? `${info.dir}/${include}` : info.dir);
    for (const file of info.sources) sources.push([`${info.dir}/${file}`, info.lib.files[file], info.lib.name]);
    log(`Using library ${info.lib.name} at version ${info.lib.version || 'unknown'}\n`);
  }
  for (const name of builtinUsed) log(`Using library ${name} (built-in Arduino AVR Boards ${manifest.core.version})\n`);

  const includeArgs = [
    '-isystem', '/sysroot/gcc/include', '-isystem', '/sysroot/gcc/include-fixed', '-isystem', '/sysroot/avr/include',
    '-I', '/sketch',
    ...profile.includes.flatMap((dir) => ['-I', dir]),
    ...manifest.builtinLibraries.flatMap((lib) => ['-I', lib.include]),
    ...libraryIncludes.flatMap((dir) => ['-I', dir]),
  ];
  const baseInputs = new Map([...sysroot, ...sketchFiles, ...libraryFiles]);
  const objects = [];
  const diagnostics = [];
  let index = 0;
  for (const [path, content, owner] of sources) {
    const isC = path.endsWith('.c');
    let text = typeof content === 'string' ? content : new TextDecoder().decode(content);
    // cc1 (the C front end) is not available as WebAssembly, so C sources are
    // compiled by the C++ front end with C linkage.
    if (isC) text = `extern "C" {\n#line 1 "${path}"\n${text}\n}\n`;
    const unit = isC ? `${path}.cpp` : path;
    const args = [...profile.cc1plus, '-quiet', ...CPP_FLAGS, ...(WARNINGS[warnings] || []), ...profile.defines, ...includeArgs, unit, '-o', '/build/unit.s'];
    const key = await digest(boardId, warnings, unit, text, owner === 'sketch' ? JSON.stringify([...sketchFiles.keys()].map((f) => [f, files[f.slice(8)]])) : owner);
    let object = cache.get(key);
    if (!object) {
      log(verbose ? `cc1plus ${args.join(' ')}\n` : `Compiling ${path.replace(/^\/(sketch|libraries)\//, '')}\n`);
      const inputs = new Map(baseInputs);
      inputs.set(unit, encoder.encode(text));
      const cc = await runTool('cc1plus', args, inputs, '/build/unit.s');
      const found = parseDiagnostics(cc.stderr);
      diagnostics.push(...found);
      if (cc.stderr.length) log(cc.stderr.join('\n') + '\n');
      if (cc.status !== 0 || !cc.output) throw new BuildError(`Compilation error: ${found.find((d) => d.severity === 'error')?.message || 'compiler exited with status ' + cc.status}`, diagnostics);
      const as = await runTool('avr-as', [...profile.as, '-o', '/build/unit.o', '/build/unit.s'], new Map([['/build/unit.s', cc.output]]), '/build/unit.o');
      if (as.status !== 0 || !as.output) throw new BuildError(`Assembler error: ${as.stderr.join('\n')}`, diagnostics);
      object = as.output;
      if (owner !== 'sketch') cache.set(key, object);
    } else log(`Using previously compiled ${path.replace(/^\/(sketch|libraries)\//, '')}\n`);
    objects.push([`/build/obj${index++}.o`, object]);
  }

  log('Linking everything together...\n');
  const linkInputs = new Map([...libPack, ...corePack, ...objects]);
  const ldArgs = [
    '-m', profile.ld.emulation, '-Tdata', profile.ld.dataStart, '--gc-sections', '-o', '/build/sketch.elf',
    `/lib/${profile.ld.crt}`, ...objects.map(([file]) => file), '-L/lib',
    '--start-group', ...profile.libraries, '/board/core.a', ...profile.ld.libs, '--end-group',
  ];
  if (verbose) log(`ld ${ldArgs.join(' ')}\n`);
  const ld = await runTool('avr-ld', ldArgs, linkInputs, '/build/sketch.elf');
  if (ld.status !== 0 || !ld.output) {
    const message = ld.stderr.join('\n');
    log(message + '\n');
    throw new BuildError(`Link error: ${message.split('\n').find((l) => /undefined reference|multiple definition|error/i.test(l)) || message}`, diagnostics);
  }
  const elf = ld.output;
  const objcopy = await runTool('avr-objcopy', ['-O', 'ihex', '-R', '.eeprom', '/build/sketch.elf', '/build/sketch.hex'], new Map([['/build/sketch.elf', elf]]), '/build/sketch.hex');
  if (objcopy.status !== 0 || !objcopy.output) throw new BuildError(`objcopy failed: ${objcopy.stderr.join('\n')}`, diagnostics);
  const hex = new TextDecoder().decode(objcopy.output);
  const size = programSize(elf);
  const pct = (a, b) => Math.floor((a * 100) / b);
  log(`Sketch uses ${size.flash} bytes (${pct(size.flash, board.maximumSize)}%) of program storage space. Maximum is ${board.maximumSize} bytes.\n`);
  log(`Global variables use ${size.ram} bytes (${pct(size.ram, board.maximumDataSize)}%) of dynamic memory, leaving ${board.maximumDataSize - size.ram} bytes for local variables. Maximum is ${board.maximumDataSize} bytes.\n`);
  if (size.flash > board.maximumSize) throw new BuildError('Sketch too big; see https://support.arduino.cc/hc/en-us/articles/360013825179 for tips on reducing it.', diagnostics);
  if (size.ram > board.maximumDataSize) throw new BuildError('Not enough memory; see https://support.arduino.cc/hc/en-us/articles/360013825179 for tips on reducing your footprint.', diagnostics);
  return { hex, elf, size, diagnostics };
}
