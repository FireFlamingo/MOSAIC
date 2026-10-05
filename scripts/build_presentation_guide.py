"""Build the plain black-and-white presentation PDF from docs/PRESENTATION.md.

Requires reportlab. Uses only text: no tables, illustrations or decorative shapes.
"""
import re
import sys
from pathlib import Path
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.platypus import PageBreak, Paragraph, SimpleDocTemplate, Spacer

ROOT = Path(__file__).resolve().parents[1]

body = ParagraphStyle("body", fontName="Helvetica", fontSize=10.6, leading=15,
                      textColor=colors.black, spaceAfter=9)
title = ParagraphStyle("title", parent=body, fontName="Helvetica-Bold", fontSize=18,
                       leading=23, spaceAfter=16, keepWithNext=True)
heading = ParagraphStyle("heading", parent=body, fontName="Helvetica-Bold", fontSize=12,
                         leading=17, spaceBefore=7, spaceAfter=8, keepWithNext=True)
code = ParagraphStyle("code", parent=body, fontName="Courier", fontSize=9,
                      leading=13, leftIndent=10, spaceAfter=6)
item = ParagraphStyle("item", parent=body, leftIndent=13, firstLineIndent=-13, spaceAfter=6)


def inline(text):
    text = escape(text)
    def link(match):
        value = match.group(0)
        url = value.rstrip(".,;")
        return f'<link href="{url}" color="#000000">{url}</link>' + value[len(url):]
    text = re.sub(r"https?://[^\s<>]+", link, text)
    return re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", text)


def build_guide(source_path, output_path, label):
    output_path.parent.mkdir(parents=True, exist_ok=True)

    def footer(canvas, doc):
        canvas.saveState()
        canvas.setFillColor(colors.black)
        canvas.setFont("Helvetica", 9)
        canvas.drawString(48, 28, label)
        canvas.drawRightString(A4[0] - 48, 28, str(doc.page))
        canvas.restoreState()

    story = []
    in_code = False
    for line in source_path.read_text(encoding="utf-8").splitlines():
        if line.startswith("```"):
            in_code = not in_code
            if not in_code:
                story.append(Spacer(1, 4))
        elif not line.strip():
            continue
        elif line == "<!-- page -->":
            story.append(PageBreak())
        elif in_code:
            story.append(Paragraph(escape(line), code))
        elif line.startswith("# "):
            story.append(Paragraph(inline(line[2:]), title))
        elif line.startswith(("## ", "### ")):
            story.append(Paragraph(inline(line.split(" ", 1)[1]), heading))
        else:
            story.append(Paragraph(inline(line), item if re.match(r"^\d+\. ", line) else body))

    doc = SimpleDocTemplate(str(output_path), pagesize=A4, rightMargin=48, leftMargin=48,
                            topMargin=42, bottomMargin=46, title=label,
                            author="MOSAIC project", subject="Normalized weighted scoring v3 and presentation documentation")
    doc.build(story, onFirstPage=footer, onLaterPages=footer)
    print(output_path)


if __name__ == "__main__":
    if "--scoring" in sys.argv:
        build_guide(ROOT / "docs" / "SCORING-RATIONALE.md", ROOT / "output" / "pdf" / "MOSAIC-Scoring-Rationale.pdf", "MOSAIC - Scoring rationale")
    else:
        build_guide(ROOT / "docs" / "PRESENTATION.md", ROOT / "output" / "pdf" / "MOSAIC-Presentation-Guide.pdf", "MOSAIC - Presentation guide")
