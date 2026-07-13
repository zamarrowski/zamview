# ZamView

VSCode extension to review the changes an AI agent makes to your code, PR-style: see changed files, open diffs, leave comments anchored to lines, and hand the review to the agent over MCP. The agent fixes each comment and marks it resolved, or pushes back by replying in the thread — all visible live in the editor.

**Built for Claude Code** — install the extension and everything (MCP registration, `/zamview` command) is set up automatically. Other MCP-capable agents can connect by registering `http://localhost:7317/mcp` manually, but they are not officially supported for now.

## Architecture

- **`src/reviewStore.ts`** — source of truth for the review (threads, comments, pending/resolved/closed). Persists to `review.json` inside the extension's per-workspace storage (`context.storageUri`) — outside the repo. No `vscode` dependency, so it can be tested in plain Node.
- **`src/comments.ts`** — VSCode Comments API (GitHub-PR-style threads) kept in sync with the store.
- **`src/gitChanges.ts`** — "ZamView" panel in the activity bar: changed files (via the `vscode.git` extension API) with comment counters; click opens the native diff.
- **`src/mcpServer.ts`** — stateless Streamable HTTP MCP server with three tools:
  - `get_review_comments` — lists threads (id, folder, file, line, snippet, conversation, status) plus all workspace folders open in the window.
  - `reply_to_comment` — replies in a thread (to discuss without resolving).
  - `resolve_comment` — marks a thread resolved, with an optional note about what was done.
- **`src/claudeSetup.ts`** — transparent registration with Claude Code (see below).
- **`src/extension.ts`** — activation, `/zamview` slash-command install, "Finish Review" button (types `/zamview` into the active terminal and submits it).

## Zero-footprint registration

The extension never writes into the user's repo. On activation it:

1. Starts the MCP server on the first **free** port at or above `zamview.port` (default 7317) — so each VSCode window gets its own server.
2. Runs `claude mcp add --transport http zamview <url>` once per **workspace folder** (multi-root workspaces are fully supported — folders added later are registered too). Claude Code stores this at **local scope** in the user's own `~/.claude.json`, keyed by project path — no `.mcp.json`, nothing to commit, and no project-approval prompt.
3. If the window later gets a different port, the stale registrations are detected and replaced automatically.

Review data is also kept out of the repo: it lives in VSCode's per-workspace extension storage. Reviews created by older versions in `<workspace>/.zamview/` are migrated there automatically (and the folder removed) on activation.

The extension also installs a **`/zamview` slash command** for Claude Code at user level (`~/.claude/commands/zamview.md`, rewritten on each activation). The "Finish Review" button just types `/zamview` in the terminal — short, magic-looking, and the full instructions live in the command file. If the file can't be written, the button falls back to sending the full prompt.

If the `claude` CLI is not installed, the extension offers the registration command to copy (also available via the status bar item or the `ZamView: Copy MCP Registration Command` command, e.g. for other MCP-capable agents).

## Multiple repos and windows

- **Multi-root workspaces** (several repos in one window): the tree groups changed files by folder, every folder gets the MCP registration, each thread records the absolute folder it belongs to, and `get_review_comments` returns that folder per thread so the agent knows which repo each comment targets (and can say so if one is outside its reach). The handoff prompt includes a per-folder breakdown.
- **Multiple windows**: each window runs its own server on its own free port, and each folder's registration points at its window's URL — so a `claude` session in project A only ever sees project A's review.

## Development

```bash
npm install
npm run sandbox   # create the demo repos (not committed: they contain nested git repos)
npm run compile   # typecheck + esbuild bundle
npm run package   # build a minified .vsix (sandbox and sources excluded via .vscodeignore)
```

Press **F5** (macOS: `Fn+F5`, or Run → Start Debugging): an Extension Development Host opens on `sandbox.code-workspace`, a multi-root workspace with two toy git repos (`sandbox/`, `sandbox2/`), both with uncommitted changes (as if the AI had just made them). A second launch config runs the single-folder case.

## Usage flow

1. Open the **ZamView** panel in the activity bar: changed files show up (M/A/D).
2. Click a file → the diff opens. Hover a line on the right side and click the **+** in the gutter to comment (drag to cover a range).
3. Open the integrated terminal and start `claude` — the MCP server was already registered for the project, so the tools are just there.
4. When you're done, hit the **send** (✈) button in the panel title: `/zamview` is typed into the active terminal and submitted automatically.
5. Claude reads the comments with `get_review_comments`, fixes and resolves (`resolve_comment`) or argues back (`reply_to_comment`). Threads update live in the editor; you can answer inside a thread and ping the agent again.
6. Once you've verified a fix (or the discussion is settled), hit **Close conversation** (✓✓) on the thread: it's archived and disappears from the editor and the tree. Threads the agent resolved stay visible (with a Reopen button) until you close them — you have the last word.

## Known limitations (MVP)

- Comments anchor to the right side of the diff (working tree); you can't comment on deleted lines on the left side.
- Line numbers can drift while the agent edits; each thread stores the commented snippet and the tools instruct the agent to relocate with it.
- "Changes" = working tree vs HEAD (same as the native Source Control view); it doesn't distinguish what the AI edited from what you had uncommitted.
