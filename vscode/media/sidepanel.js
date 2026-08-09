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
const handoffEl = document.getElementById('manual-handoff');
const handoffSummaryEl = document.getElementById('manual-summary');
const handoffAssetsEl = document.getElementById('manual-assets');

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
let manualHandoffAssets = [];

async function getQueue() {
  return queueCache;
}

async function setQueue(queue) {
  queueCache = queue;
  vscodeApi.postMessage({ type: 'save', queue });
  render();
}

function saveQueueWithoutRender(queue) {
  queueCache = queue;
  vscodeApi.postMessage({ type: 'save', queue });
}

function queueStructure(queue) {
  return queue.map((item) => item.id).join('\n');
}

window.addEventListener('message', (e) => {
  const msg = e.data;
  if (msg.type === 'state') {
    const structureChanged = queueStructure(queueCache) !== queueStructure(msg.queue);
    if (structureChanged) {
      queueCache = msg.queue;
    } else {
      const localMessages = new Map(queueCache.map((item) => [item.id, item.message]));
      queueCache = msg.queue.map((item) => ({
        ...item,
        message: localMessages.get(item.id) || item.message,
      }));
    }
    assetPreviews = msg.assets || {};
    if (msg.promptLang && globalThis.DOGEAR_PROMPTS[msg.promptLang]) {
      promptLang = msg.promptLang;
      langSelect.value = promptLang;
    }
    document.getElementById('hotkey').textContent = msg.hotkeyHint;
    if (structureChanged || !listEl.querySelector('.group')) render();
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
      const asset = await storeWebviewFile(file);
      return asset;
    },
    onError: (error) => note(error),
  },
);

async function storeWebviewFile(file) {
  const asset = await requestHost('storeAsset', {
        base64: await fileBase64(file),
        mediaType: file.type,
        displayName: file.name || 'pasted-image.png',
      });
  if (asset.previewUrl) assetPreviews[asset.id] = asset.previewUrl;
  return asset;
}

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

// ---------- selection & drag state ----------

