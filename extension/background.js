// Dogear background service worker: context menu, hotkey routing, badge count.

importScripts('theme.js', 'model.js', 'asset-store.js');

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'dogear-ask',
    title: 'Dogear: ask about selection',
    contexts: ['selection'],
  });
  chrome.contextMenus.create({
    id: 'dogear-open-pdf',
    title: 'Open PDF in Dogear viewer',
    contexts: ['link'],
    targetUrlPatterns: ['*://*/*.pdf*', '*://*/pdf/*'],
  });
});

function viewerUrl(pdfUrl) {
  return `${chrome.runtime.getURL('pdfjs/web/viewer.html')}?file=${encodeURIComponent(pdfUrl)}`;
}

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(() => {});

function openAsk(tabId) {
  chrome.tabs.sendMessage(tabId, { type: 'dogear-open-ask' }).catch(() => {
    // Content script not present (chrome:// pages, web store, native PDF viewer).
  });
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'dogear-ask' && tab && tab.id != null) openAsk(tab.id);
  if (info.menuItemId === 'dogear-open-pdf' && info.linkUrl) {
    chrome.tabs.create({ url: viewerUrl(info.linkUrl) });
  }
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg && msg.type === 'dogear-open-panel' && sender.tab && sender.tab.id != null) {
    chrome.sidePanel.open({ tabId: sender.tab.id }).catch(() => {});
  }
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

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'ask-selection' && tab && tab.id != null) openAsk(tab.id);
});

async function updateBadge() {
  const { queue = [] } = await chrome.storage.local.get('queue');
  await chrome.action.setBadgeText({ text: queue.length ? String(queue.length) : '' });
  await chrome.action.setBadgeBackgroundColor({ color: DOGEAR_THEME.colors.primary });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.queue) updateBadge();
});

updateBadge();
