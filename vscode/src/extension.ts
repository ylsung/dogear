import * as vscode from 'vscode';
import { QueueStore } from './queue';
import {
  askSelection,
  askImageSelection,
  askScreenshotSelection,
  askTab,
  askWebviewSelection,
} from './capture';
import { Decorations } from './decorations';
import { DogearPanel } from './panel';
import { AssetStore } from './assets';
import { QueueActions } from './actions';
import { deliveryAssets } from './send';
import { migrateSettings } from './settings';

// The feedback form, with its Platform question prefilled.
const FEEDBACK_URL = 'https://docs.google.com/forms/d/e/1FAIpQLSdlqToT9hgAQiGizo-yyDEgoAse1_jptcYpOOjzHyVRojQ7tA/viewform'
  + '?usp=pp_url&entry.28375611=VSCode+Extension';

export function activate(context: vscode.ExtensionContext): void {
  void migrateSettings(context);
  const store = new QueueStore(context.workspaceState);
  const assets = new AssetStore(context);
  assets.retainAlso(() => store.clearedAssetIds());
  const decorations = new Decorations(store, context);
  const actions = new QueueActions(context, store, (ids) => deliveryAssets(assets, ids));
  const panel = new DogearPanel(context, store, assets, decorations, actions);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(DogearPanel.viewId, panel, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('dogear.askSelection', () => askSelection(store, assets, panel)),
    vscode.commands.registerCommand('dogear.askTab', () => askTab(store, panel)),
    vscode.commands.registerCommand('dogear.captureScreenshot', () =>
      askScreenshotSelection(store, assets, panel),
    ),
    vscode.commands.registerCommand('dogear.askImage', (uri?: vscode.Uri) =>
      askImageSelection(store, assets, panel, uri),
    ),
    vscode.commands.registerCommand('dogear.askCodexSelection', () =>
      askWebviewSelection(store, panel, 'codex-chat'),
    ),
    vscode.commands.registerCommand('dogear.askClaudeSelection', () =>
      askWebviewSelection(store, panel, 'claude-chat'),
    ),
    vscode.commands.registerCommand('dogear.askMarkdownPreviewSelection', () =>
      askWebviewSelection(store, panel, 'markdown-preview'),
    ),
    vscode.commands.registerCommand('dogear.exportPrompt', () => actions.exportPrompt()),
    vscode.commands.registerCommand('dogear.clearQueue', () => actions.clearQueue()),
    vscode.commands.registerCommand('dogear.undoClear', () => actions.undoClear()),
    vscode.commands.registerCommand('dogear.openQueue', () =>
      vscode.commands.executeCommand(`${DogearPanel.viewId}.focus`),
    ),
    vscode.commands.registerCommand('dogear.openSettings', () =>
      vscode.commands.executeCommand('workbench.action.openSettings', '@ext:ylsung.dogear-vscode'),
    ),
    vscode.commands.registerCommand('dogear.openShortcuts', () =>
      vscode.commands.executeCommand('workbench.action.openGlobalKeybindings', 'dogear.'),
    ),
    vscode.commands.registerCommand('dogear.sendFeedback', () =>
      vscode.env.openExternal(vscode.Uri.parse(FEEDBACK_URL)),
    ),
  );
}

export function deactivate(): void {}
