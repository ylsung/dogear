import * as vscode from 'vscode';

type ChatTarget = 'claude' | 'codex';

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

export async function copyPrompt(prompt: string): Promise<void> {
  await vscode.env.clipboard.writeText(prompt);
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
export async function sendToSidebar(target: string, prompt: string): Promise<void> {
  if (target !== 'claude' && target !== 'codex') return;
  const sidebar = SIDEBAR_TARGETS[target];

  await vscode.env.clipboard.writeText(prompt);

  if (!vscode.extensions.getExtension(sidebar.extensionId)) {
    vscode.window.showWarningMessage(
      `Dogear: ${sidebar.label} is not installed. The prompt was copied to the clipboard.`,
    );
    return;
  }

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
    `Dogear: prompt pasted into ${sidebar.label}. Review it, then send when ready. If the composer stayed empty, press ${pasteKey}.`,
  );
}
