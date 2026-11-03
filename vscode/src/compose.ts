import * as fs from 'fs';
import * as path from 'path';
import { QueueItem } from './queue';

export interface PlannedAsset {
  id: string;
  label: string;
  deliveredName: string;
}

interface ComposeModule {
  buildAssetPlan(queue: QueueItem[]): PlannedAsset[];
  composePrompt(queue: QueueItem[], assets: PlannedAsset[], lang: string): string;
}

export interface PromptPacks {
  defaultLang: string;
  names: Record<string, string>;
}

// The prompt packs and media/compose.js are plain scripts that assign to
// globalThis (the sidebar webview loads them as <script>s). Evaluate them in a
// shadowed global, as loadTheme does for theme.js, so the hotkey export
// composes the exact prompt the sidebar would.
function load(extensionPath: string): { compose: ComposeModule; packs: PromptPacks } {
  const media = path.join(extensionPath, 'media');
  const sandbox: any = {};
  const run = (file: string) =>
    new Function('globalThis', fs.readFileSync(file, 'utf8'))(sandbox);
  const promptsDir = path.join(media, 'prompts');
  run(path.join(promptsDir, 'index.js'));
  for (const f of fs.readdirSync(promptsDir).filter((f) => f.endsWith('.js') && f !== 'index.js').sort()) {
    run(path.join(promptsDir, f));
  }
  run(path.join(media, 'compose.js'));
  const names = Object.fromEntries(
    Object.entries(sandbox.DOGEAR_PROMPTS as Record<string, { name: string }>).map(([code, pack]) => [code, pack.name]),
  );
  return {
    compose: sandbox.DOGEAR_COMPOSE,
    packs: { defaultLang: sandbox.DOGEAR_PROMPT_DEFAULT_LANG, names },
  };
}

let cached: ReturnType<typeof load> | undefined;

function loaded(extensionPath: string) {
  cached ??= load(extensionPath);
  return cached;
}

export function promptPacks(extensionPath: string): PromptPacks {
  return loaded(extensionPath).packs;
}

export function composeQueue(
  extensionPath: string,
  queue: QueueItem[],
  lang: string,
): { text: string; assets: PlannedAsset[] } {
  const { compose } = loaded(extensionPath);
  const assets = compose.buildAssetPlan(queue);
  return { text: compose.composePrompt(queue, assets, lang), assets };
}
