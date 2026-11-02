// Dogear side panel: queue UI, prompt composer, delivery (clipboard / chat injection).

// Apply the global theme (see theme.js) as CSS variables + branded text.
{
  const T = globalThis.DOGEAR_THEME;
  const palette = globalThis.DOGEAR_THEME_CSS(':root', `--font: ${T.font.family};`);
  const faces = (T.font.faces || [])
    .map(
      (f) =>
        `@font-face { font-family: '${f.family}'; font-weight: ${f.weight}; ` +
        `font-style: normal; font-display: swap; ` +
        `src: url('${chrome.runtime.getURL(f.file)}') format('woff2'); }`,
    )
    .join('\n');
  const s = document.createElement('style');
  s.textContent = `${palette}
${faces}`;
  document.head.appendChild(s);
  document.getElementById('open-pdf').textContent =
    `${T.emoji.pdf} Open this PDF in Dogear viewer`;
  // Pages without a content script (chrome://, the Web Store) still get a
  // toolbar icon that matches the browser's light/dark mode.
  const darkQuery = matchMedia('(prefers-color-scheme: dark)');
  const reportScheme = () =>
    chrome.runtime
      .sendMessage({ type: 'dogear-color-scheme', dark: darkQuery.matches })
      .catch(() => {});
  reportScheme();
  darkQuery.addEventListener('change', reportScheme);
}

// Appearance setting (Options page): "system" leaves the OS preference in charge.
function applyAppearance(appearance) {
  if (appearance === 'light' || appearance === 'dark') document.documentElement.dataset.theme = appearance;
  else delete document.documentElement.dataset.theme;
}
chrome.storage.local.get('appearance').then(({ appearance }) => applyAppearance(appearance));

const listEl = document.getElementById('list');
const emptyEl = document.getElementById('empty');
const countEl = document.getElementById('count');
const noteEl = document.getElementById('note');
const M = globalThis.DOGEAR_MODEL;
const ASSETS = globalThis.DOGEAR_ASSETS;
const COMPOSER = globalThis.DOGEAR_COMPOSER;
const ACTIONS = globalThis.DOGEAR_ACTIONS;
const handoffEl = document.getElementById('manual-handoff');
const handoffSummaryEl = document.getElementById('manual-summary');
const handoffAssetsEl = document.getElementById('manual-assets');
const liveObjectUrls = [];
const handoffObjectUrls = [];
const liveComposers = [];
const pendingQuietQueueWrites = new Map();
let renderRequested = false;
let renderRunning = false;
let manualHandoffRenderVersion = 0;

const QUESTION_HISTORY_LIMIT = 5;
const questionUndoStack = [];
const questionRedoStack = [];
let questionHistoryMutation = Promise.resolve();

async function getQueue() {
  const { queue = [] } = await chrome.storage.local.get('queue');
  return queue.map(M.normalizeItem);
}

async function setQueue(queue) {
  await chrome.storage.local.set({ queue });
}

function queueFingerprint(queue) {
  return JSON.stringify(queue || []);
}

function queueOrderFingerprint(queue) {
  return JSON.stringify((queue || []).map((item) => item.id));
}

function consumeQuietQueueWrite(fingerprint) {
  const count = pendingQuietQueueWrites.get(fingerprint) || 0;
  if (!count) return false;
  if (count === 1) pendingQuietQueueWrites.delete(fingerprint);
  else pendingQuietQueueWrites.set(fingerprint, count - 1);
  return true;
}

async function setQueueQuietly(queue) {
  const fingerprint = queueFingerprint(queue);
  pendingQuietQueueWrites.set(fingerprint, (pendingQuietQueueWrites.get(fingerprint) || 0) + 1);
  try {
    await chrome.storage.local.set({ queue });
  } catch (error) {
    consumeQuietQueueWrite(fingerprint);
    throw error;
  }
}

