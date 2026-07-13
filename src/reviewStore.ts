import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';

// pending: waiting on the agent · resolved: the agent considers it fixed ·
// closed: the user ended the conversation (removed from the UI)
export type ThreadStatus = 'pending' | 'resolved' | 'closed';
export type Author = 'user' | 'agent';

export interface ReviewComment {
  author: Author;
  text: string;
  at: string; // ISO timestamp
}

export interface ReviewThread {
  id: string;
  folder: string; // absolute path of the workspace folder (repo) it belongs to
  file: string; // path relative to that folder
  line: number; // 1-based, first line of the commented range
  endLine: number; // 1-based
  snippet: string; // commented code as it was when the thread was created
  status: ThreadStatus;
  comments: ReviewComment[];
}

export interface NewThreadInput {
  folder: string;
  file: string;
  line: number;
  endLine: number;
  snippet: string;
  text: string;
  author?: Author;
}

/**
 * Source of truth for the review, shared by the VSCode UI and the MCP
 * server. Persists to review.json inside the extension's per-workspace
 * storage so it survives window reloads.
 */
export class ReviewStore extends EventEmitter {
  private threads = new Map<string, ReviewThread>();
  private seq = 0;

  constructor(
    private storageDir: string,
    private fallbackFolder = '' // for threads saved by versions without a folder field
  ) {
    super();
    this.load();
  }

  private get filePath(): string {
    return path.join(this.storageDir, 'review.json');
  }

  private load(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      this.seq = typeof raw.seq === 'number' ? raw.seq : 0;
      for (const t of raw.threads ?? []) {
        this.threads.set(t.id, { folder: this.fallbackFolder, ...t });
        const n = Number(String(t.id).replace(/\D/g, ''));
        if (!Number.isNaN(n)) this.seq = Math.max(this.seq, n);
      }
    } catch {
      // no previous file: empty review
    }
  }

  private persist(): void {
    fs.mkdirSync(this.storageDir, { recursive: true });
    const data = { seq: this.seq, threads: [...this.threads.values()] };
    fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
  }

  emitChange(): void {
    this.emit('change');
  }

  list(filter: ThreadStatus | 'all' | 'open'): ReviewThread[] {
    const all = [...this.threads.values()].sort(
      (a, b) => a.folder.localeCompare(b.folder) || a.file.localeCompare(b.file) || a.line - b.line
    );
    if (filter === 'all') return all;
    if (filter === 'open') return all.filter((t) => t.status !== 'closed');
    return all.filter((t) => t.status === filter);
  }

  get(id: string): ReviewThread | undefined {
    return this.threads.get(id);
  }

  create(input: NewThreadInput, opts?: { silent?: boolean }): ReviewThread {
    const id = `c${++this.seq}`;
    const thread: ReviewThread = {
      id,
      folder: input.folder,
      file: input.file,
      line: input.line,
      endLine: input.endLine,
      snippet: input.snippet,
      status: 'pending',
      comments: [
        { author: input.author ?? 'user', text: input.text, at: new Date().toISOString() },
      ],
    };
    this.threads.set(id, thread);
    this.persist();
    if (!opts?.silent) this.emitChange();
    return thread;
  }

  reply(id: string, text: string, author: Author): ReviewThread | undefined {
    const thread = this.threads.get(id);
    if (!thread) return undefined;
    thread.comments.push({ author, text, at: new Date().toISOString() });
    // A user reply on a resolved thread reopens it: writing again means
    // there is something left to discuss or fix
    if (author === 'user' && thread.status === 'resolved') {
      thread.status = 'pending';
    }
    this.persist();
    this.emitChange();
    return thread;
  }

  setStatus(id: string, status: ThreadStatus, note?: string): ReviewThread | undefined {
    const thread = this.threads.get(id);
    if (!thread) return undefined;
    if (note?.trim()) {
      thread.comments.push({ author: 'agent', text: note, at: new Date().toISOString() });
    }
    thread.status = status;
    this.persist();
    this.emitChange();
    return thread;
  }

  remove(id: string): boolean {
    const existed = this.threads.delete(id);
    if (existed) {
      this.persist();
      this.emitChange();
    }
    return existed;
  }
}
