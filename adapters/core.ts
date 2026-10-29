import { basename, isAbsolute, join, relative } from 'node:path';
import type { ArtifactRequest, Evaluation } from '../shared/types.js';
import { extractFromCommand, tokenize, splitSegments, type Extracted, type ReadFile } from './commands.js';

export type Agent = 'claude' | 'codex';

/** The fields CARD reads from a Claude Code or Codex hook payload. */
export interface HookPayload {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  prompt?: string;
}

export interface Deps {
  fetch: typeof fetch;
  cardUrl: string;
  readFile: ReadFile;
  exists: (path: string) => boolean;
  listDir: (path: string) => string[];
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  reviewTimeoutMs: number;
  pollMs: number;
}

export type Verdict = { allow: true } | { allow: false; reason: string };

const MAX_SKILL_TEXT = 4_000;
/** Claude Code uses Bash or (on Windows) PowerShell; Codex reports shell commands as Bash. */
export const SHELL_TOOLS = new Set(['Bash', 'PowerShell', 'shell', 'exec_command']);
const MAX_OBSERVATION_TEXT = 20_000;

/** Files agents load as instructions, either at start-up or when read. */
const INSTRUCTION_FILES = new Set(['claude.md', 'agents.md', 'gemini.md', '.cursorrules', '.windsurfrules', 'copilot-instructions.md', 'skill.md']);
export function isInstructionFile(path: string): boolean {
  const normal = path.replace(/\\/g, '/').toLowerCase();
  return INSTRUCTION_FILES.has(basename(normal)) || /\/\.claude\/(skills|commands|agents)\//.test(normal) || /\/\.codex\/(skills|prompts)\//.test(normal);
}

/** Instruction files present in a workspace, as paths relative to it. */
export function startupFiles(cwd: string, deps: Pick<Deps, 'exists' | 'listDir'>): string[] {
  const found = ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md', '.cursorrules', '.windsurfrules', '.github/copilot-instructions.md'].filter((file) => deps.exists(join(cwd, file)));
  for (const folder of ['.claude/skills', '.codex/skills']) {
    for (const skill of deps.listDir(join(cwd, folder))) {
      if (deps.exists(join(cwd, folder, skill, 'SKILL.md'))) found.push(`${folder}/${skill}/SKILL.md`);
    }
  }
  for (const folder of ['.claude/commands', '.claude/agents']) {
    for (const file of deps.listDir(join(cwd, folder))) if (file.endsWith('.md')) found.push(`${folder}/${file}`);
  }
  return found;
}

const commandOf = (input: Record<string, unknown> | undefined): string => {
  const command = input?.command;
  if (Array.isArray(command)) {
    const shell = /^(bash|sh|zsh|pwsh|powershell)(\.exe)?$/i.test(String(command[0] ?? '').replace(/^.*[\\/]/, ''));
    return shell && command.length >= 3 ? String(command.at(-1)) : command.map(String).join(' ');
  }
  return typeof command === 'string' ? command : '';
};

/**
 * Commands and edits an agent must never make, whatever CARD would score: calling CARD's human-only API,
 * touching its data and keys, or changing the hook configuration that routes it through CARD.
 * Defence in depth only: the reviewer PIN is what actually stops self-approval.
 */
export function protectionViolation(payload: HookPayload, deps: Pick<Deps, 'cardUrl'>): string | undefined {
  const port = new URL(deps.cardUrl).port || '80';
  const text = [commandOf(payload.tool_input), String(payload.tool_input?.file_path ?? ''), String(payload.tool_input?.path ?? '')].join('\n');
  const cardApi = new RegExp(`(?:127\\.0\\.0\\.1|localhost|0\\.0\\.0\\.0|\\[::1\\]):(?:${port}|4317|4318)\\S*/api/(?:reviews|rules|policy|auth)`, 'i');
  if (cardApi.test(text)) return 'This command calls CARD\'s reviewer-only API. Only a person can approve requests or change CARD\'s rules.';
  if (/(?:card\.db|reviewer\.json|audit-ed25519|card-hook\.mjs)/i.test(text)) return 'This command touches CARD\'s own data, keys or hook. Agents may not modify the system that supervises them.';
  const editing = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'apply_patch'].includes(payload.tool_name ?? '') || /\b(rm|del|move|mv|copy|cp|set-content|out-file|remove-item|>)\b|>/i.test(commandOf(payload.tool_input));
  if (editing && /\.claude[\\/]+settings(\.local)?\.json|\.codex[\\/]+(hooks\.json|config\.toml)/i.test(text)) {
    return 'This change would edit the hook configuration that sends actions through CARD. Ask a person to change it.';
  }
  return undefined;
}

