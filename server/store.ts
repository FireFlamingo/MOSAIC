import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AppState, ArtifactRequest, Decision, Evaluation, FeedbackReason, HumanReview, MemoryRule, Policy, RuleRevocationCause, Scenario, Signal, ScoringBreakdown } from '../shared/types.js';
import { defaultPolicy } from './engine.js';
import { SCORING_VERSION } from '../shared/scoring.js';
import { highSeveritySignals, ruleStatus } from '../shared/feedback.js';
import { applyMemory, blockKeyOf, fingerprintOf, trustIdentityOf } from './memory.js';

export const DEFAULT_POLICY: Policy = defaultPolicy;

interface AuditEvent {
  id: string;
  timestamp: string;
  type: 'evaluation' | 'review' | 'policy' | 'scoring-model' | 'rule-created' | 'rule-revoked';
  evaluationId?: string;
  detail: Record<string, unknown>;
}

interface PersistedState {
  version: 1;
  evaluations: Evaluation[];
  policy: Policy;
  audit: AuditEvent[];
  scoringVersion?: string;
  rules?: MemoryRule[];
}

export interface ReviewInput {
  decision: 'allow' | 'deny';
  note: string;
  reason: FeedbackReason;
  reviewer: string;
  remember: boolean;
  expiresInDays?: number;
}
export type ReviewResult =
  | { ok: true; evaluation: Evaluation; rule?: MemoryRule; revoked: MemoryRule[] }
  | { ok: false; status: 404 | 409; error: string };

const DAY_MS = 86_400_000;

const canonical = (value: unknown) => JSON.stringify(value);
const receiptPayload = (evaluation: Omit<Evaluation, 'receipt' | 'review'>) => canonical(evaluation);
const digest = (previousHash: string, payload: string) => createHash('sha256').update(`${previousHash}:${payload}`).digest('hex');

export class StateStore {
  private state: PersistedState = { version: 1, evaluations: [], policy: { ...DEFAULT_POLICY }, audit: [], scoringVersion: SCORING_VERSION, rules: [] };
  private readonly file: string;
  private mutation: Promise<void> = Promise.resolve();

  constructor(private readonly dataDir: string, private readonly scenarios: Scenario[]) {
    this.file = join(dataDir, 'state.json');
  }

  async init(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8')) as PersistedState;
      if (!raw || raw.version !== 1 || !Array.isArray(raw.evaluations) || !raw.policy || !Array.isArray(raw.audit)) throw new Error('Invalid persisted CARD state');
      this.state = raw;
      if (!Array.isArray(raw.rules)) raw.rules = [];
      if (raw.scoringVersion !== SCORING_VERSION) {
        const previousPolicy = { ...raw.policy };
        // Upgrade old factory defaults; custom thresholds and original receipts stay intact.
        if ((raw.policy.reviewThreshold === 35 && raw.policy.denyThreshold === 70) || (raw.policy.reviewThreshold === 50 && raw.policy.denyThreshold === 75)) {
          raw.policy = { ...DEFAULT_POLICY, correlationEnabled: raw.policy.correlationEnabled };
        }
        raw.audit.push({ id: randomUUID(), timestamp: new Date().toISOString(), type: 'scoring-model', detail: { previousVersion: raw.scoringVersion ?? 'heuristic-v1', scoringVersion: SCORING_VERSION, previousPolicy, policy: { ...raw.policy } } });
        raw.scoringVersion = SCORING_VERSION;
        await this.persist();
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await this.persist();
    }
  }

  appState(): AppState {
    return { evaluations: structuredClone(this.state.evaluations), policy: { ...this.state.policy }, scenarios: structuredClone(this.scenarios), rules: structuredClone(this.rules()) };
  }

  exportAudit(): PersistedState { return structuredClone(this.state); }
  policy(): Policy { return { ...this.state.policy }; }
  private rules(): MemoryRule[] { return (this.state.rules ??= []); }
  get(id: string): Evaluation | undefined {
    const value = this.state.evaluations.find((item) => item.id === id);
    return value && structuredClone(value);
  }

