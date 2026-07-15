# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

ZamView is a VS Code extension that lets you review an AI agent's uncommitted changes PR-style — comment on diffs, then hand the review to the agent over a local MCP server. The agent reads the comments, fixes and resolves them, or pushes back in the thread. It targets Claude Code specifically (auto-registers its MCP server and installs a `/zamview` slash command), but any MCP-capable agent can connect.

## Commands

```bash
npm run compile   # typecheck (tsc --noEmit) + esbuild bundle → dist/extension.js
npm run typecheck # types only
npm run watch     # esbuild in watch mode (for the F5 dev loop)
npm run package   # minified .vsix via vsce (sources/sandbox excluded by .vscodeignore)
npm run sandbox   # (re)create sandbox/ and sandbox2/ — toy git repos with uncommitted changes
```

There is **no test runner and no linter** configured. `reviewStore.ts` is deliberately free of any `vscode` import so it *could* be unit-tested in plain Node, but no test infra exists yet — don't assume `npm test` works.

Debugging: press **F5** to launch an Extension Development Host on `sandbox.code-workspace` (a multi-root workspace over the two sandbox repos). Run `npm run sandbox` first — the sandbox dirs are gitignored because they contain nested git repos.

## Build specifics

- `tsc` is **typecheck-only** (`noEmit: true`). esbuild (`esbuild.mjs`) is the real bundler: single entry `src/extension.ts` → CommonJS `dist/extension.js`, with `vscode` marked external. `target: node20`.
- Runtime deps (`express`, `@modelcontextprotocol/sdk`, `zod`) are bundled into the output, so `--no-dependencies` is correct when packaging.

## Architecture

The design centers on **one source of truth shared by two independent surfaces** (the VS Code UI and the MCP server):

- **`reviewStore.ts`** — `ReviewStore`, an `EventEmitter` holding all review threads. Every mutation persists to `review.json` and fires a `'change'` event. This is the only place threads are created/replied/resolved/removed. No `vscode` dependency.
- **`comments.ts`** — `ReviewComments` bridges the store to the native VS Code Comments API (the PR-style threads in the gutter). Subscribes to `'change'` and rebuilds visible threads in `sync()`.
- **`gitChanges.ts`** — `ChangesTree`, the "ZamView" activity-bar panel. Lists changed files (working tree vs HEAD, read through the `vscode.git` extension API) with per-file/per-folder comment counts; also subscribes to `'change'`.
- **`mcpServer.ts`** — the MCP server. Reads and writes the same `ReviewStore` directly.

So there are two write paths into the store (human via Comments API, agent via MCP tools) and both UI surfaces re-render off the shared `'change'` event. When changing behavior, mutate through the store — never update the Comments/tree view directly, or the two surfaces will drift.

### MCP server

`mcpServer.ts` runs a **stateless** Streamable HTTP server (Express): a fresh `McpServer`+transport pair is built per POST to `/mcp`, so an extension reload never orphans sessions. Three tools:
- `get_review_comments` — lists threads (+ all open workspace folders); default filter is `pending`.
- `reply_to_comment` — posts an agent reply, does **not** resolve.
- `resolve_comment` — marks resolved with an optional note.

`startMcpServerOnFreePort` probes upward from `zamview.port` (default 7317) so **each VS Code window gets its own server** on its own port — this is what keeps window A's review isolated from window B's.

### Thread status model

`pending` → `resolved` → `closed`. Who can do what matters:
- **`resolved` is agent-only** (via `resolve_comment`). The human's verbs are reopen / close / delete.
- A **user reply on a resolved thread reopens it** (`ReviewStore.reply`) — writing again means there's something left to do.
- **`closed`** = the user ended the conversation; closed threads are hidden from both UI surfaces (the store's `'open'` filter excludes them). The human always has the last word.

## Zero-footprint invariant (important)

**The extension never writes anything into the user's repo.** This is a core product constraint — preserve it:
- Review data lives in VS Code's per-workspace extension storage (`context.storageUri`), not the repo. Legacy `<folder>/.zamview/review.json` files are migrated out and deleted on activation.
- MCP registration uses `claude mcp add` at **local scope**, which Claude Code stores in the user's `~/.claude.json` keyed by project path — no `.mcp.json`, nothing to commit, no project-approval prompt (`claudeSetup.ts`).
- The `/zamview` slash command is written to `~/.claude/commands/zamview.md` at user level, rewritten on every activation.

In multi-root workspaces every folder is registered (including folders added after startup), each thread records its absolute `folder`, and the MCP tools surface it so the agent knows which repo a comment targets.

## Conventions and gotchas

- Store line numbers are **1-based** (`line`/`endLine`); VS Code `Range` lines are 0-based — mind the ±1 at every boundary.
- **Threads on deleted files anchor to the HEAD side of the deletion diff** (`git:` URI). `ChangesTree.threadUri` decides where a thread lives and is injected into `ReviewComments` as a `ThreadAnchor`; comment threads match editors by exact `uri.toString()`, so the anchor and `openDiff` must build the git URI with the same `toGitUri(uri, 'HEAD')` call. A `CommentThread`'s uri is immutable — when the anchor moves, `sync()` disposes and recreates the thread.
- **Renames**: `vscode.git`'s `Change.uri` is the *new* path; `originalUri` is the pre-rename path. Diffs for renamed files must use `toGitUri(originalUri, 'HEAD')` on the left, and a working-tree edit on top of a staged rename (git `RM`) must not clobber the rename info (`changes()` merges it). `remapRenames` relocates threads to the new path so conversations follow moved files.
- The human verbs (reopen/close/delete) also exist as `*FromTree` commands on the tree's thread items (`viewItem == zamviewThread-<status>`) — the safety net for threads whose file can't be opened at all.
- Threads store the commented `snippet` because line numbers drift as the agent edits; tool descriptions instruct the agent to relocate via the snippet.
- The "Finish Review" button sends `/zamview` to the terminal, then sends the Enter (`\r`) in a **separate, delayed `sendText`** — TUIs like Claude Code treat an attached newline as part of a paste and won't submit (`extension.ts:finishReview`).
- New comments are created `silent` while adopting the ephemeral thread VS Code spawns on "+", so `sync()` doesn't duplicate it (`comments.ts:create`).
- User-facing strings and code are in English.
