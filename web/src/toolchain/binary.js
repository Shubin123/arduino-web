// SPDX-License-Identifier: AGPL-3.0-or-later
// Intel HEX parsing/serialisation and ELF section sizes (equivalent to avr-size -A).

export function parseIntelHex(text) {
  const chunks = [];
  let base = 0;
  let max = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line[0] !== ':') throw Error(`Invalid Intel HEX line: ${line}`);
    const bytes = line.slice(1).match(/../g).map((h) => parseInt(h, 16));
    const sum = bytes.reduce((a, b) => a + b, 0) & 0xff;
    if (sum !== 0) throw Error(`Intel HEX checksum mismatch: ${line}`);
    const [count, hi, lo, type] = bytes;
    const payload = bytes.slice(4, 4 + count);
    if (type === 0) {
      const address = base + ((hi << 8) | lo);
      chunks.push([address, payload]);
      max = Math.max(max, address + count);
    } else if (type === 1) break;
    else if (type === 2) base = ((payload[0] << 8) | payload[1]) << 4;
    else if (type === 4) base = ((payload[0] << 8) | payload[1]) << 16;
  }
  const image = new Uint8Array(max).fill(0xff);
  for (const [address, payload] of chunks) image.set(payload, address);
  return image;
}

export function toIntelHex(image, recordSize = 16) {
  const lines = [];
  const record = (type, address, data) => {
    const bytes = [data.length, (address >> 8) & 0xff, address & 0xff, type, ...data];
    const checksum = (-bytes.reduce((a, b) => a + b, 0)) & 0xff;
    lines.push(':' + [...bytes, checksum].map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(''));
  };
  let upper = 0;
  for (let offset = 0; offset < image.length; offset += recordSize) {
    if (offset >> 16 !== upper) {
      upper = offset >> 16;
      record(4, 0, [(upper >> 8) & 0xff, upper & 0xff]);
    }
    record(0, offset & 0xffff, [...image.subarray(offset, Math.min(offset + recordSize, image.length))]);
  }
  record(1, 0, []);
  return lines.join('\n') + '\n';
}

export function elfSections(elf) {
  const view = new DataView(elf.buffer, elf.byteOffset, elf.byteLength);
  if (view.getUint32(0) !== 0x7f454c46 || elf[4] !== 1) throw Error('Not a 32-bit ELF file');
  const le = elf[5] === 1;
  const shoff = view.getUint32(32, le);
  const shentsize = view.getUint16(46, le);
  const shnum = view.getUint16(48, le);
  const shstrndx = view.getUint16(50, le);
  const header = (i) => shoff + i * shentsize;
  const strtab = view.getUint32(header(shstrndx) + 16, le);
  const name = (offset) => {
    let end = strtab + offset;
    while (elf[end]) end++;
    return new TextDecoder().decode(elf.subarray(strtab + offset, end));
  };
  const sections = {};
  for (let i = 0; i < shnum; i++) {
    const h = header(i);
    sections[name(view.getUint32(h, le))] = view.getUint32(h + 20, le);
  }
  return sections;
}

// Same section groups as recipe.size.regex in Arduino AVR platform.txt.
export function programSize(elf) {
  const s = elfSections(elf);
  return {
    flash: (s['.text'] || 0) + (s['.data'] || 0) + (s['.bootloader'] || 0),
    ram: (s['.data'] || 0) + (s['.bss'] || 0) + (s['.noinit'] || 0),
    eeprom: s['.eeprom'] || 0,
  };
}
