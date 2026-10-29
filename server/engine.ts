import type { ArtifactRequest, Decision, DecisionFloor, Evaluation, Observation, Policy, Signal, ScoringBreakdown } from '../shared/types';
import { traceChain } from './chain';
import { normalizeName } from '../shared/names';
import { lookalikeDomain, similarMcpServer, similarPopularPackage } from './lookalike';
import { DECISION_FLOORS, EVIDENCE_GROUPS, RECOMMENDED_POLICY, SCORING_VERSION, SEVERITY_WEIGHTS, SIGNAL_RULES, scoringProfile, type EvidenceGroup, type SignalId } from '../shared/scoring';

/** Conservative defaults for the local, deterministic MVP evaluator. */
export const defaultPolicy: Policy = { ...RECOMMENDED_POLICY };

const dangerousPermissions = new Set([
  'filesystem:write', 'filesystem:read', 'network', 'network:all', 'network:egress', 'process:spawn',
  'shell', 'secrets:read', 'clipboard:read', 'browser:control',
]);

function signal(id: SignalId, reason: string): Signal {
  const rule = SIGNAL_RULES[id];
  return { id, label: rule.label, score: SEVERITY_WEIGHTS[rule.severity] * 10, weight: 1, reason, severity: rule.severity, group: rule.group, sources: rule.sources };
}

/** A normalized weighted average. The full applicable capacity is fixed before matching. */
export function scoreSignals(type: ArtifactRequest['type'], signals: Signal[]): { score: number; signals: Signal[]; scoringBreakdown: ScoringBreakdown } {
  const profile = scoringProfile(type);
  const normalizationTotal = profile.reduce((total, item) => total + item.capacity, 0);
  const winners = new Map<EvidenceGroup, Signal>();
  for (const item of signals) {
    if (!item.group || !profile.some((entry) => entry.group === item.group)) throw new Error('Signal group is not applicable to this request');
    const capacity = profile.find((entry) => entry.group === item.group)!.capacity;
    if (item.score < 0 || item.score > capacity) throw new Error('Signal severity exceeds its configured group capacity');
    const winner = winners.get(item.group!);
    if (!winner || item.score > winner.score) winners.set(item.group!, item);
  }
  const rawTotal = [...winners.values()].reduce((total, item) => total + item.score, 0);
  const targetCents = Math.round(rawTotal / normalizationTotal * 10000);
  const groups = profile.map(({ group, capacity }) => {
    const rawSeverity = winners.get(group)?.score ?? 0;
    const exactCents = rawSeverity / normalizationTotal * 10000;
    const cents = Math.floor(exactCents + 1e-9);
    return { group, capacity, rawSeverity, weight: capacity / normalizationTotal, cents, remainder: exactCents - cents };
  });
  // Allocate at most one rounding cent per group so displayed contributions sum exactly.
  const remainderCents = targetCents - groups.reduce((sum, item) => sum + item.cents, 0);
  const roundingOrder = [...groups].sort((a, b) => b.remainder - a.remainder);
  for (let index = 0; index < remainderCents; index += 1) roundingOrder[index].cents += 1;
  const contributions = new Map(groups.map((item) => [item.group, item.cents / 100]));
  const weightedSignals = signals.map((item) => {
    const winner = winners.get(item.group!)!;
    const capacity = profile.find((entry) => entry.group === item.group)!.capacity;
    const normalized = { ...item, rawSeverity: item.score, score: 100 * item.score / capacity };
    return winner === item
      ? { ...normalized, weight: capacity / normalizationTotal, contribution: contributions.get(item.group!)! }
      : { ...normalized, weight: 0, contribution: 0, reason: `${item.reason} Included in the ${EVIDENCE_GROUPS[item.group!]} group; ${winner.label} supplies that group's strongest contribution. This signal adds no extra points.` };
  });
  return {
    score: targetCents / 100,
    signals: weightedSignals,
    scoringBreakdown: { normalizationTotal, rawTotal, groups: groups.map(({ group, capacity, rawSeverity, weight, cents }) => ({ group, capacity, rawSeverity, weight, contribution: cents / 100 })) },
  };
}

function deriveDecision(score: number, policy: Policy): Decision {
  if (score >= policy.denyThreshold) return 'deny';
  if (score >= policy.reviewThreshold) return 'review';
  return 'allow';
}

const rank: Record<Decision, number> = { allow: 0, review: 1, deny: 2 };

