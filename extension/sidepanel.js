// Dogear side panel: queue UI, prompt composer, delivery (clipboard / chat injection).

// Apply the global theme (see theme.js) as CSS variables + branded text.
{
  const T = globalThis.DOGEAR_THEME;
  const root = document.documentElement;
  for (const [k, v] of Object.entries(T.colors)) root.style.setProperty(`--${k}`, v);
  root.style.setProperty('--font', T.font.family);
  const faces = (T.font.faces || [])
    .map(
      (f) =>
        `@font-face { font-family: '${f.family}'; font-weight: ${f.weight}; ` +
        `font-style: normal; font-display: swap; ` +
        `src: url('${chrome.runtime.getURL(f.file)}') format('woff2'); }`,
    )
    .join('\n');
  if (faces) {
    const s = document.createElement('style');
    s.textContent = faces;
    document.head.appendChild(s);
  }
  document.getElementById('brand').textContent = `${T.emoji.dog} Dogear`;
  document.getElementById('open-pdf').textContent =
    `${T.emoji.pdf} Open this PDF in Dogear viewer`;
}

const listEl = document.getElementById('list');
const emptyEl = document.getElementById('empty');
const countEl = document.getElementById('count');
const noteEl = document.getElementById('note');
const M = globalThis.DOGEAR_MODEL;
const ASSETS = globalThis.DOGEAR_ASSETS;
const COMPOSER = globalThis.DOGEAR_COMPOSER;
const handoffEl = document.getElementById('manual-handoff');
const handoffSummaryEl = document.getElementById('manual-summary');
const handoffAssetsEl = document.getElementById('manual-assets');
const liveObjectUrls = [];
const liveComposers = [];
let quietQueueWrites = 0;

const SOFT_CAP = 10;

async function getQueue() {
  const { queue = [] } = await chrome.storage.local.get('queue');
  return queue.map(M.normalizeItem);
}

async function setQueue(queue) {
  await chrome.storage.local.set({ queue });
}

async function setQueueQuietly(queue) {
  quietQueueWrites += 1;
  await chrome.storage.local.set({ queue });
}

async function collectGarbage(queue) {
  const referenced = queue.flatMap(M.assetIdsOf);
  await ASSETS.removeUnreferenced(referenced);
}

function note(msg) {
  noteEl.textContent = msg;
  setTimeout(() => {
    if (noteEl.textContent === msg) noteEl.textContent = '';
  }, 4000);
}

// ---------- rendering ----------

