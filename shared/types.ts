export type ArtifactType = 'package' | 'skill' | 'mcp' | 'url';
export type Decision = 'allow' | 'review' | 'deny';
export interface ArtifactRequest {
  type: ArtifactType;
  name: string;
  sessionId: string;
  source?: string;
  content?: string;
  metadata?: { exists?: boolean; ageDays?: number; downloads?: number; signed?: boolean; permissions?: string[] };
}
export interface Signal { id: string; label: string; score: number; weight: number; reason: string }
export interface Policy { reviewThreshold: number; denyThreshold: number; correlationEnabled: boolean }
export interface Evaluation {
  id: string; timestamp: string; request: ArtifactRequest; score: number;
  decision: Decision; signals: Signal[]; durationMs: number;
  review?: { decision: 'allow' | 'deny'; note: string; timestamp: string };
  receipt: { hash: string; previousHash: string };
}
export interface Scenario { id: string; title: string; description: string; requests: ArtifactRequest[] }
export interface AppState { evaluations: Evaluation[]; policy: Policy; scenarios: Scenario[] }
