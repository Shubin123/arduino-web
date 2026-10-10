# Feature comparison with Arduino IDE 2

Reference: Arduino IDE 2.3.x. “Browser” means the feature runs without any
native software; everything here does.

| Arduino IDE 2 feature | Arduino Web | Notes |
| --- | --- | --- |
| Editor (syntax highlighting, find/replace, go to line, comment, indent, font size) | ✅ | Monaco Editor |
| Code completion | ⚠️ Partial | Arduino API, constants and identifiers in the file. The IDE's clangd-based language server cannot run in the browser. |
| Auto Format | ✅ | clang-format (WebAssembly) |
| Multiple tabs, add/rename/delete files | ✅ | `.ino`, `.h`, `.cpp`, `.c`, `src/` folder |
| Sketchbook, New, Save, Save As, Rename, Delete | ✅ | Stored in the browser (IndexedDB) |
| Open a sketch folder on disk / save back to it | ✅ | File System Access API (Chromium). Other browsers: import files or a ZIP. |
| Archive Sketch (ZIP) | ✅ | |
| Built-in examples | ✅ | arduino-examples 1.10.3 and bundled-library examples |
| Examples from installed libraries | ✅ | |
| Verify/Compile | ✅ | GCC 7.3.0 in WebAssembly. No LTO, so programs are slightly larger than in the IDE. |
| Compiler warnings level, verbose output | ✅ | |
| Errors highlighted in the editor | ✅ | Mapped to `.ino` lines |
| Export Compiled Binary | ✅ | Downloads the `.hex` |
| Upload | ✅ | Web Serial. UNO and Nano (STK500v1), Mega 2560 (STK500v2), Leonardo and Micro (AVR109 with 1200-baud reset). Verified by reading the flash back. |
| Upload Using Programmer, Burn Bootloader | ❌ | Needs ISP programmers that are not exposed to Web Serial/WebUSB in a portable way |
| Board selection, board auto-detection by USB VID/PID | ✅ | |
| Board options (e.g. Nano processor/bootloader) | ✅ | |
| Boards Manager (install other platforms) | ❌ | Only Arduino AVR Boards 1.8.8 is precompiled. Other platforms (ESP32, SAMD, mbed, RP2040…) need native toolchains. ESP32/ESP8266 **binaries** can be uploaded with esptool-js. |
| Library Manager (search, install versions, dependencies, remove, update) | ✅ | Official Arduino library index; downloads checked with SHA-256 |
| Add .ZIP Library, Include Library | ✅ | |
| Serial Monitor (baud, line ending, timestamps, autoscroll) | ✅ | Web Serial |
| Serial Plotter | ✅ | Integrated as a panel (labels, legend, pause, window size) |
| Debugger | ❌ | Requires GDB and debug probes |
| Arduino Cloud sketchbook | ❌ | |
| Firmware / certificate updater (WiFiNINA, WiFi101) | ❌ | |
| Network (OTA) upload | ❌ | Browsers cannot open raw network connections to boards |
| Themes (light/dark) | ✅ | |
| Localisation | ❌ | English only |
| Keyboard shortcuts | ✅ | IDE shortcuts where the browser allows (for example Ctrl+N and Ctrl+W are reserved by browsers) |
