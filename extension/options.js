// Dogear settings page: shortcuts (read-only — Chrome owns them), appearance,
// and prompt language. Every surface listens for these storage keys.

{
  const T = globalThis.DOGEAR_THEME;
  const faces = (T.font.faces || [])
    .map(
      (f) =>
        `@font-face { font-family: '${f.family}'; font-weight: ${f.weight}; ` +
        `font-style: normal; font-display: swap; ` +
        `src: url('${chrome.runtime.getURL(f.file)}') format('woff2'); }`,
    )
    .join('\n');
  const s = document.createElement('style');
  s.textContent = `${globalThis.DOGEAR_THEME_CSS(':root', `--font: ${T.font.family};`)}
${faces}`;
  document.head.appendChild(s);
}

function applyAppearance(appearance) {
  if (appearance === 'light' || appearance === 'dark') document.documentElement.dataset.theme = appearance;
  else delete document.documentElement.dataset.theme;
}

// ---------- shortcuts ----------

async function renderShortcuts() {
  const table = document.getElementById('shortcuts');
  const order = ['ask-selection', 'export-prompt', 'clear-queue', '_execute_action'];
  const commands = (await chrome.commands.getAll())
    .sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
  table.replaceChildren(...commands.map((command) => {
    const row = document.createElement('tr');
    const name = document.createElement('td');
    name.textContent = command.description || 'Open the queue';
    const key = document.createElement('td');
    if (command.shortcut) {
      const kbd = document.createElement('kbd');
      kbd.textContent = command.shortcut;
      key.appendChild(kbd);
    } else {
      key.className = 'unset';
      key.textContent = 'Not set';
    }
    row.append(name, key);
    return row;
  }));
}

document.getElementById('edit-shortcuts').addEventListener('click', () => {
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});

// Coming back from Chrome's shortcuts page should show the new bindings.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') renderShortcuts();
});

// ---------- appearance ----------

const radios = [...document.querySelectorAll('input[name="appearance"]')];
radios.forEach((radio) => radio.addEventListener('change', () => {
  chrome.storage.local.set({ appearance: radio.value });
}));

// ---------- prompt language ----------

const langSelect = document.getElementById('lang');
for (const [code, pack] of Object.entries(globalThis.DOGEAR_PROMPTS)) {
  const opt = document.createElement('option');
  opt.value = code;
  opt.textContent = pack.name;
  langSelect.appendChild(opt);
}
langSelect.addEventListener('change', () => chrome.storage.local.set({ promptLang: langSelect.value }));

function applyStored({ appearance = 'system', promptLang }) {
  applyAppearance(appearance);
  radios.forEach((radio) => (radio.checked = radio.value === appearance));
  langSelect.value = promptLang && globalThis.DOGEAR_PROMPTS[promptLang]
    ? promptLang
    : globalThis.DOGEAR_PROMPT_DEFAULT_LANG;
}

chrome.storage.local.get(['appearance', 'promptLang']).then(applyStored);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !(changes.appearance || changes.promptLang)) return;
  chrome.storage.local.get(['appearance', 'promptLang']).then(applyStored);
});

renderShortcuts();