function truncate(s, n) {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function viewerLink(pdfUrl) {
  return `${chrome.runtime.getURL('pdfjs/web/viewer.html')}?file=${encodeURIComponent(pdfUrl)}`;
}

function faviconUrl(url) {
  const u = new URL(chrome.runtime.getURL('/_favicon/'));
  u.searchParams.set('pageUrl', url);
  u.searchParams.set('size', '16');
  return u.toString();
}

// Where clicking a source header should take the user: back to where the
// questions were captured (item.viewUrl, e.g. the Dogear PDF viewer), while
// item.url stays the canonical source cited in the composed prompt.
// Queue items come from content scripts on arbitrary pages; only ever
// navigate to plain document URLs (no javascript:, data:, etc.).
function isSafeUrl(url) {
  return /^(https?|file):/i.test(url) || url.startsWith(chrome.runtime.getURL(''));
}

function sourceDestination(item) {
  const source = M.sourceOf(item);
  if (source.viewUrl && isSafeUrl(source.viewUrl)) return source.viewUrl;
  if (!isSafeUrl(source.url)) return '#';
  if (looksLikePdf(source.url)) return viewerLink(source.url);
  return source.url;
}

// Focus the already-open tab for a source if there is one; open it otherwise.
async function openSource(item) {
  const dest = sourceDestination(item);
  if (dest === '#') return;
  const targets = [dest, M.sourceOf(item).url].map((x) => x.split('#')[0]);
  const tabs = await chrome.tabs.query({});
  const tab = tabs.find((t) => t.url && targets.includes(t.url.split('#')[0]));
  if (tab) {
    await chrome.windows.update(tab.windowId, { focused: true });
    await chrome.tabs.update(tab.id, { active: true });
  } else {
    await chrome.tabs.create({ url: dest });
  }
}

// ---------- selection & drag state ----------

let selectedIds = new Set();
let lastAnchorId = null;
let dragMode = null; // 'card' | 'group' while a drag is in flight
// Groups are identified by rendered block, not URL: the same page can render
// as two separate blocks (A, B, A after manual reordering), and those must be
// draggable onto each other. groupBlocks[i] = item ids of the i-th block.
let draggedGroupIdx = -1;
let groupBlocks = [];

function clearDropIndicators() {
  listEl
    .querySelectorAll('.drop-before, .drop-after')
    .forEach((c) => c.classList.remove('drop-before', 'drop-after'));
}

function applySelectionClasses() {
  listEl.querySelectorAll('.card').forEach((c) => {
    c.classList.toggle('selected', selectedIds.has(c.dataset.id));
  });
}

async function selectRange(fromId, toId) {
  const ids = (await getQueue()).map((x) => x.id);
  const a = ids.indexOf(fromId);
  const b = ids.indexOf(toId);
  if (a === -1 || b === -1) return;
  ids.slice(Math.min(a, b), Math.max(a, b) + 1).forEach((id) => selectedIds.add(id));
}

async function dropGroupBlockAt(fromIdx, targetIdx, before) {
  if (fromIdx === targetIdx) return;
  const movingIds = new Set(groupBlocks[fromIdx] || []);
  const targetIds = groupBlocks[targetIdx] || [];
  if (!movingIds.size || !targetIds.length) return;
  const queue = await getQueue();
  const moving = queue.filter((x) => movingIds.has(x.id));
  const rest = queue.filter((x) => !movingIds.has(x.id));
  const anchorId = before ? targetIds[0] : targetIds[targetIds.length - 1];
  let idx = rest.findIndex((x) => x.id === anchorId);
  if (idx === -1) return;
  if (!before) idx += 1;
  rest.splice(idx, 0, ...moving);
  await setQueue(rest);
}

// Delegated drag targeting: one listener pair on the list container, using the
// same midpoint rule for cards and groups. This also makes the whole panel a
// valid drop surface (per-element handlers left dead zones between groups
// where drops were silently rejected).
listEl.addEventListener('dragover', (e) => {
  if (!dragMode) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  clearDropIndicators();
  const target =
    dragMode === 'group' ? e.target.closest('.group') : e.target.closest('.card');
  if (!target) return;
  if (dragMode === 'group' && Number(target.dataset.groupIdx) === draggedGroupIdx) return;
  if (dragMode === 'card' && selectedIds.has(target.dataset.id)) return;
  const rect = target.getBoundingClientRect();
  const before = e.clientY < rect.top + rect.height / 2;
  target.classList.add(before ? 'drop-before' : 'drop-after');
});

listEl.addEventListener('drop', async (e) => {
  if (!dragMode) return;
  e.preventDefault();
  const marked = listEl.querySelector('.drop-before, .drop-after');
  const before = marked ? marked.classList.contains('drop-before') : false;
  const mode = dragMode;
  clearDropIndicators();
  if (!marked) return;
  if (mode === 'group') {
    await dropGroupBlockAt(draggedGroupIdx, Number(marked.dataset.groupIdx), before);
  } else {
    await dropSelectedAt(marked.dataset.id, before);
  }
});

listEl.addEventListener('dragend', () => {
  dragMode = null;
  draggedGroupIdx = -1;
  clearDropIndicators();
});

async function dropSelectedAt(targetId, before) {
  if (selectedIds.has(targetId)) return;
  const queue = await getQueue();
  const moving = queue.filter((x) => selectedIds.has(x.id));
  if (!moving.length) return;
  const rest = queue.filter((x) => !selectedIds.has(x.id));
  let idx = rest.findIndex((x) => x.id === targetId);
  if (idx === -1) return;
  if (!before) idx += 1;
  rest.splice(idx, 0, ...moving);
  await setQueue(rest);
}

async function render() {
  liveObjectUrls.splice(0).forEach((url) => URL.revokeObjectURL(url));
  liveComposers.splice(0).forEach((composer) => composer.destroy());
  const queue = await getQueue();
  countEl.textContent = queue.length
    ? `${queue.length} ${queue.length > 1 ? 'queries' : 'query'}`
    : '';
  listEl.querySelectorAll('.group').forEach((el) => el.remove());
  emptyEl.style.display = queue.length ? 'none' : 'block';

  let lastUrl = null;
  let group = null;
  groupBlocks = [];
  queue.forEach((item, idx) => {
    const sourceInfo = M.sourceOf(item);
    const locator = M.locatorOf(item);
    if (sourceInfo.url !== lastUrl) {
      group = document.createElement('div');
      group.className = 'group';
      const groupIdx = groupBlocks.length;
      groupBlocks.push([]);
      group.dataset.groupIdx = String(groupIdx);
      group.draggable = true;
      group.addEventListener('dragstart', (e) => {
        dragMode = 'group';
        draggedGroupIdx = groupIdx;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', `group:${groupIdx}`);
      });
      const src = document.createElement('a');
      src.className = 'source';
      src.title = sourceInfo.url;
      src.href = sourceDestination(item);
      src.draggable = false; // links drag natively and would hijack group drags
      src.addEventListener('click', (e) => {
        e.preventDefault();
        openSource(item);
      });
      const icon = document.createElement('img');
      icon.className = 'favicon';
      icon.src = faviconUrl(sourceInfo.url);
      icon.draggable = false;
      const label = document.createElement('span');
      label.textContent = sourceInfo.title;
      src.append(icon, label);
      group.appendChild(src);
      listEl.appendChild(group);
      lastUrl = sourceInfo.url;
    }
    groupBlocks[groupBlocks.length - 1].push(item.id);

    const card = document.createElement('div');
    card.className = 'card';
    card.dataset.id = item.id;
    card.draggable = true;
    if (selectedIds.has(item.id)) card.classList.add('selected');

    card.addEventListener('click', async (e) => {
      if (e.target.closest('.dogear-composer, textarea, input, button')) return;
      if (e.shiftKey && lastAnchorId) {
        await selectRange(lastAnchorId, item.id);
      } else if (e.metaKey || e.ctrlKey) {
        if (selectedIds.has(item.id)) selectedIds.delete(item.id);
        else selectedIds.add(item.id);
        lastAnchorId = item.id;
      } else {
        if (selectedIds.size === 1 && selectedIds.has(item.id)) selectedIds.clear();
        else selectedIds = new Set([item.id]);
        lastAnchorId = item.id;
      }
      applySelectionClasses();
    });

    card.addEventListener('dragstart', (e) => {
      if (e.target.closest('.dogear-composer, input, button')) {
        e.preventDefault();
        return;
      }
      e.stopPropagation(); // don't also start the enclosing group's drag
      dragMode = 'card';
      if (!selectedIds.has(item.id)) {
        selectedIds = new Set([item.id]);
        applySelectionClasses();
      }
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', item.id);
    });

    const top = document.createElement('div');
    top.className = 'top';
    const num = document.createElement('span');
    num.className = 'num';
    num.textContent = `Q${idx + 1}`;
    const contextText = M.textOf(item.selectedContext.flatMap((context) => context.parts));
    if (contextText) {
      const quote = document.createElement('blockquote');
      quote.textContent = truncate(contextText, 220);
      quote.title = contextText;
      top.append(num, quote);
    } else {
      const images = document.createElement('div');
      images.className = 'context-images';
      top.append(num, images);
      for (const part of item.selectedContext.flatMap((context) => context.parts)) {
        if (part.type !== 'asset') continue;
        ASSETS.get(part.assetId).then((record) => {
          if (!record || !images.isConnected) return;
          const url = URL.createObjectURL(record.blob);
          liveObjectUrls.push(url);
          const img = document.createElement('img');
          img.src = url;
          img.alt = part.label || 'Selected image';
          img.title = img.alt;
          images.appendChild(img);
        });
      }
    }

    const q = document.createElement('div');
    q.dataset.placeholder = 'Type a question, paste an image, or drop one here…';
    let draftParts = item.message.parts;
    const saveDraft = async (parts) => {
      const queueNow = await getQueue();
      const target = queueNow.find((x) => x.id === item.id);
      if (target) {
        target.message = { role: 'user', parts: M.coalesceParts(parts) };
        await setQueueQuietly(queueNow);
        await collectGarbage(queueNow);
      }
    };
    const composer = COMPOSER.create(q, {
      parts: item.message.parts,
      maxFileSize: 15 * 1024 * 1024,
      storeFile: (file) => ASSETS.put(file, {
        mimeType: file.type,
        displayName: file.name || 'pasted-image.png',
        origin: { type: 'question-input' },
      }),
      resolveAssetUrl: async (id) => {
        const record = await ASSETS.get(id);
        if (!record) return '';
        const url = URL.createObjectURL(record.blob);
        liveObjectUrls.push(url);
        return url;
      },
      onChange: (parts, reason) => {
        draftParts = parts;
        if (reason === 'asset') saveDraft(parts);
      },
      onBlur: () => saveDraft(draftParts),
      onError: note,
    });
    liveComposers.push(composer);

    const attachInput = document.createElement('input');
    attachInput.type = 'file';
    attachInput.accept = 'image/*';
    attachInput.multiple = true;
    attachInput.hidden = true;
    attachInput.addEventListener('change', () => {
      composer.addFiles(attachInput.files);
      attachInput.value = '';
    });

    const tools = document.createElement('div');
    tools.className = 'tools';
    const mk = (label, title, fn) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.title = title;
      b.addEventListener('click', fn);
      return b;
    };
    tools.append(
      mk('＋ Image', 'Attach one or more images to this question', () => attachInput.click()),
      mk('↑', 'Move up', () => move(item.id, -1)),
      mk('↓', 'Move down', () => move(item.id, +1)),
      mk('✕', 'Delete', () => remove(item.id)),
    );

    card.append(top, q, attachInput, tools);
    group.appendChild(card);
  });
  await renderManualHandoff(queue);
}

