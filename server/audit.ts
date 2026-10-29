import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Evaluation, MemoryRule, Policy } from '../shared/types.js';

export type AuditEventType = 'evaluation' | 'review' | 'policy' | 'scoring-model' | 'rule-created' | 'rule-revoked' | 'storage-migrated';

export interface AuditEvent {
  id: string;
  timestamp: string;
  type: AuditEventType;
  evaluationId?: string;
  detail: Record<string, unknown>;
  previousHash?: string;
  hash?: string;
  signature?: string;
}

export const AUDIT_GENESIS = 'GENESIS';

/** The signed part of an event. Built with a fixed key order so hashing is reproducible after a JSON round trip. */
const eventCore = (event: AuditEvent) => ({ id: event.id, timestamp: event.timestamp, type: event.type, evaluationId: event.evaluationId, detail: event.detail });
export const eventHash = (previousHash: string, event: AuditEvent) =>
  createHash('sha256').update(`${previousHash}:${JSON.stringify(eventCore(event))}`).digest('hex');

export function sealEvent(event: AuditEvent, previousHash: string, privateKey: KeyObject): AuditEvent {
  const hash = eventHash(previousHash, event);
  return { ...eventCore(event), previousHash, hash, signature: sign(null, Buffer.from(hash, 'hex'), privateKey).toString('base64') };
}

/**
 * The signing key lives in data/keys. It proves which CARD instance wrote the log and detects edits by anyone
 * without the key; someone with full access to this machine's files could still re-sign a rewritten log.
 */
export function loadOrCreateSigningKey(dataDir: string): { privateKey: KeyObject; publicKeyPem: string } {
  const directory = join(dataDir, 'keys');
  const file = join(directory, 'audit-ed25519.pem');
  if (!existsSync(file)) {
    mkdirSync(directory, { recursive: true });
    const { privateKey } = generateKeyPairSync('ed25519');
    writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  }
  const privateKey = createPrivateKey(readFileSync(file, 'utf8'));
  const publicKeyPem = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString();
  return { privateKey, publicKeyPem };
}

export interface AuditExport {
  version: 2;
  format: 'card-audit';
  exportedAt: string;
  scoringVersion?: string;
  policy: Policy;
  publicKey: string;
  evaluations: Evaluation[];
  rules: MemoryRule[];
  audit: AuditEvent[];
}

export type VerifyResult = { valid: true; count: number } | { valid: false; count: number; error: string };

export function verifyAuditChain(events: AuditEvent[], publicKeyPem: string): VerifyResult {
  const publicKey = createPublicKey(publicKeyPem);
  let previousHash = AUDIT_GENESIS;
  for (const [index, event] of events.entries()) {
    const where = `Audit event ${index + 1} (${event.type})`;
    if (event.previousHash !== previousHash) return { valid: false, count: index, error: `${where} does not link to the event before it.` };
    if (event.hash !== eventHash(previousHash, event)) return { valid: false, count: index, error: `${where} was changed after it was recorded.` };
    if (!event.signature || !verify(null, Buffer.from(event.hash, 'hex'), publicKey, Buffer.from(event.signature, 'base64'))) {
      return { valid: false, count: index, error: `${where} has a missing or invalid signature.` };
    }
    previousHash = event.hash;
  }
  return { valid: true, count: events.length };
}

/** Checks that current evaluations, reviews, rules and policy are exactly what the signed log says happened. */
export function verifyConsistency(data: Pick<AuditExport, 'evaluations' | 'rules' | 'audit' | 'policy'>): VerifyResult {
  const fail = (error: string): VerifyResult => ({ valid: false, count: 0, error });
  const evaluationEvents = new Map<string, AuditEvent>();
  const reviewEvents = new Map<string, AuditEvent>();
  const rules = new Map<string, MemoryRule>();
  let policy: Policy | undefined;
  for (const event of data.audit) {
    if (event.type === 'evaluation' && event.evaluationId) evaluationEvents.set(event.evaluationId, event);
    if (event.type === 'review' && event.evaluationId) reviewEvents.set(event.evaluationId, event);
    if (event.type === 'policy' || event.type === 'scoring-model') policy = (event.detail.policy as Policy | undefined) ?? policy;
    if (event.type === 'rule-created') {
      const rule = structuredClone(event.detail.rule as MemoryRule);
      rules.set(rule.id, rule);
    }
    if (event.type === 'rule-revoked') {
      const rule = rules.get(event.detail.ruleId as string);
      if (!rule) return fail(`A revocation refers to unknown rule ${String(event.detail.ruleId)}.`);
      rule.revoked = { at: event.timestamp, note: event.detail.note as string, cause: event.detail.cause as NonNullable<MemoryRule['revoked']>['cause'], ...(event.evaluationId ? { evaluationId: event.evaluationId } : {}) };
    }
  }
  for (const evaluation of data.evaluations) {
    const event = evaluationEvents.get(evaluation.id);
    if (!event || JSON.stringify(event.detail.receipt) !== JSON.stringify(evaluation.receipt)) return fail(`Evaluation ${evaluation.id} has no matching signed record.`);
    const reviewEvent = reviewEvents.get(evaluation.id);
    if (Boolean(evaluation.review) !== Boolean(reviewEvent)) return fail(`The human verdict on ${evaluation.request.name} does not match the signed log.`);
    if (evaluation.review && reviewEvent) {
      for (const [key, value] of Object.entries(evaluation.review)) {
        if (JSON.stringify(reviewEvent.detail[key]) !== JSON.stringify(value)) return fail(`The human verdict on ${evaluation.request.name} was edited (${key}).`);
      }
    }
  }
  if (data.rules.length !== rules.size) return fail('The rule list does not match the signed log.');
  for (const rule of data.rules) {
    if (JSON.stringify(rules.get(rule.id)) !== JSON.stringify(rule)) return fail(`Rule for ${rule.name} was edited outside CARD.`);
  }
  if (policy && JSON.stringify(policy) !== JSON.stringify(data.policy)) return fail('The active policy does not match the last signed policy change.');
  return { valid: true, count: data.audit.length };
}
