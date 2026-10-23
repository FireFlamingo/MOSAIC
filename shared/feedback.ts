import type { ArtifactType, Decision, Evaluation, FeedbackReason, MemoryRule } from './types';
import { SCORING_VERSION, SIGNAL_RULES } from './scoring';

export const TRUST_EXPIRY_DAYS = [7, 30, 90] as const;
export const DEFAULT_TRUST_DAYS = 30;

export const FEEDBACK_REASONS: Record<FeedbackReason, { verdict: 'allow' | 'deny'; label: string }> = {
  'expected-tool': { verdict: 'allow', label: 'Known, expected artifact' },
  'wrong-signal': { verdict: 'allow', label: 'A warning sign was wrong' },
  'other-safe': { verdict: 'allow', label: 'Other reason (safe)' },
  malicious: { verdict: 'deny', label: 'Looks malicious' },
  'policy-violation': { verdict: 'deny', label: 'Not allowed by our policy' },
  'insufficient-evidence': { verdict: 'deny', label: 'Not enough evidence to trust' },
  'other-unsafe': { verdict: 'deny', label: 'Other reason (unsafe)' },
};

export type RuleStatus = 'active' | 'expired' | 'revoked';
export function ruleStatus(rule: MemoryRule, now: Date = new Date()): RuleStatus {
  if (rule.revoked) return 'revoked';
  if (rule.expiresAt && now.getTime() >= Date.parse(rule.expiresAt)) return 'expired';
  return 'active';
}

/** Signals whose rule severity is High can be labelled safe, but never remembered as trusted. */
export const highSeveritySignals = (evaluation: Pick<Evaluation, 'signals'>) =>
  evaluation.signals.filter((signal) => SIGNAL_RULES[signal.id as keyof typeof SIGNAL_RULES]?.severity === 'high');

/** What a human concluded, or undefined when nobody has labelled the request. */
export const humanVerdict = (evaluation: Evaluation): 'allow' | 'deny' | undefined => evaluation.review?.decision;

/** The rule engine's own call, before any trust or block rule changed it. */
export const ruleDecisionOf = (evaluation: Evaluation): Decision => evaluation.ruleDecision ?? evaluation.decision;

export type Outcome = 'tp' | 'fp' | 'fn' | 'tn';
export const OUTCOME_LABELS: Record<Outcome, string> = {
  tp: 'Correctly flagged (true positive)',
  fp: 'False alarm (false positive)',
  fn: 'Missed risk (false negative)',
  tn: 'Correctly cleared (true negative)',
};
export function feedbackOutcome(evaluation: Evaluation): Outcome | undefined {
  const verdict = humanVerdict(evaluation);
  if (!verdict) return undefined;
  const flagged = ruleDecisionOf(evaluation) !== 'allow';
  const unsafe = verdict === 'deny';
  return flagged ? (unsafe ? 'tp' : 'fp') : (unsafe ? 'fn' : 'tn');
}

export interface Confusion { tp: number; fp: number; fn: number; tn: number }
const emptyConfusion = (): Confusion => ({ tp: 0, fp: 0, fn: 0, tn: 0 });
const ratio = (top: number, bottom: number) => (bottom ? top / bottom : null);

function tally(target: Confusion, flagged: boolean, unsafe: boolean) {
  if (flagged && unsafe) target.tp += 1;
  else if (flagged) target.fp += 1;
  else if (unsafe) target.fn += 1;
  else target.tn += 1;
}

/**
 * Compares the rule engine's decision with human labels. A request counts as "flagged" when the
 * rules returned review or deny. Only human-labelled requests are counted; unlabelled requests are
 * never assumed correct.
 */
export function feedbackMetrics(evaluations: Evaluation[]) {
  const labelled = evaluations.filter((evaluation) => humanVerdict(evaluation));
  const overall = emptyConfusion();
  const byType = {} as Record<ArtifactType, Confusion>;
  const bySignal = new Map<string, { label: string; fired: number; falseAlarms: number; confirmed: number }>();
  let trustErrors = 0;
  let blockOverturned = 0;
  for (const evaluation of labelled) {
    const flagged = ruleDecisionOf(evaluation) !== 'allow';
    const unsafe = humanVerdict(evaluation) === 'deny';
    tally(overall, flagged, unsafe);
    tally(byType[evaluation.request.type] ??= emptyConfusion(), flagged, unsafe);
    if (evaluation.memory?.applied?.effect === 'trust' && unsafe) trustErrors += 1;
    if (evaluation.memory?.applied?.effect === 'block' && !unsafe) blockOverturned += 1;
    for (const signal of evaluation.signals) {
      const entry = bySignal.get(signal.id) ?? { label: signal.label, fired: 0, falseAlarms: 0, confirmed: 0 };
      entry.fired += 1;
      if (flagged && !unsafe) entry.falseAlarms += 1;
      if (unsafe) entry.confirmed += 1;
      bySignal.set(signal.id, entry);
    }
  }
  return {
    total: evaluations.length,
    labelled: labelled.length,
    overall,
    falsePositiveRate: ratio(overall.fp, overall.fp + overall.tn),
    falseNegativeRate: ratio(overall.fn, overall.fn + overall.tp),
    precision: ratio(overall.tp, overall.tp + overall.fp),
    detectionRate: ratio(overall.tp, overall.tp + overall.fn),
    byType,
    signals: [...bySignal.entries()].map(([id, entry]) => ({ id, ...entry })).sort((a, b) => b.falseAlarms - a.falseAlarms || b.fired - a.fired),
    trustErrors,
    blockOverturned,
  };
}

/**
 * Replays labelled requests from the current scoring model against other review thresholds.
 * Scores from older models are excluded because they are not on the same scale.
 */
export function thresholdWhatIf(evaluations: Evaluation[], thresholds: number[]) {
  const comparable = evaluations.filter((evaluation) => humanVerdict(evaluation) && evaluation.scoringVersion === SCORING_VERSION);
  return {
    sample: comparable.length,
    rows: thresholds.map((threshold) => {
      const counts = emptyConfusion();
      for (const evaluation of comparable) tally(counts, evaluation.score >= threshold, humanVerdict(evaluation) === 'deny');
      return { threshold, falseAlarms: counts.fp, missed: counts.fn, caught: counts.tp, cleared: counts.tn };
    }),
  };
}
