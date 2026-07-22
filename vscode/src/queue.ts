import * as vscode from 'vscode';

// Mirrors the Chrome extension's queue item shape (see extension/content.js)
// so the ported side panel and prompt composer work unchanged. `url` is the
// document URI string; `title` is the workspace-relative path.
export interface Anchor {
  exact: string;
  prefix: string;
  suffix: string;
  start: number; // character offsets into document.getText()
  end: number;
}

export interface QueueItem {
  id: string;
  url: string;
  title: string;
  question: string;
  page: number | null; // always null in VSCode; kept for compose parity
  lines: { start: number; end: number } | null; // 1-based; null for chat excerpts
  languageId: string;
  surface?: 'editor' | 'markdown-preview' | 'codex-chat' | 'claude-chat';
  createdAt: number;
  anchor: Anchor;
}

const KEY = 'queue';

// Per-workspace queue on workspaceState, with a change event so the sidebar,
// badge, and decorations all refresh from one place.
export class QueueStore {
  private emitter = new vscode.EventEmitter<QueueItem[]>();
  readonly onDidChange = this.emitter.event;

  constructor(private state: vscode.Memento) {}

  get(): QueueItem[] {
    return this.state.get<QueueItem[]>(KEY, []);
  }

  async set(queue: QueueItem[]): Promise<void> {
    await this.state.update(KEY, queue);
    this.emitter.fire(queue);
  }

  // Grouped insertion, same rule as the Chrome extension: a new item lands
  // right after the last existing item from the same document.
  async add(item: QueueItem): Promise<void> {
    const queue = this.get();
    let idx = queue.length;
    for (let i = queue.length - 1; i >= 0; i--) {
      if (queue[i].url === item.url) {
        idx = i + 1;
        break;
      }
    }
    queue.splice(idx, 0, item);
    await this.set(queue);
  }

  itemsFor(uri: vscode.Uri): QueueItem[] {
    const url = uri.toString();
    return this.get().filter((x) => x.url === url);
  }
}
