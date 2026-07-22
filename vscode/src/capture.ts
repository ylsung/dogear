import * as vscode from 'vscode';
import { QueueItem, QueueStore } from './queue';

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

async function askQuestion(title: string): Promise<string | undefined> {
  const question = await vscode.window.showInputBox({
    title: `Dogear — ${title}`,
    placeHolder: 'Your query about this selection…',
    prompt: 'Leave empty to fill in later from the Dogear sidebar.',
    // Markdown Preview hands selections to the extension through a vscode://
    // link opened in a separate target. Chromium briefly moves focus while
    // dispatching that link; without this, the input appears and immediately
    // dismisses itself. It is harmless for normal editor captures too.
    ignoreFocusOut: true,
  });
  return question === undefined ? undefined : question.trim();
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
  const question = await askQuestion(meta.title);
  if (question === undefined) return;
  await store.add({
    id: itemId(),
    url: meta.url,
    title: meta.title,
    question,
    page: null,
    lines: null,
    languageId: meta.languageId,
    surface,
    createdAt: Date.now(),
    anchor: { exact, prefix: '', suffix: '', start: 0, end: exact.length },
  });
}

export async function askSelection(store: QueueStore): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showInformationMessage('Dogear: open a file and select some text first.');
    return;
  }
  const sel = editor.selection;
  const doc = editor.document;
  const exact = doc.getText(sel);
  if (!exact.trim()) {
    vscode.window.showInformationMessage('Dogear: select some text first.');
    return;
  }

  const title = vscode.workspace.asRelativePath(doc.uri);
  const question = await askQuestion(`${title}:${sel.start.line + 1}`);
  if (question === undefined) return; // Esc = cancel, same as closing the popover

  const start = doc.offsetAt(sel.start);
  const end = doc.offsetAt(sel.end);
  const text = doc.getText();

  const item: QueueItem = {
    id: itemId(),
    url: doc.uri.toString(),
    title,
    question: question.trim(),
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
