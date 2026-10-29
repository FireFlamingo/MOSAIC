import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { AppState, ArtifactRequest, Decision, Evaluation, FeedbackReason, HumanReview, MemoryRule, Policy, RuleRevocationCause, Scenario, Signal, ScoringBreakdown } from '../shared/types.js';
import { defaultPolicy } from './engine.js';
import { SCORING_VERSION } from '../shared/scoring.js';
import { highSeveritySignals, ruleStatus } from '../shared/feedback.js';
import { applyMemory, blockKeyOf, fingerprintOf, trustIdentityOf } from './memory.js';
import { Database } from './db.js';
import { AUDIT_GENESIS, loadOrCreateSigningKey, sealEvent, type AuditEvent, type AuditExport } from './audit.js';

export const DEFAULT_POLICY: Policy = defaultPolicy;
export type { AuditEvent, AuditExport };

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

/** Shape of the pre-SQLite state.json, imported once on first start. */
interface LegacyState { version: 1; evaluations: Evaluation[]; policy: Policy; audit: AuditEvent[]; scoringVersion?: string; rules?: MemoryRule[] }

type Change =
  | { kind: 'evaluation'; evaluation: Evaluation }
  | { kind: 'review'; evaluation: Evaluation }
  | { kind: 'rule'; rule: MemoryRule }
  | { kind: 'audit'; event: AuditEvent }
  | { kind: 'meta'; key: string; value: string };

const DAY_MS = 86_400_000;
const SESSION_HISTORY = 20;
const receiptPayload = (evaluation: Omit<Evaluation, 'receipt' | 'review'>) => JSON.stringify(evaluation);
const digest = (previousHash: string, payload: string) => createHash('sha256').update(`${previousHash}:${payload}`).digest('hex');

export class StateStore {
  private evaluations: Evaluation[] = [];
  private byId = new Map<string, Evaluation>();
  private bySession = new Map<string, Evaluation[]>();
  private rules: MemoryRule[] = [];
  private audit: AuditEvent[] = [];
  private currentPolicy: Policy = { ...DEFAULT_POLICY };
  private scoringVersion = SCORING_VERSION;
  private pending: Change[] = [];
  private pendingRename?: string;
  private mutation: Promise<void> = Promise.resolve();
  private db!: Database;
  private key!: ReturnType<typeof loadOrCreateSigningKey>;

  constructor(private readonly dataDir: string, private readonly scenarios: Scenario[]) {}

  async init(): Promise<void> {
    this.db = new Database(this.dataDir);
    this.key = loadOrCreateSigningKey(this.dataDir);
    this.load();
    await this.transact(() => {
      const legacy = join(this.dataDir, 'state.json');
      if (!this.evaluations.length && !this.audit.length && existsSync(legacy)) this.importLegacy(legacy);
      const stored = this.db.get('SELECT value FROM meta WHERE key = ?', 'scoringVersion')?.value as string | undefined;
      if (!stored && !this.audit.length) {
        this.setMeta('scoringVersion', SCORING_VERSION);
        this.setMeta('policy', JSON.stringify(this.currentPolicy));
      } else if (this.scoringVersion !== SCORING_VERSION) {
        this.upgradeScoringModel();
      }
    });
    this.finishMigration();
  }

  close() { this.db?.close(); }

  appState(): AppState {
    return { evaluations: structuredClone(this.evaluations), policy: { ...this.currentPolicy }, scenarios: structuredClone(this.scenarios), rules: structuredClone(this.rules) };
  }

  exportAudit(): AuditExport {
    return {
      version: 2, format: 'card-audit', exportedAt: new Date().toISOString(), scoringVersion: this.scoringVersion,
      policy: { ...this.currentPolicy }, publicKey: this.key.publicKeyPem,
      evaluations: structuredClone(this.evaluations), rules: structuredClone(this.rules), audit: structuredClone(this.audit),
    };
  }

  policy(): Policy { return { ...this.currentPolicy }; }
  get(id: string): Evaluation | undefined {
    const value = this.byId.get(id);
    return value && structuredClone(value);
  }

