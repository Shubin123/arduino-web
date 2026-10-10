// SPDX-License-Identifier: AGPL-3.0-or-later
import './style.css';
import JSZip from 'jszip';
import { monaco, formatSource, setupLanguage } from './editor.js';
import { $, h, icon, dialog, askText, confirmDialog, toast, createMenubar, download } from './ui.js';
import { sketches, libraries as libraryStore, kv, validSketchName, defaultSketchName, NEW_SKETCH } from './storage.js';
import { Monitor, matchBoard, portLabel, serialSupported } from './serial.js';
import { Plotter } from './plotter.js';
import { uploadHex } from './upload/index.js';
import { compatible, installRelease, installZip, loadIndex, missingDependencies, compareVersions } from './libraries.js';

const SOURCE_URL = import.meta.env.VITE_SOURCE_URL || 'https://github.com/';
const APP_VERSION = import.meta.env.VITE_APP_VERSION || 'dev';
const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
const mod = isMac ? '⌘' : 'Ctrl+';
const BAUDS = [300, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 74880, 115200, 230400, 250000, 500000, 1000000, 2000000];

const manifest = await (await fetch(new URL('avr/manifest.json', document.baseURI))).json();
let examples = null;
const state = {
  sketch: null, // {name, files, unsaved?}
  active: null,
  dirty: new Set(),
  boardId: 'uno',
  options: {},
  port: null,
  ports: [],
  prefs: { theme: 'system', fontSize: 14, warnings: 'none', verboseCompile: false, verboseUpload: false, autosave: true, baud: 9600, lineEnding: '\n', timestamps: false, autoscroll: true },
  busy: false,
  libraryIndex: null,
  installed: [],
};
const models = new Map();

// ---------------------------------------------------------------- preferences
Object.assign(state.prefs, (await kv.get('prefs').catch(() => null)) || {});
Object.assign(state, (await kv.get('board').catch(() => null)) || {});
if (!manifest.boards.some((b) => b.id === state.boardId)) state.boardId = 'uno';
const savePrefs = () => kv.set('prefs', state.prefs);
const saveBoard = () => kv.set('board', { boardId: state.boardId, options: state.options });

function applyTheme() {
  const dark = state.prefs.theme === 'dark' || (state.prefs.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  monaco.editor.setTheme(dark ? 'arduino-dark' : 'arduino-light');
}
monaco.editor.defineTheme('arduino-light', { base: 'vs', inherit: true, rules: [{ token: 'keyword', foreground: '00979C' }, { token: 'comment', foreground: '95A5A6' }, { token: 'string', foreground: '005C5F' }, { token: 'number', foreground: '8A7B52' }], colors: { 'editor.background': '#FFFFFF', 'editorLineNumber.foreground': '#95A5A6' } });
monaco.editor.defineTheme('arduino-dark', { base: 'vs-dark', inherit: true, rules: [{ token: 'keyword', foreground: '0CA1A6' }, { token: 'comment', foreground: '7F8C8D' }, { token: 'string', foreground: '7FCBCD' }, { token: 'number', foreground: 'C9B37E' }], colors: { 'editor.background': '#171E21', 'editorLineNumber.foreground': '#4E5B61' } });
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

// ---------------------------------------------------------------- editor
const editor = monaco.editor.create($('editor'), {
  automaticLayout: true, minimap: { enabled: false }, tabSize: 2, insertSpaces: true, fontSize: state.prefs.fontSize,
  scrollBeyondLastLine: false, fontFamily: '"JetBrains Mono", Menlo, Consolas, monospace', renderLineHighlight: 'all',
  quickSuggestions: { other: true, comments: false, strings: false }, bracketPairColorization: { enabled: false },
});
// Automated end-to-end tests set editor contents directly (see tests/browser.mjs).
if (new URLSearchParams(location.search).has('test')) window.__setSource = (text) => editor.getModel().setValue(text);
applyTheme();
setupLanguage((model) => [...new Set(model.getValue().match(/\b[A-Za-z_]\w{2,}\b/g) || [])]);
editor.onDidChangeCursorPosition(({ position }) => ($('cursor').textContent = `Ln ${position.lineNumber}, Col ${position.column}`));

function modelFor(name, content) {
  const uri = monaco.Uri.parse(`file:///sketch/${encodeURIComponent(name)}`);
  monaco.editor.getModel(uri)?.dispose();
  const language = /\.(ino|pde|c|cpp|cc|h|hpp|hh|S)$/i.test(name) ? 'cpp' : name.endsWith('.json') ? 'json' : 'plaintext';
  const model = monaco.editor.createModel(content, language, uri);
  model.onDidChangeContent(() => {
    if (!state.sketch) return;
    state.sketch.files[name] = model.getValue();
    state.dirty.add(name);
    renderTabs();
    scheduleAutosave();
  });
  return model;
}

// ---------------------------------------------------------------- sketches
const mainFile = () => `${state.sketch.name}.ino`;
let autosaveTimer;
function scheduleAutosave() {
  clearTimeout(autosaveTimer);
  if (state.prefs.autosave && !state.sketch.unsaved) autosaveTimer = setTimeout(() => saveSketch({ quiet: true }), 1200);
}

async function openSketch(sketch, { focus } = {}) {
  if (state.sketch && state.dirty.size && state.sketch.unsaved) {
    if (!(await confirmDialog('Discard changes?', `“${state.sketch.name}” has not been saved. Discard it?`, 'Discard'))) return;
  } else if (state.sketch && state.dirty.size) await saveSketch({ quiet: true });
  for (const model of models.values()) model.dispose();
  models.clear();
  state.sketch = { ...sketch, files: { ...sketch.files } };
  state.dirty.clear();
  for (const [name, content] of Object.entries(state.sketch.files)) models.set(name, modelFor(name, content));
  selectFile(focus && models.has(focus) ? focus : models.has(mainFile()) ? mainFile() : [...models.keys()][0]);
  if (!sketch.unsaved) kv.set('last-sketch', sketch.name);
  document.title = `${sketch.name} | Arduino Web ${APP_VERSION}`;
  renderSide();
}

function selectFile(name) {
  state.active = name;
  editor.setModel(models.get(name));
  renderTabs();
  editor.focus();
}

async function saveSketch({ quiet = false } = {}) {
  if (!state.sketch) return;
  if (state.sketch.unsaved) return saveAs();
  for (const [name, model] of models) state.sketch.files[name] = model.getValue();
  await sketches.put({ name: state.sketch.name, files: state.sketch.files, handle: state.sketch.handle });
  if (state.sketch.handle) await writeToDisk(state.sketch).catch((e) => toast(`Could not write to the folder on your computer: ${e.message}`, 'error'));
  state.dirty.clear();
  renderTabs();
  if (!quiet) toast('Saved');
  if (activeView === 'sketchbook') renderSide();
}

async function existingNames() {
  return (await sketches.list()).map((s) => s.name);
}

async function nameDialog(title, initial) {
  const names = await existingNames();
  return askText(title, 'Sketch name', initial, (v) => (!validSketchName(v) ? 'Use letters, numbers, “_”, “-” and “.” (max 63 characters, not starting with “-” or “.”)' : names.includes(v) ? 'A sketch with this name already exists' : ''));
}

async function saveAs() {
  const name = await nameDialog('Save sketch as', state.sketch.unsaved ? state.sketch.name : `${state.sketch.name}_copy`);
  if (!name) return;
  const files = {};
  for (const [file, model] of models) files[file === mainFile() ? `${name}.ino` : file] = model.getValue();
  await sketches.put({ name, files });
  state.dirty.clear();
  await openSketch({ name, files });
  toast(`Saved as ${name}`);
}

async function newSketch() {
  const name = defaultSketchName(await existingNames());
  const sketch = { name, files: { [`${name}.ino`]: NEW_SKETCH } };
  await sketches.put(sketch);
  await openSketch(sketch);
}

async function renameSketch(old) {
  const name = await nameDialog('Rename sketch', old.name);
  if (!name) return;
  const files = {};
  for (const [file, content] of Object.entries(old.files)) files[file === `${old.name}.ino` ? `${name}.ino` : file] = content;
  await sketches.put({ name, files });
  await sketches.delete(old.name);
  if (state.sketch?.name === old.name) {
    state.dirty.clear();
    await openSketch({ name, files });
  } else renderSide();
}

async function deleteSketch(sketch) {
  if (!(await confirmDialog('Delete sketch', `Delete “${sketch.name}” from the browser sketchbook? This cannot be undone.`, 'Delete'))) return;
  await sketches.delete(sketch.name);
  if (state.sketch?.name === sketch.name) {
    const rest = await sketches.list();
    state.dirty.clear();
    if (rest.length) await openSketch(rest[0]);
    else await newSketch();
  }
  renderSide();
}

async function addFile() {
  const name = await askText('New tab', 'Name for new file', '', (v) => (!/^[\w.-]+\.(ino|h|hpp|c|cpp|S|txt|md|json)$/.test(v) ? 'Use a name like helpers.h, util.cpp or Second.ino' : models.has(v) ? 'A file with this name already exists' : ''));
  if (!name) return;
  models.set(name, modelFor(name, ''));
  state.sketch.files[name] = '';
  state.dirty.add(name);
  selectFile(name);
  scheduleAutosave();
}

async function renameFile(name) {
  if (name === mainFile()) return renameSketch({ name: state.sketch.name, files: Object.fromEntries([...models].map(([f, m]) => [f, m.getValue()])) });
  const next = await askText('Rename file', 'New name', name, (v) => (!/^[\w.-]+\.\w+$/.test(v) ? 'Invalid file name' : v !== name && models.has(v) ? 'A file with this name already exists' : ''));
  if (!next || next === name) return;
  const content = models.get(name).getValue();
  models.get(name).dispose();
  models.delete(name);
  delete state.sketch.files[name];
  models.set(next, modelFor(next, content));
  state.sketch.files[next] = content;
  state.dirty.add(next);
  selectFile(next);
  scheduleAutosave();
}

async function deleteFile(name) {
  if (name === mainFile()) return toast('The main sketch file cannot be deleted', 'error');
  if (!(await confirmDialog('Delete file', `Delete “${name}”?`, 'Delete'))) return;
  models.get(name).dispose();
  models.delete(name);
  delete state.sketch.files[name];
  state.dirty.add(mainFile());
  selectFile(mainFile());
  scheduleAutosave();
}

function renderTabs() {
  const tabs = $('tabs');
  if (!state.sketch) return tabs.replaceChildren();
  const names = [...models.keys()].sort((a, b) => (a === mainFile() ? -1 : b === mainFile() ? 1 : a.localeCompare(b)));
  tabs.replaceChildren(
    ...names.map((name) =>
      h('div', { class: `tab${name === state.active ? ' active' : ''}`, title: name, onclick: () => selectFile(name), oncontextmenu: (e) => { e.preventDefault(); menubar.popup(tabMenu(name), e.clientX, e.clientY); } },
        h('span', {}, name), state.dirty.has(name) ? h('span', { class: 'dot', title: 'Unsaved changes' }, '●') : null)),
    h('button', { class: 'tab-menu icon-button', title: 'Tab actions', onclick: (e) => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); menubar.popup(tabMenu(state.active), r.left - 150, r.bottom); } }, '⋯'),
  );
}
const tabMenu = (name) => [
  { label: 'New Tab', action: addFile, shortcut: `${mod}⇧N` },
  { label: 'Rename', action: () => renameFile(name) },
  { label: 'Delete', action: () => deleteFile(name), disabled: name === mainFile() },
];

