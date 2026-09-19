import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { verifyEvaluations } from '../scripts/verify-audit.js';
import type { Evaluation } from '../shared/types.js';

function record(previousHash = 'GENESIS'): Evaluation {
  const original = { id: 'demo', timestamp: '2026-09-20T00:00:00Z', request: { type: 'package' as const, name: 'test-library', sessionId: 'test' }, score: 8, decision: 'allow' as const, signals: [], durationMs: 0.1 };
  return { ...original, receipt: { previousHash, hash: createHash('sha256').update(`${previousHash}:${JSON.stringify(original)}`).digest('hex') } };
}

test('audit verifier accepts intact records and rejects changed content or links', () => {
  const first = record();
  const second = record(first.receipt.hash);
  assert.deepEqual(verifyEvaluations([first, second]), { valid: true, count: 2 });
  assert.equal(verifyEvaluations([{ ...first, score: 0 }, second]).valid, false);
  assert.equal(verifyEvaluations([second, first]).valid, false);
  assert.equal(verifyEvaluations([{ ...first, receipt: { ...first.receipt, previousHash: 'changed' } }]).valid, false);
});
