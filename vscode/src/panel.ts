import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { QueueStore, QueueItem, UserMessage, assetIdsOf, coalesceParts } from './queue';
import { AssetStore } from './assets';
import { Decorations } from './decorations';
import { locateAnchor, rangeFromOffsets } from './anchors';
import { copyPrompt, DeliveryAsset, sendToSidebar } from './send';

export class DogearPanel implements vscode.WebviewViewProvider {
  static readonly viewId = 'dogear.queue';
  private static readonly maxAssetBytes = 15 * 1024 * 1024;
  private view: vscode.WebviewView | undefined;
  private viewWaiters: Array<() => void> = [];
  private messageMutation = Promise.resolve();
  private pendingComposition:
    | { resolve: (message: UserMessage | undefined) => void; assetIds: Set<string> }
    | undefined;

  constructor(
    private context: vscode.ExtensionContext,
    private store: QueueStore,
    private assets: AssetStore,
    private decorations: Decorations,
  ) {
    context.subscriptions.push(store.onDidChange(() => this.pushState()));
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.file(path.join(this.context.extensionPath, 'media')),
        this.assets.root,
      ],
    };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((msg) => {
      this.messageMutation = this.messageMutation
        .then(() => this.onMessage(msg))
        .catch((error) => {
          console.error('Dogear panel message failed:', error);
          this.note('Dogear could not save that change. Please try again.');
        });
    });
    view.onDidDispose(() => {
      if (this.view === view) this.view = undefined;
      void this.cancelComposition();
    });
    this.viewWaiters.splice(0).forEach((resolve) => resolve());
    this.pushState();
  }

  async compose(title: string): Promise<UserMessage | undefined> {
    if (this.pendingComposition) await this.cancelComposition();
    try {
      await this.reveal();
    } catch {
      vscode.window.showWarningMessage('Dogear: could not open the question composer.');
      return undefined;
    }
    return new Promise((resolve) => {
      this.pendingComposition = { resolve, assetIds: new Set() };
      this.view?.webview.postMessage({ type: 'compose', title });
    });
  }

  private async reveal(): Promise<void> {
    if (!this.view) {
      await vscode.commands.executeCommand(`${DogearPanel.viewId}.focus`);
    }
    if (this.view) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Dogear sidebar did not open.')), 3000);
      this.viewWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private async cancelComposition(): Promise<void> {
    const pending = this.pendingComposition;
    if (!pending) return;
    this.pendingComposition = undefined;
    pending.resolve(undefined);
    const referenced = this.store.get().flatMap((item) =>
      item.message.parts
        .filter((part) => part.type === 'asset')
        .map((part) => part.assetId),
    );
    await this.assets.removeUnreferenced(referenced);
  }

  private note(msg: string): void {
    this.view?.webview.postMessage({ type: 'note', msg });
  }

  private pushState(): void {
    const queue = this.store.get();
    if (this.view) {
      this.view.badge = queue.length
        ? { value: queue.length, tooltip: `${queue.length} queued queries` }
        : undefined;
      this.view.webview.postMessage({
        type: 'state',
        queue,
        assets: this.assetPreviews(),
        promptLang: this.context.globalState.get<string>('promptLang'),
        hotkeyHint: process.platform === 'darwin' ? '⌃⌥Q' : 'Ctrl+Alt+Q',
      });
    }
  }

  private assetPreviews(): Record<string, string> {
    if (!this.view) return {};
    return Object.fromEntries(
      this.assets.all().flatMap((asset) => {
        const uri = this.assets.uri(asset);
        return uri ? [[asset.id, this.view!.webview.asWebviewUri(uri).toString()]] : [];
      }),
    );
  }

  private respond(requestId: string, result?: unknown, error?: string): void {
    this.view?.webview.postMessage({ type: 'response', requestId, result, error });
  }

  private deliveryAssets(ids: unknown): DeliveryAsset[] {
    if (!Array.isArray(ids)) return [];
    const unique = [...new Set(ids.filter((id): id is string => typeof id === 'string'))];
    return unique.flatMap((id, index) => {
      const uri = this.assets.uri(id);
      return uri ? [{ id, label: `Image I${index + 1}`, uri }] : [];
    });
  }

  private async storeAsset(msg: any): Promise<void> {
    const requestId = String(msg.requestId || '');
    try {
      if (typeof msg.base64 !== 'string' || !String(msg.mediaType).startsWith('image/')) {
        throw new Error('Dogear only accepts image attachments here.');
      }
      if (msg.base64.length > Math.ceil(DogearPanel.maxAssetBytes * 4 / 3) + 8) {
        throw new Error('Image is larger than 15 MB.');
      }
      const bytes = Buffer.from(msg.base64, 'base64');
      if (bytes.byteLength > DogearPanel.maxAssetBytes) {
        throw new Error('Image is larger than 15 MB.');
      }
      const asset = await this.assets.put(bytes, {
        mediaType: msg.mediaType,
        displayName: String(msg.displayName || 'image'),
      });
      this.pendingComposition?.assetIds.add(asset.id);
      const uri = this.assets.uri(asset);
      this.respond(requestId, {
        id: asset.id,
        mimeType: asset.mediaType,
        displayName: asset.displayName,
        previewUrl: uri ? this.view?.webview.asWebviewUri(uri).toString() : undefined,
      });
    } catch (error) {
      this.respond(requestId, undefined, error instanceof Error ? error.message : 'Could not store image.');
    }
  }

  private async onMessage(msg: any): Promise<void> {
    switch (msg.type) {
      case 'ready':
        this.pushState();
        break;
      case 'storeAsset':
        await this.storeAsset(msg);
        break;
      case 'composeSubmit': {
        const pending = this.pendingComposition;
        if (!pending) break;
        const parts = coalesceParts(Array.isArray(msg.parts) ? msg.parts : []);
        const missing = parts.find(
          (part) => part.type === 'asset' && !this.assets.get(part.assetId),
        );
        if (missing) {
          this.note('One attached image is no longer available. Remove it and try again.');
          break;
        }
        this.pendingComposition = undefined;
        pending.resolve({ role: 'user', parts });
        break;
      }
      case 'composeCancel':
        await this.cancelComposition();
        break;
      case 'save':
        await this.store.set(msg.queue);
        await this.assets.removeUnreferenced(assetIdsOf(this.store.get()));
        break;
      case 'setLang':
        await this.context.globalState.update('promptLang', msg.lang);
        break;
      case 'copy':
        await copyPrompt(msg.prompt, this.deliveryAssets(msg.assetIds));
        this.note(msg.assetIds?.length
          ? 'Prompt copied with local image paths — attach the files if the destination cannot read them.'
          : 'Prompt copied — paste it into any chat.');
        break;
      case 'send':
        await sendToSidebar(msg.target, msg.prompt, this.deliveryAssets(msg.assetIds));
        break;
      case 'clear': {
        const n = this.store.get().length;
        if (!n) break;
        const ok = await vscode.window.showWarningMessage(
          `Remove all ${n} ${n > 1 ? 'queries' : 'query'}?`,
          { modal: true },
          'Remove all',
        );
        if (ok === 'Remove all') {
          await this.store.set([]);
          await this.assets.removeUnreferenced([]);
        }
        break;
      }
      case 'openSource':
        await this.openSource(msg.id);
        break;
    }
  }

  private async openSource(id: string): Promise<void> {
    const item = this.store.get().find((x) => x.id === id);
    if (!item) return;
    if (item.surface === 'image') {
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(item.url));
      return;
    }
    if (item.surface === 'codex-chat') {
      await vscode.commands.executeCommand('chatgpt.openSidebar');
      return;
    }
    if (item.surface === 'claude-chat') {
      await vscode.commands.executeCommand('claude-vscode.sidebar.open');
      return;
    }
    if (item.surface === 'markdown-preview' && item.url.startsWith('dogear-webview:')) {
      await vscode.commands.executeCommand('markdown.showPreview');
      return;
    }
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(item.url));
      const editor = await vscode.window.showTextDocument(doc, { preview: false });
      const loc = locateAnchor(doc, item.anchor);
      if (loc) {
        const range = rangeFromOffsets(doc, loc);
        editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
        editor.selection = new vscode.Selection(range.start, range.start);
        this.decorations.flash(editor, range);
      }
    } catch {
      vscode.window.showWarningMessage(`Dogear: couldn't open ${item.title}.`);
    }
  }

  private html(webview: vscode.Webview): string {
    const media = (...p: string[]) =>
      webview.asWebviewUri(
        vscode.Uri.file(path.join(this.context.extensionPath, 'media', ...p)),
      );

    // Prompt packs: index.js must load before the language files it registers.
    const promptsDir = path.join(this.context.extensionPath, 'media', 'prompts');
    const packs = fs
      .readdirSync(promptsDir)
      .filter((f) => f.endsWith('.js') && f !== 'index.js')
      .sort();
    const scripts = [
      'theme.js',
      'model.js',
      'composer.js',
      'prompts/index.js',
      ...packs.map((f) => `prompts/${f}`),
      'sidepanel.js',
    ]
      .map((f) => `<script src="${media(...f.split('/'))}"></script>`)
      .join('\n  ');

    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
      `script-src ${webview.cspSource}`,
      `img-src ${webview.cspSource} data:`,
    ].join('; ');

    return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <style>
    @font-face { font-family: 'Lora'; font-weight: 400; font-style: normal;
      font-display: swap; src: url('${media('fonts', 'lora-400.woff2')}') format('woff2'); }
    @font-face { font-family: 'Lora'; font-weight: 600; font-style: normal;
      font-display: swap; src: url('${media('fonts', 'lora-600.woff2')}') format('woff2'); }
  </style>
  <link rel="stylesheet" href="${media('sidepanel.css')}" />