function readInstruction(path: string, cwd: string, deps: Pick<Deps, 'readFile'>, tool: string): Extracted | undefined {
  const full = isAbsolute(path) ? path : join(cwd, path);
  const content = deps.readFile(full);
  if (content === undefined) return undefined;
  const shown = relative(cwd, full).replace(/\\/g, '/') || basename(full);
  return {
    // The adapter read the file itself, so its existence is an observation, not a claim.
    request: { type: 'skill', name: basename(full), source: shown.startsWith('..') ? full : shown, content: content.slice(0, MAX_SKILL_TEXT), metadata: { exists: true } },
    label: `${tool} ${shown}`,
  };
}

/** The artifacts a tool call would install, fetch or load. Most tool calls have none and go straight through. */
export function extractArtifacts(payload: HookPayload, deps: Pick<Deps, 'readFile'>): Extracted[] {
  const tool = payload.tool_name ?? '';
  const cwd = payload.cwd ?? process.cwd();
  const input = payload.tool_input ?? {};
  if (SHELL_TOOLS.has(tool)) {
    const command = commandOf(input);
    const found = extractFromCommand(command, cwd, deps.readFile);
    // Reading an instruction file through the shell (cat, type, Get-Content) loads it just like the Read tool.
    for (const segment of splitSegments(command)) {
      const words = tokenize(segment);
      if (!/^(cat|type|more|less|head|tail|get-content|gc)$/i.test(words[0] ?? '')) continue;
      for (const word of words.slice(1)) if (!word.startsWith('-') && isInstructionFile(word)) {
        const skill = readInstruction(word, cwd, deps, 'Read');
        if (skill) found.push(skill);
      }
    }
    return found;
  }
  if (tool === 'Read' && typeof input.file_path === 'string' && isInstructionFile(input.file_path)) {
    const skill = readInstruction(input.file_path, cwd, deps, 'Read');
    return skill ? [skill] : [];
  }
  if (tool === 'WebFetch' && typeof input.url === 'string') {
    return [{ request: { type: 'url', name: input.url, source: input.url }, label: `WebFetch ${input.url}` }];
  }
  const mcp = /^mcp__([^_].*?)__(.+)$/.exec(tool);
  if (mcp) return [{ request: { type: 'mcp', name: mcp[1], content: `Tool called: ${mcp[2]}` }, label: `MCP ${mcp[1]} → ${mcp[2]}` }];
  return [];
}

const sessionOf = (agent: Agent, payload: HookPayload) => `${agent}:${payload.session_id ?? 'unknown'}`;

export class Unreachable extends Error {}

export async function call<T>(deps: Pick<Deps, 'fetch' | 'cardUrl'>, path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await deps.fetch(`${deps.cardUrl}${path}`, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) }, signal: AbortSignal.timeout(20_000) });
  } catch (error) {
    throw new Unreachable((error as Error).message);
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((body as { error?: string }).error ?? `CARD returned ${response.status}`);
  return body as T;
}

const decisionWords = { allow: 'allowed', review: 'held for review', deny: 'denied' } as const;

