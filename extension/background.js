// Dogear background service worker: context menu, hotkey routing, badge count.

importScripts(
  'theme.js', 'model.js', 'asset-store.js',
  'prompts/index.js', 'prompts/en.js', 'prompts/zh-TW.js',
  'actions.js',
);

const ACTIONS = globalThis.DOGEAR_ACTIONS;

// ---------- context menu ----------
// Everything sits under one "Dogear" parent. Titles carry the live shortcut
// (users can rebind it) and the queue count, so they are rebuilt on change.

const PAGE_CONTEXTS = ['page', 'selection', 'link', 'image', 'frame', 'editable'];

function withShortcut(title, shortcut) {
  return shortcut ? `${title}  (${shortcut})` : title;
}

async function buildContextMenu() {
  const commands = await chrome.commands.getAll();
  const shortcut = (name) => commands.find((c) => c.name === name)?.shortcut || '';
  const { queue = [] } = await chrome.storage.local.get('queue');
  const count = queue.length;
  await chrome.contextMenus.removeAll();
  const add = (props) => chrome.contextMenus.create({ parentId: 'dogear', ...props });
  chrome.contextMenus.create({ id: 'dogear', title: 'Dogear', contexts: PAGE_CONTEXTS });
  add({
    id: 'dogear-ask',
    title: withShortcut('Ask about selection', shortcut('ask-selection')),
    contexts: ['selection'],
  });
  add({ id: 'dogear-ask-page', title: 'Ask about this page', contexts: PAGE_CONTEXTS });
  add({ id: 'dogear-capture', title: 'Capture screenshot and ask', contexts: PAGE_CONTEXTS });
  add({ id: 'dogear-sep-1', type: 'separator', contexts: PAGE_CONTEXTS });
  add({
    id: 'dogear-open-queue',
    title: withShortcut(count ? `Open queue (${count})` : 'Open queue', shortcut('_execute_action')),
    contexts: PAGE_CONTEXTS,
  });
  add({
    id: 'dogear-export',
    title: withShortcut('Export prompt…', shortcut('export-prompt')),
    contexts: PAGE_CONTEXTS,
    enabled: count > 0,
  });
  add({
    id: 'dogear-clear',
    title: withShortcut(count ? `Clear queue (${count})` : 'Clear queue', shortcut('clear-queue')),
    contexts: PAGE_CONTEXTS,
    enabled: count > 0,
  });
  add({ id: 'dogear-sep-2', type: 'separator', contexts: PAGE_CONTEXTS });
  add({
    id: 'dogear-open-pdf',
    title: 'Open PDF in Dogear viewer',
    contexts: ['link'],
    targetUrlPatterns: ['*://*/*.pdf*', '*://*/pdf/*'],
  });
  add({ id: 'dogear-settings', title: 'Settings…', contexts: PAGE_CONTEXTS });
  // The toolbar icon's own right-click menu.
  chrome.contextMenus.create({ id: 'dogear-feedback', title: 'Send feedback', contexts: ['action'] });
}

// Serialize rebuilds: removeAll/create from two overlapping calls would
// otherwise collide on duplicate ids.
let menuBuild = Promise.resolve();
function refreshContextMenu() {
  menuBuild = menuBuild.then(buildContextMenu).catch(() => {});
  return menuBuild;
}

chrome.runtime.onInstalled.addListener(refreshContextMenu);
chrome.runtime.onStartup.addListener(refreshContextMenu);

function viewerUrl(pdfUrl) {
  return `${chrome.runtime.getURL('pdfjs/web/viewer.html')}?file=${encodeURIComponent(pdfUrl)}`;
}

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(() => {});

const recentSelectionFrames = new Map();

function openAsk(tabId, requestedFrameId) {
  const recent = recentSelectionFrames.get(tabId);
  const frameId = Number.isInteger(requestedFrameId)
    ? requestedFrameId
    : recent && Date.now() - recent.at < 2000
      ? recent.frameId
      : 0;
  chrome.tabs.sendMessage(tabId, { type: 'dogear-open-ask' }, { frameId }).catch(() => {
    // Content script not present (chrome:// pages, web store, native PDF viewer).
  });
}

// Pages where content scripts never run, so on-page UI cannot appear.
function isRestrictedUrl(url) {
  return !url || /^(chrome|edge|about|devtools|view-source):/i.test(url) ||
    /^https:\/\/chrome(webstore)?\.google\.com\/webstore/i.test(url) ||
    (url.startsWith('chrome-extension:') && !url.startsWith(chrome.runtime.getURL('pdfjs/')));
}

