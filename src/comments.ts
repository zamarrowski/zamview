import * as vscode from 'vscode';
import * as path from 'path';
import { ReviewStore, ThreadStatus } from './reviewStore';

/**
 * Keeps the ReviewStore in sync with the VSCode Comments API.
 * The store is authoritative: any mutation (from the UI or from MCP)
 * triggers a sync that rebuilds the visible CommentThreads.
 */
export class ReviewComments {
  private controller: vscode.CommentController;
  private byId = new Map<string, vscode.CommentThread>();
  private byThread = new Map<vscode.CommentThread, string>();

  constructor(
    private store: ReviewStore,
    context: vscode.ExtensionContext
  ) {
    this.controller = vscode.comments.createCommentController('zamview', 'ZamView Review');
    this.controller.options = {
      placeHolder: 'Leave a comment for the AI…',
      prompt: 'Review comment',
    };
    this.controller.commentingRangeProvider = {
      provideCommentingRanges: (document) => {
        if (document.uri.scheme !== 'file') return [];
        return [new vscode.Range(0, 0, Math.max(document.lineCount - 1, 0), 0)];
      },
    };
    context.subscriptions.push(this.controller);

    store.on('change', () => this.sync());
    this.sync();

    context.subscriptions.push(
      vscode.commands.registerCommand('zamview.createComment', (reply: vscode.CommentReply) =>
        this.create(reply)
      ),
      vscode.commands.registerCommand('zamview.replyComment', (reply: vscode.CommentReply) =>
        this.reply(reply)
      ),
      // 'resolved' is agent-only (via the resolve_comment MCP tool); the user's
      // verbs are reopen, close and delete
      vscode.commands.registerCommand('zamview.reopenThread', (thread: vscode.CommentThread) =>
        this.setStatus(thread, 'pending')
      ),
      vscode.commands.registerCommand('zamview.closeThread', (thread: vscode.CommentThread) =>
        this.setStatus(thread, 'closed')
      ),
      vscode.commands.registerCommand('zamview.deleteThread', (thread: vscode.CommentThread) =>
        this.remove(thread)
      )
    );
  }

  private async create(reply: vscode.CommentReply): Promise<void> {
    if (!reply.text.trim()) return;
    const thread = reply.thread;
    const range = thread.range ?? new vscode.Range(0, 0, 0, 0);
    const doc = await vscode.workspace.openTextDocument(thread.uri);
    const endLine = Math.min(range.end.line, doc.lineCount - 1);
    const snippet = doc.getText(
      new vscode.Range(range.start.line, 0, endLine, doc.lineAt(endLine).text.length)
    );
    // Workspace folder (repo) the file belongs to; files outside every
    // folder are stored with an absolute path and an empty folder
    const ws = vscode.workspace.getWorkspaceFolder(thread.uri);
    const folder = ws?.uri.fsPath ?? '';
    const file = ws ? path.relative(folder, thread.uri.fsPath) : thread.uri.fsPath;
    // silent + adopting the ephemeral thread VSCode creates on "+", so that
    // sync() does not create a duplicate thread at the same position
    const t = this.store.create(
      {
        folder,
        file,
        line: range.start.line + 1,
        endLine: endLine + 1,
        snippet,
        text: reply.text,
      },
      { silent: true }
    );
    this.byId.set(t.id, thread);
    this.byThread.set(thread, t.id);
    this.store.emitChange();
  }

  private reply(reply: vscode.CommentReply): void {
    if (!reply.text.trim()) return;
    const id = this.byThread.get(reply.thread);
    if (id) this.store.reply(id, reply.text, 'user');
  }

  private setStatus(thread: vscode.CommentThread, status: ThreadStatus): void {
    const id = this.byThread.get(thread);
    if (id) this.store.setStatus(id, status);
  }

  private remove(thread: vscode.CommentThread): void {
    const id = this.byThread.get(thread);
    if (id) this.store.remove(id);
    else thread.dispose();
  }

  private sync(): void {
    const seen = new Set<string>();
    // closed threads are not shown; the final loop removes them from the editor
    for (const t of this.store.list('open')) {
      seen.add(t.id);
      let vt = this.byId.get(t.id);
      if (!vt) {
        const uri = vscode.Uri.file(t.folder ? path.join(t.folder, t.file) : t.file);
        vt = this.controller.createCommentThread(
          uri,
          new vscode.Range(t.line - 1, 0, t.endLine - 1, 0),
          []
        );
        vt.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
        this.byId.set(t.id, vt);
        this.byThread.set(vt, t.id);
      }
      vt.comments = t.comments.map((c) => ({
        author: { name: c.author === 'agent' ? 'AI' : 'You' },
        body: new vscode.MarkdownString(c.text),
        mode: vscode.CommentMode.Preview,
        timestamp: new Date(c.at),
      }));
      vt.label = `${t.id} · ${t.status}`;
      vt.contextValue = t.status;
      vt.state =
        t.status === 'resolved'
          ? vscode.CommentThreadState.Resolved
          : vscode.CommentThreadState.Unresolved;
    }
    for (const [id, vt] of [...this.byId]) {
      if (!seen.has(id)) {
        vt.dispose();
        this.byId.delete(id);
        this.byThread.delete(vt);
      }
    }
  }
}