let selectedIds = new Set();
let lastAnchorId = null;
let dragMode = null; // 'card' | 'group' while a drag is in flight
// Groups are identified by rendered block, not URL: the same file can render
// as two separate blocks (A, B, A after manual reordering), and those must be
// draggable onto each other. groupBlocks[i] = item ids of the i-th block.
let draggedGroupIdx = -1;
let groupBlocks = [];
let cardEditors = new Map();

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
  cardEditors.forEach((editor) => editor.destroy());
  cardEditors = new Map();
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
      const groupHeader = document.createElement('div');
      groupHeader.className = 'group-header';
      const groupHandle = document.createElement('span');
      groupHandle.className = 'drag-handle group-drag-handle';
      groupHandle.textContent = '⠿';
      groupHandle.title = 'Drag this file group';
      groupHandle.draggable = true;
      groupHandle.addEventListener('dragstart', (e) => {
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
      icon.textContent = item.surface === 'image' ? '🖼️' : '📄';
      const label = document.createElement('span');
      label.textContent = item.title;
      src.append(icon, label);
      groupHeader.append(groupHandle, src);
      group.appendChild(groupHeader);
      listEl.appendChild(group);
      lastUrl = item.url;
    }
    groupBlocks[groupBlocks.length - 1].push(item.id);

    const card = document.createElement('div');
    card.className = 'card';
    card.dataset.id = item.id;
    if (selectedIds.has(item.id)) card.classList.add('selected');

    card.addEventListener('click', async (e) => {
      if (e.target.closest('.dogear-composer, button, input, .drag-handle')) return;
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

    const top = document.createElement('div');
    top.className = 'top';
    const num = document.createElement('span');
    num.className = 'num';
    num.textContent = `Q${idx + 1}`;
    const contextAssets = (item.selectedContext || []).filter((part) => part.type === 'asset');
    if (contextAssets.length) {
      const images = document.createElement('div');
      images.className = 'context-images';
      contextAssets.forEach((part) => {
        const image = document.createElement('img');
        image.src = assetPreviews[part.assetId] || '';
        image.alt = part.label || 'Selected image';
        image.title = part.label || 'Selected image';
        images.appendChild(image);
      });
      top.append(num, images);
    } else {
      const quote = document.createElement('blockquote');
      const selectedText = renderParts(item.selectedContext, new Map()) || item.anchor.exact;
      quote.textContent = truncate(selectedText, 220);
      quote.title = selectedText;
      top.append(num, quote);
    }

    const q = document.createElement('div');
    q.dataset.placeholder = 'Your query about this selection…';
    const editor = globalThis.DOGEAR_COMPOSER.create(q, {
      parts: item.message?.parts || [],
      maxFileSize: 15 * 1024 * 1024,
      resolveAssetUrl: async (assetId) => assetPreviews[assetId],
      storeFile: storeWebviewFile,
      onChange: async (parts) => {
        const queueNow = await getQueue();
        const target = queueNow.find((entry) => entry.id === item.id);
        if (target) {
          target.message = { role: 'user', parts };
          saveQueueWithoutRender(queueNow);
        }
      },
      onError: (error) => note(error),
    });
    cardEditors.set(item.id, editor);

    const attachInput = document.createElement('input');
    attachInput.type = 'file';
    attachInput.accept = 'image/*';
    attachInput.multiple = true;
    attachInput.hidden = true;
    attachInput.addEventListener('change', async () => {
      await editor.addFiles(attachInput.files);
      attachInput.value = '';
    });

    q.addEventListener('blur', async () => {
      const queueNow = await getQueue();
      const target = queueNow.find((x) => x.id === item.id);
      if (target) {
        target.message = { role: 'user', parts: editor.getParts() };
        saveQueueWithoutRender(queueNow);
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
    const cardHandle = document.createElement('span');
    cardHandle.className = 'drag-handle card-drag-handle';
    cardHandle.textContent = '⠿';
    cardHandle.title = 'Drag this question';
    cardHandle.draggable = true;
    cardHandle.addEventListener('dragstart', (e) => {
      e.stopPropagation();
      dragMode = 'card';
      if (!selectedIds.has(item.id)) {
        selectedIds = new Set([item.id]);
        applySelectionClasses();
      }
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', item.id);
    });
    tools.append(
      cardHandle,
      mk('＋ Image', 'Attach one or more images', () => attachInput.click()),
      mk('↑', 'Move up', () => move(item.id, -1)),
      mk('↓', 'Move down', () => move(item.id, +1)),
      mk('✕', 'Delete', () => remove(item.id)),
    );

    card.append(top, q, attachInput, tools);
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

function renderManualHandoff() {
  const assets = manualHandoffAssets;
  handoffEl.hidden = !assets.length;
  handoffAssetsEl.replaceChildren();
  if (!assets.length) return;

  handoffSummaryEl.textContent = `Manual handoff · ${assets.length} ${assets.length === 1 ? 'image' : 'images'}`;
  const attachAll = document.createElement('button');
  attachAll.className = 'handoff-all';
  attachAll.textContent = 'Attach all images to this chat';
  attachAll.addEventListener('click', async () => {
    attachAll.disabled = true;
    try {
      const result = await requestHost('attachAssets', {
        assetIds: assets.map((asset) => asset.id),
      });
      if (result.unavailable) {
        note('This chat does not expose an image attachment command. Use the local paths in the copied prompt.');
      } else {
        const attached = (result.attachedIds || []).length;
        const failed = assets.length - attached;
        note(failed
          ? `${attached} attached; ${failed} ${failed === 1 ? 'image' : 'images'} could not be attached.`
          : `${attached} ${attached === 1 ? 'image' : 'images'} attached. You can attach them again after switching chats.`);
      }
    } catch (error) {
      note(error.message || 'Could not attach images to this chat.');
    } finally {
      attachAll.disabled = false;
    }
  });
  handoffAssetsEl.appendChild(attachAll);

  assets.forEach((asset) => {
    const row = document.createElement('div');
    row.className = 'handoff-asset';
    const img = document.createElement('img');
    img.src = assetPreviews[asset.id] || '';
    img.alt = '';
    const label = document.createElement('span');
    label.textContent = `${asset.label} · ${asset.deliveredName}`;
    label.title = asset.deliveredName;
    row.append(img, label);
    handoffAssetsEl.appendChild(row);
  });
}

function showManualHandoff(assets) {
  manualHandoffAssets = assets;
  renderManualHandoff();
  handoffEl.open = true;
}

function renderParts(parts, labels) {
  return (parts || []).map((part) =>
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

async function composeOrWarn() {
  const queue = await getQueue();
  if (!queue.length) {
    note('Queue is empty.');
    return null;
  }
  if (queue.length > SOFT_CAP) {
    note(`Heads up: ${queue.length} queries in one prompt may dilute answer quality.`);
  }
  const assets = buildAssetPlan(queue);
  return { text: composePrompt(queue, assets), assets };
}

// ---------- delivery ----------
// Clipboard, sidebar commands, and the confirm dialog all live host-side (webviews
// block window.confirm and may lack clipboard focus).

document.getElementById('copy').addEventListener('click', async () => {
  const prompt = await composeOrWarn();
  if (!prompt) return;
  showManualHandoff(prompt.assets);
  vscodeApi.postMessage({
    type: 'copy',
    prompt: prompt.text,
    assetIds: prompt.assets.map((asset) => asset.id),
  });
});

document.getElementById('to-claude').addEventListener('click', async () => {
  const prompt = await composeOrWarn();
  if (!prompt) return;
  showManualHandoff(prompt.assets);
  vscodeApi.postMessage({
    type: 'send',
    target: 'claude',
    prompt: prompt.text,
    assetIds: prompt.assets.map((asset) => asset.id),
  });
});

document.getElementById('to-codex').addEventListener('click', async () => {
  const prompt = await composeOrWarn();
  if (!prompt) return;
  showManualHandoff(prompt.assets);
  vscodeApi.postMessage({
    type: 'send',
    target: 'codex',
    prompt: prompt.text,
    assetIds: prompt.assets.map((asset) => asset.id),
  });
});

document.getElementById('ask-tab').addEventListener('click', () => {
  vscodeApi.postMessage({ type: 'askTab' });
});

document.getElementById('capture-screenshot').addEventListener('click', () => {
  vscodeApi.postMessage({ type: 'captureScreenshot' });
});

document.getElementById('clear').addEventListener('click', () => {
  vscodeApi.postMessage({ type: 'clear' });
});

render();
vscodeApi.postMessage({ type: 'ready' });
