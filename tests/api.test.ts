import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApp } from '../server/index.js';
import { evaluateRisk } from '../server/engine.js';
import type { ArtifactRequest } from '../shared/types.js';

async function withServer(fn: (base: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'mosaic-api-'));
  const { app } = await createApp({ dataDir: directory, seed: false });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  try { await fn(base); } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); await rm(directory, { recursive: true, force: true }); }
}

const artifact: ArtifactRequest = { type: 'package', name: 'test-kit', sessionId: 'session-one', metadata: { exists: true, ageDays: 2, downloads: 12, signed: false, permissions: ['network:egress', 'secrets:read'] } };

test('rejects malformed artifact input', async () => withServer(async (base) => {
  const response = await fetch(`${base}/api/evaluate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...artifact, type: 'binary' }) });
  assert.equal(response.status, 400);
}));

test('persists evaluation and records immutable review audit event', async () => withServer(async (base) => {
  const created = await fetch(`${base}/api/evaluate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(artifact) });
  assert.equal(created.status, 201);
  const evaluation = await created.json() as { id: string; receipt: { hash: string } };
  const review = await fetch(`${base}/api/reviews/${evaluation.id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'allow', note: 'Synthetic test approval' }) });
  assert.equal(review.status, 200);
  const state = await (await fetch(`${base}/api/state`)).json() as { evaluations: Array<{ id: string; receipt: { hash: string }; review?: unknown }> };
  assert.equal(state.evaluations[0].id, evaluation.id);
  assert.equal(state.evaluations[0].receipt.hash, evaluation.receipt.hash);
  assert.ok(state.evaluations[0].review);
  const audit = await (await fetch(`${base}/api/export`)).json() as { audit: Array<{ type: string }> };
  assert.deepEqual(audit.audit.map((event) => event.type), ['evaluation', 'review']);
}));

test('serializes concurrent evaluations into one receipt chain', async () => withServer(async (base) => {
  const responses = await Promise.all(Array.from({ length: 6 }, (_, index) => fetch(`${base}/api/evaluate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...artifact, name: `test-kit-${index}`, sessionId: `parallel-${index}` }) })));
  assert.ok(responses.every((response) => response.status === 201));
  const state = await (await fetch(`${base}/api/state`)).json() as { evaluations: Array<{ receipt: { hash: string; previousHash: string } }> };
  assert.equal(state.evaluations.length, 6);
  assert.equal(state.evaluations[0].receipt.previousHash, 'GENESIS');
  for (let index = 1; index < state.evaluations.length; index += 1) assert.equal(state.evaluations[index].receipt.previousHash, state.evaluations[index - 1].receipt.hash);
}));

test('persists policy, reviews, and verifiable receipts across a fresh app instance', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mosaic-reopen-'));
  try {
    const first = await createApp({ dataDir: directory, seed: false });
    const created = await first.store.evaluate(artifact, evaluateRisk);
    assert.equal(created.decision, 'review');
    const reviewed = await first.store.review(created.id, { decision: 'allow', note: 'Persist this synthetic decision', timestamp: '2026-01-01T00:00:00.000Z' });
    assert.ok(reviewed);
    await first.store.setPolicy({ reviewThreshold: 25, denyThreshold: 65, correlationEnabled: false });
    const second = await createApp({ dataDir: directory, seed: false });
    const restored = second.store.appState().evaluations[0];
    assert.deepEqual(second.store.policy(), { reviewThreshold: 25, denyThreshold: 65, correlationEnabled: false });
    assert.equal(restored.review?.note, 'Persist this synthetic decision');
    const { receipt, review: _review, ...unsigned } = restored;
    const expected = createHash('sha256').update(`${receipt.previousHash}:${JSON.stringify(unsigned)}`).digest('hex');
    assert.equal(receipt.hash, expected);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('enforces policy, review, origin, and request-body boundaries', async () => withServer(async (base) => {
  const invalidPolicy = await fetch(`${base}/api/policy`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reviewThreshold: 70, denyThreshold: 70, correlationEnabled: true }) });
  assert.equal(invalidPolicy.status, 400);
  const validPolicy = await fetch(`${base}/api/policy`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reviewThreshold: 20, denyThreshold: 60, correlationEnabled: false }) });
  assert.equal(validPolicy.status, 200);
  const safe = await fetch(`${base}/api/evaluate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'url', name: 'docs', sessionId: 'safe', source: 'https://docs.example.invalid', metadata: { exists: true, signed: true, permissions: [] } }) });
  const safeEvaluation = await safe.json() as { id: string; decision: string };
  assert.equal(safeEvaluation.decision, 'allow');
  const nonReview = await fetch(`${base}/api/reviews/${safeEvaluation.id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'allow', note: 'Cannot review this' }) });
  assert.equal(nonReview.status, 409);
  const pending = await fetch(`${base}/api/evaluate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(artifact) });
  const pendingEvaluation = await pending.json() as { id: string };
  const firstReview = await fetch(`${base}/api/reviews/${pendingEvaluation.id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'deny', note: 'Synthetic denial' }) });
  assert.equal(firstReview.status, 200);
  const duplicateReview = await fetch(`${base}/api/reviews/${pendingEvaluation.id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'deny', note: 'Again' }) });
  assert.equal(duplicateReview.status, 409);
  const blockedOrigin = await fetch(`${base}/api/evaluate`, { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: JSON.stringify(artifact) });
  assert.equal(blockedOrigin.status, 403);
  const malformed = await fetch(`${base}/api/evaluate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
  assert.equal(malformed.status, 400);
  const oversized = await fetch(`${base}/api/evaluate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...artifact, content: 'x'.repeat(17_000) }) });
  assert.equal(oversized.status, 413);
}));

test('runs scenarios in isolated sessions with live review and correlation signals', async () => withServer(async (base) => {
  const review = await (await fetch(`${base}/api/scenarios/review-queue/run`, { method: 'POST' })).json() as Array<{ decision: string; request: { sessionId: string } }>;
  assert.equal(review.length, 1);
  assert.equal(review[0].decision, 'review');
  const first = await (await fetch(`${base}/api/scenarios/correlated-chain/run`, { method: 'POST' })).json() as Array<{ request: { sessionId: string }; signals: Array<{ id: string }> }>;
  const rerun = await (await fetch(`${base}/api/scenarios/correlated-chain/run`, { method: 'POST' })).json() as Array<{ request: { sessionId: string } }>;
  assert.notEqual(first[0].request.sessionId, rerun[0].request.sessionId);
  assert.ok(first[1].signals.some((signal) => signal.id === 'session-correlation'));
  assert.ok(first[1].signals.some((signal) => signal.id === 'name-correlation'));
}));
