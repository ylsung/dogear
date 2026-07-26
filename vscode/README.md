# 🐶 Dogear for VSCode

**Mark your questions and submit in a batch** — inside your editor. Select code or text,
attach a query to each selection, and compose them for Claude Code or Codex as
one prompt. Sibling of the Dogear Chrome extension (in
`extension/` in the same repo); they share the same theme, prompt templates,
and queue model.

## Develop / install

```sh
cd vscode
npm install
npm run build     # copies shared files from ../extension and bundles src/
```

- **Run from source**: open the `vscode/` folder in VSCode and press `F5`
  (Extension Development Host).
- **Install for real**: `npx @vscode/vsce package` then
  `code --install-extension dogear-vscode-0.1.0.vsix`.

`media/theme.js`, `media/prompts/`, and `media/fonts/` are build-time copies —
the source of truth lives in `../extension/`. Edit there, rebuild here.

## Usage

1. Select text in any editor → press `⌃⌥Q` (Mac) / `Ctrl+Alt+Q` (Windows/Linux),
   or right-click → **Dogear: Add query for selection**.
2. Type your query (or leave it empty to fill in later) and press Enter. The
   selection gets a highlight; the query lands in the queue (badge on the
   Dogear icon in the Activity Bar).
3. Repeat across as many files as you like — the queue is per-workspace and
   survives restarts.
4. Open the Dogear sidebar (Activity Bar) to edit, reorder (drag cards or whole
   file groups), or delete queries. Click a file header to jump to the anchored
   code.
5. Deliver the batch:
   - **→ Claude Code / → Codex** opens the matching chat sidebar and pastes the
     composed prompt into its composer without sending it. The prompt remains
     on the clipboard as a fallback.
   - **Copy prompt** puts it on the clipboard for anywhere else.

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
  composer directly
  ([anthropics/claude-code#27873](https://github.com/anthropics/claude-code/issues/27873));
  Dogear therefore focuses the requested sidebar and uses VS Code's global
  clipboard command to paste. Sending remains an explicit user action.
