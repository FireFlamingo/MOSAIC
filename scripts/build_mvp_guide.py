"""Create the checked-in MVP guide. Requires Python 3 and reportlab."""
from pathlib import Path
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfgen import canvas
from reportlab.platypus import Paragraph

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "output" / "pdf" / "MOSAIC-MVP-Guide.pdf"
OUT.parent.mkdir(parents=True, exist_ok=True)
W, H = A4
M = 44
CW = W - 2 * M
INK = colors.HexColor("#171717")
MUTED = colors.HexColor("#656565")
LINE = colors.HexColor("#dedbd7")
PAPER = colors.HexColor("#faf9f7")
ORANGE = colors.HexColor("#ba4a27")
AMBER = colors.HexColor("#9c7022")
RED = colors.HexColor("#a7463a")
WHITE = colors.white
REV = "cd09532012cacbdbe9f588f6ce985cd9a65d9605"
REPO = "https://github.com/FireFlamingo/MOSAIC"
c = canvas.Canvas(str(OUT), pagesize=A4, pageCompression=1)
c.setTitle("MOSAIC | MVP capabilities and roadmap")
c.setAuthor("MOSAIC project")
c.setSubject("Implemented capabilities, operating limits, demonstration guide and final-project plan")


def para(text, x, y, width=CW, size=10.5, leading=15.5, color=INK, bold=False):
    style = ParagraphStyle("p", fontName="Helvetica-Bold" if bold else "Helvetica",
                           fontSize=size, leading=leading, textColor=color, alignment=TA_LEFT)
    p = Paragraph(text, style)
    _, height = p.wrap(width, H)
    if y + height > H - 58:
        raise ValueError(f"Page overflow at {y + height}: {text[:60]}")
    p.drawOn(c, x, H - y - height)
    return y + height


def label(text, x, y, color=ORANGE, size=8):
    c.setFillColor(color)
    c.setFont("Helvetica-Bold", size)
    c.drawString(x, H - y - size, text)


def box(x, y, width, height, fill=PAPER, stroke=None, radius=5):
    c.setFillColor(fill)
    c.setStrokeColor(stroke or fill)
    c.roundRect(x, H - y - height, width, height, radius, fill=1, stroke=bool(stroke))


def line(x1, y1, x2, y2, color=LINE, width=0.7):
    c.setStrokeColor(color)
    c.setLineWidth(width)
    c.line(x1, H - y1, x2, H - y2)


def frame(page, section):
    c.setFillColor(WHITE)
    c.rect(0, 0, W, H, fill=1, stroke=0)
    label("MOSAIC", M, 23, INK, 10)
    label("MVP / CAPABILITIES & ROADMAP", W - 224, 26, MUTED, 7)
    line(M, 45, W - M, 45)
    line(M, H - 43, W - M, H - 43)
    label("21 SEPTEMBER 2026  /  v0.1", M, H - 29, MUTED, 7)
    label(f"{section.upper()}  /  {page:02d}", W - M - 145, H - 29, MUTED, 7)


def chapter(page, section, title, intro):
    frame(page, section)
    label(f"0{page} / {section.upper()}", M, 67)
    end = para(title, M, 85, size=27, leading=31, bold=True)
    return para(intro, M, end + 12, size=10.5, color=MUTED) + 24


def callout(y, heading, text, height=83, dark=False):
    box(M, y, CW, height, INK if dark else PAPER)
    label(heading.upper(), M + 16, y + 14, colors.HexColor("#e9a184") if dark else ORANGE)
    para(text, M + 16, y + 32, CW - 32, 10, 15, WHITE if dark else INK)
    return y + height


def table(y, headers, rows, widths, size=9.6, padding=20):
    x = M
    box(M, y, CW, 29, INK, radius=2)
    for text, width in zip(headers, widths):
        label(text.upper(), x + 10, y + 10, WHITE, 7.3)
        x += width
    y += 29
    for row_num, row in enumerate(rows):
        cells = []
        for index, (text, width) in enumerate(zip(row, widths)):
            style = ParagraphStyle("cell", fontName="Helvetica-Bold" if index == 0 else "Helvetica",
                                   fontSize=size, leading=14, textColor=INK if index == 0 else MUTED)
            p = Paragraph(text, style)
            _, height = p.wrap(width - 20, H)
            cells.append((p, height, width))
        height = max(item[1] for item in cells) + padding
        if y + height > H - 58:
            raise ValueError(f"Table overflow: {row[0]}")
        if row_num % 2 == 0:
            box(M, y, CW, height, PAPER, radius=0)
        x = M
        for p, ph, width in cells:
            p.drawOn(c, x + 10, H - y - padding / 2 - ph)
            x += width
        line(M, y + height, W - M, y + height)
        y += height
    return y


