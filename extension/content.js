// Dogear content script: capture selections, attach questions, render highlights.
// Anchoring = TextQuote (exact + prefix/suffix) + TextPosition, in the spirit of
// the W3C Web Annotation selectors used by Hypothesis.

(() => {
  if (window.__dogearLoaded) return;
  window.__dogearLoaded = true;

  const T = globalThis.DOGEAR_THEME; // see theme.js — the one place to restyle
  const M = globalThis.DOGEAR_MODEL;
  const COMPOSER = globalThis.DOGEAR_COMPOSER;
  const CONTEXT_LEN = 32;
  const IS_DOGEAR_VIEWER =
    location.protocol === 'chrome-extension:' && location.pathname.endsWith('/viewer.html');

  // In the bundled PDF.js viewer, attribute questions to the original PDF URL
  // rather than the extension-internal viewer URL.
  function pageUrl() {
    if (IS_DOGEAR_VIEWER) {
      const f = new URLSearchParams(location.search).get('file');
      // Scheme allowlist: this value is stored and later opened as a tab /
      // rendered as a link in the side panel, so never pass through anything
      // other than a plain document URL.
      if (f && /^(https?|file):/i.test(f)) return f;
    }
    return location.href.split('#')[0];
  }

  // ---------- text-offset utilities ----------

  function bodyText() {
    const r = document.createRange();
    r.selectNodeContents(document.body);
    return r.toString();
  }

  // Global character offset of a range boundary, consistent with bodyText().
  function globalOffset(container, offset) {
    const pre = document.createRange();
    pre.selectNodeContents(document.body);
    try {
      pre.setEnd(container, offset);
    } catch (e) {
      return -1;
    }
    return pre.toString().length;
  }

  function* textNodes() {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) yield n;
  }

  // Map [start, end) global offsets back to a Range with text-node boundaries.
  function rangeFromOffsets(start, end) {
    let acc = 0;
    let startNode = null;
    let startOff = 0;
    for (const t of textNodes()) {
      const next = acc + t.data.length;
      if (startNode === null && next > start) {
        startNode = t;
        startOff = start - acc;
      }
      if (startNode !== null && next >= end) {
        const r = document.createRange();
        r.setStart(startNode, startOff);
        r.setEnd(t, end - acc);
        return r;
      }
      acc = next;
    }
    return null;
  }

  // ---------- anchoring ----------

  function makeAnchor(range) {
    const exact = range.toString();
    const start = globalOffset(range.startContainer, range.startOffset);
    const full = bodyText();
    return {
      exact,
      prefix: start >= 0 ? full.slice(Math.max(0, start - CONTEXT_LEN), start) : '',
      suffix:
        start >= 0
          ? full.slice(start + exact.length, start + exact.length + CONTEXT_LEN)
          : '',
      start,
    };
  }

  // Find the anchor in the current document; returns a Range or null.
  function locateAnchor(anchor) {
    if (!anchor.exact) return null;
    const full = bodyText();
    const candidates = [];
    let i = full.indexOf(anchor.exact);
    while (i !== -1) {
      candidates.push(i);
      i = full.indexOf(anchor.exact, i + 1);
    }
    if (!candidates.length) return null;
    let best = candidates[0];
    let bestScore = -Infinity;
    for (const c of candidates) {
      let score = 0;
      if (anchor.prefix && full.slice(Math.max(0, c - CONTEXT_LEN), c) === anchor.prefix) score += 2;
      const after = full.slice(c + anchor.exact.length, c + anchor.exact.length + CONTEXT_LEN);
      if (anchor.suffix && after === anchor.suffix) score += 2;
      if (typeof anchor.start === 'number' && anchor.start >= 0) {
        score -= Math.abs(c - anchor.start) / Math.max(full.length, 1);
      }
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
    return rangeFromOffsets(best, best + anchor.exact.length);
  }

  // ---------- highlight rendering ----------

  function wrapRange(range, id, num, question) {
    let sc = range.startContainer;
    let so = range.startOffset;
    let ec = range.endContainer;
    let eo = range.endOffset;
    if (sc.nodeType !== Node.TEXT_NODE || ec.nodeType !== Node.TEXT_NODE) return;

    if (so > 0) {
      const rest = sc.splitText(so);
      if (sc === ec) {
        ec = rest;
        eo -= so;
      }
      sc = rest;
    }
    if (eo < ec.data.length) ec.splitText(eo);

    const nodes = [];
    let inRange = false;
    for (const t of textNodes()) {
      if (t === sc) inRange = true;
      if (inRange) nodes.push(t);
      if (t === ec) break;
    }
    nodes.forEach((t, idx) => {
      if (!t.parentNode) return;
      const mark = document.createElement('mark');
      mark.className = 'dogear-mark';
      mark.dataset.dogearId = id;
      if (idx === 0) mark.dataset.dogearNum = String(num);
      mark.title = `Dogear Q${num}: ${question}`;
      t.parentNode.replaceChild(mark, t);
      mark.appendChild(t);
    });
  }

  function unwrapAllMarks() {
    document.querySelectorAll('mark.dogear-mark').forEach((mark) => {
      const parent = mark.parentNode;
      while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
      parent.removeChild(mark);
      parent.normalize();
    });
  }

  async function refreshHighlights() {
    unwrapAllMarks();
    let queue;
    try {
      ({ queue = [] } = await chrome.storage.local.get('queue'));
    } catch (e) {
      return; // stale script after extension reload
    }
    const here = queue.filter((item) => M.sourceOf(item).url === pageUrl());
    here.forEach((item) => {
      const num = queue.indexOf(item) + 1;
      const locator = M.locatorOf(item);
      if (locator.type !== 'text-quote') return;
      let range = locateAnchor(locator);
      if (!range && locator.exact.includes('\n')) {
        // Multi-line text-field captures (e.g. GitHub's code view) rarely match
        // the rendered DOM verbatim; fall back to marking the first solid line.
        const firstLine = locator.exact
          .split('\n')
          .map((s) => s.trim())
          .find((s) => s.length >= 8);
        if (firstLine) {
          range = locateAnchor({ exact: firstLine, prefix: '', suffix: '', start: -1 });
        }
      }
      if (range) wrapRange(range, item.id, num, M.textOf(M.normalizeItem(item).message.parts));
    });
  }

  // ---------- capture UI (shadow DOM) ----------

  const host = document.createElement('div');
  host.id = 'dogear-host';
  // Closed: page scripts must not get a handle on our UI (they could read the
  // typed question or synthesize clicks that plant items in the queue).
  const shadow = host.attachShadow({ mode: 'closed' });
  // Styles go through adoptedStyleSheets: pages with a strict style-src CSP
  // (e.g. the bundled PDF.js viewer, some hardened sites) block <style>
  // elements, but constructed stylesheets are not subject to page CSP.
  const DOGEAR_CSS = `
      :host { all: initial; }
      * { box-sizing: border-box; font-family: ${T.font.family}; }
      .popover, .toast { position: fixed; z-index: 2147483647; }
      .popover {
        display: none; width: 320px; background: ${T.colors.panel}; color: ${T.colors.text};
        border: 1px solid ${T.colors.borderStrong}; border-radius: 10px; padding: 10px;
        box-shadow: 0 6px 24px rgba(0,0,0,.18);
      }
      .popover .close {
        position: absolute; top: 6px; left: 6px; width: 18px; height: 18px;
        border: none; background: transparent; color: ${T.colors.textFaint}; font-size: 12px;
        line-height: 1; padding: 0; border-radius: 4px; cursor: pointer;
      }
      .popover .close:hover { background: ${T.colors.groupBg}; color: ${T.colors.text}; }
      .popover .excerpt {
        font-size: 11.5px; color: ${T.colors.textMuted}; border-left: 3px solid ${T.colors.primary};
        padding-left: 8px; margin: 0 0 8px 20px; max-height: 60px; overflow: hidden;
      }
      .popover .excerpt img {
        display: block; max-width: 100%; max-height: 88px; border-radius: 5px; object-fit: contain;
      }
      .popover .dogear-composer {
        width: 100%; min-height: 56px; resize: vertical; font-size: 13px;
        border: 1px solid ${T.colors.borderStrong}; border-radius: 6px; padding: 6px; outline: none;
        background: ${T.colors.panel}; color: ${T.colors.text}; white-space: pre-wrap;
        overflow-wrap: anywhere; cursor: text;
      }
      .popover .dogear-composer:focus { border-color: ${T.colors.primary}; }
      .dogear-composer:empty::before {
        content: attr(data-placeholder); color: ${T.colors.textFaint}; pointer-events: none;
      }
      .dogear-asset-chip {
        display: inline-flex; align-items: center; gap: 4px;
        margin: 1px 3px; padding: 2px 4px; border: 1px solid ${T.colors.borderStrong};
        border-radius: 5px; background: ${T.colors.groupBg}; vertical-align: middle;
        color: ${T.colors.textMuted}; font-size: 11px;
      }
      .dogear-asset-chip img {
        width: 22px; height: 22px; object-fit: cover; border-radius: 3px;
      }
      .dogear-inline-drop-caret {
        display: inline-block; width: 2px; height: 1.35em; margin: 0 1px;
        border-radius: 1px; background: ${T.colors.primary}; vertical-align: text-bottom;
        pointer-events: none;
      }
      .dogear-remove-asset {
        border: 0; padding: 0 2px; background: transparent; color: ${T.colors.textFaint}; cursor: pointer;
      }
      .dogear-drop-active { box-shadow: inset 0 0 0 2px ${T.colors.primary}; }
      .row { display: flex; justify-content: space-between; align-items: center; margin-top: 8px; }
      .hints { display: flex; flex-direction: column; gap: 1px; font-size: 11px; color: ${T.colors.textFaint}; }
      .btns { display: flex; gap: 6px; }
      .add {
        background: ${T.colors.primary}; color: ${T.colors.textOnPrimary};
        border: none; border-radius: 6px;
        padding: 5px 12px; font-size: 12.5px; cursor: pointer;
      }
      .add:hover { background: ${T.colors.primaryHover}; }
      .open-queue {
        background: ${T.colors.panel}; color: ${T.colors.textMuted};
        border: 1px solid ${T.colors.borderStrong}; border-radius: 6px;
        padding: 5px 10px; font-size: 12.5px; cursor: pointer;
      }
      .open-queue:hover { background: ${T.colors.groupBg}; }
      .attach {
        background: ${T.colors.panel}; color: ${T.colors.textMuted};
        border: 1px solid ${T.colors.borderStrong}; border-radius: 6px;
        padding: 5px 8px; font-size: 12.5px; cursor: pointer;
      }
      .attach:hover { background: ${T.colors.groupBg}; }
      .toast {
        display: none; left: 50%; transform: translateX(-50%); bottom: 24px;
        background: ${T.colors.dark}; color: ${T.colors.textOnDark}; border-radius: 8px;
        padding: 8px 14px; font-size: 12.5px;
      }
      .capture-overlay {
        display: none; position: fixed; inset: 0; z-index: 2147483646;
        cursor: crosshair; background: rgba(10, 16, 22, .18); user-select: none;
      }
      .capture-instructions {
        position: fixed; top: 14px; left: 50%; transform: translateX(-50%);
        display: flex; align-items: center; gap: 10px; padding: 7px 10px;
        color: white; background: rgba(20, 24, 28, .9); border-radius: 7px;
        font-size: 12px; cursor: default;
      }
      .capture-full {
        border: 1px solid rgba(255,255,255,.35); border-radius: 5px; padding: 4px 7px;
        background: rgba(255,255,255,.12); color: white; cursor: pointer;
      }
      .capture-box {
        display: none; position: fixed; border: 2px solid ${T.colors.primary};
        background: ${T.colors.highlight}; box-shadow: 0 0 0 9999px rgba(10, 16, 22, .28);
        pointer-events: none;
      }
  `;
  shadow.innerHTML = `
    <div class="popover">
      <button class="close" title="Cancel (Esc)">✕</button>
      <div class="excerpt"></div>
      <div class="question" data-placeholder="Type a question, paste an image, or drop one here…"></div>
      <input class="image-input" type="file" accept="image/*" multiple hidden />
      <div class="row">
        <div class="hints"><span>Enter to add</span><span>Esc to cancel</span></div>
        <div class="btns">
          <button class="attach" title="Attach image">＋ Image</button>
          <button class="open-queue">Open queue</button>
          <button class="add">Add to queue</button>
        </div>
      </div>
    </div>
    <div class="capture-overlay" tabindex="-1">
      <div class="capture-instructions">
        <span>Drag to select a screenshot · Esc to cancel</span>
        <button class="capture-full">Use visible page</button>
      </div>
      <div class="capture-box"></div>
    </div>
    <div class="toast"></div>
  `;
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(DOGEAR_CSS);
    shadow.adoptedStyleSheets = [sheet];
  } catch (e) {
    const styleEl = document.createElement('style');
    styleEl.textContent = DOGEAR_CSS;
    shadow.prepend(styleEl);
  }

  // On-page highlight marks live in the page DOM (outside the shadow root),
  // so their theme-driven styles are attached to the document itself.
  const MARKS_CSS = `
    mark.dogear-mark {
      background: ${T.colors.highlight}; color: inherit;
      border-radius: 2px; padding: 0;
    }
    mark.dogear-mark[data-dogear-num]::before {
      content: attr(data-dogear-num);
      display: inline-block; background: ${T.colors.primary}; color: ${T.colors.textOnPrimary};
      font-size: 10px; line-height: 1; font-family: ${T.font.family};
      border-radius: 8px; padding: 2px 5px; margin-right: 3px; vertical-align: super;
    }
  `;
  try {
    const docSheet = new CSSStyleSheet();
    docSheet.replaceSync(MARKS_CSS);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, docSheet];
  } catch (e) {
    const styleEl = document.createElement('style');
    styleEl.textContent = MARKS_CSS;
    (document.head || document.documentElement).appendChild(styleEl);
  }

  // Bundled fonts must be registered on the document (@font-face inside
  // constructed/shadow stylesheets does not load in Chrome). Best-effort:
  // strict page CSPs may reject this, in which case the fallback stack applies.
  const faces = (T.font.faces || [])
    .map(
      (f) =>
        `@font-face { font-family: '${f.family}'; font-weight: ${f.weight}; ` +
        `font-style: normal; font-display: swap; ` +
        `src: url('${chrome.runtime.getURL(f.file)}') format('woff2'); }`,
    )
    .join('\n');
  if (faces) {
    try {
      const fontStyle = document.createElement('style');
      fontStyle.textContent = faces;
      (document.head || document.documentElement).appendChild(fontStyle);
    } catch (e) {
      /* fall back to system font stack */
    }
  }

  const popover = shadow.querySelector('.popover');
  const excerptEl = shadow.querySelector('.excerpt');
  const questionEl = shadow.querySelector('.question');
  const imageInput = shadow.querySelector('.image-input');
  const attachBtn = shadow.querySelector('.attach');
  const addBtn = shadow.querySelector('.add');
  const closeBtn = shadow.querySelector('.close');
  const openQueueBtn = shadow.querySelector('.open-queue');
  const captureOverlay = shadow.querySelector('.capture-overlay');
  const captureBox = shadow.querySelector('.capture-box');
  const captureFullBtn = shadow.querySelector('.capture-full');
  const toastEl = shadow.querySelector('.toast');

  function attachHost() {
    if (document.body && !host.isConnected) document.body.appendChild(host);
  }

  let savedCapture = null;
  // Stashed while a selection exists: some apps (e.g. ChatGPT's canvas) clear
  // the selection on any mousedown, so it may already be gone by the time the
  // context-menu command or hotkey reaches us.
  let pendingCapture = null;
  let pendingCaptureAt = 0;
  let lastPoint = { x: 24, y: 24 };
  const previewUrls = new Map();

  function fileDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error('Could not read image.'));
      reader.readAsDataURL(file);
    });
  }

  const composer = COMPOSER.create(questionEl, {
    maxFileSize: 15 * 1024 * 1024,
    storeFile: async (file) => {
      const previewUrl = URL.createObjectURL(file);
      const response = await chrome.runtime.sendMessage({
        type: 'dogear-store-asset',
        dataUrl: await fileDataUrl(file),
        displayName: file.name || 'pasted-image.png',
      });
      if (!response?.ok) {
        URL.revokeObjectURL(previewUrl);
        throw new Error(response?.error || 'Could not attach image.');
      }
      previewUrls.set(response.asset.id, previewUrl);
      return response.asset;
    },
    resolveAssetUrl: async (id) => previewUrls.get(id) || '',
    onError: toast,
  });

  function currentSelectionRange() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    if (!range.toString().trim()) return null;
    return range;
  }

  function isTextField(el) {
    if (!el) return false;
    if (el.tagName === 'TEXTAREA') return true;
    if (el.tagName === 'INPUT') {
      try {
        return el.selectionStart != null;
      } catch (e) {
        return false;
      }
    }
    return false;
  }

  // A capture is either a DOM selection or a selection inside a
  // textarea/input. The latter never appears in window.getSelection() —
  // GitHub's code view, for instance, overlays an invisible textarea over
  // the code, which is why plain range capture misses it.
  function getCapture() {
    const range = currentSelectionRange();
    if (range) {
      return { kind: 'range', range: range.cloneRange(), text: range.toString() };
    }
    const el = document.activeElement;
    if (isTextField(el) && el.selectionEnd > el.selectionStart) {
      const text = el.value.slice(el.selectionStart, el.selectionEnd);
      if (text.trim()) {
        return { kind: 'input', el, text, start: el.selectionStart, end: el.selectionEnd };
      }
    }
    return null;
  }

  function captureRect(cap) {
    if (cap.kind === 'range') return cap.range.getBoundingClientRect();
    // Text-field selections have no client rect; anchor to the mouse instead.
    return { bottom: lastPoint.y, left: lastPoint.x };
  }

  function positionNear(el, rect) {
    const top = Math.min(window.innerHeight - 60, Math.max(8, rect.bottom + 6));
    const left = Math.min(window.innerWidth - 340, Math.max(8, rect.left));
    el.style.top = `${top}px`;
    el.style.left = `${left}px`;
  }

  // Remember the latest capture without showing any UI (the old floating Ask
  // button was removed — capture is hotkey / context-menu only). Keeps the
  // previous stash when the selection is already gone.
  function stashCapture() {
    const cap = getCapture();
    if (cap) {
      pendingCapture = cap;
      pendingCaptureAt = Date.now();
      try {
        chrome.runtime.sendMessage({ type: 'dogear-capture-ready' }).catch(() => {});
      } catch (_) {
        // The extension may have been reloaded while this page kept the old script.
      }
    }
  }

  function openPopover() {
    const cap = getCapture() || (Date.now() - pendingCaptureAt < 2000 ? pendingCapture : null);
    if (!cap) {
      startRegionCapture();
      return;
    }
    savedCapture = cap;
    const text = cap.text;
    excerptEl.replaceChildren();
    excerptEl.textContent = text.length > 200 ? `${text.slice(0, 200)}…` : text;
    positionNear(popover, captureRect(cap));
    popover.style.display = 'block';
    composer.setParts([]).then(() => composer.focus());
  }

  function openPagePopover() {
    closePopover();
    const source = sourceReference();
    savedCapture = { kind: 'page', source };
    excerptEl.replaceChildren();
    excerptEl.textContent = 'Asking about this page — no selection';
    positionNear(popover, { bottom: 18, left: Math.max(18, window.innerWidth - 380) });
    popover.style.display = 'block';
    composer.setParts([]).then(() => composer.focus());
  }

  function closePopover() {
    popover.style.display = 'none';
    savedCapture = null;
    pendingCapture = null;
    composer.setParts([]);
  }

  function sourceReference() {
    const source = { url: pageUrl(), title: document.title || pageUrl() };
    if (IS_DOGEAR_VIEWER) source.viewUrl = location.href.split('#')[0];
    return source;
  }

  function startRegionCapture() {
    closePopover();
    captureBox.style.display = 'none';
    captureOverlay.style.display = 'block';
    captureOverlay.focus();
  }

  function stopRegionCapture() {
    captureOverlay.style.display = 'none';
    captureBox.style.display = 'none';
  }

  async function finishRegionCapture(rect) {
    stopRegionCapture();
    // Let Chrome paint away Dogear's overlay before capturing the tab.
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'dogear-capture-region',
        rect,
        viewport: { width: window.innerWidth, height: window.innerHeight },
      });
      if (!response?.ok) throw new Error(response?.error || 'Could not capture screenshot.');
      previewUrls.set(response.asset.id, response.previewDataUrl);
      savedCapture = {
        kind: 'image',
        asset: response.asset,
        source: sourceReference(),
        locator: {
          type: 'viewport-region',
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          scrollX: window.scrollX,
          scrollY: window.scrollY,
        },
      };
      const img = document.createElement('img');
      img.src = response.previewDataUrl;
      img.alt = 'Selected screenshot';
      excerptEl.replaceChildren(img);
      positionNear(popover, { bottom: Math.min(rect.y + rect.height, innerHeight - 180), left: rect.x });
      popover.style.display = 'block';
      composer.setParts([]).then(() => composer.focus());
    } catch (error) {
      toast(error.message || 'Could not capture screenshot.');
    }
  }

  let captureStart = null;
  captureOverlay.addEventListener('pointerdown', (event) => {
    if (event.target.closest('.capture-instructions')) return;
    event.preventDefault();
    captureStart = { x: event.clientX, y: event.clientY };
    captureBox.style.display = 'block';
    captureOverlay.setPointerCapture(event.pointerId);
  });
  captureOverlay.addEventListener('pointermove', (event) => {
    if (!captureStart) return;
    const x = Math.min(captureStart.x, event.clientX);
    const y = Math.min(captureStart.y, event.clientY);
    captureBox.style.left = `${x}px`;
    captureBox.style.top = `${y}px`;
    captureBox.style.width = `${Math.abs(event.clientX - captureStart.x)}px`;
    captureBox.style.height = `${Math.abs(event.clientY - captureStart.y)}px`;
  });
  captureOverlay.addEventListener('pointerup', (event) => {
    if (!captureStart) return;
    const start = captureStart;
    captureStart = null;
    const rect = {
      x: Math.min(start.x, event.clientX),
      y: Math.min(start.y, event.clientY),
      width: Math.abs(event.clientX - start.x),
      height: Math.abs(event.clientY - start.y),
    };
    if (rect.width < 8 || rect.height < 8) stopRegionCapture();
    else finishRegionCapture(rect);
  });
  captureOverlay.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') stopRegionCapture();
  });
  captureFullBtn.addEventListener('click', () => finishRegionCapture({
    x: 0,
    y: 0,
    width: window.innerWidth,
    height: window.innerHeight,
  }));

  let toastTimer = null;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toastEl.style.display = 'none'), 2200);
  }

  async function saveQuestion() {
    const messageParts = composer.getParts();
    const hasQuestion = messageParts.some(
      (part) => part.type === 'asset' || (part.type === 'text' && part.text.trim()),
    );
    if (!hasQuestion || !savedCapture) return;
    const cap = savedCapture;
    let anchor;
    let page;
    if (cap.kind === 'image') {
      const item = M.createImageRequest({
        id: crypto.randomUUID(),
        source: cap.source,
        locator: cap.locator,
        asset: cap.asset,
        messageParts,
      });
      await addQueueItem(item, cap.source.url);
      return;
    } else if (cap.kind === 'page') {
      const item = M.createPageRequest({
        id: crypto.randomUUID(),
        source: cap.source,
        messageParts,
      });
      await addQueueItem(item, cap.source.url, cap);
      return;
    } else if (cap.kind === 'range') {
      anchor = makeAnchor(cap.range);
      // In the bundled PDF.js viewer, record which PDF page the selection is on.
      const startEl =
        cap.range.startContainer.nodeType === Node.TEXT_NODE
          ? cap.range.startContainer.parentElement
          : cap.range.startContainer;
      const pageEl =
        startEl && startEl.closest ? startEl.closest('.page[data-page-number]') : null;
      if (pageEl) page = Number(pageEl.dataset.pageNumber);
    } else {
      // Text-field selection: offsets are within the field's value, not the
      // document, so re-anchoring highlights is skipped for these.
      anchor = {
        exact: cap.text,
        prefix: cap.el.value.slice(Math.max(0, cap.start - CONTEXT_LEN), cap.start),
        suffix: cap.el.value.slice(cap.end, cap.end + CONTEXT_LEN),
        start: -1,
      };
    }
    if (page) anchor.page = page;
    const source = sourceReference();
    const item = M.createTextRequest({
      id: crypto.randomUUID(),
      source,
      locator: { type: 'text-quote', ...anchor },
      question: '',
    });
    item.message = { role: 'user', parts: messageParts };
    await addQueueItem(item, source.url, cap);
  }

  async function addQueueItem(item, sourceUrl, cap = savedCapture) {
    let queue;
    try {
      ({ queue = [] } = await chrome.storage.local.get('queue'));
      // Keep the queue grouped: insert after the last question from this page.
      let insertAt = queue.length;
      for (let i = queue.length - 1; i >= 0; i--) {
        if (M.sourceOf(queue[i]).url === sourceUrl) {
          insertAt = i + 1;
          break;
        }
      }
      queue.splice(insertAt, 0, item);
      await chrome.storage.local.set({ queue });
    } catch (e) {
      // Extension was reloaded/updated while this page still runs the old script.
      toast('Dogear was reloaded — refresh this page to reconnect.');
      return;
    }
    if (cap?.kind === 'input') {
      cap.el.setSelectionRange(cap.end, cap.end);
    }
    closePopover();
    window.getSelection()?.removeAllRanges();
    toast(`Dogear: added — ${queue.length} in queue`);
  }

  addBtn.addEventListener('click', saveQuestion);
  attachBtn.addEventListener('click', () => imageInput.click());
  imageInput.addEventListener('change', () => {
    composer.addFiles(imageInput.files);
    imageInput.value = '';
  });
  closeBtn.addEventListener('click', closePopover);
  openQueueBtn.addEventListener('click', () => {
    try {
      chrome.runtime.sendMessage({ type: 'dogear-open-panel' }).catch(() => {});
    } catch (e) {
      toast('Dogear was reloaded — refresh this page to reconnect.');
    }
  });
  questionEl.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      saveQuestion();
    } else if (e.key === 'Escape') {
      closePopover();
    }
  });
  // keyup/keypress/input also cross the shadow boundary (composed events);
  // stop them so page scripts can't keylog the question as it's typed.
  for (const type of ['keyup', 'keypress', 'input', 'paste', 'drop']) {
    questionEl.addEventListener(type, (e) => e.stopPropagation());
  }

  function maybeStashCapture() {
    if (popover.style.display === 'block') return;
    stashCapture();
  }

  // Capture phase + selectionchange fallback: SPAs like chatgpt.com stop
  // propagation of mouse events before they bubble to document, and
  // selectionchange cannot be suppressed by the page. lastPoint doubles as
  // the popover anchor for text-field captures (no client rect available).
  document.addEventListener(
    'mouseup',
    (e) => {
      lastPoint = { x: e.clientX, y: e.clientY };
      if (e.composedPath().includes(host)) return;
      setTimeout(maybeStashCapture, 10);
    },
    true,
  );
  let selTimer = null;
  document.addEventListener('selectionchange', () => {
    clearTimeout(selTimer);
    selTimer = setTimeout(maybeStashCapture, 150);
  });
  document.addEventListener(
    'mousedown',
    (e) => {
      if (!e.composedPath().includes(host)) closePopover();
    },
    true,
  );

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'dogear-open-ask') {
      attachHost();
      openPopover();
    }
    if (msg && msg.type === 'dogear-start-region') {
      attachHost();
      startRegionCapture();
    }
    if (msg && msg.type === 'dogear-open-page-ask') {
      attachHost();
      openPagePopover();
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.queue) refreshHighlights();
  });

  // Inside the bundled PDF.js viewer, pages (and their text layers) render
  // lazily, so re-anchor highlights whenever scrolling settles.
  if (IS_DOGEAR_VIEWER) {
    let scrollTimer = null;
    document.addEventListener(
      'scroll',
      () => {
        clearTimeout(scrollTimer);
        scrollTimer = setTimeout(refreshHighlights, 800);
      },
      { capture: true, passive: true },
    );
  }

  attachHost();
  refreshHighlights();
})();
