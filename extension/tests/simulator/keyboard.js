#!/usr/bin/env node
// Deterministic host fixtures; production scripts and a closed shadow root.
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require(path.join(process.env.DOGEAR_SIM_NODE_MODULES || '/tmp/dogear-playwright/node_modules', 'playwright'));
const root = path.resolve(__dirname, '../..');
const manifest = require(path.join(root, 'manifest.json'));
assert.ok(manifest.content_scripts.some(script =>
  script.run_at === 'document_start' && script.js.includes('keyboard-boundary.js') && script.all_frames));

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const surface of ['ChatGPT', 'Claude', 'Grok', 'Gemini', 'PDF viewer', 'Markdown',
      'ChatGPT image preview (focus trap)', 'ChatGPT image preview (native modal)']) {
      const page = await browser.newPage();
      if (!process.env.DOGEAR_TEST_WITHOUT_BOUNDARY) {
        await page.addInitScript({ path: path.join(root, 'keyboard-boundary.js') });
      }
      await page.route('http://localhost/**', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><title>${surface}</title>
        <div class="page" data-page-number="7"><p id="selection">Selected answer from ${surface}</p></div>
        <textarea id="prompt"></textarea><script>
        window.hostKeys = 0;
        // A particularly aggressive focus trap does not recognize an editor
        // behind a closed shadow root, even when it is inside the dialog.
        document.addEventListener('focusin', event => {
          if (event.target.id === 'dogear-host') document.querySelector('#prompt').focus();
        }, true);
        // Chat-style global type-to-focus, including capture on window itself.
        for (const target of [window, document]) for (const type of ['keydown','keypress','keyup']) {
          target.addEventListener(type, event => {
            if (!event.target.isContentEditable && event.target.tagName !== 'TEXTAREA') {
              window.hostKeys++; document.querySelector('#prompt').focus();
            }
          }, true);
        }
        </script>` }));
      await page.goto('http://localhost/fixture');
      await page.evaluate(() => {
        window.queue = [];
        window.chrome = {
          runtime: {
            getURL: file => `https://example.invalid/${file}`,
            sendMessage: async message => message.type === 'dogear-capture-region' ? {
              ok: true,
              asset: { id: 'preview-image', mimeType: 'image/png', displayName: 'preview.png' },
              previewDataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+X2NDWQAAAABJRU5ErkJggg==',
            } : ({}),
            onMessage: { addListener: fn => window.openDogear = fn },
          },
          storage: {
            local: { get: async () => ({ queue: window.queue }), set: async value => { window.queue = value.queue; } },
            onChanged: { addListener() {} },
          },
        };
      });
      for (const file of ['theme.js', 'model.js', 'composer.js', 'content.js']) {
        await page.addScriptTag({ path: path.join(root, file) });
      }
      assert.equal(await page.locator('#dogear-host').evaluate(host => host.shadowRoot), null);
      if (surface.includes('image preview')) {
        // Open the preview AFTER Dogear has mounted at body level, as happens
        // when clicking a chat image. Include both common kinds of modal.
        await page.evaluate(native => {
          const preview = document.createElement(native ? 'dialog' : 'div');
          preview.id = 'image-preview';
          preview.setAttribute('role', 'dialog');
          preview.setAttribute('aria-modal', 'true');
          preview.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;margin:0;padding:0;background:white';
          document.body.appendChild(preview);
          preview.append(document.querySelector('.page'), document.querySelector('#prompt'));
          const image = document.createElement('img');
          image.alt = 'Zoomed image';
          preview.appendChild(image);
          if (native) preview.showModal();
          else {
            for (const sibling of document.body.children) if (sibling !== preview) sibling.inert = true;
            // Capture-phase focus scope redirects attempts to focus outside.
            document.addEventListener('focusin', event => {
              if (preview.isConnected && !preview.contains(event.target)) document.querySelector('#prompt').focus();
            }, true);
          }
          document.querySelector('#prompt').focus();
        }, surface.includes('native modal'));
      }
      await page.evaluate(() => {
        const range = document.createRange();
        range.selectNodeContents(document.querySelector('#selection'));
        window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
        window.openDogear({ type: 'dogear-open-ask' });
      });
      await page.waitForFunction(() => document.activeElement.id === 'dogear-host', null, { timeout: 3000 });
      if (surface.includes('image preview')) {
        assert.equal(await page.locator('#dogear-host').evaluate(host => host.parentElement.id), 'image-preview');
        assert.equal(await page.locator('#image-preview').evaluate(preview =>
          preview.tagName !== 'DIALOG' || preview.matches(':modal')), true);
      }
      // Click the focused editor again, as in the reported failure. The root
      // stays closed; only this test world's resolver can inspect its caret.
      const point = await page.evaluate(() => {
        const editor = globalThis.DOGEAR_KEYBOARD_TARGET({ composedPath: () => [document.querySelector('#dogear-host')] });
        const rect = editor.getBoundingClientRect();
        return { x: rect.x + 8, y: rect.y + 8 };
      });
      await page.mouse.click(point.x, point.y);
      await page.keyboard.type('Explain ');
      // Scripted focus changes must not override the user's explicit click
      // into Dogear. A later real click outside must still release ownership.
      await page.evaluate(() => document.querySelector('#prompt').focus());
      assert.equal(await page.evaluate(() => document.activeElement.id), 'dogear-host');
      await page.evaluate(() => {
        const editor = globalThis.DOGEAR_KEYBOARD_TARGET({ composedPath: () => [document.querySelector('#dogear-host')] });
        editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }));
      });
      assert.equal(await page.evaluate(() => window.queue.length), 0);
      await page.keyboard.type('this!');
      await page.keyboard.press('Backspace');
      await page.keyboard.press('Shift+Enter');
      await page.keyboard.type('Second line');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => window.queue.length === 1, null, { timeout: 3000 });
      const item = await page.evaluate(() => window.queue[0]);
      assert.equal(item.message.parts.map(p => p.text || '').join(''), 'Explain this\nSecond line');
      assert.ok(JSON.stringify(item.selectedContext).includes(`Selected answer from ${surface}`));
      assert.equal(item.selectedContext[0].locator.page, 7);
      assert.equal(await page.locator('#prompt').inputValue(), '');
      assert.equal(await page.evaluate(() => window.hostKeys), 0);
      await page.evaluate(() => window.openDogear({ type: 'dogear-open-page-ask' }));
      await page.waitForFunction(() => document.activeElement.id === 'dogear-host');
      await page.keyboard.type('Unsaved draft');
      await page.locator('#prompt').click();
      assert.equal(await page.evaluate(() => document.activeElement.id), 'prompt');
      await page.keyboard.type('Outside click wins');
      assert.equal(await page.locator('#prompt').inputValue(), 'Outside click wins');
      assert.equal(await page.evaluate(() => window.queue.length), 1);
      await page.locator('#prompt').fill('');
      // Tab out of the last Dogear control also hands focus back, without a
      // pointer click or a forced redirect back into the ask editor.
      await page.evaluate(() => window.openDogear({ type: 'dogear-open-page-ask' }));
      await page.waitForFunction(() => document.activeElement.id === 'dogear-host');
      await page.evaluate(() => {
        const editor = globalThis.DOGEAR_KEYBOARD_TARGET({ composedPath: () => [document.querySelector('#dogear-host')] });
        editor.getRootNode().querySelector('.add').focus();
      });
      await page.keyboard.press('Tab');
      assert.notEqual(await page.evaluate(() => document.activeElement.id), 'dogear-host');
      await page.evaluate(() => window.openDogear({ type: 'dogear-open-page-ask' }));
      await page.waitForFunction(() => document.activeElement.id === 'dogear-host');
      await page.keyboard.type('Discard me');
      await page.keyboard.press('Escape');
      assert.equal(await page.evaluate(() => window.queue.length), 1);
      if (surface.includes('image preview')) {
        assert.equal(await page.locator('#image-preview').evaluate(preview =>
          preview.tagName !== 'DIALOG' || preview.matches(':modal')), true);
        await page.evaluate(() => window.openDogear({ type: 'dogear-start-region' }));
        await page.mouse.move(400, 300);
        await page.mouse.down();
        await page.mouse.move(550, 450);
        await page.mouse.up();
        await page.waitForFunction(() => document.activeElement.id === 'dogear-host' &&
          globalThis.DOGEAR_KEYBOARD_TARGET({ composedPath: () => [document.querySelector('#dogear-host')] })?.classList.contains('question'));
        await page.keyboard.type('Explain this image');
        await page.keyboard.press('Enter');
        await page.waitForFunction(() => window.queue.length === 2);
        const imageItem = await page.evaluate(() => window.queue[1]);
        assert.equal(imageItem.selectedContext[0].parts[0].assetId, 'preview-image');
        assert.equal(imageItem.message.parts[0].text, 'Explain this image');
        assert.equal(await page.locator('#prompt').inputValue(), '');
        // Removing a preview also removes its Dogear host. The next invocation
        // must reconnect the retained host to the ordinary page.
        await page.evaluate(() => {
          const preview = document.querySelector('#image-preview');
          document.body.append(document.querySelector('#prompt'));
          if (preview.tagName === 'DIALOG') preview.close();
          preview.remove();
          for (const child of document.body.children) child.inert = false;
          window.openDogear({ type: 'dogear-open-page-ask' });
        });
        await page.waitForFunction(() => document.activeElement.id === 'dogear-host');
        assert.equal(await page.locator('#dogear-host').evaluate(host => host.parentElement.tagName), 'BODY');
        await page.keyboard.type('Back on page');
        await page.keyboard.press('Enter');
        await page.waitForFunction(() => window.queue.length === 3);
      }
      await page.locator('#prompt').click();
      await page.keyboard.type('Host still works');
      assert.equal(await page.locator('#prompt').inputValue(), 'Host still works');
      console.log(`PASS: ${surface}: capture, focus ownership, caret retention, typing isolation, outside click, Tab, save/cancel, host input`);
      await page.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
