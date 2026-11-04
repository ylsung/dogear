const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// Execute the actual serialized injection functions, as chrome.scripting does.
function harness({ delayed = false, uploadFails = false } = {}) {
  const events = [];
  let ready = !delayed;
  const editor = {
    tagName: 'DIV', disabled: false,
    getClientRects: () => [1],
    getAttribute: () => null,
    focus: () => events.push('focus'),
    dispatchEvent: (event) => events.push(event.type),
  };
  const hidden = { ...editor, getClientRects: () => [] };
  const document = {
    querySelectorAll(selector) {
      if (selector === '#prompt-textarea') return [hidden];
      if (selector === '[contenteditable="true"][role="textbox"]' && ready) return [editor];
      return [];
    },
    createRange: () => ({ selectNodeContents() {}, collapse() {} }),
    execCommand(command, _, text) { events.push(['text', text]); return true; },
  };
  const context = vm.createContext({
    DOGEAR_MODEL: {}, DOGEAR_ASSETS: {}, document,
    window: { getSelection: () => ({ removeAllRanges() {}, addRange() {} }) },
    setTimeout(callback) { ready = true; callback(); },
    DataTransfer: class { files = []; items = { add: (file) => this.files.push(file) }; },
    File: class {}, DragEvent: class { constructor(type) { this.type = type; } },
    Uint8Array, atob, btoa,
    chrome: {
      tabs: { query: async () => [{ id: 1, windowId: 2, active: true }], update: async () => {} },
      windows: { update: async () => {} },
      scripting: { async executeScript({ func, args }) {
        if (uploadFails && func.name === 'injectFiles') throw Error('upload unavailable');
        const injected = vm.runInContext(`(${func.toString()})`, context);
        return [{ result: await injected(...args) }];
      } },
    },
  });
  vm.runInContext(fs.readFileSync(require.resolve('../actions.js'), 'utf8'), context);
  const assets = [{ deliveredName: 'I1-test.png', record: {
    blob: new Blob(['test'], { type: 'image/png' }), mimeType: 'image/png', createdAt: 1,
  } }];
  return { actions: context.DOGEAR_ACTIONS, events, delivery: { text: 'Question with image', assets } };
}

test('delivers text and image to a visible textbox outside main, skipping hidden stale editor', async () => {
  const { actions, events, delivery } = harness({ delayed: true });
  const result = await actions.deliverToChat('chatgpt', delivery);
  assert.equal(result.status, 'inserted');
  assert.equal(result.imagesFailed, false);
  assert.deepEqual(events, ['focus', ['text', delivery.text], 'drop']);
});

test('an upload failure still leaves the prompt inserted', async () => {
  const { actions, events, delivery } = harness({ uploadFails: true });
  const result = await actions.deliverToChat('chatgpt', delivery);
  assert.equal(result.status, 'inserted');
  assert.equal(result.imagesFailed, true);
  assert.deepEqual(events, ['focus', ['text', delivery.text]]);
});