// Opening sketches from / saving to a folder on the computer (File System Access API, Chromium).
async function readDirectory(handle) {
  const files = {};
  const walk = async (dir, prefix) => {
    for await (const [name, entry] of dir.entries()) {
      if (entry.kind === 'directory') {
        if (name === 'src' || prefix) await walk(entry, `${prefix}${name}/`);
      } else if (/\.(ino|pde|h|hpp|hh|c|cpp|cc|S|txt|md|json)$/i.test(name)) files[prefix + name] = await (await entry.getFile()).text();
    }
  };
  await walk(handle, '');
  return files;
}

async function writeToDisk(sketch) {
  const handle = sketch.handle;
  if ((await handle.queryPermission({ mode: 'readwrite' })) !== 'granted' && (await handle.requestPermission({ mode: 'readwrite' })) !== 'granted') throw Error('permission denied');
  for (const [name, content] of Object.entries(sketch.files)) {
    let dir = handle;
    const parts = name.split('/');
    for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create: true });
    const writable = await (await dir.getFileHandle(parts.at(-1), { create: true })).createWritable();
    await writable.write(content);
    await writable.close();
  }
}

async function openFromComputer() {
  if ('showDirectoryPicker' in window) {
    let handle;
    try {
      handle = await showDirectoryPicker({ id: 'sketch', mode: 'readwrite' });
    } catch {
      return;
    }
    const files = await readDirectory(handle);
    let main = `${handle.name}.ino`;
    if (!files[main]) {
      const inos = Object.keys(files).filter((f) => f.endsWith('.ino') && !f.includes('/'));
      if (!inos.length) return toast('No .ino file found in that folder', 'error');
      const renamed = inos[0].slice(0, -4);
      return importFiles(renamed, files);
    }
    const names = await existingNames();
    let name = handle.name;
    if (!validSketchName(name)) return toast(`“${name}” is not a valid sketch name`, 'error');
    if (names.includes(name) && !(await confirmDialog('Replace sketch', `A sketch named “${name}” is already in the browser sketchbook. Replace it with the folder contents?`, 'Replace'))) return;
    const sketch = { name, files, handle };
    await sketches.put(sketch);
    await openSketch(sketch);
    toast(`Opened ${name}. Saving also writes to the folder on your computer.`);
  } else $('file-import').click();
}

async function importFiles(suggested, files) {
  const name = await nameDialog('Import sketch', validSketchName(suggested) ? suggested : 'imported_sketch');
  if (!name) return;
  const main = Object.keys(files).find((f) => f.endsWith('.ino') && !f.includes('/'));
  const renamed = {};
  for (const [file, content] of Object.entries(files)) renamed[file === main ? `${name}.ino` : file] = content;
  await sketches.put({ name, files: renamed });
  await openSketch({ name, files: renamed });
}

$('file-import').addEventListener('change', async (event) => {
  const list = [...event.target.files];
  event.target.value = '';
  if (!list.length) return;
  if (list.length === 1 && list[0].name.endsWith('.zip')) return importZip(list[0]);
  const files = {};
  for (const file of list) if (/\.(ino|pde|h|hpp|c|cpp|S|txt|md|json)$/i.test(file.name)) files[file.name] = await file.text();
  const main = Object.keys(files).find((f) => f.endsWith('.ino'));
  if (!main) return toast('Select at least one .ino file', 'error');
  await importFiles(main.slice(0, -4), files);
});

