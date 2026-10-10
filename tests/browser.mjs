// End-to-end check of the built site in headless Chrome:
// compile, examples, library install from the Arduino index, and an upload
// over a fake Web Serial port backed by an emulated Optiboot bootloader.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const server = spawn('npx', ['vite', 'preview', '--port', '4174', '--strictPort'], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((resolve) => server.stdout.on('data', (d) => /4174/.test(d) && resolve()));
const fakeBoards = (await readFile(new URL('./helpers/fake-boards.mjs', import.meta.url), 'utf8')).replace(/^export /gm, '');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1360, height: 860 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(`${fakeBoards}
    const device = new Optiboot({ flashSize: 32768, signature: [0x1e, 0x95, 0x0f] });
    const port = new FakePort(device);
    port.getInfo = () => ({ usbVendorId: 0x2341, usbProductId: 0x0043 });
    window.__device = device;
    Object.defineProperty(navigator, 'serial', { value: { requestPort: async () => port, getPorts: async () => [port], addEventListener() {} } });`);
  await page.goto('http://localhost:4174/?test');
  await page.waitForSelector('.monaco-editor');
  await page.waitForFunction(() => document.querySelector('.tab')?.textContent.endsWith('.ino'));

  // Replace the new sketch with Blink and compile.
  const blink = 'void setup() {\n  pinMode(LED_BUILTIN, OUTPUT);\n}\n\nvoid loop() {\n  digitalWrite(LED_BUILTIN, HIGH);\n  delay(1000);\n  digitalWrite(LED_BUILTIN, LOW);\n  delay(1000);\n}\n';
  await page.evaluate((text) => window.__setSource(text), blink);
  await page.click('#verify');
  await page.waitForFunction(() => /Sketch uses \d+ bytes/.test(document.querySelector('#output').textContent) || /error/i.test(document.querySelector('#output').textContent), null, { timeout: 180000 });
  const compiled = await page.textContent('#output');
  assert.match(compiled, /Sketch uses \d+ bytes \(\d+%\) of program storage space\. Maximum is 32256 bytes\./, compiled);

  // Upload to the emulated Uno (board auto-detected from VID/PID).
  await page.click('#upload');
  await page.waitForFunction(() => /Upload complete|failed|error/i.test(document.querySelector('#output').textContent), null, { timeout: 180000 });
  const uploaded = await page.textContent('#output');
  assert.match(uploaded, /Upload complete in .* Flash verified\./, uploaded);
  const written = await page.evaluate(() => [...window.__device.flash.subarray(0, 4)]);
  assert.equal(written[0], 0x0c, 'reset vector written (jmp)');

  // Library Manager: install a library from the Arduino index and compile with it.
  await page.click('[data-view="libraries"]');
  await page.waitForFunction(() => /\d+ libraries/.test(document.querySelector('#side-body').textContent), null, { timeout: 120000 });
  await page.fill('#side-body input[type=search]', 'Servo');
  await page.waitForFunction(() => [...document.querySelectorAll('.lib-list .card h3')].some((h) => h.textContent.startsWith('Servo ')));
  const card = page.locator('.lib-list .card', { has: page.locator('h3', { hasText: /^Servo by/ }) }).first();
  await card.getByRole('button', { name: 'Install' }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('.lib-list .card')].some((c) => c.textContent.startsWith('Servo by') && /installed/.test(c.textContent)), null, { timeout: 60000 });
  await page.evaluate((text) => window.__setSource(text), '#include <Servo.h>\nServo s;\nvoid setup() {\n  s.attach(9);\n}\nvoid loop() {\n  s.write(90);\n}\n');
  await page.click('#verify');
  await page.waitForFunction(() => /Sketch uses|error/i.test(document.querySelector('#output').textContent), null, { timeout: 180000 });
  const servo = await page.textContent('#output');
  assert.match(servo, /Using library Servo at version/, servo);
  assert.match(servo, /Sketch uses/, servo);

  // Compile error is mapped to the .ino line.
  await page.evaluate((text) => window.__setSource(text), 'void setup() {\n  notDeclared();\n}\nvoid loop() {}\n');
  await page.click('#verify');
  await page.waitForFunction(() => /Compilation error/.test(document.querySelector('#output').textContent), null, { timeout: 120000 });
  assert.match(await page.textContent('#output'), /\.ino:2:\d+: error: 'notDeclared' was not declared/);

  // Open a built-in example through the menu and compile it.
  await page.hover('#menubar');
  await page.click('.menubar-item:has-text("File")');
  await page.hover('.menu-item:has-text("Examples")');
  await page.hover('.menu-item:has-text("Basics")');
  await page.click('.menu-item:has-text("AnalogReadSerial")');
  await page.waitForFunction(() => document.querySelector('.tab.active')?.textContent.startsWith('AnalogReadSerial'));
  await page.click('#verify');
  await page.waitForFunction(() => /Sketch uses|error/i.test(document.querySelector('#output').textContent), null, { timeout: 120000 });
  assert.match(await page.textContent('#output'), /Sketch uses/);

  await page.screenshot({ path: 'tests/screenshot.png' });
  assert.deepEqual(errors, []);
  console.log('PASS: compile, upload to emulated Uno over Web Serial, Library Manager install + compile, error mapping, examples');
} finally {
  await browser.close();
  server.kill();
}