function tellPage(tabId, msg) {
  return chrome.tabs.sendMessage(tabId, msg, { frameId: 0 }).then(() => true, () => false);
}

// The export popup lives on the page; where it cannot (browser pages) the
// queue's own export buttons stand in. sidePanel.open must run before any
// await, or Chrome no longer treats the call as part of the user gesture.
async function openExport(tab) {
  if (isRestrictedUrl(tab.url)) {
    chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
    return;
  }
  const { queue = [], lastExportTarget } = await chrome.storage.local.get(['queue', 'lastExportTarget']);
  if (!queue.length) {
    tellPage(tab.id, { type: 'dogear-toast', text: 'Dogear: the queue is empty.' });
    return;
  }
  tellPage(tab.id, {
    type: 'dogear-open-export',
    count: queue.length,
    targets: ACTIONS.TARGETS,
    last: lastExportTarget || 'copy',
  });
}

async function clearFromPage(tab) {
  const cleared = await ACTIONS.clearQueue();
  if (!tab || isRestrictedUrl(tab.url)) return;
  tellPage(tab.id, cleared ? { type: 'dogear-cleared', count: cleared } : { type: 'dogear-toast', text: 'Dogear: the queue is already empty.' });
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const tabId = tab && tab.id != null ? tab.id : null;
  switch (info.menuItemId) {
    case 'dogear-ask':
      if (tabId != null) openAsk(tabId, Number.isInteger(info.frameId) ? info.frameId : undefined);
      break;
    case 'dogear-ask-page':
      if (tabId != null) tellPage(tabId, { type: 'dogear-open-page-ask' });
      break;
    case 'dogear-capture':
      if (tabId != null) tellPage(tabId, { type: 'dogear-start-region' });
      break;
    case 'dogear-open-queue':
      if (tabId != null) chrome.sidePanel.open({ tabId }).catch(() => {});
      break;
    case 'dogear-export':
      if (tab) openExport(tab);
      break;
    case 'dogear-clear':
      clearFromPage(tab);
      break;
    case 'dogear-open-pdf':
      if (info.linkUrl) chrome.tabs.create({ url: viewerUrl(info.linkUrl) });
      break;
    case 'dogear-settings':
      chrome.runtime.openOptionsPage();
      break;
    case 'dogear-feedback':
      ACTIONS.openFeedback();
      break;
  }
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg && msg.type === 'dogear-capture-ready' && sender.tab && sender.tab.id != null) {
    recentSelectionFrames.set(sender.tab.id, { frameId: sender.frameId, at: Date.now() });
  }
  if (msg && msg.type === 'dogear-open-panel' && sender.tab && sender.tab.id != null) {
    chrome.sidePanel.open({ tabId: sender.tab.id }).catch(() => {});
  }
  if (msg && msg.type === 'dogear-color-scheme') setToolbarIcon(msg.dark === true);
});

// The bare charcoal toolbar mark disappears on a dark toolbar, and a service
// worker cannot read prefers-color-scheme, so pages report it and we swap in
// the reversed mark. (Static `icons` use a white tile instead; see manifest.)
let toolbarIconDark = null; // unknown after a worker restart: always apply the first report
function setToolbarIcon(dark) {
  if (dark === toolbarIconDark) return;
  toolbarIconDark = dark;
  const suffix = dark ? '-dark' : '';
  chrome.action
    .setIcon({ path: { 16: `icons/toolbar16${suffix}.png`, 32: `icons/toolbar32${suffix}.png` } })
    .catch(() => {});
}

// Requests from the on-page export popup and clear toast. The page cannot
// reach chat tabs or extension storage itself; clipboard writes stay on the
// page, which holds the user's click.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !sender.tab) return false;
  if (msg.type === 'dogear-export') {
    (async () => {
      const delivery = await ACTIONS.compose();
      if (delivery.error) return sendResponse({ ok: false, note: delivery.error });
      await chrome.storage.local.set({ lastExportTarget: msg.target });
      if (msg.target === 'copy') {
        return sendResponse({ ok: true, copy: delivery.text, imageCount: delivery.assets.length, warning: delivery.warning });
      }
      const outcome = await ACTIONS.deliverToChat(msg.target, delivery);
      sendResponse({
        ok: true,
        copy: outcome.status === 'copy' ? delivery.text : null,
        outcome,
        imageCount: delivery.assets.length,
        note: ACTIONS.chatNote(outcome, delivery),
        failedNote: ACTIONS.chatNote(outcome, delivery, false),
        warning: delivery.warning,
      });
    })().catch((error) => sendResponse({ ok: false, note: error.message || 'Export failed.' }));
    return true;
  }
  if (msg.type === 'dogear-undo-clear') {
    ACTIONS.undoClear().then((restored) => sendResponse({ restored }), () => sendResponse({ restored: 0 }));
    return true;
  }
  return false;
});

