// ============================================================================
// Dogear prompt templates — registry & default language.
//
// Each language lives in its own file (prompts/<lang>.js) and registers a
// template pack into globalThis.DOGEAR_PROMPTS. Templates are functions, not
// plain strings, so each language controls its own pluralization, quoting,
// and punctuation.
//
// To add a language:
//   1. Copy prompts/en.js to prompts/<code>.js and translate each function.
//   2. Add a <script src="prompts/<code>.js"> tag to sidepanel.html
//      (after prompts/index.js).
// It then appears automatically in the side panel's language picker; the
// user's choice is persisted. DEFAULT_LANG applies until a choice is made.
// ============================================================================

globalThis.DOGEAR_PROMPTS = {};
globalThis.DOGEAR_PROMPT_DEFAULT_LANG = 'en';
