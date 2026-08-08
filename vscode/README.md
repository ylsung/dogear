# 🐶 Dogear for VSCode

**Mark your questions and submit in a batch** — inside your editor. Select code,
text, or an image file; mix multiline text and reference images in each query;
and compose everything for Claude Code or Codex as one prompt. Sibling of the
Dogear Chrome extension (in `extension/` in the same repo), it shares the same
theme, prompt templates, and queue model.

## Develop / install

```sh
cd vscode
npm install
npm run build     # copies shared files from ../extension and bundles src/
```

- **Run from source**: open the `vscode/` folder in VSCode and press `F5`
  (Extension Development Host).
- **Install for real**: `npx @vscode/vsce package` then
  `code --install-extension dogear-vscode-0.2.0.vsix`.

`media/theme.js`, `media/prompts/`, and `media/fonts/` are build-time copies —
the source of truth lives in `../extension/`. Edit there, rebuild here.

## Usage

1. Choose the context:
   - Select text in any editor → press `⌃⌥Q` (Mac) / `Ctrl+Alt+Q`
     (Windows/Linux), or right-click → **Dogear: Add query for selection**.
   - Right-click a PNG, JPEG, GIF, WebP, BMP, or SVG file in the Explorer or
     editor title → **Dogear: Add query for image**.
2. Dogear opens a composer in its sidebar. Enter as many lines as needed, then
   paste, drop, or choose one or more reference images. The image thumbnails
   remain inline with the surrounding text and can be reordered. Press
   `Command+Enter` / `Ctrl+Enter` or click **Add to queue**. Text selections get
   a highlight; image selections retain a preview in the queued card.
3. Repeat across as many files as you like — the queue is per-workspace and
   survives restarts.
4. Open the Dogear sidebar (Activity Bar) to edit multiline text and images,
   reorder inline images, drag cards or file groups by their handles, or delete
   queries. Click a source header to return to the selected code or image.
5. Deliver the batch:
   - **→ Codex** attaches the queued images through Codex's contributed
     **Add File to Codex Thread** command, then pastes the labeled prompt without
     sending it.
   - **→ Claude Code** pastes the prompt with local image paths because Claude
     Code currently exposes no file-attachment command to other extensions.
     Claude can read those files directly; sending remains explicit.
   - **Copy prompt** includes the same labeled local paths for other coding
     agents. Use **Save images…** to export every queued image into one chosen
     folder when the destination cannot read extension storage.

Image bytes live in VS Code's extension storage for the current workspace, not
inside the queue JSON or the prompt. Orphaned files are removed when images or
questions are deleted. Dogear only gives a destination access when you choose a
delivery, copy, or save action.

### Markdown previews and AI chat views

- In VS Code's built-in Markdown preview, select rendered text and press
  `⌃⌥Q` / `Ctrl+Alt+Q`, or right-click → **Dogear: Add selected preview text**.
- The same right-click capture is available in Codex and Claude Code chats.
  This webview path briefly uses the clipboard and restores its previous
  contents immediately.
- VS Code isolates webviews from other extensions, so preview and chat
  captures are excerpt-only: they can be queued and included in a batch
  prompt, but Dogear cannot persist a highlight or navigate to the exact
  rendered passage or chat message.

Highlights re-anchor after edits by exact text + surrounding context, and the
line numbers in the composed prompt follow along.

## Notes

- The queue lives in the workspace, so questions about repo A never show up
  while you're in repo B.
- Neither the Claude Code nor Codex VSCode extensions currently exposes its
  text composer directly
  ([anthropics/claude-code#27873](https://github.com/anthropics/claude-code/issues/27873));
  Dogear therefore focuses the requested sidebar and uses VS Code's global
  clipboard command to paste. Sending remains an explicit user action.
- VS Code's native `showInputBox` is single-line and has no attachment model,
  so Dogear's multiline mixed-content input is implemented in its existing
  sidebar webview.

## Multimodal simulator

After building, run the browser-level sidebar regression harness with:

```sh
node vscode/tests/simulator/run.js
```

See [`tests/simulator/README.md`](tests/simulator/README.md) for its external
Playwright dependency. The simulator covers multiline input, three-image
attachment, stable queue synchronization, selected-image context, and prompt
labels without writing repository artifacts.