/** One sentence the agent (and the person reading its transcript) can act on. */
export function explain(evaluation: Evaluation, label: string, final: 'allow' | 'deny', cardUrl: string): string {
  const parts = [`CARD ${final === 'deny' ? 'blocked' : 'allowed'} ${label}`];
  if (evaluation.review) parts.push(`Reviewer ${evaluation.review.reviewer ?? ''} decided: ${evaluation.review.note}`.replace('  ', ' '));
  else if (evaluation.memory?.applied) parts.push(`${evaluation.memory.applied.effect === 'block' ? 'Blocked' : 'Trusted'} earlier by ${evaluation.memory.applied.reviewer}: ${evaluation.memory.applied.note}`);
  else {
    const reasons = [...evaluation.signals].sort((a, b) => (b.contribution ?? 0) - (a.contribution ?? 0)).slice(0, 2).map((signal) => signal.label);
    parts.push(`Risk ${evaluation.score}/100, ${decisionWords[evaluation.decision]}${reasons.length ? ` (${reasons.join('; ')})` : ''}`);
    if (evaluation.decisionFloor) parts.push(evaluation.decisionFloor.reason);
  }
  parts.push(`Details: ${cardUrl} (evaluation ${evaluation.id.slice(0, 8)})`);
  return parts.join('. ').replace(/\.\./g, '.');
}

/** Waits for a human verdict on a held request; no answer within the limit means deny. */
export async function awaitReview(evaluation: Evaluation, deps: Deps): Promise<Evaluation | undefined> {
  const deadline = deps.now() + deps.reviewTimeoutMs;
  while (deps.now() < deadline) {
    await deps.sleep(deps.pollMs);
    const latest = await call<Evaluation>(deps, `/api/evaluations/${evaluation.id}`);
    if (latest.review) return latest;
  }
  return undefined;
}

async function decide(items: Extracted[], agent: Agent, payload: HookPayload, deps: Deps, tool: string): Promise<Verdict> {
  const session = sessionOf(agent, payload);
  const command = commandOf(payload.tool_input).slice(0, 1_000) || undefined;
  const results: Array<{ evaluation: Evaluation; label: string }> = [];
  try {
    for (const item of items) {
      const body: ArtifactRequest & { evidence: 'live' } = { ...item.request, sessionId: session, origin: { agent, tool, waitSeconds: Math.round(deps.reviewTimeoutMs / 1000), ...(command ? { command } : {}) }, evidence: 'live' };
      results.push({ evaluation: await call<Evaluation>(deps, '/api/evaluate', { method: 'POST', body: JSON.stringify(body) }), label: item.label });
    }
    const denied = results.find(({ evaluation }) => evaluation.decision === 'deny');
    if (denied) return { allow: false, reason: explain(denied.evaluation, denied.label, 'deny', deps.cardUrl) };
    for (const { evaluation, label } of results.filter(({ evaluation }) => evaluation.decision === 'review')) {
      const resolved = await awaitReview(evaluation, deps);
      if (!resolved) return { allow: false, reason: `CARD held ${label} for a human decision and nobody decided within ${Math.round(deps.reviewTimeoutMs / 1000)} seconds, so it is blocked. Approve it in ${deps.cardUrl} and try again.` };
      if (resolved.review!.decision === 'deny') return { allow: false, reason: explain(resolved, label, 'deny', deps.cardUrl) };
    }
    return { allow: true };
  } catch (error) {
    if (error instanceof Unreachable) return { allow: false, reason: `CARD is not reachable at ${deps.cardUrl}, so ${items[0].label} is blocked (CARD fails closed). Start CARD and try again.` };
    return { allow: false, reason: `CARD could not evaluate ${items[0].label}: ${(error as Error).message}. Blocked to stay safe.` };
  }
}

export async function onPreToolUse(payload: HookPayload, agent: Agent, deps: Deps): Promise<Verdict> {
  const violation = protectionViolation(payload, deps);
  if (violation) return { allow: false, reason: `CARD blocked this action. ${violation}` };
  const items = extractArtifacts(payload, deps);
  if (!items.length) return { allow: true };
  return decide(items, agent, payload, deps, payload.tool_name ?? 'tool');
}

