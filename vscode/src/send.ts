import * as vscode from 'vscode';
import { execFile } from 'child_process';

// Neither the Claude Code nor Codex VSCode extensions expose a "prefill the
// chat panel" command (anthropics/claude-code#27873). Reuse a matching CLI
// terminal so its conversation survives, and write without a newline so the
// user can review/edit the prompt before pressing Enter. Clipboard is the
// fallback when the CLI isn't installed.

const CLI_LABELS: Record<string, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
};

const cliPathCache = new Map<string, string | null>();
const NEW_TERMINAL_STARTUP_MS: Record<string, number> = {
  claude: 1200,
  // Codex initializes its full-screen composer after the process itself has
  // started; input sent earlier can be partially consumed during startup.
  codex: 2500,
};

function terminalInput(target: string, prompt: string): string {
  if (target !== 'codex') return prompt;
  // VS Code's Terminal.sendText sends embedded newlines as literal Enter
  // keystrokes. Codex therefore submits a multiline prompt one line at a
  // time unless it is marked as a bracketed paste. These markers are the
  // standard terminal protocol used by normal Cmd/Ctrl+V paste operations.
  return `\x1b[200~${prompt}\x1b[201~`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function findCli(name: string): Promise<string | null> {
  if (cliPathCache.has(name)) return Promise.resolve(cliPathCache.get(name)!);
  const finder = process.platform === 'win32' ? 'where' : 'which';
  return new Promise((resolve) => {
    execFile(finder, [name], (err, stdout) => {
      const p = err ? null : stdout.split(/\r?\n/)[0].trim() || null;
      cliPathCache.set(name, p);
      resolve(p);
    });
  });
}

export async function copyPrompt(prompt: string): Promise<void> {
  await vscode.env.clipboard.writeText(prompt);
}

export async function sendToCli(target: string, prompt: string): Promise<void> {
  const label = CLI_LABELS[target];
  if (!label) return;
  const cli = await findCli(target);
  if (!cli) {
    await vscode.env.clipboard.writeText(prompt);
    vscode.window.showWarningMessage(
      `Dogear: \`${target}\` CLI not found on PATH — prompt copied to clipboard, paste it into ${label} yourself.`,
    );
    return;
  }
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const matchesTarget = (terminal: vscode.Terminal): boolean => {
    const name = terminal.name.toLowerCase();
    return target === 'claude' ? name.includes('claude') : name.includes('codex');
  };
  const active = vscode.window.activeTerminal;
  let terminal =
    (active && matchesTarget(active) ? active : undefined) ||
    vscode.window.terminals.find(matchesTarget);
  const isNew = !terminal;
  if (!terminal) {
    terminal = vscode.window.createTerminal({ name: `Dogear → ${label}`, shellPath: cli, cwd });
  }

  terminal.show();
  if (isNew) {
    // createTerminal() returns before the pseudoterminal and CLI process are
    // attached. Await processId first so sendText cannot race process launch,
    // then allow the interactive Claude/Codex UI a brief startup window.
    await terminal.processId;
    await delay(NEW_TERMINAL_STARTUP_MS[target] ?? 1200);
    if (!vscode.window.terminals.includes(terminal)) return;
  }
  // addNewLine=false is intentional: submitting remains the user's action.
  terminal.sendText(terminalInput(target, prompt), false);
  vscode.window.showInformationMessage(
    `Dogear: prompt placed in ${label}. Review it, then press Enter to send.`,
  );
}
