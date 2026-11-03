// Register before page scripts: a closed shadow root retargets keyboard events
// to its host, so document-level chat shortcuts cannot recognize our editor.
// This runs in the extension's isolated world; the page cannot set the resolver.
(() => {
  // Observe user intent before page handlers can redirect focus. Do not cancel
  // outside clicks: they explicitly hand control back to the page.
  window.addEventListener('pointerdown', (event) => {
    globalThis.DOGEAR_POINTER_INTENT?.(event);
  }, true);
  window.addEventListener('blur', (event) => {
    if (event.target === window) globalThis.DOGEAR_RELEASE_FOCUS?.();
    else globalThis.DOGEAR_REMEMBER_FOCUS_SELECTION?.(event);
  }, true);
  for (const type of ['focus', 'focusin']) {
    window.addEventListener(type, (event) => {
      if (globalThis.DOGEAR_FOCUS_EVENT?.(event)) event.stopImmediatePropagation();
    }, true);
  }
  for (const type of ['keydown', 'keypress', 'keyup']) {
    window.addEventListener(type, (event) => {
      const target = globalThis.DOGEAR_KEYBOARD_TARGET?.(event);
      if (!target) return;
      // Native Tab navigation is an intentional focus transfer too. An
      // internal destination can claim ownership again on its focus event.
      if (type === 'keydown' && event.key === 'Tab') globalThis.DOGEAR_RELEASE_FOCUS?.();
      event.stopImmediatePropagation();
      // Keep native editing on the original trusted event, while allowing the
      // composer (undo, Enter, Escape) to handle a shadow-local keyboard event.
      const local = new KeyboardEvent(type, {
        key: event.key, code: event.code, location: event.location,
        ctrlKey: event.ctrlKey, metaKey: event.metaKey,
        altKey: event.altKey, shiftKey: event.shiftKey,
        repeat: event.repeat, isComposing: event.isComposing,
        keyCode: event.keyCode, charCode: event.charCode,
        bubbles: true, cancelable: true, composed: false,
      });
      if (!target.dispatchEvent(local)) event.preventDefault();
    }, true);
  }
})();