const SECRET_LOCATIONS = /(?:process\.env|environment variables|\.npmrc|authtoken|aws_access_key|\.aws[\\/]credentials|\.ssh[\\/]|id_rsa|id_ed25519|private[_ -]?key|api keys?|passwords?|mcp\.json)/i;
const ENCODED_CODE = /(?:atob\s*\(|fromcharcode|base64\s*(?:-d|--decode)|eval\s*\()/i;

/** Names an earlier request can be recognised by: its name, and for URLs the host labels and path segments. */
function correlationNames(request: ArtifactRequest): string[] {
  const names = [normalizeName(request.name)];
  if (request.type === 'url') {
    try {
      const url = new URL(request.source ?? request.name);
      for (const part of [...url.hostname.split('.'), ...url.pathname.split('/')]) names.push(normalizeName(part));
    } catch { /* not a URL */ }
  }
  return names.filter((name) => name.length >= 3);
}

/** Loopback, private, link-local and unique-local addresses, plus localhost names. */
export function isPrivateHost(value: string): boolean {
  const host = value.toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '0.0.0.0'
    || /^127(?:\.\d{1,3}){3}$/.test(host) || /^10(?:\.\d{1,3}){3}$/.test(host) || /^192\.168(?:\.\d{1,3}){2}$/.test(host)
    || /^169\.254(?:\.\d{1,3}){2}$/.test(host) || /^172\.(?:1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2}$/.test(host)
    || /^f[cd][0-9a-f:]*$/i.test(host) || /^fe[89ab][0-9a-f:]*$/i.test(host);
}

/** The strongest floor among the signals that fired, if it is stricter than the threshold decision. */
function decisionFloor(signals: Signal[], thresholdDecision: Decision): DecisionFloor | undefined {
  let strongest: DecisionFloor | undefined;
  for (const item of signals) {
    const floor = DECISION_FLOORS[item.id as SignalId];
    if (floor && (!strongest || rank[floor.decision] > rank[strongest.decision])) strongest = { decision: floor.decision, signalId: item.id, reason: floor.reason };
  }
  return strongest && rank[strongest.decision] > rank[thresholdDecision] ? strongest : undefined;
}

/**
 * Scores only the supplied text and local evaluation history. It never resolves,
 * installs, executes, or fetches an artifact.
 */
export function evaluateRisk(
  request: ArtifactRequest,
  history: Evaluation[],
  policy: Policy,
  observations: Observation[] = [],
): { score: number; decision: Decision; signals: Signal[]; scoringVersion: string; policySnapshot: Policy; scoringBreakdown: ScoringBreakdown; decisionFloor?: DecisionFloor; chain?: Evaluation['chain'] } {
  const signals: Signal[] = [];
  const metadata = request.metadata;

  if (metadata?.exists === false) {
    signals.push(signal('metadata-missing', 'The supplied metadata explicitly reports that this artifact does not exist. This is a high-priority policy concern, not independently verified evidence of an attack.'));
  } else if (metadata?.exists !== true) {
    signals.push(signal('metadata-unverified', 'No existence result was supplied. Unknown evidence is treated as a low concern, not proof that the artifact is missing.'));
  }

  if (request.type === 'package') {
    const similar = similarPopularPackage(request.name, request.ecosystem);
    if (similar) signals.push(signal('name-lookalike', `“${request.name}” imitates the popular package “${similar}”: it differs only by punctuation, an added prefix or suffix, or a small edit. Similarity is a review cue, not proof of impersonation.`));
  } else if (request.type === 'mcp') {
    const similar = similarMcpServer(request.name);
    if (similar) signals.push(signal('name-lookalike', `“${request.name}” is one small edit away from the well-known MCP server “${similar}”. Similarity is a review cue, not proof of impersonation.`));
  }

  if (metadata) {
    if (metadata.takenDown) signals.push(signal('registry-takedown', 'The registry replaced this package with a security holding package, which npm does after removing malware. Whoever asked for it was steered to a known-malicious name.'));
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
    ['credential-access', /(?:process\.env|\.npmrc|aws_access_key|private[_ -]?key|authorization:\s*bearer|\.ssh[\/]|id_rsa|id_ed25519|\.aws[\/]credentials)/i, 'Static content references an environment variable or credential-bearing location. The match does not establish secret theft.'],
    ['remote-payload', /(?:curl\s+[^\n]+\|\s*(?:sh|bash)|wget\s+[^\n]+\|\s*(?:sh|bash)|invoke-webrequest.+\||\b(?:iwr|irm|invoke-restmethod)\b[^\n]*\|\s*(?:iex|invoke-expression)\b)/i, 'Static content includes a shell-piped remote download pattern. This can execute unreviewed remote code, but the MVP does not run it or establish intent.'],
  ];
  for (const [id, pattern, reason] of indicators) {
    if (pattern.test(content)) signals.push(signal(id, reason));
  }

  if ((request.type === 'skill' || request.type === 'mcp') && /(?:ignore (?:all )?(?:previous|prior) instructions|disable (?:the )?security|bypass (?:the )?security|<important>|do not (?:tell|inform|mention|reveal)(?: this)?(?: to)? the user)/i.test(content)) {
    signals.push(signal('instruction-override', 'Static instructions attempt to override prior guidance or disable security controls. A literal text match is not a demonstrated successful prompt injection.'));
  }
  // In instruction files and MCP descriptions the text is a direction to the agent, so pointing it at secrets or
  // at encoded code is far more serious than the same string inside package source.
  if ((request.type === 'skill' || request.type === 'mcp') && (SECRET_LOCATIONS.test(content) || ENCODED_CODE.test(content))) {
    signals.push(signal('instruction-sensitive-action', 'The instructions direct the agent to read credentials or secret files, or to run encoded code. Agents follow such text as instructions.'));
  }

  if (request.type === 'url') {
    const candidate = request.source ?? request.name;
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol !== 'https:') signals.push(signal('url-not-https', `URL uses ${parsed.protocol || 'an unknown'} protocol rather than HTTPS. Transport protection is not established by this URL.`));
      const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
      const privateAddress = (metadata?.resolvedAddresses ?? []).find(isPrivateHost);
      if (isPrivateHost(host)) {
        signals.push(signal('url-local-host', 'URL names a local or private network host. This can cross a network trust boundary; approved internal services can also be legitimate.'));
      } else if (privateAddress) {
        signals.push(signal('url-local-host', `“${host}” is a public-looking name that resolves to the private address ${privateAddress}. This is how server-side request forgery and DNS rebinding reach internal systems.`));
      } else if (!/^[\d.]+$/.test(host) && !host.includes(':')) {
        const lookalike = lookalikeDomain(host);
        if (lookalike) signals.push(signal('domain-lookalike', lookalike.how === 'subdomain'
          ? `“${host}” puts the trusted name “${lookalike.imitates}” in front of a different domain. The real owner is the part at the end.`
          : `“${host}” is one small edit away from the well-known domain “${lookalike.imitates}”. Lookalike domains are a common phishing and squatting tactic.`));
      }
    } catch {
      signals.push(signal('url-invalid', 'URL could not be parsed locally, so its destination cannot be assessed. Holding it for review is a CARD input-validation policy.'));
    }
  }

  if (policy.correlationEnabled) {
    const recent = history
      .filter((evaluation) => evaluation.request.sessionId === request.sessionId)
      .slice(-20)
      // A human verdict replaces the automated outcome: an earlier request a reviewer called safe
      // stops raising suspicion, and one reported unsafe starts raising it.
      .filter((evaluation) =>
        evaluation.request.type !== request.type
        && (evaluation.review?.decision ?? evaluation.decision) !== 'allow',
      );
    if (recent.length) signals.push(signal('session-correlation', `${recent.length} prior non-allowed artifact(s) of a different type occurred in this session. History is one contextual cue; counts are not multiplied into attack probabilities.`));
    const mine = normalizeName(request.name);
    const nameMatch = mine.length >= 3 && recent.some((evaluation) => correlationNames(evaluation.request).includes(mine));
    if (nameMatch) signals.push(signal('name-correlation', 'A prior non-allowed artifact of another type used the same normalized name. The stronger contextual cue replaces the generic history contribution; its severity is a CARD research hypothesis.'));
  }

  // Layer 2: earlier content in the session that told the agent to fetch or install this artifact.
  let chain: Evaluation['chain'];
  if (policy.correlationEnabled && observations.length) {
    chain = traceChain(request, observations);
    const quote = (link: NonNullable<typeof chain>['links'][number]) => `${link.tool} (${link.kind}) said: “${link.excerpt}”`;
    const external = chain.links.find((link) => link.instruction && link.external);
    const local = chain.links.find((link) => link.instruction && !link.external);
    const mention = chain.links.find((link) => link.external);
    if (chain.userRequested) { /* the user asked for it by name: explicit intent, not injection */ }
    else if (external) signals.push(signal('chain-external-instruction', `Content the agent fetched told it to get this artifact. ${quote(external)} Instructions inside fetched content are the indirect prompt-injection channel; the user did not ask for it by name.`));
    // A local instruction (the user's own workspace files or command output) is recorded as provenance but not scored.
    else if (local) { /* informational */ }
    else if (mention) signals.push(signal('chain-external-mention', `The artifact first appeared in content the agent fetched, not in the user's request. ${quote(mention)}`));
    if (!chain.links.length && !chain.userRequested) chain = undefined;
  }

  const result = scoreSignals(request.type, signals);
  const thresholdDecision = deriveDecision(result.score, policy);
  const floor = decisionFloor(result.signals, thresholdDecision);
  return {
    ...result, decision: floor?.decision ?? thresholdDecision, ...(floor ? { decisionFloor: floor } : {}), ...(chain ? { chain } : {}),
    scoringVersion: SCORING_VERSION, policySnapshot: { ...policy },
  };
}
