import * as vscode from 'vscode';

type ChatTarget = 'claude' | 'codex';

export interface DeliveryAsset {
  id: string;
  label: string;
  uri: vscode.Uri;
}

interface SidebarTarget {
  extensionId: string;
  label: string;
  openCommand: string;
}

const SIDEBAR_TARGETS: Record<ChatTarget, SidebarTarget> = {
  claude: {
    extensionId: 'anthropic.claude-code',
    label: 'Claude Code',
    openCommand: 'claude-vscode.sidebar.open',
  },
  codex: {
    extensionId: 'openai.chatgpt',
    label: 'Codex',
    openCommand: 'chatgpt.openSidebar',
  },
};

function promptWithLocalPaths(prompt: string, assets: readonly DeliveryAsset[]): string {
  if (!assets.length) return prompt;
  const lines = assets.map((asset) => {
    // For remote workspaces, the coding agent runs on the extension-host side
    // and needs that host's filesystem path, not a vscode-remote:// UI URI.
    const location = asset.uri.scheme === 'file' ? asset.uri.fsPath : asset.uri.path;
    return `- ${asset.label}: ${location}`;
  });
  return `${prompt}\n\nLocal image files for the labels above:\n${lines.join('\n')}`;
}

export async function copyPrompt(
  prompt: string,
  assets: readonly DeliveryAsset[] = [],
): Promise<void> {
  await vscode.env.clipboard.writeText(promptWithLocalPaths(prompt, assets));
}

export async function attachToCodex(
  assets: readonly DeliveryAsset[],
): Promise<{ attachedIds: string[]; unavailable: boolean }> {
  if (!vscode.extensions.getExtension(SIDEBAR_TARGETS.codex.extensionId)) {
    return { attachedIds: [], unavailable: true };
  }
  const attachedIds: string[] = [];
  for (const asset of assets) {
    try {
      await vscode.commands.executeCommand('chatgpt.addFileToThread', asset.uri);
      attachedIds.push(asset.id);
    } catch {
      // Return partial progress so the manual handoff can retry failed files.
    }
  }
  return { attachedIds, unavailable: false };
}

/**
 * Put a prompt on the clipboard, focus the requested extension's sidebar, and
 * invoke VS Code's paste command in the focused webview.
 *
 * Claude Code and Codex currently expose commands for opening their sidebars,
 * but neither exposes its composer directly. VS Code's global clipboard
 * command is the supported bridge to a focused webview; it inserts the text
 * without synthesizing Enter, so submitting remains an explicit user action.
 */
export async function sendToSidebar(
  target: string,
  prompt: string,
  assets: readonly DeliveryAsset[] = [],
): Promise<void> {
  if (target !== 'claude' && target !== 'codex') return;
  const sidebar = SIDEBAR_TARGETS[target];
  const fallbackPrompt = promptWithLocalPaths(prompt, assets);

  if (!vscode.extensions.getExtension(sidebar.extensionId)) {
    await vscode.env.clipboard.writeText(fallbackPrompt);
    vscode.window.showWarningMessage(
      `Dogear: ${sidebar.label} is not installed. The prompt was copied to the clipboard.`,
    );
    return;
  }

  let attached = 0;
  if (target === 'codex') {
    attached = (await attachToCodex(assets)).attachedIds.length;
  }

  const deliveredPrompt = target === 'codex' && attached === assets.length
    ? prompt
    : fallbackPrompt;
  await vscode.env.clipboard.writeText(deliveredPrompt);

  try {
    await vscode.commands.executeCommand(sidebar.openCommand);
  } catch {
    vscode.window.showWarningMessage(
      `Dogear: couldn't open the ${sidebar.label} sidebar. The prompt was copied to the clipboard.`,
    );
    return;
  }

  // View focus completes asynchronously after the open command. Give the
  // webview a moment to focus its composer before routing the global paste.
  await new Promise((resolve) => setTimeout(resolve, 150));

  try {
    await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
  } catch {
    const pasteKey = process.platform === 'darwin' ? '⌘V' : 'Ctrl+V';
    vscode.window.showWarningMessage(
      `Dogear: couldn't paste into ${sidebar.label}. The prompt is copied; press ${pasteKey} to paste it.`,
    );
    return;
  }

  const pasteKey = process.platform === 'darwin' ? '⌘V' : 'Ctrl+V';
  vscode.window.showInformationMessage(
    `Dogear: prompt${attached ? ` and ${attached} ${attached === 1 ? 'image' : 'images'}` : ''} ` +
      `pasted into ${sidebar.label}. Review it, then send when ready. ` +
      `If the composer stayed empty, press ${pasteKey}.`,
  );
}