  async setPolicy(policy: Policy): Promise<Policy> {
    return this.transact(() => {
      this.currentPolicy = { ...policy };
      this.setMeta('policy', JSON.stringify(this.currentPolicy));
      this.record({ type: 'policy', timestamp: new Date().toISOString(), detail: { policy: { ...policy } } });
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
      // The engine only reads recent history from the same session, so only that is handed over.
      const history = structuredClone((this.bySession.get(request.sessionId) ?? []).slice(-SESSION_HISTORY));
      const result = assess(request, history, this.policy());
      const fingerprint = fingerprintOf(request);
      const { decision, memory } = applyMemory({ request, fingerprint, signals: result.signals, ruleDecision: result.decision, rules: this.rules, now });
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
    return this.transact((): ReviewResult => {
      const evaluation = this.byId.get(id);
      if (!evaluation) return { ok: false, status: 404, error: 'Evaluation not found' };
      if (evaluation.review) return { ok: false, status: 409, error: 'This evaluation already has a human verdict' };
      const timestamp = now.toISOString();
      const active = (rule: MemoryRule) => ruleStatus(rule, now) === 'active';
      const blockKey = blockKeyOf(evaluation.request.type, evaluation.request.name);

      if (input.remember) {
        if (!evaluation.fingerprint) return { ok: false, status: 409, error: 'This evaluation was recorded before decision memory existed. Submit it again to remember a verdict.' };
        if (input.decision === 'allow') {
          const high = highSeveritySignals(evaluation);
          if (high.length) return { ok: false, status: 409, error: `Cannot trust an artifact with a high-severity signal (${high.map((signal) => signal.label).join(', ')}). You can still label it safe without remembering it.` };
          if (this.rules.some((rule) => rule.effect === 'block' && active(rule) && rule.matchKey === blockKey)) {
            return { ok: false, status: 409, error: 'An active block rule covers this artifact. Revoke the block first; a safe verdict never lifts a block on its own.' };
          }
        }
      }

      const revoked: MemoryRule[] = [];
      const revoke = (rule: MemoryRule, cause: RuleRevocationCause, note: string) => {
        rule.revoked = { at: timestamp, note, cause, evaluationId: evaluation.id };
        revoked.push(rule);
        this.pending.push({ kind: 'rule', rule });
        this.record({ type: 'rule-revoked', timestamp, evaluationId: evaluation.id, detail: { ruleId: rule.id, cause, note } });
      };

      if (input.decision === 'deny') {
        // Any trust on this exact version, including the one that allowed this request, ends now.
        for (const rule of this.rules) {
          if (rule.effect === 'trust' && active(rule) && (rule.matchKey === evaluation.fingerprint || rule.id === evaluation.memory?.applied?.ruleId)) {
            revoke(rule, 'reported-unsafe', `Reported unsafe: ${input.note}`);
          }
        }
      }

      let created: MemoryRule | undefined;
      if (input.remember) {
        const base = { id: randomUUID(), type: evaluation.request.type, name: evaluation.request.name, source: evaluation.request.source, createdAt: timestamp, evaluationId: evaluation.id, reason: input.reason, note: input.note, reviewer: input.reviewer };
        if (input.decision === 'allow') {
          for (const rule of this.rules) if (rule.effect === 'trust' && active(rule) && rule.matchKey === evaluation.fingerprint) revoke(rule, 'superseded', 'Replaced by a newer trust decision for the same version');
          created = {
            ...base, effect: 'trust', matchKey: evaluation.fingerprint!, identityKey: trustIdentityOf(evaluation.request),
            coveredSignals: evaluation.signals.map((signal) => signal.id),
            expiresAt: new Date(now.getTime() + (input.expiresInDays ?? 30) * DAY_MS).toISOString(),
          };
        } else {
          for (const rule of this.rules) {
            if (!active(rule)) continue;
            if (rule.effect === 'block' && rule.matchKey === blockKey) revoke(rule, 'superseded', 'Replaced by a newer block decision');
            if (rule.effect === 'trust' && blockKeyOf(rule.type, rule.name) === blockKey) revoke(rule, 'replaced-by-block', 'A block now covers this artifact name');
          }
          created = { ...base, effect: 'block', matchKey: blockKey };
        }
        this.rules.push(created);
        this.pending.push({ kind: 'rule', rule: created });
        this.record({ type: 'rule-created', timestamp, evaluationId: evaluation.id, detail: { rule: structuredClone(created) } });
      }

      // The evaluation receipt covers the original evaluation; the verdict is its own signed audit event.
      const review: HumanReview = { decision: input.decision, note: input.note, timestamp, reason: input.reason, reviewer: input.reviewer, ...(created ? { ruleId: created.id } : {}) };
      evaluation.review = review;
      this.pending.push({ kind: 'review', evaluation });
      this.record({ type: 'review', timestamp, evaluationId: id, detail: { ...review, finalDecision: evaluation.decision, ruleDecision: evaluation.ruleDecision ?? evaluation.decision, originalReceipt: evaluation.receipt.hash } });
      return { ok: true, evaluation: structuredClone(evaluation), rule: created && structuredClone(created), revoked: structuredClone(revoked) };
    });
  }

  async revokeRule(id: string, note: string, now: Date = new Date()): Promise<MemoryRule | 'not-found' | 'already-revoked'> {
    return this.transact(() => {
      const rule = this.rules.find((item) => item.id === id);
      if (!rule) return 'not-found' as const;
      if (rule.revoked) return 'already-revoked' as const;
      const timestamp = now.toISOString();
      rule.revoked = { at: timestamp, note, cause: 'manual' };
      this.pending.push({ kind: 'rule', rule });
      this.record({ type: 'rule-revoked', timestamp, detail: { ruleId: rule.id, cause: 'manual', note } });
      return structuredClone(rule);
    });
  }

  /** Serializes changes; memory is updated first, then written in one SQLite transaction, and undone if the write fails. */
  private async transact<T>(change: () => Promise<T> | T): Promise<T> {
    const run = this.mutation.then(async () => {
      const mark = { evaluations: this.evaluations.length, audit: this.audit.length, rules: structuredClone(this.rules), policy: { ...this.currentPolicy }, scoringVersion: this.scoringVersion };
      this.pending = [];
      try {
        const result = await change();
        const changes = this.pending;
        this.db.transaction(() => { for (const item of changes) this.write(item); });
        return result;
      } catch (error) {
        for (const item of this.pending) if (item.kind === 'review') delete item.evaluation.review;
        for (const evaluation of this.evaluations.splice(mark.evaluations)) {
          this.byId.delete(evaluation.id);
          this.bySession.get(evaluation.request.sessionId)?.pop();
        }
        this.audit.length = mark.audit;
        this.rules = mark.rules;
        this.currentPolicy = mark.policy;
        this.scoringVersion = mark.scoringVersion;
        throw error;
      } finally {
        this.pending = [];
      }
    });
    this.mutation = run.then(() => undefined, () => undefined);
    return run;
  }

  private write(item: Change) {
    if (item.kind === 'evaluation') {
      const { review, ...body } = item.evaluation;
      this.db.run('INSERT INTO evaluations (id, session_id, body, review) VALUES (?, ?, ?, ?)', body.id, body.request.sessionId, JSON.stringify(body), review ? JSON.stringify(review) : null);
    } else if (item.kind === 'review') {
      this.db.run('UPDATE evaluations SET review = ? WHERE id = ?', JSON.stringify(item.evaluation.review), item.evaluation.id);
    } else if (item.kind === 'rule') {
      this.db.run('INSERT OR REPLACE INTO rules (id, body) VALUES (?, ?)', item.rule.id, JSON.stringify(item.rule));
    } else if (item.kind === 'audit') {
      this.db.run('INSERT INTO audit_events (id, body) VALUES (?, ?)', item.event.id, JSON.stringify(item.event));
    } else {
      this.db.run('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', item.key, item.value);
    }
  }

  private setMeta(key: string, value: string) { this.pending.push({ kind: 'meta', key, value }); }

  /** Appends a hash-chained, signed audit event. */
  private record(event: Omit<AuditEvent, 'id'>) {
    const sealed = sealEvent({ id: randomUUID(), ...event }, this.audit.at(-1)?.hash ?? AUDIT_GENESIS, this.key.privateKey);
    this.audit.push(sealed);
    this.pending.push({ kind: 'audit', event: sealed });
  }

  private index(evaluation: Evaluation) {
    this.evaluations.push(evaluation);
    this.byId.set(evaluation.id, evaluation);
    const session = this.bySession.get(evaluation.request.sessionId);
    if (session) session.push(evaluation);
    else this.bySession.set(evaluation.request.sessionId, [evaluation]);
  }

  private appendUnsafe(evaluation: Omit<Evaluation, 'id' | 'timestamp' | 'receipt'>): Evaluation {
    const id = randomUUID();
    const timestamp = new Date().toISOString();
    const previousHash = this.evaluations.at(-1)?.receipt.hash ?? 'GENESIS';
    const unsigned = { ...evaluation, id, timestamp };
    const stored: Evaluation = { ...unsigned, receipt: { previousHash, hash: digest(previousHash, receiptPayload(unsigned)) } };
    this.index(stored);
    this.pending.push({ kind: 'evaluation', evaluation: stored });
    this.record({ type: 'evaluation', timestamp, evaluationId: id, detail: { receipt: stored.receipt } });
    return structuredClone(stored);
  }

  private load() {
    for (const row of this.db.all('SELECT body, review FROM evaluations ORDER BY seq')) {
      const evaluation = JSON.parse(row.body as string) as Evaluation;
      if (row.review) evaluation.review = JSON.parse(row.review as string);
      this.index(evaluation);
    }
    this.rules = this.db.all('SELECT body FROM rules').map((row) => JSON.parse(row.body as string) as MemoryRule).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    this.audit = this.db.all('SELECT body FROM audit_events ORDER BY seq').map((row) => JSON.parse(row.body as string) as AuditEvent);
    const meta = (key: string) => this.db.get('SELECT value FROM meta WHERE key = ?', key)?.value as string | undefined;
    const policy = meta('policy');
    if (policy) this.currentPolicy = JSON.parse(policy);
    this.scoringVersion = meta('scoringVersion') ?? (this.audit.length ? 'heuristic-v1' : SCORING_VERSION);
  }

  /** One-time import of the JSON store. Original evaluation receipts are kept byte-for-byte; legacy events are re-chained and signed. */
  private importLegacy(file: string) {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as LegacyState;
    if (!raw || raw.version !== 1 || !Array.isArray(raw.evaluations) || !raw.policy || !Array.isArray(raw.audit)) throw new Error('Invalid persisted CARD state');
    for (const evaluation of raw.evaluations) {
      this.index(evaluation);
      this.pending.push({ kind: 'evaluation', evaluation });
    }
    for (const rule of raw.rules ?? []) {
      this.rules.push(rule);
      this.pending.push({ kind: 'rule', rule });
    }
    for (const event of raw.audit) {
      const { id, timestamp, type, evaluationId, detail } = event;
      const sealed = sealEvent({ id, timestamp, type, evaluationId, detail }, this.audit.at(-1)?.hash ?? AUDIT_GENESIS, this.key.privateKey);
      this.audit.push(sealed);
      this.pending.push({ kind: 'audit', event: sealed });
    }
    this.currentPolicy = { ...raw.policy };
    this.scoringVersion = raw.scoringVersion ?? 'heuristic-v1';
    this.setMeta('policy', JSON.stringify(this.currentPolicy));
    this.setMeta('scoringVersion', this.scoringVersion);
    this.record({ type: 'storage-migrated', timestamp: new Date().toISOString(), detail: { from: 'state.json', evaluations: raw.evaluations.length, events: raw.audit.length } });
    this.pendingRename = file;
  }

  /** Upgrade old factory-default thresholds when the scoring model changes; custom thresholds and receipts stay intact. */
  private upgradeScoringModel() {
    const previousPolicy = { ...this.currentPolicy };
    const factory = [[35, 70], [50, 75]];
    if (factory.some(([review, deny]) => previousPolicy.reviewThreshold === review && previousPolicy.denyThreshold === deny)) {
      this.currentPolicy = { ...DEFAULT_POLICY, correlationEnabled: previousPolicy.correlationEnabled };
    }
    this.record({ type: 'scoring-model', timestamp: new Date().toISOString(), detail: { previousVersion: this.scoringVersion, scoringVersion: SCORING_VERSION, previousPolicy, policy: { ...this.currentPolicy } } });
    this.scoringVersion = SCORING_VERSION;
    this.setMeta('policy', JSON.stringify(this.currentPolicy));
    this.setMeta('scoringVersion', SCORING_VERSION);
  }

  /** Runs only after the import committed, so a failed import never loses the original file. */
  private finishMigration() {
    if (this.pendingRename && existsSync(this.pendingRename)) renameSync(this.pendingRename, `${this.pendingRename}.migrated`);
    this.pendingRename = undefined;
  }
}
