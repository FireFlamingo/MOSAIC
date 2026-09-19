import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AppState, ArtifactRequest, Decision, Evaluation, Policy, Scenario, Signal } from '../shared/types.js';
import { defaultPolicy } from './engine.js';

export const DEFAULT_POLICY: Policy = defaultPolicy;

interface AuditEvent {
  id: string;
  timestamp: string;
  type: 'evaluation' | 'review' | 'policy';
  evaluationId?: string;
  detail: Record<string, unknown>;
}

interface PersistedState {
  version: 1;
  evaluations: Evaluation[];
  policy: Policy;
  audit: AuditEvent[];
}

const canonical = (value: unknown) => JSON.stringify(value);
const receiptPayload = (evaluation: Omit<Evaluation, 'receipt' | 'review'>) => canonical(evaluation);
const digest = (previousHash: string, payload: string) => createHash('sha256').update(`${previousHash}:${payload}`).digest('hex');

export class StateStore {
  private state: PersistedState = { version: 1, evaluations: [], policy: { ...DEFAULT_POLICY }, audit: [] };
  private readonly file: string;
  private mutation: Promise<void> = Promise.resolve();

  constructor(private readonly dataDir: string, private readonly scenarios: Scenario[]) {
    this.file = join(dataDir, 'state.json');
  }

  async init(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8')) as PersistedState;
      if (!raw || raw.version !== 1 || !Array.isArray(raw.evaluations) || !raw.policy || !Array.isArray(raw.audit)) throw new Error('Invalid persisted MOSAIC state');
      this.state = raw;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await this.persist();
    }
  }

  appState(): AppState {
    return { evaluations: structuredClone(this.state.evaluations), policy: { ...this.state.policy }, scenarios: structuredClone(this.scenarios) };
  }

  exportAudit(): PersistedState { return structuredClone(this.state); }
  policy(): Policy { return { ...this.state.policy }; }
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
    assess: (request: ArtifactRequest, history: Evaluation[], policy: Policy) => { score: number; decision: Decision; signals: Signal[] },
  ): Promise<Evaluation> {
    return this.transact(() => {
      const started = performance.now();
      const result = assess(request, structuredClone(this.state.evaluations), this.policy());
      return this.appendUnsafe({ request, ...result, durationMs: Math.max(1, Math.round(performance.now() - started)) });
    });
  }

  async review(id: string, review: NonNullable<Evaluation['review']>): Promise<Evaluation | undefined> {
    return this.transact(async () => {
      const evaluation = this.state.evaluations.find((item) => item.id === id);
      if (!evaluation || evaluation.review || evaluation.decision !== 'review') return undefined;
      // The receipt covers the original evaluation only; reviews are append-only audit events.
      evaluation.review = { ...review };
      this.state.audit.push({ id: randomUUID(), timestamp: review.timestamp, type: 'review', evaluationId: id, detail: { ...review, originalReceipt: evaluation.receipt.hash } });
      return structuredClone(evaluation);
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
