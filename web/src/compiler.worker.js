// SPDX-License-Identifier: AGPL-3.0-or-later
// Runs builds off the main thread. The GCC/binutils WebAssembly binaries are
// fetched from the jsDelivr CDN and checked against pinned SRI hashes.
import { buildSketch } from './toolchain/build.js';
import { createToolRunner } from './toolchain/tools.js';
import { decodePack } from '../../scripts/pack.mjs';

const TOOLS = ['cc1plus', 'avr-as', 'avr-ld', 'avr-objcopy'];
let manifest;
let assetsBase;
const packs = new Map();
const factories = new Map();
const modules = new Map();
const cache = new Map();
const post = (message) => self.postMessage(message);

async function fetchVerified(file) {
  const url = manifest.toolchain.base + file;
  const response = await fetch(url, { integrity: manifest.toolchain.files[file], mode: 'cors' });
  if (!response.ok) throw Error(`Could not download ${url} (${response.status})`);
  return response;
}

function memo(map, key, load) {
  if (!map.has(key)) {
    const promise = load();
    map.set(key, promise);
    promise.catch(() => map.delete(key));
  }
  return map.get(key);
}

const loaders = {
  loadFactory: (name) =>
    memo(factories, name, async () => {
      const source = await (await fetchVerified(`tools/${name}.mjs`)).text();
      const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
      const factory = (await import(/* @vite-ignore */ url)).default;
      return (options) => factory({ ...options, locateFile: (file) => manifest.toolchain.base + 'tools/' + file });
    }),
  loadModule: (name) =>
    memo(modules, name, async () => {
      post({ type: 'status', text: `Downloading compiler (${name})…` });
      return WebAssembly.compile(await (await fetchVerified(`tools/${name}.wasm`)).arrayBuffer());
    }),
};
const runTool = createToolRunner(loaders);

const loadPack = (name) =>
  memo(packs, name, async () => {
    const response = await fetch(new URL(name, assetsBase));
    if (!response.ok) throw Error(`Missing toolchain asset ${name}`);
    return decodePack(await response.arrayBuffer());
  });

self.onmessage = async ({ data }) => {
  if (data.type === 'init') {
    manifest = data.manifest;
    assetsBase = data.assetsBase;
  } else if (data.type === 'warmup') {
    try {
      await Promise.all(TOOLS.flatMap((tool) => [loaders.loadFactory(tool), loaders.loadModule(tool)]));
      post({ type: 'status', text: 'Compiler ready' });
    } catch (error) {
      post({ type: 'status', text: `Compiler unavailable: ${error.message}` });
    }
  } else if (data.type === 'build') {
    const { id, request } = data;
    try {
      const result = await buildSketch({ ...request, manifest, loadPack, runTool, cache, log: (text) => post({ type: 'log', id, text }) });
      post({ type: 'done', id, result: { hex: result.hex, size: result.size, diagnostics: result.diagnostics } });
    } catch (error) {
      post({ type: 'failed', id, message: error.message, diagnostics: error.diagnostics || [] });
    }
  }
};
