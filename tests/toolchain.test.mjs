import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AVREEPROM, AVRIOPort, AVRSPI, AVRTimer, AVRUSART, CPU, EEPROMMemoryBackend, avrInstruction, eepromConfig, portBConfig, spiConfig, timer0Config, usart0Config } from 'avr8js';
import { manifest, runTool, loadPack } from './helpers/node-toolchain.mjs';
import { buildSketch } from '../web/src/toolchain/build.js';
import { parseIntelHex, toIntelHex } from '../web/src/toolchain/binary.js';

const build = (files, boardId, extra = {}) =>
  buildSketch({ files, sketchName: Object.keys(files).find((f) => f.endsWith('.ino')).slice(0, -4), manifest, boardId, loadPack, runTool, ...extra });

// Runs firmware on a simulated ATmega328P for the given number of milliseconds.
function simulate(hex, ms) {
  const image = parseIntelHex(hex);
  const program = new Uint16Array(0x8000 / 2);
  new Uint8Array(program.buffer).set(image);
  const cpu = new CPU(program);
  new AVRTimer(cpu, timer0Config);
  const portB = new AVRIOPort(cpu, portBConfig);
  const usart = new AVRUSART(cpu, usart0Config, 16e6);
  new AVREEPROM(cpu, new EEPROMMemoryBackend(1024), eepromConfig);
  new AVRSPI(cpu, spiConfig, 16e6);
  let serial = '';
  usart.onByteTransmit = (byte) => (serial += String.fromCharCode(byte));
  const ledChanges = [];
  portB.addListener(() => ledChanges.push([cpu.cycles, portB.pinState(5)]));
  const end = 16e6 * (ms / 1000);
  while (cpu.cycles < end) {
    avrInstruction(cpu);
    cpu.tick();
  }
  return { serial, ledChanges };
}

test('Blink with forward-referenced function compiles and runs on a simulated Uno', async () => {
  const sketch = `// Blink
void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
  Serial.begin(115200);
}

void loop() {
  Serial.println(twice(21));
  digitalWrite(LED_BUILTIN, HIGH);
  delay(50);
  digitalWrite(LED_BUILTIN, LOW);
  delay(50);
}

int twice(int value) { return value * 2; }
`;
  const result = await build({ 'Blink.ino': sketch }, 'uno');
  assert.ok(result.size.flash > 500 && result.size.flash < 4000, `flash ${result.size.flash}`);
  const { serial, ledChanges } = simulate(result.hex, 300);
  assert.match(serial, /42\r\n42\r\n/);
  const toggles = ledChanges.map(([, state]) => state).filter((s, i, all) => i === 0 || s !== all[i - 1]);
  assert.ok(toggles.length >= 4, `LED toggled ${toggles.length} times`);
});

test('multi-file sketch with header, .cpp and built-in EEPROM/Wire/SPI/SoftwareSerial libraries', async () => {
  const files = {
    'Multi.ino': '#include <EEPROM.h>\n#include <Wire.h>\n#include <SPI.h>\n#include <SoftwareSerial.h>\n#include "util.h"\nSoftwareSerial soft(10, 11);\nvoid setup() { Serial.begin(115200); Wire.begin(); SPI.begin(); soft.begin(9600); EEPROM.write(0, 7); Serial.println(addOne(EEPROM.read(0))); }\nvoid loop() {}\n',
    'util.h': 'int addOne(int x);\n',
    'util.cpp': '#include "util.h"\nint addOne(int x) { return x + 1; }\n',
  };
  for (const board of ['uno', 'nano', 'mega', 'leonardo', 'micro']) {
    const result = await build(files, board);
    assert.ok(result.hex.startsWith(':'), board);
  }
  const { serial } = simulate((await build(files, 'uno')).hex, 50);
  assert.match(serial, /^8\r\n/);
});

test('user library in 1.5 layout with C source is compiled from source', async () => {
  const library = {
    name: 'Counter', version: '1.0.0',
    files: {
      'library.properties': 'name=Counter\nversion=1.0.0\n',
      'src/Counter.h': '#pragma once\n#include <Arduino.h>\nextern "C" int counter_step(int);\nclass Counter { public: int next() { return value = counter_step(value); } int value = 0; };\n',
      'src/impl/step.c': 'int counter_step(int v) { return v + 3; }\n',
    },
  };
  const result = await build({ 'UseLib.ino': '#include <Counter.h>\nCounter c;\nvoid setup() { Serial.begin(115200); c.next(); Serial.println(c.next()); }\nvoid loop() {}\n' }, 'uno', { libraries: [library] });
  assert.match(simulate(result.hex, 50).serial, /^6\r\n/);
});

test('compile errors are reported with .ino line numbers', async () => {
  await assert.rejects(build({ 'Broken.ino': 'void setup() {\n  undefinedThing();\n}\nvoid loop() {}\n' }, 'uno'), (error) => {
    const d = error.diagnostics.find((x) => x.severity === 'error');
    assert.equal(d.file, 'Broken.ino');
    assert.equal(d.line, 2);
    return true;
  });
});

test('Intel HEX round trip', () => {
  const image = new Uint8Array(70000).map((_, i) => (i * 7) & 0xff);
  assert.deepEqual(parseIntelHex(toIntelHex(image)), image);
});