async function move(id, delta) {
  const queue = await getQueue();
  const i = queue.findIndex((x) => x.id === id);
  const j = i + delta;
  if (i === -1 || j < 0 || j >= queue.length) return;
  [queue[i], queue[j]] = [queue[j], queue[i]];
  await setQueue(queue);
}

async function remove(id) {
  const queue = await getQueue();
  const next = queue.filter((x) => x.id !== id);
  await setQueue(next);
  await collectGarbage(next);
}

// ---------- prompt composition ----------
// All user-facing prompt text comes from prompts/<lang>.js template packs.

let promptLang = globalThis.DOGEAR_PROMPT_DEFAULT_LANG;

const langSelect = document.getElementById('lang');
for (const [code, pack] of Object.entries(globalThis.DOGEAR_PROMPTS)) {
  const opt = document.createElement('option');
  opt.value = code;
  opt.textContent = pack.name;
  langSelect.appendChild(opt);
}
chrome.storage.local.get('promptLang').then(({ promptLang: stored }) => {
  if (stored && globalThis.DOGEAR_PROMPTS[stored]) promptLang = stored;
  langSelect.value = promptLang;
});
langSelect.addEventListener('change', () => {
  promptLang = langSelect.value;
  chrome.storage.local.set({ promptLang });
});

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

