import type { Confidence, Evaluation } from './types';

const round = (value: number) => Math.round(value * 100) / 100;

/**
 * How firmly a decision rests on evidence CARD verified itself, and how far the score is from a threshold.
 * coverage = verified checks / applicable checks; margin = distance to the nearest threshold, saturating at 20
 * points (a human rule or a decision floor counts as full margin). value = 0.6 * coverage + 0.4 * margin.
 * This is an explained estimate. Whether it is calibrated is measured on the benchmark, not assumed.
 */
export function computeConfidence(evaluation: Pick<Evaluation, 'request' | 'evidence' | 'score' | 'decision' | 'decisionFloor' | 'memory' | 'policySnapshot'>): Confidence {
  const reasons: string[] = [];
  const { request, evidence } = evaluation;
  const verified = (field: 'exists' | 'signed') => evidence?.fields[field]?.from === 'registry';
  let checks: boolean[];
  if (request.type === 'package') {
    checks = [verified('exists'), verified('signed')];
    // npm install scripts were inspected when a version was resolved (or there is nothing to install).
    if (evidence?.registry === 'npm') checks.push(evidence.fields.exists?.value === false || evidence.version !== undefined);
  } else if (request.type === 'url') {
    checks = [verified('exists'), Boolean(evidence?.resolvedAddresses?.length) || evidence?.fields.exists?.value === false];
  } else {
    // Skills and MCP servers have no registry; the content is verified when an adapter observed it directly.
    checks = [Boolean(request.origin && request.content), Boolean(request.origin)];
  }
  const coverage = checks.filter(Boolean).length / checks.length;
  if (!evidence && request.type !== 'skill' && request.type !== 'mcp') reasons.push('Evidence was typed by the caller, not looked up.');
  else if (coverage < 1) reasons.push(`${checks.length - checks.filter(Boolean).length} of ${checks.length} checks could not be verified.`);
  else reasons.push('All applicable checks were verified by CARD.');

  let margin: number;
  if (evaluation.memory?.applied) { margin = 1; reasons.push('Decided by a rule a reviewer created.'); }
  else if (evaluation.decisionFloor) { margin = 1; reasons.push('Set by a decision floor for a critical finding.'); }
  else {
    const policy = evaluation.policySnapshot ?? { reviewThreshold: 20, denyThreshold: 50 };
    const distance = Math.min(Math.abs(evaluation.score - policy.reviewThreshold), Math.abs(evaluation.score - policy.denyThreshold));
    margin = Math.min(1, distance / 20);
    reasons.push(distance < 5 ? `Score is within ${round(distance)} points of a threshold.` : `Score is ${round(distance)} points from the nearest threshold.`);
  }
  const value = round(0.6 * coverage + 0.4 * margin);
  return { value, level: value < 0.4 ? 'low' : value < 0.7 ? 'medium' : 'high', reasons };
}
