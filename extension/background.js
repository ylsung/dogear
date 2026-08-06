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
