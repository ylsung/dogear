import * as vscode from 'vscode';
import { QueueStore } from './queue';
import { composeQueue } from './compose';
import { copyPrompt, DeliveryAsset, sendToSidebar } from './send';
import { promptLang } from './settings';

// Queue actions behind the export / clear hotkeys, shared with the sidebar's
// own buttons so both paths behave the same.

export type ExportTarget = 'copy' | 'claude' | 'codex';

const TARGETS: Array<{ id: ExportTarget; label: string; icon: string }> = [
  { id: 'copy', label: 'Copy prompt', icon: 'copy' },
  { id: 'claude', label: '→ Claude Code', icon: 'arrow-right' },
  { id: 'codex', label: '→ Codex', icon: 'arrow-right' },
];

const LAST_TARGET_KEY = 'lastExportTarget';

export class QueueActions {
  private activePick: vscode.QuickPick<vscode.QuickPickItem & { target: ExportTarget }> | undefined;

  constructor(
    private context: vscode.ExtensionContext,
    private store: QueueStore,
    private deliveryAssets: (ids: readonly string[]) => DeliveryAsset[],
  ) {}

  /** Delivers an already composed prompt; the sidebar buttons call this too. */
  async deliver(target: ExportTarget, prompt: string, assetIds: readonly string[]): Promise<void> {
    await this.context.globalState.update(LAST_TARGET_KEY, target);
    const assets = this.deliveryAssets(assetIds);
    if (target === 'copy') {
      await copyPrompt(prompt, assets);
      vscode.window.setStatusBarMessage(
        assets.length
          ? 'Dogear: prompt copied with local image paths — attach the files if the destination cannot read them.'
          : 'Dogear: prompt copied — paste it into any chat.',
        5000,
      );
      return;
    }
    await sendToSidebar(target, prompt, assets);
  }

  /**
   * The export chooser: a quick pick with the sidebar's destinations. Number
   * keys pick directly, Enter takes the last-used one (pre-selected), and
   * running the command again while it is open does the same.
   */
  async exportPrompt(): Promise<void> {
    if (this.activePick) {
      const [item] = this.activePick.activeItems;
      if (item) this.runPick(item.target);
      return;
    }
    const queue = this.store.get();
    if (!queue.length) {
      vscode.window.setStatusBarMessage('Dogear: the queue is empty.', 4000);
      return;
    }
    const last = this.context.globalState.get<ExportTarget>(LAST_TARGET_KEY, 'copy');
    const pick = vscode.window.createQuickPick<vscode.QuickPickItem & { target: ExportTarget }>();
    const items = TARGETS.map((target, index) => ({
      label: `$(${target.icon}) ${target.label}`,
      description: `${index + 1}${target.id === last ? ' · last used' : ''}`,
      target: target.id,
    }));
    pick.title = `Dogear: send ${queue.length} ${queue.length === 1 ? 'question' : 'questions'}`;
    pick.placeholder = `Press 1–${items.length}, or Enter to send to the last used destination`;
    pick.items = items;
    pick.activeItems = items.filter((item) => item.target === last);
    pick.onDidChangeValue((value) => {
      const item = items[Number(value) - 1];
      if (/^[1-9]$/.test(value) && item) this.runPick(item.target);
    });
    pick.onDidAccept(() => {
      const [item] = pick.activeItems;
      if (item) this.runPick(item.target);
    });
    pick.onDidHide(() => {
      pick.dispose();
      if (this.activePick === pick) this.activePick = undefined;
    });
    this.activePick = pick;
    pick.show();
  }

  private runPick(target: ExportTarget): void {
    this.activePick?.hide();
    const queue = this.store.get();
    if (!queue.length) return;
    const { text, assets } = composeQueue(this.context.extensionPath, queue, promptLang(this.context));
    void this.deliver(target, text, assets.map((asset) => asset.id));
  }

  /** Clears without a confirmation dialog; the notification offers Undo. */
  async clearQueue(): Promise<void> {
    const cleared = await this.store.clear();
    if (!cleared) {
      vscode.window.setStatusBarMessage('Dogear: the queue is already empty.', 4000);
      return;
    }
    const choice = await vscode.window.showInformationMessage(
      `Dogear: cleared ${cleared} ${cleared === 1 ? 'question' : 'questions'}.`,
      'Undo',
    );
    if (choice === 'Undo') await this.undoClear();
  }

  async undoClear(): Promise<void> {
    const restored = await this.store.undoClear();
    vscode.window.setStatusBarMessage(
      restored
        ? `Dogear: restored ${restored} ${restored === 1 ? 'question' : 'questions'}.`
        : 'Dogear: nothing to restore.',
      4000,
    );
  }
}
