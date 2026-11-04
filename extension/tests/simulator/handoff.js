const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(path.join(process.env.DOGEAR_SIM_NODE_MODULES || '/tmp/dogear-playwright/node_modules', 'playwright'));

(async () => {
  const browser = await chromium.launch({ channel: 'chromium', headless: true });
  try {
    const page = await browser.newPage();
    for (const attributes of ['role="textbox"', 'data-lexical-editor="true"', 'id="prompt-textarea"']) {
      await page.setContent('<div id="prompt-textarea" style="display:none"></div><section id="host"></section>');
      await page.evaluate((attributes) => {
        setTimeout(() => {
          document.querySelector('#host').innerHTML = `<div contenteditable="true" ${attributes}></div>`;
          const editor = document.querySelector('#host > div');
          editor.addEventListener('drop', (event) => {
            event.preventDefault();
            window.received = [...event.dataTransfer.files].map((file) => file.name);
          });
        }, 150);
        window.DOGEAR_MODEL = {};
        window.DOGEAR_ASSETS = {};
        window.chrome = {
          tabs: { query: async () => [{ id: 1, windowId: 1, active: true }], update: async () => {} },
          windows: { update: async () => {} },
          scripting: { executeScript: async ({ func, args }) => [{ result: await func(...args) }] },
        };
      }, attributes);
      await page.addScriptTag({ path: path.resolve(__dirname, '../../actions.js') });
      const result = await page.evaluate(async () => {
        const outcome = await DOGEAR_ACTIONS.deliverToChat('chatgpt', {
          text: 'Explain this image.\nKeep the prompt.',
          assets: [{ deliveredName: 'I1-test.png', record: {
            blob: new Blob(['image'], { type: 'image/png' }), mimeType: 'image/png', createdAt: 1,
          } }],
        });
        return { outcome, text: document.querySelector('#host > div').innerText, files: window.received };
      });
      assert.equal(result.outcome.status, 'inserted');
      assert.equal(result.outcome.imagesFailed, false);
      assert.equal(result.text, 'Explain this image.\nKeep the prompt.');
      assert.deepEqual(result.files, ['I1-test.png']);
      console.log(`PASS: delayed editor outside main (${attributes}), hidden stale editor, text and image drop`);
    }
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
