#!/usr/bin/env node

// End-to-end Dogear attachment-status simulator. Dependencies are intentionally
// external to the extension; set DOGEAR_SIM_NODE_MODULES or use the default
// isolated /tmp setup described in this task's review notes.

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const dependencyRoot = process.env.DOGEAR_SIM_NODE_MODULES || '/tmp/dogear-playwright/node_modules';
const { chromium } = require(path.join(dependencyRoot, 'playwright'));
const CDP = require(path.join(dependencyRoot, 'chrome-remote-interface'));

const repoRoot = path.resolve(__dirname, '../../..');
const extensionRoot = path.join(repoRoot, 'extension');
const fixturePath = path.join(__dirname, 'chat.html');
const artifactDir = path.join(repoRoot, 'artifacts');
const videoPath = path.join(artifactDir, 'attachment-status-simulator.webm');
const reportPath = path.join(artifactDir, 'attachment-status-simulator.json');

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check, description, timeout = 8000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await check();
    if (last) return last;
    await wait(100);
  }
  throw new Error(`Timed out waiting for ${description}; last value: ${JSON.stringify(last)}`);
}

async function sideValue(client, expression) {
  const { result, exceptionDetails } = await client.Runtime.evaluate({
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (exceptionDetails) throw new Error(exceptionDetails.text || 'Side-panel evaluation failed.');
  return result.value;
}

async function main() {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dogear-simulator-'));
  const extensionCopy = path.join(temporaryRoot, 'extension');
  const profileDir = path.join(temporaryRoot, 'profile');
  const rawVideoDir = path.join(temporaryRoot, 'video');
  const debugPort = 9400 + Math.floor(Math.random() * 300);
  fs.cpSync(extensionRoot, extensionCopy, { recursive: true });

  // A real click in the fixture supplies chrome.sidePanel.open's required user
  // gesture. Only the temporary extension copy receives this bridge.
  const contentPath = path.join(extensionCopy, 'content.js');
  const content = fs.readFileSync(contentPath, 'utf8');
  fs.writeFileSync(contentPath, content.replace(
    '\n  attachHost();\n  refreshHighlights();',
    `
  if (location.hostname === '127.0.0.1') {
    document.addEventListener('click', (event) => {
      if (event.target?.id === 'open-dogear') {
        chrome.runtime.sendMessage({ type: 'dogear-open-panel' }).catch(() => {});
      }
    }, true);
  }

  attachHost();
  refreshHighlights();`,
  ));

  const fixture = fs.readFileSync(fixturePath);
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(fixture);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const fixturePort = server.address().port;

  fs.mkdirSync(artifactDir, { recursive: true });
  const context = await chromium.launchPersistentContext(profileDir, {
    channel: 'chromium',
    headless: true,
    viewport: { width: 900, height: 650 },
    args: [
      `--disable-extensions-except=${extensionCopy}`,
      `--load-extension=${extensionCopy}`,
      `--remote-debugging-port=${debugPort}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });
  const recorderBrowser = await chromium.launch({ channel: 'chromium', headless: true });
  const recorderContext = await recorderBrowser.newContext({
    viewport: { width: 1280, height: 720 },
    recordVideo: { dir: rawVideoDir, size: { width: 1280, height: 720 } },
  });
  const reviewPage = await recorderContext.newPage();
  await reviewPage.setContent(`
    <style>
      body { margin: 0; font-family: system-ui, sans-serif; background: #0f172a; color: white; }
      header { height: 76px; padding: 14px 22px; background: #172554; }
      h1 { margin: 0 0 4px; font-size: 24px; }
      #caption { color: #bfdbfe; font-size: 16px; }
      main { height: 644px; display: grid; grid-template-columns: 2fr 1fr; gap: 12px; padding: 12px; }
      figure { margin: 0; display: flex; flex-direction: column; min-width: 0; }
      figcaption { padding: 6px 10px; background: #1e293b; font-weight: 600; }
      img { width: 100%; flex: 1; min-height: 0; object-fit: contain; background: white; }
    </style>
    <header><h1>Dogear multimodal attachment-status test</h1><div id="caption"></div></header>
    <main>
      <figure><figcaption>Simulated destination chat</figcaption><img id="chat" /></figure>
      <figure><figcaption>Real Dogear side panel</figcaption><img id="dogear" /></figure>
    </main>
  `);

  let sideClient;
  let page;
  const report = [];
  try {
    let workers = context.serviceWorkers();
    if (!workers.length) workers = [await context.waitForEvent('serviceworker')];
    const worker = workers[0];
    page = context.pages()[0] || await context.newPage();
    await page.goto(`http://127.0.0.1:${fixturePort}/chat.html?target=chatgpt`);

    const seededAssets = await worker.evaluate(async () => {
      await chrome.storage.local.clear();
      await chrome.storage.session.clear();
      const assets = [];
      const colors = ['#ef4444', '#3b82f6', '#eab308'];
      for (let index = 0; index < colors.length; index += 1) {
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="100"><rect width="160" height="100" rx="12" fill="${colors[index]}"/><text x="80" y="58" text-anchor="middle" font-size="32" fill="white">I${index + 1}</text></svg>`;
        assets.push(await DOGEAR_ASSETS.put(new Blob([svg], { type: 'image/svg+xml' }), {
          mimeType: 'image/svg+xml',
          displayName: `simulated-image-${index + 1}.svg`,
          origin: { type: 'simulator' },
        }));
      }
      const item = DOGEAR_MODEL.createTextRequest({
        id: crypto.randomUUID(),
        source: { url: 'http://127.0.0.1/simulator', title: 'Attachment simulator' },
        locator: { type: 'text-quote', exact: 'Three simulated images', prefix: '', suffix: '', start: 0 },
        question: 'Compare the selected text.',
      });
      await chrome.storage.local.set({ queue: [item] });
      return assets.map(({ id, mimeType, displayName }) => ({ id, mimeType, displayName }));
    });

    await page.locator('#open-dogear').click();
    const sideTarget = await waitFor(async () => {
      const targets = await CDP.List({ port: debugPort });
      return targets.find((target) => target.url.endsWith('/sidepanel.html'));
    }, 'Dogear side-panel target');
    sideClient = await CDP({ target: sideTarget, port: debugPort });
    await Promise.all([sideClient.Runtime.enable(), sideClient.Page.enable()]);
    await waitFor(() => sideValue(sideClient, `document.querySelectorAll('.card').length === 1`), 'initial queue card');
    const initiallyHidden = await sideValue(sideClient, `document.querySelector('#manual-handoff').hidden`);
    if (!initiallyHidden) throw new Error('Manual handoff should start hidden for a text-only question.');

    // Reproduce the old stale-render sequence: an in-composer save was treated
    // as "quiet", and an unmatched quiet-write counter could then suppress
    // later captures from the content script. The image save must refresh only
    // the handoff tray; the external captures must refresh the full queue.
    await sideValue(sideClient, `(async () => {
      const assets = ${JSON.stringify(seededAssets)};
      const queue = await getQueue();
      queue[0].message.parts = [
        DOGEAR_MODEL.textPart('Compare '),
        ...assets.flatMap((asset, index) => [
          DOGEAR_MODEL.assetPart(asset.id, asset.mimeType, asset.displayName),
          DOGEAR_MODEL.textPart(index === assets.length - 1 ? '.' : ', '),
        ]),
      ];
      await setQueueQuietly(queue);
      await setQueueQuietly(queue);
    })()`);
    await waitFor(
      () => sideValue(sideClient, `!document.querySelector('#manual-handoff').hidden && document.querySelectorAll('.handoff-asset').length === 3`),
      'manual handoff refresh after a quiet image edit',
    );

    await worker.evaluate(async (assets) => {
      const queue = (await chrome.storage.local.get('queue')).queue;
      const firstAsset = await DOGEAR_ASSETS.get(assets[0].id);
      queue.push(DOGEAR_MODEL.createImageRequest({
        id: crypto.randomUUID(),
        source: { url: 'http://127.0.0.1/simulator', title: 'Attachment simulator' },
        locator: { type: 'region', x: 10, y: 10, width: 160, height: 100 },
        asset: firstAsset,
        messageParts: [DOGEAR_MODEL.textPart('Explain this screenshot.')],
      }));
      queue.push(DOGEAR_MODEL.createTextRequest({
        id: crypto.randomUUID(),
        source: { url: 'http://127.0.0.1/simulator', title: 'Attachment simulator' },
        locator: { type: 'text-quote', exact: 'A later text selection', prefix: '', suffix: '', start: 25 },
        question: 'Explain this selection.',
      }));
      await chrome.storage.local.set({ queue });
    }, seededAssets);
    await waitFor(
      () => sideValue(sideClient, `document.querySelectorAll('.card').length === 3 && document.querySelector('#count').textContent === '3 queries'`),
      'two externally captured questions in the visible queue',
    );

    const interactionState = await sideValue(sideClient, `({
      cardsAreStatic: [...document.querySelectorAll('.card')].every((element) => !element.draggable),
      groupsAreStatic: [...document.querySelectorAll('.group')].every((element) => !element.draggable),
      handlesAreDraggable: [...document.querySelectorAll('.drag-handle')].every((element) => element.draggable),
      imageIsDraggable: document.querySelector('.context-images img')?.draggable === true,
      textIsSelectable: getComputedStyle(document.querySelector('blockquote')).userSelect === 'text',
    })`);
    if (Object.values(interactionState).some((value) => !value)) {
      throw new Error(`Queue interaction regression: ${JSON.stringify(interactionState)}`);
    }
    report.push({
      label: 'Queue synchronization and content interaction',
      handoffRows: 3,
      visibleQueries: 3,
      ...interactionState,
    });
    await sideValue(sideClient, `document.querySelector('#manual-handoff').open = true`);

    async function attachedState() {
      return sideValue(sideClient, `[...document.querySelectorAll('.handoff-asset')].map((row) => ({ attached: row.classList.contains('attached'), label: row.querySelector('span')?.textContent }))`);
    }

    async function recordStep(caption) {
      const chat = await page.screenshot({ type: 'png' });
      const dogear = Buffer.from((await sideClient.Page.captureScreenshot({ format: 'png' })).data, 'base64');
      await reviewPage.evaluate(({ caption, chat, dogear }) => {
        document.getElementById('caption').textContent = caption;
        document.getElementById('chat').src = `data:image/png;base64,${chat}`;
        document.getElementById('dogear').src = `data:image/png;base64,${dogear}`;
      }, { caption, chat: chat.toString('base64'), dogear: dogear.toString('base64') });
      await reviewPage.waitForTimeout(1200);
    }

    async function expectAttached(expected, label) {
      const state = await waitFor(async () => {
        const value = await attachedState();
        return value.filter((entry) => entry.attached).length === expected ? value : null;
      }, `${expected} attached rows for ${label}`);
      report.push({ label, attached: state.map((entry) => entry.attached) });
      await recordStep(`${label}: ${expected} attached row${expected === 1 ? '' : 's'}`);
    }

    await recordStep('PASS: handoff visible, 3 captures rendered, content selectable, handle-only reorder');
    await recordStep('ChatGPT-style fixture: ready to attach three images');
    await sideValue(sideClient, `document.querySelector('.handoff-all').click()`);
    await expectAttached(3, 'ChatGPT attach-all');
    await page.locator('.attachment').nth(1).locator('button').click();
    await expectAttached(2, 'ChatGPT remove middle image first');
    await page.locator('.attachment').nth(0).locator('button').click();
    await expectAttached(1, 'ChatGPT remove first remaining image');
    await page.locator('.attachment').nth(0).locator('button').click();
    await expectAttached(0, 'ChatGPT remove final image');

    await page.goto(`http://127.0.0.1:${fixturePort}/chat.html?target=claude`);
    await waitFor(async () => (await attachedState()).every((entry) => !entry.attached), 'navigation status reset');
    await recordStep('Claude-style fixture: anonymous chips and asynchronous replacement');
    await sideValue(sideClient, `document.querySelector('.handoff-all').click()`);
    await expectAttached(3, 'Claude attach-all');
    await page.locator('.file-preview').nth(1).locator('button').click();
    await expectAttached(2, 'Claude remove middle image first');
    await page.locator('.file-preview').nth(0).locator('button').click();
    await expectAttached(1, 'Claude remove first remaining image');
    await page.locator('.file-preview').nth(0).locator('button').click();
    await expectAttached(0, 'Claude remove final image');
    await recordStep('PASS: both adapters tracked arbitrary removal order');

    fs.writeFileSync(reportPath, `${JSON.stringify({ passed: true, steps: report }, null, 2)}\n`);
  } catch (error) {
    fs.writeFileSync(reportPath, `${JSON.stringify({ passed: false, error: error.stack }, null, 2)}\n`);
    throw error;
  } finally {
    await reviewPage.close();
    const rawVideo = await reviewPage.video().path();
    await recorderContext.close();
    await recorderBrowser.close();
    if (sideClient) await sideClient.close();
    await context.close();
    server.close();
    fs.copyFileSync(rawVideo, videoPath);
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }

  console.log(`PASS report: ${reportPath}`);
  console.log(`Review video: ${videoPath}`);
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
