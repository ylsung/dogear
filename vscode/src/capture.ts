import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { execFile } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import { AssetStore } from './assets';
import { assetIdsOf, QueueItem, QueueStore, UserMessage } from './queue';

const CONTEXT_CHARS = 32; // same prefix/suffix window as the Chrome extension

type WebviewSurface = 'markdown-preview' | 'codex-chat' | 'claude-chat';

const WEBVIEW_META: Record<
  WebviewSurface,
  { title: string; url: string; languageId: string }
> = {
  'markdown-preview': {
    title: 'Markdown preview',
    url: 'dogear-webview://markdown/preview',
    languageId: 'markdown',
  },
  'codex-chat': {
    title: 'Codex conversation',
    url: 'dogear-webview://codex/conversation',
    languageId: 'plaintext',
  },
  'claude-chat': {
    title: 'Claude Code conversation',
    url: 'dogear-webview://claude/conversation',
    languageId: 'plaintext',
  },
};

function itemId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface QuestionComposer {
  compose(title: string, retainedAssetIds?: readonly string[]): Promise<UserMessage | undefined>;
}

// Webviews owned by another extension do not expose their DOM or Selection to
// Dogear. The workbench's copy command is the narrow supported bridge to the
// focused selection. Restore the previous clipboard immediately afterwards.
async function copyFocusedWebviewSelection(): Promise<string> {
  const before = await vscode.env.clipboard.readText();
  const sentinel = `dogear-no-selection-${Date.now()}-${Math.random()}`;
  await vscode.env.clipboard.writeText(sentinel);
  try {
    await vscode.commands.executeCommand('editor.action.clipboardCopyAction');
    await new Promise((resolve) => setTimeout(resolve, 75));
    const selected = await vscode.env.clipboard.readText();
    return selected === sentinel ? '' : selected.trim();
  } finally {
    await vscode.env.clipboard.writeText(before);
  }
}

export async function askWebviewSelection(
  store: QueueStore,
  composer: QuestionComposer,
  surface: WebviewSurface,
): Promise<void> {
  const exact = await copyFocusedWebviewSelection();
  if (!exact) {
    vscode.window.showInformationMessage(
      'Dogear: select some text in the view, then use the Dogear context-menu command again.',
    );
    return;
  }
  const meta = WEBVIEW_META[surface];
  const message = await composer.compose(meta.title);
  if (!message) return;
  await store.add({
    id: itemId(),
    url: meta.url,
    title: meta.title,
    selectedContext: [{ type: 'text', text: exact }],
    message,
    page: null,
    lines: null,
    languageId: meta.languageId,
    surface,
    createdAt: Date.now(),
    anchor: { exact, prefix: '', suffix: '', start: 0, end: exact.length },
  });
}

export async function askSelection(
  store: QueueStore,
  assets: AssetStore,
  composer: QuestionComposer,
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    await askScreenshotSelection(store, assets, composer);
    return;
  }
  const sel = editor.selection;
  const doc = editor.document;
  const exact = doc.getText(sel);
  if (!exact.trim()) {
    await askScreenshotSelection(store, assets, composer);
    return;
  }

  const title = vscode.workspace.asRelativePath(doc.uri);
  const message = await composer.compose(`${title}:${sel.start.line + 1}`);
  if (!message) return;

  const start = doc.offsetAt(sel.start);
  const end = doc.offsetAt(sel.end);
  const text = doc.getText();

  const item: QueueItem = {
    id: itemId(),
    url: doc.uri.toString(),
    title,
    selectedContext: [{ type: 'text', text: exact }],
    message,
    page: null,
    lines: { start: sel.start.line + 1, end: sel.end.line + 1 },
    languageId: doc.languageId,
    surface: 'editor',
    createdAt: Date.now(),
    anchor: {
      exact,
      prefix: text.slice(Math.max(0, start - CONTEXT_CHARS), start),
      suffix: text.slice(end, end + CONTEXT_CHARS),
      start,
      end,
    },
  };

  await store.add(item);
}

