// Small dependency-free editor for ordered text + asset parts. Attachments are
// non-editable chips in a contenteditable surface, so their position relative
// to the surrounding text is preserved without exposing local file paths.

(() => {
  const M = globalThis.DOGEAR_MODEL;

  function childParts(node) {
    const parts = [];
    for (const child of node.childNodes) {
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
          if (/^(DIV|P)$/.test(child.tagName) && child !== node.lastChild) {
            parts.push(M.textPart('\n'));
          }
        }
      }
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
      chip.title = part.label || 'Attached image';
      chip.draggable = true;

      const preview = document.createElement('img');
      preview.alt = '';
      const label = document.createElement('span');
      label.textContent = part.label || 'image';
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'dogear-remove-asset';
      remove.title = `Remove ${part.label || 'image'}`;
      remove.setAttribute('aria-label', remove.title);
      remove.textContent = '×';
      chip.append(preview, label, remove);

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

    async function setParts(parts) {
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

    function clearDropCaret() {
      dropCaret.remove();
    }

    function placeDropCaret(event) {
      clearDropCaret();
      const targetChip = event.target.closest?.('.dogear-asset-chip');
      if (targetChip && root.contains(targetChip)) {
        const rect = targetChip.getBoundingClientRect();
        const before = event.clientX < rect.left + rect.width / 2;
        targetChip.parentNode.insertBefore(dropCaret, before ? targetChip : targetChip.nextSibling);
        return true;
      }
      const range = document.caretRangeFromPoint?.(event.clientX, event.clientY);
      if (range && root.contains(range.commonAncestorContainer)) {
        const containingChip = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
          ? range.commonAncestorContainer.closest?.('.dogear-asset-chip')
          : range.commonAncestorContainer.parentElement?.closest?.('.dogear-asset-chip');
        if (containingChip) {
          const rect = containingChip.getBoundingClientRect();
          const before = event.clientX < rect.left + rect.width / 2;
          containingChip.parentNode.insertBefore(dropCaret, before ? containingChip : containingChip.nextSibling);
        } else {
          range.insertNode(dropCaret);
        }
        return true;
      }
      root.appendChild(dropCaret);
      return true;
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
      if (inserted) await options.onChange?.(getParts(), 'asset');
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
    root.addEventListener('input', () => options.onChange?.(getParts(), 'input'));
    root.addEventListener('blur', () => {
      fileMutation.then(() => options.onBlur?.(getParts()));
    });
    root.addEventListener('beforeinput', (event) => {
      if (event.inputType !== 'insertParagraph') return;
      event.preventDefault();
      document.execCommand('insertText', false, '\n');
    });
    root.addEventListener('click', async (event) => {
      const button = event.target.closest('.dogear-remove-asset');
      if (!button) return;
      event.preventDefault();
      button.closest('.dogear-asset-chip').remove();
      await options.onChange?.(getParts(), 'asset');
    });
    root.addEventListener('dragstart', (event) => {
      const chip = event.target.closest?.('.dogear-asset-chip');
      if (!chip || !root.contains(chip)) return;
      draggedChip = chip;
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('application/x-dogear-asset', chip.dataset.assetId);
    });
    root.addEventListener('dragover', (event) => {
      if (draggedChip) {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        placeDropCaret(event);
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
      if (draggedChip && !root.contains(event.relatedTarget)) clearDropCaret();
    });
    root.addEventListener('drop', async (event) => {
      root.classList.remove('dogear-drop-active');
      if (draggedChip) {
        event.preventDefault();
        const chip = draggedChip;
        draggedChip = null;
        if (!dropCaret.isConnected) placeDropCaret(event);
        dropCaret.before(chip);
        clearDropCaret();
        placeCaretAfter(chip);
        lastRange = selectionRangeWithin(root);
        await options.onChange?.(getParts(), 'asset');
        return;
      }
      if (!event.dataTransfer.files.length) return;
      event.preventDefault();
      const pointRange = document.caretRangeFromPoint?.(event.clientX, event.clientY) || lastRange;
      addFiles(event.dataTransfer.files, pointRange);
    });
    root.addEventListener('dragend', () => {
      draggedChip = null;
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
        revokeObjectUrls();
      },
      focus: () => root.focus(),
      getParts,
      setParts,
    };
  }

  globalThis.DOGEAR_COMPOSER = { create };
})();
