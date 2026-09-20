import {
  Box,
  Check,
  FileCode2,
  Globe2,
  Network,
  Pause,
  X,
} from "lucide-react";
import type {
  ArtifactType,
  Decision,
  Evaluation,
  Policy,
} from "../shared/types";
export const TYPES: ArtifactType[] = ["package", "skill", "mcp", "url"];
export const typeLabel = {
  package: "Package",
  skill: "Skill",
  mcp: "MCP server",
  url: "Remote URL",
};
export const typeIcon = {
  package: Box,
  skill: FileCode2,
  mcp: Network,
  url: Globe2,
};
export const decisionLabel = {
  allow: "Allowed",
  review: "Needs review",
  deny: "Denied",
};
export const decisionIcon = { allow: Check, review: Pause, deny: X };
export const INITIAL_POLICY: Policy = {
  reviewThreshold: 35,
  denyThreshold: 70,
  correlationEnabled: true,
};
export const resolved = (e: Evaluation) => e.review?.decision ?? e.decision;
export const latest = (list: Evaluation[]) =>
  [...list].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
export const time = (stamp: string) =>
  new Date(stamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
export const shortSession = (id: string) =>
  id.startsWith("scenario-")
    ? `${id.slice(9, -37)} / ${id.slice(-6)}`
    : id.startsWith("seed-")
      ? `fixture / ${id.slice(-6)}`
      : id;
export const correlation = (e: Evaluation) =>
  e.signals
    .filter((s) => s.id.includes("correlation"))
    .reduce((sum, s) => sum + s.score * s.weight, 0);
export function Badge({ decision }: { decision: Decision }) {
  const Icon = decisionIcon[decision];
  return (
    <span className={`badge ${decision}`}>
      <Icon size={12} strokeWidth={2.3} />
      {decisionLabel[decision]}
    </span>
  );
}
export function ArtifactIcon({ type }: { type: ArtifactType }) {
  const Icon = typeIcon[type];
  return (
    <span className={`artifact-icon ${type}`}>
      <Icon size={17} strokeWidth={1.6} />
    </span>
  );
}
export function Boundary({
  policy,
  score,
}: {
  policy: Policy;
  score?: number;
}) {
  return (
    <div className="boundary">
      <div className="boundary-track">
        <span
          className="zone-allow"
          style={{ width: `${policy.reviewThreshold}%` }}
        />
        <span
          className="zone-review"
          style={{ width: `${policy.denyThreshold - policy.reviewThreshold}%` }}
        />
        <span
          className="zone-deny"
          style={{ width: `${100 - policy.denyThreshold}%` }}
        />
        {score !== undefined && <i style={{ left: `${score}%` }} />}
      </div>
      <div className="boundary-labels">
        <span>0</span>
        <span style={{ left: `${policy.reviewThreshold}%` }}>
          {policy.reviewThreshold}
        </span>
        <span style={{ left: `${policy.denyThreshold}%` }}>
          {policy.denyThreshold}
        </span>
        <span>100</span>
      </div>
    </div>
  );
}
