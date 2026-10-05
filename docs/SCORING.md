# MOSAIC scoring: weighted-v3

The numerical severity scale is sourced from **Zahan et al., "OpenSSF Scorecard: On the Path Toward Ecosystem-Wide Automated Security Metrics," IEEE Security & Privacy 21(6), 76-88, 2023**, DOI [10.1109/MSEC.2023.3279773](https://doi.org/10.1109/MSEC.2023.3279773). The [author manuscript, Section II](https://arxiv.org/html/2208.03412v3#S2) explicitly reports Low = 2.5, Medium = 5, High = 7.5, Critical = 10.

MOSAIC uses **raw severity ratings** of 25 / 50 / 75 / 100, preserving the published 2.5 / 5 / 7.5 / 10 ratios. These ratings are not additive contributions. A fixed normalized weighted average converts each group's rating into its share of the full 100-point assessment budget. The total is naturally bounded; there is no clipping operation.

**Citation scope:** the paper supplies severity weights and describes weighted-average aggregation for repository security practices. MOSAIC uses that mathematical form with its own groups and declared ranges. It does not implement the full Scorecard checks or claim that their authors validated agent-request coefficients. Signal classifications, group definitions, range selection and decision thresholds are **MOSAIC adaptations**, awaiting expert review and benchmark calibration.

## Classification rubric

- Low (25): uncertain or non-specific evidence, or a generally legitimate capability. Unknown existence, reported unsigned status, environment-variable use, encoding and network capability are weak cues.
- Medium (50): a structural trust-boundary concern or a stronger contextual association warranting review. Lookalike names, private/non-HTTPS destinations, secrets access and linked identifiers fall here.
- High (severity 75): an explicit unavailable-artifact report, remote-download-to-shell pattern or instruction to override security guidance. Severity expresses concern strength, not proof of maliciousness or an automatic decision.
- Critical (severity 100): reserved for future independently confirmed threats; no current detector uses it. A final score of 100 means every applicable group reached its declared maximum, not that an attack is certain.

## Rules and backing

| Signal | Raw severity | Group | Rationale and source |
| --- | ---: | --- | --- |
| Artifact reported missing | 75 | Identity & provenance | Request cannot be fulfilled as identified. Spracklen et al., USENIX Security 2025, documents package hallucination and its attack surface. Only a caller report is used here; no registry check. |
| Existence unverified | 25 | Identity & provenance | Missing evidence is weaker than reported nonexistence. This distinction is a MOSAIC policy judgement motivated by the same research. |
| Known-package lookalike | 50 | Identity & provenance | Ohm et al., DIMVA 2020, documents typosquatting. Similar names can be legitimate, so similarity merits review rather than a malware claim. Catalog and edit-distance boundary are prototype choices. |
| Reported unsigned | 25 | Identity & provenance | Zahan et al. discusses signed provenance. Its Signed-Releases check is High; MOSAIC uses Low because an unverified boolean is weaker than examining actual releases. This is an explicit adaptation. |
| General elevated capability | 25 | Requested capabilities | Network/filesystem/clipboard/browser access creates potential exposure but is often needed legitimately. OWASP AI Agent Security motivates least privilege. IEEE Token-Permissions is related but repository-specific. |
| Sensitive capability | 50 | Requested capabilities | Shell, process spawning or secrets access increases execution/confidentiality impact. OWASP least privilege supports review. Duplicates and permission counts do not multiply points. |
| Obfuscation marker | 25 | Static content | Ohm et al. and Sejfia & Schäfer, ICSE 2022, motivate suspicious-code inspection. Encoding also occurs in benign code, making a bare marker weak evidence. |
| Credential-location marker | 25 | Static content | The same research discusses exfiltration-related behavior. A reference such as process.env does not establish theft, hence Low. Their trained/behavioral analyses are not implemented here. |
| Remote download piped to shell | 75 | Static content | Ohm et al. studies execution mechanisms and payloads. The pattern can run unreviewed code, warranting intervention. Legitimate installers can use it too. |
| Instruction override in skill/MCP text | 75 | Static content | Abdelnabi et al., ACM AISec 2023, demonstrates indirect prompt injection. An override in an instruction-bearing artifact gets conservative High priority; a text match is not a successful-attack measurement. |
| Non-HTTPS URL | 50 | URL & transport | MITRE CWE-319 motivates cleartext-transmission concerns. This does not establish that sensitive data is actually transmitted. |
| Local/private URL host | 50 | URL & transport | OWASP SSRF Prevention motivates network-boundary checks. Approved internal services can be legitimate. Literal parsing only; no DNS/HTTP request. |
| Invalid URL | 50 | URL & transport | Destination cannot be classified. Review is a MOSAIC fail-safe input policy, not a learned coefficient. |
| Prior non-allowed cross-type request | 25 | Session context | Indirect-injection research and OWASP behavior monitoring motivate history inspection. Generic earlier activity is a weak cue. |
| Shared name across those requests | 50 | Session context | A shared identifier is a stronger link than timing alone. This uplift is MOSAIC's research hypothesis, not an improvement measured by the cited papers. |

Age and download count are visible context with **zero points**. No transferable evidence was found for universal 7-day or 50-download cutoffs in the reviewed papers. These features could still be useful in a trained, ecosystem-specific model.

## Fixed weights and normalized aggregation

For package, skill and MCP requests, the applicable group ranges and weights are:

| Group | Maximum supported severity C_g | Weight C_g / 250 | Maximum contribution |
| --- | ---: | ---: | ---: |
| Identity & provenance | 75 | 30% | 30 |
| Requested capabilities | 50 | 20% | 20 |
| Static content | 75 | 30% | 30 |
| Session context | 50 | 20% | 20 |
| Total | 250 | 100% | 100 |

Each range is the highest severity in the declared detector catalog for that group. This avoids inventing additional percentage weights: 75/250 = 30%, 50/250 = 20%. It remains a documented range-selection adaptation, not an empirically fitted importance estimate.

URLs additionally include URL & transport with capacity 50. Their fixed denominator is **300**; weights in the order provenance/capabilities/content/transport/context are **1/4, 1/6, 1/4, 1/6, 1/6**. These sum to one. Transport is excluded for non-URL requests because their source label is not evaluated as a URL by this MVP.

Let S_g be the strongest matched raw severity in group g, or zero, and C_g its configured maximum:

```text
group weight w_g = C_g / sum(C_g)
group rating r_g = S_g / C_g
contribution_g = 100 * w_g * r_g
score = sum(contribution_g)
      = 100 * sum(S_g) / sum(C_g)
```

Since weights sum to one and each group rating is between zero and one, the total is between **0 and 100 by construction**. No post-hoc cap is used. The denominator includes all applicable groups, including unmatched groups, and does not change when correlation is disabled or metadata is omitted. Normalizing only matched signals would inflate sparse evidence and is not done.

Only the strongest cue within a group supplies its rating; others remain visible with zero additional contribution. API fields retain `rawSeverity`, `score = 100 * S_g / C_g`, normalized `weight = C_g / denominator`, and the two-decimal `contribution`. The complete profile includes every applicable group and its weight. Contributions are rounded together using the largest fractional remainders so they sum exactly to the displayed total. Rounding changes at most a cent, not the score range.

Defaults: **review 20, deny 50, correlation on**. Scores below 20 allow; 20 to below 50 review; 50-100 deny. Review 20 catches a medium concern in the four-group profile or two low concerns from different groups. Deny 50 means half the possible weighted concern budget is occupied. These are transparent operational policy choices, not empirically optimal thresholds. A single medium URL concern contributes 16.67 and can be below review; deployments needing stricter URL policy must lower the threshold or add a separately evaluated mandatory control.

History includes the most recent 20 earlier evaluations in the same session, with original non-allowed decisions and different artifact types. The window is an implementation bound, not a statistical estimate. Shared-name context replaces generic context instead of adding both.

## Worked examples

- Known publisher: **0, allow**.
- Young integration / presentation-notes: provenance max(unknown 25, unsigned 25) = 25; capability 25. Weighted contributions **10 + 10 = 20, review**. Age and downloads add nothing.
- Linked trust signals: URL severities 75 provenance + 50 transport + 25 capability = 150 out of capacity 300. Contributions **25 + 16.67 + 8.33 = 50, deny**. Skill severities 25 provenance + 50 context = 75 out of 250. Contributions **10 + 20 = 30, review**. Correlation off: skill **10, allow**.
- Over-privileged unknown source / ops-mirror: severities 75 missing + 50 sensitive capability = 125 out of capacity 250. Contributions **30 + 20 = 50, deny**. The other groups contribute zero; unsigned is already covered by the stronger provenance cue. No clipping.

## Versioning and limits

New records include `scoringVersion: weighted-v3`, the policy used, and the complete normalization breakdown, covered by the original hash-linked receipt. V1/v2 records retain their old scores and hashes and are labelled earlier models. Upgrade changes former factory thresholds 35/70 or 50/75 to 20/50 and records an audit event; custom settings remain. Replay or submit fresh requests for v3.

Tests cover every combination of the current severity levels across all four profiles, including all-zero, maximum, duplicate and rounding cases. Displayed contributions equal the total and the score remains within 0-100 without clipping. They also verify thresholds, correlation, versioning and legacy migration. These are functional properties, not detection-rate measurements. Evidence remains caller-supplied; no artifact is fetched, installed or executed.

## Peer-reviewed references

1. Zahan, N. et al. "OpenSSF Scorecard: On the Path Toward Ecosystem-Wide Automated Security Metrics." **IEEE Security & Privacy**, 21(6), 76-88, 2023. DOI: [10.1109/MSEC.2023.3279773](https://doi.org/10.1109/MSEC.2023.3279773). [Manuscript, Section II/Table I](https://arxiv.org/html/2208.03412v3#S2).
2. Spracklen, J. et al. "We Have a Package for You! A Comprehensive Analysis of Package Hallucinations by Code Generating LLMs." **34th USENIX Security Symposium**, 2025. [Proceedings and paper](https://www.usenix.org/conference/usenixsecurity25/presentation/spracklen).
3. Ohm, M., Plate, H., Sykosch, A., Meier, M. "Backstabber's Knife Collection: A Review of Open Source Software Supply Chain Attacks." **DIMVA**, 2020, pp. 23-43. DOI: [10.1007/978-3-030-52683-2_2](https://doi.org/10.1007/978-3-030-52683-2_2). [Manuscript](https://arxiv.org/abs/2005.09535).
4. Sejfia, A., Schäfer, M. "Practical Automated Detection of Malicious npm Packages." **44th ACM/IEEE ICSE**, 2022, pp. 1681-1692. DOI: [10.1145/3510003.3510104](https://doi.org/10.1145/3510003.3510104). [Manuscript](https://arxiv.org/abs/2202.13953).
5. Abdelnabi, S. et al. "Not What You've Signed Up For: Compromising Real-World LLM-Integrated Applications with Indirect Prompt Injection." **16th ACM AISec**, 2023, pp. 79-90. DOI: [10.1145/3605764.3623985](https://doi.org/10.1145/3605764.3623985). [Manuscript](https://arxiv.org/abs/2302.12173).

Additional guidance (not conference papers): [OWASP AI Agent Security](https://cheatsheetseries.owasp.org/cheatsheets/AI_Agent_Security_Cheat_Sheet.html), [OWASP SSRF Prevention](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html), [MITRE CWE-319](https://cwe.mitre.org/data/definitions/319.html), [NIST SP 800-30r1](https://doi.org/10.6028/NIST.SP.800-30r1). Inspected 5 October 2026. None endorses MOSAIC's accuracy or thresholds.
