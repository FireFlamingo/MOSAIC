import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Evaluation } from '../shared/types.js';

/** Verifies original evaluations; human reviews are recorded separately. */
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

async function main() {
  if (!process.argv[2]) throw new Error('Usage: npm run verify:audit -- path/to/mosaic-audit.json');
  const data = JSON.parse(await readFile(process.argv[2], 'utf8'));
  if (!Array.isArray(data.evaluations)) throw new Error('Export must contain an evaluations array.');
  const result = verifyEvaluations(data.evaluations);
  console.log(JSON.stringify(result, null, 2));
  if (!result.valid) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
