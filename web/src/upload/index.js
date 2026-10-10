// SPDX-License-Identifier: AGPL-3.0-or-later
// Chooses the upload protocol for a board and handles board-specific reset.
import { parseIntelHex } from '../toolchain/binary.js';
import { SerialLink, sleep } from './link.js';
import { flashStk500v1 } from './stk500v1.js';
import { flashStk500v2 } from './stk500v2.js';
import { flashAvr109 } from './avr109.js';

const VENDORS = [0x2341, 0x2a03];

async function withLink(port, baudRate, fn) {
  const link = new SerialLink(port);
  await link.open(baudRate);
  try {
    return await fn(link);
  } finally {
    await link.close().catch(() => {});
  }
}

// Leonardo/Micro: opening the port at 1200 baud and closing it makes the sketch
// reboot into the Caterina bootloader, which enumerates as a different USB device.
async function findBootloaderPort(original, pids, requestPort, log) {
  const info = original.getInfo();
  if (pids.includes(info.usbProductId)) return original;
  await original.open({ baudRate: 1200 });
  await original.setSignals({ dataTerminalReady: false }).catch(() => {});
  await original.close();
  log('Waiting for the bootloader port…\n');
  // Caterina stays in the bootloader for about 8 s; poll previously granted ports first.
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    await sleep(250);
    for (const port of await navigator.serial.getPorts()) {
      const { usbVendorId, usbProductId } = port.getInfo();
      if (VENDORS.includes(usbVendorId) && pids.includes(usbProductId)) return port;
    }
  }
  // The bootloader port has not been granted to this site yet; ask the user.
  return requestPort(VENDORS.flatMap((usbVendorId) => pids.map((usbProductId) => ({ usbVendorId, usbProductId }))));
}

export async function uploadHex({ hex, board, profile, options = {}, port, requestPort, log = () => {}, progress = () => {} }) {
  const image = parseIntelHex(hex);
  const upload = { ...board.upload };
  for (const [key, value] of Object.entries(options)) {
    const choice = board.options?.[key]?.values.find((v) => v.id === value);
    if (choice?.upload) Object.assign(upload, choice.upload);
  }
  const common = { signature: profile.signature, pageSize: profile.pageSize, progress, log };
  log(`Uploading ${image.length} bytes with ${upload.protocol} at ${upload.speed} baud\n`);
  switch (upload.protocol) {
    case 'stk500v1':
      return withLink(port, upload.speed, (link) => flashStk500v1(link, image, common));
    case 'stk500v2':
      return withLink(port, upload.speed, (link) => flashStk500v2(link, image, common));
    case 'avr109': {
      const bootPort = upload.touch1200 ? await findBootloaderPort(port, upload.bootloaderPids, requestPort, log) : port;
      return withLink(bootPort, upload.speed, (link) => flashAvr109(link, image, common));
    }
    default:
      throw Error(`Upload protocol ${upload.protocol} is not supported in the browser`);
  }
}
