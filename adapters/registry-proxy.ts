import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { ArtifactRequest, Evaluation } from '../shared/types.js';
import { awaitReview, call, explain, Unreachable, type Deps } from './core.js';

/**
 * A local npm registry and PyPI simple-index proxy. Every package the workspace resolves passes through CARD,
 * however the install was started (a script, a lockfile, a tool the command parser does not know).
 * Point a workspace at it with `.npmrc` (registry + replace-registry-host=always) and PIP_INDEX_URL.
 */
export interface RegistryProxyOptions {
  deps: Deps;
  npmUpstream?: string;
  pypiUpstream?: string;
  evidence?: 'live' | 'caller';
}

type Gate = { allow: true } | { allow: false; status: 403 | 503; reason: string };
const DECISION_CACHE_MS = 5 * 60 * 1000;

/** "/zod", "/zod/3.1.0", "/@scope%2fpkg", "/@scope/pkg/-/pkg-1.0.0.tgz" -> name and optional version. */
export function parseNpmPath(path: string): { name: string; version?: string; tarball: boolean } | undefined {
  const clean = decodeURIComponent(path.split('?')[0]).replace(/^\/+/, '');
  if (!clean || clean.startsWith('-/')) return undefined;
  const [left, file] = clean.split('/-/');
  const parts = left.split('/');
  const scoped = parts[0].startsWith('@');
  const name = scoped ? parts.slice(0, 2).join('/') : parts[0];
  if (!name || (scoped && parts.length < 2)) return undefined;
  if (file) {
    const base = name.split('/').at(-1)!;
    const version = file.startsWith(`${base}-`) ? file.slice(base.length + 1).replace(/\.tgz$/, '') : undefined;
    return { name, version, tarball: true };
  }
  const version = parts[scoped ? 2 : 1];
  return { name, ...(version ? { version } : {}), tarball: false };
}

export function createRegistryProxy(options: RegistryProxyOptions): Server {
  const { deps } = options;
  const npmUpstream = (options.npmUpstream ?? 'https://registry.npmjs.org').replace(/\/$/, '');
  const pypiUpstream = (options.pypiUpstream ?? 'https://pypi.org').replace(/\/$/, '');
  const decided = new Map<string, { gate: Gate; at: number }>();

  async function gate(request: Omit<ArtifactRequest, 'sessionId'>, label: string, key: string): Promise<Gate> {
    const cached = decided.get(key);
    if (cached && deps.now() - cached.at < DECISION_CACHE_MS) return cached.gate;
    let result: Gate;
    try {
      const body = { ...request, sessionId: `registry-proxy:${request.ecosystem}`, origin: { agent: 'registry-proxy', tool: request.ecosystem, command: label }, evidence: options.evidence ?? 'live' };
      let evaluation = await call<Evaluation>(deps, '/api/evaluate', { method: 'POST', body: JSON.stringify(body) });
      if (evaluation.decision === 'review') {
        const resolved = await awaitReview(evaluation, deps);
        if (!resolved) return { allow: false, status: 403, reason: `CARD held ${label} for a human decision and nobody decided in time. Approve it in ${deps.cardUrl} and run the install again.` };
        evaluation = resolved;
      }
      const final = evaluation.review?.decision ?? evaluation.decision;
      result = final === 'deny' ? { allow: false, status: 403, reason: explain(evaluation, label, 'deny', deps.cardUrl) } : { allow: true };
    } catch (error) {
      return { allow: false, status: 503, reason: error instanceof Unreachable ? `CARD is not reachable at ${deps.cardUrl}; package downloads are blocked until it runs (fail closed).` : `CARD could not evaluate ${label}: ${(error as Error).message}` };
    }
    decided.set(key, { gate: result, at: deps.now() });
    return result;
  }

  async function relay(req: IncomingMessage, res: ServerResponse, target: string) {
    const upstream = await deps.fetch(target, { headers: { accept: req.headers.accept ?? '*/*', 'user-agent': req.headers['user-agent'] ?? 'card-registry-proxy' } });
    const headers: Record<string, string> = {};
    upstream.headers.forEach((value, name) => { if (!['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(name)) headers[name] = value; });
    res.writeHead(upstream.status, headers);
    res.end(Buffer.from(await upstream.arrayBuffer()));
  }

  const refuse = (res: ServerResponse, decision: Extract<Gate, { allow: false }>) => {
    res.writeHead(decision.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: decision.reason }));
  };

  return createServer((req, res) => {
    void (async () => {
      const path = req.url ?? '/';
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'The CARD registry proxy only serves package downloads.' }));
      }
      const simple = /^\/simple\/([^/]+)\/?$/.exec(path.split('?')[0]);
      if (simple) {
        const name = decodeURIComponent(simple[1]);
        const decision = await gate({ type: 'package', ecosystem: 'pypi', name }, `pip install ${name}`, `pypi|${name.toLowerCase()}`);
        if (!decision.allow) return refuse(res, decision);
        return relay(req, res, `${pypiUpstream}/simple/${encodeURIComponent(name)}/`);
      }
      const npm = parseNpmPath(path);
      if (!npm) return relay(req, res, `${npmUpstream}${path}`);
      const spec = npm.version ? `${npm.name}@${npm.version}` : npm.name;
      // Keyed by exact version: allowing the package listing must not wave through any version's download.
      const decision = await gate({ type: 'package', ecosystem: 'npm', name: spec }, `npm install ${spec}`, `npm|${spec}`);
      if (!decision.allow) return refuse(res, decision);
      return relay(req, res, `${npmUpstream}${path}`);
    })().catch((error) => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: `CARD registry proxy error: ${(error as Error).message}` }));
    });
  });
}
