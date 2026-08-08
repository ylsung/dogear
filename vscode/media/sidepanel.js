// Dogear sidebar (VSCode port of extension/sidepanel.js): queue UI, prompt
// composer, delivery. All chrome.* calls are replaced by a message bridge to
// the extension host (src/panel.ts); rendering, drag-and-drop, grouping, and
// prompt composition are identical to the Chrome side panel.

const vscodeApi = acquireVsCodeApi();

// Apply the global theme (see theme.js) as CSS variables + branded text.
// Lora @font-face is injected by the host HTML (webview resource URIs).
{
  const T = globalThis.DOGEAR_THEME;
  const root = document.documentElement;
  for (const [k, v] of Object.entries(T.colors)) root.style.setProperty(`--${k}`, v);
  root.style.setProperty('--font', T.font.family);
  document.getElementById('brand').textContent = `${T.emoji.dog} Dogear`;
}

const listEl = document.getElementById('list');
const emptyEl = document.getElementById('empty');
const countEl = document.getElementById('count');
const noteEl = document.getElementById('note');

const SOFT_CAP = 10;

// ---------- host bridge ----------
// The host owns the queue (workspaceState); the webview keeps a local cache,
// mutates it optimistically, and posts the whole queue back to persist. The
// host echoes a fresh `state` after every change (its role matches
// chrome.storage.onChanged in the Chrome version).

let queueCache = [];
let assetPreviews = {};
let requestSequence = 0;
const pendingRequests = new Map();

async function getQueue() {
  return queueCache;
}

async function setQueue(queue) {
  queueCache = queue;
  vscodeApi.postMessage({ type: 'save', queue });
  render();
}

window.addEventListener('message', (e) => {
  const msg = e.data;
  if (msg.type === 'state') {
    queueCache = msg.queue;
    assetPreviews = msg.assets || {};
    if (msg.promptLang && globalThis.DOGEAR_PROMPTS[msg.promptLang]) {
      promptLang = msg.promptLang;
      langSelect.value = promptLang;
    }
    document.getElementById('hotkey').textContent = msg.hotkeyHint;
    render();
  } else if (msg.type === 'response') {
    const pending = pendingRequests.get(msg.requestId);
    if (!pending) return;
    pendingRequests.delete(msg.requestId);
    if (msg.error) pending.reject(new Error(msg.error));
    else pending.resolve(msg.result);
  } else if (msg.type === 'compose') {
    openCaptureComposer(msg.title);
  } else if (msg.type === 'note') {
    note(msg.msg);
  }
});

function note(msg) {
  noteEl.textContent = msg;
  setTimeout(() => {
    if (noteEl.textContent === msg) noteEl.textContent = '';
  }, 4000);
}

