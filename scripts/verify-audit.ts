import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Evaluation } from '../shared/types.js';
import { verifyAuditChain, verifyConsistency, type AuditExport } from '../server/audit.js';

/** Verifies the chain of original evaluation receipts. */
export function verifyEvaluations(evaluations: Evaluation[]): { valid: boolean; count: number; error?: string } {
  let previousHash = 'GENESIS';
  for (const [index, evaluation] of evaluations.entries()) {
    const { receipt, review: _review, ...original } = evaluation;
    const hash = createHash('sha256').update(`${previousHash}:${JSON.stringify(original)}`).digest('hex');
    if (!receipt || receipt.previousHash !== previousHash || receipt.hash !== hash) {
      return { valid: false, count: index, error: `Evaluation ${index + 1} failed integrity verification.` };
    }
    previousHash = receipt.hash;
  }
  return { valid: true, count: evaluations.length };
}

/** Full check of a CARD export: evaluation receipts, the signed audit chain, and that reviews, rules and policy match it. */
export function verifyExport(data: AuditExport) {
  const evaluations = verifyEvaluations(data.evaluations);
  const chain = verifyAuditChain(data.audit, data.publicKey);
  const consistency = verifyConsistency(data);
  const error = [evaluations, chain, consistency].map((result) => ('error' in result ? result.error : undefined)).find(Boolean);
  return {
    valid: evaluations.valid && chain.valid && consistency.valid,
    evaluations: evaluations.count,
    auditEvents: data.audit.length,
    ...(error ? { error } : {}),
    note: 'Detects edited, inserted or removed records and invalid signatures. It cannot detect events cut off from the end, or a full rewrite by someone holding the signing key.',
  };
}

async function main() {
  if (!process.argv[2]) throw new Error('Usage: npm run verify:audit -- path/to/card-audit.json');
  const data = JSON.parse(await readFile(process.argv[2], 'utf8'));
  if (!Array.isArray(data.evaluations)) throw new Error('Export must contain an evaluations array.');
  const result = data.version === 2 ? verifyExport(data as AuditExport) : verifyEvaluations(data.evaluations);
  console.log(JSON.stringify(result, null, 2));
  if (!result.valid) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
