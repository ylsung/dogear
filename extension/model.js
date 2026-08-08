// Shared queue/message helpers for the Chrome extension. The persisted v2 shape
// uses ordered content parts while normalizeItem keeps every v1 text-only item
// readable without an eager, destructive migration.

(() => {
  function textPart(text = '') {
    return { type: 'text', text: String(text) };
  }

  function assetPart(assetId, mediaType = 'application/octet-stream', label = '') {
    return { type: 'asset', assetId, mediaType, label };
  }

  function coalesceParts(parts) {
    const result = [];
    for (const part of parts || []) {
      if (!part || (part.type !== 'text' && part.type !== 'asset')) continue;
      if (part.type === 'text') {
        const text = String(part.text || '');
        if (!text) continue;
        const previous = result[result.length - 1];
        if (previous && previous.type === 'text') previous.text += text;
        else result.push(textPart(text));
      } else if (typeof part.assetId === 'string' && part.assetId) {
        result.push(assetPart(part.assetId, part.mediaType, part.label));
      }
    }
    return result;
  }

  function legacyContext(item) {
    const anchor = item.anchor || { exact: '', prefix: '', suffix: '', start: -1 };
    return {
      source: {
        url: item.url || '',
        title: item.title || item.url || '',
        ...(item.viewUrl ? { viewUrl: item.viewUrl } : {}),
      },
      locator: {
        type: 'text-quote',
        exact: anchor.exact || '',
        prefix: anchor.prefix || '',
        suffix: anchor.suffix || '',
        start: typeof anchor.start === 'number' ? anchor.start : -1,
        ...(item.page ? { page: item.page } : {}),
      },
      parts: [textPart(anchor.exact || '')],
    };
  }

  function normalizeItem(item) {
    const selectedContext = Array.isArray(item.selectedContext)
      ? item.selectedContext.map((context) => ({
          ...context,
          source: { ...(context.source || {}) },
          locator: { type: 'unanchored', ...(context.locator || {}) },
          parts: coalesceParts(context.parts),
        }))
      : [legacyContext(item)];
    const message = item.message && Array.isArray(item.message.parts)
      ? { role: 'user', parts: coalesceParts(item.message.parts) }
      : { role: 'user', parts: [textPart(item.question || '')] };
    return {
      id: item.id,
      selectedContext,
      message,
      createdAt: item.createdAt || Date.now(),
    };
  }

  function sourceOf(item) {
    return normalizeItem(item).selectedContext[0]?.source || { url: '', title: '' };
  }

  function locatorOf(item) {
    return normalizeItem(item).selectedContext[0]?.locator || { type: 'unanchored' };
  }

  function textOf(parts) {
    return coalesceParts(parts)
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('');
  }

  function assetIdsOf(item) {
    const normalized = normalizeItem(item);
    const ids = [];
    for (const block of normalized.selectedContext) {
      for (const part of block.parts) if (part.type === 'asset') ids.push(part.assetId);
    }
    for (const part of normalized.message.parts) {
      if (part.type === 'asset') ids.push(part.assetId);
    }
    return [...new Set(ids)];
  }

  function createTextRequest({ id, source, locator, question, createdAt = Date.now() }) {
    return {
      id,
      selectedContext: [{ source, locator, parts: [textPart(locator.exact || '')] }],
      message: { role: 'user', parts: [textPart(question)] },
      createdAt,
    };
  }

  function createImageRequest({ id, source, locator, asset, messageParts, createdAt = Date.now() }) {
    return {
      id,
      selectedContext: [{
        source,
        locator,
        parts: [assetPart(asset.id, asset.mimeType, asset.displayName)],
      }],
      message: { role: 'user', parts: coalesceParts(messageParts) },
      createdAt,
    };
  }

  function createPageRequest({ id, source, messageParts, createdAt = Date.now() }) {
    return {
      id,
      selectedContext: [{ source, locator: { type: 'unanchored' }, parts: [] }],
      message: { role: 'user', parts: coalesceParts(messageParts) },
      createdAt,
    };
  }

  const api = {
    assetIdsOf,
    assetPart,
    coalesceParts,
    createImageRequest,
    createPageRequest,
    createTextRequest,
    locatorOf,
    normalizeItem,
    sourceOf,
    textOf,
    textPart,
  };
  globalThis.DOGEAR_MODEL = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
