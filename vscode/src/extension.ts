import * as vscode from 'vscode';
import { QueueStore } from './queue';
import {
  askSelection,
  askWebviewSelection,
} from './capture';
import { Decorations } from './decorations';
import { DogearPanel } from './panel';
import { AssetStore } from './assets';

export function activate(context: vscode.ExtensionContext): void {
  const store = new QueueStore(context.workspaceState);
  const assets = new AssetStore(context);
  const decorations = new Decorations(store, context);
  const panel = new DogearPanel(context, store, assets, decorations);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(DogearPanel.viewId, panel, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('dogear.askSelection', () => askSelection(store, panel)),
    vscode.commands.registerCommand('dogear.askCodexSelection', () =>
      askWebviewSelection(store, panel, 'codex-chat'),
    ),
    vscode.commands.registerCommand('dogear.askClaudeSelection', () =>
      askWebviewSelection(store, panel, 'claude-chat'),
    ),
    vscode.commands.registerCommand('dogear.askMarkdownPreviewSelection', () =>
      askWebviewSelection(store, panel, 'markdown-preview'),
    ),
  );
}

export function deactivate(): void {}