async function collectGarbage(queue, retainedAssetIds = []) {
  const questionHistoryAssetIds = [...questionUndoStack, ...questionRedoStack]
    .flatMap((action) => M.assetIdsOf(action.item));
  const referenced = [
    ...queue.flatMap(M.assetIdsOf),
    ...retainedAssetIds,
    ...questionHistoryAssetIds,
    ...(await ACTIONS.clearedAssetIds()),
  ];
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
      const sourceHeader = document.createElement('div');
      sourceHeader.className = 'source-header';
      const groupDragHandle = document.createElement('span');
      groupDragHandle.className = 'drag-handle group-drag-handle';
      groupDragHandle.draggable = true;
      groupDragHandle.role = 'button';
      groupDragHandle.tabIndex = 0;
      groupDragHandle.title = 'Drag to reorder this source group';
      groupDragHandle.textContent = '⋮⋮';
      groupDragHandle.addEventListener('dragstart', (e) => {
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
      sourceHeader.append(src, groupDragHandle);
      group.appendChild(sourceHeader);
      listEl.appendChild(group);
      lastUrl = sourceInfo.url;
    }
    groupBlocks[groupBlocks.length - 1].push(item.id);

    const card = document.createElement('div');
    card.className = 'card';
    card.dataset.id = item.id;
    if (selectedIds.has(item.id)) card.classList.add('selected');

    card.addEventListener('click', async (e) => {
      if (e.target.closest('.dogear-composer, blockquote, .context-images, textarea, input, button, a')) return;
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
    const contextText = M.textOf(item.selectedContext.flatMap((context) => context.parts));
    if (contextText) {
      const quote = document.createElement('blockquote');
      quote.textContent = truncate(contextText, 220);
      quote.title = contextText;
      top.append(num, quote);
    } else if (locator.type !== 'unanchored') {
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
    } else {
      const pageContext = document.createElement('span');
      pageContext.className = 'page-context';
      pageContext.textContent = 'Whole page';
      top.append(num, pageContext);
    }

    const q = document.createElement('div');
    q.dataset.placeholder = 'Type a question, paste an image, or drop one here…';
    let draftParts = item.message.parts;
    let saveDraftChain = Promise.resolve();
    const undoRetainedAssetIds = new Set();
    const saveDraft = (parts) => {
      const snapshot = M.coalesceParts(parts);
      saveDraftChain = saveDraftChain.catch(() => {}).then(async () => {
        const queueNow = await getQueue();
        const target = queueNow.find((x) => x.id === item.id);
        if (target) {
          target.message = { role: 'user', parts: snapshot };
          await setQueueQuietly(queueNow);
          await collectGarbage(queueNow, undoRetainedAssetIds);
        }
      });
      return saveDraftChain;
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
        const previousAssetIds = new Set(
          draftParts.filter((part) => part.type === 'asset').map((part) => part.assetId),
        );
        const nextAssetIds = new Set(
          parts.filter((part) => part.type === 'asset').map((part) => part.assetId),
        );
        for (const id of previousAssetIds) {
          if (!nextAssetIds.has(id)) undoRetainedAssetIds.add(id);
        }
        for (const id of nextAssetIds) undoRetainedAssetIds.delete(id);
        draftParts = parts;
        if (reason === 'asset') return saveDraft(parts);
      },
      onBlur: (parts, event) => {
        draftParts = parts;
        if (event.relatedTarget instanceof Node && card.contains(event.relatedTarget)) return;
        return saveDraft(parts);
      },
      onDestroy: () => {
        if (!undoRetainedAssetIds.size) return;
        undoRetainedAssetIds.clear();
        getQueue().then(collectGarbage);
      },
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
    const cardDragHandle = document.createElement('span');
    cardDragHandle.className = 'drag-handle card-drag-handle';
    cardDragHandle.draggable = true;
    cardDragHandle.role = 'button';
    cardDragHandle.tabIndex = 0;
    cardDragHandle.title = 'Drag to reorder this question';
    cardDragHandle.textContent = '⋮⋮';
    cardDragHandle.addEventListener('dragstart', (e) => {
      e.stopPropagation();
      dragMode = 'card';
      if (!selectedIds.has(item.id)) {
        selectedIds = new Set([item.id]);
        applySelectionClasses();
      }
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', item.id);
    });
    const mk = (label, title, fn) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.title = title;
      b.addEventListener('click', fn);
      return b;
    };
    tools.append(
      cardDragHandle,
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

async function scheduleRender() {
  renderRequested = true;
  if (renderRunning) return;
  renderRunning = true;
  try {
    while (renderRequested) {
      renderRequested = false;
      await render();
    }
  } finally {
    renderRunning = false;
    if (renderRequested) scheduleRender();
  }
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
  const index = queue.findIndex((item) => item.id === id);
  if (index === -1) return;
  const [item] = queue.splice(index, 1);
  questionUndoStack.push({ item, index });
  if (questionUndoStack.length > QUESTION_HISTORY_LIMIT) questionUndoStack.shift();
  questionRedoStack.length = 0;
  const next = queue;
  await setQueue(next);
  await collectGarbage(next);
  note('Question deleted — press Command/Ctrl+Z to restore it.');
}

async function applyQuestionHistory(redo) {
  const from = redo ? questionRedoStack : questionUndoStack;
  if (!from.length) return false;
  const action = from.pop();
  const queue = await getQueue();
  if (redo) {
    const index = queue.findIndex((item) => item.id === action.item.id);
    if (index !== -1) queue.splice(index, 1);
    questionUndoStack.push(action);
  } else {
    if (!queue.some((item) => item.id === action.item.id)) {
      queue.splice(Math.min(action.index, queue.length), 0, action.item);
    }
    questionRedoStack.push(action);
  }
  await setQueue(queue);
  await collectGarbage(queue);
  note(redo ? 'Question deleted again.' : 'Question restored.');
  return true;
}

function queueQuestionHistory(redo) {
  questionHistoryMutation = questionHistoryMutation.then(() => applyQuestionHistory(redo));
  return questionHistoryMutation;
}

document.addEventListener('keydown', (event) => {
  if (event.defaultPrevented || !(event.metaKey || event.ctrlKey) || event.altKey) return;
  if (event.key.toLowerCase() !== 'z') return;
  const target = event.target;
  if (target instanceof Element &&
      (target.closest('.dogear-composer, input, textarea, select') || target.isContentEditable)) return;
  const stack = event.shiftKey ? questionRedoStack : questionUndoStack;
  if (stack.length) {
    event.preventDefault();
    queueQuestionHistory(event.shiftKey);
  } else if (!event.shiftKey) {
    // Nothing left to restore one by one: undo a recent Clear instead.
    event.preventDefault();
    questionHistoryMutation = questionHistoryMutation.then(async () => {
      const restored = await ACTIONS.undoClear();
      if (restored) note(`Restored ${restored} ${restored === 1 ? 'question' : 'questions'}.`);
    });
  }
});

// ---------- prompt composition ----------
// Composition itself lives in actions.js, shared with the hotkey export popup.

let promptLang = globalThis.DOGEAR_PROMPT_DEFAULT_LANG;

const langSelect = document.getElementById('lang');
for (const [code, pack] of Object.entries(globalThis.DOGEAR_PROMPTS)) {
  const opt = document.createElement('option');
  opt.value = code;
  opt.textContent = pack.name;
  langSelect.appendChild(opt);
}
ACTIONS.getPromptLang().then((lang) => {
  promptLang = lang;
  langSelect.value = promptLang;
});
langSelect.addEventListener('change', () => {
  promptLang = langSelect.value;
  chrome.storage.local.set({ promptLang });
});

async function composeOrWarn() {
  const delivery = await ACTIONS.compose(promptLang);
  if (delivery.error) {
    note(delivery.error);
    return null;
  }
  if (delivery.warning) note(delivery.warning);
  return delivery;
}

async function renderManualHandoff(queue) {
  const version = ++manualHandoffRenderVersion;
  const assets = await ACTIONS.buildAssetPlan(queue);
  if (version !== manualHandoffRenderVersion) return;
  handoffObjectUrls.splice(0).forEach((url) => URL.revokeObjectURL(url));
  handoffAssetsEl.replaceChildren();
  handoffEl.hidden = !assets.length;
  if (!assets.length) return;
  handoffSummaryEl.textContent = `Manual handoff · ${assets.length} ${assets.length === 1 ? 'image' : 'images'}`;

  const all = document.createElement('button');
  all.type = 'button';
  all.className = 'handoff-all';
  all.title = `Attach all ${assets.length} images to the active tab`;
  all.textContent = `▦ Attach all ${assets.length} ${assets.length === 1 ? 'image' : 'images'} to this tab`;
  all.addEventListener('click', async () => {
    all.disabled = true;
    await attachAssetsToCurrentTab(assets);
    all.disabled = false;
  });
  handoffAssetsEl.appendChild(all);

  for (const asset of assets) {
    const row = document.createElement('div');
    row.className = 'handoff-asset';
    const url = URL.createObjectURL(asset.record.blob);
    handoffObjectUrls.push(url);
    const img = document.createElement('img');
    img.src = url;
    img.alt = '';
    const label = document.createElement('span');
    label.textContent = `${asset.label} · ${asset.deliveredName}`;
    const tools = document.createElement('div');
    tools.className = 'handoff-tools';
    const attach = document.createElement('button');
    attach.type = 'button';
    attach.textContent = 'Attach';
    attach.title = 'Attach this image to the active tab';
    attach.addEventListener('click', async () => {
      attach.disabled = true;
      await attachAssetsToCurrentTab([asset]);
      attach.disabled = false;
    });
    const download = document.createElement('button');
    download.type = 'button';
    download.textContent = 'Save';
    download.title = 'Save this image if the destination uploader is not accessible';
    download.addEventListener('click', () => {
      const link = document.createElement('a');
      link.href = url;
      link.download = asset.deliveredName;
      link.click();
    });
    tools.append(attach, download);
    row.append(img, label, tools);
    handoffAssetsEl.appendChild(row);
  }
}

// ---------- delivery ----------

document.getElementById('copy').addEventListener('click', async () => {
  const delivery = await composeOrWarn();
  if (!delivery) return;
  chrome.storage.local.set({ lastExportTarget: 'copy' });
  await navigator.clipboard.writeText(delivery.text);
  if (delivery.assets.length) handoffEl.open = true;
  note(ACTIONS.copyNote(delivery));
});

// No confirmation: Clear is undoable (Command/Ctrl+Z here, or Undo in the
// page toast when cleared by hotkey), which keeps it a one-keystroke action.
document.getElementById('clear').addEventListener('click', async () => {
  questionUndoStack.length = 0;
  questionRedoStack.length = 0;
  const cleared = await ACTIONS.clearQueue();
  if (!cleared) return;
  note(`Cleared ${cleared} ${cleared === 1 ? 'question' : 'questions'} — press Command/Ctrl+Z to restore.`);
});

document.getElementById('settings').addEventListener('click', () => chrome.runtime.openOptionsPage());

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

document.getElementById('ask-page').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'dogear-open-page-ask' }, { frameId: 0 });
    await chrome.windows.update(tab.windowId, { focused: true });
    await chrome.tabs.update(tab.id, { active: true });
  } catch (_) {
    note('Dogear cannot ask about this browser page.');
  }
});

