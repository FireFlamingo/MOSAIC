"""Plot output/performance/results.json (from `npm run bench`). Requires Python 3 and matplotlib."""
import json
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
from matplotlib.ticker import FuncFormatter

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "output" / "performance"
data = json.loads((OUT / "results.json").read_text(encoding="utf8"))

INK = "#171717"
TEXT = "#3d3d3d"
MUTED = "#6f6f6f"
GRID = "#e4e2de"
NEUTRAL = "#8c8a85"
ACCENT = "#b5452a"

plt.rcParams.update({
    "font.family": ["Arial", "DejaVu Sans"],
    "font.size": 9,
    "text.color": TEXT,
    "axes.edgecolor": "#bdbab5",
    "axes.labelcolor": TEXT,
    "axes.linewidth": 0.8,
    "axes.spines.top": False,
    "axes.spines.right": False,
    "xtick.color": MUTED,
    "ytick.color": MUTED,
    "xtick.major.size": 3,
    "ytick.major.size": 0,
    "xtick.major.width": 0.8,
    "svg.fonttype": "none",
    "pdf.fonttype": 42,
})


def panel_title(ax, letter, title, note, x=None):
    """Title and note above the axes, starting at figure x (defaults to the axes' left edge)."""
    box = ax.get_position()
    x = box.x0 if x is None else x
    ax.figure.text(x, box.y1 + 0.047, f"({letter})  {title}", fontsize=10, fontweight="bold", color=INK)
    ax.figure.text(x, box.y1 + 0.018, note, fontsize=8.5, color=MUTED)


def hgrid(ax, axis="y"):
    ax.grid(axis=axis, color=GRID, linewidth=0.8)
    ax.set_axisbelow(True)


fig = plt.figure(figsize=(10, 7.4), dpi=200)
top_row = fig.add_gridspec(1, 2, width_ratios=[1, 1.15], wspace=0.3, left=0.105, right=0.955, top=0.815, bottom=0.53)
bottom_row = fig.add_gridspec(1, 1, left=0.255, right=0.955, top=0.36, bottom=0.115)

fig.text(0.03, 0.955, "CARD evaluation performance", fontsize=13, fontweight="bold", color=INK)
fig.text(0.03, 0.922, "Local measurements of the scoring engine and the /api/evaluate endpoint", fontsize=9.5, color=MUTED)

# (a) Scoring engine latency per artifact type
ax = fig.add_subplot(top_row[0, 0])
labels = {"package": "Package", "skill": "Skill", "mcp": "MCP server", "url": "URL"}
order = ["url", "mcp", "skill", "package"]
engine = data["engine"]
y = np.arange(len(order))
p50 = np.array([engine[k]["p50"] for k in order]) * 1000
p95 = np.array([engine[k]["p95"] for k in order]) * 1000
p99 = np.array([engine[k]["p99"] for k in order]) * 1000
ax.hlines(y, p50, p99, color=NEUTRAL, linewidth=1.2, zorder=2)
ax.scatter(p95, y, marker="|", s=60, color=NEUTRAL, linewidths=1.2, zorder=3, label="95th percentile")
ax.scatter(p99, y, s=34, facecolor="white", edgecolor=INK, linewidth=1.2, zorder=4, label="99th percentile")
ax.scatter(p50, y, s=40, color=INK, edgecolor="white", linewidth=1.2, zorder=5, label="Median")
ax.set_xscale("log")
ax.set_xlim(0.5, 1000)
ax.xaxis.set_major_formatter(FuncFormatter(lambda v, _: f"{v:g}"))
ax.set_yticks(y, [labels[k] for k in order])
ax.tick_params(axis="y", labelsize=9, labelcolor=TEXT)
ax.set_ylim(-0.6, len(order) - 0.4)
ax.set_xlabel("Time per evaluation (µs, log scale)")
hgrid(ax, "x")
ax.spines["left"].set_visible(False)
pkg = order.index("package")
ax.text(p99[pkg] * 1.3, pkg, "edit-distance check\nagainst package catalog", fontsize=7.6, color=MUTED,
        va="center", linespacing=1.15)
