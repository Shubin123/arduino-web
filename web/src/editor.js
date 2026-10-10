// SPDX-License-Identifier: AGPL-3.0-or-later
// Monaco editor (Microsoft, MIT) configured for Arduino sketches.
import * as monaco from 'monaco-editor/esm/vs/editor/edcore.main.js';
import 'monaco-editor/esm/vs/basic-languages/cpp/cpp.contribution.js';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker.js?worker';
import initFormatter, { format as clangFormat } from '@wasm-fmt/clang-format/web';
import formatterWasm from '@wasm-fmt/clang-format/clang-format.wasm?url';

self.MonacoEnvironment = { getWorker: () => new EditorWorker() };

// Arduino language reference (https://docs.arduino.cc/language-reference/).
const API = {
  pinMode: 'pinMode(${1:pin}, ${2:OUTPUT})', digitalWrite: 'digitalWrite(${1:pin}, ${2:HIGH})', digitalRead: 'digitalRead(${1:pin})',
  analogRead: 'analogRead(${1:pin})', analogWrite: 'analogWrite(${1:pin}, ${2:value})', analogReference: 'analogReference(${1:DEFAULT})',
  delay: 'delay(${1:ms})', delayMicroseconds: 'delayMicroseconds(${1:us})', millis: 'millis()', micros: 'micros()',
  tone: 'tone(${1:pin}, ${2:frequency})', noTone: 'noTone(${1:pin})', pulseIn: 'pulseIn(${1:pin}, ${2:HIGH})', pulseInLong: 'pulseInLong(${1:pin}, ${2:HIGH})',
  shiftIn: 'shiftIn(${1:dataPin}, ${2:clockPin}, ${3:MSBFIRST})', shiftOut: 'shiftOut(${1:dataPin}, ${2:clockPin}, ${3:MSBFIRST}, ${4:value})',
  attachInterrupt: 'attachInterrupt(digitalPinToInterrupt(${1:pin}), ${2:isr}, ${3:CHANGE})', detachInterrupt: 'detachInterrupt(digitalPinToInterrupt(${1:pin}))',
  digitalPinToInterrupt: 'digitalPinToInterrupt(${1:pin})', interrupts: 'interrupts()', noInterrupts: 'noInterrupts()',
  map: 'map(${1:value}, ${2:fromLow}, ${3:fromHigh}, ${4:toLow}, ${5:toHigh})', constrain: 'constrain(${1:x}, ${2:a}, ${3:b})',
  min: 'min(${1:a}, ${2:b})', max: 'max(${1:a}, ${2:b})', abs: 'abs(${1:x})', pow: 'pow(${1:base}, ${2:exponent})', sqrt: 'sqrt(${1:x})', sq: 'sq(${1:x})',
  sin: 'sin(${1:rad})', cos: 'cos(${1:rad})', tan: 'tan(${1:rad})', random: 'random(${1:max})', randomSeed: 'randomSeed(${1:seed})',
  bitRead: 'bitRead(${1:x}, ${2:n})', bitWrite: 'bitWrite(${1:x}, ${2:n}, ${3:b})', bitSet: 'bitSet(${1:x}, ${2:n})', bitClear: 'bitClear(${1:x}, ${2:n})',
  bit: 'bit(${1:n})', highByte: 'highByte(${1:x})', lowByte: 'lowByte(${1:x})', isAlpha: 'isAlpha(${1:c})', isDigit: 'isDigit(${1:c})',
  isAlphaNumeric: 'isAlphaNumeric(${1:c})', isSpace: 'isSpace(${1:c})', isUpperCase: 'isUpperCase(${1:c})', isLowerCase: 'isLowerCase(${1:c})',
  'Serial.begin': 'Serial.begin(${1:9600})', 'Serial.print': 'Serial.print(${1})', 'Serial.println': 'Serial.println(${1})', 'Serial.available': 'Serial.available()',
  'Serial.read': 'Serial.read()', 'Serial.write': 'Serial.write(${1})', 'Serial.parseInt': 'Serial.parseInt()', 'Serial.parseFloat': 'Serial.parseFloat()',
  'Serial.readString': 'Serial.readString()', 'Serial.readStringUntil': "Serial.readStringUntil('${1:\\n}')", 'Serial.setTimeout': 'Serial.setTimeout(${1:1000})', 'Serial.flush': 'Serial.flush()',
  setup: 'void setup() {\n\t$0\n}', loop: 'void loop() {\n\t$0\n}',
};
const CONSTANTS = ['HIGH', 'LOW', 'INPUT', 'OUTPUT', 'INPUT_PULLUP', 'LED_BUILTIN', 'true', 'false', 'A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'MSBFIRST', 'LSBFIRST', 'CHANGE', 'RISING', 'FALLING', 'DEFAULT', 'INTERNAL', 'EXTERNAL', 'DEC', 'HEX', 'OCT', 'BIN', 'PI', 'HALF_PI', 'TWO_PI', 'DEG_TO_RAD', 'RAD_TO_DEG'];
const TYPES = ['boolean', 'bool', 'byte', 'char', 'unsigned', 'int', 'long', 'short', 'float', 'double', 'word', 'String', 'void', 'size_t', 'uint8_t', 'uint16_t', 'uint32_t', 'int8_t', 'int16_t', 'int32_t', 'const', 'static', 'volatile', 'PROGMEM', 'F'];

// Clang-format style approximating the Arduino IDE 2 default formatter settings.
const STYLE = JSON.stringify({
  BasedOnStyle: 'LLVM', IndentWidth: 2, TabWidth: 2, UseTab: 'Never', ColumnLimit: 0, BreakBeforeBraces: 'Attach',
  AllowShortFunctionsOnASingleLine: 'Empty', AllowShortIfStatementsOnASingleLine: 'AllIfsAndElse', AllowShortLoopsOnASingleLine: true,
  AllowShortBlocksOnASingleLine: 'Always', AllowShortCaseLabelsOnASingleLine: true, IndentCaseLabels: true, SortIncludes: 'Never',
  SpaceBeforeParens: 'ControlStatements', AlignTrailingComments: true, KeepEmptyLinesAtTheStartOfBlocks: true, MaxEmptyLinesToKeep: 100000,
  IndentPPDirectives: 'None', NamespaceIndentation: 'None', PointerAlignment: 'Right', DerivePointerAlignment: true, ReflowComments: false,
});

let formatterReady;
export async function formatSource(text, filename) {
  formatterReady ??= initFormatter(formatterWasm);
  await formatterReady;
  return clangFormat(text, filename.replace(/\.ino$/, '.cpp'), STYLE);
}

export function setupLanguage(getExtraWords) {
  monaco.languages.registerCompletionItemProvider('cpp', {
    triggerCharacters: ['.'],
    provideCompletionItems(model, position) {
      const word = model.getWordUntilPosition(position);
      const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
      const before = model.getLineContent(position.lineNumber).slice(0, word.startColumn - 1);
      const object = before.match(/(\w+)\.$/)?.[1];
      const suggestions = [];
      const K = monaco.languages.CompletionItemKind;
      for (const [label, snippet] of Object.entries(API)) {
        if (object ? !label.startsWith(object + '.') : label.includes('.')) continue;
        const name = object ? label.slice(object.length + 1) : label;
        suggestions.push({ label: name, kind: K.Function, insertText: object ? snippet.slice(object.length + 1) : snippet, insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet, range, detail: 'Arduino' });
      }
      if (!object) {
        for (const c of CONSTANTS) suggestions.push({ label: c, kind: K.Constant, insertText: c, range });
        for (const t of TYPES) suggestions.push({ label: t, kind: K.Keyword, insertText: t, range });
        const seen = new Set([...Object.keys(API), ...CONSTANTS, ...TYPES]);
        for (const w of getExtraWords(model)) if (!seen.has(w)) { seen.add(w); suggestions.push({ label: w, kind: K.Text, insertText: w, range }); }
      }
      return { suggestions };
    },
  });
}

export { monaco };
