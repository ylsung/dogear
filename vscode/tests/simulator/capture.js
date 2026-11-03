#!/usr/bin/env node
// Run the production selection bridge against a simulated VS Code clipboard.
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('../../node_modules/esbuild');
const bundle = esbuild.buildSync({
  entryPoints: [path.resolve(__dirname, '../../src/capture.ts')],
  bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], write: false,
}).outputFiles[0].text;
let clipboard = 'original clipboard';
let selected = '';
const vscode = {
  env: { clipboard: { readText: async () => clipboard, writeText: async value => { clipboard = value; } } },
  commands: { executeCommand: async command => {
    assert.equal(command, 'editor.action.clipboardCopyAction');
    if (selected) clipboard = selected;
  } },
  window: { showInformationMessage() {} },
};
const moduleObject = { exports: {} };
vm.runInNewContext(`(function(require,module,exports){${bundle}\n})`, { setTimeout, console, Buffer, process })(
  name => name === 'vscode' ? vscode : require(name), moduleObject, moduleObject.exports,
);
(async () => {
  for (const surface of ['codex-chat', 'claude-chat', 'markdown-preview']) {
    selected = `Selected text from ${surface}`;
    const items = [];
    const store = { add: async item => items.push(item) };
    const message = { role: 'user', parts: [{ type: 'text', text: 'Explain this.' }] };
    await moduleObject.exports.askWebviewSelection(store, { compose: async () => message }, surface);
    assert.equal(clipboard, 'original clipboard');
    assert.equal(items.length, 1);
    assert.equal(items[0].surface, surface);
    assert.equal(items[0].selectedContext[0].text, selected);
    assert.equal(items[0].message, message);
    await moduleObject.exports.askWebviewSelection(store, { compose: async () => undefined }, surface);
    assert.equal(items.length, 1);
    selected = '';
    await moduleObject.exports.askWebviewSelection(store, { compose: async () => { throw Error('Should not compose without selection'); } }, surface);
    assert.equal(items.length, 1);
    assert.equal(clipboard, 'original clipboard');
    console.log(`PASS: ${surface}: production capture, clipboard restore, cancel, empty selection`);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