ax.legend(loc="lower right", frameon=False, fontsize=8, handletextpad=0.3, borderaxespad=0.1)
panel_title(ax, "a", "Scoring engine", f"evaluateRisk() alone, empty session history, {data['method']['engineRunsPerType']:,} runs per type", x=0.03)

# (b) End-to-end latency against store size
ax = fig.add_subplot(top_row[0, 1])
bins = data["endToEnd"]["bins"]
size = np.array([b["storeSize"] for b in bins])
med = np.array([b["p50"] for b in bins])
hi = np.array([b["p95"] for b in bins])
ax.fill_between(size, med, hi, color=INK, alpha=0.09, linewidth=0, label="Median to 95th percentile")
ax.plot(size, med, color=INK, linewidth=1.6, solid_capstyle="round", label="Median")
ax.scatter([size[-1]], [med[-1]], s=30, color=INK, edgecolor="white", linewidth=1.2, zorder=4)
ax.annotate(f"{med[-1]:.0f} ms", xy=(size[-1], med[-1]), xytext=(6, 0), textcoords="offset points",
            fontsize=8.5, color=INK, va="center", fontweight="bold")
slope = np.polyfit(size, med, 1)[0] * 1000
ax.text(0.03, 0.93, f"Median grows ≈ {slope:.1f} ms per 1,000 stored records",
        transform=ax.transAxes, fontsize=8, color=MUTED, va="top")
store_size = data["method"]["storeSize"]
ax.set_xlim(0, store_size * 1.08)
ax.set_ylim(0, max(hi.max(), med.max()) * 1.12)
ax.xaxis.set_major_formatter(FuncFormatter(lambda v, _: f"{v:,.0f}"))
ax.set_xlabel("Evaluations already in the store")
ax.set_ylabel("Request latency (ms)")
hgrid(ax)
ax.legend(loc="lower right", frameon=False, fontsize=8, handlelength=1.6)
panel_title(ax, "b", "POST /api/evaluate", f"{store_size:,} sequential requests over loopback, binned every {data['method']['binSize']}")

# (c) Breakdown of one request at the final store size
ax = fig.add_subplot(bottom_row[0, 0])
brk = data["breakdown"]
steps = sorted(brk["stepsP50Ms"].items(), key=lambda kv: kv[1])
names = [k for k, _ in steps]
values = np.array([v for _, v in steps])
total = values.sum()
colors = [NEUTRAL] * len(values)
colors[-1] = ACCENT
ax.barh(np.arange(len(values)), values, height=0.56, color=colors, zorder=3)
for i, v in enumerate(values):
    label = f"{v:.1f} ms" if v >= 0.1 else f"{v * 1000:.0f} µs"
    share = "<1%" if v / total < 0.01 else f"{v / total:.0%}"
    ax.text(v + total * 0.006, i, f"{label}   {share}" if v >= 0.1 else label,
            va="center", fontsize=8.3, color=INK if i == len(values) - 1 else TEXT)
ax.set_yticks(np.arange(len(values)), names)
ax.tick_params(axis="y", labelsize=8.8, labelcolor=TEXT)
ax.set_xlim(0, values.max() * 1.2)
ax.set_xlabel("Median time per request (ms)")
ax.spines["left"].set_visible(False)
hgrid(ax, "x")
panel_title(ax, "c", f"Where the time goes at {brk['storeSize']:,} stored evaluations",
            f"Median of each step timed in isolation; state file {brk['stateBytes'] / 2**20:.1f} MB. Percentages are of the summed steps.", x=0.03)

env = data["environment"]
fig.text(0.03, 0.022,
         f"Measured {data['generatedAt'][:10]} on {env['cpu']} ({env['cores']} threads, {env['memoryGb']} GB), "
         f"Node {env['node']}, {env['platform']}. Synthetic inputs, one request in flight, warm process.\n"
         "Reproduce with npm run bench, then python scripts/plot_performance.py.",
         fontsize=7.3, color=MUTED, linespacing=1.5)

for ext in ("png", "svg", "pdf"):
    fig.savefig(OUT / f"card-performance.{ext}", facecolor="white")
print(f"Wrote {OUT / 'card-performance.png'}")