function requestHost(type, payload = {}) {
  const requestId = `request-${Date.now()}-${++requestSequence}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error('Dogear timed out while storing the image.'));
    }, 30000);
    pendingRequests.set(requestId, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    vscodeApi.postMessage({ type, requestId, ...payload });
  });
}

async function fileBase64(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
  }
  return btoa(chunks.join(''));
}

// ---------- capture composer ----------

const captureSection = document.getElementById('capture-composer');
const captureTitle = document.getElementById('capture-title');
const captureImages = document.getElementById('capture-images');
const captureEditorApi = globalThis.DOGEAR_COMPOSER.create(
  document.getElementById('capture-editor'),
  {
    parts: [],
    maxFileSize: 15 * 1024 * 1024,
    resolveAssetUrl: async (assetId) => assetPreviews[assetId],
    storeFile: async (file) => {
      const asset = await requestHost('storeComposerAsset', {
        base64: await fileBase64(file),
        mediaType: file.type,
        displayName: file.name || 'pasted-image.png',
      });
      if (asset.previewUrl) assetPreviews[asset.id] = asset.previewUrl;
      return asset;
    },
    onError: (error) => note(error),
  },
);

async function openCaptureComposer(title) {
  captureTitle.textContent = `Question about ${title}`;
  captureSection.hidden = false;
  await captureEditorApi.setParts([]);
  captureEditorApi.focus();
}

function closeCaptureComposer(submit) {
  const parts = submit ? captureEditorApi.getParts() : undefined;
  captureSection.hidden = true;
  vscodeApi.postMessage({ type: submit ? 'composeSubmit' : 'composeCancel', parts });
}

document.getElementById('capture-add-image').addEventListener('click', () => captureImages.click());
captureImages.addEventListener('change', async () => {
  await captureEditorApi.addFiles(captureImages.files);
  captureImages.value = '';
});
document.getElementById('capture-cancel').addEventListener('click', () => closeCaptureComposer(false));
document.getElementById('capture-submit').addEventListener('click', () => closeCaptureComposer(true));
document.getElementById('capture-editor').addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    closeCaptureComposer(false);
  } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    closeCaptureComposer(true);
  }
});

// ---------- rendering ----------

function truncate(s, n) {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function messageText(item) {
  return (item.message?.parts || [])
    .filter((part) => part.type === 'text')
    .map((part) => part.text || '')
    .join('');
}

function replaceMessageText(item, text) {
  item.message = {
    role: 'user',
    parts: text ? [{ type: 'text', text }] : [],
  };
}

// ---------- selection & drag state ----------

let selectedIds = new Set();
let lastAnchorId = null;
let dragMode = null; // 'card' | 'group' while a drag is in flight
// Groups are identified by rendered block, not URL: the same file can render
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
    if (item.url !== lastUrl) {
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
      src.title = item.url;
      src.href = '#';
      src.draggable = false; // links drag natively and would hijack group drags
      src.addEventListener('click', (e) => {
        e.preventDefault();
        vscodeApi.postMessage({ type: 'openSource', id: item.id });
      });
      const icon = document.createElement('span');
      icon.className = 'favicon';
      icon.textContent = '📄';
      const label = document.createElement('span');
      label.textContent = item.title;
      src.append(icon, label);
      group.appendChild(src);
      listEl.appendChild(group);
      lastUrl = item.url;
    }
    groupBlocks[groupBlocks.length - 1].push(item.id);

    const card = document.createElement('div');
    card.className = 'card';
    card.dataset.id = item.id;
    card.draggable = true;
    if (selectedIds.has(item.id)) card.classList.add('selected');

    card.addEventListener('click', async (e) => {
      if (e.target.closest('textarea, button')) return;
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
    const quote = document.createElement('blockquote');
    quote.textContent = truncate(item.anchor.exact, 220);
    quote.title = item.anchor.exact;
    top.append(num, quote);

    const q = document.createElement('textarea');
    q.placeholder = 'Your query about this selection…';
    q.value = messageText(item);
    q.addEventListener('change', async () => {
      const queueNow = await getQueue();
      const target = queueNow.find((x) => x.id === item.id);
      if (target) {
        replaceMessageText(target, q.value.trim());
        await setQueue(queueNow);
      }
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
      mk('↑', 'Move up', () => move(item.id, -1)),
      mk('↓', 'Move down', () => move(item.id, +1)),
      mk('✕', 'Delete', () => remove(item.id)),
    );

    card.append(top, q, tools);
    group.appendChild(card);
  });
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
  await setQueue(queue.filter((x) => x.id !== id));
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
langSelect.value = promptLang;
langSelect.addEventListener('change', () => {
  promptLang = langSelect.value;
  vscodeApi.postMessage({ type: 'setLang', lang: promptLang });
});

// Privacy (same policy as the Chrome side panel's sourceCitation): the full
// file:// URI reveals the username and folder structure, and the composed
// prompt leaves the machine. The workspace-relative title already identifies
// the file, so local sources are cited as just "local file".
function sourceCitation(item, P) {
  if (/^https?:/i.test(item.url)) return { title: item.title, url: item.url };
  return { title: item.title, url: P.localFile || 'local file' };
}

function composePrompt(queue) {
  const P = globalThis.DOGEAR_PROMPTS[promptLang] || globalThis.DOGEAR_PROMPTS.en;
  const lines = [P.header(queue.length)];

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
    lines.push('', P.excerpt(idx + 1, where, item.anchor.exact));
    if (item.anchor.prefix || item.anchor.suffix) {
      lines.push(P.context(item.anchor.prefix, item.anchor.suffix));
    }
    lines.push(P.question(messageText(item)));
  });

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
  return composePrompt(queue);
}

// ---------- delivery ----------
// Clipboard, sidebar commands, and the confirm dialog all live host-side (webviews
// block window.confirm and may lack clipboard focus).

document.getElementById('copy').addEventListener('click', async () => {
  const prompt = await composeOrWarn();
  if (!prompt) return;
  vscodeApi.postMessage({ type: 'copy', prompt });
});

document.getElementById('to-claude').addEventListener('click', async () => {
  const prompt = await composeOrWarn();
  if (!prompt) return;
  vscodeApi.postMessage({ type: 'send', target: 'claude', prompt });
});

document.getElementById('to-codex').addEventListener('click', async () => {
  const prompt = await composeOrWarn();
  if (!prompt) return;
  vscodeApi.postMessage({ type: 'send', target: 'codex', prompt });
});

document.getElementById('clear').addEventListener('click', () => {
  vscodeApi.postMessage({ type: 'clear' });
});

render();
vscodeApi.postMessage({ type: 'ready' });
