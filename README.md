# Cross-Artifact Runtime Defense (CARD)

A middleware for autonomous coding agents against malicious dependency injection.

Coding agents such as Claude Code and Codex install packages, fetch URLs, load instruction files (CLAUDE.md, AGENTS.md, skills) and call MCP servers on their own. CARD sits in front of those actions. Each one is checked against real registry and DNS evidence, scored by one explainable rule engine, linked to whatever earlier content prompted it, and then allowed, held for a human, or denied, before it runs.

## What it does

- **Intercepts live agent actions.** Claude Code and Codex hooks catch installs (npm, pnpm, yarn, bun, npx, pip, uv, pipx, poetry, cargo), URL fetches, instruction files and MCP calls. A local npm/PyPI registry proxy catches installs the hook cannot see, such as an install hidden inside an `npm run` script. An MCP proxy checks tool descriptions before the agent sees them.
- **Looks facts up itself.** Existence, publish date, provenance attestations, install scripts and security takedowns come from npm and PyPI; DNS shows whether a domain exists or resolves to a private address. A failed lookup is "unverified", never "missing".
- **One explainable score for four artifact types.** A weighted-v4 rubric (severity scale from Zahan et al., IEEE S&P 2023), decision floors for single critical findings, and a per-signal reason with sources. See [docs/SCORING.md](docs/SCORING.md).
- **Cross-artifact context.** Session correlation links risky requests across types. Layer 2 links a request to the fetched page or MCP response that told the agent to make it.
- **Human in the loop that cannot be bypassed.** Held actions wait in the dashboard; only a reviewer with the PIN can decide. Verdicts can be remembered as trust (one exact version, expiring) or blocks (every version), and feed false-positive / false-negative metrics.
- **Tamper-evident audit.** Every evaluation, verdict, rule change and policy change is hash-chained and Ed25519-signed; `npm run verify:audit` checks an export offline.

## Run it

Requires Node.js 22+ (uses the built-in `node:sqlite`).

```sh
npm ci
npm run build
npm start                      # dashboard and API on http://127.0.0.1:4318
```

On first start the terminal prints a one-time setup code. Open the dashboard and choose a reviewer PIN with it. Sample data is off by default; start with `CARD_SAMPLE_DATA=1` to load the demo fixtures.

Connect an agent to a workspace (project-level configuration only; user settings are never changed):

```sh
npm run card -- install claude --workspace <dir> --registry-proxy
npm run card -- install codex  --workspace <dir> --registry-proxy
npm run card -- proxy          # npm/PyPI registry proxy on 127.0.0.1:4873
npm run card -- mcp-add claude --workspace <dir> --name <server> -- <server command...>
npm run card -- status --workspace <dir>
```

Codex runs project hooks only after you trust them: open Codex in the workspace, accept "trust this project", then run `/hooks` and trust the CARD hooks.

If CARD is not running, agents in connected workspaces are blocked from installs, fetches and MCP use (fail closed); ordinary editing is unaffected.

## Measured results

From [the benchmark](benchmark/README.md): real recorded registry and DNS data, CARD's production code path, deterministic results.

| Set | Attacks caught | False alarms | Notes |
|---|---|---|---|
| Hold-out (144 scenarios, written after the rules were frozen) | 95.1% (77/81) | 0% (0/63) | The unbiased estimate. All 4 misses are reworded instruction files. It contains no hard benign cases. |
| Main corpus (431 scenarios) | 96.6% | 9.8% | Optimistic: rule fixes were informed by these results. False alarms are official `curl \| sh` installers and installs an agent takes from a docs page the user did not name. |
| Main corpus, Layer 1 only | 92.4% | 4.7% | Layer 2 adds cross-artifact detections at the cost of holding docs-following installs. |

Per-request overhead: about 2.7 ms median through the API (scoring itself under 0.1 ms), flat from 100 to 5,000 stored evaluations ([output/performance](output/performance)). Live registry lookups add network time on first use; results are cached for an hour.

## Architecture

```text
Claude Code / Codex ──hook──┐   npm / pip ──registry proxy──┐   MCP client ──MCP proxy──┐
                            ▼                               ▼                          ▼
                 CARD API (Express, loopback) ── evidence: npm, PyPI, DNS, RDAP
                            │
        engine: signals ─▶ weighted score ─▶ thresholds + decision floors
                            │   + session history, Layer 2 observations, decision memory
                            ▼
           allow · review (waits for a signed-in human) · deny
                            │
              SQLite store ─▶ hash-chained, signed audit log ─▶ dashboard (React)
```

Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Comparison with Pipelock and mcp-firewall: [docs/COMPARISON.md](docs/COMPARISON.md). Live demo script: [docs/PRESENTATION.md](docs/PRESENTATION.md).

## Development

| Command | Purpose |
|---|---|
| `npm run dev` | API on 4318 and Vite dev server on 4317 |
| `npm run check` | Unit, API, adapter and proxy tests, type check, production build |
| `npm run test:browser` | Playwright browser suite (uses installed Edge on Windows) |
| `npm run benchmark` | Replays the benchmark and writes output/benchmark |
| `npm run bench` | Latency benchmark (output/performance) |
| `npm run verify:audit -- <export.json>` | Verifies a downloaded audit export |

## Limits

- CARD protects only workspaces where it is installed. An agent with full shell access as the same OS user could still stop CARD or edit its files. CARD blocks the obvious paths (its reviewer API, its data and hook configuration), but true isolation needs CARD to run as a separate OS user or service.
- Text rules miss reworded instructions; the benchmark measures this gap.
- The confidence value is an explanation of how much was verified, and the benchmark shows it is not calibrated.
- PyPI provenance attestations are not checked. Skills and MCP servers have no registry, so their evidence is what the adapter observed.
- The benchmark was written by the same team that wrote the rules. The hold-out set reduces but does not remove that bias.
- Codex integration follows Codex's documented hook and MCP formats; it is verified by contract tests, not yet by a live Codex session on this machine.