export async function askTab(
  store: QueueStore,
  composer: QuestionComposer,
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
  const title = editor
    ? vscode.workspace.asRelativePath(editor.document.uri)
    : activeTab?.label || 'VS Code tab';
  const message = await composer.compose(title);
  if (!message) return;

  const offset = editor ? editor.document.offsetAt(editor.selection.active) : 0;
  await store.add({
    id: itemId(),
    url: editor?.document.uri.toString() || 'dogear-tab://current',
    title,
    selectedContext: [],
    message,
    page: null,
    lines: null,
    languageId: editor?.document.languageId || 'plaintext',
    surface: editor ? 'editor' : 'tab',
    createdAt: Date.now(),
    anchor: { exact: '', prefix: '', suffix: '', start: offset, end: offset },
  });
}

function captureMacRegion(destination: vscode.Uri): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      '/usr/sbin/screencapture',
      ['-i', '-s', '-x', destination.fsPath],
      (error) => resolve(!error),
    );
  });
}

function screenshotName(): string {
  return `dogear-screenshot-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
}

export async function askScreenshotSelection(
  store: QueueStore,
  assets: AssetStore,
  composer: QuestionComposer,
): Promise<void> {
  // VS Code has no public region-capture API. A native capture is only safe
  // when the extension host is running locally on macOS; remote hosts cannot
  // see the user's desktop.
  if (process.platform !== 'darwin' || vscode.env.remoteName) {
    vscode.window.showInformationMessage(
      'Dogear: screen-region capture is only available in a local macOS window. Choose an existing screenshot instead.',
    );
    await askImageSelection(store, assets, composer);
    return;
  }

  const name = screenshotName();
  const destination = vscode.Uri.file(
    path.join(os.tmpdir(), `${crypto.randomUUID()}-${name}`),
  );
  try {
    if (!await captureMacRegion(destination)) return;
    try {
      const stat = await vscode.workspace.fs.stat(destination);
      if (!stat.size) return;
    } catch {
      return;
    }

    const asset = await assets.putUri(destination);
    const message = await composer.compose('Screenshot selection', [asset.id]);
    if (!message) {
      await assets.removeUnreferenced(assetIdsOf(store.get()));
      return;
    }
    const storedUri = assets.uri(asset);
    await store.add({
      id: itemId(),
      url: storedUri?.toString() || destination.toString(),
      title: 'Screenshot selection',
      selectedContext: [{
        type: 'asset',
        assetId: asset.id,
        mediaType: asset.mediaType,
        label: name,
      }],
      message,
      page: null,
      lines: null,
      languageId: 'image',
      surface: 'image',
      createdAt: Date.now(),
      anchor: { exact: '', prefix: '', suffix: '', start: 0, end: 0 },
    });
  } finally {
    try {
      await vscode.workspace.fs.delete(destination);
    } catch {
      // Cancellation and failed captures normally leave no temporary file.
    }
  }
}

export async function askImageSelection(
  store: QueueStore,
  assets: AssetStore,
  composer: QuestionComposer,
  resource?: vscode.Uri,
): Promise<void> {
  let uri = resource;
  if (!uri) {
    [uri] = await vscode.window.showOpenDialog({
      title: 'Choose an image for Dogear',
      openLabel: 'Use image',
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      filters: { Images: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'] },
    }) || [];
  }
  if (!uri) return;

  const asset = await assets.putUri(uri);
  if (!asset.mediaType.startsWith('image/')) {
    await assets.removeUnreferenced(assetIdsOf(store.get()));
    vscode.window.showWarningMessage('Dogear: choose a PNG, JPEG, GIF, WebP, BMP, or SVG image.');
    return;
  }

  const title = vscode.workspace.asRelativePath(uri, false);
  const message = await composer.compose(title, [asset.id]);
  if (!message) {
    await assets.removeUnreferenced(assetIdsOf(store.get()));
    return;
  }
  await store.add({
    id: itemId(),
    url: uri.toString(),
    title,
    selectedContext: [{
      type: 'asset',
      assetId: asset.id,
      mediaType: asset.mediaType,
      label: asset.displayName,
    }],
    message,
    page: null,
    lines: null,
    languageId: 'image',
    surface: 'image',
    createdAt: Date.now(),
    anchor: { exact: '', prefix: '', suffix: '', start: 0, end: 0 },
  });
}
