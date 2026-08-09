import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { QueueStore } from './queue';
import { locateAnchor, rangeFromOffsets } from './anchors';

// theme.js is a plain script that assigns to globalThis; evaluate it with a
// shadowed global to read the same tokens the webview uses.
export function loadTheme(extensionPath: string): any {
  try {
    const src = fs.readFileSync(path.join(extensionPath, 'media', 'theme.js'), 'utf8');
    const sandbox: any = {};
    new Function('globalThis', src)(sandbox);
    return sandbox.DOGEAR_THEME;
  } catch {
    return { colors: { highlight: 'rgba(249, 115, 22, 0.35)' } };
  }
}

export class Decorations {
  private markType: vscode.TextEditorDecorationType;
  private flashType: vscode.TextEditorDecorationType;
  private debounce: NodeJS.Timeout | undefined;

  constructor(
    private store: QueueStore,
    context: vscode.ExtensionContext,
  ) {
    const highlight = loadTheme(context.extensionPath).colors.highlight;
    this.markType = vscode.window.createTextEditorDecorationType({
      backgroundColor: highlight,
      borderRadius: '2px',
    });
    this.flashType = vscode.window.createTextEditorDecorationType({
      backgroundColor: highlight,
      border: `1px solid ${loadTheme(context.extensionPath).colors.primary || '#1d4ed8'}`,
    });

    context.subscriptions.push(
      this.markType,
      this.flashType,
      vscode.window.onDidChangeActiveTextEditor(() => this.refreshAll()),
      vscode.workspace.onDidChangeTextDocument((e) => this.refreshSoon(e.document)),
      store.onDidChange(() => this.refreshAll()),
    );
    this.refreshAll();
  }

  private refreshSoon(doc: vscode.TextDocument): void {
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.refresh(doc), 300);
  }

  refreshAll(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      this.refresh(editor.document);
    }
  }

  // Highlight every anchored selection in this document. When an edit moved
  // an anchor, write the corrected offsets/lines back so the sidebar's line
  // numbers stay honest (guarded by "only save on actual change" so the
  // resulting store event can't loop).
  private refresh(doc: vscode.TextDocument): void {
    const editors = vscode.window.visibleTextEditors.filter(
      (e) => e.document.uri.toString() === doc.uri.toString(),
    );
    if (!editors.length) return;

    const items = this.store.itemsFor(doc.uri);
    const ranges: vscode.Range[] = [];
    let moved = false;

    for (const item of items) {
      if (item.surface === 'image') continue;
      const loc = locateAnchor(doc, item.anchor);
      if (!loc) continue; // anchor lost (text deleted/rewritten): no highlight
      ranges.push(rangeFromOffsets(doc, loc));
      const lines = {
        start: doc.positionAt(loc.start).line + 1,
        end: doc.positionAt(loc.end).line + 1,
      };
      if (loc.start !== item.anchor.start || loc.end !== item.anchor.end) {
        item.anchor.start = loc.start;
        item.anchor.end = loc.end;
        item.lines = lines;
        moved = true;
      }
    }

    for (const editor of editors) editor.setDecorations(this.markType, ranges);

    if (moved) {
      const queue = this.store.get();
      const byId = new Map(items.map((x) => [x.id, x]));
      void this.store.set(queue.map((x) => byId.get(x.id) || x));
    }
  }

  flash(editor: vscode.TextEditor, range: vscode.Range): void {
    editor.setDecorations(this.flashType, [range]);
    setTimeout(() => editor.setDecorations(this.flashType, []), 900);
  }
}
