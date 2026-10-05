# MOSAIC: MVP capabilities and final-project plan

## 1. What works now

Updated 5 October 2026 for scoring model severity-v2. MOSAIC is a local console and API that evaluates external resources an AI coding agent proposes to use. It records a score, an explanation and Allow, Needs review or Deny.

**Four artifact types:** software packages, agent skills/instructions, MCP tool servers and remote URLs. They share one request format and one review workflow.

**Evaluation:** enter a name and session, then optional source, existence/signature reports, age, downloads, static text and permissions. The engine inspects these supplied inputs locally; it does not fetch or execute the resource.

**Scoring:** severity weights are sourced from Zahan et al., IEEE Security & Privacy (2023), Section II: 2.5, 5, 7.5 and 10. MOSAIC multiplies by ten for a 0-100 display. Take the strongest signal in each evidence group, sum and cap at 100. Default review is 50 and deny is 75. Age and downloads have no fixed penalty. Classifications, grouping and thresholds are documented project adaptations, awaiting benchmark calibration.

**Session context:** prior non-allowed requests of other artifact types can influence the current evaluation. A shared name strengthens that context cue. The latest 20 earlier events in the same session are considered. That window is an implementation limit.

**Interactive controls:** Overview totals, a session dropdown and trace, a review inbox, a searchable request list, type and decision filters, session filters, pagination, and a detailed evidence inspector.

**Review and policy:** a human may resolve held requests with Allow/Deny and a note. The original score and receipt are preserved. Thresholds and correlation can be saved; the preview slider creates no evaluation.

**Replays:** four synthetic workflows use the real local API. Known publisher gives 0/Allow; Young integration gives 50/Review; Linked trust signals gives URL 100/Deny then skill 75/Deny; correlation off makes the skill 25/Allow. Over-privileged unknown source gives 100/Deny.

**Persistence and audit:** evaluations, policy and reviews are saved locally. Export JSON and verify the original hash-linked evaluation chain. New evaluations include the model version and policy used; older results retain their original scoring and hashes.

**Interface:** responsive desktop/mobile layout, keyboard navigation, reconnect controls and locally bundled Manrope/Public Sans fonts. The scoring inspector includes paper references and labels supporting signals that add no extra points.

<!-- page -->

# 2. How to run and demonstrate it

Install Node.js 22 or newer. In the MOSAIC folder, run the following once. Initial dependency installation needs internet.

```text
npm ci
npm run build
npm start
```

Open http://127.0.0.1:4318/. Keep the terminal running. After setup, npm start is sufficient unless source changes require rebuilding. Development uses npm run dev with the interface on port 4317.

**Before presenting:** set review 50, deny 75 and correlation on. Old records still use older weights; replay fresh examples.

**Suggested sequence:** show Overview; replay Known publisher; replay Linked trust signals and inspect the 25 + 50 = 75 skill result; turn correlation off, save and replay to show 25/Allow; restore correlation; submit the following review example; resolve it with a note; export the audit.

**New evaluation example:** select MCP server. Name: presentation-notes. Session: presentation-review-01, using a new ID for each rehearsal. Source: https://example.invalid/tools. Existence: Unknown. Signature: Reported unsigned. Age: 6. Downloads: 18. Static content: "Summarise the selected project notes." Check only network:egress.

**Expected result:** provenance max(unknown 25, unsigned 25) = 25; network capability 25. Total **50, Needs review**. Age and downloads add nothing. The duplicate provenance cue remains visible as already covered. A reviewer note enables the Allow/Deny buttons.

**Functional validation commands:** npm run check and npm run test:browser. Browser tests use isolated temporary stores, installed Edge on Windows or Playwright Chromium elsewhere. They verify functionality, not empirical detection accuracy.

**Audit verification:** download the JSON export and run the following with its actual location.

```text
npm run verify:audit -- "C:/path/to/mosaic-audit.json"
```

### Research explanation

The numeric scale is described in a peer-reviewed IEEE publication, but the complete MOSAIC model is an adaptation. Security conference research motivates hallucination, typosquatting, content and indirect-injection checks. No claim of measured detection accuracy is made. Read MOSAIC-Scoring-Rationale.pdf for each category's reasoning and complete references.

**Main reference:** N. Zahan et al., "OpenSSF Scorecard: On the Path Toward Ecosystem-Wide Automated Security Metrics," IEEE Security & Privacy, 21(6), 76-88, 2023. DOI: 10.1109/MSEC.2023.3279773. Accessible manuscript: https://arxiv.org/html/2208.03412v3#S2.

<!-- page -->

# 3. What the final project will add

### Current limits

**Interception:** the MVP returns decisions through an API. It does not automatically intercept shell commands, skill reads, MCP traffic or browser requests. A cooperating caller must submit a request before use and obey the verdict.

**Evidence:** existence, signature, age, downloads and permissions are caller reports. There are no live registry, DNS, domain reputation or signature-verification checks.

**Detection:** the package catalog and static text patterns are small. There is no semantic injection classifier, complete package analysis, execution sandbox or consensus hallucinated-name database. Legitimate inputs can match; malicious inputs can be missed.

**Operations:** this is a single-user local prototype. It has no authentication, reviewer identity, roles, tenants or multi-process database coordination.

**Audit:** receipts are SHA-256 hash-linked, not digitally signed or externally anchored. They can reveal changed original evaluations or broken links, but cannot authenticate their author or detect a fully rewritten chain. Review/policy events are separate and not authenticated by that chain.

**Research validation:** no labelled 200-500-case corpus, measured false-positive rate, comparative detection rate or end-to-end agent latency benchmark has been completed.

### Planned completion stages

**Connect and enforce:** build supported agent adapters, package/skill hooks, an MCP proxy and controlled HTTP egress. Completion requires denied operations to stop and held operations to pause/resume correctly.

**Verify evidence:** add independent registries, signed provenance and appropriate reputation checks. Distinguish verified results from unavailable or uncertain information.

**Expand analysis:** broaden name/content detectors and investigate a trained scoring model only with reliable labelled evidence. Review the current severity assignments with domain experts.

**Build and evaluate a benchmark:** assemble realistic malicious and benign workflows. Compare against relevant baselines, measure per-type detection and false positives, run correlation on/off ablation, vary thresholds and report latency. Use separate calibration and test data and report negative results honestly.

**Harden operation:** add persistent database coordination, identities/permissions for reviewers, authenticated audit receipts and secure deployment controls.

The final contribution is a tested enforcement system plus a reproducible research evaluation. The current MVP demonstrates the interface, explanatory scoring flow, correlation, review and audit mechanisms needed to reach it.