// Content scripts run in the page's storage origin, so image bytes captured by
// the on-page composer cross this validated bridge into extension IndexedDB.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'dogear-store-asset') return false;
  if (!sender.tab || typeof msg.dataUrl !== 'string' || !msg.dataUrl.startsWith('data:image/')) {
    sendResponse({ ok: false, error: 'Invalid image attachment.' });
    return false;
  }
  (async () => {
    try {
      const blob = await (await fetch(msg.dataUrl)).blob();
      if (blob.size > 15 * 1024 * 1024) throw new Error('Images must be 15 MB or smaller.');
      const asset = await DOGEAR_ASSETS.put(blob, {
        mimeType: blob.type,
        displayName: msg.displayName || 'pasted-image.png',
        origin: { type: 'question-input', url: sender.tab.url || '' },
      });
      sendResponse({ ok: true, asset });
    } catch (error) {
      sendResponse({ ok: false, error: error.message || 'Could not store image.' });
    }
  })();
  return true;
});

function blobDataUrl(blob) {
  return blob.arrayBuffer().then((buffer) => {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return `data:${blob.type};base64,${btoa(binary)}`;
  });
}

async function cropCapture(dataUrl, rect, viewport) {
  const sourceBlob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(sourceBlob);
  const scaleX = bitmap.width / viewport.width;
  const scaleY = bitmap.height / viewport.height;
  const sx = Math.max(0, Math.floor(rect.x * scaleX));
  const sy = Math.max(0, Math.floor(rect.y * scaleY));
  const width = Math.max(1, Math.min(bitmap.width - sx, Math.round(rect.width * scaleX)));
  const height = Math.max(1, Math.min(bitmap.height - sy, Math.round(rect.height * scaleY)));
  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext('2d').drawImage(bitmap, sx, sy, width, height, 0, 0, width, height);
  bitmap.close();
  return { blob: await canvas.convertToBlob({ type: 'image/png' }), width, height };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'dogear-capture-region') return false;
  const rect = msg.rect;
  const viewport = msg.viewport;
  const numbers = [rect?.x, rect?.y, rect?.width, rect?.height, viewport?.width, viewport?.height];
  if (!sender.tab || numbers.some((value) => !Number.isFinite(value)) || rect.width < 2 || rect.height < 2) {
    sendResponse({ ok: false, error: 'Invalid screenshot region.' });
    return false;
  }
  (async () => {
    try {
      const capture = await chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: 'png' });
      const cropped = await cropCapture(capture, rect, viewport);
      const asset = await DOGEAR_ASSETS.put(cropped.blob, {
        mimeType: 'image/png',
        displayName: `dogear-screenshot-${new Date().toISOString().replace(/[:.]/g, '-')}.png`,
        width: cropped.width,
        height: cropped.height,
        origin: { type: 'tab-screenshot', url: sender.tab.url || '' },
      });
      sendResponse({ ok: true, asset, previewDataUrl: await blobDataUrl(cropped.blob) });
    } catch (error) {
      sendResponse({ ok: false, error: error.message || 'Could not capture screenshot.' });
    }
  })();
  return true;
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (!tab || tab.id == null) return;
  if (command === 'ask-selection') openAsk(tab.id);
  if (command === 'export-prompt') openExport(tab);
  if (command === 'clear-queue') clearFromPage(tab);
});

async function updateBadge() {
  const { queue = [] } = await chrome.storage.local.get('queue');
  await chrome.action.setBadgeText({ text: queue.length ? String(queue.length) : '' });
  await chrome.action.setBadgeBackgroundColor({ color: DOGEAR_THEME.colors.primary });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.queue) {
    updateBadge();
    const before = (changes.queue.oldValue || []).length;
    const after = (changes.queue.newValue || []).length;
    if (before !== after) refreshContextMenu();
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  recentSelectionFrames.delete(tabId);
});

updateBadge();