function composePrompt(queue, assets) {
  const P = globalThis.DOGEAR_PROMPTS[promptLang] || globalThis.DOGEAR_PROMPTS.en;
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
    lines.push('', hasContextAsset
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

async function composeOrWarn() {
  const queue = await getQueue();
  if (!queue.length) {
    note('Queue is empty.');
    return null;
  }
  if (queue.length > SOFT_CAP) {
    note(`Heads up: ${queue.length} queries in one prompt may dilute answer quality.`);
  }
  const assets = await buildAssetPlan(queue);
  return { text: composePrompt(queue, assets), assets };
}

async function renderManualHandoff(queue) {
  const assets = await buildAssetPlan(queue);
  handoffAssetsEl.replaceChildren();
  handoffEl.hidden = !assets.length;
  if (!assets.length) return;
  handoffSummaryEl.textContent = `Manual handoff · ${assets.length} ${assets.length === 1 ? 'image' : 'images'}`;
  for (const asset of assets) {
    const row = document.createElement('div');
    row.className = 'handoff-asset';
    row.draggable = true;
    row.title = 'Drag this image into a chat composer';
    const url = URL.createObjectURL(asset.record.blob);
    liveObjectUrls.push(url);
    const img = document.createElement('img');
    img.src = url;
    img.alt = '';
    const label = document.createElement('span');
    label.textContent = `${asset.label} · ${asset.deliveredName}`;
    const download = document.createElement('button');
    download.type = 'button';
    download.textContent = 'Save';
    download.title = 'Save this image if drag-and-drop is not accepted';
    download.addEventListener('click', () => {
      const link = document.createElement('a');
      link.href = url;
      link.download = asset.deliveredName;
      link.click();
    });
    row.addEventListener('dragstart', (event) => {
      const file = new File([asset.record.blob], asset.deliveredName, { type: asset.record.mimeType });
      event.dataTransfer.items.add(file);
      event.dataTransfer.effectAllowed = 'copy';
    });
    row.append(img, label, download);
    handoffAssetsEl.appendChild(row);
  }
}

// ---------- delivery ----------

document.getElementById('copy').addEventListener('click', async () => {
  const delivery = await composeOrWarn();
  if (!delivery) return;
  await navigator.clipboard.writeText(delivery.text);
  if (delivery.assets.length) {
    handoffEl.open = true;
    note(`Prompt copied — drag the ${delivery.assets.length} labeled ${delivery.assets.length === 1 ? 'image' : 'images'} above into any chat.`);
  } else {
    note('Prompt copied — paste it into any chat.');
  }
});

document.getElementById('clear').addEventListener('click', async () => {
  const queue = await getQueue();
  if (!queue.length) return;
  if (confirm(`Remove all ${queue.length} queries?`)) {
    await setQueue([]);
    await collectGarbage([]);
  }
});

document.getElementById('capture-region').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'dogear-start-region' }, { frameId: 0 });
    await chrome.windows.update(tab.windowId, { focused: true });
    await chrome.tabs.update(tab.id, { active: true });
  } catch (_) {
    note('Dogear cannot capture this browser page.');
  }
});

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

