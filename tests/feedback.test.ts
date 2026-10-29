import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApp } from '../server/index.js';
import { evaluateRisk } from '../server/engine.js';
import { applyMemory, fingerprintOf } from '../server/memory.js';
import type { StateStore, ReviewInput } from '../server/store.js';
import type { ArtifactRequest, Evaluation, MemoryRule } from '../shared/types.js';
import { feedbackMetrics, feedbackOutcome, thresholdWhatIf } from '../shared/feedback.js';
import { verifyEvaluations } from '../scripts/verify-audit.js';
import { SCORING_VERSION } from '../shared/scoring.js';
import { signIn, TEST_REVIEWER, useSession } from './helpers.js';

// Medium-severity only (sensitive permissions), so it is held for review and may be trusted.
const kit: ArtifactRequest = { type: 'package', name: 'test-kit', sessionId: 'first', source: 'registry://example.invalid', metadata: { exists: true, signed: true, permissions: ['network:egress', 'secrets:read'] } };
const safe = (extra: Partial<ReviewInput> = {}): ReviewInput => ({ decision: 'allow', note: 'Known internal tool', reason: 'expected-tool', reviewer: 'Tester', remember: false, ...extra });
const unsafe = (extra: Partial<ReviewInput> = {}): ReviewInput => ({ decision: 'deny', note: 'Not acceptable', reason: 'malicious', reviewer: 'Tester', remember: false, ...extra });
const DAY = 86_400_000;

async function withStore(fn: (store: StateStore, base: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'card-feedback-'));
  const { app, store } = await createApp({ dataDir: directory, seed: false, reviewer: TEST_REVIEWER });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  const restore = useSession(base, await signIn(base));
  try { await fn(store, base); } finally {
    restore();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}
const evaluate = (store: StateStore, request: ArtifactRequest, now?: Date) => store.evaluate(request, evaluateRisk, now);
async function trustKit(store: StateStore, now?: Date) {
  const held = await evaluate(store, kit, now);
  assert.equal(held.decision, 'review');
  const result = await store.review(held.id, safe({ remember: true }), now);
  assert.ok(result.ok);
  return { held, rule: result.rule! };
}

test('a trusted exact version is allowed on later requests in any session, with the rule recorded in the receipt', () => withStore(async (store) => {
  const { rule } = await trustKit(store);
  assert.equal(rule.effect, 'trust');
  assert.equal(Date.parse(rule.expiresAt!) - Date.parse(rule.createdAt), 30 * DAY);
  const later = await evaluate(store, { ...kit, sessionId: 'another-session' });
  assert.equal(later.ruleDecision, 'review');
  assert.equal(later.decision, 'allow');
  assert.equal(later.memory?.applied?.ruleId, rule.id);
  assert.equal(verifyEvaluations(store.appState().evaluations).valid, true);
  const audit = store.exportAudit().audit.map((event) => event.type);
  assert.ok(audit.includes('rule-created'));
}));

test('age and download changes do not break trust, but any change to content, claims or permissions does', () => withStore(async (store) => {
  await trustKit(store);
  const popularity = await evaluate(store, { ...kit, metadata: { ...kit.metadata, ageDays: 900, downloads: 5 } });
  assert.equal(popularity.decision, 'allow');
  for (const changed of [
    { ...kit, content: 'postinstall: node setup.js' },
    { ...kit, metadata: { ...kit.metadata, signed: false } },
    { ...kit, metadata: { ...kit.metadata, permissions: ['network:egress'] } },
  ]) {
    const result = await evaluate(store, changed);
    assert.ok(result.memory?.changedSinceTrust, 'a changed version is detected');
    assert.notEqual(result.decision, 'allow', 'a changed version is never silently allowed');
  }
}));

test('trust does not transfer to a lookalike name or to a different source', () => withStore(async (store) => {
  await trustKit(store);
  for (const other of [{ ...kit, name: 'test_kit' }, { ...kit, name: 'Test-Kit' }, { ...kit, source: 'registry://mirror.invalid' }]) {
    const result = await evaluate(store, other);
    assert.equal(result.memory?.applied, undefined);
    assert.equal(result.decision, result.ruleDecision);
  }
}));

