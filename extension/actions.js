// Dogear queue actions shared by the side panel and the background worker:
// prompt composition, chat delivery, and clear-with-undo. Runs in a service
// worker too, so no DOM, FileReader, or clipboard here — callers that need the
// clipboard (side panel, page popup) write it themselves.

(() => {
  const M = globalThis.DOGEAR_MODEL;
  const ASSETS = globalThis.DOGEAR_ASSETS;

  const SOFT_CAP = 10;
  // How long a cleared queue can be restored with Undo / Command+Z.
  const CLEAR_UNDO_MS = 5 * 60 * 1000;

  // Export destinations, in the order the side panel and export popup show them.
  const TARGETS = [
    { id: 'copy', label: 'Copy prompt' },
    { id: 'chatgpt', label: '→ ChatGPT' },
    { id: 'claude', label: '→ Claude' },
  ];

  const CHATS = {
    chatgpt: { patterns: ['https://chatgpt.com/*', 'https://chat.openai.com/*'], home: 'https://chatgpt.com/', label: 'ChatGPT' },
    claude: { patterns: ['https://claude.ai/*'], home: 'https://claude.ai/new', label: 'Claude' },
  };

  async function getQueue() {
    const { queue = [] } = await chrome.storage.local.get('queue');
    return queue.map(M.normalizeItem);
  }

  async function getPromptLang() {
    const { promptLang } = await chrome.storage.local.get('promptLang');
    return promptLang && globalThis.DOGEAR_PROMPTS[promptLang]
      ? promptLang
      : globalThis.DOGEAR_PROMPT_DEFAULT_LANG;
  }

  // ---------- prompt composition ----------
  // All user-facing prompt text comes from prompts/<lang>.js template packs.

  // Privacy: local file:// paths reveal the username and folder structure, and
  // the composed prompt leaves the machine — cite only the filename for those.
  // The full URL stays on the item for navigation and grouping.
  function sourceCitation(item, P) {
    const source = M.sourceOf(item);
    if (!/^file:/i.test(source.url)) return { title: source.title, url: source.url };
    const filename = decodeURIComponent(source.url.split('#')[0].split('?')[0].split('/').pop());
    const title = /^file:/i.test(source.title) ? filename : source.title;
    return { title, url: `${P.localFile || 'local file'}: ${filename}` };
  }

  function safeFilename(name) {
    const leaf = String(name || 'image.png').split(/[\\/]/).pop();
    return leaf.replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/g, '') || 'image.png';
  }

  async function buildAssetPlan(queue) {
    const ids = [];
    for (const item of queue) {
      for (const context of item.selectedContext) {
        for (const part of context.parts) {
          if (part.type === 'asset' && !ids.includes(part.assetId)) ids.push(part.assetId);
        }
      }
      for (const part of item.message.parts) {
        if (part.type === 'asset' && !ids.includes(part.assetId)) ids.push(part.assetId);
      }
    }
    const assets = [];
    for (let index = 0; index < ids.length; index += 1) {
      const record = await ASSETS.get(ids[index]);
      if (!record) continue;
      const shortLabel = `I${index + 1}`;
      assets.push({
        id: record.id,
        label: `Image ${shortLabel}`,
        deliveredName: `${shortLabel}-${safeFilename(record.displayName)}`,
        record,
      });
    }
    return assets;
  }

  function renderParts(parts, labels) {
    return parts.map((part) =>
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
      const source = M.sourceOf(item);
      const locator = M.locatorOf(item);
      if (source.url !== lastUrl) {
        sourceIdx += 1;
        const letter = String.fromCharCode(64 + sourceIdx); // A, B, C…
        const cite = sourceCitation(item, P);
        lines.push('', P.source(letter, cite.title, cite.url));
        lastUrl = source.url;
      }
      const where = locator.page ? P.pdfPage(locator.page) : '';
      const contextParts = item.selectedContext.flatMap((context) => context.parts);
      const contextText = renderParts(contextParts, labels);
      const hasContextAsset = contextParts.some((part) => part.type === 'asset');
      lines.push('', locator.type === 'unanchored'
        ? P.pageQuestion(idx + 1)
        : hasContextAsset
          ? P.multimodalSelection(idx + 1, where, contextText)
          : P.excerpt(idx + 1, where, contextText));
      if (locator.prefix || locator.suffix) {
        lines.push(P.context(locator.prefix, locator.suffix));
      }
      lines.push(P.question(renderParts(item.message.parts, labels)));
    });

    if (assets.length) {
      lines.push('', P.attachmentsHeader);
      assets.forEach((asset) => lines.push(P.attachment(asset.label, asset.deliveredName)));
    }

    return lines.join('\n');
  }

  // Returns { text, assets, warning } or { error } when the queue is empty.
  async function compose(lang) {
    const queue = await getQueue();
    if (!queue.length) return { error: 'Queue is empty.' };
    const assets = await buildAssetPlan(queue);
    const text = composePrompt(queue, assets, lang || (await getPromptLang()));
    const warning = queue.length > SOFT_CAP
      ? `Heads up: ${queue.length} queries in one prompt may dilute answer quality.`
      : '';
    return { text, assets, warning };
  }

  // ---------- chat delivery ----------

  // Runs inside the chat tab. Finds the composer and inserts text at the end,
  // leaving the prompt in the box for the user to review and send (PRD decision).
  function injectPrompt(text) {
    const el =
      document.querySelector('#prompt-textarea') || // chatgpt.com (ProseMirror div)
      document.querySelector('div[contenteditable="true"].ProseMirror') || // claude.ai
      document.querySelector('main div[contenteditable="true"]') ||
      document.querySelector('main textarea');
    if (!el) return false;
    el.focus();
    if (el.tagName === 'TEXTAREA') {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        'value',
      ).set;
      setter.call(el, el.value ? `${el.value}\n\n${text}` : text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    return document.execCommand('insertText', false, text);
  }

  // Runs inside a destination tab. Reconstructing every image in a single
  // DataTransfer is important: repeated one-file changes cause some uploaders to
  // replace the previous selection and retain only the last image.
  async function injectFiles(payloads) {
    const transfer = new DataTransfer();
    for (const payload of payloads) {
      const binary = atob(payload.dataUrl.split(',')[1]);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      transfer.items.add(new File([bytes], payload.name, {
        type: payload.mimeType,
        lastModified: payload.lastModified,
      }));
    }
    const composer =
      document.querySelector('#prompt-textarea') ||
      document.querySelector('div[contenteditable="true"].ProseMirror') ||
      document.querySelector('main div[contenteditable="true"]') ||
      document.querySelector('main textarea');
    const inputs = [...document.querySelectorAll('input[type="file"]')];
    const acceptsImages = (candidate) => /image|\*|png|jpe?g|webp/i.test(candidate.accept || '');
    const input =
      inputs.find((candidate) => candidate.multiple && acceptsImages(candidate)) ||
      inputs.find(acceptsImages) ||
      inputs.find((candidate) => candidate.multiple) ||
      inputs[0];
    let delivered = false;
    let method = '';
    if (input) {
      try {
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          'files',
        ).set;
        setter.call(input, transfer.files);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        delivered = true;
        method = 'input';
      } catch (_) {
        // Fall through to a synthetic drop for composers without a file input.
      }
    }
    if (!delivered) {
      if (!composer) return { ok: false, count: 0 };
      composer.dispatchEvent(new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
      }));
      method = 'drop';
    }

    return { ok: true, count: transfer.files.length, method };
  }

  // FileReader is unavailable in service workers, so encode via ArrayBuffer.
  async function dataUrlForBlob(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return `data:${blob.type};base64,${btoa(binary)}`;
  }

  async function payloadsForAssets(assets) {
    return Promise.all(assets.map(async (asset) => ({
      dataUrl: await dataUrlForBlob(asset.record.blob),
      name: asset.deliveredName,
      mimeType: asset.record.mimeType,
      lastModified: asset.record.createdAt,
    })));
  }

  async function attachAssetsToTab(tab, assets) {
    if (!tab?.id || !assets.length) return { ok: false };
    try {
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: injectFiles,
        args: [await payloadsForAssets(assets)],
      });
      const outcome = result?.result;
      if (!outcome?.ok || outcome.count !== assets.length) {
        return { ok: false };
      }
      return { ok: true };
    } catch (_) {
      return { ok: false };
    }
  }

  // Inserts the prompt (and images) into an open chat tab. Returns
  // { status: 'opened' | 'inserted' | 'copy', label, imagesFailed }; on 'copy'
  // the caller must put delivery.text on the clipboard itself.
  async function deliverToChat(kind, delivery) {
    const cfg = CHATS[kind];
    const tabs = await chrome.tabs.query({ url: cfg.patterns });
    if (!tabs.length) {
      await chrome.tabs.create({ url: cfg.home });
      return { status: 'opened', label: cfg.label, imagesFailed: false };
    }
    // Inject first, focus after: once the chat tab is focused the side panel
    // loses focus and clipboard writes are rejected ("Document is not focused").
    const tab = tabs.find((t) => t.active) || tabs[0];
    const attachmentOutcome = delivery.assets.length
      ? await attachAssetsToTab(tab, delivery.assets)
      : { ok: true };
    const imagesFailed = !!delivery.assets.length && !attachmentOutcome.ok;
    let inserted = false;
    try {
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: injectPrompt,
        args: [delivery.text],
      });
      inserted = !!(result && result.result);
    } catch (e) {
      inserted = false;
    }
    if (!inserted) return { status: 'copy', label: cfg.label, imagesFailed };
    await chrome.windows.update(tab.windowId, { focused: true });
    await chrome.tabs.update(tab.id, { active: true });
    return { status: 'inserted', label: cfg.label, imagesFailed };
  }

  // What to tell the user after deliverToChat. `copied` is whether the caller
  // managed to put the prompt on the clipboard for a 'copy' outcome.
  function chatNote(outcome, delivery, copied = true) {
    const { label } = outcome;
    if (outcome.status === 'opened') return `Opened ${label} — send again once it has loaded.`;
    if (outcome.status === 'inserted') {
      return outcome.imagesFailed
        ? `Prompt inserted, but the images still need attaching. Open ${label}'s attachment menu and click “Attach all” in Dogear.`
        : `Prompt${delivery.assets.length ? ' and images' : ''} inserted into ${label} — review and send.`;
    }
    if (!copied) return 'Couldn\'t insert or copy automatically — use the "Copy prompt" button.';
    if (outcome.imagesFailed) {
      return `Couldn't complete ${label} handoff — prompt copied; open its attachment menu and use Dogear's “Attach all” button.`;
    }
    if (delivery.assets.length) return `Images attached, but the prompt was copied — paste it into ${label}.`;
    return `Couldn't find ${label}'s input box — prompt copied to the clipboard.`;
  }

  function copyNote(delivery) {
    const n = delivery.assets.length;
    return n
      ? `Prompt copied — open the destination chat, then click “Attach all ${n} ${n === 1 ? 'image' : 'images'} to this tab.”`
      : 'Prompt copied — paste it into any chat.';
  }

  // ---------- clear with undo ----------
  // A clear keeps the removed questions (and so their images) as
  // `clearedQueue` until the undo window passes or the next clear replaces it.

  async function clearQueue() {
    const { queue = [] } = await chrome.storage.local.get('queue');
    if (!queue.length) return 0;
    await chrome.storage.local.set({ queue: [], clearedQueue: { items: queue, at: Date.now() } });
    return queue.length;
  }

  async function canUndoClear() {
    const { clearedQueue } = await chrome.storage.local.get('clearedQueue');
    return !!clearedQueue && Date.now() - clearedQueue.at < CLEAR_UNDO_MS;
  }

  // Restores the cleared questions ahead of anything added since. Returns how
  // many came back (0 when there is nothing to undo).
  async function undoClear() {
    const { queue = [], clearedQueue } = await chrome.storage.local.get(['queue', 'clearedQueue']);
    if (!clearedQueue || Date.now() - clearedQueue.at >= CLEAR_UNDO_MS) return 0;
    const restoredIds = new Set(clearedQueue.items.map((item) => item.id));
    await chrome.storage.local.set({
      queue: [...clearedQueue.items, ...queue.filter((item) => !restoredIds.has(item.id))],
    });
    await chrome.storage.local.remove('clearedQueue');
    return clearedQueue.items.length;
  }

  // Asset ids an undoable clear still needs; drops an expired snapshot.
  async function clearedAssetIds() {
    const { clearedQueue } = await chrome.storage.local.get('clearedQueue');
    if (!clearedQueue) return [];
    if (Date.now() - clearedQueue.at >= CLEAR_UNDO_MS) {
      await chrome.storage.local.remove('clearedQueue');
      return [];
    }
    return clearedQueue.items.map(M.normalizeItem).flatMap(M.assetIdsOf);
  }

  globalThis.DOGEAR_ACTIONS = {
    TARGETS,
    getQueue,
    getPromptLang,
    buildAssetPlan,
    compose,
    attachAssetsToTab,
    deliverToChat,
    chatNote,
    copyNote,
    clearQueue,
    canUndoClear,
    undoClear,
    clearedAssetIds,
  };
})();
