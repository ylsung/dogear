#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const dependencyRoot = process.env.DOGEAR_SIM_NODE_MODULES || '/tmp/dogear-playwright/node_modules';
const { chromium } = require(path.join(dependencyRoot, 'playwright'));

const vscodeRoot = path.resolve(__dirname, '../..');
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+X2NDWQAAAABJRU5ErkJggg==',
  'base64',
);

const fixture = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <link rel="stylesheet" href="/media/sidepanel.css" />
</head>
<body>
  <header><h1 id="brand">Dogear</h1><span id="count"></span></header>
  <section id="capture-composer" hidden>
    <div class="capture-title" id="capture-title"></div>
    <div id="capture-editor" data-placeholder="Type a question…"></div>
    <input id="capture-images" type="file" accept="image/*" multiple hidden />
    <div class="capture-actions">
      <button id="capture-add-image">＋ Image</button>
      <span class="capture-hint"></span>
      <button id="capture-cancel">Cancel</button>
      <button id="capture-submit">Add to queue</button>
    </div>
  </section>
  <main id="list">
    <p class="empty" id="empty"><kbd id="hotkey">…</kbd></p>
  </main>
  <footer>
    <div class="actions">
      <button id="copy">Copy prompt</button>
      <button id="to-claude">→ Claude Code</button>
      <button id="to-codex">→ Codex</button>
      <button id="save-images" hidden>Save images…</button>
      <button id="clear">Clear</button>
    </div>
    <select id="lang"></select>
    <p class="note" id="note"></p>
  </footer>
  <script>
    window.__hostMessages = [];
    window.__assetSequence = 0;
    window.acquireVsCodeApi = () => ({
      postMessage(message) {
        window.__hostMessages.push(structuredClone(message));
        if (message.type === 'storeAsset') {
          const id = 'asset-' + (++window.__assetSequence);
          setTimeout(() => window.dispatchEvent(new MessageEvent('message', { data: {
            type: 'response',
            requestId: message.requestId,
            result: {
              id,
              mimeType: message.mediaType,
              displayName: message.displayName,
              previewUrl: 'data:' + message.mediaType + ';base64,' + message.base64,
            },
          }})));
        }
      },
    });
  </script>
  <script src="/media/theme.js"></script>
  <script src="/media/model.js"></script>
  <script src="/media/composer.js"></script>
  <script src="/media/prompts/index.js"></script>
  <script src="/media/prompts/en.js"></script>
  <script src="/media/prompts/zh-TW.js"></script>
  <script src="/media/sidepanel.js"></script>
