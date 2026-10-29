import { readFileSync } from 'node:fs';
import { normalizeName, packageBaseName } from '../shared/names.js';

/** Reference lists of real, popular names (see shared/reference/popular-packages.json for sources and date). */
const popular = JSON.parse(readFileSync(new URL('../shared/reference/popular-packages.json', import.meta.url), 'utf8')) as { npm: string[]; pypi: string[] };

/** Reference MCP servers from the official modelcontextprotocol/servers project and widely used vendor servers. */
const KNOWN_MCP_SERVERS = [
  'filesystem', 'fetch', 'git', 'github', 'gitlab', 'memory', 'sequential-thinking', 'sqlite', 'postgres', 'puppeteer',
  'playwright', 'brave-search', 'slack', 'google-drive', 'google-maps', 'everything', 'time', 'sentry', 'redis', 'notion',
];

/** Domains coding agents commonly fetch from. A near-miss of one of these is a phantom-squatting cue. */
const KNOWN_DOMAINS = [
  'github.com', 'githubusercontent.com', 'gitlab.com', 'bitbucket.org', 'npmjs.com', 'npmjs.org', 'pypi.org', 'pythonhosted.org',
  'python.org', 'nodejs.org', 'crates.io', 'rust-lang.org', 'go.dev', 'golang.org', 'anthropic.com', 'claude.ai', 'openai.com',
  'microsoft.com', 'google.com', 'googleapis.com', 'stackoverflow.com', 'mozilla.org', 'docker.com', 'amazonaws.com',
  'cloudflare.com', 'vercel.com', 'readthedocs.io', 'jsdelivr.net', 'unpkg.com', 'huggingface.co',
];

/** Optimal-string-alignment distance: insertions, deletions, substitutions and adjacent swaps each cost 1. */
export function editDistance(left: string, right: string): number {
  const rows = Array.from({ length: left.length + 1 }, (_, i) => Array.from({ length: right.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= left.length; i += 1) {
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      rows[i][j] = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && left[i - 1] === right[j - 2] && left[i - 2] === right[j - 1]) rows[i][j] = Math.min(rows[i][j], rows[i - 2][j - 2] + 1);
    }
  }
  return rows[left.length][right.length];
}

const allowedDistance = (length: number) => Math.max(1, Math.floor(length * 0.2));

interface ReferenceList { entries: Array<readonly [string, string]>; exact: Set<string> }
const reference = (names: string[]): ReferenceList => {
  const entries = names.map((name) => [name, normalizeName(name)] as const);
  return { entries, exact: new Set(entries.map(([, normal]) => normal)) };
};
const NPM = reference(popular.npm);
const PYPI = reference(popular.pypi);
const ANY_REGISTRY = reference([...popular.npm, ...popular.pypi]);
const MCP = reference(KNOWN_MCP_SERVERS);

/** Returns the closest reference name the candidate imitates, or undefined. Exact matches are never lookalikes. */
function closest(candidate: string, list: ReferenceList): string | undefined {
  const normal = normalizeName(candidate);
  if (normal.length < 4 || list.exact.has(normal)) return undefined;
  let best: { name: string; distance: number } | undefined;
  for (const [name, reference] of list.entries) {
    if (Math.abs(reference.length - normal.length) > allowedDistance(reference.length)) continue;
    const distance = editDistance(normal, reference);
    if (distance <= allowedDistance(reference.length) && (!best || distance < best.distance)) best = { name, distance };
  }
  return best?.name;
}

export function similarPopularPackage(name: string, ecosystem?: 'npm' | 'pypi'): string | undefined {
  return closest(packageBaseName(name), ecosystem === 'npm' ? NPM : ecosystem === 'pypi' ? PYPI : ANY_REGISTRY);
}

export const similarMcpServer = (name: string) => closest(name, MCP);

/** Flags a near-miss of a known domain, or a known domain used as a subdomain of someone else's domain. */
export function lookalikeDomain(hostname: string): { imitates: string; how: 'near-miss' | 'subdomain' } | undefined {
  const host = hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
  if (KNOWN_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`))) return undefined;
  const embedded = KNOWN_DOMAINS.find((domain) => host.startsWith(`${domain}.`) || host.includes(`.${domain}.`));
  if (embedded) return { imitates: embedded, how: 'subdomain' };
  const registrable = host.split('.').slice(-2).join('.');
  for (const domain of KNOWN_DOMAINS) {
    if (Math.abs(domain.length - registrable.length) > 1) continue;
    if (registrable !== domain && editDistance(registrable, domain) === 1) return { imitates: domain, how: 'near-miss' };
  }
  return undefined;
}

export const referenceListInfo = { npm: popular.npm.length, pypi: popular.pypi.length, mcp: KNOWN_MCP_SERVERS.length, domains: KNOWN_DOMAINS.length };
