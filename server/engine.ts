import type { ArtifactRequest, Decision, Evaluation, Policy, Signal } from '../shared/types';

/** Conservative defaults for the local, deterministic MVP evaluator. */
export const defaultPolicy: Policy = {
  reviewThreshold: 35,
  denyThreshold: 70,
  correlationEnabled: true,
};

const knownPackages = [
  'react', 'react-dom', 'typescript', 'vite', 'express', 'lodash', 'axios',
  'zod', 'next', 'tailwindcss', 'eslint', 'prettier', 'node-fetch', 'dotenv',
];

const dangerousPermissions = new Set([
  'filesystem:write', 'filesystem:read', 'network', 'network:all', 'network:egress', 'process:spawn',
  'shell', 'secrets:read', 'clipboard:read', 'browser:control',
]);

function signal(id: string, label: string, points: number, reason: string): Signal {
  return { id, label, score: points, weight: 1, reason };
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
): { score: number; decision: Decision; signals: Signal[] } {
  const signals: Signal[] = [];
  const metadata = request.metadata;

  if (metadata?.exists === false) {
    signals.push(signal('metadata-missing', 'Artifact not found', 48, 'The supplied metadata explicitly reports that this artifact does not exist.'));
  } else if (metadata?.exists !== true) {
    signals.push(signal('metadata-unverified', 'Existence unverified', 8, 'No verified existence result was supplied; this is not treated as confirmation.'));
  }

  const similar = request.type === 'package' ? similarKnownPackage(packageBaseName(request.name)) : undefined;
  if (similar) {
    signals.push(signal('name-lookalike', 'Known-package lookalike', 26, `“${request.name}” is unusually similar to the known package “${similar}”.`));
  }

  if (metadata) {
    if (metadata.signed === false) signals.push(signal('unsigned', 'Unsigned artifact', 10, 'Metadata explicitly reports no signature.'));
    if (typeof metadata.ageDays === 'number' && metadata.ageDays < 7) signals.push(signal('new-artifact', 'Very new artifact', 8, `Artifact age is ${metadata.ageDays} day(s).`));
    if (typeof metadata.downloads === 'number' && metadata.downloads < 50) signals.push(signal('low-adoption', 'Low observed adoption', 7, `Only ${metadata.downloads} downloads were reported.`));
    const permissions = metadata.permissions ?? [];
    const elevated = permissions.filter((permission) => dangerousPermissions.has(permission.toLowerCase()));
    if (elevated.length) signals.push(signal('elevated-permissions', 'Elevated permissions', Math.min(24, 8 * elevated.length), `Requested permissions: ${elevated.join(', ')}.`));
  }

  const content = request.content ?? '';
  const indicators: Array<[string, string, RegExp, number, string]> = [
    ['obfuscated-content', 'Obfuscated content', /(?:fromcharcode|\\\\x[0-9a-f]{2}|base64\s*,\s*['\"]|atob\s*\()/i, 18, 'Static content contains an obfuscation indicator.'],
    ['credential-access', 'Credential-access indicator', /(?:process\.env|\.npmrc|aws_access_key|private[_ -]?key|authorization:\s*bearer)/i, 16, 'Static content references a credential-bearing location or token.'],
    ['remote-payload', 'Remote payload indicator', /(?:curl\s+[^\n]+\|\s*(?:sh|bash)|wget\s+[^\n]+\|\s*(?:sh|bash)|invoke-webrequest.+\|)/i, 24, 'Static content includes a shell-piped remote download pattern.'],
  ];
  for (const [id, label, pattern, points, reason] of indicators) {
    if (pattern.test(content)) signals.push(signal(id, label, points, reason));
  }

  if ((request.type === 'skill' || request.type === 'mcp') && /(?:ignore (?:all )?(?:previous|prior) instructions|disable (?:the )?security|bypass (?:the )?security)/i.test(content)) {
    signals.push(signal('instruction-override', 'Instruction override', 22, 'Static instructions attempt to override prior guidance or disable security controls.'));
  }

  if (request.type === 'url') {
    const candidate = request.source ?? request.name;
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol !== 'https:') signals.push(signal('url-not-https', 'Non-HTTPS URL', 12, `URL uses ${parsed.protocol || 'an unknown'} protocol.`));
      const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
      if (host === 'localhost' || host.endsWith('.localhost') || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host) || /^10(?:\.\d{1,3}){3}$/.test(host) || /^192\.168(?:\.\d{1,3}){2}$/.test(host) || /^169\.254(?:\.\d{1,3}){2}$/.test(host) || /^172\.(?:1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2}$/.test(host) || /^f[cd][0-9a-f:]*$/i.test(host) || /^fe[89ab][0-9a-f:]*$/i.test(host)) {
        signals.push(signal('url-local-host', 'Local or private host', 20, 'URL targets a local or private network host.'));
      }
    } catch {
      signals.push(signal('url-invalid', 'Invalid URL', 20, 'URL could not be parsed locally.'));
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
    if (recent.length) signals.push(signal('session-correlation', 'Session correlation', Math.min(18, recent.length * 6), `${recent.length} prior non-allowed artifact(s) of a different type occurred in this session.`));
    const nameMatch = recent.some((evaluation) => normalizeName(evaluation.request.name) === normalizeName(request.name));
    if (nameMatch) signals.push(signal('name-correlation', 'Cross-artifact name reuse', 12, 'A prior non-allowed artifact of another type used the same normalized name.'));
  }

  const score = Math.min(100, signals.reduce((total, item) => total + item.score * item.weight, 0));
  return { score, decision: deriveDecision(score, policy), signals };
}
