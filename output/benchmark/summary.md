# CARD benchmark results

Corpus: 431 scenarios used (238 malicious, 193 benign) of 435 built. Registry and DNS facts recorded 2026-10-29. Policy: review 20, deny 50. "Flagged" = held for review or denied.

Excluded by recorded-fact rules: 3 × not (or no longer) an npm security holding package; 1 × hallucinated domain turned out to exist.

## Overall

| Configuration | Detection rate | False-positive rate | Precision | F1 |
|---|---|---|---|---|
| Full CARD (Layer 1 + 2) | 96.6% | 9.8% | 92.4% | 94.5% |
| Layer 1 only | 92.4% | 4.7% | 96.1% | 94.2% |

## By category (full CARD)

| Category | Scenarios | Flagged | Detection (attacks) / false-positive rate (benign) |
|---|---|---|---|
| attack: cross-artifact name reuse | 10 | 10 | 100.0% |
| attack: documented malicious npm package | 36 | 36 | 100.0% |
| attack: hallucinated domain | 14 | 14 | 100.0% |
| attack: hallucinated package (npm) | 30 | 30 | 100.0% |
| attack: hallucinated package (PyPI) | 15 | 15 | 100.0% |
| attack: install steered by fetched content | 19 | 19 | 100.0% |
| attack: internal address (SSRF) | 10 | 10 | 100.0% |
| attack: lookalike domain | 10 | 10 | 100.0% |
| attack: MCP rug pull (changed after trust) | 5 | 5 | 100.0% |
| attack: MCP tool poisoning | 8 | 8 | 100.0% |
| attack: MCP tool poisoning (lookalike name) | 3 | 3 | 100.0% |
| attack: MCP tool poisoning (paraphrased) | 4 | 2 | 50.0% |
| attack: poisoned instruction file | 12 | 12 | 100.0% |
| attack: poisoned instruction file (paraphrased) | 8 | 2 | 25.0% |
| attack: typosquat (npm) | 29 | 29 | 100.0% |
| attack: typosquat (PyPI) | 15 | 15 | 100.0% |
| attack: unknown script piped to a shell | 10 | 10 | 100.0% |
| benign: documentation URL | 20 | 0 | 0.0% |
| benign: install listed in the project README | 10 | 0 | 0.0% |
| benign: install suggested by a fetched docs page | 10 | 10 | 100.0% |
| benign: instruction file | 20 | 1 | 5.0% |
| benign: MCP server | 15 | 0 | 0.0% |
| benign: official installer piped to a shell | 8 | 8 | 100.0% |
| benign: popular npm package | 60 | 0 | 0.0% |
| benign: popular PyPI package | 40 | 0 | 0.0% |
| benign: user-requested, also mentioned on a fetched page | 10 | 0 | 0.0% |

## Layer 2 ablation (categories whose outcome changed)

| Category | Layer 1 flagged | Full flagged |
|---|---|---|
| attack: cross-artifact name reuse | 0/10 | 10/10 |
| benign: install suggested by a fetched docs page | 0/10 | 10/10 |

## Threshold selection

Review threshold chosen on the train split by Youden J (detection rate minus false-positive rate), ties broken toward the default 20; reported on the held-out test split. Chosen review threshold: 30. Test split (220 scenarios) at the default 20: detection 97.3%, false positives 9.2%, precision 91.5% (TP 108, FP 10, FN 3, TN 99). At the chosen threshold: detection 90.1%, false positives 2.8%, precision 97.1% (TP 100, FP 3, FN 11, TN 106).

## Confidence calibration

| Confidence | Scenarios | Decision correct |
|---|---|---|
| low | 39 | 97.4% |
| medium | 80 | 85.0% |
| high | 312 | 95.5% |

## Misses and false alarms

Missed attacks: 8. False alarms: 19. Both are listed in results.json.

## Hold-out set (unbiased estimate)

Written after the rules were frozen at commit c1b12e9; never used to change them. This is the unbiased estimate. 144 scenarios (81 malicious, 63 benign).

| Configuration | Detection rate | False-positive rate | Precision |
|---|---|---|---|
| Full CARD | 95.1% | 0.0% | 100.0% |
| Layer 1 only | 95.1% | 0.0% | 100.0% |

| Category | Scenarios | Flagged |
|---|---|---|
| attack: hallucinated domain | 5 | 5 |
| attack: hallucinated package (npm) | 20 | 20 |
| attack: hallucinated package (PyPI) | 10 | 10 |
| attack: internal address (SSRF) | 3 | 3 |
| attack: MCP tool poisoning | 5 | 5 |
| attack: poisoned instruction file | 8 | 4 |
| attack: typosquat (npm) | 20 | 20 |
| attack: typosquat (PyPI) | 10 | 10 |
| benign: instruction file | 8 | 0 |
| benign: MCP server | 5 | 0 |
| benign: popular npm package | 30 | 0 |
| benign: popular PyPI package | 20 | 0 |

Timing: median 1.27 ms, 95th percentile 295.51 ms per evaluation (Wall time per evaluation including recorded-evidence replay; varies by machine and is excluded from the reproducibility hash.)

Results hash: see results.json. Re-running `npm run benchmark` on the same recording reproduces it.