async function importZip(file) {
  const zip = await JSZip.loadAsync(file);
  const files = {};
  const entries = Object.values(zip.files).filter((e) => !e.dir && !e.name.startsWith('__MACOSX/'));
  const prefix = entries.every((e) => e.name.includes('/')) && new Set(entries.map((e) => e.name.split('/')[0])).size === 1 ? entries[0].name.split('/')[0] + '/' : '';
  for (const entry of entries) {
    const rel = entry.name.slice(prefix.length);
    if (/\.(ino|pde|h|hpp|c|cpp|S|txt|md|json)$/i.test(rel) && !rel.split('/').includes('..')) files[rel] = await entry.async('string');
  }
  const main = Object.keys(files).find((f) => f.endsWith('.ino') && !f.includes('/'));
  if (!main) return toast('No sketch (.ino) found in the archive', 'error');
  await importFiles(prefix ? prefix.slice(0, -1) : main.slice(0, -4), files);
}

async function archiveSketch() {
  await saveSketch({ quiet: true });
  const zip = new JSZip();
  for (const [name, model] of models) zip.file(`${state.sketch.name}/${name}`, model.getValue());
  download(`${state.sketch.name}.zip`, await zip.generateAsync({ type: 'blob' }));
}

// ---------------------------------------------------------------- examples
async function loadExamples() {
  examples ??= await (await fetch(new URL('examples.json', document.baseURI))).json();
  return examples;
}

function exampleItems(node) {
  return [
    ...node.children.map((child) => ({ label: child.label, submenu: () => exampleItems(child) })),
    ...node.sketches.map((sketch) => ({ label: sketch.name, action: () => openExample(sketch) })),
  ];
}

async function openExample(example) {
  const names = await existingNames();
  let name = example.name;
  for (let i = 1; names.includes(name); i++) name = `${example.name}_${i}`;
  const files = {};
  for (const [file, content] of Object.entries(example.files)) files[file === `${example.name}.ino` ? `${name}.ino` : file] = content;
  await openSketch({ name, files, unsaved: true });
  toast('Example opened. Use Save to keep a copy in your sketchbook.');
}

async function examplesMenu() {
  const data = await loadExamples();
  const installed = (await libraryStore.list()).map((lib) => {
    const exampleFiles = Object.entries(lib.files).filter(([f]) => f.startsWith('examples/'));
    const groups = new Map();
    for (const [file, content] of exampleFiles) {
      const parts = file.split('/');
      if (parts.length < 3) continue;
      const sketchName = parts[parts.length - 2];
      const key = parts.slice(1, -1).join('/');
      if (!groups.has(key)) groups.set(key, { name: sketchName, files: {} });
      groups.get(key).files[parts.at(-1)] = content;
    }
    return { label: lib.name, children: [], sketches: [...groups.values()].filter((s) => s.files[`${s.name}.ino`]) };
  }).filter((n) => n.sketches.length);
  return [
    { label: 'Built-in examples', disabled: true },
    ...data.builtin.map((node) => ({ label: node.label, submenu: () => exampleItems(node) })),
    '-',
    { label: `Examples for ${currentBoard().name}`, disabled: true },
    ...data.libraries.map((node) => ({ label: node.label, submenu: () => exampleItems(node) })),
    ...(installed.length ? ['-', { label: 'Examples from custom libraries', disabled: true }, ...installed.map((node) => ({ label: node.label, submenu: () => exampleItems(node) }))] : []),
  ];
}

// ---------------------------------------------------------------- boards & ports
const currentBoard = () => manifest.boards.find((b) => b.id === state.boardId);
const currentProfile = () => manifest.profiles[currentBoard().profile];

function selectBoard(id) {
  state.boardId = id;
  const board = currentBoard();
  state.options = Object.fromEntries(Object.entries(board.options || {}).map(([key, option]) => [key, state.options[key] && option.values.some((v) => v.id === state.options[key]) ? state.options[key] : option.values[0].id]));
  saveBoard();
  renderBoardButton();
  if (activeView === 'boards') renderSide();
}

async function refreshPorts() {
  state.ports = serialSupported ? await navigator.serial.getPorts() : [];
  if (state.port && !state.ports.includes(state.port)) state.port = null;
  renderBoardButton();
}

async function requestPort(filters) {
  if (!serialSupported) {
    toast('Web Serial is not available in this browser. Use a recent Chrome, Edge or Opera on desktop.', 'error');
    return null;
  }
  try {
    const port = await navigator.serial.requestPort(filters ? { filters } : {});
    await refreshPorts();
    return port;
  } catch {
    return null;
  }
}

async function choosePort(port) {
  if (monitor.open && monitor.port !== port) await monitor.disconnect();
  state.port = port;
  const detected = matchBoard(port, manifest.boards);
  if (detected && detected.id !== state.boardId) {
    selectBoard(detected.id);
    toast(`Detected ${detected.name}`);
  }
  renderBoardButton();
}

function renderBoardButton() {
  const board = currentBoard();
  const portText = state.port ? portLabel(state.port, manifest.boards) : 'No port selected';
  $('board-button').replaceChildren(h('span', { class: 'board-name' }, board.name), h('span', { class: `port-name${state.port ? '' : ' muted'}` }, portText), icon('chevron'));
  $('status-board').textContent = `${board.name}${state.port ? ' on ' + portText : ' [not connected]'}`;
}

function boardMenuItems() {
  return [
    ...manifest.boards.map((b) => ({ label: b.name, checked: b.id === state.boardId, action: () => selectBoard(b.id) })),
    '-',
    ...state.ports.map((p) => ({ label: portLabel(p, manifest.boards), checked: p === state.port, action: () => choosePort(p) })),
    { label: 'Connect a new port…', action: async () => { const p = await requestPort(); if (p) await choosePort(p); } },
    '-',
    { label: 'Select other board and port…', action: boardDialog },
  ];
}

async function boardDialog() {
  let chosenBoard = state.boardId;
  let chosenPort = state.port;
  const boardList = h('div', { class: 'pick-list' });
  const portList = h('div', { class: 'pick-list' });
  const filter = h('input', { placeholder: 'Search board', type: 'search' });
  const render = () => {
    const q = filter.value.toLowerCase();
    boardList.replaceChildren(...manifest.boards.filter((b) => b.name.toLowerCase().includes(q)).map((b) => h('button', { type: 'button', class: b.id === chosenBoard ? 'selected' : '', onclick: () => { chosenBoard = b.id; render(); } }, b.name, h('small', {}, b.fqbn))));
    portList.replaceChildren(
      ...state.ports.map((p) => h('button', { type: 'button', class: p === chosenPort ? 'selected' : '', onclick: () => { chosenPort = p; const d = matchBoard(p, manifest.boards); if (d) chosenBoard = d.id; render(); } }, portLabel(p, manifest.boards))),
      h('button', { type: 'button', class: 'link', onclick: async () => { const p = await requestPort(); if (p) { chosenPort = p; render(); } } }, '+ Connect a new port…'),
    );
  };
  filter.oninput = render;
  render();
  const ok = await dialog({
    title: 'Select Other Board and Port', wide: true,
    body: [h('p', { class: 'muted' }, 'Select both a board and a port if you want to upload a sketch. If you only select a board you will be able to compile, but not to upload your sketch.'),
      h('div', { class: 'two-columns' }, h('div', {}, h('h3', {}, 'Boards'), filter, boardList), h('div', {}, h('h3', {}, 'Ports'), portList))],
    actions: [{ label: 'Cancel' }, { label: 'OK', primary: true, value: true }],
  });
  if (!ok) return;
  selectBoard(chosenBoard);
  if (chosenPort) await choosePort(chosenPort);
}

if (serialSupported) {
  navigator.serial.addEventListener('connect', refreshPorts);
  navigator.serial.addEventListener('disconnect', async (event) => {
    if (event.target === state.port && !state.busy) toast('The selected port was disconnected');
    await refreshPorts();
  });
}

