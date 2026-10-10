// SPDX-License-Identifier: AGPL-3.0-or-later
// Library Manager: Arduino library index, installation from downloads.arduino.cc
// (both served with CORS), and ZIP import. Libraries are stored in IndexedDB.
import JSZip from 'jszip';
import { kv, libraries as store } from './storage.js';

const INDEX_URL = 'https://downloads.arduino.cc/libraries/library_index.json.gz';
const KEEP = /\.(h|hpp|hh|c|cpp|cc|cxx|S|ino|pde|properties|txt|md|adoc|json)$/i;

export async function loadIndex({ refresh = false, onStatus = () => {} } = {}) {
  const cached = await kv.get('library-index');
  if (cached && !refresh && Date.now() - cached.fetched < 24 * 3600 * 1000) return cached.libraries;
  onStatus('Downloading library index…');
  const response = await fetch(INDEX_URL);
  if (!response.ok) throw Error(`Library index download failed (${response.status})`);
  const json = await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).json();
  onStatus('Processing library index…');
  const byName = new Map();
  for (const release of json.libraries) {
    const entry = byName.get(release.name) || { name: release.name, releases: [] };
    entry.releases.push({
      version: release.version, author: release.author, maintainer: release.maintainer, sentence: release.sentence,
      paragraph: release.paragraph, website: release.website, category: release.category, architectures: release.architectures,
      url: release.url, checksum: release.checksum, size: release.size, dependencies: release.dependencies || [],
    });
    byName.set(release.name, entry);
  }
  const libraries = [...byName.values()].map((entry) => {
    entry.releases.sort((a, b) => compareVersions(b.version, a.version));
    return { ...entry.releases[0], name: entry.name, versions: entry.releases.map((r) => r.version), releases: entry.releases };
  });
  libraries.sort((a, b) => a.name.localeCompare(b.name));
  await kv.set('library-index', { fetched: Date.now(), libraries });
  return libraries;
}

export function compareVersions(a, b) {
  const pa = String(a).split(/[.-]/).map((x) => (isNaN(x) ? x : Number(x)));
  const pb = String(b).split(/[.-]/).map((x) => (isNaN(x) ? x : Number(x)));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if (pa[i] === pb[i]) continue;
    if (pa[i] === undefined) return -1;
    if (pb[i] === undefined) return 1;
    return typeof pa[i] === 'number' && typeof pb[i] === 'number' ? pa[i] - pb[i] : String(pa[i]).localeCompare(String(pb[i]));
  }
  return 0;
}

export const compatible = (release) => !release.architectures || release.architectures.some((a) => a === '*' || a === 'avr');

async function sha256(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Turns a library ZIP into {name, version, files}. Accepts archives with or
// without a single top-level folder.
export async function readLibraryZip(bytes, fallbackName) {
  const zip = await JSZip.loadAsync(bytes);
  const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir && !n.startsWith('__MACOSX/'));
  const tops = new Set(names.map((n) => n.split('/')[0]));
  const prefix = tops.size === 1 && names.every((n) => n.includes('/')) ? [...tops][0] + '/' : '';
  const files = {};
  let total = 0;
  for (const name of names) {
    const rel = name.slice(prefix.length);
    if (!rel || rel.split('/').includes('..') || !KEEP.test(rel)) continue;
    const content = await zip.files[name].async('string');
    total += content.length;
    if (total > 30e6) throw Error('Library is too large');
    files[rel] = content;
  }
  const properties = Object.fromEntries((files['library.properties'] || '').split(/\r?\n/).map((l) => l.match(/^\s*([\w.]+)\s*=\s*(.*)$/)).filter(Boolean).map((m) => [m[1], m[2].trim()]));
  const name = properties.name || prefix.replace(/\/$/, '') || fallbackName;
  if (!name) throw Error('Could not determine the library name');
  if (!Object.keys(files).some((f) => /\.(h|hpp)$/.test(f))) throw Error('The archive does not contain a valid library (no header files found)');
  return { name, version: properties.version || '', author: properties.author || '', sentence: properties.sentence || '', architectures: properties.architectures, files };
}

export async function installRelease(release, name) {
  const response = await fetch(release.url);
  if (!response.ok) throw Error(`Download failed (${response.status})`);
  const bytes = await response.arrayBuffer();
  const [algorithm, expected] = String(release.checksum || '').split(':');
  if (algorithm === 'SHA-256' && (await sha256(bytes)) !== expected.toLowerCase()) throw Error('Checksum mismatch: the downloaded archive is corrupt');
  const library = await readLibraryZip(bytes, name);
  library.name = name;
  library.version = release.version;
  await store.put({ ...library, installed: Date.now(), source: 'index' });
  return library;
}

export async function installZip(file) {
  const library = await readLibraryZip(await file.arrayBuffer(), file.name.replace(/\.zip$/i, ''));
  await store.put({ ...library, installed: Date.now(), source: 'zip' });
  return library;
}

// Dependencies (name, optional version) not installed yet, resolved recursively.
export function missingDependencies(release, index, installed) {
  const have = new Set(installed.map((l) => l.name));
  const result = [];
  const visit = (rel) => {
    for (const dep of rel.dependencies || []) {
      if (have.has(dep.name) || result.some((r) => r.name === dep.name)) continue;
      const entry = index.find((l) => l.name === dep.name);
      if (!entry) continue;
      const chosen = (dep.version && entry.releases.find((r) => r.version === dep.version)) || entry.releases[0];
      result.push({ name: dep.name, release: chosen });
      visit(chosen);
    }
  };
  visit(release);
  return result;
}
