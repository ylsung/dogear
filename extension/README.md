# 🐶 Dogear for Chrome Extension

## Install (developer mode)

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** and pick the [`extension/`](extension/) folder

## Multimodal questions

Each queued question can contain an ordered mix of text and images. Dogear keeps
the context you were looking at separate from the references you add to the
question, then assembles both into one labeled prompt at delivery time.

Choose the context that fits the question:

- **Selected text** — select a passage and use the Dogear hotkey. The queued
  question retains the quote, surrounding text, source page, and its numbered
  highlight.
- **Screenshot** — use the hotkey without selected text, or click **Capture
  screenshot** in the side panel. Drag around part of the visible page or choose
  **Use visible page** to capture the entire viewport as image context.
- **Ask page** — click **Ask page** in the side panel for a general question that
  does not need a text highlight or screenshot. The question still records the
  active page as its source.

Inside either the on-page composer or a queued question, paste or drop images,
or use **＋ Image** to choose several files. Image thumbnails sit inline with the
text: drag one to the exact insertion point you want, and hover over it to see
its full filename. Text edits, image removal, and deleted question cards can be
restored with `Command+Z` on macOS or `Ctrl+Z` on Windows/Linux; the editor keeps
up to five recent mixed-content steps.

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
     The controls remain neutral and reusable after each attempt, so you can
     switch chats and attach the same image set again.

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