# 1. Overview and the boundary between a decision and its enforcement.
frame(1, "Overview")
label("PROJECT GUIDE / IMPLEMENTED MVP", M, 72)
para("A checkpoint for<br/>AI-agent artifacts.", M, 98, size=36, leading=41, bold=True)
para("MOSAIC scores the external resources an AI coding agent wants to use. It returns a risk score, explains the contributing signals, and recommends allow, review, or deny.", M, 202, size=12, leading=18, color=MUTED)
for i, name in enumerate(["PACKAGES", "SKILLS & RULES", "MCP SERVERS", "REMOTE URLS"]):
    x = M + i * (CW + 9) / 4
    box(x, 277, (CW - 27) / 4, 33, PAPER, LINE)
    label(name, x + 10, 289, INK, 7.5)
label("THE WORKING PATH", M, 339)
stages = [
    ("01", "Submit", "A person or cooperating caller supplies an artifact request."),
    ("02", "Score + explain", "Local rules combine metadata, text and session history."),
    ("03", "Decide + record", "Policy assigns a verdict and stores the evaluation receipt."),
]
sw = (CW - 28) / 3
for i, (num, title, desc) in enumerate(stages):
    x = M + i * (sw + 14)
    box(x, 362, sw, 137, INK)
    label(num, x + 13, 376, colors.HexColor("#e69a76"), 10)
    para(title, x + 13, 400, sw - 26, 12, 16, WHITE, True)
    para(desc, x + 13, 430, sw - 26, 9, 13, colors.HexColor("#cccccc"))
    if i < 2:
        label(">", x + sw + 3, 420, ORANGE, 10)
para("What the MVP demonstrates", M, 528, size=17, leading=22, bold=True)
para("One request format and review workflow across four artifact types. A deterministic score with visible evidence. A concrete example of earlier session activity changing a later decision.", M, 562, size=11, leading=17)
callout(640, "The current boundary", "The gateway supplies decisions. An integrating caller must obey them. This version does not automatically intercept agent commands, installations, MCP calls or network traffic.", 96)
c.showPage()

# 2. Product capabilities in plain language.
y = chapter(2, "Capabilities", "What works today", "The console, API, scoring rules, human review and local persistence are connected. Buttons create and update real stored records.")
y = table(y, ["Artifact type", "What MOSAIC can inspect"], [
    ("Package", "Reported existence, age, downloads, signature and permissions; static text; name similarity against a small built-in package catalog."),
    ("Skill / rules file", "The same supplied metadata plus static instruction-override patterns and related session history."),
    ("MCP server", "Supplied server metadata and manifest-like text. MCP means Model Context Protocol: a way for an agent to call external tools."),
    ("Remote URL", "Local URL parsing, HTTPS use and literal local/private host checks, alongside supplied evidence. No URL is fetched."),
], [116, CW - 116])
y += 24
para("Working controls", M, y, size=17, leading=22, bold=True)
y += 34
y = table(y, ["You can", "Result"], [
    ("Inspect and filter", "Search artifacts or sessions; filter type and verdict; paginate; open the evidence and receipt drawer."),
    ("Follow a session", "Choose a session, inspect its trace, then view its full request list. The trace shows the latest five events."),
    ("Resolve a hold", "Allow or deny a pending review with a required note. The original score and receipt remain unchanged."),
    ("Edit policy", "Save review/deny thresholds, toggle correlation, discard edits and preview a score without recording an evaluation."),
    ("Replay and export", "Run four synthetic workflows through the real API. Download a JSON audit export for offline checking."),
], [116, CW - 116], 9.2)
para("State survives restarts in a local JSON store. A new store starts with 10 synthetic observations. These examples are separate from real connected-agent traffic.", M, y + 17, size=9.4, leading=14, color=MUTED)
c.showPage()

# 3. Scoring and the repeatable correlation example.
y = chapter(3, "Scoring", "From evidence to a decision", "The score is a rule-based triage result from 0 to 100. It is not a probability of compromise or a guarantee that an artifact is safe.")
box(M, y, CW, 67, INK)
para("score = min(100, sum of signal points)", M + 16, y + 15, CW - 32, 15, 20, WHITE, True)
para("Current signal weights are all 1. No model API or API key is required.", M + 16, y + 43, CW - 32, 9, 13, colors.HexColor("#cccccc"))
y += 73
for start, width, title, tint in [(0, .35, "ALLOW  0-34", MUTED), (.35, .35, "REVIEW  35-69", AMBER), (.70, .30, "DENY  70-100", RED)]:
    box(M + CW * start, y, CW * width - 3, 7, tint, radius=0)
    label(title, M + CW * start, y + 16, tint, 8)
