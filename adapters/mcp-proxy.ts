/**
 * Stdio MCP proxy: `node card-mcp-proxy.mjs --name <server> [--url=<CARD>] -- <real server command...>`.
 * The agent talks to this process; it talks to the real server. Before the agent sees the server's tools,
 * their names and descriptions are scored by CARD (tool poisoning), and the version fingerprint means a
 * description changed after it was trusted is held again (rug pull). Denied servers expose no tools.
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Evaluation } from '../shared/types.js';
import { awaitReview, call, Unreachable, type Deps } from './core.js';

interface Tool { name?: string; description?: string; inputSchema?: unknown }
const MAX_CONTENT = 4_000;
/** MCP clients wait a limited time for tools/list; a longer human decision arrives as a list_changed notification. */
const INLINE_WAIT_MS = 25_000;

export function describeTools(tools: Tool[]): string {
  return tools.map((tool) => `tool ${tool.name ?? '?'}: ${tool.description ?? ''} | input ${JSON.stringify(tool.inputSchema ?? {})}`).join('\n').slice(0, MAX_CONTENT);
}

export type ToolGate = (tools: Tool[]) => Promise<{ allowed: boolean; note: string; later?: Promise<boolean> }>;

/** Asks CARD about a server's tool list. Unreachable CARD hides the tools (fail closed). */
export function cardToolGate(name: string, deps: Deps): ToolGate {
  return async (tools) => {
    try {
      const body = { type: 'mcp', name, content: describeTools(tools), metadata: { exists: true }, sessionId: `mcp-proxy:${name}`, origin: { agent: 'mcp-proxy', tool: 'tools/list' }, evidence: 'live' };
      const evaluation = await call<Evaluation>(deps, '/api/evaluate', { method: 'POST', body: JSON.stringify(body) });
      if (evaluation.decision === 'allow') return { allowed: true, note: 'allowed' };
      if (evaluation.decision === 'deny') return { allowed: false, note: `CARD denied MCP server ${name}; its tools are hidden. Details: ${deps.cardUrl}` };
      const inline = await awaitReview(evaluation, { ...deps, reviewTimeoutMs: Math.min(INLINE_WAIT_MS, deps.reviewTimeoutMs) });
      if (inline) return { allowed: inline.review!.decision === 'allow', note: `reviewed: ${inline.review!.decision}` };
      // If CARD becomes unreachable while waiting, the tools simply stay hidden.
      const later = awaitReview(evaluation, deps).then((resolved) => resolved?.review?.decision === 'allow', () => false);
      return { allowed: false, note: `CARD is holding MCP server ${name} for a human decision; its tools appear once approved in ${deps.cardUrl}.`, later };
    } catch (error) {
      return { allowed: false, note: error instanceof Unreachable ? `CARD is not reachable at ${deps.cardUrl}; MCP server ${name} stays hidden (fail closed).` : `CARD could not evaluate MCP server ${name}: ${(error as Error).message}` };
    }
  };
}

/** Wires agent <-> proxy <-> server. Output order is preserved while a tool list is being checked. */
export function runMcpProxy(command: string[], gate: ToolGate, io: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream; log: (line: string) => void }) {
  // On Windows, commands like "npx" are .cmd scripts that need a shell; a path to an executable does not,
  // and running it through cmd would split paths such as "C:\Program Files\...". Shell arguments are quoted.
  const needsShell = process.platform === 'win32' && !/\.exe$/i.test(command[0]) && !/[\\/]/.test(command[0]);
  const quote = (arg: string) => (/[\s"&|<>^]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg);
  const child = needsShell
    ? spawn(command.map(quote).join(' '), { stdio: ['pipe', 'pipe', 'inherit'], shell: true })
    : spawn(command[0], command.slice(1), { stdio: ['pipe', 'pipe', 'inherit'] });
  const listRequests = new Set<string | number>();
  let approvedTools: boolean | undefined;
  let queue = Promise.resolve();
  const send = (line: string) => { queue = queue.then(() => { io.output.write(`${line}\n`); }); };

  createInterface({ input: io.input }).on('line', (line) => {
    try {
      const message = JSON.parse(line) as { id?: string | number; method?: string };
      if (message.method === 'tools/list' && message.id !== undefined) listRequests.add(message.id);
    } catch { /* not JSON; pass through untouched */ }
    child.stdin.write(`${line}\n`);
  });
  io.input.on('end', () => child.stdin.end());

  createInterface({ input: child.stdout }).on('line', (line) => {
    let message: { id?: string | number; result?: { tools?: Tool[] } } | undefined;
    try { message = JSON.parse(line); } catch { /* pass through */ }
    if (!message || message.id === undefined || !listRequests.has(message.id) || !Array.isArray(message.result?.tools)) return send(line);
    listRequests.delete(message.id);
    const tools = message.result!.tools!;
    const reply = message;
    queue = queue.then(async () => {
      const verdict = approvedTools === true ? { allowed: true, note: 'approved earlier in this session' } : await gate(tools);
      io.log(`[CARD] ${verdict.note}`);
      io.output.write(`${JSON.stringify(verdict.allowed ? reply : { ...reply, result: { ...reply.result, tools: [] } })}\n`);
      void verdict.later?.then((ok) => {
        if (!ok) return;
        approvedTools = true;
        send(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }));
      });
    });
  });
  return { child, flushed: () => queue };
}

if (process.argv[1] && /card-mcp-proxy|mcp-proxy\.(ts|mjs)$/.test(process.argv[1])) {
  const separator = process.argv.indexOf('--');
  const option = (key: string) => process.argv.slice(2, separator < 0 ? undefined : separator).find((arg) => arg.startsWith(`--${key}=`))?.slice(key.length + 3);
  const name = option('name');
  const command = separator < 0 ? [] : process.argv.slice(separator + 1);
  if (!name || !command.length) {
    process.stderr.write('Usage: card-mcp-proxy --name=<server> [--url=<CARD>] -- <server command...>\n');
    process.exit(2);
  }
  const deps: Deps = {
    fetch: globalThis.fetch, cardUrl: (option('url') ?? process.env.CARD_URL ?? 'http://127.0.0.1:4318').replace(/\/$/, ''),
    readFile: () => undefined, exists: () => false, listDir: () => [],
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now: () => Date.now(),
    reviewTimeoutMs: Number(process.env.CARD_REVIEW_TIMEOUT_S ?? 120) * 1000, pollMs: 1_000,
  };
  const proxy = runMcpProxy(command, cardToolGate(name, deps), { input: process.stdin, output: process.stdout, log: (line) => process.stderr.write(`${line}\n`) });
  proxy.child.on('exit', (code) => { void proxy.flushed().then(() => process.exit(code ?? 0)); });
}
