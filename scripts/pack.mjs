// SPDX-License-Identifier: AGPL-3.0-or-later
// Minimal container used to ship many small toolchain files in one request.
// Layout: [u32 LE header length][JSON header {path: [offset, length]}][payload]

export function encodePack(entries) {
  const index = {};
  let offset = 0;
  for (const [file, bytes] of entries) {
    index[file] = [offset, bytes.length];
    offset += bytes.length;
  }
  const header = new TextEncoder().encode(JSON.stringify(index));
  const out = new Uint8Array(4 + header.length + offset);
  new DataView(out.buffer).setUint32(0, header.length, true);
  out.set(header, 4);
  let position = 4 + header.length;
  for (const [, bytes] of entries) {
    out.set(bytes, position);
    position += bytes.length;
  }
  return out;
}

export function decodePack(buffer) {
  const bytes = new Uint8Array(buffer);
  const headerLength = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true);
  const index = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + headerLength)));
  const base = 4 + headerLength;
  const files = new Map();
  for (const [file, [offset, length]] of Object.entries(index)) {
    files.set(file, bytes.subarray(base + offset, base + offset + length));
  }
  return files;
}