label("DEFAULT THRESHOLDS / CHANGES APPLY TO FUTURE EVALUATIONS", M, y + 39, MUTED, 6.9)
y = table(y + 66, ["Example signal", "Points / condition"], [
    ("Existence", "48 if explicitly reported missing; 8 if existence is unspecified."),
    ("Package lookalike", "26 for a close match to a name in the small package catalog."),
    ("Metadata", "10 unsigned; 8 younger than 7 days; 7 with fewer than 50 reported downloads."),
    ("Permissions and text", "Elevated permissions: 8 each, capped at 24. Text indicators add 16-24 points; instruction override adds 22 for skills/MCP."),
    ("URL indicators", "12 non-HTTPS; 20 local/private literal host; 20 for a URL that cannot be parsed."),
    ("Session context", "6 per earlier non-allowed request of another type, capped at 18; another 12 for matching normalized names."),
], [129, CW - 129], 9.1)
y += 22
label("WORKED EXAMPLE / LINKED TRUST SIGNALS", M, y)
y += 24
box(M, y, CW, 112, PAPER)
para("25  +  6  +  12  =  43  /  Review", M + 15, y + 14, CW - 30, 20, 26, INK, True)
para("A skill's reported age, adoption and unsigned status total 25 points. An earlier denied URL in the same session adds 6; the shared name adds 12. Without correlation, the skill scores 25 and is allowed under the default policy.", M + 15, y + 52, CW - 30, 9.5, 14)
para("Context uses the most recent 20 earlier evaluations in the same session and their original policy decisions. Human overrides do not rewrite that scoring history. Full rule details: docs/SCORING.md.", M, y + 125, size=9, leading=13, color=MUTED)
c.showPage()

# 4. A presenter-friendly walkthrough.
y = chapter(4, "Walkthrough", "A short demonstration", "Use the default policy (review 35, deny 70, correlation on) for the expected results below. Every replay creates a fresh session.")
steps = [
    ("Start with a clean request", "Open Replay workflow and choose Known publisher install. The signed package has no configured risk indicators, scores 0 and receives Allow."),
    ("Show why history matters", "Replay Linked trust signals. The URL scores 100 and is denied; the later skill scores 43 and needs review. Open the skill in Session trace to see its individual signals."),
    ("Use the dropdowns and filters", "Choose a different session, then return to the linked session. Select View session to show both records. In Requests, filter by artifact type or decision and search by name or session."),
    ("Make a human decision", "Open Review queue, inspect a pending request and enter a reviewer note. Choose Allow request or Deny request. The queue updates and the recorded override appears in the details."),
    ("Change the decision policy", "Open Policy, edit a threshold or toggle correlation, and save. The preview slider illustrates the boundaries. Replay again to evaluate with the new policy; existing records retain their original scores."),
    ("Evaluate your own input and export", "Choose New evaluation, select one of the four types, and supply a name and session. Add optional metadata, text or permissions. Inspect the result, then download the audit trail."),
]
for i, (title, desc) in enumerate(steps, 1):
    box(M, y, 29, 29, INK)
    label(f"{i:02d}", M + 8, y + 9, WHITE, 9)
    para(title, M + 43, y, CW - 43, 12, 17, INK, True)
    end = para(desc, M + 43, y + 24, CW - 43, 10, 15, MUTED)
    y = end + 25
callout(y, "Useful controls", "Press N for a new evaluation and / to search. Escape closes a dialog. Replay supports arrow keys. If a submission loses connection, Reconnect keeps the draft available.", 82)
c.showPage()

# 5. Honest boundaries.
y = chapter(5, "Limits", "What is not present yet", "The current release is a single-user local prototype. These boundaries explain what a successful demo establishes and what it does not.")
y = table(y, ["Missing capability", "Practical implication"], [
    ("Automatic interception", "No agent wrapper, package-command hook, skill-read hook, MCP proxy or HTTP enforcement proxy is installed. A caller can ignore a verdict."),
    ("Independent evidence", "No live npm/PyPI registry checks, DNS/WHOIS reputation, signature verification or trusted skills/MCP registry. Metadata comes from the submitter."),
    ("Broad analysis", "No semantic prompt-injection classifier, sandbox execution or full package scanner. The catalog and text rules are deliberately small; false positives and false negatives are possible."),
    ("Hallucination database", "No cross-model consensus database or dedicated hallucinated-name detector. Name similarity is only an illustrative package check."),
    ("Signed audit receipts", "Evaluations form a SHA-256 hash chain. They are not signed or externally anchored; someone who rewrites the whole store can recompute the chain."),
    ("Multi-user operations", "No authentication, roles, tenants or reviewer identity. No multi-process database coordination. The server defaults to loopback access."),
    ("Validated research results", "No 200-500-case labeled corpus, baseline comparison, detection-rate measurement, false-positive rate or end-to-end latency benchmark."),
], [135, CW - 135], 9.5)
callout(y + 23, "Audit verification scope", "The export verifier checks original evaluation contents and their links. Review and policy events are recorded separately and are not authenticated by this chain. Exported requests may contain the text supplied by the caller.", 96)
c.showPage()

