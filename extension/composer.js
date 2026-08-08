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

    function revokeObjectUrls() {
      objectUrls.forEach((url) => URL.revokeObjectURL(url));
      objectUrls = [];
    }

    async function makeChip(part) {
      const chip = document.createElement('span');
      chip.className = 'dogear-asset-chip';
      chip.contentEditable = 'false';
      chip.dataset.assetId = part.assetId;
      chip.dataset.mediaType = part.mediaType || 'application/octet-stream';
      chip.dataset.label = part.label || 'image';
      chip.title = part.label || 'Attached image';

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
            objectUrls.push(url);
          }
        } catch (_) {
          preview.style.display = 'none';
        }
      }
      return chip;
    }

    async function setParts(parts) {
      revokeObjectUrls();
      root.replaceChildren();
      for (const part of M.coalesceParts(parts)) {
        if (part.type === 'text') root.appendChild(document.createTextNode(part.text));
        else root.appendChild(await makeChip(part));
      }
      if (!root.childNodes.length) root.appendChild(document.createElement('br'));
    }

    function getParts() {
      return childParts(root);
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
      options.onChange?.(getParts(), 'asset');
    }

    async function addFiles(files, range = lastRange) {
      const images = [...files].filter((file) => file.type.startsWith('image/'));
      for (const file of images) {
        if (options.maxFileSize && file.size > options.maxFileSize) {
          options.onError?.(`${file.name || 'Image'} is too large.`);
          continue;
        }
        try {
          const asset = await options.storeFile(file);
          await insertAsset(asset, range);
          range = selectionRangeWithin(root);
        } catch (error) {
          options.onError?.(error.message || 'Could not attach image.');
        }
      }
    }

    root.addEventListener('selectionchange', rememberRange);
    root.addEventListener('keyup', rememberRange);
    root.addEventListener('mouseup', rememberRange);
    root.addEventListener('input', () => options.onChange?.(getParts(), 'input'));
    root.addEventListener('blur', () => options.onBlur?.(getParts()));
    root.addEventListener('beforeinput', (event) => {
      if (event.inputType !== 'insertParagraph') return;
      event.preventDefault();
      document.execCommand('insertText', false, '\n');
    });
    root.addEventListener('click', (event) => {
      const button = event.target.closest('.dogear-remove-asset');
      if (!button) return;
      event.preventDefault();
      button.closest('.dogear-asset-chip').remove();
      options.onChange?.(getParts(), 'asset');
    });
    root.addEventListener('dragover', (event) => {
      if ([...event.dataTransfer.items].some((item) => item.kind === 'file')) {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
        root.classList.add('dogear-drop-active');
      }
    });
    root.addEventListener('dragleave', () => root.classList.remove('dogear-drop-active'));
    root.addEventListener('drop', (event) => {
      root.classList.remove('dogear-drop-active');
      if (!event.dataTransfer.files.length) return;
      event.preventDefault();
      const pointRange = document.caretRangeFromPoint?.(event.clientX, event.clientY) || lastRange;
      addFiles(event.dataTransfer.files, pointRange);
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
      destroy: revokeObjectUrls,
      focus: () => root.focus(),
      getParts,
      setParts,
    };
  }

  globalThis.DOGEAR_COMPOSER = { create };
})();
