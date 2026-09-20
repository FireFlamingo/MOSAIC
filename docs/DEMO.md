# Present the MVP

Start with `npm run build` and `npm start`, then open http://127.0.0.1:4318.

1. **Overview:** Explain that the stored observations are synthetic fixtures evaluated by the real local scoring engine. Counts and the stream come from persisted data.
2. **Replay workflow → Linked trust signals:** The session trace shows a URL request followed by a skill request. With default thresholds, the URL scores 100 and is denied. The skill scores 43 and needs review; 18 of its points come from session correlation and name reuse. Click the skill node to inspect those contributions.
3. **Review inbox:** Inspect a held request, enter a reason, then allow or deny it. The decision updates in the stream; the original assessment remains in its receipt.
4. **Policy:** Try the score slider. The preview shows where allow, review, and deny boundaries apply without recording an evaluation. Change a threshold, save it, and replay a workflow to see the new policy used.
5. **New evaluation:** Submit a package, skill, MCP server, or URL. Optional content and permissions appear under the expandable evidence section. The gateway only inspects supplied information; it never executes the artifact.
6. **Export audit trail:** Download persisted records. Verify original evaluation receipts with `npm run verify:audit -- path/to/mosaic-audit.json`.

Use **View session** to filter the request stream to that session. The table also supports artifact types, decisions, search, and pagination. Press `/` to focus search and `N` to open a new evaluation; Escape closes dialogs. Refresh in the header loads evaluations made by external API callers.

The MVP is a cooperating-caller gateway, not a transparent agent interceptor. Reputation data is supplied by the caller. The fixtures are not a research benchmark, and hash receipts are not digital signatures.
