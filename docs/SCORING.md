# MOSAIC scoring: severity-v2

The numerical severity scale is sourced from **Zahan et al., "OpenSSF Scorecard: On the Path Toward Ecosystem-Wide Automated Security Metrics," IEEE Security & Privacy 21(6), 76-88, 2023**, DOI [10.1109/MSEC.2023.3279773](https://doi.org/10.1109/MSEC.2023.3279773). The [author manuscript, Section II](https://arxiv.org/html/2208.03412v3#S2) explicitly reports Low = 2.5, Medium = 5, High = 7.5, Critical = 10.

MOSAIC uses `points = 10 * published severity weight`, giving **25 / 50 / 75 / 100** on the existing display. Multiplication changes units and preserves the 1:2:3:4 ratios; it does not create probabilities. The original individually chosen values have been replaced.

**Citation scope:** the paper studies repository security practices, using a weighted average of check scores. It does not train an agent-request detector or assign coefficients to MOSAIC's signals. Signal classifications, maximum-per-group aggregation and decision policy below are **MOSAIC adaptations**, awaiting expert review and benchmark calibration. The sources establish why each concern matters, not a measured effect size.

## Classification rubric

- Low (25): uncertain or non-specific evidence, or a generally legitimate capability. Unknown existence, reported unsigned status, environment-variable use, encoding and network capability are weak cues.
- Medium (50): a structural trust-boundary concern or a stronger contextual association warranting review. Lookalike names, private/non-HTTPS destinations, secrets access and linked identifiers fall here.
- High (75): an explicit unavailable-artifact report, remote-download-to-shell pattern or instruction to override security guidance. High expresses conservative intervention priority, not proof of maliciousness.
- Critical (100): a single-signal level reserved for future independently confirmed threats. No current detector assigns Critical. Combined group contributions may still reach the 100 cap.

## Rules and backing

| Signal | Base points | Group | Rationale and source |
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

## Aggregation and decisions

```text
group_points(g) = max(base points of signals in group g, default=0)
score = min(100, sum(group_points(g)))
```

Within each of the five groups, only the strongest signal contributes; ties use the first detected signal. All explanations are retained: contributing signals have `weight=1`, others `weight=0`. Grouping reduces repeated penalties for related concerns; it does not assert independence between groups.

Defaults: **review 50, deny 75, correlation on**. One Medium concern reaches review; one High concern reaches deny. Scores 0-49 allow, 50-74 review, 75-100 deny. Two Low concerns in different groups also reach review. These are operational boundaries tied to severity categories, not empirically optimal thresholds.

History includes the most recent 20 earlier evaluations in the same session, with original non-allowed decisions and different artifact types. The window is an implementation bound, not a statistical estimate. Shared-name context replaces generic context instead of adding both.

## Worked examples

- Known publisher: **0, allow**.
- Young integration / presentation-notes: provenance max(unknown 25, unsigned 25) = 25, capability 25. **50, review**. Age and downloads add nothing.
- Linked trust signals: URL 75 provenance + max(non-HTTPS 50, private host 50) + capability 25 = 150, capped at **100, deny**. Skill provenance 25 + max(prior event 25, shared name 50) = **75, deny**. Correlation off: skill **25, allow**.
- Over-privileged unknown source: missing 75 + sensitive capability 50 = 125, capped at **100, deny**.

## Versioning and limits

New records include `scoringVersion: severity-v2` and the policy used, covered by the original hash-linked receipt. Old records keep their scores and hashes and show "Earlier scoring model" in the inspector. The upgrade records an audit event and replaces only old factory thresholds 35/70 with 50/75; custom thresholds remain. Replay or submit fresh requests for the revised model.

Tests verify arithmetic, grouping, thresholds, duplicate handling, cutoff removal, correlation, versioning and migration. They are regression checks, not detection-rate or false-positive measurements. Evidence is caller-supplied. No artifact is fetched, installed or executed.

## Peer-reviewed references

1. Zahan, N. et al. "OpenSSF Scorecard: On the Path Toward Ecosystem-Wide Automated Security Metrics." **IEEE Security & Privacy**, 21(6), 76-88, 2023. DOI: [10.1109/MSEC.2023.3279773](https://doi.org/10.1109/MSEC.2023.3279773). [Manuscript, Section II/Table I](https://arxiv.org/html/2208.03412v3#S2).
2. Spracklen, J. et al. "We Have a Package for You! A Comprehensive Analysis of Package Hallucinations by Code Generating LLMs." **34th USENIX Security Symposium**, 2025. [Proceedings and paper](https://www.usenix.org/conference/usenixsecurity25/presentation/spracklen).
3. Ohm, M., Plate, H., Sykosch, A., Meier, M. "Backstabber's Knife Collection: A Review of Open Source Software Supply Chain Attacks." **DIMVA**, 2020, pp. 23-43. DOI: [10.1007/978-3-030-52683-2_2](https://doi.org/10.1007/978-3-030-52683-2_2). [Manuscript](https://arxiv.org/abs/2005.09535).
4. Sejfia, A., Schäfer, M. "Practical Automated Detection of Malicious npm Packages." **44th ACM/IEEE ICSE**, 2022, pp. 1681-1692. DOI: [10.1145/3510003.3510104](https://doi.org/10.1145/3510003.3510104). [Manuscript](https://arxiv.org/abs/2202.13953).
5. Abdelnabi, S. et al. "Not What You've Signed Up For: Compromising Real-World LLM-Integrated Applications with Indirect Prompt Injection." **16th ACM AISec**, 2023, pp. 79-90. DOI: [10.1145/3605764.3623985](https://doi.org/10.1145/3605764.3623985). [Manuscript](https://arxiv.org/abs/2302.12173).

Additional guidance (not conference papers): [OWASP AI Agent Security](https://cheatsheetseries.owasp.org/cheatsheets/AI_Agent_Security_Cheat_Sheet.html), [OWASP SSRF Prevention](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html), [MITRE CWE-319](https://cwe.mitre.org/data/definitions/319.html), [NIST SP 800-30r1](https://doi.org/10.6028/NIST.SP.800-30r1). Inspected 5 October 2026. None endorses MOSAIC's accuracy or thresholds.