// ---------------------------------------------------------------- build output
const output = $('output');
function log(text, kind) {
  const atBottom = output.scrollTop + output.clientHeight >= output.scrollHeight - 20;
  if (kind) output.append(h('span', { class: kind }, text));
  else output.append(text);
  if (output.childNodes.length > 4000) output.firstChild.remove();
  if (atBottom) output.scrollTop = output.scrollHeight;
}
function clearOutput() {
  output.replaceChildren();
}

const worker = new Worker(new URL('./compiler.worker.js', import.meta.url), { type: 'module' });
worker.postMessage({ type: 'init', manifest, assetsBase: new URL('avr/', document.baseURI).href });
const builds = new Map();
let buildId = 0;
worker.onmessage = ({ data }) => {
  if (data.type === 'status') return setStatus(data.text);
  const build = builds.get(data.id);
  if (!build) return;
  if (data.type === 'log') log(data.text);
  else if (data.type === 'done') build.resolve(data.result);
  else if (data.type === 'failed') build.reject(Object.assign(Error(data.message), { diagnostics: data.diagnostics }));
};
setTimeout(() => worker.postMessage({ type: 'warmup' }), 1500);

function setStatus(text) {
  $('status-msg').textContent = text;
}

function setBusy(busy, label) {
  state.busy = busy;
  for (const id of ['verify', 'upload']) $(id).disabled = busy;
  $('progress').hidden = !busy;
  $('progress-label').textContent = label || '';
}

function showDiagnostics(diagnostics) {
  for (const [name, model] of models) {
    monaco.editor.setModelMarkers(model, 'compiler', diagnostics.filter((d) => d.file === name).map((d) => ({
      startLineNumber: d.line, endLineNumber: d.line, startColumn: d.column, endColumn: d.column + 1, message: d.message,
      severity: d.severity === 'warning' ? monaco.MarkerSeverity.Warning : d.severity === 'note' ? monaco.MarkerSeverity.Info : monaco.MarkerSeverity.Error,
    })));
  }
}

async function compile() {
  if (!state.sketch) throw Error('No sketch open');
  for (const [name, model] of models) state.sketch.files[name] = model.getValue();
  showBottom('output');
  clearOutput();
  const id = ++buildId;
  const board = currentBoard();
  log(`Compiling sketch for ${board.name} (${board.fqbn})…\n`, 'info');
  const installed = await libraryStore.list();
  try {
    const result = await new Promise((resolve, reject) => {
      builds.set(id, { resolve, reject });
      worker.postMessage({ type: 'build', id, request: { files: state.sketch.files, sketchName: state.sketch.name, boardId: state.boardId, libraries: installed.map(({ name, version, files }) => ({ name, version, files })), warnings: state.prefs.warnings, verbose: state.prefs.verboseCompile } });
    });
    showDiagnostics(result.diagnostics);
    return result;
  } catch (error) {
    showDiagnostics(error.diagnostics || []);
    const first = (error.diagnostics || []).find((d) => d.severity === 'error' && models.has(d.file));
    if (first) {
      selectFile(first.file);
      editor.revealLineInCenter(first.line);
      editor.setPosition({ lineNumber: first.line, column: first.column });
    }
    throw error;
  } finally {
    builds.delete(id);
  }
}

async function verify() {
  if (state.busy) return;
  setBusy(true, 'Compiling sketch…');
  try {
    await compile();
    toast('Done compiling.');
  } catch (error) {
    log(`\n${error.message}\n`, 'error');
    toast(error.message, 'error');
  } finally {
    setBusy(false);
  }
}

async function bootloaderPortPrompt(filters) {
  // A user gesture is required before the browser may show the port chooser.
  return new Promise((resolve) => {
    dialog({
      title: 'Select the bootloader port',
      body: h('p', {}, 'The board has restarted into its bootloader, which appears as a new USB device. Click “Select port”, then pick the board in the list within a few seconds.'),
      actions: [{ label: 'Cancel', value: null }, { label: 'Select port', primary: true, value: 'pick' }],
    }).then(async (choice) => resolve(choice === 'pick' ? await requestPort(filters) : null));
  });
}

async function upload({ hex } = {}) {
  if (state.busy) return;
  if (!serialSupported) return toast('Uploading needs Web Serial (desktop Chrome, Edge or Opera).', 'error');
  if (!state.port) {
    const port = await requestPort();
    if (!port) return;
    await choosePort(port);
  }
  setBusy(true, hex ? 'Uploading…' : 'Compiling sketch…');
  const reopen = monitor.open ? monitor.baudRate : 0;
  try {
    if (!hex) hex = (await compile()).hex;
    else {
      showBottom('output');
      clearOutput();
    }
    if (reopen) await monitor.disconnect();
    setBusy(true, 'Uploading…');
    log('Uploading…\n', 'info');
    const started = performance.now();
    let lastPhase = '';
    await uploadHex({
      hex, board: currentBoard(), profile: currentProfile(), options: state.options, port: state.port,
      requestPort: async (filters) => {
        const port = await bootloaderPortPrompt(filters);
        if (!port) throw Error('Upload cancelled: no bootloader port selected');
        return port;
      },
      log: (text) => state.prefs.verboseUpload && log(text),
      progress: (phase, done, total) => {
        $('progress-label').textContent = `${phase} ${Math.round((done / total) * 100)}%`;
        if (phase !== lastPhase) {
          lastPhase = phase;
          log(`${phase}…\n`);
        }
      },
    });
    log(`Upload complete in ${((performance.now() - started) / 1000).toFixed(1)} s. Flash verified.\n`, 'info');
    toast('Done uploading.');
  } catch (error) {
    log(`\n${error.message}\n`, 'error');
    toast(`Upload failed: ${error.message}`, 'error');
  } finally {
    setBusy(false);
    await refreshPorts();
    if (reopen && state.port) setTimeout(() => connectMonitor(reopen).catch(() => {}), 1500);
  }
}

async function exportBinary() {
  if (state.busy) return;
  setBusy(true, 'Compiling sketch…');
  try {
    const { hex } = await compile();
    download(`${state.sketch.name}.ino.${state.boardId}.hex`, hex, 'text/plain');
    log('Compiled binary exported.\n', 'info');
  } catch (error) {
    log(`\n${error.message}\n`, 'error');
  } finally {
    setBusy(false);
  }
}

