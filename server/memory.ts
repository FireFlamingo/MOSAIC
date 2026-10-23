import { createHash } from 'node:crypto';
import type { ArtifactRequest, Decision, MemoryOutcome, MemoryRule, Signal } from '../shared/types.js';
import { ruleStatus } from '../shared/feedback.js';
import { blockKeyOf, trustIdentityOf } from '../shared/names.js';

export { blockKeyOf, trustIdentityOf };

/**
 * Identifies one exact version of an artifact: what it is, where it comes from, what it contains
 * and what it claims about itself. Age and download counts are excluded because they change daily
 * without the artifact changing. Session ID is excluded because trust is not session-scoped.
 */
export function fingerprintOf(request: ArtifactRequest): string {
  const metadata = request.metadata ?? {};
  const canonical = {
    type: request.type,
    name: request.name.trim(),
    source: request.source?.trim() || null,
    content: request.content ?? null,
    exists: metadata.exists ?? null,
    signed: metadata.signed ?? null,
    permissions: [...new Set((metadata.permissions ?? []).map((permission) => permission.toLowerCase()))].sort(),
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

const rank: Record<Decision, number> = { allow: 0, review: 1, deny: 2 };
const atLeast = (decision: Decision, floor: Decision): Decision => (rank[decision] >= rank[floor] ? decision : floor);

export interface MemoryInput {
  request: ArtifactRequest;
  fingerprint: string;
  signals: Signal[];
  ruleDecision: Decision;
  rules: MemoryRule[];
  now: Date;
}

/**
 * Applies remembered human decisions in a fixed order:
 * 1. An active block on this name denies, whatever the score or any trust.
 * 2. An active trust on this exact fingerprint allows, but only if every current signal was
 *    already seen by the reviewer; otherwise the trust is suspended for this request.
 * 3. An active trust on the same name and source with a different fingerprint means the artifact
 *    changed after approval, so the request is held for review at minimum.
 * Expired trust is reported for explanation only and has no effect.
 */
export function applyMemory({ request, fingerprint, signals, ruleDecision, rules, now }: MemoryInput): { decision: Decision; memory?: MemoryOutcome } {
  const active = rules.filter((rule) => ruleStatus(rule, now) === 'active');
  const blockKey = blockKeyOf(request.type, request.name);
  const block = active.find((rule) => rule.effect === 'block' && rule.matchKey === blockKey);
  if (block) {
    return { decision: 'deny', memory: { applied: { ruleId: block.id, effect: 'block', createdAt: block.createdAt, reviewer: block.reviewer, note: block.note } } };
  }

  const exactTrust = active.find((rule) => rule.effect === 'trust' && rule.matchKey === fingerprint);
  if (exactTrust) {
    const covered = new Set(exactTrust.coveredSignals ?? []);
    const newSignals = signals.map((signal) => signal.id).filter((id) => !covered.has(id));
    if (newSignals.length) return { decision: ruleDecision, memory: { trustSuspended: { ruleId: exactTrust.id, newSignals } } };
    return {
      decision: 'allow',
      memory: { applied: { ruleId: exactTrust.id, effect: 'trust', createdAt: exactTrust.createdAt, reviewer: exactTrust.reviewer, note: exactTrust.note, expiresAt: exactTrust.expiresAt } },
    };
  }

  const identity = trustIdentityOf(request);
  const changed = active.find((rule) => rule.effect === 'trust' && rule.identityKey === identity);
  if (changed) {
    return { decision: atLeast(ruleDecision, 'review'), memory: { changedSinceTrust: { ruleId: changed.id, trustedAt: changed.createdAt, reviewer: changed.reviewer } } };
  }

  const expired = rules.find((rule) => rule.effect === 'trust' && rule.matchKey === fingerprint && ruleStatus(rule, now) === 'expired');
  if (expired) return { decision: ruleDecision, memory: { expiredTrust: { ruleId: expired.id, expiredAt: expired.expiresAt! } } };

  return { decision: ruleDecision };
}