async function attachAssetsToCurrentTab(assets) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const outcome = await ACTIONS.attachAssetsToTab(tab, assets);
  if (outcome.ok) {
    note(`Attached ${assets.length} ${assets.length === 1 ? 'image' : 'images'}. You can attach them again after switching chats.`);
  } else {
    note('Could not find an image uploader in this tab. Open its attachment menu and try again, or use Save.');
  }
  return outcome.ok;
}

async function sendToChat(kind) {
  const delivery = await composeOrWarn();
  if (!delivery) return;
  chrome.storage.local.set({ lastExportTarget: kind });
  const outcome = await ACTIONS.deliverToChat(kind, delivery);
  let copied = true;
  if (outcome.status === 'copy') {
    try {
      await navigator.clipboard.writeText(delivery.text);
    } catch (e) {
      copied = false;
    }
  }
  if (outcome.imagesFailed && copied) handoffEl.open = true;
  note(ACTIONS.chatNote(outcome, delivery, copied));
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

// Show the actual hotkeys for this machine (differs per platform, and the
// user may have rebound or lost them to a conflict).
async function updateHotkeyHint() {
  const commands = await chrome.commands.getAll();
  const shortcut = (name) => commands.find((c) => c.name === name)?.shortcut || '';
  document.getElementById('hotkey').textContent =
    shortcut('ask-selection') || 'no hotkey — set one in Settings';
  const rest = [['export-prompt', 'export'], ['clear-queue', 'clear']]
    .filter(([name]) => shortcut(name))
    .map(([name, label]) => `${shortcut(name)} to ${label}`);
  document.getElementById('more-hotkeys').textContent = rest.length ? ` ${rest.join(', ')}.` : '';
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.appearance) applyAppearance(changes.appearance.newValue);
  if (area === 'local' && changes.promptLang && globalThis.DOGEAR_PROMPTS[changes.promptLang.newValue]) {
    promptLang = changes.promptLang.newValue;
    langSelect.value = promptLang;
  }
  if (area === 'local' && changes.queue) {
    const sameQuestionOrder =
      queueOrderFingerprint(changes.queue.oldValue) === queueOrderFingerprint(changes.queue.newValue);
    if (sameQuestionOrder) {
      consumeQuietQueueWrite(queueFingerprint(changes.queue.newValue));
      getQueue().then(renderManualHandoff);
      return;
    }
    scheduleRender();
  }
});

updateHotkeyHint();
scheduleRender();
