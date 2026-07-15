import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Server as HttpServer } from 'http';
import { ReviewStore } from './reviewStore';
import { ReviewComments } from './comments';
import { ChangesTree } from './gitChanges';
import { startMcpServerOnFreePort } from './mcpServer';
import { ensureClaudeRegistration } from './claudeSetup';

let server: HttpServer | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length || !context.storageUri) return;
  const folderPaths = folders.map((f) => f.uri.fsPath);

  // Per-workspace extension storage: the review lives outside the repo
  const storageDir = context.storageUri.fsPath;
  migrateLegacyStores(folderPaths, storageDir);
  const store = new ReviewStore(storageDir, folderPaths[0]);
  const tree = new ChangesTree(store, context);
  // the tree owns the git state, so it decides where each thread is anchored
  // (deleted files anchor to the HEAD side of their diff)
  new ReviewComments(store, context, {
    uriFor: (t) => tree.threadUri(t),
    onDidChange: tree.onGitChange,
  });

  const basePort = vscode.workspace.getConfiguration('zamview').get<number>('port', 7317);
  let url: string | undefined;
  let port: number | undefined;
  try {
    const started = await startMcpServerOnFreePort(store, basePort, folderPaths);
    server = started.server;
    port = started.port;
    url = `http://localhost:${port}/mcp`;
  } catch (err) {
    vscode.window.showErrorMessage(
      `ZamView: could not start the MCP server (${err instanceof Error ? err.message : String(err)}).`
    );
  }

  // User-level Claude Code slash command (~/.claude/commands): the send
  // button types just "/zamview" instead of a wall of text
  const slashCommandInstalled = installSlashCommand();

  context.subscriptions.push(
    vscode.commands.registerCommand('zamview.copyMcpCommand', async () => {
      if (!url) return;
      const addCmd = `claude mcp add --transport http zamview ${url}`;
      await vscode.env.clipboard.writeText(addCmd);
      vscode.window.showInformationMessage(`Copied: ${addCmd}`);
    }),
    vscode.commands.registerCommand('zamview.setupClaude', () => {
      if (url) {
        const current = vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [];
        void registerWithClaude(context, current, url, true);
      }
    }),
    vscode.commands.registerCommand('zamview.finishReview', () =>
      finishReview(store, slashCommandInstalled)
    )
  );

  if (url && port !== undefined) {
    const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
    status.text = `$(comment-discussion) ZamView :${port}`;
    status.tooltip = `ZamView MCP server at ${url}\nClick to copy the registration command`;
    status.command = 'zamview.copyMcpCommand';
    status.show();
    context.subscriptions.push(status);

    void registerWithClaude(context, folderPaths, url, false);
    // Folders added to the workspace after startup get registered too
    context.subscriptions.push(
      vscode.workspace.onDidChangeWorkspaceFolders((e) => {
        const added = e.added.map((f) => f.uri.fsPath);
        if (added.length && url) void registerWithClaude(context, added, url, false);
      })
    );
  }
}

export function deactivate(): void {
  server?.close();
}

/**
 * Transparent registration: `claude mcp add` at local scope stores the config
 * in the user's ~/.claude.json, keyed by project path — nothing is ever
 * written inside the repo. In multi-root workspaces every folder is
 * registered, so the server is available wherever claude is launched.
 */
async function registerWithClaude(
  context: vscode.ExtensionContext,
  folderPaths: string[],
  url: string,
  manual: boolean
): Promise<void> {
  let registeredAny = false;
  for (const folder of folderPaths) {
    const result = await ensureClaudeRegistration(folder, url);
    if (result === 'registered') registeredAny = true;
    if (result === 'no-cli' || result === 'failed') {
      await warnRegistrationFailed(context, result, url, manual);
      return;
    }
  }

  const notified = context.workspaceState.get<boolean>('zamview.registrationNotified');
  if (registeredAny && (manual || !notified)) {
    const scope = folderPaths.length > 1 ? `all ${folderPaths.length} workspace folders` : 'this project';
    vscode.window.showInformationMessage(
      `ZamView: MCP server registered with Claude Code for ${scope} (stored in your user config — nothing was added to any repo). Restart claude if it was already running.`
    );
    await context.workspaceState.update('zamview.registrationNotified', true);
  } else if (manual && !registeredAny) {
    vscode.window.showInformationMessage(
      'ZamView: MCP server already registered with Claude Code for every workspace folder.'
    );
  }
}

