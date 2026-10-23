"""Build the current plain text MVP guide. Requires Python 3 and reportlab."""
from build_presentation_guide import ROOT, build_guide

if __name__ == "__main__":
    build_guide(ROOT / "docs" / "MVP-GUIDE.md", ROOT / "output" / "pdf" / "CARD-MVP-Guide.pdf", "CARD - MVP capabilities and roadmap")