  async setPolicy(policy: Policy): Promise<Policy> {
    return this.transact(async () => {
      this.state.policy = { ...policy };
      this.state.audit.push({ id: randomUUID(), timestamp: new Date().toISOString(), type: 'policy', detail: { policy } });
      return this.policy();
    });
  }

  async append(evaluation: Omit<Evaluation, 'id' | 'timestamp' | 'receipt'>): Promise<Evaluation> {
    return this.transact(() => this.appendUnsafe(evaluation));
  }

  async evaluate(
    request: ArtifactRequest,
    assess: (request: ArtifactRequest, history: Evaluation[], policy: Policy) => { score: number; decision: Decision; signals: Signal[]; scoringVersion?: string; policySnapshot?: Policy; scoringBreakdown?: ScoringBreakdown },
    now: Date = new Date(),
  ): Promise<Evaluation> {
    return this.transact(() => {
      const started = performance.now();
      const result = assess(request, structuredClone(this.state.evaluations), this.policy());
      const fingerprint = fingerprintOf(request);
      const { decision, memory } = applyMemory({ request, fingerprint, signals: result.signals, ruleDecision: result.decision, rules: this.rules(), now });
      // ruleDecision, fingerprint and memory sit inside the hashed receipt, so editing which rule applied is detectable.
      return this.appendUnsafe({
        request, ...result, ruleDecision: result.decision, decision, fingerprint, ...(memory ? { memory } : {}),
        durationMs: Math.max(1, Math.round(performance.now() - started)),
      });
    });
  }

  /**
   * Records one human verdict per evaluation and, when asked, remembers it as a rule.
   * Tightening is automatic (an unsafe verdict ends matching trust); loosening never is
   * (a safe verdict cannot lift an existing block, which must be revoked explicitly).
   */
  async review(id: string, input: ReviewInput, now: Date = new Date()): Promise<ReviewResult> {
    return this.transact(async (): Promise<ReviewResult> => {
      const evaluation = this.state.evaluations.find((item) => item.id === id);
      if (!evaluation) return { ok: false, status: 404, error: 'Evaluation not found' };
      if (evaluation.review) return { ok: false, status: 409, error: 'This evaluation already has a human verdict' };
      const timestamp = now.toISOString();
      const rules = this.rules();
      const active = (rule: MemoryRule) => ruleStatus(rule, now) === 'active';
      const blockKey = blockKeyOf(evaluation.request.type, evaluation.request.name);

      if (input.remember) {
        if (!evaluation.fingerprint) return { ok: false, status: 409, error: 'This evaluation was recorded before decision memory existed. Submit it again to remember a verdict.' };
        if (input.decision === 'allow') {
          const high = highSeveritySignals(evaluation);
          if (high.length) return { ok: false, status: 409, error: `Cannot trust an artifact with a high-severity signal (${high.map((signal) => signal.label).join(', ')}). You can still label it safe without remembering it.` };
          if (rules.some((rule) => rule.effect === 'block' && active(rule) && rule.matchKey === blockKey)) {
            return { ok: false, status: 409, error: 'An active block rule covers this artifact. Revoke the block first; a safe verdict never lifts a block on its own.' };
          }
        }
      }

      const revoked: MemoryRule[] = [];
      const revoke = (rule: MemoryRule, cause: RuleRevocationCause, note: string) => {
        rule.revoked = { at: timestamp, note, cause, evaluationId: evaluation.id };
        revoked.push(rule);
        this.state.audit.push({ id: randomUUID(), timestamp, type: 'rule-revoked', evaluationId: evaluation.id, detail: { ruleId: rule.id, cause, note } });
      };

      if (input.decision === 'deny') {
        // Any trust on this exact version, including the one that allowed this request, ends now.
        for (const rule of rules) {
          if (rule.effect === 'trust' && active(rule) && (rule.matchKey === evaluation.fingerprint || rule.id === evaluation.memory?.applied?.ruleId)) {
            revoke(rule, 'reported-unsafe', `Reported unsafe: ${input.note}`);
          }
        }
      }

      let created: MemoryRule | undefined;
      if (input.remember) {
        const base = { id: randomUUID(), type: evaluation.request.type, name: evaluation.request.name, source: evaluation.request.source, createdAt: timestamp, evaluationId: evaluation.id, reason: input.reason, note: input.note, reviewer: input.reviewer };
        if (input.decision === 'allow') {
          for (const rule of rules) if (rule.effect === 'trust' && active(rule) && rule.matchKey === evaluation.fingerprint) revoke(rule, 'superseded', 'Replaced by a newer trust decision for the same version');
          created = {
            ...base, effect: 'trust', matchKey: evaluation.fingerprint!, identityKey: trustIdentityOf(evaluation.request),
            coveredSignals: evaluation.signals.map((signal) => signal.id),
            expiresAt: new Date(now.getTime() + (input.expiresInDays ?? 30) * DAY_MS).toISOString(),
          };
        } else {
          for (const rule of rules) {
            if (!active(rule)) continue;
            if (rule.effect === 'block' && rule.matchKey === blockKey) revoke(rule, 'superseded', 'Replaced by a newer block decision');
            if (rule.effect === 'trust' && blockKeyOf(rule.type, rule.name) === blockKey) revoke(rule, 'replaced-by-block', 'A block now covers this artifact name');
          }
          created = { ...base, effect: 'block', matchKey: blockKey };
        }
        rules.push(created);
        this.state.audit.push({ id: randomUUID(), timestamp, type: 'rule-created', evaluationId: evaluation.id, detail: { rule: structuredClone(created) } });
      }

      // The receipt covers the original evaluation only; reviews are append-only audit events.
      const review: HumanReview = { decision: input.decision, note: input.note, timestamp, reason: input.reason, reviewer: input.reviewer, ...(created ? { ruleId: created.id } : {}) };
      evaluation.review = review;
      this.state.audit.push({ id: randomUUID(), timestamp, type: 'review', evaluationId: id, detail: { ...review, finalDecision: evaluation.decision, ruleDecision: evaluation.ruleDecision ?? evaluation.decision, originalReceipt: evaluation.receipt.hash } });
      return { ok: true, evaluation: structuredClone(evaluation), rule: created && structuredClone(created), revoked: structuredClone(revoked) };
    });
  }

