import * as vscode from 'vscode';
import * as path from 'path';
import { ReviewStore, ReviewThread } from './reviewStore';

// Minimal typing of the vscode.git extension's public API (v1)
interface GitChange {
  uri: vscode.Uri; // for renames this is the NEW path (uri === renameUri)
  originalUri?: vscode.Uri; // pre-rename path, needed to look the file up in HEAD
  status: number;
}
interface GitRepositoryState {
  workingTreeChanges: GitChange[];
  indexChanges: GitChange[];
  untrackedChanges?: GitChange[];
  onDidChange: vscode.Event<void>;
}
interface GitRepository {
  rootUri: vscode.Uri;
  state: GitRepositoryState;
}
interface GitApi {
  repositories: GitRepository[];
  onDidOpenRepository: vscode.Event<GitRepository>;
  toGitUri(uri: vscode.Uri, ref: string): vscode.Uri;
}

// Values of the vscode.git Status enum
const ADDED_STATUSES = [1, 7, 9]; // INDEX_ADDED, UNTRACKED, INTENT_TO_ADD
const DELETED_STATUSES = [2, 6]; // INDEX_DELETED, DELETED
const RENAMED_STATUSES = [3, 10]; // INDEX_RENAMED, INTENT_TO_RENAME

function statusLetter(status: number): string {
  if (ADDED_STATUSES.includes(status)) return 'A';
  if (DELETED_STATUSES.includes(status)) return 'D';
  if (RENAMED_STATUSES.includes(status)) return 'R';
  return 'M';
}

type Node = FolderNode | FileNode | ThreadNode;
interface FolderNode {
  kind: 'folder';
  uri: vscode.Uri;
  files: FileNode[];
}
interface FileNode {
  kind: 'file';
  uri: vscode.Uri;
  folder: string; // absolute path of the workspace folder containing it
  rel: string; // path relative to that folder
  status?: number;
  originalUri?: vscode.Uri;
  threads: ReviewThread[];
}
interface ThreadNode {
  kind: 'thread';
  thread: ReviewThread;
}

export class ChangesTree implements vscode.TreeDataProvider<Node> {
  private emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  // fires when git state changes, so thread anchors can be recomputed
  private gitEmitter = new vscode.EventEmitter<void>();
  readonly onGitChange = this.gitEmitter.event;
  private git: GitApi | undefined;

