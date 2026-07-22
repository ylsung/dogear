// 繁體中文 prompt templates. See prompts/index.js for how packs are loaded.

globalThis.DOGEAR_PROMPTS['zh-TW'] = {
  name: '繁體中文',

  header: (n) =>
    `我現在有幾個請求，且每個請求都對應特定的來源及一段文字片段。` +
    `請在各自的編號標題（[Q1]、[Q2]…）下分別回應。`,

  source: (letter, title, url) => `來源 ${letter}：「${title}」（${url}）`,

  localFile: '本機檔案',

  pdfPage: (page) => `（PDF 第 ${page} 頁）`,

  lines: (start, end) => (start === end ? `（第 ${start} 行）` : `（第 ${start}–${end} 行）`),

  excerpt: (qNum, where, text) => `[Q${qNum}]${where}\n片段：「${text}」`,

  context: (prefix, suffix) => `前後文：「…${prefix}⟨片段⟩${suffix}…」`,

  question: (text) => `請求：${text}`,
};
