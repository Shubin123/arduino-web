// Emulated bootloaders behind a Web Serial-shaped port, for protocol tests.
// They follow AVR061 (STK500v1/Optiboot), AVR068 (STK500v2) and AVR109 (Caterina).
export class FakePort {
  constructor(device) {
    this.device = device;
    this.signals = [];
  }
  async open({ baudRate }) {
    this.baudRate = baudRate;
    let controller;
    this.readable = new ReadableStream({ start: (c) => (controller = c) });
    this.device.send = (bytes) => controller.enqueue(Uint8Array.from(bytes));
    this.device.closeStream = () => { try { controller.close(); } catch {} };
    this.writable = new WritableStream({ write: (chunk) => this.device.receive([...chunk]) });
  }
  async setSignals(signals) {
    this.signals.push(signals);
    if (signals.dataTerminalReady) this.device.reset?.();
  }
  async close() {
    this.device.closeStream();
  }
}

class Base {
  constructor({ flashSize, signature }) {
    this.flash = new Uint8Array(flashSize).fill(0xff);
    this.signature = signature;
    this.input = [];
  }
  receive(bytes) {
    this.input.push(...bytes);
    this.process();
  }
}

export class Optiboot extends Base {
  process() {
    for (;;) {
      const cmd = this.input[0];
      if (cmd === undefined) return;
      const need = { 0x30: 2, 0x75: 2, 0x50: 2, 0x51: 2, 0x55: 4, 0x74: 5 }[cmd] ?? (cmd === 0x64 ? (this.input.length >= 3 ? 5 + ((this.input[1] << 8) | this.input[2]) : Infinity) : 1);
      if (this.input.length < need) return;
      const packet = this.input.splice(0, need);
      if (packet[packet.length - 1] !== 0x20) { this.send([0x15]); continue; }
      if (cmd === 0x55) this.address = (packet[1] | (packet[2] << 8)) * 2;
      if (cmd === 0x64) this.flash.set(packet.slice(4, -1), this.address);
      if (cmd === 0x75) this.send([0x14, ...this.signature, 0x10]);
      else if (cmd === 0x74) { const n = (packet[1] << 8) | packet[2]; this.send([0x14, ...this.flash.subarray(this.address, this.address + n), 0x10]); }
      else this.send([0x14, 0x10]);
    }
  }
}

export class Stk500v2Boot extends Base {
  process() {
    for (;;) {
      if (this.input.length < 5) return;
      const size = (this.input[2] << 8) | this.input[3];
      if (this.input.length < 6 + size) return;
      const message = this.input.splice(0, 6 + size);
      const [, seq] = message;
      if (message.reduce((a, b) => a ^ b, 0) !== 0) throw Error('bad checksum from host');
      const body = message.slice(5, 5 + size);
      let answer;
      switch (body[0]) {
        case 0x01: answer = [0x01, 0x00, 8, ...new TextEncoder().encode('AVRISP_2')]; break;
        case 0x10: case 0x11: answer = [body[0], 0x00]; break;
        case 0x1b: answer = [0x1b, 0x00, this.signature[body[4]], 0x00]; break;
        case 0x06: this.address = (((body[1] & 0x7f) << 24) | (body[2] << 16) | (body[3] << 8) | body[4]) * 2; answer = [0x06, 0x00]; break;
        case 0x13: { const n = (body[1] << 8) | body[2]; this.flash.set(body.slice(10, 10 + n), this.address); this.address += n; answer = [0x13, 0x00]; break; }
        case 0x14: { const n = (body[1] << 8) | body[2]; answer = [0x14, 0x00, ...this.flash.subarray(this.address, this.address + n), 0x00]; this.address += n; break; }
        default: answer = [body[0], 0xc0];
      }
      const reply = [0x1b, seq, answer.length >> 8, answer.length & 0xff, 0x0e, ...answer];
      reply.push(reply.reduce((a, b) => a ^ b, 0));
      this.send(reply);
    }
  }
}

export class Caterina extends Base {
  process() {
    for (;;) {
      const cmd = this.input[0];
      if (cmd === undefined) return;
      const need = { 0x41: 3, 0x67: 4 }[cmd] ?? (cmd === 0x42 ? (this.input.length >= 3 ? 4 + ((this.input[1] << 8) | this.input[2]) : Infinity) : 1);
      if (this.input.length < need) return;
      const p = this.input.splice(0, need);
      switch (cmd) {
        case 0x53: this.send([...new TextEncoder().encode('CATERIN')]); break;
        case 0x62: this.send([0x59, 0x00, 0x80]); break;
        case 0x73: this.send([...this.signature].reverse()); break;
        case 0x65: this.flash.fill(0xff); this.send([0x0d]); break;
        case 0x41: this.address = ((p[1] << 8) | p[2]) * 2; this.send([0x0d]); break;
        case 0x42: { const n = (p[1] << 8) | p[2]; this.flash.set(p.slice(4), this.address); this.address += n; this.send([0x0d]); break; }
        case 0x67: { const n = (p[1] << 8) | p[2]; this.send([...this.flash.subarray(this.address, this.address + n)]); this.address += n; break; }
        default: this.send([0x0d]);
      }
    }
  }
}
