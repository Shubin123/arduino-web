import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { decodePack } from '../../scripts/pack.mjs';
import { createToolRunner } from '../../web/src/toolchain/tools.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pkg = path.join(root, 'node_modules/@horang-corp/avr-gcc-wasm/tools');
const assets = path.join(root, 'web/public/avr');
const modules = new Map();
const factories = new Map();
const packs = new Map();

export const manifest = JSON.parse(await readFile(path.join(assets, 'manifest.json'), 'utf8'));
export const runTool = createToolRunner({
  loadFactory: async (name) => {
    if (!factories.has(name)) factories.set(name, (await import(pathToFileURL(path.join(pkg, `${name}.mjs`)).href)).default);
    return factories.get(name);
  },
  loadModule: async (name) => {
    if (!modules.has(name)) modules.set(name, WebAssembly.compile(await readFile(path.join(pkg, `${name}.wasm`))));
    return modules.get(name);
  },
});
export async function loadPack(name) {
  if (!packs.has(name)) packs.set(name, decodePack(await readFile(path.join(assets, name))));
  return packs.get(name);
}
