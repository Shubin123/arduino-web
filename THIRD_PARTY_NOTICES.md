# Third-party notices

Arduino Web is licensed under AGPL-3.0-or-later. It is an independent
implementation; the user interface and workflow follow
[Arduino IDE 2](https://github.com/arduino/arduino-ide) (Arduino SA and
contributors, AGPL-3.0-or-later), and some user-interface messages follow
Arduino IDE 2 and [Arduino CLI](https://github.com/arduino/arduino-cli)
(Arduino SA, GPL-3.0). No Arduino IDE source code is included.

The deployed site contains or loads the following components. `npm run credits`
writes `web/public/CREDITS.txt` with the authors (taken from each component's
own metadata and source headers) and the complete license texts.

| Component | Authors | License | How it is used |
| --- | --- | --- | --- |
| [Arduino AVR Boards 1.8.8](https://github.com/arduino/ArduinoCore-avr) | Arduino SA; David A. Mellis, Nicholas Zambetti, Hernando Barragan, Cristian Maglie, Peter Barrett, Paul Stoffregen, Matthijs Kooijman and others named in the source files | LGPL-2.1-or-later | Precompiled objects and headers; full source shipped in `third_party/ArduinoCore-avr-1.8.8/` |
| [AVR-LibC](https://github.com/avrdudes/avr-libc) (from Arduino avr-gcc 7.3.0-atmel3.6.1-arduino7) | AVR-LibC contributors (see `licenses/avr-libc-LICENSE.txt`) | Modified BSD | Headers, `libc.a`, `libm.a`, startup files |
| libgcc from [GCC 7.3.0](https://gcc.gnu.org/) | Free Software Foundation, Inc. | GPL-3.0-or-later with GCC Runtime Library Exception 3.1 | Linked into firmware; source via [arduino/toolchain-avr](https://github.com/arduino/toolchain-avr) |
| GCC `cc1plus` and GNU binutils `as`/`ld`/`objcopy` compiled to WebAssembly ([@horang-corp/avr-gcc-wasm](https://github.com/horang-corp/avr-gcc-wasm) 0.2.0) | Free Software Foundation, Inc.; WebAssembly build published by the horang-corp organization | GPL-3.0-or-later | Not hosted here: loaded by the browser from jsDelivr with pinned SRI hashes |
| [arduino-examples 1.10.3](https://github.com/arduino/arduino-examples) | Authors credited in each example's comments | CC0-1.0 | Built-in examples |
| [Monaco Editor](https://github.com/microsoft/monaco-editor) 0.52.2 | Microsoft Corporation | MIT | Code editor |
| [esptool-js](https://github.com/espressif/esptool-js) 0.7.0 | Espressif Systems | Apache-2.0 | ESP32/ESP8266 flashing |
| [JSZip](https://github.com/Stuk/jszip) 3.10.1 | Stuart Knightley, David Duponchel, Franz Buchinger, António Afonso | MIT (dual MIT/GPL-3.0) | ZIP import/export |
| [pako](https://github.com/nodeca/pako) | Vitaly Puzrin, Andrei Tuputcyn, Friedel Ziegelmayer, Kirill Efimov; zlib by Jean-loup Gailly and Mark Adler | MIT and Zlib | Compression (via JSZip, esptool-js) |
| [@wasm-fmt/clang-format](https://github.com/wasm-fmt/clang-format) 23.1.1 | wasm-fmt (magic-akari); clang-format by the LLVM Project | MIT; Apache-2.0 WITH LLVM-exception | Auto Format |

Development-only tools (not distributed): Vite, Prettier, Playwright, and
[avr8js](https://github.com/wokwi/avr8js) by Uri Shaked (MIT) for simulation tests.

License texts kept in this repository: `LICENSE.txt` (AGPL-3.0),
`licenses/LGPL-2.1.txt`, `licenses/GPL-3.0.txt`,
`licenses/GCC-exception-3.1.txt`, `licenses/avr-libc-LICENSE.txt`.

Arduino is a trademark of Arduino SA. This project is not affiliated with or
endorsed by Arduino SA.
