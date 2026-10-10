// SPDX-License-Identifier: AGPL-3.0-or-later
// STK500 version 1 protocol, as implemented by the Optiboot bootloader used on
// Arduino Uno and Nano (avrdude programmer id "arduino"). Protocol reference:
// Atmel application note AVR061.
import { checkSignature, pad, sleep, verifyPage } from './link.js';

const OK = 0x10;
const INSYNC = 0x14;
const EOP = 0x20;

async function command(link, bytes, responseLength = 0, timeout = 1000) {
  await link.write([...bytes, EOP]);
  const response = await link.read(responseLength + 2, timeout);
  if (response[0] !== INSYNC || response[response.length - 1] !== OK) throw Error(`Programmer is out of sync (response ${[...response].map((b) => b.toString(16)).join(' ')})`);
  return response.subarray(1, response.length - 1);
}

export async function resetIntoBootloader(link) {
  await link.setSignals({ dataTerminalReady: false, requestToSend: false });
  await sleep(250);
  await link.setSignals({ dataTerminalReady: true, requestToSend: true });
  await sleep(50);
  link.drain();
}

export async function flashStk500v1(link, image, { signature, pageSize = 128, progress = () => {}, log = () => {}, reset = true }) {
  if (reset) await resetIntoBootloader(link);
  let synced = false;
  for (let attempt = 0; attempt < 10 && !synced; attempt++) {
    try {
      await command(link, [0x30], 0, 200); // STK_GET_SYNC
      synced = true;
    } catch {
      link.drain();
    }
  }
  if (!synced) throw Error('Could not synchronise with the bootloader (STK500v1). Check the board, port and selected processor/bootloader.');
  log('Bootloader in sync\n');
  const sig = await command(link, [0x75], 3); // STK_READ_SIGN
  checkSignature(signature, sig);
  await command(link, [0x50]); // STK_ENTER_PROGMODE
  const data = pad(image, pageSize);
  const total = data.length / pageSize;
  for (let page = 0; page < total; page++) {
    const address = page * pageSize;
    await command(link, [0x55, (address >> 1) & 0xff, (address >> 9) & 0xff]); // STK_LOAD_ADDRESS (word address)
    await command(link, [0x64, pageSize >> 8, pageSize & 0xff, 0x46, ...data.subarray(address, address + pageSize)], 0, 2000); // STK_PROG_PAGE 'F'
    progress('Writing', page + 1, total);
  }
  for (let page = 0; page < total; page++) {
    const address = page * pageSize;
    await command(link, [0x55, (address >> 1) & 0xff, (address >> 9) & 0xff]);
    const read = await command(link, [0x74, pageSize >> 8, pageSize & 0xff, 0x46], pageSize); // STK_READ_PAGE
    verifyPage(data.subarray(address, address + pageSize), read, address);
    progress('Verifying', page + 1, total);
  }
  await command(link, [0x51]); // STK_LEAVE_PROGMODE
  return { bytes: image.length };
}
