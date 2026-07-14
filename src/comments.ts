import * as vscode from 'vscode';
import * as path from 'path';
import { ReviewStore, ReviewThread, ThreadStatus } from './reviewStore';

// vscode.Comment plus the store coordinates needed to edit it later
interface ZamComment extends vscode.Comment {
  threadId: string;
  index: number;
}

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
      ),
      vscode.commands.registerCommand('zamview.editComment', (comment: ZamComment) =>
        this.startEdit(comment)
      ),
      vscode.commands.registerCommand('zamview.saveComment', (comment: ZamComment) =>
        this.saveEdit(comment)
      ),
      vscode.commands.registerCommand('zamview.deleteComment', (comment: ZamComment) =>
        this.store.removeComment(comment.threadId, comment.index)
      ),
      // resync rebuilds every comment from the store, discarding the draft
      vscode.commands.registerCommand('zamview.cancelEditComment', () => this.sync())
    );
  }

  private async create(reply: vscode.CommentReply): Promise<void> {
    if (!reply.text.trim()) return;
    const thread = reply.thread;
    const range = thread.range ?? new vscode.Range(0, 0, 0, 0);
    const doc = await vscode.workspace.openTextDocument(thread.uri);
    // A selection ending at column 0 does not really include that line
    const rawEnd =
      range.end.line > range.start.line && range.end.character === 0
        ? range.end.line - 1
        : range.end.line;
    const endLine = Math.min(rawEnd, doc.lineCount - 1);
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

  private startEdit(comment: ZamComment): void {
    const vt = this.byId.get(comment.threadId);
    if (!vt) return;
    // mutate then reassign: the Comments API only re-renders on assignment
    vt.comments = vt.comments.map((c) => {
      if ((c as ZamComment).index === comment.index) c.mode = vscode.CommentMode.Editing;
      return c;
    });
  }

  private saveEdit(comment: ZamComment): void {
    // VSCode has already written the edited text into comment.body
    const text = typeof comment.body === 'string' ? comment.body : comment.body.value;
    if (text.trim()) this.store.editComment(comment.threadId, comment.index, text);
    else this.sync(); // emptied out: treat as cancel
  }

  // A range ending at column 0 is drawn by VSCode as a one-pixel border
  // sliver that looks like a stray cursor, so end it at the last line's text
  private threadRange(t: ReviewThread): vscode.Range {
    const endCol = (t.snippet.split('\n').pop() ?? '').length;
    return new vscode.Range(t.line - 1, 0, t.endLine - 1, endCol);
  }

  private sync(): void {
    const seen = new Set<string>();
    // closed threads are not shown; the final loop removes them from the editor
    for (const t of this.store.list('open')) {
      seen.add(t.id);
      let vt = this.byId.get(t.id);
      if (!vt) {
        const uri = vscode.Uri.file(t.folder ? path.join(t.folder, t.file) : t.file);
        vt = this.controller.createCommentThread(uri, this.threadRange(t), []);
        vt.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
        this.byId.set(t.id, vt);
        this.byThread.set(vt, t.id);
      }
      // reassign even for adopted threads: the ephemeral thread VSCode spawns
      // on "+" may carry a column-0 end (see threadRange)
      vt.range = this.threadRange(t);
      vt.comments = t.comments.map((c, i): ZamComment => {
        const flags: string[] = [];
        // only the user's own comments on a not-yet-resolved thread are editable
        if (c.author === 'user' && t.status === 'pending') flags.push('editable');
        // deleting the only comment would be deleting the thread, which has its own button
        if (t.comments.length > 1) flags.push('deletable');
        return {
          threadId: t.id,
          index: i,
          author: { name: c.author === 'agent' ? 'AI' : 'You' },
          body: new vscode.MarkdownString(c.text),
          mode: vscode.CommentMode.Preview,
          timestamp: new Date(c.at),
          contextValue: flags.join(' ') || undefined,
        };
      });
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