async function uploadBinaryDialog() {
  const fileInput = h('input', { type: 'file', accept: '.hex,.bin', multiple: true });
  const target = h('select', {}, h('option', { value: 'avr' }, `${currentBoard().name} (Intel HEX)`), h('option', { value: 'esp' }, 'ESP32 / ESP8266 (binary images, esptool)'));
  const rows = h('div', { class: 'stack' });
  const espBaud = h('select', {}, [115200, 230400, 460800, 921600].map((b) => h('option', { value: b, selected: b === 921600 }, b)));
  const erase = h('input', { type: 'checkbox' });
  const espOptions = h('div', { class: 'stack', hidden: true }, h('label', {}, 'Baud rate', espBaud), h('label', { class: 'inline' }, erase, 'Erase entire flash first'));
  const renderRows = () => {
    rows.replaceChildren(...[...fileInput.files].map((file, i) => h('label', { class: 'inline' }, h('span', { class: 'grow' }, file.name), target.value === 'esp' ? h('input', { class: 'address', 'data-index': i, value: i === 0 && fileInput.files.length === 1 ? '0x10000' : '0x0' }) : null)));
  };
  target.onchange = () => { espOptions.hidden = target.value !== 'esp'; renderRows(); };
  fileInput.onchange = renderRows;
  const go = await dialog({
    title: 'Upload a compiled binary',
    body: [h('label', {}, 'Target', target), h('label', {}, 'Files', fileInput), rows, espOptions,
      h('p', { class: 'muted' }, 'For ESP boards give each image its flash address (for example bootloader 0x1000 or 0x0, partitions 0x8000, application 0x10000, or a merged image at 0x0).')],
    actions: [{ label: 'Cancel' }, { label: 'Upload', primary: true, value: true }],
  });
  if (!go || !fileInput.files.length) return;
  if (target.value === 'avr') return upload({ hex: await fileInput.files[0].text() });
  const port = await requestPort();
  if (!port) return;
  if (monitor.open) await monitor.disconnect();
  const images = [];
  for (const [i, file] of [...fileInput.files].entries()) images.push({ data: new Uint8Array(await file.arrayBuffer()), address: Number(rows.querySelector(`[data-index="${i}"]`)?.value || 0) });
  setBusy(true, 'Uploading…');
  showBottom('output');
  clearOutput();
  try {
    const { flashEsp } = await import('./upload/esp.js');
    await flashEsp(port, images, { baudRate: Number(espBaud.value), eraseAll: erase.checked, log, progress: (phase, done, total) => ($('progress-label').textContent = `${phase} ${Math.round((done / total) * 100)}%`) });
    log('Upload complete.\n', 'info');
    toast('Done uploading.');
  } catch (error) {
    log(`\n${error.message}\n`, 'error');
    toast(`Upload failed: ${error.message}`, 'error');
  } finally {
    setBusy(false);
  }
}

async function boardInfo() {
  if (!state.port) return toast('Select a port first', 'error');
  const { usbVendorId, usbProductId } = state.port.getInfo();
  const match = matchBoard(state.port, manifest.boards);
  const hex4 = (v) => (v === undefined ? 'n/a' : '0x' + v.toString(16).padStart(4, '0'));
  await dialog({ title: 'Board Info', body: h('dl', { class: 'info' }, h('dt', {}, 'Board'), h('dd', {}, match?.name || 'Unknown'), h('dt', {}, 'VID'), h('dd', {}, hex4(usbVendorId)), h('dt', {}, 'PID'), h('dd', {}, hex4(usbProductId))) });
}

// ---------------------------------------------------------------- serial monitor & plotter
const monitorEl = $('monitor');
let lineStart = true;
const plotter = new Plotter($('plot'), $('plot-legend'));
const monitor = new Monitor({
  onText(text) {
    plotter.push(text);
    if (state.prefs.timestamps) {
      let out = '';
      for (const ch of text) {
        if (lineStart) out += new Date().toTimeString().slice(0, 8) + '.' + String(Date.now() % 1000).padStart(3, '0') + ' -> ';
        out += ch;
        lineStart = ch === '\n';
      }
      text = out;
    }
    monitorEl.append(text);
    if (monitorEl.textContent.length > 300000) monitorEl.textContent = monitorEl.textContent.slice(-200000);
    if (state.prefs.autoscroll) monitorEl.scrollTop = monitorEl.scrollHeight;
  },
  onState(open) {
    $('monitor-connect').textContent = open ? 'Disconnect' : 'Connect';
    $('monitor-input').placeholder = open ? `Message (Enter to send message to '${currentBoard().name}' on '${portLabel(state.port, manifest.boards)}')` : 'Not connected. Select a board and a port to connect.';
  },
});
monitor.onState(false);

async function connectMonitor(baud = state.prefs.baud) {
  if (!serialSupported) return toast('The serial monitor needs Web Serial (desktop Chrome, Edge or Opera).', 'error');
  if (!state.port) {
    const port = await requestPort();
    if (!port) return;
    await choosePort(port);
  }
  try {
    await monitor.connect(state.port, Number(baud));
  } catch (error) {
    toast(`Could not open the port: ${error.message}`, 'error');
  }
}

function openMonitor(view = 'monitor') {
  showBottom(view);
  if (!monitor.open && !state.busy) connectMonitor();
}

$('monitor-connect').onclick = () => (monitor.open ? monitor.disconnect() : connectMonitor());
$('baud').replaceChildren(...BAUDS.map((b) => h('option', { value: b, selected: b === Number(state.prefs.baud) }, `${b} baud`)));
$('baud').onchange = async () => {
  state.prefs.baud = Number($('baud').value);
  savePrefs();
  if (monitor.open) await connectMonitor(state.prefs.baud);
};
$('line-ending').value = state.prefs.lineEnding;
$('line-ending').onchange = () => { state.prefs.lineEnding = $('line-ending').value; savePrefs(); };
$('autoscroll').checked = state.prefs.autoscroll;
$('autoscroll').onchange = () => { state.prefs.autoscroll = $('autoscroll').checked; savePrefs(); };
$('timestamps').checked = state.prefs.timestamps;
$('timestamps').onchange = () => { state.prefs.timestamps = $('timestamps').checked; savePrefs(); };
$('monitor-clear').onclick = () => { monitorEl.textContent = ''; };
$('monitor-input').addEventListener('keydown', async (e) => {
  if (e.key !== 'Enter') return;
  try {
    await monitor.send($('monitor-input').value + state.prefs.lineEnding);
    $('monitor-input').value = '';
  } catch (error) {
    toast(error.message, 'error');
  }
});
$('plot-window').onchange = () => { plotter.window = Number($('plot-window').value); plotter.draw(); };
$('plot-pause').onclick = () => { plotter.paused = !plotter.paused; $('plot-pause').textContent = plotter.paused ? 'Resume' : 'Pause'; };
$('plot-clear').onclick = () => plotter.clear();
new ResizeObserver(() => plotter.draw()).observe($('plot'));

// ---------------------------------------------------------------- bottom panel
function showBottom(view) {
  $('bottom').hidden = false;
  for (const name of ['output', 'monitor', 'plotter']) {
    $(`${name}-view`).hidden = name !== view;
    document.querySelector(`[data-bottom="${name}"]`).classList.toggle('active', name === view);
  }
  if (view === 'plotter') requestAnimationFrame(() => plotter.draw());
}
document.querySelectorAll('[data-bottom]').forEach((b) => (b.onclick = () => showBottom(b.dataset.bottom)));
$('bottom-close').onclick = () => ($('bottom').hidden = true);
{
  const splitter = $('splitter');
  splitter.addEventListener('pointerdown', (e) => {
    splitter.setPointerCapture(e.pointerId);
    const startY = e.clientY;
    const startHeight = $('bottom').getBoundingClientRect().height;
    const move = (ev) => ($('bottom').style.height = Math.max(100, Math.min(innerHeight - 200, startHeight - (ev.clientY - startY))) + 'px');
    splitter.addEventListener('pointermove', move);
    splitter.addEventListener('pointerup', () => splitter.removeEventListener('pointermove', move), { once: true });
  });
}

