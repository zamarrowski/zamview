import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export type RegistrationResult = 'already' | 'registered' | 'no-cli' | 'failed';

/**
 * Registers the ZamView MCP server with Claude Code at *local* scope: the
 * config lives in the user's ~/.claude.json keyed by project path, so nothing
 * is ever written into the user's repo. Running `claude mcp add` with cwd set
 * to the workspace root is what selects the project entry.
 */
export async function ensureClaudeRegistration(
  workspaceRoot: string,
  url: string
): Promise<RegistrationResult> {
  const opts = { cwd: workspaceRoot, timeout: 15000 };

  try {
    const { stdout } = await execFileAsync('claude', ['mcp', 'get', 'zamview'], opts);
    if (stdout.includes(url)) return 'already';
    // registered with a stale URL (e.g. the window got a different port): replace it
    await execFileAsync('claude', ['mcp', 'remove', 'zamview'], opts).catch(() => undefined);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return 'no-cli';
    // `claude mcp get` exits non-zero when the server is not registered yet
  }

  try {
    await execFileAsync('claude', ['mcp', 'add', '--transport', 'http', 'zamview', url], opts);
    return 'registered';
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'no-cli' : 'failed';
  }
}
