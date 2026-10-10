// SPDX-License-Identifier: AGPL-3.0-or-later
// STK500 version 2 protocol, as implemented by the stk500v2 bootloader used on
// Arduino Mega 2560 (avrdude programmer id "wiring"). Protocol reference:
// Atmel application note AVR068.
import { checkSignature, pad, sleep, verifyPage } from './link.js';
import { resetIntoBootloader } from './stk500v1.js';

const START = 0x1b;
const TOKEN = 0x0e;

export class Stk500v2 {
  constructor(link) {
    this.link = link;
    this.sequence = 0;
  }

  async send(body, timeout = 1000) {
    const seq = this.sequence;
    this.sequence = (this.sequence + 1) & 0xff;
    const message = [START, seq, body.length >> 8, body.length & 0xff, TOKEN, ...body];
    message.push(message.reduce((a, b) => a ^ b, 0));
    await this.link.write(message);
    const head = await this.link.read(5, timeout);
    if (head[0] !== START || head[4] !== TOKEN || head[1] !== seq) throw Error('Invalid STK500v2 response header');
    const size = (head[2] << 8) | head[3];
    const rest = await this.link.read(size + 1, timeout);
    const checksum = [...head, ...rest].reduce((a, b) => a ^ b, 0);
    if (checksum !== 0) throw Error('STK500v2 checksum error');
    const response = rest.subarray(0, size);
    if (response[0] !== body[0]) throw Error(`Unexpected STK500v2 answer 0x${response[0].toString(16)} to command 0x${body[0].toString(16)}`);
    if (response[1] !== 0x00) throw Error(`STK500v2 command 0x${body[0].toString(16)} failed with status 0x${response[1].toString(16)}`);
    return response;
  }

  loadAddress(byteAddress) {
    const word = (byteAddress >> 1) | 0x80000000;
    return this.send([0x06, (word >>> 24) & 0xff, (word >> 16) & 0xff, (word >> 8) & 0xff, word & 0xff]);
  }
}

export async function flashStk500v2(link, image, { signature, pageSize = 256, progress = () => {}, log = () => {}, reset = true }) {
  if (reset) await resetIntoBootloader(link);
  const stk = new Stk500v2(link);
  let signedOn = null;
  for (let attempt = 0; attempt < 10 && !signedOn; attempt++) {
    try {
      signedOn = await stk.send([0x01], 300); // CMD_SIGN_ON
    } catch {
      link.drain();
      stk.sequence = 0;
      await sleep(50);
    }
  }
  if (!signedOn) throw Error('Could not synchronise with the bootloader (STK500v2). Check the board and port.');
  log(`Programmer: ${new TextDecoder().decode(signedOn.subarray(3, 3 + signedOn[2]))}\n`);
  // CMD_ENTER_PROGMODE_ISP with the parameters avrdude uses for the ATmega2560.
  await stk.send([0x10, 200, 100, 25, 32, 0, 0x53, 3, 0xac, 0x53, 0x00, 0x00]);
  const sig = [];
  for (let i = 0; i < 3; i++) sig.push((await stk.send([0x1b, 4, 0x30, 0x00, i, 0x00]))[2]); // CMD_READ_SIGNATURE_ISP
  checkSignature(signature, sig);
  const data = pad(image, pageSize);
  const total = data.length / pageSize;
  for (let page = 0; page < total; page++) {
    const address = page * pageSize;
    await stk.loadAddress(address);
    // CMD_PROGRAM_FLASH_ISP, page mode with page write (0xC1).
    await stk.send([0x13, pageSize >> 8, pageSize & 0xff, 0xc1, 10, 0x40, 0x4c, 0x20, 0x00, 0x00, ...data.subarray(address, address + pageSize)], 3000);
    progress('Writing', page + 1, total);
  }
  for (let page = 0; page < total; page++) {
    const address = page * pageSize;
    await stk.loadAddress(address);
    const response = await stk.send([0x14, pageSize >> 8, pageSize & 0xff, 0x20], 3000); // CMD_READ_FLASH_ISP
    verifyPage(data.subarray(address, address + pageSize), response.subarray(2, 2 + pageSize), address);
    progress('Verifying', page + 1, total);
  }
  await stk.send([0x11, 1, 1]); // CMD_LEAVE_PROGMODE_ISP
  return { bytes: image.length };
}