// ---------------------------------------------------------------- side panels
let activeView = null;
document.querySelectorAll('[data-view]').forEach((b) => (b.onclick = () => toggleView(b.dataset.view)));
function toggleView(view) {
  activeView = activeView === view ? null : view;
  document.querySelectorAll('[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === activeView));
  $('side').hidden = !activeView;
  renderSide();
}
function showView(view) {
  if (activeView !== view) toggleView(view);
}

async function renderSide() {
  if (!activeView) return;
  const titles = { sketchbook: 'Sketchbook', boards: 'Boards Manager', libraries: 'Library Manager', search: 'Search' };
  $('side-title').textContent = titles[activeView];
  const body = $('side-body');
  if (activeView === 'sketchbook') {
    const list = (await sketches.list()).sort((a, b) => a.name.localeCompare(b.name));
    body.replaceChildren(
      h('div', { class: 'side-actions' }, h('button', { class: 'primary', onclick: newSketch }, 'New Sketch'), h('button', { onclick: openFromComputer }, 'Open…')),
      h('p', { class: 'muted small' }, 'Sketches are stored in this browser. Use “Open…” to work on a folder on your computer.'),
      ...list.map((s) => h('div', { class: `list-row${s.name === state.sketch?.name ? ' current' : ''}` },
        h('button', { class: 'link grow', onclick: () => openSketch(s) }, s.name, s.handle ? h('small', {}, ' (folder)') : null),
        h('button', { class: 'icon-button', title: 'More', onclick: (e) => { e.stopPropagation(); menubar.popup([{ label: 'Open', action: () => openSketch(s) }, { label: 'Rename…', action: () => renameSketch(s) }, { label: 'Download as ZIP', action: async () => { const zip = new JSZip(); for (const [f, c] of Object.entries(s.files)) zip.file(`${s.name}/${f}`, c); download(`${s.name}.zip`, await zip.generateAsync({ type: 'blob' })); } }, { label: 'Delete…', action: () => deleteSketch(s) }], e.clientX, e.clientY); } }, '⋯'))),
    );
  } else if (activeView === 'boards') renderBoardsManager(body);
  else if (activeView === 'libraries') renderLibraryManager(body);
  else if (activeView === 'search') renderSearch(body);
}

function renderBoardsManager(body) {
  body.replaceChildren(
    h('div', { class: 'card' },
      h('h3', {}, 'Arduino AVR Boards ', h('span', { class: 'muted' }, `by Arduino`)),
      h('p', { class: 'small' }, `Version ${manifest.core.version} installed (bundled, compiled in your browser)`),
      h('p', { class: 'small' }, 'Boards included in this package: ', manifest.boards.map((b) => b.name).join(', '), '.'),
      h('div', { class: 'stack' }, ...manifest.boards.map((b) => h('label', { class: 'inline' }, h('input', { type: 'radio', name: 'board', checked: b.id === state.boardId, onchange: () => selectBoard(b.id) }), b.name))),
      ...Object.entries(currentBoard().options || {}).map(([key, option]) => h('label', {}, option.label, h('select', { onchange: (e) => { state.options[key] = e.target.value; saveBoard(); } }, option.values.map((v) => h('option', { value: v.id, selected: state.options[key] === v.id }, v.label))))),
    ),
    h('div', { class: 'card' },
      h('h3', {}, 'esp32 / esp8266 ', h('span', { class: 'muted' }, 'upload only')),
      h('p', { class: 'small' }, 'Compiling for Espressif chips needs their native toolchains, which are not available in the browser. You can flash binaries built elsewhere (e.g. “Export Compiled Binary” in the desktop Arduino IDE) with Tools ▸ Upload Binary.'),
      h('button', { onclick: uploadBinaryDialog }, 'Upload Binary…'),
    ),
  );
}

const libraryUi = { query: '', type: 'All', topic: 'All' };
async function renderLibraryManager(body) {
  state.installed = await libraryStore.list();
  const search = h('input', { type: 'search', placeholder: 'Filter your search…', value: libraryUi.query });
  const type = h('select', {}, ['All', 'Installed', 'Updatable'].map((t) => h('option', { selected: t === libraryUi.type }, t)));
  const list = h('div', { class: 'lib-list' });
  const status = h('p', { class: 'muted small' });
  const zipInput = h('input', { type: 'file', accept: '.zip', hidden: true, onchange: async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const lib = await installZip(file);
      toast(`Library installed: ${lib.name}`);
      renderSide();
    } catch (error) {
      toast(error.message, 'error');
    }
  } });
  body.replaceChildren(h('div', { class: 'stack' }, search, h('label', { class: 'inline' }, 'Type', type)), h('div', { class: 'side-actions' }, h('button', { onclick: () => zipInput.click() }, 'Add .ZIP Library…'), h('button', { onclick: async () => { state.libraryIndex = await loadIndex({ refresh: true, onStatus: (t) => (status.textContent = t) }); draw(); } }, 'Update index')), zipInput, status, list);
  const draw = () => {
    libraryUi.query = search.value;
    libraryUi.type = type.value;
    const q = search.value.toLowerCase().trim();
    const installedByName = new Map(state.installed.map((l) => [l.name, l]));
    let entries = state.libraryIndex ? state.libraryIndex.filter(compatible) : [];
    for (const lib of state.installed) if (!entries.some((e) => e.name === lib.name)) entries.push({ ...lib, releases: [], versions: [lib.version] });
    if (type.value === 'Installed') entries = entries.filter((e) => installedByName.has(e.name));
    if (type.value === 'Updatable') entries = entries.filter((e) => installedByName.has(e.name) && e.version && compareVersions(e.version, installedByName.get(e.name).version) > 0);
    if (q) entries = entries.filter((e) => [e.name, e.sentence, e.paragraph, e.author].some((v) => v && v.toLowerCase().includes(q)));
    status.textContent = state.libraryIndex ? `${entries.length} libraries` : status.textContent;
    list.replaceChildren(...entries.slice(0, 100).map((entry) => libraryCard(entry, installedByName.get(entry.name))));
    if (entries.length > 100) list.append(h('p', { class: 'muted small' }, `Showing the first 100 of ${entries.length}. Refine your search.`));
  };
  let timer;
  search.oninput = () => { clearTimeout(timer); timer = setTimeout(draw, 200); };
  type.onchange = draw;
  draw();
  if (!state.libraryIndex) {
    try {
      state.libraryIndex = await loadIndex({ onStatus: (t) => (status.textContent = t) });
      draw();
    } catch (error) {
      status.textContent = `Could not load the library index: ${error.message}`;
    }
  }
}

function libraryCard(entry, installed) {
  const version = h('select', {}, (entry.versions || []).map((v) => h('option', { value: v }, v)));
  const actions = h('div', { class: 'side-actions' });
  if (entry.releases?.length) {
    actions.append(version, h('button', { class: installed ? '' : 'primary', onclick: () => installLibrary(entry, version.value) }, installed ? (installed.version === version.value ? 'Reinstall' : 'Install') : 'Install'));
  }
  if (installed) actions.append(h('button', { onclick: async () => { if (await confirmDialog('Remove library', `Remove ${entry.name}?`, 'Remove')) { await libraryStore.delete(entry.name); renderSide(); } } }, 'Remove'));
  return h('div', { class: 'card' },
    h('h3', {}, entry.name, ' ', h('span', { class: 'muted' }, entry.author ? `by ${entry.author}` : '')),
    installed ? h('p', { class: 'badge' }, `${installed.version || ''} installed`) : null,
    h('p', { class: 'small' }, entry.sentence || ''),
    entry.website ? h('a', { href: entry.website, target: '_blank', rel: 'noopener' }, 'More info') : null,
    actions);
}

