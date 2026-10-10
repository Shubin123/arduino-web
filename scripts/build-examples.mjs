// SPDX-License-Identifier: AGPL-3.0-or-later
// Bundles the built-in examples into web/public/examples.json:
//  - arduino/arduino-examples 1.10.3 (CC0-1.0), the release Arduino IDE 2.3.x ships
//  - examples of the libraries bundled with Arduino AVR Boards 1.8.8 (LGPL-2.1+)
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const examplesRepo = process.env.ARDUINO_EXAMPLES || path.join(root, 'examples-reference');
const candidateCores = [
  process.env.ARDUINO_AVR_CORE,
  path.join(homedir(), '.arduino15', 'packages', 'arduino', 'hardware', 'avr', '1.8.8'),
  path.join(homedir(), 'Library', 'Arduino15', 'packages', 'arduino', 'hardware', 'avr', '1.8.8'),
  path.join(root, '.runtime/data/packages/arduino/hardware/avr/1.8.8'),
].filter(Boolean);
const core = candidateCores.find(existsSync) || candidateCores[0];
const TEXT = /\.(ino|h|hpp|c|cpp|txt|md)$/i;

async function isSketch(dir) {
  try {
    return (await readdir(dir)).includes(`${path.basename(dir)}.ino`);
  } catch {
    return false;
  }
}

async function collect(dir) {
  const node = { label: path.basename(dir).replace(/^\d+\./, ''), children: [], sketches: [] };
  for (const name of (await readdir(dir)).sort()) {
    const full = path.join(dir, name);
    if (!(await stat(full)).isDirectory()) continue;
    if (await isSketch(full)) {
      const files = {};
      for (const file of (await readdir(full)).sort()) if (TEXT.test(file) && (await stat(path.join(full, file))).isFile()) files[file] = await readFile(path.join(full, file), 'utf8');
      node.sketches.push({ name, files });
    } else node.children.push(await collect(full));
  }
  return node;
}

const builtin = [];
for (const category of (await readdir(path.join(examplesRepo, 'examples'))).sort()) {
  builtin.push(await collect(path.join(examplesRepo, 'examples', category)));
}
const libraries = [];
for (const name of (await readdir(path.join(core, 'libraries'))).sort()) {
  try {
    const node = await collect(path.join(core, 'libraries', name, 'examples'));
    node.label = name;
    libraries.push(node);
  } catch {}
}
let revision = 'unknown';
try {
  revision = execFileSync('git', ['-C', examplesRepo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
} catch {}
const output = { source: { repository: 'https://github.com/arduino/arduino-examples', tag: '1.10.3', revision, license: 'CC0-1.0' }, builtin, libraries };
await writeFile(path.join(root, 'web/public/examples.json'), JSON.stringify(output));
const count = (n) => n.sketches.length + n.children.reduce((a, c) => a + count(c), 0);
console.log(`examples.json: ${builtin.reduce((a, n) => a + count(n), 0)} built-in, ${libraries.reduce((a, n) => a + count(n), 0)} library examples`);
