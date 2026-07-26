# 🐶 Dogear for Chrome Extension

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
