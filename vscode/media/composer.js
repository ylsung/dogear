// Small dependency-free editor for ordered text + asset parts. Attachments are
// non-editable chips in a contenteditable surface, so their position relative
// to the surrounding text is preserved without exposing local file paths.

(() => {
  const M = globalThis.DOGEAR_MODEL;
  const HISTORY_LIMIT = 5;
  const GROUP_WINDOW_MS = 750;

  function childParts(node) {
    const parts = [];
    let previousWasBlock = false;
    const appendNewline = () => {
      const last = parts[parts.length - 1];
      if (last?.type !== 'text' || !last.text.endsWith('\n')) parts.push(M.textPart('\n'));
    };
    for (const child of node.childNodes) {
      const isBlock = child.nodeType === Node.ELEMENT_NODE && /^(DIV|P)$/.test(child.tagName);
      if (parts.length && (isBlock || previousWasBlock)) appendNewline();
      if (child.nodeType === Node.TEXT_NODE) {
        parts.push(M.textPart(child.data));
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        if (child.dataset?.assetId) {
          parts.push(M.assetPart(
            child.dataset.assetId,
            child.dataset.mediaType,
            child.dataset.label,
          ));
        } else if (child.tagName === 'BR') {
          parts.push(M.textPart('\n'));
        } else {
          parts.push(...childParts(child));
        }
      }
      previousWasBlock = isBlock;
    }
    return M.coalesceParts(parts);
  }

  function selectionRangeWithin(root) {
    const selection = root.getRootNode().getSelection?.() || window.getSelection();
    if (!selection || !selection.rangeCount) return null;
    const range = selection.getRangeAt(0);
    return root.contains(range.commonAncestorContainer) ? range.cloneRange() : null;
  }

  function placeCaretAfter(node) {
    const range = document.createRange();
    range.setStartAfter(node);
    range.collapse(true);
    const selection = node.getRootNode().getSelection?.() || window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function caretRangeFromPointWithin(root, x, y) {
    const treeRoot = root.getRootNode();
    const legacyRange = treeRoot.caretRangeFromPoint?.(x, y);
    if (legacyRange && root.contains(legacyRange.commonAncestorContainer)) return legacyRange;
    const shadowRoots = treeRoot instanceof ShadowRoot ? { shadowRoots: [treeRoot] } : undefined;
    const position = document.caretPositionFromPoint?.(x, y, shadowRoots);
    if (position && root.contains(position.offsetNode)) {
      const range = document.createRange();
      range.setStart(position.offsetNode, position.offset);
      range.collapse(true);
      return range;
    }
    const range = treeRoot === document ? null : document.caretRangeFromPoint?.(x, y);
    return range && root.contains(range.commonAncestorContainer) ? range : null;
  }

  function create(root, options = {}) {
    root.classList.add('dogear-composer');
    root.contentEditable = 'true';
    root.setAttribute('role', 'textbox');
    root.setAttribute('aria-multiline', 'true');
    let lastRange = null;
    let objectUrls = [];
    let draggedChip = null;
    let fileMutation = Promise.resolve();
    let partsRenderVersion = 0;
    let undoStack = [];
    let redoStack = [];
    let pendingInput = null;
    let draggedBeforeParts = null;
    let historyMutation = Promise.resolve();
    let pendingDropRange = null;
    let pendingDragPoint = null;
    let dragFrame = 0;
    const dropCaret = document.createElement('span');
    dropCaret.className = 'dogear-inline-drop-caret';
    dropCaret.contentEditable = 'false';
    dropCaret.setAttribute('aria-hidden', 'true');

    function revokeObjectUrls() {
      objectUrls.forEach((url) => URL.revokeObjectURL(url));
      objectUrls = [];
    }

    async function makeChip(part, urlBucket = objectUrls) {
      const chip = document.createElement('span');
      chip.className = 'dogear-asset-chip';
      chip.contentEditable = 'false';
      chip.dataset.assetId = part.assetId;
      chip.dataset.mediaType = part.mediaType || 'application/octet-stream';
      chip.dataset.label = part.label || 'image';
      const displayName = part.label || 'Attached image';
      chip.title = displayName;
      chip.setAttribute('aria-label', displayName);
      chip.draggable = true;

      const preview = document.createElement('img');
      preview.alt = '';
      preview.title = displayName;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'dogear-remove-asset';
      remove.title = `Remove ${part.label || 'image'}`;
      remove.setAttribute('aria-label', remove.title);
      remove.textContent = '×';
      chip.append(preview, remove);

      if (options.resolveAssetUrl) {
        try {
          const url = await options.resolveAssetUrl(part.assetId);
          if (url) {
            preview.src = url;
            urlBucket.push(url);
          }
        } catch (_) {
          preview.style.display = 'none';
        }
      }
      return chip;
    }

    async function setParts(parts, preserveHistory = false) {
      if (!preserveHistory) {
        undoStack = [];
        redoStack = [];
        pendingInput = null;
      }
      const version = ++partsRenderVersion;
      const nextObjectUrls = [];
      const fragment = document.createDocumentFragment();
      for (const part of M.coalesceParts(parts)) {
        if (part.type === 'text') fragment.appendChild(document.createTextNode(part.text));
        else fragment.appendChild(await makeChip(part, nextObjectUrls));
      }
      if (!fragment.childNodes.length) fragment.appendChild(document.createElement('br'));
      if (version !== partsRenderVersion) {
        nextObjectUrls.forEach((url) => URL.revokeObjectURL(url));
        return;
      }
      // Swap only after every asynchronous preview lookup finishes. Exposing a
      // half-built editor allowed a quick edit to save only the chips rendered
      // so far and made cleanup delete the remaining assets.
      revokeObjectUrls();
      objectUrls = nextObjectUrls;
      root.replaceChildren(fragment);
    }

    function getParts() {
      return childParts(root);
    }

    function snapshot(parts) {
      return M.coalesceParts(parts).map((part) => ({ ...part }));
    }

    function sameParts(a, b) {
      return JSON.stringify(a) === JSON.stringify(b);
    }

    function recordHistory(beforeParts, afterParts, kind) {
      const before = snapshot(beforeParts);
      const after = snapshot(afterParts);
      if (sameParts(before, after)) return;
      const now = Date.now();
      const last = undoStack[undoStack.length - 1];
      const groupable = ['insertText', 'deleteContentBackward', 'deleteContentForward'].includes(kind);
      if (groupable && last?.kind === kind && now - last.at <= GROUP_WINDOW_MS) {
        last.after = after;
        last.at = now;
      } else {
        undoStack.push({ before, after, kind, at: now });
        if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
      }
      redoStack = [];
    }

    async function applyHistory(redo) {
      const from = redo ? redoStack : undoStack;
      if (!from.length) return false;
      const action = from.pop();
      const parts = redo ? action.after : action.before;
      (redo ? undoStack : redoStack).push(action);
      await setParts(parts, true);
      root.focus();
      await options.onChange?.(getParts(), 'history');
      return true;
    }

    function queueHistory(redo) {
      historyMutation = historyMutation.then(() => applyHistory(redo));
      return historyMutation;
    }

    function clearDropCaret() {
      dropCaret.remove();
      pendingDropRange = null;
    }

    function sameRange(a, b) {
      return a && b && a.startContainer === b.startContainer && a.startOffset === b.startOffset;
    }

    function caretRect(range) {
      const collapsedRect = range.getBoundingClientRect();
      if (collapsedRect.height) return collapsedRect;
      const container = range.startContainer;
      const offset = range.startOffset;
      const probe = range.cloneRange();
      if (container.nodeType === Node.TEXT_NODE && container.data.length) {
        if (offset < container.data.length) {
          probe.setEnd(container, offset + 1);
          const rect = probe.getBoundingClientRect();
          return { left: rect.left, top: rect.top, height: rect.height };
        }
        probe.setStart(container, offset - 1);
        const rect = probe.getBoundingClientRect();
        return { left: rect.right, top: rect.top, height: rect.height };
      }
      const child = container.childNodes?.[offset] || container.childNodes?.[offset - 1];
      const rect = child?.getBoundingClientRect?.() || root.getBoundingClientRect();
      return {
        left: container.childNodes?.[offset] ? rect.left : rect.right,
        top: rect.top,
        height: rect.height || parseFloat(getComputedStyle(root).lineHeight) || 16,
      };
    }

    function showDropCaret(range, rect = caretRect(range)) {
      if (!sameRange(pendingDropRange, range)) pendingDropRange = range.cloneRange();
      const treeRoot = root.getRootNode();
      const overlayParent = treeRoot.nodeType === Node.DOCUMENT_NODE ? treeRoot.body : treeRoot;
      if (dropCaret.parentNode !== overlayParent) overlayParent.appendChild(dropCaret);
      const left = `${rect.left}px`;
      const top = `${rect.top}px`;
      const height = `${rect.height || 16}px`;
      if (dropCaret.style.left !== left) dropCaret.style.left = left;
      if (dropCaret.style.top !== top) dropCaret.style.top = top;
      if (dropCaret.style.height !== height) dropCaret.style.height = height;
    }

    function placeDropCaret(point) {
      const targetChip = point.target.closest?.('.dogear-asset-chip');
      if (targetChip && root.contains(targetChip)) {
        const rect = targetChip.getBoundingClientRect();
        const before = point.clientX < rect.left + rect.width / 2;
        const range = document.createRange();
        if (before) range.setStartBefore(targetChip);
        else range.setStartAfter(targetChip);
        range.collapse(true);
        showDropCaret(range, {
          left: before ? rect.left : rect.right,
          top: rect.top,
          height: rect.height,
        });
        return true;
      }
      const range = caretRangeFromPointWithin(root, point.clientX, point.clientY);
      if (range) {
        const containingChip = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
          ? range.commonAncestorContainer.closest?.('.dogear-asset-chip')
          : range.commonAncestorContainer.parentElement?.closest?.('.dogear-asset-chip');
        if (containingChip) {
          const rect = containingChip.getBoundingClientRect();
          const before = point.clientX < rect.left + rect.width / 2;
          if (before) range.setStartBefore(containingChip);
          else range.setStartAfter(containingChip);
          range.collapse(true);
          showDropCaret(range, {
            left: before ? rect.left : rect.right,
            top: rect.top,
            height: rect.height,
          });
          return true;
        }
        showDropCaret(range);
        return true;
      }
      const end = document.createRange();
      end.selectNodeContents(root);
      end.collapse(false);
      showDropCaret(end);
      return true;
    }

    function scheduleDropCaret(event) {
      pendingDragPoint = {
        target: event.target,
        clientX: event.clientX,
        clientY: event.clientY,
      };
      if (dragFrame) return;
      dragFrame = requestAnimationFrame(() => {
        dragFrame = 0;
        const point = pendingDragPoint;
        pendingDragPoint = null;
        if (draggedChip && point) placeDropCaret(point);
      });
    }

    function cancelDropCaretFrame() {
      if (dragFrame) cancelAnimationFrame(dragFrame);
      dragFrame = 0;
      pendingDragPoint = null;
    }

    function rememberRange() {
      lastRange = selectionRangeWithin(root) || lastRange;
    }

    async function insertAsset(asset, range = lastRange) {
      const part = M.assetPart(asset.id, asset.mimeType, asset.displayName);
      const chip = await makeChip(part);
      if (range && root.contains(range.commonAncestorContainer)) {
        range.deleteContents();
        range.insertNode(chip);
      } else {
        root.appendChild(chip);
      }
      placeCaretAfter(chip);
      lastRange = selectionRangeWithin(root);
    }

    async function addFilesNow(images, range) {
      const before = getParts();
      let inserted = 0;
      for (const file of images) {
        if (options.maxFileSize && file.size > options.maxFileSize) {
          options.onError?.(`${file.name || 'Image'} is too large.`);
          continue;
        }
        try {
          const asset = await options.storeFile(file);
          await insertAsset(asset, range);
          range = selectionRangeWithin(root);
          inserted += 1;
        } catch (error) {
          options.onError?.(error.message || 'Could not attach image.');
        }
      }
      // Persist the complete batch before callers are allowed to start another
      // file mutation. Saving after each chip let partial-question garbage
      // collection delete a later image that had been stored but not referenced.
      if (inserted) {
        const after = getParts();
        recordHistory(before, after, 'asset-add');
        await options.onChange?.(after, 'asset');
      }
    }

    function addFiles(files, range = lastRange) {
      const images = [...files].filter((file) => file.type.startsWith('image/'));
      const insertionRange = range?.cloneRange?.() || range;
      fileMutation = fileMutation
        .then(() => addFilesNow(images, insertionRange))
        .catch((error) => options.onError?.(error.message || 'Could not attach image.'));
      return fileMutation;
    }

    root.addEventListener('selectionchange', rememberRange);
    root.addEventListener('keyup', rememberRange);
    root.addEventListener('mouseup', rememberRange);
    root.addEventListener('input', (event) => {
      const after = getParts();
      if (pendingInput) recordHistory(pendingInput.before, after, pendingInput.kind);
      pendingInput = null;
      options.onChange?.(after, 'input');
    });
    root.addEventListener('blur', (event) => {
      fileMutation.then(() => options.onBlur?.(getParts(), event));
    });
    root.addEventListener('beforeinput', (event) => {
      if (event.inputType === 'historyUndo' || event.inputType === 'historyRedo') {
        const redo = event.inputType === 'historyRedo';
        if ((redo ? redoStack : undoStack).length) {
          event.preventDefault();
          queueHistory(redo);
        }
        return;
      }
      pendingInput = { before: getParts(), kind: event.inputType || 'input' };
      if (event.inputType !== 'insertParagraph') return;
      event.preventDefault();
      document.execCommand('insertText', false, '\n');
    });
    root.addEventListener('keydown', async (event) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.key.toLowerCase() !== 'z') return;
      const stack = event.shiftKey ? redoStack : undoStack;
      if (!stack.length) return;
      event.preventDefault();
      await queueHistory(event.shiftKey);
    });
    root.addEventListener('click', async (event) => {
      const button = event.target.closest('.dogear-remove-asset');
      if (!button) return;
      event.preventDefault();
      const chip = button.closest('.dogear-asset-chip');
      const before = getParts();
      root.focus();
      chip.remove();
      const after = getParts();
      recordHistory(before, after, 'asset-remove');
      // Match ordinary text editing: update the draft now and persist on blur.
      // Saving immediately can cause the host to rebuild this editor and erase
      // its local undo entry before the user presses Command/Ctrl+Z.
      options.onChange?.(after, 'input');
    });
    root.addEventListener('dragstart', (event) => {
      const chip = event.target.closest?.('.dogear-asset-chip');
      if (!chip || !root.contains(chip)) return;
      draggedChip = chip;
      draggedBeforeParts = getParts();
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('application/x-dogear-asset', chip.dataset.assetId);
    });
    root.addEventListener('dragover', (event) => {
      if (draggedChip) {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        scheduleDropCaret(event);
        return;
      }
      if ([...event.dataTransfer.items].some((item) => item.kind === 'file')) {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
        root.classList.add('dogear-drop-active');
      }
    });
    root.addEventListener('dragleave', (event) => {
      root.classList.remove('dogear-drop-active');
      if (draggedChip && !root.contains(event.relatedTarget)) {
        cancelDropCaretFrame();
        clearDropCaret();
      }
    });
    root.addEventListener('drop', async (event) => {
      root.classList.remove('dogear-drop-active');
      if (draggedChip) {
        event.preventDefault();
        const chip = draggedChip;
        draggedChip = null;
        cancelDropCaretFrame();
        placeDropCaret(event);
        const targetRange = pendingDropRange?.cloneRange();
        clearDropCaret();
        if (!targetRange) return;
        const anchor = document.createComment('dogear-drop');
        targetRange.insertNode(anchor);
        anchor.before(chip);
        anchor.remove();
        root.normalize();
        placeCaretAfter(chip);
        lastRange = selectionRangeWithin(root);
        const after = getParts();
        recordHistory(draggedBeforeParts || after, after, 'asset-move');
        draggedBeforeParts = null;
        await options.onChange?.(after, 'asset');
        return;
      }
      if (!event.dataTransfer.files.length) return;
      event.preventDefault();
      const pointRange = caretRangeFromPointWithin(root, event.clientX, event.clientY) || lastRange;
      addFiles(event.dataTransfer.files, pointRange);
    });
    root.addEventListener('dragend', () => {
      draggedChip = null;
      draggedBeforeParts = null;
      cancelDropCaretFrame();
      clearDropCaret();
    });
    root.addEventListener('paste', (event) => {
      const files = [...event.clipboardData.files].filter((file) => file.type.startsWith('image/'));
      if (!files.length) return;
      event.preventDefault();
      addFiles(files, selectionRangeWithin(root));
    });

    setParts(options.parts || []);
    return {
      addFiles,
      destroy: () => {
        partsRenderVersion += 1;
        cancelDropCaretFrame();
        clearDropCaret();
        revokeObjectUrls();
        options.onDestroy?.();
      },
      focus: () => root.focus(),
      getParts,
      setParts,
    };
  }

  globalThis.DOGEAR_COMPOSER = { create };
})();
