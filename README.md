# Arduino Web

An Arduino development environment that runs entirely in the browser, modelled on
the [Arduino IDE 2](https://github.com/arduino/arduino-ide). There is no server:
the site is static and can be hosted on GitHub Pages.

- **Edit** sketches in Monaco with Arduino API completion, multiple tabs and
  clang-format based Auto Format.
- **Compile** in a Web Worker with GCC 7.3.0 and GNU binutils compiled to
  WebAssembly, against the Arduino AVR core 1.8.8 that is precompiled at build
  time with the official Arduino avr-gcc toolchain.
- **Upload** over [Web Serial](https://developer.mozilla.org/docs/Web/API/Web_Serial_API)
  using the same bootloader protocols as avrdude (STK500v1/Optiboot,
  STK500v2, AVR109/Caterina), with read-back verification. ESP32/ESP8266
  binaries can be flashed with esptool-js.
- **Serial Monitor and Serial Plotter**, **Library Manager** backed by the
  official Arduino library index, the built-in **examples**, and a sketchbook
  stored in the browser (or in a folder on your computer).

Supported boards for compiling and uploading: Arduino UNO, Nano (new and old
bootloader), Mega 2560, Leonardo and Micro. See [FEATURE_PARITY.md](FEATURE_PARITY.md)
for a feature-by-feature comparison with Arduino IDE 2.

Uploading and the serial monitor need a browser with Web Serial (desktop
Chrome, Edge or Opera). Editing and compiling work in any modern browser.

## Development

Requirements: Node.js 20+, [arduino-cli](https://arduino.github.io/arduino-cli/)
and Git (only to generate the toolchain assets).

```sh
npm ci
arduino-cli core install arduino:avr@1.8.8
git clone --depth 1 --branch 1.10.3 https://github.com/arduino/arduino-examples.git examples-reference
ARDUINO_AVR_CORE=~/.arduino15/packages/arduino/hardware/avr/1.8.8 \
ARDUINO_AVR_GCC=~/.arduino15/packages/arduino/tools/avr-gcc/7.3.0-atmel3.6.1-arduino7 \
npm run assets          # precompile the AVR core, pack headers/libs, bundle examples
npm run dev             # http://localhost:5173
npm run build           # static site in dist/
```

(On macOS the arduino-cli data directory is `~/Library/Arduino15`.)

### How compilation works

`scripts/build-avr-assets.mjs` compiles the Arduino AVR core and its bundled
libraries (EEPROM, HID, SoftwareSerial, SPI, Wire) per board with the native
avr-gcc, and records the exact arguments the GCC driver (`avr-gcc -###`) passes
to `cc1plus`, `as` and `ld` for each MCU. In the browser,
`web/src/toolchain/build.js` performs the Arduino sketch preprocessing
(merging `.ino` files and generating function prototypes), resolves libraries
from `#include` directives, and runs the WebAssembly builds of those same tools
with those arguments. The WebAssembly compiler is fetched from jsDelivr and
checked against SHA-384 hashes pinned at build time.

Differences from the desktop toolchain: link-time optimisation is not used
(there is no WebAssembly `lto1`), so programs are slightly larger than with the
Arduino IDE, and C sources are compiled by the C++ front end with C linkage.

## Tests

```sh
npm test               # toolchain + upload protocol tests (Node)
npm run build && npm run test:browser   # end-to-end in headless Chrome
```

- `tests/toolchain.test.mjs` compiles sketches for every board with the
  WebAssembly tools and runs the Uno firmware in the
  [avr8js](https://github.com/wokwi/avr8js) simulator (by Uri Shaked), checking
  real behaviour (Serial output, LED toggling, EEPROM, a library with C sources,
  diagnostics mapped to `.ino` line numbers).
- `tests/upload.test.mjs` flashes emulated Optiboot, STK500v2 and Caterina
  bootloaders through the Web Serial code path and verifies the written flash.
- `tests/browser.mjs` drives the built site: compile, upload to an emulated Uno
  over a fake Web Serial port, install a library from the Arduino index and
  compile with it, error markers, and examples.

Uploads to physical boards use the protocols exercised above but depend on the
board and USB adapter; please report any board that does not work.

## Deployment

`.github/workflows/pages.yml` installs the Arduino AVR core with arduino-cli,
generates the assets, runs the tests and publishes `dist/` to GitHub Pages.

## License

Copyright (C) 2026 Shubin123.

Arduino Web is free software: you can redistribute it and/or modify it under the
terms of the GNU Affero General Public License as published by the Free Software
Foundation, either version 3 of the License, or (at your option) any later
version. See [LICENSE.txt](LICENSE.txt). The deployed site links to this source
repository, as required by section 13 of the AGPL for network use.

Third-party components keep their own licenses and copyright notices; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The generated `CREDITS.txt`
(served with the site) lists the authors of every bundled component with full
license texts.

Arduino is a trademark of Arduino SA. This is an independent project and is not
affiliated with or endorsed by Arduino SA.