async function installLibrary(entry, version) {
  const release = entry.releases.find((r) => r.version === version) || entry.releases[0];
  const deps = missingDependencies(release, state.libraryIndex, state.installed);
  let list = [{ name: entry.name, release }];
  if (deps.length) {
    const choice = await dialog({
      title: 'Install library dependencies',
      body: [h('p', {}, `The library ${entry.name}:${release.version} needs some other library dependencies currently not installed:`), h('ul', {}, deps.map((d) => h('li', {}, `${d.name} ${d.release.version}`))), h('p', {}, 'Would you like to install all the missing dependencies?')],
      actions: [{ label: 'Cancel' }, { label: 'Install without dependencies', value: 'one' }, { label: 'Install all', primary: true, value: 'all' }],
    });
    if (!choice) return;
    if (choice === 'all') list = [...list, ...deps];
  }
  for (const item of list) {
    try {
      setStatus(`Installing ${item.name}:${item.release.version}…`);
      await installRelease(item.release, item.name);
      toast(`Installed ${item.name}:${item.release.version}`);
    } catch (error) {
      toast(`${item.name}: ${error.message}`, 'error');
    }
  }
  setStatus('');
  renderSide();
}

function renderSearch(body) {
  const input = h('input', { type: 'search', placeholder: 'Search in sketch files' });
  const results = h('div', {});
  const run = () => {
    const q = input.value;
    results.replaceChildren();
    if (!q) return;
    for (const [name, model] of models) {
      const matches = model.findMatches(q, false, false, false, null, false);
      if (!matches.length) continue;
      results.append(h('h4', {}, `${name} (${matches.length})`), ...matches.slice(0, 200).map((m) => h('button', { class: 'link result', onclick: () => { selectFile(name); editor.setSelection(m.range); editor.revealRangeInCenter(m.range); } }, `${m.range.startLineNumber}: ${model.getLineContent(m.range.startLineNumber).trim().slice(0, 80)}`)));
    }
  };
  input.oninput = run;
  body.replaceChildren(input, results);
  input.focus();
}

