// SPDX-License-Identifier: AGPL-3.0-or-later
// AVR109 (butterfly) protocol, as implemented by the Caterina bootloader used on
// Arduino Leonardo and Micro. Protocol reference: Atmel application note AVR109.
import { checkSignature, pad, verifyPage } from './link.js';

const CR = 0x0d;

async function expectCR(link, bytes, timeout = 1000) {
  await link.write(bytes);
  const [answer] = await link.read(1, timeout);
  if (answer !== CR) throw Error(`AVR109 command '${String.fromCharCode(bytes[0])}' was not acknowledged`);
}

export async function flashAvr109(link, image, { signature, pageSize = 128, progress = () => {}, log = () => {} }) {
  link.drain();
  await link.write([0x53]); // 'S' software identifier
  const id = new TextDecoder().decode(await link.read(7, 2000));
  log(`Found programmer: ${id}\n`);
  await link.write([0x62]); // 'b' block support
  const block = await link.read(3);
  const blockSize = block[0] === 0x59 ? Math.min((block[1] << 8) | block[2], pageSize) : pageSize;
  await link.write([0x73]); // 's' signature, reported low byte first
  const sig = [...(await link.read(3))].reverse();
  checkSignature(signature, sig);
  await expectCR(link, [0x50]); // 'P' enter programming mode
  await expectCR(link, [0x65], 10000); // 'e' chip erase
  const data = pad(image, blockSize);
  const total = data.length / blockSize;
  for (let i = 0; i < total; i++) {
    const address = i * blockSize;
    await expectCR(link, [0x41, (address >> 9) & 0xff, (address >> 1) & 0xff]); // 'A' word address
    await expectCR(link, [0x42, blockSize >> 8, blockSize & 0xff, 0x46, ...data.subarray(address, address + blockSize)], 2000); // 'B' ... 'F'
    progress('Writing', i + 1, total);
  }
  for (let i = 0; i < total; i++) {
    const address = i * blockSize;
    await expectCR(link, [0x41, (address >> 9) & 0xff, (address >> 1) & 0xff]);
    await link.write([0x67, blockSize >> 8, blockSize & 0xff, 0x46]); // 'g' block read
    verifyPage(data.subarray(address, address + blockSize), await link.read(blockSize, 2000), address);
    progress('Verifying', i + 1, total);
  }
  await expectCR(link, [0x4c]); // 'L' leave programming mode
  await expectCR(link, [0x45]); // 'E' exit bootloader
  return { bytes: image.length };
}