</head>
<body>
  <header>
    <h1 id="brand">Dogear</h1>
    <span id="count"></span>
  </header>

  <section id="capture-composer" hidden>
    <div class="capture-title" id="capture-title"></div>
    <div id="capture-editor" data-placeholder="Type a question, paste an image, or drop one here…"></div>
    <input id="capture-images" type="file" accept="image/*" multiple hidden />
    <div class="capture-actions">
      <button id="capture-add-image" title="Attach one or more images">＋ Image</button>
      <span class="capture-action-spacer"></span>
      <button id="capture-cancel">Cancel</button>
      <button id="capture-submit" class="primary">Add to queue</button>
    </div>
    <div class="capture-hint"><kbd>⌘/Ctrl+Enter</kbd> add · <kbd>Esc</kbd> cancel</div>
  </section>

  <main id="list">
    <p class="empty" id="empty">
      Select text in any editor, press <kbd id="hotkey">…</kbd> (or right-click →
      “Dogear: Add query for selection”), and your anchored queries collect here.
      <br /><br />
      Click a card to select it (<kbd>Shift</kbd>/<kbd>⌘</kbd>-click for several), drag to reorder.
    </p>
  </main>

  <footer>
    <div class="actions">
      <button id="copy" title="Copy the composed prompt to the clipboard">Copy prompt</button>
      <button id="to-claude" title="Paste the composed prompt into the Claude Code sidebar without sending">→ Claude Code</button>
      <button id="to-codex" title="Paste the composed prompt into the Codex sidebar without sending">→ Codex</button>
      <button id="clear" class="danger" title="Remove all queries">Clear</button>
    </div>
    <div class="lang-row">
      <label for="lang">Prompt language</label>
      <select id="lang" title="Language used for the composed prompt sent to the AI — not the panel UI"></select>
    </div>
    <p class="note" id="note"></p>
  </footer>

  ${scripts}
</body>
</html>`;
  }
}
