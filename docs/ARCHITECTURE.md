# CARD architecture

## Components

| Component | Files | Role |
|---|---|---|
| Agent hook | `adapters/hook.ts`, `adapters/core.ts`, `adapters/commands.ts` | Runs inside Claude Code and Codex for every tool call. Extracts artifacts from shell commands (installs, fetches, reads of instruction files), WebFetch, file reads and MCP calls; asks CARD; blocks with exit code 2 and a reason. Scans instruction files at session start and enforces the result at the first prompt. Records tool output as observations. |
| Registry proxy | `adapters/registry-proxy.ts` | Local npm registry and PyPI simple index. Every package listing and version download is checked, so installs the hook cannot parse are still covered. Denied: HTTP 403 with CARD's reason. CARD down: 503. |
| MCP proxy | `adapters/mcp-proxy.ts` | Stdio wrapper around an MCP server. Scores the tool list before the agent sees it and hides denied or held servers' tools. |
| Installer | `scripts/card.ts` | Bundles the hook and proxy, writes project-level hook and MCP configuration, routes npm/pip through the proxy. |
| API | `server/index.ts` | Express on loopback. Validates every input. Evaluation endpoints are open to adapters; review, rule and policy endpoints need the reviewer session. |
| Evidence | `server/evidence.ts` | npm, PyPI, DNS and RDAP lookups; per-field provenance; one-hour cache. |
| Engine | `server/engine.ts`, `shared/scoring.ts`, `server/lookalike.ts`, `server/chain.ts` | Signals, normalized weighted score, thresholds, decision floors, session correlation and Layer 2 chain tracing. Deterministic: same inputs, same result. |
| Decision memory | `server/memory.ts`, `shared/feedback.ts` | Trust and block rules from human verdicts; feedback metrics. |
| Store and audit | `server/store.ts`, `server/db.ts`, `server/audit.ts` | SQLite (node:sqlite, WAL). One hash chain over all audit events, each signed with Ed25519. |
| Reviewer auth | `server/auth.ts` | PIN (scrypt hash), HttpOnly SameSite=Strict session, lockout after five failures, one-time setup code. |
| Dashboard | `src/` | React console: live updates (server-sent events), waiting-agent banner, evidence and chain panels, review, Trust & feedback, policy. |

## What happens to one request

1. **Intercept.** The agent is about to run `npm install axois`. The hook receives the tool call (tool name, command, the agent's session ID) and extracts `{type: package, ecosystem: npm, name: axois}`. Tool calls with no artifact go straight through without contacting CARD.
2. **Evidence.** CARD queries npm: the package exists, has no provenance attestation, and its latest version is `0.0.1-security` (a security holding package). Caller claims are ignored for anything checkable.
3. **Signals and score.** Lookalike of `axios`; removed by registry security; unsigned. Each group's strongest severity is weighted against the full 100-point budget.
4. **Context.** The last 20 requests in the session (session correlation) and this session's observations (Layer 2: did a fetched page tell the agent to do this?).
5. **Decision.** Thresholds (review 20, deny 50), then decision floors (registry takedown means at least Deny), then decision memory (a block always wins; trust applies only to the exact version and only if no new warning sign appeared).
6. **Record.** The evaluation, including evidence, decision floor, memory outcome, chain and confidence, is appended to the hash chain and signed.
7. **Enforce.** Allow: the hook prints nothing and the agent's own permission checks continue. Deny: exit 2 with the reason, which the agent reads. Review: the hook waits (up to 120 s) while the dashboard shows a countdown; a signed-in reviewer decides; no decision means deny.
8. **Learn.** The reviewer's verdict is stored as feedback and, if chosen, as a trust or block rule for later requests.

## Threat model

**Attacker can:** publish packages, MCP servers, skills and domains; post content agents read (web pages, READMEs, issue comments, MCP responses); choose names that LLMs hallucinate or users mistype.

**Attacker cannot:** change the model's weights, compromise the registry, or run code as the developer before CARD has allowed something. Out of scope: a compromised developer machine, insiders, and the CI pipeline.

**Attacker goals (owner-harm):** run code on the developer's machine, exfiltrate secrets, persist as a dependency.

## Trust boundaries

| Boundary | How CARD treats it |
|---|---|
| Agent to CARD | The agent is not trusted. It cannot call reviewer endpoints (PIN), cannot choose its session ID (set by the harness), and commands touching CARD's API, data or hook configuration are blocked. |
| CARD to registries | Registry answers are trusted as facts about the registry; a missing answer is "unverified". |
| Caller-supplied metadata | Used only in manual test mode; ignored in live mode for checkable fields. |
| Reviewer | Trusted, and accountable through signed audit events. |
| Same OS user | Not a boundary CARD can enforce. A process with the user's full privileges can stop CARD or edit its files. Isolation needs a separate OS account or service, which is outside the MVP. |

## Data stored locally

`data/card.db` (evaluations, verdicts, rules, audit chain, observations, evidence cache), `data/keys/audit-ed25519.pem` (signing key) and `data/reviewer.json` (PIN hash). Observations contain tool output, which can include file contents; it never leaves the machine. Keep exports private.