/** Scans the instruction files the agent loads at start-up. Never blocks here; the first prompt enforces the result. */
export async function onSessionStart(payload: HookPayload, agent: Agent, deps: Deps): Promise<void> {
  const cwd = payload.cwd ?? process.cwd();
  await call(deps, '/api/heartbeat', { method: 'POST', body: JSON.stringify({ agent, workspace: cwd }) }).catch(() => undefined);
  await scanStartup(payload, agent, deps).catch(() => undefined);
}

async function scanStartup(payload: HookPayload, agent: Agent, deps: Deps): Promise<Evaluation[]> {
  const cwd = payload.cwd ?? process.cwd();
  const out: Evaluation[] = [];
  for (const file of startupFiles(cwd, deps)) {
    const item = readInstruction(file, cwd, deps, 'Startup');
    if (!item) continue;
    const body = { ...item.request, sessionId: sessionOf(agent, payload), origin: { agent, tool: 'SessionStart' }, evidence: 'live' };
    out.push(await call<Evaluation>(deps, '/api/evaluate', { method: 'POST', body: JSON.stringify(body) }));
  }
  return out;
}

/** Before each prompt: instruction files that CARD denied (or that are still awaiting a person) stop the session. */
export async function onUserPromptSubmit(payload: HookPayload, agent: Agent, deps: Deps): Promise<Verdict> {
  const cwd = payload.cwd ?? process.cwd();
  const files = startupFiles(cwd, deps);
  await call(deps, '/api/observations', { method: 'POST', body: JSON.stringify({ sessionId: sessionOf(agent, payload), kind: 'user', tool: 'prompt', text: String(payload.prompt ?? '').slice(0, MAX_OBSERVATION_TEXT) }) }).catch(() => undefined);
  if (!files.length) return { allow: true };
  try {
    let startup = await call<Evaluation[]>(deps, `/api/sessions/${encodeURIComponent(sessionOf(agent, payload))}/startup`);
    if (!startup.length) startup = await scanStartup(payload, agent, deps);
    for (const evaluation of startup) {
      const label = `instruction file ${evaluation.request.source ?? evaluation.request.name}`;
      const outcome = evaluation.decision === 'review' ? (evaluation.review ?? (await awaitReview(evaluation, deps))?.review) : undefined;
      if (evaluation.decision === 'review' && !outcome) return { allow: false, reason: `CARD is holding ${label} for a human decision. Approve or deny it in ${deps.cardUrl}, then send your message again.` };
      if (evaluation.decision === 'deny' || outcome?.decision === 'deny') return { allow: false, reason: `${explain(evaluation, label, 'deny', deps.cardUrl)} The agent loaded this file as instructions, so the session is stopped until it is fixed or approved.` };
    }
    return { allow: true };
  } catch (error) {
    if (error instanceof Unreachable) return { allow: false, reason: `CARD is not reachable at ${deps.cardUrl}, so this workspace's instruction files cannot be checked (CARD fails closed). Start CARD and send your message again.` };
    return { allow: false, reason: `CARD could not check this workspace's instruction files: ${(error as Error).message}` };
  }
}

/** Records what a tool returned so later requests can be linked to what prompted them. Never blocks. */
export async function onPostToolUse(payload: HookPayload, agent: Agent, deps: Deps): Promise<void> {
  const tool = payload.tool_name ?? 'tool';
  const response = payload.tool_response as Record<string, unknown> | string | undefined;
  const text = typeof response === 'string' ? response
    : response && typeof response === 'object'
      ? [response.result, response.stdout, response.output, (response.file as { content?: string } | undefined)?.content, response.content].filter((part) => typeof part === 'string').join('\n') || JSON.stringify(response)
      : '';
  if (!text.trim()) return;
  const kind = tool === 'WebFetch' || tool === 'WebSearch' ? 'web' : tool === 'Read' ? 'file' : tool.startsWith('mcp__') ? 'mcp' : 'command';
  await call(deps, '/api/observations', { method: 'POST', body: JSON.stringify({ sessionId: sessionOf(agent, payload), kind, tool, text: text.slice(0, MAX_OBSERVATION_TEXT) }) }).catch(() => undefined);
}