test('a warning sign the reviewer did not see suspends the trust', () => withStore(async (store) => {
  await trustKit(store);
  const url = await evaluate(store, { type: 'url', name: 'test-kit', sessionId: 'chain', source: 'http://192.168.1.5/setup', metadata: { exists: false, permissions: [] } });
  assert.notEqual(url.decision, 'allow');
  const chained = await evaluate(store, { ...kit, sessionId: 'chain' });
  assert.ok(chained.memory?.trustSuspended?.newSignals.includes('name-correlation'));
  assert.equal(chained.decision, chained.ruleDecision);
  assert.notEqual(chained.decision, 'allow');
}));

test('expired trust has no effect and is explained', () => withStore(async (store) => {
  const start = new Date('2026-01-01T00:00:00.000Z');
  await trustKit(store, start);
  const before = await evaluate(store, kit, new Date(start.getTime() + 29 * DAY));
  assert.equal(before.decision, 'allow');
  const after = await evaluate(store, kit, new Date(start.getTime() + 30 * DAY));
  assert.equal(after.decision, 'review');
  assert.ok(after.memory?.expiredTrust);
}));

test('an artifact with a high-severity signal can be labelled safe but never trusted', () => withStore(async (store) => {
  const missing = await evaluate(store, { ...kit, name: 'ghost-kit', metadata: { ...kit.metadata, exists: false } });
  const refused = await store.review(missing.id, safe({ remember: true }));
  assert.equal(refused.ok, false);
  assert.equal(store.appState().rules.length, 0);
  const labelled = await store.review(missing.id, safe());
  assert.ok(labelled.ok);
}));

test('a block covers every version and spelling, outranks trust, and ends trust on that name', () => withStore(async (store) => {
  const { rule: trust } = await trustKit(store);
  const bad = await evaluate(store, { ...kit, name: 'test-kit@2.0.0', sessionId: 'x' });
  const blocked = await store.review(bad.id, unsafe({ remember: true }));
  assert.ok(blocked.ok && blocked.rule?.effect === 'block');
  assert.equal(store.appState().rules.find((rule) => rule.id === trust.id)?.revoked?.cause, 'replaced-by-block');
  for (const variant of [kit, { ...kit, name: 'Test_Kit@3.1.0' }, { ...kit, metadata: { exists: true, signed: true, permissions: [] } }]) {
    const result = await evaluate(store, { ...variant, sessionId: 'later' });
    assert.equal(result.decision, 'deny');
    assert.equal(result.memory?.applied?.effect, 'block');
  }
}));

test('a safe verdict never lifts a block on its own; revoking it explicitly does', () => withStore(async (store, base) => {
  const first = await evaluate(store, kit);
  const block = await store.review(first.id, unsafe({ remember: true }));
  assert.ok(block.ok);
  const denied = await evaluate(store, kit);
  assert.equal(denied.decision, 'deny');
  assert.equal((await store.review(denied.id, safe({ remember: true }))).ok, false);
  assert.ok((await store.review(denied.id, safe())).ok);
  assert.equal((await evaluate(store, kit)).decision, 'deny', 'the block is still in force');
  const send = (note?: string) => fetch(`${base}/api/rules/${block.ok && block.rule!.id}/revoke`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(note ? { note } : {}) });
  assert.equal((await send()).status, 400);
  assert.equal((await send('Vendor confirmed it is ours')).status, 200);
  assert.equal((await send('Again')).status, 409);
  assert.equal((await evaluate(store, kit)).decision, 'review');
}));

test('reporting a trusted request unsafe ends its trust immediately', () => withStore(async (store) => {
  const { rule } = await trustKit(store);
  const allowed = await evaluate(store, kit);
  assert.equal(allowed.decision, 'allow');
  const report = await store.review(allowed.id, unsafe());
  assert.ok(report.ok);
  assert.equal(report.ok && report.revoked[0]?.id, rule.id);
  assert.equal(store.appState().rules[0].revoked?.cause, 'reported-unsafe');
  assert.equal((await evaluate(store, kit)).decision, 'review');
}));

test('one verdict per evaluation, and the verdict never rewrites the original decision', () => withStore(async (store) => {
  const held = await evaluate(store, kit);
  assert.ok((await store.review(held.id, safe())).ok);
  assert.equal((await store.review(held.id, unsafe())).ok, false);
  const stored = store.get(held.id)!;
  assert.equal(stored.decision, 'review');
  assert.equal(stored.review?.decision, 'allow');
}));

test('human verdicts feed session correlation', () => withStore(async (store) => {
  const risky = { type: 'url' as const, name: 'helper', sessionId: 's', source: 'http://192.168.1.5/x', metadata: { exists: false, permissions: [] } };
  const first = await evaluate(store, risky);
  assert.notEqual(first.decision, 'allow');
  assert.ok((await store.review(first.id, safe())).ok);
  const next = await evaluate(store, { ...kit, name: 'helper', sessionId: 's' });
  assert.equal(next.signals.some((signal) => signal.id.includes('correlation')), false, 'a request a human called safe no longer raises suspicion');
}));