// ---------------------------------------------------------------- include library
async function includeLibraryItems() {
  const installed = await libraryStore.list();
  const insert = (headers) => {
    const model = models.get(state.active) || models.get(mainFile());
    const text = headers.map((x) => `#include <${x}>`).join('\n') + '\n';
    const lines = model.getLinesContent();
    let line = 0;
    lines.forEach((l, i) => /^\s*#\s*include/.test(l) && (line = i + 1));
    model.pushEditOperations([], [{ range: new monaco.Range(line + 1, 1, line + 1, 1), text: line ? text : text + '\n' }], () => null);
  };
  const headersOf = (lib) => {
    const root = Object.keys(lib.files).some((f) => f.startsWith('src/')) ? 'src/' : '';
    const all = Object.keys(lib.files).filter((f) => f.startsWith(root) && /\.h$/.test(f) && !f.slice(root.length).includes('/')).map((f) => f.slice(root.length));
    const props = (lib.files['library.properties'] || '').match(/^includes=(.*)$/m)?.[1];
    return props ? props.split(',').map((s) => s.trim()).filter(Boolean) : all;
  };
  return [
    { label: 'Manage Libraries…', shortcut: `${mod}⇧I`, action: () => showView('libraries') },
    { label: 'Add .ZIP Library…', action: () => { showView('libraries'); setTimeout(() => $('side-body').querySelector('input[type=file]')?.click(), 50); } },
    '-',
    { label: `Arduino libraries`, disabled: true },
    ...manifest.builtinLibraries.map((lib) => ({ label: lib.name, action: () => insert(lib.headers) })),
    ...(installed.length ? ['-', { label: 'Contributed libraries', disabled: true }, ...installed.map((lib) => ({ label: lib.name, action: () => insert(headersOf(lib)) }))] : []),
  ];
}

// ---------------------------------------------------------------- dialogs
async function preferencesDialog() {
  const p = { ...state.prefs };
  const field = (label, control) => h('label', {}, label, control);
  const select = (key, options) => h('select', { onchange: (e) => (p[key] = e.target.value) }, options.map(([v, l]) => h('option', { value: v, selected: String(p[key]) === String(v) }, l)));
  const check = (key, label) => h('label', { class: 'inline' }, h('input', { type: 'checkbox', checked: !!p[key], onchange: (e) => (p[key] = e.target.checked) }), label);
  const fontSize = h('input', { type: 'number', min: 8, max: 40, value: p.fontSize, oninput: (e) => (p.fontSize = Number(e.target.value)) });
  const ok = await dialog({
    title: 'Preferences',
    body: h('div', { class: 'stack' },
      field('Theme', select('theme', [['system', 'Use system setting'], ['light', 'Light'], ['dark', 'Dark']])),
      field('Editor font size', fontSize),
      field('Compiler warnings', select('warnings', [['none', 'None'], ['default', 'Default'], ['more', 'More'], ['all', 'All']])),
      h('fieldset', {}, h('legend', {}, 'Show verbose output during'), check('verboseCompile', 'compile'), check('verboseUpload', 'upload')),
      check('autosave', 'Auto save'),
      h('p', { class: 'muted small' }, 'Uploads are always verified by reading the flash back from the board.')),
    actions: [{ label: 'Cancel' }, { label: 'OK', primary: true, value: true }],
  });
  if (!ok) return;
  state.prefs = { ...p, fontSize: Math.max(8, Math.min(40, Number(p.fontSize) || 14)) };
  savePrefs();
  editor.updateOptions({ fontSize: state.prefs.fontSize });
  applyTheme();
}

function setFontSize(delta) {
  state.prefs.fontSize = Math.max(8, Math.min(40, state.prefs.fontSize + delta));
  editor.updateOptions({ fontSize: state.prefs.fontSize });
  savePrefs();
}

async function aboutDialog() {
  await dialog({
    title: 'About Arduino Web',
    body: h('div', { class: 'stack' },
      h('p', {}, `Version: ${APP_VERSION}`),
      h('p', {}, 'A browser-based Arduino development environment modelled on the Arduino IDE 2. Sketches are compiled in your browser with WebAssembly builds of GCC 7.3.0 and GNU binutils, and uploaded with Web Serial.'),
      h('p', {}, 'Free software under the GNU Affero General Public License v3.0 or later. ', h('a', { href: SOURCE_URL, target: '_blank', rel: 'noopener' }, 'Source code'), ' · ', h('a', { href: new URL('CREDITS.txt', document.baseURI).href, target: '_blank' }, 'Credits and third-party licenses')),
      h('p', { class: 'muted small' }, 'Arduino is a trademark of Arduino SA. This is an independent project and is not affiliated with or endorsed by Arduino SA.')),
  });
}

// ---------------------------------------------------------------- menus
const formatDocument = async () => {
  const model = editor.getModel();
  if (!model) return;
  try {
    const formatted = await formatSource(model.getValue(), state.active);
    if (formatted !== model.getValue()) editor.executeEdits('format', [{ range: model.getFullModelRange(), text: formatted }]);
  } catch (error) {
    toast(`Auto format failed: ${error.message}`, 'error');
  }
};
const run = (id) => () => { editor.focus(); editor.trigger('menu', id, null); };

const menubar = createMenubar($('menubar'), [
  { label: 'File', items: () => [
    { label: 'New Sketch', shortcut: `${mod}⌥N`, action: newSketch },
    { label: 'Open…', shortcut: `${mod}O`, action: openFromComputer },
    { label: 'Import Sketch (files or .zip)…', action: () => $('file-import').click() },
    { label: 'Sketchbook', submenu: () => sketchbookCache },
    { label: 'Examples', submenu: () => examplesCache || [{ label: 'Loading…', disabled: true }] },
    '-',
    { label: 'Save', shortcut: `${mod}S`, action: () => saveSketch() },
    { label: 'Save As…', shortcut: `${mod}⇧S`, action: saveAs },
    '-',
    { label: 'Preferences…', shortcut: `${mod},`, action: preferencesDialog },
  ] },
  { label: 'Edit', items: () => [
    { label: 'Undo', shortcut: `${mod}Z`, action: run('undo') },
    { label: 'Redo', shortcut: `${mod}⇧Z`, action: run('redo') },
    '-',
    { label: 'Select All', shortcut: `${mod}A`, action: run('editor.action.selectAll') },
    { label: 'Go to Line…', shortcut: `${mod}L`, action: run('editor.action.gotoLine') },
    '-',
    { label: 'Comment/Uncomment', shortcut: `${mod}/`, action: run('editor.action.commentLine') },
    { label: 'Increase Indent', shortcut: 'Tab', action: run('editor.action.indentLines') },
    { label: 'Decrease Indent', shortcut: '⇧Tab', action: run('editor.action.outdentLines') },
    { label: 'Auto Format', shortcut: `${mod}T`, action: formatDocument },
    '-',
    { label: 'Increase Font Size', shortcut: `${mod}=`, action: () => setFontSize(1) },
    { label: 'Decrease Font Size', shortcut: `${mod}-`, action: () => setFontSize(-1) },
    '-',
    { label: 'Find', shortcut: `${mod}F`, action: run('actions.find') },
    { label: 'Find Next', shortcut: `${mod}G`, action: run('editor.action.nextMatchFindAction') },
    { label: 'Find Previous', shortcut: `${mod}⇧G`, action: run('editor.action.previousMatchFindAction') },
    { label: 'Replace', shortcut: `${mod}H`, action: run('editor.action.startFindReplaceAction') },
  ] },
  { label: 'Sketch', items: () => [
    { label: 'Verify/Compile', shortcut: `${mod}R`, action: verify },
    { label: 'Upload', shortcut: `${mod}U`, action: () => upload() },
    { label: 'Export Compiled Binary', shortcut: `${mod}⌥S`, action: exportBinary },
    '-',
    { label: 'Include Library', submenu: () => includeCache || [{ label: 'Loading…', disabled: true }] },
    { label: 'Add File…', action: addFile },
  ] },
  { label: 'Tools', items: () => [
    { label: 'Auto Format', shortcut: `${mod}T`, action: formatDocument },
    { label: 'Archive Sketch', action: archiveSketch },
    { label: 'Manage Libraries…', shortcut: `${mod}⇧I`, action: () => showView('libraries') },
    { label: 'Serial Monitor', shortcut: `${mod}⇧M`, action: () => openMonitor('monitor') },
    { label: 'Serial Plotter', shortcut: `${mod}⇧L`, action: () => openMonitor('plotter') },
    '-',
    { label: `Board: “${currentBoard().name}”`, submenu: () => [{ label: 'Boards Manager…', shortcut: `${mod}⇧B`, action: () => showView('boards') }, '-', ...manifest.boards.map((b) => ({ label: b.name, checked: b.id === state.boardId, action: () => selectBoard(b.id) }))] },
    ...Object.entries(currentBoard().options || {}).map(([key, option]) => ({ label: `${option.label}: “${option.values.find((v) => v.id === state.options[key])?.label}”`, submenu: () => option.values.map((v) => ({ label: v.label, checked: state.options[key] === v.id, action: () => { state.options[key] = v.id; saveBoard(); } })) })),
    { label: `Port${state.port ? `: “${portLabel(state.port, manifest.boards)}”` : ''}`, submenu: () => [...state.ports.map((p) => ({ label: portLabel(p, manifest.boards), checked: p === state.port, action: () => choosePort(p) })), { label: 'Connect a new port…', action: async () => { const p = await requestPort(); if (p) await choosePort(p); } }] },
    { label: 'Get Board Info', action: boardInfo },
    '-',
    { label: 'Upload Binary (AVR .hex / ESP32 / ESP8266)…', action: uploadBinaryDialog },
  ] },
  { label: 'Help', items: () => [
    { label: 'Getting Started', action: () => open('https://docs.arduino.cc/software/ide-v2/tutorials/getting-started-ide-v2', '_blank', 'noopener') },
    { label: 'Reference', action: () => open('https://docs.arduino.cc/language-reference/', '_blank', 'noopener') },
    { label: 'Find in Reference', shortcut: `${mod}⇧F`, action: findInReference },
    { label: 'Troubleshooting', action: () => open('https://support.arduino.cc/hc/en-us', '_blank', 'noopener') },
    '-',
    { label: 'Source Code', action: () => open(SOURCE_URL, '_blank', 'noopener') },
    { label: 'Credits and Licenses', action: () => open(new URL('CREDITS.txt', document.baseURI).href, '_blank') },
    { label: 'About Arduino Web', action: aboutDialog },
  ] },
]);

function findInReference() {
  const model = editor.getModel();
  const word = model && editor.getPosition() ? model.getWordAtPosition(editor.getPosition())?.word : '';
  open(`https://docs.arduino.cc/search/?q=${encodeURIComponent(word || '')}`, '_blank', 'noopener');
}

// Submenus that need async data are prepared when the pointer approaches the menu bar.
let examplesCache = null;
let includeCache = null;
let sketchbookCache = [];
async function prepareMenus() {
  sketchbookCache = (await sketches.list()).sort((a, b) => a.name.localeCompare(b.name)).map((s) => ({ label: s.name, action: () => openSketch(s) }));
  examplesCache = await examplesMenu();
  includeCache = await includeLibraryItems();
}
$('menubar').addEventListener('pointerenter', () => prepareMenus().catch(() => {}));
$('menubar').addEventListener('focusin', () => prepareMenus().catch(() => {}));

// ---------------------------------------------------------------- toolbar & keys
$('verify').append(icon('verify'));
$('upload').append(icon('upload'));
$('monitor-button').append(icon('monitor'));
$('plotter-button').append(icon('plotter'));
document.querySelectorAll('[data-view]').forEach((b) => b.append(icon(b.dataset.view)));
$('verify').onclick = verify;
$('upload').onclick = () => upload();
$('monitor-button').onclick = () => openMonitor('monitor');
$('plotter-button').onclick = () => openMonitor('plotter');
$('board-button').onclick = (e) => {
  e.stopPropagation();
  const r = e.currentTarget.getBoundingClientRect();
  menubar.popup(boardMenuItems(), r.left, r.bottom + 2);
};
$('source-link').href = SOURCE_URL;

document.addEventListener('keydown', (e) => {
  if (!(isMac ? e.metaKey : e.ctrlKey)) return;
  const key = e.key.toLowerCase();
  const actions = {
    r: verify, u: () => upload(), s: e.shiftKey ? saveAs : e.altKey ? exportBinary : () => saveSketch(), o: openFromComputer, ',': preferencesDialog, t: formatDocument,
    m: e.shiftKey && (() => openMonitor('monitor')), l: e.shiftKey && (() => openMonitor('plotter')), i: e.shiftKey && (() => showView('libraries')),
    b: e.shiftKey && (() => showView('boards')), f: e.shiftKey && findInReference, n: e.altKey ? newSketch : e.shiftKey ? addFile : null, '=': () => setFontSize(1), '+': () => setFontSize(1), '-': () => setFontSize(-1),
  };
  const action = actions[key];
  if (action) {
    e.preventDefault();
    e.stopPropagation();
    action();
  }
}, true);

window.addEventListener('beforeunload', (e) => {
  if (state.sketch?.unsaved && state.dirty.size) e.preventDefault();
  else if (state.dirty.size) saveSketch({ quiet: true });
});

// ---------------------------------------------------------------- start
if (!serialSupported) $('compat').hidden = false;
renderBoardButton();
await refreshPorts();
const lastName = await kv.get('last-sketch').catch(() => null);
const last = lastName && (await sketches.get(lastName));
if (last) await openSketch(last);
else await newSketch();
setStatus('');
