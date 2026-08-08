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

  // Palette: "Blueprint" — cobalt + navy on icy-azure paper with a
  // safety-orange redline marker. The most colorblind-robust option
  // (blue↔orange is the classic CVD-safe axis).
  colors: {
    // Brand / actions
    primary: '#1d4ed8', // main buttons, question numbers, badge, drop indicator
    primaryHover: '#1e40af',
    textOnPrimary: '#ffffff',
    dark: '#0c2340', // dark buttons (Ask, Copy prompt), toast background
    darkHover: '#1d3a63',
    textOnDark: '#eaf2fb',

    // Text
    text: '#10233c',
    textMuted: '#4e6787',
    textFaint: '#86a0bf',

    // Surfaces
    bg: '#eef4fa', // side panel background
    panel: '#ffffff', // cards, popover
    groupBg: '#dbe8f7', // source-group box
    border: '#c9d9ec',
    borderStrong: '#a8c0dd',
    selectedBg: '#fff1e2', // selected card tint (ties to the orange marker)

    // On-page highlight marks
    highlight: 'rgba(249, 115, 22, 0.35)',

    // Destructive
    danger: '#dc2626',
    dangerBg: '#fee2e2',

    // Confirmed handoff state
    success: '#166534',
    successBorder: '#22c55e',
    successBg: '#dcfce7',
  },
};
