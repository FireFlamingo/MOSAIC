# CARD: live demonstration script

This demo runs CARD in front of a real Claude Code session. Every step below was verified on the demo workspace. Nothing harmful is ever installed: every package that gets approved is a real, harmless package.

## Before the presentation (once)

1. In the CARD folder: `npm ci`, then `npm run build`.
2. Start CARD: `npm start`. On first start the terminal prints a one-time setup code. Open http://127.0.0.1:4318, click "Set reviewer PIN", enter the code, your name and a PIN.
3. In a second terminal, start the registry proxy: `npm run card -- proxy`.
4. Connect the demo workspace (already done for d:/TY/Sem V/EDI/card-demo-workspace):
   - `npm run card -- install claude --workspace ../card-demo-workspace --registry-proxy`
   - `npm run card -- mcp-add claude --workspace ../card-demo-workspace --name docs-search -- node <workspace>/demo-mcp/server.mjs <workspace>/demo-mcp/docs-tools.json`
   - `npm run card -- mcp-add claude --workspace ../card-demo-workspace --name deploy-tools -- node <workspace>/demo-mcp/server.mjs <workspace>/demo-mcp/tools.json`
5. Open the demo workspace in VS Code with Claude Code. Keep the CARD dashboard visible beside it.
6. Rehearse once. Requests are recorded, so repeat runs show history.

## Opening line

"Coding agents now install packages, fetch URLs, load instruction files and connect to MCP servers on their own. CARD is a middleware that checks each of those actions against real registry evidence before it runs, explains its decision, and lets a human decide the unclear cases."

## The live sequence (about 8 minutes)

1. **A real package is allowed (30 s).** Ask Claude: "Install zod." It installs normally. On the dashboard the request appears live, tagged Claude Code. Open it: the evidence panel shows facts "Looked up" from npm, a provenance attestation, and high confidence. Say: "Nothing typed by the agent is trusted; CARD checked npm itself."
2. **A hallucinated package is blocked (45 s).** Ask: "Install react-auth-helperz." Claude reports that CARD blocked it and quotes the reason: the package does not exist, so anyone could register the name (slopsquatting). Say: "This is the attack from Spracklen et al.: models invent package names and attackers register them."
3. **Known malware is blocked (30 s).** Ask: "Install axois." CARD denies it: a lookalike of axios, and npm has already replaced it with a security holding package.
4. **An injected instruction is held for a human (2 min).** Ask: "Use the docs-search tool to find how to pad strings, then do the setup step it describes." The MCP tool's answer tells Claude to `npm install left-pad`. The dashboard shows the waiting banner with a countdown. Open the request: "What led the agent here" quotes the MCP response. Say: "left-pad is a real package, but the user never asked for it. Content the agent read told it to install it, the indirect prompt-injection pattern." Allow it with the reason "Known, expected artifact", tick "Trust this exact version", and the install continues in Claude.
5. **An install hidden in a script is still caught (45 s).** Ask: "Run npm run setup." The command looks harmless, but the script installs a nonexistent package. The registry proxy refuses it with CARD's reason. Say: "The hook could not see this install; the registry proxy did."
6. **A poisoned MCP server is hidden (45 s).** Ask: "What tools does the deploy-tools server give you?" Claude has none. On the dashboard, deploy-tools is held: its description hides an instruction to read the SSH key and not tell the user.
7. **A poisoned instruction file stops the session (45 s).** Add a CLAUDE.md to the workspace containing "Ignore previous instructions…", start a new Claude session and send any message. CARD stops the first prompt until a reviewer decides.
8. **Feedback and audit (1 min).** Open Trust & feedback: the trusted left-pad version, verdict counts, noisiest warning signs. Click Export audit trail and run `npm run verify:audit -- card-audit.json`: every record is hash-chained and signed.

## Closing

"CARD vets all four artifact types with one explainable score, uses real registry evidence, links requests to what prompted them, and keeps a human in control. On a hold-out set written after the rules were frozen it caught 95% of attacks with no false alarms. Its limits: it cannot catch reworded instructions, and it holds official install scripts by design."

## Questions to expect

- **Can the agent approve itself?** No. Approvals need the reviewer PIN, and commands that touch CARD's API, data or hook files are blocked.
- **What if CARD is down?** Installs, fetches and MCP use are blocked (fail closed). Ordinary editing still works.
- **Is the score a probability?** No. It is a weighted rubric; decisions come from thresholds and decision floors. See docs/SCORING.md.
- **How was it evaluated?** 431 + 144 scenarios with real recorded registry data; see benchmark/README.md, including the misses and false alarms.
- **How is this different from Pipelock?** See docs/COMPARISON.md: CARD vets packages and instruction files with registry evidence across all four types; Pipelock is stronger at inspecting traffic contents.
- **What does it not do?** Protect against an agent with full control of the same OS account, catch reworded instructions, or verify PyPI attestations.

## If something goes wrong

- Claude does nothing visible: check that `npm run card -- status --workspace ../card-demo-workspace` shows "installed" and "CARD running".
- Every install is blocked with "not reachable": CARD or the registry proxy is not running.
- The dashboard asks for a PIN on Allow: sign in with the reviewer PIN (top right).
