// ============================================================================
// Dogear global style config — THE single place to change look & feel.
// Every surface (page popover/highlights, side panel, badge, PDF viewer UI)
// reads from this file. Loaded as a plain script in content pages, the side
// panel, and the background worker; no build step.
// ============================================================================

globalThis.DOGEAR_THEME = {
  emoji: {
    dog: '🐶', // brand mark: side panel header, toasts
    pdf: '📄', // "open PDF in Dogear viewer" button
  },

  font: {
    // UI font for Dogear's own surfaces (popover, side panel). Page content
    // and highlights keep the host page's font.
    family: "'Lora', Georgia, 'Times New Roman', serif",
    // Bundled @font-face sources (files live in fonts/, declared as
    // web-accessible resources so content pages may load them).
    faces: [
      { family: 'Lora', weight: '400', file: 'fonts/lora-400.woff2' },
      { family: 'Lora', weight: '600', file: 'fonts/lora-600.woff2' },
    ],
  },

  // Palette: "Bilberry Apricot" — inky bilberry lead with an apricot
  // highlighter on lavender-grey paper. Every token is mixed from these eight
  // swatches (see the Dogear Palette Lab). Light and dark mode share the same
  // swatches: dark mode swaps Paper and Ink as ground/figure, and the accents
  // (primary, dark, highlight) are identical in both.
  palette: {
    paper: '#f5f5fa', // light ground
    ink: '#161827', // dark ground
    lead: '#5960b3', // main accent
    mark: '#f7b285', // highlighter
    mist: '#cdd0ec', // soft tint
    deep: '#2b2e5c', // strong buttons
    alert: '#d4474f', // destructive
    ok: '#4ea27c', // success
  },

  colors: {
    // Brand / actions
    primary: '#5960b3', // main buttons, question numbers, badge, drop indicator
    primaryHover: '#4d549b',
    textOnPrimary: '#f5f5fa',
    dark: '#2b2e5c', // dark buttons (Ask, Copy prompt), toast background
    darkHover: '#434771',
    textOnDark: '#f5f5fa',

    // Text
    text: '#161827',
    textMuted: '#545664',
    textFaint: '#80828d',

    // Surfaces
    bg: '#f2f2f9', // side panel background
    panel: '#f5f5fa', // cards, popover
    groupBg: '#ebecf7', // source-group box
    border: '#d4d5dc',
    borderStrong: '#b6b7c0',
    selectedBg: '#f6e9e5', // selected card tint (ties to the apricot marker)

    // On-page highlight marks
    highlight: 'rgba(247, 178, 133, 0.45)',

    // Destructive
    danger: '#d4474f',
    dangerBg: '#f4e0e3',

    // Confirmed handoff state
    success: '#3e7562',
    successBorder: '#4ea27c',
    successBg: '#dee9e8',
  },

  // Dark mode: same keys, used when the OS / editor theme is dark.
  colorsDark: {
    primary: '#5960b3',
    primaryHover: '#6f78bf',
    textOnPrimary: '#f5f5fa',
    dark: '#2b2e5c',
    darkHover: '#434771',
    textOnDark: '#f5f5fa',

    text: '#f5f5fa',
    textMuted: '#a5a7b0',
    textFaint: '#777985',

    bg: '#222434',
    panel: '#161827',
    groupBg: '#3c3e51',
    border: '#2e303f',
    borderStrong: '#454856',
    selectedBg: '#383138',

    highlight: 'rgba(247, 178, 133, 0.45)',

    danger: '#d4474f',
    dangerBg: '#2d202d',

    success: '#84bba0',
    successBorder: '#4ea27c',
    successBg: '#1e2933',
  },
};
