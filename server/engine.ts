import type { ArtifactRequest, Decision, Evaluation, Policy, Signal } from '../shared/types';
import { EVIDENCE_GROUPS, RECOMMENDED_POLICY, SCORING_VERSION, SEVERITY_WEIGHTS, SIGNAL_RULES, type EvidenceGroup, type SignalId } from '../shared/scoring';

/** Conservative defaults for the local, deterministic MVP evaluator. */
export const defaultPolicy: Policy = { ...RECOMMENDED_POLICY };

const knownPackages = [
  'react', 'react-dom', 'typescript', 'vite', 'express', 'lodash', 'axios',
  'zod', 'next', 'tailwindcss', 'eslint', 'prettier', 'node-fetch', 'dotenv',
];

const dangerousPermissions = new Set([
  'filesystem:write', 'filesystem:read', 'network', 'network:all', 'network:egress', 'process:spawn',
  'shell', 'secrets:read', 'clipboard:read', 'browser:control',
]);

function signal(id: SignalId, reason: string): Signal {
  const rule = SIGNAL_RULES[id];
  return { id, label: rule.label, score: SEVERITY_WEIGHTS[rule.severity] * 10, weight: 1, reason, severity: rule.severity, group: rule.group, sources: rule.sources };
}

/** Keep only the strongest contribution in each evidence family, retaining every explanation. */
function groupSignals(signals: Signal[]): Signal[] {
  const winners = new Map<EvidenceGroup, Signal>();
  for (const item of signals) {
    const winner = winners.get(item.group!);
    if (!winner || item.score > winner.score) winners.set(item.group!, item);
  }
  return signals.map((item) => {
    const winner = winners.get(item.group!)!;
    return winner === item ? item : { ...item, weight: 0, reason: `${item.reason} Included in the ${EVIDENCE_GROUPS[item.group!]} group; ${winner.label} supplies that group's strongest contribution. This signal adds no extra points.` };
  });
}

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function packageBaseName(name: string): string {
  return name.replace(/@v?\d+(?:\.\d+){0,2}(?:[-+][a-z0-9.-]+)?$/i, '');
}

function levenshtein(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const saved = previous[j];
      previous[j] = Math.min(previous[j] + 1, previous[j - 1] + 1, diagonal + (left[i - 1] === right[j - 1] ? 0 : 1));
      diagonal = saved;
    }
  }
  return previous[right.length];
}

function similarKnownPackage(name: string): string | undefined {
  const normal = normalizeName(name);
  return knownPackages.find((candidate) => {
    const known = normalizeName(candidate);
    const distance = levenshtein(normal, known);
    return normal !== known && normal.length >= 4 && distance <= Math.max(1, Math.floor(known.length * 0.2));
  });
}

function deriveDecision(score: number, policy: Policy): Decision {
  if (score >= policy.denyThreshold) return 'deny';
  if (score >= policy.reviewThreshold) return 'review';
  return 'allow';
}

/**
 * Scores only the supplied text and local evaluation history. It never resolves,
 * installs, executes, or fetches an artifact.
 */
