import * as vscode from 'vscode';
import { promptPacks } from './compose';

// User settings (Settings UI → Extensions → Dogear). Shortcuts are not here:
// VS Code owns keybindings, so the sidebar links to Keyboard Shortcuts instead.

export type Appearance = 'auto' | 'light' | 'dark';

const LEGACY_LANG_KEY = 'promptLang';

function config(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('dogear');
}

export function appearance(): Appearance {
  const value = config().get<string>('appearance', 'auto');
  return value === 'light' || value === 'dark' ? value : 'auto';
}

export function promptLang(context: vscode.ExtensionContext): string {
  const packs = promptPacks(context.extensionPath);
  const value = config().get<string>('promptLanguage', packs.defaultLang);
  return packs.names[value] ? value : packs.defaultLang;
}

export async function setPromptLang(lang: string): Promise<void> {
  await config().update('promptLanguage', lang, vscode.ConfigurationTarget.Global);
}

/** The language used to live in globalState; move it into the setting once. */
export async function migrateSettings(context: vscode.ExtensionContext): Promise<void> {
  const legacy = context.globalState.get<string>(LEGACY_LANG_KEY);
  if (!legacy) return;
  if (config().inspect('promptLanguage')?.globalValue === undefined) await setPromptLang(legacy);
  await context.globalState.update(LEGACY_LANG_KEY, undefined);
}

// Default bindings as shown in the sidebar. VS Code has no API to read the
// user's actual keybindings, so a rebound key is not reflected here.
export function hotkeyHints(): { ask: string; export: string; clear: string } {
  const mac = process.platform === 'darwin';
  return mac
    ? { ask: '⌘⇧E', export: '⌘⇧X', clear: '⌘⇧0' }
    : { ask: 'Ctrl+Shift+E', export: 'Ctrl+Shift+X', clear: 'Ctrl+Shift+0' };
}
