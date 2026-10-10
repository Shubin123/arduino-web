// SPDX-License-Identifier: AGPL-3.0-or-later
// Web Serial port selection and the serial monitor connection.

export const serialSupported = 'serial' in navigator;

export function portLabel(port, boards = []) {
  const { usbVendorId, usbProductId } = port.getInfo();
  if (usbVendorId === undefined) return 'Serial port';
  const id = `${usbVendorId.toString(16).padStart(4, '0')}:${usbProductId.toString(16).padStart(4, '0')}`;
  const board = matchBoard(port, boards);
  return board ? `${board.name} (${id})` : `USB serial ${id}`;
}

export function matchBoard(port, boards) {
  const { usbVendorId, usbProductId } = port.getInfo();
  return boards.find((b) => b.usb.some(([vid, pid]) => vid === usbVendorId && pid === usbProductId));
}

export class Monitor {
  constructor({ onText, onState }) {
    this.onText = onText;
    this.onState = onState;
    this.port = null;
  }

  get open() {
    return !!this.port;
  }

  async connect(port, baudRate) {
    if (this.port) await this.disconnect();
    await port.open({ baudRate });
    this.port = port;
    this.baudRate = baudRate;
    this.onState(true);
    this.reading = this.readLoop(port);
  }

  async readLoop(port) {
    const decoder = new TextDecoder();
    while (port.readable && this.port === port) {
      this.reader = port.readable.getReader();
      try {
        for (;;) {
          const { value, done } = await this.reader.read();
          if (done) break;
          this.onText(decoder.decode(value, { stream: true }));
        }
      } catch (error) {
        if (this.port === port) this.onText(`\n[${error.message}]\n`);
      } finally {
        this.reader.releaseLock();
        this.reader = null;
      }
      if (this.closing) break;
    }
  }

  async send(text) {
    if (!this.port?.writable) throw Error('Serial monitor is not connected');
    const writer = this.port.writable.getWriter();
    try {
      await writer.write(new TextEncoder().encode(text));
    } finally {
      writer.releaseLock();
    }
  }

  async disconnect() {
    const port = this.port;
    if (!port) return;
    this.closing = true;
    try {
      await this.reader?.cancel();
    } catch {}
    await this.reading;
    this.port = null;
    this.closing = false;
    try {
      await port.close();
    } catch {}
    this.onState(false);
  }
}
