import express from 'express';
import type { Server as HttpServer } from 'http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { ReviewStore } from './reviewStore';

const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] });
const errText = (s: string) => ({ content: [{ type: 'text' as const, text: s }], isError: true });

function buildServer(store: ReviewStore, workspaceFolders: string[]): McpServer {
  const server = new McpServer({ name: 'zamview', version: '0.1.0' });

  server.registerTool(
    'get_review_comments',
    {
      title: 'Get review comments',
      description:
        'Lists the code-review comments the user left on your changes from the ZamView panel in VS Code. ' +
        'The editor window may contain several workspace folders (repos); the response lists them all, and each thread carries the absolute `folder` it belongs to plus a folder-relative `file` path. ' +
        'Only act on threads whose folder you can actually edit, and tell the user if some belong to a repo outside your reach. ' +
        'Each thread includes: id, folder, file, line/endLine (1-based; they may have drifted if the file changed afterwards — use the snippet to relocate the exact spot), ' +
        'the commented code snippet, status (pending|resolved) and the conversation so far (author "user" is the human, "agent" is you). ' +
        'Workflow: for each pending thread, either fix what it asks and call resolve_comment, or discuss it with reply_to_comment.',
      inputSchema: {
        status: z
          .enum(['pending', 'resolved', 'closed', 'all'])
          .optional()
          .describe(
            "Which threads to return. Default: 'pending'. 'closed' means the user ended the conversation — nothing left to do there."
          ),
      },
    },
    async ({ status }) => {
      const threads = store.list(status ?? 'pending');
      return text(JSON.stringify({ workspaceFolders, total: threads.length, threads }, null, 2));
    }
  );

  server.registerTool(
    'reply_to_comment',
    {
      title: 'Reply to a review comment',
      description:
        'Posts a reply in a review thread; the user sees it immediately in VS Code. ' +
        'Use it to discuss, push back with arguments, or ask for clarification. It does NOT resolve the thread.',
      inputSchema: {
        thread_id: z.string().describe('Thread id, e.g. "c3"'),
        reply: z.string().describe('Your reply (markdown supported)'),
      },
    },
    async ({ thread_id, reply }) => {
      const thread = store.reply(thread_id, reply, 'agent');
      if (!thread) return errText(`Thread not found: ${thread_id}`);
      return text(
        `Reply posted on ${thread.id} (${thread.file}:${thread.line}). Thread is still ${thread.status}.`
      );
    }
  );

  server.registerTool(
    'resolve_comment',
    {
      title: 'Resolve a review comment',
      description:
        'Marks a review thread as resolved once you have addressed it. ' +
        'Pass a short note describing what you changed; it is posted as a reply so the user can verify.',
      inputSchema: {
        thread_id: z.string().describe('Thread id, e.g. "c3"'),
        note: z.string().optional().describe('Short summary of what you did'),
      },
    },
    async ({ thread_id, note }) => {
      const thread = store.setStatus(thread_id, 'resolved', note);
      if (!thread) return errText(`Thread not found: ${thread_id}`);
      return text(`${thread.id} (${thread.file}:${thread.line}) marked as resolved.`);
    }
  );

  return server;
}

/**
 * Stateless Streamable HTTP MCP server: every POST creates a fresh
 * server/transport pair over the shared ReviewStore, so there is no session
 * management and an extension reload never leaves orphaned sessions behind.
 */
export function startMcpServer(
  store: ReviewStore,
  port: number,
  workspaceFolders: string[]
): Promise<HttpServer> {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  app.post('/mcp', async (req, res) => {
    const server = buildServer(store, workspaceFolders);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  });

  const reject = (_req: express.Request, res: express.Response) =>
    res.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed (stateless server)' },
      id: null,
    });
  app.get('/mcp', reject);
  app.delete('/mcp', reject);

  return new Promise((resolve, rejectPromise) => {
    const httpServer = app.listen(port, '127.0.0.1', () => resolve(httpServer));
    httpServer.on('error', rejectPromise);
  });
}

/**
 * Each VSCode window needs its own server (one review per workspace), so we
 * probe upwards from the base port until a free one is found. The chosen
 * port is then registered with Claude Code at local scope, per project.
 */
export async function startMcpServerOnFreePort(
  store: ReviewStore,
  basePort: number,
  workspaceFolders: string[]
): Promise<{ server: HttpServer; port: number }> {
  for (let port = basePort; port < basePort + 50; port++) {
    try {
      return { server: await startMcpServer(store, port, workspaceFolders), port };
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'EADDRINUSE') throw err;
    }
  }
  throw new Error(`no free port found in range ${basePort}-${basePort + 49}`);
}
