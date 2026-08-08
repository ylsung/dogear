// English prompt templates. See prompts/index.js for how packs are loaded.

globalThis.DOGEAR_PROMPTS['en'] = {
  name: 'English',

  // Opening instruction; n = number of queries.
  header: (n) =>
    `I have several questions, each associated with a source and sometimes selected text or images. ` +
    `Please address each one under its own numbered header ([Q1], [Q2], …).`,

  // One line introducing each source document. letter = A, B, C…
  source: (letter, title, url) => `Source ${letter}: "${title}" (${url})`,

  // Label used in place of a local file's path (the path itself is private).
  localFile: 'local file',

  // Location suffix for questions captured in the PDF viewer.
  pdfPage: (page) => ` (PDF page ${page})`,

  // Location suffix for selections captured in a code editor (VSCode).
  lines: (start, end) => (start === end ? ` (line ${start})` : ` (lines ${start}–${end})`),

  // Opens each query block: the [Qn] marker on its own line, a blank line,
  // then the selected text. where = pdfPage(...) or ''. "\n" = one line
  // break, so "\n\n" produces the blank line between marker and selection.
  excerpt: (qNum, where, text) => `[Q${qNum}]${where}\nSelected text: "${text}"`,

  // Used when selected context contains one or more attached assets.
  multimodalSelection: (qNum, where, content) =>
    `[Q${qNum}]${where}\nSelected context: ${content}`,

  pageQuestion: (qNum) => `[Q${qNum}]\nContext: the whole source page`,

  // Optional line showing text around the selection.
  context: (prefix, suffix) => `Surrounding text: "…${prefix}⟨selected text⟩${suffix}…"`,

  // The query line itself.
  question: (text) => `Query: ${text}`,

  attachmentsHeader: 'Attached images (uploaded with this prompt):',

  attachment: (label, filename) => `- ${label}: ${filename}`,
};