// Runs inside a supported chat tab. Reconstructs one local image as a File and
// routes it through the page's own file input. One file per invocation keeps
// extension messages bounded even when a request has several large images.
function injectFile(payload) {
  const binary = atob(payload.dataUrl.split(',')[1]);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  const file = new File([bytes], payload.name, { type: payload.mimeType });
  const transfer = new DataTransfer();
  transfer.items.add(file);
  const inputs = [...document.querySelectorAll('input[type="file"]')];
  const input = inputs.find((candidate) => /image|\*/i.test(candidate.accept || '')) || inputs[0];
  if (input) {
    try {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'files',
      ).set;
      setter.call(input, transfer.files);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    } catch (_) {
      // Fall through to a synthetic drop for composers without a file input.
    }
  }
  const composer =
    document.querySelector('#prompt-textarea') ||
    document.querySelector('div[contenteditable="true"].ProseMirror') ||
    document.querySelector('main div[contenteditable="true"]') ||
    document.querySelector('main textarea');
  if (!composer) return false;
  composer.dispatchEvent(new DragEvent('drop', {
    bubbles: true,
    cancelable: true,
    dataTransfer: transfer,
  }));
  return true;
}

function dataUrlForBlob(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('Could not read attachment.'));
    reader.readAsDataURL(blob);
  });
}

