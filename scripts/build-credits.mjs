// SPDX-License-Identifier: AGPL-3.0-or-later
// Writes web/public/CREDITS.txt: authors and full license texts of everything the
// deployed site contains or loads. Names are taken from the components' own
// metadata (package.json author/contributors, LICENSE files, source headers).
import { execFileSync } from 'node:child_process';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const rule = '='.repeat(78);
const out = [];
const section = (title, ...lines) => out.push('', rule, title, rule, ...lines);
const person = (p) => (typeof p === 'string' ? p : [p.name, p.email && `<${p.email}>`, p.url && `(${p.url})`].filter(Boolean).join(' '));
const read = (file) => readFile(file, 'utf8');

async function walk(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full)));
    else files.push(full);
  }
  return files;
}

out.push(
  `Arduino Web ${pkg.version}`,
  `Copyright (C) 2026 ${pkg.author}`,
  '',
  'This program is free software: you can redistribute it and/or modify it under the terms of',
  'the GNU Affero General Public License as published by the Free Software Foundation, either',
  'version 3 of the License, or (at your option) any later version. See LICENSE.txt in the',
  `source repository: ${pkg.repository.url.replace(/^git\+|\.git$/g, '')}`,
  '',
  'Arduino is a trademark of Arduino SA. This independent project is not affiliated with or',
  'endorsed by Arduino SA.',
);

section(
  'Design reference: Arduino IDE 2 and Arduino CLI',
  'The user interface and workflow follow Arduino IDE 2 (https://github.com/arduino/arduino-ide,',
  'Copyright Arduino SA and contributors, AGPL-3.0-or-later). Some user-interface messages follow',
  'Arduino IDE 2 and Arduino CLI (https://github.com/arduino/arduino-cli, Copyright Arduino SA,',
  'GPL-3.0). This project is a new implementation; it does not contain Arduino IDE source code.',
);

// Arduino AVR core: shipped as headers, precompiled objects and full source.
const coreDir = path.join(root, 'web/public/third_party/ArduinoCore-avr-1.8.8');
const holders = new Set();
for (const file of await walk(coreDir)) {
  if (!/\.(c|cpp|h|S)$/.test(file)) continue;
  for (const line of (await read(file)).split('\n')) {
    const m = line.match(/Copyright\s*(?:\(c\)|©)\s*(.+)$/i);
    if (m) holders.add(m[1].replace(/\s*All rights? reserved\.?/i, '').replace(/\s+/g, ' ').trim());
  }
}
section(
  'Arduino AVR Boards 1.8.8 (https://github.com/arduino/ArduinoCore-avr)',
  'License: GNU Lesser General Public License 2.1 or later (see the license text below).',
  'Used as: precompiled core and bundled-library objects (avr/core-*.pack), headers',
  '(avr/sysroot.pack) and the complete corresponding source in third_party/ArduinoCore-avr-1.8.8/.',
  'Copyright notices found in the source files:',
  ...[...holders].sort().map((h) => `  Copyright (c) ${h}`),
);

section(
  'AVR-LibC (https://github.com/avrdudes/avr-libc), as shipped in Arduino avr-gcc 7.3.0-atmel3.6.1-arduino7',
  'License: Modified BSD License; individual headers carry their own copyright notices, which',
  'are preserved in avr/sysroot.pack. Used as: headers, libc.a, libm.a, device libraries, crt*.o.',
  '',
  await read(path.join(root, 'licenses/avr-libc-LICENSE.txt')),
);

section(
  'GCC 7.3.0 and GNU Binutils (Free Software Foundation, Inc.)',
  'libgcc.a (in avr/lib-*.pack) is covered by GPL-3.0-or-later with the GCC Runtime Library',
  'Exception 3.1, which permits linking it into firmware under any license. Source:',
  '  https://github.com/arduino/toolchain-avr (build scripts for avr-gcc 7.3.0-atmel3.6.1-arduino7)',
  '  https://gcc.gnu.org/  https://www.gnu.org/software/binutils/',
  '',
  'The compiler itself (cc1plus, as, ld, objcopy compiled to WebAssembly) is not part of this',
  `site: browsers download it from the npm package ${'@horang-corp/avr-gcc-wasm'} published by the`,
  'horang-corp organization (https://github.com/horang-corp/avr-gcc-wasm) via jsDelivr, verified',
  'with subresource-integrity hashes. Those binaries are GPL-3.0-or-later; their source is GCC',
  '7.3.0 and GNU Binutils.',
);

section(
  'Built-in examples: arduino-examples 1.10.3 (https://github.com/arduino/arduino-examples)',
  'License: CC0-1.0 (public domain dedication). The authors of each example are credited in its',
  'comments, which are reproduced unmodified. Examples of the libraries bundled with Arduino AVR',
  'Boards are LGPL-2.1-or-later as described above.',
);

// Bundled npm packages (production dependency closure).
const packages = execFileSync('npm', ['ls', '--omit=dev', '--all', '--parseable'], { cwd: root, encoding: 'utf8' })
  .trim().split('\n').slice(1);
const seen = new Set();
for (const dir of packages) {
  const meta = JSON.parse(await read(path.join(dir, 'package.json')));
  const id = `${meta.name}@${meta.version}`;
  if (seen.has(id)) continue;
  seen.add(id);
  const people = [meta.author, ...(meta.contributors || []), ...(meta.maintainers || [])].filter(Boolean).map(person);
  const licenseFiles = (await readdir(dir)).filter((f) => /^(licen[cs]e|copying|notice)/i.test(f));
  const texts = [];
  for (const f of licenseFiles) if ((await stat(path.join(dir, f))).isFile()) texts.push(await read(path.join(dir, f)));
  section(
    `${id}${meta.homepage ? `  ${meta.homepage}` : ''}`,
    `License: ${meta.license || 'see below'}`,
    ...(people.length ? [`Authors: ${[...new Set(people)].join('; ')}`] : []),
    ...(meta.name === 'esptool-js' ? ['Published by Espressif Systems (https://github.com/espressif/esptool-js).'] : []),
    ...(meta.name === '@wasm-fmt/clang-format' ? ['Contains clang-format from the LLVM Project, Apache-2.0 WITH LLVM-exception (https://llvm.org/LICENSE.txt).'] : []),
    '',
    ...texts,
  );
}

section('GNU Lesser General Public License 2.1', await read(path.join(root, 'licenses/LGPL-2.1.txt')));
section('GCC Runtime Library Exception 3.1', await read(path.join(root, 'licenses/GCC-exception-3.1.txt')));

await writeFile(path.join(root, 'web/public/CREDITS.txt'), out.join('\n') + '\n');
console.log(`CREDITS.txt: ${seen.size} packages, ${holders.size} Arduino core copyright notices`);