  constructor(
    private store: ReviewStore,
    private context: vscode.ExtensionContext
  ) {
    context.subscriptions.push(
      vscode.window.createTreeView('zamviewChanges', { treeDataProvider: this }),
      vscode.workspace.registerTextDocumentContentProvider('zamview-empty', {
        provideTextDocumentContent: () => '',
      }),
      vscode.commands.registerCommand('zamview.refresh', () => this.refresh()),
      vscode.commands.registerCommand(
        'zamview.openDiff',
        (uri: vscode.Uri, status?: number, originalUri?: vscode.Uri) =>
          this.openDiff(uri, status, originalUri)
      ),
      vscode.commands.registerCommand('zamview.openThread', (id: string) => this.openThread(id)),
      // safety net: a thread whose file is gone cannot be reached through the
      // comment widget, so the human verbs are also available from the tree
      vscode.commands.registerCommand('zamview.reopenThreadFromTree', (n: ThreadNode) =>
        this.store.setStatus(n.thread.id, 'pending')
      ),
      vscode.commands.registerCommand('zamview.closeThreadFromTree', (n: ThreadNode) =>
        this.store.setStatus(n.thread.id, 'closed')
      ),
      vscode.commands.registerCommand('zamview.deleteThreadFromTree', (n: ThreadNode) =>
        this.store.remove(n.thread.id)
      ),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.refresh())
    );
    store.on('change', () => this.refresh());
    void this.initGit();
  }

  private async initGit(): Promise<void> {
    const ext = vscode.extensions.getExtension('vscode.git');
    if (!ext) return;
    const exports = ext.isActive ? ext.exports : await ext.activate();
    this.git = exports.getAPI(1) as GitApi;
    const onGitState = () => {
      this.remapRenames();
      this.gitEmitter.fire();
      this.refresh();
    };
    const hook = (repo: GitRepository) =>
      this.context.subscriptions.push(repo.state.onDidChange(onGitState));
    this.git.repositories.forEach(hook);
    this.context.subscriptions.push(
      this.git.onDidOpenRepository((repo) => {
        hook(repo);
        onGitState();
      })
    );
    onGitState();
  }

  // Where a thread should be shown. Threads on a deleted file anchor to the
  // HEAD side of its diff — the file:// document no longer exists, and without
  // a reachable widget the thread could never be replied, reopened or closed
  threadUri(t: ReviewThread): vscode.Uri {
    const uri = vscode.Uri.file(t.folder ? path.join(t.folder, t.file) : t.file);
    const change = this.changes().get(uri.fsPath);
    if (this.git && change && DELETED_STATUSES.includes(change.status)) {
      return this.git.toGitUri(uri, 'HEAD');
    }
    return uri;
  }

  // A rename leaves threads pointing at the old path; follow the file so the
  // conversation survives the move
  private remapRenames(): void {
    for (const change of this.changes().values()) {
      if (!RENAMED_STATUSES.includes(change.status) || !change.originalUri) continue;
      if (change.originalUri.fsPath === change.uri.fsPath) continue;
      for (const t of this.store.list('all')) {
        const tPath = t.folder ? path.join(t.folder, t.file) : t.file;
        if (tPath !== change.originalUri.fsPath) continue;
        const ws = vscode.workspace.getWorkspaceFolder(change.uri);
        const folder = ws?.uri.fsPath ?? t.folder;
        const file = folder ? path.relative(folder, change.uri.fsPath) : change.uri.fsPath;
        this.store.relocate(t.id, folder, file);
      }
    }
  }

  refresh(): void {
    this.emitter.fire();
  }

  private changes(): Map<string, GitChange> {
    const map = new Map<string, GitChange>();
    for (const repo of this.git?.repositories ?? []) {
      const all = [
        ...repo.state.indexChanges,
        ...(repo.state.untrackedChanges ?? []),
        ...repo.state.workingTreeChanges,
      ];
      for (const change of all) {
        const prev = map.get(change.uri.fsPath);
        // a working-tree edit on top of a staged rename must keep the rename
        // info, or the diff would look the new path up in HEAD. Built as an
        // explicit literal: the API's Change exposes uri/status via prototype
        // getters, which a spread would silently drop
        if (prev && RENAMED_STATUSES.includes(prev.status) && !RENAMED_STATUSES.includes(change.status)) {
          map.set(change.uri.fsPath, {
            uri: change.uri,
            originalUri: prev.originalUri,
            status: prev.status,
          });
        } else {
          map.set(change.uri.fsPath, change);
        }
      }
    }
    return map;
  }

  private buildFileNodes(): FileNode[] {
    const threadsByFile = new Map<string, ReviewThread[]>();
    for (const t of this.store.list('open')) {
      const fsPath = t.folder ? path.join(t.folder, t.file) : t.file;
      let arr = threadsByFile.get(fsPath);
      if (!arr) {
        arr = [];
        threadsByFile.set(fsPath, arr);
      }
      arr.push(t);
    }

    const locate = (uri: vscode.Uri) => {
      const ws = vscode.workspace.getWorkspaceFolder(uri);
      const folder = ws?.uri.fsPath ?? path.dirname(uri.fsPath);
      return { folder, rel: path.relative(folder, uri.fsPath) };
    };

    const nodes = new Map<string, FileNode>();
    for (const [fsPath, change] of this.changes()) {
      nodes.set(fsPath, {
        kind: 'file',
        uri: change.uri,
        ...locate(change.uri),
        status: change.status,
        originalUri: change.originalUri,
        threads: [],
      });
    }
    for (const [fsPath, threads] of threadsByFile) {
      const uri = vscode.Uri.file(fsPath);
      let node = nodes.get(fsPath);
      if (!node) {
        node = { kind: 'file', uri, ...locate(uri), threads: [] };
        nodes.set(fsPath, node);
      }
      node.threads = threads;
    }
    return [...nodes.values()].sort(
      (a, b) => a.folder.localeCompare(b.folder) || a.rel.localeCompare(b.rel)
    );
  }

  getChildren(element?: Node): Node[] {
    if (element) {
      if (element.kind === 'folder') return element.files;
      if (element.kind === 'file') {
        return element.threads.map((thread) => ({ kind: 'thread', thread }));
      }
      return [];
    }

    const files = this.buildFileNodes();
    const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
    if (workspaceFolders.length <= 1) return files;

    // Multi-root workspace: group by folder (repo)
    const byFolder = new Map<string, FolderNode>();
    for (const file of files) {
      let node = byFolder.get(file.folder);
      if (!node) {
        node = { kind: 'folder', uri: vscode.Uri.file(file.folder), files: [] };
        byFolder.set(file.folder, node);
      }
      node.files.push(file);
    }
    return [...byFolder.values()].sort((a, b) => a.uri.fsPath.localeCompare(b.uri.fsPath));
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'folder') {
      const item = new vscode.TreeItem(
        path.basename(node.uri.fsPath),
        vscode.TreeItemCollapsibleState.Expanded
      );
      item.iconPath = vscode.ThemeIcon.Folder;
      const pending = node.files.reduce(
        (acc, f) => acc + f.threads.filter((t) => t.status === 'pending').length,
        0
      );
      item.description = pending
        ? `${node.files.length} file${node.files.length === 1 ? '' : 's'} · ${pending} pending`
        : `${node.files.length} file${node.files.length === 1 ? '' : 's'}`;
      item.tooltip = node.uri.fsPath;
      return item;
    }

    if (node.kind === 'file') {
      const item = new vscode.TreeItem(
        node.uri,
        node.threads.length
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.None
      );
      const parts: string[] = [];
      const dir = path.dirname(node.rel);
      if (dir !== '.') parts.push(dir);
      if (node.status !== undefined) parts.push(statusLetter(node.status));
      if (node.threads.length) {
        const pending = node.threads.filter((t) => t.status === 'pending').length;
        parts.push(pending ? `${pending} pending` : 'all resolved');
      }
      item.description = parts.join(' · ');
      item.command = {
        command: 'zamview.openDiff',
        title: 'Open diff',
        arguments: [node.uri, node.status, node.originalUri],
      };
      return item;
    }

    const t = node.thread;
    const first = (t.comments[0]?.text ?? '').replace(/\s+/g, ' ');
    const item = new vscode.TreeItem(
      `L${t.line} · ${first.length > 60 ? first.slice(0, 57) + '…' : first}`
    );
    item.iconPath = new vscode.ThemeIcon(t.status === 'resolved' ? 'pass' : 'comment');
    item.contextValue = `zamviewThread-${t.status}`;
    item.tooltip = new vscode.MarkdownString(
      `**${t.file}:${t.line}** (${t.status})\n\n` +
        t.comments.map((c) => `**${c.author === 'agent' ? 'AI' : 'You'}:** ${c.text}`).join('\n\n')
    );
    item.command = { command: 'zamview.openThread', title: 'Go to comment', arguments: [t.id] };
    return item;
  }

  private async openDiff(uri: vscode.Uri, status?: number, originalUri?: vscode.Uri): Promise<void> {
    const name = path.basename(uri.fsPath);
    const empty = uri.with({ scheme: 'zamview-empty' });
    if (status === undefined || !this.git) {
      try {
        await vscode.window.showTextDocument(uri, { preview: true });
      } catch {
        vscode.window.showWarningMessage(`ZamView: ${name} no longer exists on disk.`);
      }
      return;
    }
    if (ADDED_STATUSES.includes(status)) {
      await vscode.commands.executeCommand('vscode.diff', empty, uri, `${name} (new)`);
    } else if (DELETED_STATUSES.includes(status)) {
      await vscode.commands.executeCommand(
        'vscode.diff',
        this.git.toGitUri(uri, 'HEAD'),
        empty,
        `${name} (deleted)`
      );
    } else if (RENAMED_STATUSES.includes(status) && originalUri) {
      // the new path does not exist in HEAD: diff against the old path
      await vscode.commands.executeCommand(
        'vscode.diff',
        this.git.toGitUri(originalUri, 'HEAD'),
        uri,
        `${path.basename(originalUri.fsPath)} → ${name} (HEAD ↔ working tree)`
      );
    } else {
      await vscode.commands.executeCommand(
        'vscode.diff',
        this.git.toGitUri(uri, 'HEAD'),
        uri,
        `${name} (HEAD ↔ working tree)`
      );
    }
  }

  private async openThread(id: string): Promise<void> {
    const t = this.store.get(id);
    if (!t) return;
    const uri = vscode.Uri.file(t.folder ? path.join(t.folder, t.file) : t.file);
    const change = this.changes().get(uri.fsPath);
    await this.openDiff(uri, change?.status, change?.originalUri);
    // reveal in the pane the thread is anchored to (for a deleted file that
    // is the HEAD side of the diff, not the active zamview-empty side)
    const target = this.threadUri(t).toString();
    const editor = vscode.window.visibleTextEditors.find(
      (e) => e.document.uri.toString() === target
    );
    if (editor) {
      const line = Math.min(t.line - 1, editor.document.lineCount - 1);
      const pos = new vscode.Position(line, 0);
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(
        new vscode.Range(pos, pos),
        vscode.TextEditorRevealType.InCenterIfOutsideViewport
      );
    }
  }
}
