// SPDX-License-Identifier: AGPL-3.0-or-later
// Byte-oriented request/response access to a Web Serial port.

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class SerialLink {
  constructor(port) {
    this.port = port;
    this.buffer = [];
    this.waiters = [];
  }

  async open(baudRate) {
    await this.port.open({ baudRate });
    this.writer = this.port.writable.getWriter();
    this.reader = this.port.readable.getReader();
    this.pumping = this.pump();
  }

  async pump() {
    try {
      for (;;) {
        const { value, done } = await this.reader.read();
        if (done) break;
        for (const byte of value) this.buffer.push(byte);
        this.notify();
      }
    } catch (error) {
      this.error = error;
    }
    this.closed = true;
    this.notify();
  }

  notify() {
    const waiters = this.waiters;
    this.waiters = [];
    for (const wake of waiters) wake();
  }

  async read(count, timeout = 1000) {
    const deadline = Date.now() + timeout;
    while (this.buffer.length < count) {
      if (this.error) throw this.error;
      if (this.closed) throw Error('Serial port closed');
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw Error('Timed out waiting for a response from the board');
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, remaining);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    return Uint8Array.from(this.buffer.splice(0, count));
  }

  drain() {
    this.buffer.length = 0;
  }

  write(bytes) {
    return this.writer.write(Uint8Array.from(bytes));
  }

  setSignals(signals) {
    return this.port.setSignals(signals);
  }

  async close() {
    try {
      await this.reader.cancel();
    } catch {}
    await this.pumping;
    this.reader.releaseLock();
    try {
      await this.writer.close();
    } catch {}
    this.writer.releaseLock();
    await this.port.close();
  }
}

export function pad(image, pageSize) {
  const length = Math.ceil(image.length / pageSize) * pageSize;
  const out = new Uint8Array(length).fill(0xff);
  out.set(image);
  return out;
}

export function hex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join(' ');
}

export function verifyPage(expected, actual, address) {
  for (let i = 0; i < expected.length; i++) {
    if (expected[i] !== actual[i]) throw Error(`Verification failed at 0x${(address + i).toString(16)}: wrote 0x${expected[i].toString(16)}, read 0x${actual[i].toString(16)}`);
  }
}

export function checkSignature(expected, actual) {
  if (expected && expected.some((b, i) => b !== actual[i])) {
    throw Error(`Device signature ${hex(actual)} does not match the selected board (${hex(expected)}). Check the board selection.`);
  }
}
