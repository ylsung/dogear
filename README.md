# Dogear

When reading a webpage or an AI agent’s response, you’ll often come across sections that raise questions or need changes. You may want to highlight those parts and add a question, comment, or edit request.

Some web-based tools and coding agent chatbots already let you select text and ask about it directly. But each time you send a request, the model’s response interrupts your reading flow. When you have several questions, you usually have to submit them one by one.

Dogear solves this problem. You can mark every section you want to revisit, write your questions or edit requests alongside them, and send everything to the model at once. There’s no need to manually copy the selected text, keep track of where it came from, or submit each request separately.

The Chrome extension also supports multimodal questions: use selected text or a
Dogear screenshot as context, mix text with pasted or dropped reference images,
or choose **Ask page** when your question is about the page as a whole. Dogear
keeps the batch editable and uploads its images only when you hand the prompt to
a chat.

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
   Press the hotkey without selected text to capture part or all of the visible
   page as image context. You can also use **Capture screenshot** in the side panel,
   or choose **Ask page** to start a question without selected context.
2. Type your query, optionally pasting or dropping reference images directly into
   the composer, then press Enter. Text selections get a numbered highlight and
   the multimodal query lands in the queue (badge on the toolbar icon).
3. Keep reading; repeat across as many pages/tabs as you like — the queue is global.
4. Click the Dogear toolbar icon to open the side panel: edit, reorder, or delete
   queries.
5. Deliver the batch:
   - **→ ChatGPT / → Claude** attaches the images and inserts the composed prompt
     into an open chat tab, leaving it in the box for you to review and send.
   - **Copy prompt** puts the text on the clipboard for any other chat. The side
     panel opens a **Manual handoff** tray containing matching, labeled images.
     Open the destination chat in the active tab and choose **Attach all images to
     this tab**, or use the individual **Attach** and **Save** controls.
     Successfully attached images turn green. Dogear returns tracked images to
     neutral when their destination chips are removed; use **Reset attachment
     status** when a site's custom uploader cannot be observed.

Images are kept in extension-local storage while you collect and edit questions.
Dogear only hands them to a website when you choose a delivery or attachment
action from the manual handoff tray.

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
   (Windows/Linux), or right-click → **Dogear: Add query for selection**. You
   can also right-click an image file → **Dogear: Add query for image**.
2. Use the Dogear sidebar composer for multiline text plus pasted, dropped, or
   selected reference images, then add the mixed-content question to the queue.
   Text selections are highlighted and image selections retain a preview.
3. Repeat across as many files as you like. The queue is **per-workspace** and
   survives restarts, so questions about one repo never bleed into another.
4. Open the Dogear sidebar to edit or reorder text and images, drag cards or
   whole file groups by their handles, or delete queries. Click a source header
   to jump back to the anchored code or image.
5. Deliver the batch:
   - **→ Codex** attaches queued images and pastes the composed prompt.
   - **→ Claude Code** pastes the prompt with local paths that Claude can read.
   - **Copy prompt** puts the prompt and labeled local image paths on the
     clipboard; **Save images…** exports all images when manual attachment is
     needed. Dogear never sends on your behalf.

It also supports capturing selections from VS Code's Markdown preview and from
the Codex/Claude Code chat webviews via right-click, though those captures are
excerpt-only (no persistent highlight, since VS Code isolates webviews from
other extensions).

Install: `cd vscode && npm install && npm run build`, then either press `F5` in
that folder to run it from source, or package it with `npx @vscode/vsce
package` and `code --install-extension dogear-vscode-0.2.0.vsix`. Full details,
including multimodal delivery behavior and fallbacks, are in
[`vscode/README.md`](vscode/README.md).

## Current limitations (Phase 0)
- **Browser-reserved pages**: Chrome forbids all extensions from running on
  `chrome://` pages (settings, extensions, history), the Chrome Web Store, and
  other extensions' pages. Dogear cannot work there — no extension can.
- **Selections inside text fields** (e.g. GitHub's code view, which overlays an
  invisible textarea over the code) are captured with full context, but don't get
  a persistent visual highlight — the browser doesn't allow marking inside a
  text control.
- **Chat injection is best-effort**: if chatgpt.com/claude.ai change their composer
  or upload controls, Dogear copies the prompt and opens the labeled manual handoff
  tray for any images it could not attach.
- Screenshot capture covers the current visible page area. It does not yet scroll
  and stitch an entire page, capture other desktop applications, or watch native
  screenshot files.
- Highlights re-anchor by quote + context; on heavily dynamic pages a highlight may
  fail to re-attach after reload (the selected text is embedded in the prompt regardless,
  so your queries still work).
- No answer mapping back to highlights yet — planned for a future update.

## License

[MIT](LICENSE)