# 6. Planned final project, tied to observable completion criteria.
y = chapter(6, "Roadmap", "From MVP to the final project", "The original brief describes a larger runtime defense and research evaluation. The items below are planned work, not capabilities already delivered or guaranteed research outcomes.")
phases = [
    ("01", "Connect and enforce", "Add supported coding-agent adapters, package and skill hooks, an MCP proxy and controlled HTTP egress.", "Completion evidence: requests are intercepted before use; deny stops the action; review pauses and resumes it correctly."),
    ("02", "Verify the evidence", "Add registry existence checks, provenance verification, trusted catalogs and URL reputation sources with explicit failure handling.", "Completion evidence: decisions use independently collected evidence, including clear handling of unknown or unavailable results."),
    ("03", "Strengthen scoring and audit", "Expand detectors and cross-artifact signals, add the proposed hallucination-name dataset, and design signed receipts and durable storage.", "Completion evidence: documented signal tests, calibrated thresholds and authenticated audit records. Learned weights remain an optional experiment."),
    ("04", "Build the research evaluation", "Curate the brief's 200-500 labeled cases and benign controls. Compare with Pipelock and mcp-firewall under a reproducible method.", "Completion evidence: detection and false-positive rates, coverage and latency results, plus correlation-on/off ablation and stated limitations."),
    ("05", "Package a usable release", "Document supported agents and deployment, add access controls where needed, publish reproducibility materials and prepare the research report.", "Completion evidence: another team can install, demonstrate and reproduce the reported results from the release instructions."),
]
for num, title, planned, evidence in phases:
    label(num, M, y + 2, ORANGE, 11)
    para(title, M + 35, y, CW - 35, 13, 17, INK, True)
    end = para(planned, M + 35, y + 25, CW - 35, 10, 14.5)
    end = para(evidence, M + 35, end + 7, CW - 35, 9.3, 13.5, MUTED)
    line(M + 35, end + 15, W - M, end + 15)
    y = end + 25
para("Research claims such as novelty or superiority need a current literature review and measured evidence. The MVP does not establish those claims.", M, y, size=9.4, leading=14, color=MUTED)
c.showPage()

# 7. Operational reference and validation provenance.
y = chapter(7, "Reference", "Run, integrate and verify", "The current implementation uses React + TypeScript for the console and an Express API with a local JSON store. Use Node.js 22 or newer.")
box(M, y, CW, 80, INK)
for i, command in enumerate(["npm ci", "npm run build", "npm start"]):
    c.setFont("Courier", 10)
    c.setFillColor(WHITE)
    c.drawString(M + 16, H - y - 22 - i * 21, command)
y += 89
y = para("Open <b>http://127.0.0.1:4318</b>. For development, <b>npm run dev</b> opens the console on 4317 with the API on 4318. User data lives in <b>data/</b> and is excluded from Git.", M, y, size=9.7, leading=14.5) + 22
y = table(y, ["API route", "Purpose"], [
    ("GET /api/state", "Evaluations, active policy and replay choices."),
    ("POST /api/evaluate", "Submit type, name, sessionId and optional source, content and metadata; receive score, signals, decision and receipt."),
    ("POST /api/reviews/:id", "Resolve a pending hold with an allow/deny decision and a note."),
    ("PATCH /api/policy", "Save reviewThreshold, denyThreshold and correlationEnabled."),
    ("POST /api/scenarios/:id/run", "Record a synthetic workflow in a new session."),
    ("GET /api/export", "Download evaluations, policy and audit events as JSON."),
], [169, CW - 169], 8.8, padding=14)
y += 20
y = callout(y, "Verified for this revision", "21 Playwright browser tests and 18 engine/API/audit tests pass locally. Coverage includes dropdowns, all artifact forms, reviews, policy persistence, filtering, keyboard use, mobile layout, downloads and recovery from connection failures. Browser tests use isolated temporary stores.", 106)
y += 16
y = para("<b>Run checks:</b> npm run check; npm run test:browser.<br/><b>Verify an export:</b> npm run verify:audit -- path/to/mosaic-audit.json.<br/>Windows browser tests use installed Edge; other platforms require Playwright Chromium. See README.md for setup.", M, y, size=9, leading=13.5) + 17
y = para(f'<b>Implementation:</b> <link href="{REPO}/tree/{REV}" color="#ba4a27">FireFlamingo/MOSAIC, revision cd09532</link>. Details: README.md, docs/MVP.md, docs/SCORING.md, server/engine.ts and tests/browser/.<br/><b>Planning source:</b> supplied agent-firewall-brief.pdf, v1.0, especially sections 5 and 8. Planned research claims are not independently verified by this guide.', M, y, size=8.2, leading=12, color=MUTED)
c.showPage()
c.save()
print(OUT)
