// SPDX-License-Identifier: AGPL-3.0-or-later
// Espressif ESP8266/ESP32 flashing through esptool-js (Espressif Systems, Apache-2.0).
import { ESPLoader, Transport } from 'esptool-js';

export async function flashEsp(port, images, { baudRate = 921600, eraseAll = false, progress = () => {}, log = () => {} }) {
  const transport = new Transport(port, false);
  const terminal = { clean() {}, writeLine: (line) => log(line + '\n'), write: (text) => log(text) };
  const loader = new ESPLoader({ transport, baudrate: baudRate, terminal, debugLogging: false });
  try {
    const chip = await loader.main();
    log(`Connected to ${chip}\n`);
    await loader.writeFlash({
      fileArray: images.map(({ data, address }) => ({ data, address })),
      flashMode: 'keep',
      flashFreq: 'keep',
      flashSize: 'keep',
      eraseAll,
      compress: true,
      reportProgress: (index, written, total) => progress(`Writing image ${index + 1}/${images.length}`, written, total),
    });
    await loader.after('hard_reset');
  } finally {
    await transport.disconnect();
  }
}
