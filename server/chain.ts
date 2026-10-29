import type { ArtifactRequest, ChainLink, Observation } from '../shared/types.js';
import { packageBaseName } from '../shared/names.js';

/**
 * Layer 2: links a request to earlier content in the same session that mentioned it. Content the agent read
 * from outside (web pages, MCP responses) telling it to install or fetch something is the indirect
 * prompt-injection channel; the user's own prompt mentioning the artifact marks it as user-requested.
 */
const EXTERNAL = new Set<Observation['kind']>(['web', 'mcp']);
const EXCERPT = 90;

/** The identifiers a request can be recognised by in text. */
export function identifiers(request: Pick<ArtifactRequest, 'type' | 'name' | 'source'>): string[] {
  if (request.type === 'package') {
    const base = packageBaseName(request.name).split('==')[0].toLowerCase();
    return base.length >= 3 ? [base] : [];
  }
  if (request.type === 'url') {
    try {
      const url = new URL(request.source ?? request.name);
      return [url.href.toLowerCase(), url.hostname.toLowerCase()].filter((value) => value.length >= 4);
    } catch { return []; }
  }
  return [request.name.toLowerCase()].filter((value) => value.length >= 3);
}

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Whole-token match: "zod" matches "npm i zod" but not "zodiac". */
const token = (id: string) => new RegExp(`(?<![a-z0-9@._/-])${escape(id)}(?![a-z0-9_-]|\\.[a-z0-9])`, 'i');
const INSTRUCTION = (id: string) => new RegExp(
  `(?:\\b(?:npm|pnpm|yarn|bun|pip3?|uv|pipx|poetry|cargo)\\s+(?:install|i|add)\\b[^\\n]{0,120}?|\\b(?:npx|bunx)\\s+[^\\n]{0,40}?|\\b(?:curl|wget|iwr|irm|invoke-webrequest|git\\s+clone)\\b[^\\n]{0,120}?)(?<![a-z0-9@._/-])${escape(id)}(?![a-z0-9_-]|\\.[a-z0-9])`,
  'i',
);

function excerpt(text: string, index: number) {
  const start = Math.max(0, index - EXCERPT / 2);
  return `${start > 0 ? '…' : ''}${text.slice(start, start + EXCERPT).replace(/\s+/g, ' ').trim()}${start + EXCERPT < text.length ? '…' : ''}`;
}

export interface ChainResult { links: ChainLink[]; userRequested: boolean }

export function traceChain(request: ArtifactRequest, observations: Observation[]): ChainResult {
  const ids = identifiers(request);
  const links: ChainLink[] = [];
  let userRequested = false;
  if (!ids.length) return { links, userRequested };
  for (const observation of observations) {
    for (const id of ids) {
      const instruction = INSTRUCTION(id).exec(observation.text);
      const mention = instruction ?? token(id).exec(observation.text);
      if (!mention) continue;
      if (observation.kind === 'user') { userRequested = true; break; }
      links.push({
        observationId: observation.id, kind: observation.kind, tool: observation.tool, at: observation.at,
        instruction: Boolean(instruction), external: EXTERNAL.has(observation.kind), excerpt: excerpt(observation.text, mention.index),
      });
      break;
    }
  }
  return { links, userRequested };
}
