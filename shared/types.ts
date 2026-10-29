export type ArtifactType = 'package' | 'skill' | 'mcp' | 'url';
export type Decision = 'allow' | 'review' | 'deny';
export interface ArtifactRequest {
  type: ArtifactType;
  name: string;
  sessionId: string;
  source?: string;
  content?: string;
  /** Package registry, when known. Without it, package names are compared against every registry's reference list. */
  ecosystem?: 'npm' | 'pypi';
  metadata?: { exists?: boolean; ageDays?: number; downloads?: number; signed?: boolean; permissions?: string[]; resolvedAddresses?: string[] };
}
/** Where one fact came from: looked up by CARD, typed by the caller, or not established. */
export interface EvidenceField<T = unknown> { value?: T; from: 'registry' | 'caller' | 'unverified'; detail?: string }
export interface EvidenceReport {
  mode: 'live' | 'caller';
  registry?: 'npm' | 'pypi';
  lookedUp: string;
  version?: string;
  fetchedAt: string;
  sources: string[];
  fields: Partial<Record<'exists' | 'signed' | 'ageDays' | 'downloads', EvidenceField>>;
  installScripts?: string;
  resolvedAddresses?: string[];
  callerClaims?: Record<string, unknown>;
  note?: string;
}
export interface Signal {
  id: string; label: string; score: number; weight: number; reason: string;
  severity?: import('./scoring').Severity;
  group?: import('./scoring').EvidenceGroup;
  sources?: readonly import('./scoring').ScoringSource[];
  contribution?: number;
  rawSeverity?: number;
}
export interface ScoringBreakdown {
  normalizationTotal: number;
  rawTotal: number;
  groups: Array<{ group: import('./scoring').EvidenceGroup; capacity: number; rawSeverity: number; weight: number; contribution: number }>;
}
export interface Policy { reviewThreshold: number; denyThreshold: number; correlationEnabled: boolean }
export interface DecisionFloor { decision: 'review' | 'deny'; signalId: string; reason: string }
export type FeedbackReason =
  | 'expected-tool' | 'wrong-signal' | 'other-safe'
  | 'malicious' | 'policy-violation' | 'insufficient-evidence' | 'other-unsafe';
/** A human verdict. On a held request it resolves the hold; on an allowed or denied request it is a correctness label. */
export interface HumanReview {
  decision: 'allow' | 'deny'; note: string; timestamp: string;
  reason?: FeedbackReason; reviewer?: string; ruleId?: string;
}
export type MemoryEffect = 'trust' | 'block';
export type RuleRevocationCause = 'manual' | 'reported-unsafe' | 'superseded' | 'replaced-by-block';
export interface MemoryRule {
  id: string; effect: MemoryEffect; type: ArtifactType; name: string; source?: string;
  /** Trust: exact fingerprint. Block: loose name key covering every version and spelling variant. */
  matchKey: string;
  /** Trust only: type + exact name + source, used to detect a changed version of a trusted artifact. */
  identityKey?: string;
  /** Trust only: signal ids the reviewer saw. Any other signal suspends the trust. */
  coveredSignals?: string[];
  createdAt: string; expiresAt?: string;
  evaluationId: string; reason: FeedbackReason; note: string; reviewer: string;
  revoked?: { at: string; note: string; cause: RuleRevocationCause; evaluationId?: string };
}
export interface MemoryOutcome {
  applied?: { ruleId: string; effect: MemoryEffect; createdAt: string; reviewer: string; note: string; expiresAt?: string };
  changedSinceTrust?: { ruleId: string; trustedAt: string; reviewer: string };
  trustSuspended?: { ruleId: string; newSignals: string[] };
  expiredTrust?: { ruleId: string; expiredAt: string };
}
export interface Evaluation {
  id: string; timestamp: string; request: ArtifactRequest; score: number;
  /** Final decision returned to the caller, after decision memory. */
  decision: Decision; signals: Signal[]; durationMs: number;
  review?: HumanReview;
  receipt: { hash: string; previousHash: string };
  scoringVersion?: string;
  policySnapshot?: Policy;
  scoringBreakdown?: ScoringBreakdown;
  /** Decision from the score and thresholds alone. Absent on records made before decision memory existed. */
  ruleDecision?: Decision;
  /** How the facts behind the score were obtained. Absent on records made before evidence lookups existed. */
  evidence?: EvidenceReport;
  /** Set when a single critical finding raised the threshold decision. */
  decisionFloor?: DecisionFloor;
  fingerprint?: string;
  memory?: MemoryOutcome;
}
export interface Scenario { id: string; title: string; description: string; requests: ArtifactRequest[] }
export interface AppState { evaluations: Evaluation[]; policy: Policy; scenarios: Scenario[]; rules: MemoryRule[] }