export function evaluateRisk(
  request: ArtifactRequest,
  history: Evaluation[],
  policy: Policy,
): { score: number; decision: Decision; signals: Signal[]; scoringVersion: string; policySnapshot: Policy } {
  const signals: Signal[] = [];
  const metadata = request.metadata;

  if (metadata?.exists === false) {
    signals.push(signal('metadata-missing', 'The supplied metadata explicitly reports that this artifact does not exist. This is a high-priority policy concern, not independently verified evidence of an attack.'));
  } else if (metadata?.exists !== true) {
    signals.push(signal('metadata-unverified', 'No existence result was supplied. Unknown evidence is treated as a low concern, not proof that the artifact is missing.'));
  }

  const similar = request.type === 'package' ? similarKnownPackage(packageBaseName(request.name)) : undefined;
  if (similar) {
    signals.push(signal('name-lookalike', `“${request.name}” is unusually similar to the known package “${similar}”. Similarity is a review cue, not proof of impersonation.`));
  }

  if (metadata) {
    if (metadata.signed === false) signals.push(signal('unsigned', 'Metadata reports no signature. This weak provenance cue is not a failed signature verification; legitimate artifacts can be unsigned.'));
    // No age/adoption cutoffs: the literature does not establish universal 7-day/50-download thresholds.
    const permissions = metadata.permissions ?? [];
    const elevated = [...new Set(permissions.map((permission) => permission.toLowerCase()))].filter((permission) => dangerousPermissions.has(permission));
    const sensitive = elevated.filter((permission) => ['process:spawn', 'shell', 'secrets:read'].includes(permission));
    if (elevated.length) signals.push(signal(sensitive.length ? 'sensitive-permissions' : 'elevated-permissions', `Requested permissions: ${elevated.join(', ')}. Capabilities indicate potential impact, not malicious intent; repeated permissions do not increase the score.`));
  }

  const content = request.content ?? '';
  const indicators: Array<[SignalId, RegExp, string]> = [
    ['obfuscated-content', /(?:fromcharcode|\\\\x[0-9a-f]{2}|base64\s*,\s*['\"]|atob\s*\()/i, 'Static content contains an encoding or obfuscation marker. Encoding also occurs in benign code.'],
    ['credential-access', /(?:process\.env|\.npmrc|aws_access_key|private[_ -]?key|authorization:\s*bearer)/i, 'Static content references an environment variable or credential-bearing location. The match does not establish secret theft.'],
    ['remote-payload', /(?:curl\s+[^\n]+\|\s*(?:sh|bash)|wget\s+[^\n]+\|\s*(?:sh|bash)|invoke-webrequest.+\|)/i, 'Static content includes a shell-piped remote download pattern. This can execute unreviewed remote code, but the MVP does not run it or establish intent.'],
  ];
  for (const [id, pattern, reason] of indicators) {
    if (pattern.test(content)) signals.push(signal(id, reason));
  }

  if ((request.type === 'skill' || request.type === 'mcp') && /(?:ignore (?:all )?(?:previous|prior) instructions|disable (?:the )?security|bypass (?:the )?security)/i.test(content)) {
    signals.push(signal('instruction-override', 'Static instructions attempt to override prior guidance or disable security controls. A literal text match is not a demonstrated successful prompt injection.'));
  }

  if (request.type === 'url') {
    const candidate = request.source ?? request.name;
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol !== 'https:') signals.push(signal('url-not-https', `URL uses ${parsed.protocol || 'an unknown'} protocol rather than HTTPS. Transport protection is not established by this URL.`));
      const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
      if (host === 'localhost' || host.endsWith('.localhost') || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host) || /^10(?:\.\d{1,3}){3}$/.test(host) || /^192\.168(?:\.\d{1,3}){2}$/.test(host) || /^169\.254(?:\.\d{1,3}){2}$/.test(host) || /^172\.(?:1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2}$/.test(host) || /^f[cd][0-9a-f:]*$/i.test(host) || /^fe[89ab][0-9a-f:]*$/i.test(host)) {
        signals.push(signal('url-local-host', 'URL names a local or private network host. This can cross a network trust boundary; approved internal services can also be legitimate.'));
      }
    } catch {
      signals.push(signal('url-invalid', 'URL could not be parsed locally, so its destination cannot be assessed. Holding it for review is a MOSAIC input-validation policy.'));
    }
  }

  if (policy.correlationEnabled) {
    const recent = history
      .filter((evaluation) => evaluation.request.sessionId === request.sessionId)
      .slice(-20)
      .filter((evaluation) =>
        evaluation.request.type !== request.type
        && evaluation.decision !== 'allow',
      );
    if (recent.length) signals.push(signal('session-correlation', `${recent.length} prior non-allowed artifact(s) of a different type occurred in this session. History is one contextual cue; counts are not multiplied into attack probabilities.`));
    const nameMatch = recent.some((evaluation) => normalizeName(evaluation.request.name) === normalizeName(request.name));
    if (nameMatch) signals.push(signal('name-correlation', 'A prior non-allowed artifact of another type used the same normalized name. The stronger contextual cue replaces the generic history contribution; its severity is a MOSAIC research hypothesis.'));
  }

  const grouped = groupSignals(signals);
  const score = Math.min(100, grouped.reduce((total, item) => total + item.score * item.weight, 0));
  return { score, decision: deriveDecision(score, policy), signals: grouped, scoringVersion: SCORING_VERSION, policySnapshot: { ...policy } };
}