async function sendToChat(kind) {
  const delivery = await composeOrWarn();
  if (!delivery) return;
  const cfg =
    kind === 'chatgpt'
      ? { patterns: ['https://chatgpt.com/*', 'https://chat.openai.com/*'], home: 'https://chatgpt.com/', label: 'ChatGPT' }
      : { patterns: ['https://claude.ai/*'], home: 'https://claude.ai/new', label: 'Claude' };

  const tabs = await chrome.tabs.query({ url: cfg.patterns });
  if (!tabs.length) {
    await chrome.tabs.create({ url: cfg.home });
    note(`Opened ${cfg.label} — click the button again once it has loaded.`);
    return;
  }
  // Inject first, focus after: once the chat tab is focused the side panel
  // loses focus and clipboard writes are rejected ("Document is not focused").
  const tab = tabs.find((t) => t.active) || tabs[0];
  const failedAssets = [];
  for (const asset of delivery.assets) {
    let attached = false;
    try {
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: injectFile,
        args: [{
          dataUrl: await dataUrlForBlob(asset.record.blob),
          name: asset.deliveredName,
          mimeType: asset.record.mimeType,
        }],
      });
      attached = !!result?.result;
    } catch (_) {
      attached = false;
    }
    if (!attached) failedAssets.push(asset);
    // Give the site's uploader a moment to consume each synthetic change.
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
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
  if (inserted) {
    await chrome.windows.update(tab.windowId, { focused: true });
    await chrome.tabs.update(tab.id, { active: true });
    if (failedAssets.length) {
      handoffEl.open = true;
      note(`Prompt inserted, but ${failedAssets.map((asset) => asset.label).join(', ')} still ${failedAssets.length === 1 ? 'needs' : 'need'} to be dragged into ${cfg.label}.`);
    } else {
      note(`Prompt${delivery.assets.length ? ' and images' : ''} inserted into ${cfg.label} — review and send.`);
    }
  } else {
    try {
      await navigator.clipboard.writeText(delivery.text);
      if (failedAssets.length) handoffEl.open = true;
      if (failedAssets.length) {
        note(`Couldn't complete ${cfg.label} handoff — prompt copied; drag the labeled images above into the chat.`);
      } else if (delivery.assets.length) {
        note(`Images attached, but the prompt was copied — paste it into ${cfg.label}.`);
      } else {
        note(`Couldn't find ${cfg.label}'s input box — prompt copied to the clipboard.`);
      }
    } catch (e) {
      note('Couldn\'t insert or copy automatically — use the "Copy prompt" button.');
    }
  }
}

document.getElementById('to-chatgpt').addEventListener('click', () => sendToChat('chatgpt'));
document.getElementById('to-claude').addEventListener('click', () => sendToChat('claude'));

// ---------- PDF handoff ----------
// Chrome's native PDF viewer exposes no DOM, so capture can't work there;
// offer a one-click reopen in the bundled PDF.js viewer.

const openPdfBtn = document.getElementById('open-pdf');

function looksLikePdf(url) {
  return /\.pdf($|[?#])/i.test(url) || /arxiv\.org\/pdf\//i.test(url);
}

async function updatePdfButton() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const show = !!(tab && tab.url && looksLikePdf(tab.url));
  openPdfBtn.style.display = show ? '' : 'none';
  openPdfBtn.dataset.url = show ? tab.url : '';
}

openPdfBtn.addEventListener('click', () => {
  if (!openPdfBtn.dataset.url) return;
  chrome.tabs.create({ url: viewerLink(openPdfBtn.dataset.url) });
});

chrome.tabs.onActivated.addListener(updatePdfButton);
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.url || info.status === 'complete') updatePdfButton();
});
updatePdfButton();

// Show the actual capture hotkey for this machine (differs per platform, and
// the user may have rebound or lost it to a conflict).
async function updateHotkeyHint() {
  const el = document.getElementById('hotkey');
  const commands = await chrome.commands.getAll();
  const cmd = commands.find((c) => c.name === 'ask-selection');
  el.textContent =
    cmd && cmd.shortcut ? cmd.shortcut : 'no hotkey — set one at chrome://extensions/shortcuts';
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.queue) return;
  if (quietQueueWrites > 0) {
    quietQueueWrites -= 1;
    return;
  }
  render();
});

updateHotkeyHint();
render();
