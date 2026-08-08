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

const recentSelectionFrames = new Map();
const ATTACHMENT_STATUS_KEY = 'attachmentStatus';

async function clearAttachmentStatusForTab(tabId) {
  const { [ATTACHMENT_STATUS_KEY]: current = {} } =
    await chrome.storage.session.get(ATTACHMENT_STATUS_KEY);
  const next = Object.fromEntries(
    Object.entries(current).filter(([, status]) => status.tabId !== tabId),
  );
  if (Object.keys(next).length !== Object.keys(current).length) {
    await chrome.storage.session.set({ [ATTACHMENT_STATUS_KEY]: next });
  }
}

async function updateObservedAttachmentStatus(msg, sender) {
  if (!sender.tab || !Array.isArray(msg.assetIds) || !Array.isArray(msg.presentAssetIds)) return;
  const { queue = [] } = await chrome.storage.local.get('queue');
  const validIds = new Set(queue.flatMap(DOGEAR_MODEL.assetIdsOf));
  const batchIds = msg.assetIds.filter((id) => typeof id === 'string' && validIds.has(id));
  const presentIds = new Set(
    msg.presentAssetIds.filter((id) => typeof id === 'string' && validIds.has(id)),
  );
  if (!batchIds.length) return;

  const { [ATTACHMENT_STATUS_KEY]: current = {} } =
    await chrome.storage.session.get(ATTACHMENT_STATUS_KEY);
  const next = { ...current };
  for (const id of batchIds) {
    if (presentIds.has(id)) {
      next[id] = {
        state: 'attached',
        tabId: sender.tab.id,
        monitored: true,
        updatedAt: Date.now(),
      };
    } else if (next[id]?.tabId === sender.tab.id) {
      delete next[id];
    }
  }
  if (JSON.stringify(next) !== JSON.stringify(current)) {
    await chrome.storage.session.set({ [ATTACHMENT_STATUS_KEY]: next });
  }
}

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

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'dogear-ask' && tab && tab.id != null) {
    openAsk(tab.id, Number.isInteger(info.frameId) ? info.frameId : undefined);
  }
  if (info.menuItemId === 'dogear-open-pdf' && info.linkUrl) {
    chrome.tabs.create({ url: viewerUrl(info.linkUrl) });
  }
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg && msg.type === 'dogear-capture-ready' && sender.tab && sender.tab.id != null) {
    recentSelectionFrames.set(sender.tab.id, { frameId: sender.frameId, at: Date.now() });
  }
  if (msg && msg.type === 'dogear-open-panel' && sender.tab && sender.tab.id != null) {
    chrome.sidePanel.open({ tabId: sender.tab.id }).catch(() => {});
  }
  if (msg && msg.type === 'dogear-attachment-status') {
    updateObservedAttachmentStatus(msg, sender).catch(() => {});
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

chrome.tabs.onRemoved.addListener((tabId) => {
  recentSelectionFrames.delete(tabId);
  clearAttachmentStatusForTab(tabId).catch(() => {});
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading' || changeInfo.url) {
    clearAttachmentStatusForTab(tabId).catch(() => {});
  }
});

updateBadge();
