/** Literature-sourced ordinal weights; MOSAIC's classifications are adaptations. */
export const SCORING_VERSION = 'weighted-v3';
export const RECOMMENDED_POLICY = { reviewThreshold: 20, denyThreshold: 50, correlationEnabled: true };
export const SEVERITY_WEIGHTS = { low: 2.5, medium: 5, high: 7.5, critical: 10 } as const;
export type Severity = keyof typeof SEVERITY_WEIGHTS;
export const EVIDENCE_GROUPS = {
  provenance: 'Identity & provenance',
  permissions: 'Requested capabilities',
  content: 'Static content',
  transport: 'URL & transport',
  context: 'Session context',
} as const;
export type EvidenceGroup = keyof typeof EVIDENCE_GROUPS;

export const SCORING_SOURCES = {
  weights: { title: 'Zahan et al. · IEEE Security & Privacy 2023 · Section II', url: 'https://arxiv.org/html/2208.03412v3#S2', doi: '10.1109/MSEC.2023.3279773' },
  hallucination: { title: 'Spracklen et al. · USENIX Security 2025', url: 'https://www.usenix.org/conference/usenixsecurity25/presentation/spracklen' },
  supplyChain: { title: 'Ohm et al. · DIMVA 2020', url: 'https://arxiv.org/abs/2005.09535', doi: '10.1007/978-3-030-52683-2_2' },
  detection: { title: 'Sejfia & Schäfer · ICSE 2022', url: 'https://arxiv.org/abs/2202.13953', doi: '10.1145/3510003.3510104' },
  injection: { title: 'Abdelnabi et al. · ACM AISec 2023', url: 'https://arxiv.org/abs/2302.12173', doi: '10.1145/3605764.3623985' },
  ssrf: { title: 'OWASP · SSRF Prevention Cheat Sheet', url: 'https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html' },
  transport: { title: 'MITRE · CWE-319', url: 'https://cwe.mitre.org/data/definitions/319.html' },
  agent: { title: 'OWASP · AI Agent Security Cheat Sheet', url: 'https://cheatsheetseries.owasp.org/cheatsheets/AI_Agent_Security_Cheat_Sheet.html' },
} as const;
export type ScoringSource = keyof typeof SCORING_SOURCES;

export const SIGNAL_RULES = {
  'metadata-missing': { label: 'Artifact reported missing', severity: 'high', group: 'provenance', sources: ['hallucination'] },
  'metadata-unverified': { label: 'Existence unverified', severity: 'low', group: 'provenance', sources: ['hallucination'] },
  'name-lookalike': { label: 'Known-package lookalike', severity: 'medium', group: 'provenance', sources: ['supplyChain'] },
  unsigned: { label: 'Unsigned artifact', severity: 'low', group: 'provenance', sources: ['weights'] },
  'elevated-permissions': { label: 'Elevated permissions', severity: 'low', group: 'permissions', sources: ['agent', 'weights'] },
  'sensitive-permissions': { label: 'Sensitive capabilities', severity: 'medium', group: 'permissions', sources: ['agent', 'weights'] },
  'obfuscated-content': { label: 'Obfuscated content', severity: 'low', group: 'content', sources: ['detection', 'supplyChain'] },
  'credential-access': { label: 'Credential-access indicator', severity: 'low', group: 'content', sources: ['detection', 'supplyChain'] },
  'remote-payload': { label: 'Remote execution pattern', severity: 'high', group: 'content', sources: ['supplyChain'] },
  'instruction-override': { label: 'Instruction override', severity: 'high', group: 'content', sources: ['injection'] },
  'url-not-https': { label: 'Non-HTTPS URL', severity: 'medium', group: 'transport', sources: ['transport'] },
  'url-local-host': { label: 'Local or private host', severity: 'medium', group: 'transport', sources: ['ssrf'] },
  'url-invalid': { label: 'Invalid URL', severity: 'medium', group: 'transport', sources: ['ssrf'] },
  'session-correlation': { label: 'Session correlation', severity: 'low', group: 'context', sources: ['injection', 'agent'] },
  'name-correlation': { label: 'Cross-artifact name reuse', severity: 'medium', group: 'context', sources: ['injection', 'hallucination'] },
} as const satisfies Record<string, { label: string; severity: Severity; group: EvidenceGroup; sources: readonly ScoringSource[] }>;
export type SignalId = keyof typeof SIGNAL_RULES;

/** All applicable groups remain in the denominator, including those with no matches. */
export function scoringProfile(type: 'package' | 'skill' | 'mcp' | 'url') {
  return (Object.keys(EVIDENCE_GROUPS) as EvidenceGroup[])
    .filter((group) => type === 'url' || group !== 'transport')
    .map((group) => ({
      group,
      capacity: Math.max(...Object.values(SIGNAL_RULES)
        .filter((rule) => rule.group === group)
        .map((rule) => SEVERITY_WEIGHTS[rule.severity] * 10)),
    }));
}

export const signalContribution = (signal: { score: number; weight: number; contribution?: number }) =>
  signal.contribution ?? signal.score * signal.weight;
