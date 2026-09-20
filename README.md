# MOSAIC

A local, explainable risk gateway for AI coding-agent artifacts. Packages, skills, MCP servers, and remote URLs share one evaluation workflow and one review queue.

## Run locally

Requires Node.js 22+ and npm.

```sh
npm ci
npm run dev
```

Open http://127.0.0.1:4317. The API listens on loopback port 4318. For a single-server build:

```sh
npm run build
npm start
```

Open http://127.0.0.1:4318. Run `npm run check` for automated tests and the production build.

## MVP scope

- Submit and inspect all four artifact types.
- Get a deterministic 0–100 risk score, a per-signal explanation, and an allow/review/deny decision.
- Include recent activity from the same session in cross-artifact scoring.
- Adjust review and deny thresholds and enable or disable correlation.
- Resolve held requests with a recorded human decision.
- Persist evaluations and export a hash-linked audit trail.
- Replay small synthetic scenarios through the actual evaluation API.

The console includes an interactive session trace, review inbox, searchable paginated request stream, evidence inspector, and a threshold preview. See [the demonstration guide](docs/DEMO.md) for a short walkthrough.

The initial observations and scenarios are **synthetic demonstrations**, not traffic from connected agents or a validated research benchmark. They run locally and never execute submitted artifacts.

## Evaluate from an agent integration

```sh
curl http://127.0.0.1:4318/api/evaluate \
  -H "Content-Type: application/json" \
  -d '{"type":"package","name":"example-library","sessionId":"my-agent-session","metadata":{"exists":true,"ageDays":900,"downloads":100000,"signed":true}}'
```

An integrating caller must submit the request **before** using an artifact, and only proceed when the returned decision is `allow`. A `review` result must pause that operation until a human resolves it. The API supplies decisions; this MVP does not transparently intercept shell commands, MCP traffic, or browser requests.

Request metadata is caller-supplied, not independently verified. Do not trust an untrusted agent to attest its own provenance in a production deployment. The built-in name catalog and content rules are deliberately small and illustrative; a low score is not a guarantee of safety.

## Architecture

```text
React console / cooperating caller
              |
              v
       Local Express API
              |
              v
   Deterministic scoring engine <--- recent session history
              |
              v
      Threshold policy
              |
              v
   JSON store + audit receipts
```

`shared/types.ts` defines the contract. `server/engine.ts` contains the rules. `server/store.ts` owns persistence. `src/` contains the console.

## Limits and next steps

This is a single-user local prototype. Keep it bound to loopback. It has no user authentication, multi-process storage coordination, live registry or reputation feeds, universal agent interception, or production enforcement adapter. Receipts are hash-linked, not cryptographically signed or externally anchored; someone able to rewrite the entire store can recompute them.

The larger brief's 200–500-case incident corpus, external baseline comparisons, learned scoring, paper claims, and integration with multiple coding agents are deferred. No detection-rate or novelty claims are made by this MVP.

Local state lives under `data/` and is excluded from Git. Keep audit exports private if requests contain confidential content.

Verify an exported evaluation chain with `npm run verify:audit -- path/to/mosaic-audit.json`. This detects broken links or changed evaluation contents. It does not authenticate the author, detect a complete rewrite, or verify the separately recorded review and policy events. The rule definitions are documented in [docs/SCORING.md](docs/SCORING.md).