test('validates review input at the API boundary', () => withStore(async (store, base) => {
  const held = await evaluate(store, kit);
  const post = (body: unknown) => fetch(`${base}/api/reviews/${held.id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post({ decision: 'allow', note: 'x', reason: 'malicious' })).status, 400, 'reason must match the verdict');
  assert.equal((await post({ decision: 'allow', note: 'x', reason: 'nonsense' })).status, 400);
  assert.equal((await post({ decision: 'allow', note: 'x', remember: true, expiresInDays: 365 })).status, 400);
  assert.equal((await post({ decision: 'deny', note: 'x', remember: true, expiresInDays: 30 })).status, 400, 'blocks have no expiry');
  const ok = await post({ decision: 'allow', note: 'x', reason: 'expected-tool', reviewer: 'Someone else', remember: true, expiresInDays: 7 });
  assert.equal(ok.status, 200);
  const rule = store.appState().rules[0];
  assert.equal(Date.parse(rule.expiresAt!) - Date.parse(rule.createdAt), 7 * DAY);
  assert.equal(rule.reviewer, TEST_REVIEWER.name, 'the reviewer is the signed-in person, never a name in the request');
}));

test('applyMemory checks a block before trust and ignores revoked rules', () => {
  const fingerprint = fingerprintOf(kit);
  const base = { type: 'package' as const, name: 'test-kit', createdAt: '2026-01-01T00:00:00.000Z', evaluationId: 'e', reason: 'expected-tool' as const, note: 'n', reviewer: 'r' };
  const trust: MemoryRule = { ...base, id: 't', effect: 'trust', matchKey: fingerprint, coveredSignals: [], expiresAt: '2027-01-01T00:00:00.000Z' };
  const block: MemoryRule = { ...base, id: 'b', effect: 'block', matchKey: 'package|testkit' };
  const now = new Date('2026-06-01T00:00:00.000Z');
  assert.equal(applyMemory({ request: kit, fingerprint, signals: [], ruleDecision: 'review', rules: [trust, block], now }).decision, 'deny');
  const revokedBlock = { ...block, revoked: { at: '2026-02-01T00:00:00.000Z', note: 'n', cause: 'manual' as const } };
  assert.equal(applyMemory({ request: kit, fingerprint, signals: [], ruleDecision: 'review', rules: [trust, revokedBlock], now }).decision, 'allow');
});

test('feedback metrics compare the rule decision with human labels and skip unlabelled requests', () => {
  const make = (score: number, ruleDecision: Evaluation['decision'], verdict?: 'allow' | 'deny', applied?: 'trust'): Evaluation => ({
    id: `${score}-${verdict}`, timestamp: '', request: { ...kit }, score, decision: applied ? 'allow' : ruleDecision, ruleDecision, signals: [{ id: 'unsigned', label: 'Unsigned artifact', score: 25, weight: 1, reason: '' }],
    durationMs: 1, receipt: { hash: '', previousHash: '' }, scoringVersion: SCORING_VERSION,
    ...(verdict ? { review: { decision: verdict, note: '', timestamp: '' } } : {}),
    ...(applied ? { memory: { applied: { ruleId: 'r', effect: applied, createdAt: '', reviewer: '', note: '' } } } : {}),
  });
  const list = [make(60, 'deny', 'deny'), make(30, 'review', 'allow'), make(10, 'allow', 'deny'), make(5, 'allow', 'allow'), make(40, 'review', 'deny', 'trust'), make(25, 'review')];
  const metrics = feedbackMetrics(list);
  assert.deepEqual(metrics.overall, { tp: 2, fp: 1, fn: 1, tn: 1 });
  assert.equal(metrics.labelled, 5);
  assert.equal(metrics.falsePositiveRate, 0.5);
  assert.equal(metrics.trustErrors, 1);
  assert.equal(feedbackOutcome(list[1]), 'fp');
  assert.equal(feedbackOutcome(list[5]), undefined);
  const whatIf = thresholdWhatIf(list, [20, 35]);
  assert.equal(whatIf.sample, 5);
  assert.deepEqual(whatIf.rows.map((row) => [row.falseAlarms, row.missed]), [[1, 1], [0, 1]]);
});
