import * as vscode from 'vscode';
import { Anchor } from './queue';

// Re-anchoring after edits: same TextQuote strategy as the Chrome content
// script (exact match disambiguated by 32-char prefix/suffix), but against
// the flat document text — no DOM tree to walk.
export function locateAnchor(
  doc: vscode.TextDocument,
  anchor: Anchor,
): { start: number; end: number } | null {
  const text = doc.getText();

  if (text.slice(anchor.start, anchor.end) === anchor.exact) {
    return { start: anchor.start, end: anchor.end };
  }

  let best: number | null = null;
  let bestScore = -Infinity;
  let i = text.indexOf(anchor.exact);
  while (i !== -1) {
    let score = 0;
    if (anchor.prefix && text.slice(Math.max(0, i - anchor.prefix.length), i) === anchor.prefix) {
      score += 2;
    }
    const afterEnd = i + anchor.exact.length;
    if (anchor.suffix && text.slice(afterEnd, afterEnd + anchor.suffix.length) === anchor.suffix) {
      score += 2;
    }
    score += 1 / (1 + Math.abs(i - anchor.start)); // closest occurrence wins ties
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
    i = text.indexOf(anchor.exact, i + 1);
  }

  return best === null ? null : { start: best, end: best + anchor.exact.length };
}

export function rangeFromOffsets(
  doc: vscode.TextDocument,
  loc: { start: number; end: number },
): vscode.Range {
  return new vscode.Range(doc.positionAt(loc.start), doc.positionAt(loc.end));
}