  async revokeRule(id: string, note: string, now: Date = new Date()): Promise<MemoryRule | 'not-found' | 'already-revoked'> {
    return this.transact(async () => {
      const rule = this.rules().find((item) => item.id === id);
      if (!rule) return 'not-found' as const;
      if (rule.revoked) return 'already-revoked' as const;
      const timestamp = now.toISOString();
      rule.revoked = { at: timestamp, note, cause: 'manual' };
      this.state.audit.push({ id: randomUUID(), timestamp, type: 'rule-revoked', detail: { ruleId: rule.id, cause: 'manual', note } });
      return structuredClone(rule);
    });
  }

  private async transact<T>(change: () => Promise<T> | T): Promise<T> {
    const run = this.mutation.then(async () => {
      const before = structuredClone(this.state);
      try {
        const result = await change();
        await this.persist();
        return result;
      } catch (error) {
        this.state = before;
        throw error;
      }
    });
    this.mutation = run.then(() => undefined, () => undefined);
    return run;
  }

  private appendUnsafe(evaluation: Omit<Evaluation, 'id' | 'timestamp' | 'receipt'>): Evaluation {
    const id = randomUUID();
    const timestamp = new Date().toISOString();
    const previousHash = this.state.evaluations.at(-1)?.receipt.hash ?? 'GENESIS';
    const unsigned = { ...evaluation, id, timestamp };
    const stored: Evaluation = { ...unsigned, receipt: { previousHash, hash: digest(previousHash, receiptPayload(unsigned)) } };
    this.state.evaluations.push(stored);
    this.state.audit.push({ id: randomUUID(), timestamp, type: 'evaluation', evaluationId: id, detail: { receipt: stored.receipt } });
    return structuredClone(stored);
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(this.state, null, 2), 'utf8');
    await rename(temp, this.file);
  }
}