async function warnRegistrationFailed(
  context: vscode.ExtensionContext,
  result: 'no-cli' | 'failed',
  url: string,
  manual: boolean
): Promise<void> {
  const notified = context.workspaceState.get<boolean>('zamview.registrationNotified');
  if (!manual && notified) return;
  const reason =
    result === 'no-cli' ? 'the claude CLI was not found in PATH' : 'the claude CLI returned an error';
  const pick = await vscode.window.showWarningMessage(
    `ZamView: could not register the MCP server automatically (${reason}). You can register it manually.`,
    'Copy command'
  );
  if (pick) {
    await vscode.env.clipboard.writeText(`claude mcp add --transport http zamview ${url}`);
  }
  await context.workspaceState.update('zamview.registrationNotified', true);
}

const REVIEW_INSTRUCTIONS =
  'I have finished reviewing your changes with ZamView and left comments for you. ' +
  'Read them with the get_review_comments tool of the "zamview" MCP server. ' +
  'Each comment includes the absolute folder of the repo it belongs to — only act on the ones inside the project you are working in, and tell me if any belong to a repo you cannot access. ' +
  'For each comment: if you agree, apply the fix and call resolve_comment with a short note of what you did; ' +
  'if you disagree or have doubts, make your case with reply_to_comment and leave it pending. ' +
  "When you're done, give me a summary of what you resolved and what's still under discussion.";

async function finishReview(store: ReviewStore, slashCommand: boolean): Promise<void> {
  const pending = store.list('pending');
  if (pending.length === 0) {
    vscode.window.showInformationMessage('ZamView: no pending comments.');
    return;
  }

  const message = slashCommand ? '/zamview' : REVIEW_INSTRUCTIONS;
  const terminal = vscode.window.activeTerminal ?? vscode.window.terminals[0];
  if (!terminal) {
    const pick = await vscode.window.showWarningMessage(
      'ZamView: there is no open terminal to notify the AI.',
      'Copy prompt'
    );
    if (pick) await vscode.env.clipboard.writeText(REVIEW_INSTRUCTIONS);
    return;
  }
  terminal.show(true);
  // The Enter goes in a separate, delayed send: attached to the text, TUIs
  // (Claude Code included) treat it as part of the paste and never submit
  terminal.sendText(message, false);
  setTimeout(() => terminal.sendText('\r', false), 300);
  vscode.window.setStatusBarMessage(`ZamView: review sent to terminal "${terminal.name}"`, 5000);
}

/**
 * Installs the /zamview slash command at user level (~/.claude/commands),
 * outside any repo. Rewritten on every activation to keep it in sync with
 * the extension.
 */
function installSlashCommand(): boolean {
  const content =
    '---\n' +
    'description: Address pending ZamView code-review comments\n' +
    '---\n' +
    REVIEW_INSTRUCTIONS + '\n';
  try {
    const claudeDir = path.join(os.homedir(), '.claude');
    // Claude Code users only: without ~/.claude, "/zamview" would mean nothing
    // to whatever agent runs in the terminal — the send button then falls back
    // to typing the full instructions instead
    if (!fs.existsSync(claudeDir)) return false;
    const dir = path.join(claudeDir, 'commands');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'zamview.md'), content, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * Older versions stored the review in <folder>/.zamview/review.json. The
 * reviews of all workspace folders are merged into internal storage
 * (renumbering ids to avoid collisions) and the leftovers cleaned up.
 */
function migrateLegacyStores(folderPaths: string[], storageDir: string): void {
  const newFile = path.join(storageDir, 'review.json');
  try {
    if (fs.existsSync(newFile)) return;
    const threads: Array<Record<string, unknown>> = [];
    let seq = 0;
    for (const folder of folderPaths) {
      const legacyFile = path.join(folder, '.zamview', 'review.json');
      if (!fs.existsSync(legacyFile)) continue;
      const raw = JSON.parse(fs.readFileSync(legacyFile, 'utf8'));
      for (const t of raw.threads ?? []) {
        threads.push({ ...t, id: `c${++seq}`, folder: t.folder ?? folder });
      }
      fs.rmSync(legacyFile);
      try {
        fs.rmdirSync(path.dirname(legacyFile)); // only removes the dir if it ended up empty
      } catch {
        // it had other content: leave it
      }
    }
    if (!threads.length) return;
    fs.mkdirSync(storageDir, { recursive: true });
    fs.writeFileSync(newFile, JSON.stringify({ seq, threads }, null, 2) + '\n', 'utf8');
  } catch {
    // best effort: if anything fails, the old review stays where it was
  }
}
