# Dogear

When reading a webpage or an AI agent’s response, you’ll often come across sections that raise questions or need changes. You may want to highlight those parts and add a question, comment, or edit request.

Some web-based tools and coding agent chatbots already let you select text and ask about it directly. But each time you send a request, the model’s response interrupts your reading flow. When you have several questions, you usually have to submit them one by one.

Dogear solves this problem. You can mark every section you want to revisit, write your questions or edit requests alongside them, and send everything to the model at once. There’s no need to manually copy the selected text, keep track of where it came from, or submit each request separately.

Two extensions live in this repo, sharing the same theme, prompt templates, and
queue model:

- [`extension/`](extension/) — the Chrome extension (this README)
- [`vscode/`](vscode/) — the VS Code extension, for querying code and text
  right inside your editor (see [VS Code extension](#vs-code-extension) below,
  or [its own README](vscode/README.md) for full details)

## Install (developer mode)

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** and pick the [`extension/`](extension/) folder

## Usage

1. On any page, select text → press the hotkey (`Alt+Q` on Windows/Linux,
   `⌃Q` on Mac) or right-click → *Dogear: ask about selection*. Chrome only
   applies suggested hotkeys at install time; check or rebind at
   `chrome://extensions/shortcuts`. The side panel shows your actual binding.
2. Type your query, press Enter. The selection gets a numbered highlight and the
   query lands in the queue (badge on the toolbar icon).
3. Keep reading; repeat across as many pages/tabs as you like — the queue is global.
4. Click the Dogear toolbar icon to open the side panel: edit, reorder, or delete
   queries.
5. Deliver the batch:
   - **→ ChatGPT / → Claude** inserts the composed prompt into an open chat tab and
     leaves it in the box for you to review and send.
   - **Copy prompt** puts it on the clipboard for anywhere else (desktop apps,
     Claude Code, Gemini, …).

## PDFs

Chrome's built-in PDF viewer exposes no DOM to extensions, so Dogear ships its own
viewer (bundled [PDF.js](https://mozilla.github.io/pdf.js/)). Two ways in:

- Viewing a PDF in a tab → open the Dogear side panel → **📄 Open this PDF in Dogear
  viewer**.
- Right-click any link to a PDF → **Open PDF in Dogear viewer**.

Inside the viewer, selection capture works exactly like on web pages, and each
query also records its **PDF page number** (included in the composed prompt).

**Local PDFs**: enable *"Allow access to file URLs"* for Dogear on
`chrome://extensions` (required by Chrome before the viewer may read `file://`
URLs), or skip the toggle entirely by using the viewer's own *Open file*
toolbar button to pick the file.

## VS Code extension

The same select-and-queue workflow, inside your editor, sending batches to
**Claude Code** or **Codex** instead of a browser chat tab.

1. Select code or text in any editor → press `⌃⌥Q` (Mac) / `Ctrl+Alt+Q`
   (Windows/Linux), or right-click → **Dogear: Add query for selection**.
2. Type your query (or leave it empty to fill in later) and press Enter. The
   selection is highlighted and the query lands in the queue — badge on the
   Dogear icon in the Activity Bar.
3. Repeat across as many files as you like. The queue is **per-workspace** and
   survives restarts, so questions about one repo never bleed into another.
4. Open the Dogear sidebar to edit, reorder (drag cards or whole file groups),
   or delete queries. Click a file header to jump back to the anchored code.
5. Deliver the batch:
   - **→ Claude Code / → Codex** places the composed prompt in a matching CLI
     terminal (reusing one if it's already open) and waits for you to press
     Enter — it doesn't send on your behalf.
   - **Copy prompt** puts it on the clipboard for anywhere else.

It also supports capturing selections from VS Code's Markdown preview and from
the Codex/Claude Code chat webviews via right-click, though those captures are
excerpt-only (no persistent highlight, since VS Code isolates webviews from
other extensions).

Install: `cd vscode && npm install && npm run build`, then either press `F5` in
that folder to run it from source, or package it with `npx @vscode/vsce
package` and `code --install-extension dogear-vscode-0.1.0.vsix`. Full details,
including why delivery goes through the CLIs rather than the chat panels
directly, are in [`vscode/README.md`](vscode/README.md).

## Current limitations (Phase 0)
- **Browser-reserved pages**: Chrome forbids all extensions from running on
  `chrome://` pages (settings, extensions, history), the Chrome Web Store, and
  other extensions' pages. Dogear cannot work there — no extension can.
- **Selections inside text fields** (e.g. GitHub's code view, which overlays an
  invisible textarea over the code) are captured with full context, but don't get
  a persistent visual highlight — the browser doesn't allow marking inside a
  text control.
- **Chat injection is best-effort**: if chatgpt.com/claude.ai change their composer
  DOM, the buttons fall back to copying the prompt to your clipboard.
- Highlights re-anchor by quote + context; on heavily dynamic pages a highlight may
  fail to re-attach after reload (the selected text is embedded in the prompt regardless,
  so your queries still work).
- No answer mapping back to highlights yet — planned for a future update.

## License

[MIT](LICENSE)