</body>
</html>`;

function initialItem() {
  return {
    id: 'q1',
    url: 'file:///workspace/example.ts',
    title: 'example.ts',
    selectedContext: [{ type: 'text', text: 'const answer = 42;' }],
    message: { role: 'user', parts: [{ type: 'text', text: 'Explain this.' }] },
    page: null,
    lines: { start: 1, end: 1 },
    languageId: 'typescript',
    surface: 'editor',
    createdAt: 1,
    anchor: { exact: 'const answer = 42;', prefix: '', suffix: '', start: 0, end: 18 },
  };
}

function contentType(file) {
  if (file.endsWith('.js')) return 'text/javascript';
  if (file.endsWith('.css')) return 'text/css';
  return 'application/octet-stream';
}

async function main() {
  const server = http.createServer((request, response) => {
    if (request.url === '/') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(fixture);
      return;
    }
    const relative = decodeURIComponent(request.url || '').replace(/^\//, '');
    const file = path.resolve(vscodeRoot, relative);
    if (!file.startsWith(vscodeRoot + path.sep) || !fs.existsSync(file)) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { 'content-type': contentType(file) });
    response.end(fs.readFileSync(file));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  const browser = await chromium.launch({ channel: 'chromium', headless: true });
  const page = await browser.newPage({ viewport: { width: 420, height: 800 } });
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const initial = initialItem();
    await page.evaluate((queue) => window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'state', queue, assets: {}, promptLang: 'en', hotkeyHint: 'Ctrl+Alt+Q',
    }})), [initial]);
    await page.locator('.card').waitFor();

    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'compose', title: 'example.ts:1',
    }})));
    const capture = page.locator('#capture-editor');
    await capture.fill('First line\nSecond line');
    await page.locator('#capture-images').setInputFiles([
      { name: 'one.png', mimeType: 'image/png', buffer: png },
      { name: 'two.png', mimeType: 'image/png', buffer: png },
      { name: 'three.png', mimeType: 'image/png', buffer: png },
    ]);
    await page.locator('#capture-editor .dogear-asset-chip').nth(2).waitFor();
    assert.equal(await page.locator('#capture-editor .dogear-asset-chip').count(), 3);
    await page.locator('#capture-submit').click();

    const submitted = await page.evaluate(() =>
      window.__hostMessages.findLast((message) => message.type === 'composeSubmit'));
    assert.ok(submitted);
    assert.match(submitted.parts.find((part) => part.type === 'text').text, /First line\nSecond line/);
    assert.equal(submitted.parts.filter((part) => part.type === 'asset').length, 3);

    const previews = Object.fromEntries(submitted.parts
      .filter((part) => part.type === 'asset')
      .map((part) => [part.assetId, `data:image/png;base64,${png.toString('base64')}`]));
    const mixed = {
      ...initial,
      id: 'q2',
      createdAt: 2,
      message: { role: 'user', parts: submitted.parts },
    };
    const imageContext = {
      ...initial,
      id: 'q3',
      url: 'file:///workspace/mockup.png',
      title: 'mockup.png',
      selectedContext: [{
        type: 'asset', assetId: 'asset-1', mediaType: 'image/png', label: 'mockup.png',
      }],
      message: { role: 'user', parts: [{ type: 'text', text: 'Recreate this layout.' }] },
      lines: null,
      languageId: 'image',
      surface: 'image',
      anchor: { exact: '', prefix: '', suffix: '', start: 0, end: 0 },
    };
    const queue = [initial, mixed, imageContext];
    await page.evaluate(({ queue, previews }) => window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'state', queue, assets: previews, promptLang: 'en', hotkeyHint: 'Ctrl+Alt+Q' },
    })), { queue, previews });
    await page.locator('.card[data-id="q3"] .context-images img').waitFor();
    assert.equal(await page.locator('.card[data-id="q2"] .dogear-asset-chip').count(), 3);

    await page.evaluate(() => {
      document.querySelector('.card[data-id="q2"]').dataset.mountMarker = 'stable';
    });
    await page.evaluate(({ queue, previews }) => window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'state', queue, assets: previews, promptLang: 'en', hotkeyHint: 'Ctrl+Alt+Q' },
    })), { queue, previews });
    assert.equal(
      await page.locator('.card[data-id="q2"]').getAttribute('data-mount-marker'),
      'stable',
    );

    await page.locator('#copy').click();
    const copied = await page.evaluate(() =>
      window.__hostMessages.findLast((message) => message.type === 'copy'));
    assert.deepEqual(copied.assetIds, ['asset-1', 'asset-2', 'asset-3']);
    assert.match(copied.prompt, /First line\nSecond line/);
    assert.match(copied.prompt, /\[Image I1\]/);
    assert.match(copied.prompt, /Selected context: \[Image I1\]/);

    await page.locator('.card[data-id="q2"] .dogear-remove-asset').last().click();
    await page.waitForFunction(() => window.__hostMessages.some((message) =>
      message.type === 'save' &&
      message.queue.find((item) => item.id === 'q2')?.message.parts
        .filter((part) => part.type === 'asset').length === 2));
    await page.evaluate(({ queue, previews }) => window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'state', queue, assets: previews, promptLang: 'en', hotkeyHint: 'Ctrl+Alt+Q' },
    })), { queue, previews });
    await page.locator('#copy').click();
    const copiedAfterStaleEcho = await page.evaluate(() =>
      window.__hostMessages.filter((message) => message.type === 'copy').at(-1));
    assert.deepEqual(copiedAfterStaleEcho.assetIds, ['asset-1', 'asset-2']);
    assert.equal(
      await page.locator('.card[data-id="q2"]').getAttribute('data-mount-marker'),
      'stable',
    );

    console.log('PASS: multiline text, three images, stable queue echoes, image context, and prompt labels');
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
