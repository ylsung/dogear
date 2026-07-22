import * as vscode from 'vscode';
import { QueueStore } from './queue';
import {
  askSelection,
  askWebviewSelection,
} from './capture';
import { Decorations } from './decorations';
import { DogearPanel } from './panel';

export function activate(context: vscode.ExtensionContext): void {
  const store = new QueueStore(context.workspaceState);
  const decorations = new Decorations(store, context);
  const panel = new DogearPanel(context, store, decorations);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(DogearPanel.viewId, panel, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    // No auto-focus of the sidebar after adding: capture should keep you in
    // the editor (the view badge shows the growing count instead).
    vscode.commands.registerCommand('dogear.askSelection', () => askSelection(store)),
    vscode.commands.registerCommand('dogear.askCodexSelection', () =>
      askWebviewSelection(store, 'codex-chat'),
    ),
    vscode.commands.registerCommand('dogear.askClaudeSelection', () =>
      askWebviewSelection(store, 'claude-chat'),
    ),
    vscode.commands.registerCommand('dogear.askMarkdownPreviewSelection', () =>
      askWebviewSelection(store, 'markdown-preview'),
    ),
  );
}

export function deactivate(): void {}
