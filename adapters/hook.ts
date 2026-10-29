/**
 * CARD hook for Claude Code and Codex: `node card-hook.mjs <claude|codex> [--url=http://127.0.0.1:4318]`, payload on stdin.
 * Allowing prints nothing and exits 0, so the agent's own permission checks still run.
 * Blocking exits 2 with the reason on stderr, which both agents show to the model and the user.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { onPostToolUse, onPreToolUse, onSessionStart, onUserPromptSubmit, type Agent, type Deps, type HookPayload } from './core.js';

const agent = process.argv[2] as Agent;
const deps: Deps = {
  fetch: globalThis.fetch,
  cardUrl: (process.argv.find((arg) => arg.startsWith('--url='))?.slice(6) ?? process.env.CARD_URL ?? 'http://127.0.0.1:4318').replace(/\/$/, ''),
  readFile: (path) => { try { return readFileSync(path, 'utf8'); } catch { return undefined; } },
  exists: (path) => existsSync(path),
  listDir: (path) => { try { return readdirSync(path); } catch { return []; } },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
  reviewTimeoutMs: Number(process.env.CARD_REVIEW_TIMEOUT_S ?? 120) * 1000,
  pollMs: 1_000,
};

function block(reason: string): never {
  process.stderr.write(`${reason}\n`);
  process.exit(2);
}

async function main() {
  if (agent !== 'claude' && agent !== 'codex') block('CARD hook misconfigured: expected "claude" or "codex" as the first argument.');
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  let payload: HookPayload;
  try { payload = JSON.parse(raw) as HookPayload; } catch { block('CARD could not read the hook input, so the action is blocked to stay safe.'); }
  const event = payload.hook_event_name;
  if (event === 'PreToolUse') {
    const verdict = await onPreToolUse(payload, agent, deps);
    if (!verdict.allow) block(verdict.reason);
  } else if (event === 'UserPromptSubmit') {
    const verdict = await onUserPromptSubmit(payload, agent, deps);
    if (!verdict.allow) block(verdict.reason);
  } else if (event === 'SessionStart') {
    await onSessionStart(payload, agent, deps);
  } else if (event === 'PostToolUse') {
    await onPostToolUse(payload, agent, deps);
  }
  process.exit(0);
}

main().catch((error) => block(`CARD hook failed (${(error as Error).message}), so the action is blocked to stay safe.`));
