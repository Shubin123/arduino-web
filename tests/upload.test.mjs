import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Caterina, FakePort, Optiboot, Stk500v2Boot } from './helpers/fake-boards.mjs';
import { SerialLink } from '../web/src/upload/link.js';
import { flashStk500v1 } from '../web/src/upload/stk500v1.js';
import { flashStk500v2 } from '../web/src/upload/stk500v2.js';
import { flashAvr109 } from '../web/src/upload/avr109.js';

const image = (size) => Uint8Array.from({ length: size }, (_, i) => (i * 31 + 7) & 0xff);

async function flashWith(Device, flasher, options, size, deviceOptions) {
  const device = new Device(deviceOptions);
  const port = new FakePort(device);
  const link = new SerialLink(port);
  await link.open(options.baud);
  const data = image(size);
  const steps = [];
  await flasher(link, data, { ...options, progress: (phase, done, total) => steps.push([phase, done, total]) });
  await link.close();
  assert.deepEqual(device.flash.subarray(0, data.length), data);
  assert.ok(steps.some(([phase]) => phase === 'Verifying'));
  return { device, port };
}

test('STK500v1 (Optiboot, Uno) writes and verifies flash, resetting via DTR/RTS', async () => {
  const sig = [0x1e, 0x95, 0x0f];
  const { port } = await flashWith(Optiboot, flashStk500v1, { baud: 115200, signature: sig, pageSize: 128 }, 3000, { flashSize: 32768, signature: sig });
  assert.deepEqual(port.signals.map((s) => s.dataTerminalReady), [false, true]);
});

test('STK500v2 (Mega 2560) writes and verifies flash beyond 64 KiB', async () => {
  const sig = [0x1e, 0x98, 0x01];
  await flashWith(Stk500v2Boot, flashStk500v2, { baud: 115200, signature: sig, pageSize: 256 }, 70000, { flashSize: 262144, signature: sig });
});

test('AVR109 (Caterina, Leonardo) writes and verifies flash', async () => {
  const sig = [0x1e, 0x95, 0x87];
  await flashWith(Caterina, flashAvr109, { baud: 57600, signature: sig, pageSize: 128 }, 5000, { flashSize: 32768, signature: sig });
});

test('wrong board selection is detected by device signature', async () => {
  const device = new Optiboot({ flashSize: 32768, signature: [0x1e, 0x98, 0x01] });
  const link = new SerialLink(new FakePort(device));
  await link.open(115200);
  await assert.rejects(flashStk500v1(link, image(256), { signature: [0x1e, 0x95, 0x0f] }), /signature/);
  await link.close();
});
