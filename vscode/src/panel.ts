import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { QueueStore, QueueItem } from './queue';
import { Decorations } from './decorations';
import { locateAnchor, rangeFromOffsets } from './anchors';
import { copyPrompt, sendToSidebar } from './send';

export class DogearPanel implements vscode.WebviewViewProvider {
  static readonly viewId = 'dogear.queue';
  private view: vscode.WebviewView | undefined;

  constructor(
    private context: vscode.ExtensionContext,
    private store: QueueStore,
    private decorations: Decorations,
  ) {
    context.subscriptions.push(store.onDidChange(() => this.pushState()));
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.file(path.join(this.context.extensionPath, 'media'))],
    };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((msg) => this.onMessage(msg));
    this.pushState();
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
        promptLang: this.context.globalState.get<string>('promptLang'),
        hotkeyHint: process.platform === 'darwin' ? '⌃⌥Q' : 'Ctrl+Alt+Q',
      });
    }
  }

  private async onMessage(msg: any): Promise<void> {
    switch (msg.type) {
      case 'ready':
        this.pushState();
        break;
      case 'save':
        await this.store.set(msg.queue);
        break;
      case 'setLang':
        await this.context.globalState.update('promptLang', msg.lang);
        break;
      case 'copy':
        await copyPrompt(msg.prompt);
        this.note('Prompt copied — paste it into any chat.');
        break;
      case 'send':
        await sendToSidebar(msg.target, msg.prompt);
        break;
      case 'clear': {
        const n = this.store.get().length;
        if (!n) break;
        const ok = await vscode.window.showWarningMessage(
          `Remove all ${n} ${n > 1 ? 'queries' : 'query'}?`,
          { modal: true },
          'Remove all',
        );
        if (ok === 'Remove all') await this.store.set([]);
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
    const scripts = ['theme.js', 'prompts/index.js', ...packs.map((f) => `prompts/${f}`), 'sidepanel.js']
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
