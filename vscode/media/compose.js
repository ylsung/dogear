// Dogear prompt composition for VS Code, shared by the sidebar webview and
// the extension host (src/compose.ts evaluates this file, like theme.js, so
// the hotkey export works without the sidebar open). Plain script: assigns
// to globalThis, no DOM.

(() => {
  // Privacy (same policy as the Chrome side panel's sourceCitation): the full
  // file:// URI reveals the username and folder structure, and the composed
  // prompt leaves the machine. The workspace-relative title already identifies
  // the file, so local sources are cited as just "local file".
  function sourceCitation(item, P) {
    if (/^https?:/i.test(item.url)) return { title: item.title, url: item.url };
    return { title: item.title, url: P.localFile || 'local file' };
  }

  function safeFilename(name) {
    return String(name || 'image')
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
      .replace(/^\.+/, '') || 'image';
  }

  function buildAssetPlan(queue) {
    const parts = queue.flatMap((item) => [
      ...(item.selectedContext || []),
      ...(item.message?.parts || []),
    ]);
    const seen = new Set();
    return parts.flatMap((part) => {
      if (part.type !== 'asset' || seen.has(part.assetId)) return [];
      seen.add(part.assetId);
      const index = seen.size;
      return [{
        id: part.assetId,
        label: `Image I${index}`,
        deliveredName: `I${index}-${safeFilename(part.label)}`,
      }];
    });
  }

  function renderParts(parts, labels) {
    return (parts || []).map((part) =>
      part.type === 'text' ? part.text : `[${labels.get(part.assetId) || 'Missing image'}]`,
    ).join('');
  }

  function composePrompt(queue, assets, lang) {
    const P = globalThis.DOGEAR_PROMPTS[lang] || globalThis.DOGEAR_PROMPTS.en;
    const lines = [P.header(queue.length)];
    const labels = new Map(assets.map((asset) => [asset.id, asset.label]));

    let lastUrl = null;
    let sourceIdx = 0;
    queue.forEach((item, idx) => {
      if (item.url !== lastUrl) {
        sourceIdx += 1;
        const letter = String.fromCharCode(64 + sourceIdx); // A, B, C…
        const cite = sourceCitation(item, P);
        lines.push('', P.source(letter, cite.title, cite.url));
        lastUrl = item.url;
      }
      // Location suffix: PDF page in Chrome, line numbers here. P.lines is an
      // optional pack key (older packs simply omit the location).
      const where = item.page
        ? P.pdfPage(item.page)
        : item.lines && P.lines
          ? P.lines(item.lines.start, item.lines.end)
          : '';
      const contextParts = item.selectedContext || [];
      const contextText = renderParts(contextParts, labels);
      const hasContextImage = contextParts.some((part) => part.type === 'asset');
      lines.push('', !contextParts.length
        ? P.pageQuestion(idx + 1)
        : hasContextImage
          ? P.multimodalSelection(idx + 1, where, contextText)
          : P.excerpt(idx + 1, where, contextText || item.anchor.exact));
      if (item.anchor.prefix || item.anchor.suffix) {
        lines.push(P.context(item.anchor.prefix, item.anchor.suffix));
      }
      lines.push(P.question(renderParts(item.message?.parts, labels)));
    });

    if (assets.length) {
      lines.push('', P.attachmentsHeader);
      assets.forEach((asset) => lines.push(P.attachment(asset.label, asset.deliveredName)));
    }

    return lines.join('\n');
  }

  globalThis.DOGEAR_COMPOSE = { buildAssetPlan, composePrompt, renderParts };
})();
