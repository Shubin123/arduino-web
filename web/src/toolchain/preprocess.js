// SPDX-License-Identifier: AGPL-3.0-or-later
// Arduino sketch preprocessing: merge .ino files, add `#include <Arduino.h>`,
// and generate prototypes for top-level functions so they can be called before
// their definition. Uses #line directives so diagnostics point at the .ino files.

// Replace comments, string and character literals with spaces (keeping newlines),
// so structural scanning only sees code.
export function maskCode(text) {
  const out = text.split('');
  let i = 0;
  const blank = (from, to) => {
    for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    if (c === '/' && n === '/') {
      let end = text.indexOf('\n', i);
      if (end < 0) end = text.length;
      blank(i, end);
      i = end;
    } else if (c === '/' && n === '*') {
      let end = text.indexOf('*/', i + 2);
      end = end < 0 ? text.length : end + 2;
      blank(i, end);
      i = end;
    } else if (c === '"' || c === "'") {
      // Raw string literals R"delim( ... )delim"
      if (c === '"' && text[i - 1] === 'R' && !/\w/.test(text[i - 2] || '')) {
        const open = text.indexOf('(', i);
        const delim = text.slice(i + 1, open);
        let end = text.indexOf(`)${delim}"`, open);
        end = end < 0 ? text.length : end + delim.length + 2;
        blank(i + 1, end - 1);
        i = end;
        continue;
      }
      let j = i + 1;
      while (j < text.length && text[j] !== c && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
      blank(i + 1, j);
      i = j + 1;
    } else i++;
  }
  return out.join('');
}

const NOT_A_FUNCTION = /^(?:if|else|for|while|switch|do|return|struct|class|union|enum|namespace|typedef|using|extern\s+"C")\b/;

// Returns [{start, end, prototype, name}] for top-level function definitions.
export function findFunctions(text) {
  const code = maskCode(text);
  const results = [];
  let depth = 0;
  let parens = 0;
  let statementStart = 0;
  let lineStart = true;
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (lineStart && depth === 0) {
      // Skip preprocessor directives (with line continuations).
      let j = i;
      while (code[j] === ' ' || code[j] === '\t') j++;
      if (code[j] === '#') {
        while (j < code.length && !(code[j] === '\n' && code[j - 1] !== '\\')) j++;
        i = j;
        statementStart = j + 1;
        lineStart = true;
        continue;
      }
    }
    lineStart = c === '\n';
    if (c === '(') parens++;
    else if (c === ')') parens--;
    else if (c === '{') {
      if (depth === 0 && parens === 0) {
        const head = text.slice(statementStart, i).trim();
        const masked = code.slice(statementStart, i).trim();
        const proto = prototypeFor(head, masked);
        if (proto) results.push({ start: statementStart + (code.slice(statementStart, i).length - code.slice(statementStart, i).trimStart().length), end: i, ...proto });
      }
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0) statementStart = i + 1;
    } else if (c === ';' && depth === 0 && parens === 0) statementStart = i + 1;
  }
  return results;
}

function prototypeFor(head, masked) {
  if (!masked.endsWith(')') && !/\)\s*const$/.test(masked)) return null;
  if (NOT_A_FUNCTION.test(masked) || masked.includes('=') && masked.indexOf('=') < masked.indexOf('(')) return null;
  const match = masked.match(/^([\s\S]*?[\w*&>\]\s])\s*([A-Za-z_]\w*)\s*\(([\s\S]*)\)\s*(const)?$/);
  if (!match) return null;
  const [, returnType, name] = match;
  if (!returnType.trim() || /::/.test(masked) || /^(?:ISR|SIGNAL)$/.test(name)) return null;
  // Top-level default arguments cannot be repeated in a prototype; skip those.
  const params = match[3];
  let level = 0;
  for (const ch of params) {
    if ('(<['.includes(ch)) level++;
    else if (')>]'.includes(ch)) level--;
    else if (ch === '=' && level === 0) return null;
  }
  return { name, prototype: head.replace(/\s+/g, ' ') + ';' };
}

// files: {name: content}; mainName: e.g. "Blink.ino". Returns C++ source text.
export function preprocessSketch(files, mainName) {
  const inos = Object.keys(files)
    .filter((f) => f.endsWith('.ino') || f.endsWith('.pde'))
    .sort((a, b) => (a === mainName ? -1 : b === mainName ? 1 : a.localeCompare(b)));
  if (!inos.includes(mainName)) throw Error(`Main sketch file ${mainName} not found`);
  // Build the merged text and remember which file/line each merged line maps to.
  let merged = '';
  const lineMap = [];
  for (const file of inos) {
    const content = files[file].replace(/\r\n?/g, '\n');
    merged += `#line 1 "${file}"\n`;
    lineMap.push(null);
    const lines = content.split('\n');
    lines.forEach((_, index) => lineMap.push([file, index + 1]));
    merged += content.endsWith('\n') ? content : content + '\n';
    if (content.endsWith('\n')) lineMap.pop();
  }
  const functions = findFunctions(merged);
  const header = '#include <Arduino.h>\n';
  if (!functions.length) return header + merged;
  // Insert prototypes at the beginning of the line holding the first definition.
  const first = functions[0];
  const insertAt = merged.lastIndexOf('\n', first.start - 1) + 1;
  const insertLine = merged.slice(0, insertAt).split('\n').length - 1;
  const [file, line] = lineMap[insertLine] || [mainName, 1];
  const seen = new Set();
  const prototypes = functions
    .filter((f) => !seen.has(f.prototype) && seen.add(f.prototype))
    .map((f) => f.prototype)
    .join('\n');
  return header + merged.slice(0, insertAt) + `#line ${line} "${file}"\n${prototypes}\n#line ${line} "${file}"\n` + merged.slice(insertAt);
}

// Header names referenced by #include directives.
export function includedHeaders(text) {
  const names = [];
  for (const match of maskIncludeSafe(text).matchAll(/^[ \t]*#[ \t]*include[ \t]*[<"]([^>"]+)[>"]/gm)) names.push(match[1].trim());
  return names;
}

// Comments are removed, but the contents of #include "…" must survive.
function maskIncludeSafe(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/\/\/[^\n]*/g, '');
}
