# CARD benchmark

Measures how CARD's decisions compare with ground-truth labels on realistic agent scenarios. Results: [output/benchmark/summary.md](../output/benchmark/summary.md) (full data in `results.json` and `outcomes.json`).

## Commands

| Command | What it does |
|---|---|
| `npm run benchmark` | Replays both corpora through CARD and writes `output/benchmark/`. Deterministic: the same recording gives the same results hash. |
| `npm run benchmark:record` | Re-records the real npm, PyPI, RDAP and DNS answers for the main corpus (needs network). |
| `npx tsx benchmark/record.ts --holdout` | Re-records the hold-out corpus. |

## How a scenario works

Each scenario is a short agent session: optional context (what the user asked, what a fetched page or MCP tool returned, earlier requests), then one **target** request with a label. *Malicious* means CARD should hold it for review or deny it; *benign* means CARD should allow it. "Flagged" = review or deny.

The runner uses CARD's production path: the SQLite store, the live-evidence merge (fed by recorded answers instead of the network), decision memory and Layer 2. It runs twice: with cross-artifact correlation and chain analysis (full CARD) and without (Layer 1 only).

## Where the data comes from

- **Benign packages:** the most-downloaded npm packages (npm-high-impact) and PyPI projects (top-pypi-packages).
- **Documented malware:** names from the 2017 npm "hacktask" typosquatting campaign (crossenv, mongose, babelcli …) and later cases. A name is used only if npm **currently serves a security holding package** for it, the registry's own marker for removed malware. 36 of 38 candidates qualified; 2 are legitimate packages today and are excluded automatically.
- **Hallucinated packages and domains:** plausible invented names (a popular base plus a generic suffix, the conflation pattern described by Spracklen et al., USENIX Security 2025). A name is used only if the registry or DNS **confirmed it does not exist** at recording time.
- **Typosquats:** one-character edits of top packages (swap, drop, double, substitute); a variant that is itself a popular package is excluded.
- **Private-network targets:** literal private addresses plus public wildcard DNS names that really resolve to private addresses (localtest.me, nip.io, sslip.io).
- **Instruction files and MCP descriptions:** written for this benchmark, modelled on published tool-poisoning and indirect-prompt-injection examples. Some attacks are deliberately **paraphrased** so literal patterns cannot match them.
- **Hard benign cases:** official installers that pipe a download into a shell (rustup, bun, deno, docker, nvm, uv, pnpm, ollama), installs listed in a project README, and installs an agent takes from an official docs page the user did not name.

Registry and DNS answers were recorded once (`recordings/`, date inside each file) and trimmed to the fields CARD reads. npm's download-count API rate-limited some lookups; download counts are context only and never scored, so this does not affect results.

## Validity rules

1. **Rules frozen before the hold-out set.** The main corpus exposed rule gaps that were fixed (commit c1b12e9; the first run is kept as `output/benchmark/results-initial-v4.json`). Those fixes were informed by misses in both the train and test splits of the main corpus, so **main-corpus numbers are optimistic**. The hold-out set (`buildHoldout` in corpus.ts) was written after the freeze and never used to change a rule. **It is the unbiased estimate.**
2. **Threshold selection** on a deterministic 50/50 split of the main corpus: chosen on train by Youden's J, reported on test.
3. **Confidence calibration** is reported as accuracy per confidence level, not assumed.

## Limitations

- The scenarios are built by the CARD team from public descriptions; it is not an industry-standard corpus, and the same people wrote the rules and the attacks.
- Malicious labels for typosquat variants assume the user meant the popular package; a variant could in rare cases be a legitimate project.
- Lookalike domains may be defensive registrations by the real owner; they are still labelled as unintended hosts.
- The hold-out set does not repeat the hard benign categories, so its false-positive rate is optimistic for installers and docs-following.
- Pattern matching cannot catch reworded instructions; the paraphrased categories measure this gap.

## Ethics and disclosure

- No malicious code is downloaded, executed or included. Documented malware names are only looked up as registry metadata; npm serves empty security holding packages for them.
- Invented names were checked to be unregistered and are not published by the team.
- If future work finds a real, active malicious package or a vulnerability in another tool, the team reports it to the registry or the maintainer before publishing.
