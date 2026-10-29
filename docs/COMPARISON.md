# CARD compared with existing open-source agent firewalls (RQ5)

**Status: coverage comparison from each project's own documentation. The tools were not executed against the CARD benchmark**, so this document gives no detection numbers for them. Pipelock v3.7.1 was downloaded and its checksum verified, but running a downloaded third-party binary was blocked by this machine's execution policy pending explicit approval. See "How to run the comparison" below.

Documentation checked 29 October 2026:
- Pipelock: [github.com/pipelab-org/pipelock](https://github.com/pipelab-org/pipelock), formerly luckyPipewrench/pipelock. v3.7.1; Apache-2.0 core, enterprise features under the Elastic License 2.0.
- mcp-firewall: [github.com/ressl/mcp-firewall](https://github.com/ressl/mcp-firewall). v0.2.0a1 prerelease; AGPL-3.0.

"mcp-firewall" is the name of several unrelated projects (ressl, evalops, defi0x1 and others). The project brief describes "8 inbound + 4 outbound checks"; ressl's documents 7 inbound stages and 2 outbound scanners, so the brief may refer to an earlier version or another project.

## What each tool inspects

| Capability | CARD | Pipelock | mcp-firewall (ressl) |
|---|---|---|---|
| Package installs (npm, PyPI) before they run | Yes: hook, plus a registry proxy for indirect installs | Not documented | No |
| Registry evidence (existence, takedowns, provenance) | Yes | Not documented | No |
| Typosquat, hallucinated-name and lookalike checks | Yes (packages, MCP names, domains) | Not documented | No |
| URL fetches: SSRF and private addresses | Yes, including DNS resolution to private addresses | Yes (SSRF protection on HTTP traffic) | Yes (egress control on MCP tool calls) |
| Content of HTTP responses (exfiltration, injection) | No (only records what tools returned, for Layer 2) | Yes: responses, request bodies, WebSocket, TLS-intercepted tunnels | No |
| Skill / instruction files | Yes, at session start and on read | Yes (`pipelock skill-scan`) | No |
| MCP tool descriptions (tool poisoning, rug pull) | Yes, via the MCP proxy; changes after trust are held | Yes, in `pipelock mcp proxy` | Injection detection on tool calls |
| MCP tool arguments and responses (secrets, PII) | No | Yes | Yes (secret and PII scanners) |
| Cross-artifact correlation across types | Yes (session history and Layer 2 content tracing) | Not documented | Dangerous tool-call sequences within MCP ("chain detector") |
| Human review with remembered trust / block | Yes (reviewer PIN, trust per exact version, blocks) | Not documented | Optional human approval |
| Audit evidence | Hash-chained, Ed25519-signed log inside CARD | Mediator-signed action receipts | Audit logging |
| Integration with coding agents | Claude Code and Codex hooks, MCP proxy, registry proxy | Claude Code, Codex, Cursor, Cline and others | Any MCP client |

## How to read this

- CARD's distinct contribution is **pre-execution vetting of all four artifact types under one score**, with registry evidence, cross-artifact correlation and a human loop. That is the gap the synopsis names.
- Pipelock is stronger at **traffic-level inspection**: data-loss prevention in requests and responses, TLS interception, WebSocket/A2A and media scanning. CARD does none of this. The tools are complementary more than competing.
- mcp-firewall focuses on **MCP tool-call policy** and response scanning, a narrower scope than either.
- "Not documented" means the documentation did not mention the capability; it does not prove the tool lacks it.

## How to run the comparison (needs your approval to execute Pipelock)

Pipelock documents command-line checks that match parts of the benchmark:

```text
pipelock check --config <file> --url <url>        # URL scenarios (A4, A5, A6, A7, B3, B8)
pipelock skill-scan <path>                         # instruction-file scenarios (A8, B4)
pipelock explain mcp-response <file>               # MCP description scenarios (A9, B5)
```

A fair comparison runs each tool only on the scenarios it claims to inspect, and reports coverage and detection separately. Package scenarios (A1, A2, A3, A11) have no documented Pipelock equivalent and count as "not covered", not as missed.
