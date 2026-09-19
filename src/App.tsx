import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownToLine,
  Boxes,
  Check,
  ChevronRight,
  CircleAlert,
  ClipboardCheck,
  FileSearch,
  KeyRound,
  Menu,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  X,
} from "lucide-react";
import type {
  AppState,
  ArtifactRequest,
  ArtifactType,
  Decision,
  Evaluation,
  Policy,
  Scenario,
} from "../shared/types";

const typeIcons: Record<ArtifactType, string> = {
  package: "PKG",
  skill: "SKL",
  mcp: "MCP",
  url: "URL",
};
const nav = [
  { label: "Overview", icon: Boxes },
  { label: "Requests", icon: FileSearch },
  { label: "Review queue", icon: ClipboardCheck },
  { label: "Policy", icon: Settings2 },
];

const tone = (d: Decision) => `badge ${d}`;
function date(t: string) {
  return new Intl.DateTimeFormat("en", {
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
    day: "numeric",
  }).format(new Date(t));
}
export default function App() {
  const [state, setState] = useState<AppState>({
      evaluations: [],
      policy: {
        reviewThreshold: 45,
        denyThreshold: 72,
        correlationEnabled: true,
      },
      scenarios: [],
    }),
    [loading, setLoading] = useState(true),
    [toast, setToast] = useState(""),
    [active, setActive] = useState("Overview");
  const [query, setQuery] = useState(""),
    [type, setType] = useState("all"),
    [decision, setDecision] = useState("all"),
    [selected, setSelected] = useState<Evaluation | null>(null),
    [modal, setModal] = useState(false),
    [menu, setMenu] = useState(false),
    [mobile, setMobile] = useState(false);
  const [policy, setPolicy] = useState<Policy>({
    reviewThreshold: 45,
    denyThreshold: 72,
    correlationEnabled: true,
  });
  const [online, setOnline] = useState(false),
    [busy, setBusy] = useState(false);
  const dialog = useRef<HTMLDivElement>(null),
    drawer = useRef<HTMLElement>(null),
    opener = useRef<HTMLElement | null>(null);
  const loadState = () => {
    setLoading(true);
    fetch("/api/state")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d: AppState) => {
        setState({
          ...d,
          evaluations: [...d.evaluations].sort(
            (a, b) => +new Date(b.timestamp) - +new Date(a.timestamp),
          ),
        });
        setPolicy(d.policy);
        setOnline(true);
      })
      .catch(() => {
        setOnline(false);
        setToast(
          "Local evaluation gateway is offline. No observations are shown.",
        );
      })
      .finally(() => setLoading(false));
  };
  useEffect(loadState, []);
  useEffect(() => {
    if (toast) {
      const x = setTimeout(() => setToast(""), 4500);
      return () => clearTimeout(x);
    }
  }, [toast]);
  useEffect(() => {
    if (!modal && !selected) {
      opener.current?.focus();
      return;
    }
    const box = modal ? dialog.current : drawer.current;
    box?.focus();
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setModal(false);
        setSelected(null);
      }
      if (e.key === "Tab" && box) {
        const items = [
          ...box.querySelectorAll<HTMLElement>(
            'button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])',
          ),
        ].filter((x) => !x.hasAttribute("disabled"));
        if (items.length) {
          const first = items[0],
            last = items[items.length - 1];
          if (e.shiftKey && (document.activeElement === first || document.activeElement === box)) {
            e.preventDefault();
            last.focus();
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    };
    addEventListener("keydown", h);
    return () => removeEventListener("keydown", h);
  }, [modal, selected]);
  const resolved = (e: Evaluation): Decision =>
    e.review?.decision || e.decision;
  const items = useMemo(
    () =>
      state.evaluations.filter(
        (e) =>
          (type === "all" || e.request.type === type) &&
          (decision === "all" || resolved(e) === decision) &&
          (active !== "Review queue" || resolved(e) === "review") &&
          `${e.request.name} ${e.request.source ?? ''} ${e.request.sessionId}`
            .toLowerCase()
            .includes(query.toLowerCase()),
      ),
    [state, query, type, decision, active],
  );
  const reviews = state.evaluations.filter(
      (e) => resolved(e) === "review",
    ).length,
    counts = (d: Decision) =>
      state.evaluations.filter((e) => resolved(e) === d).length;
  async function call(url: string, opts?: RequestInit) {
    if (!online) {
      setToast("The local evaluation gateway is offline.");
      return null;
    }
    setBusy(true);
    try {
      const r = await fetch(url, {
        headers: { "Content-Type": "application/json" },
        ...opts,
      });
      if (!r.ok) {
        const detail = await r.json().catch(() => null);
        setToast(detail?.error || `Request failed (${r.status}).`);
        return null;
      }
      return r;
    } catch {
      setOnline(false);
      setToast("The local gateway did not accept that request.");
      return null;
    } finally {
      setBusy(false);
    }
  }
  async function review(decision: "allow" | "deny") {
    if (!selected) return;
    const note =
      (
        document.getElementById("review-note") as HTMLTextAreaElement
      )?.value.trim() || "";
    if (!note) {
      setToast("A reviewer note is required.");
      return;
    }
    const r = await call(`/api/reviews/${selected.id}`, {
      method: "POST",
      body: JSON.stringify({ decision, note }),
    });
    if (r) {
      const updated = await r.json();
      setState((s) => ({
        ...s,
        evaluations: s.evaluations.map((e) =>
          e.id === updated.id ? updated : e,
        ),
      }));
      setSelected(updated);
      setToast("Review decision recorded.");
    }
  }
  async function savePolicy() {
    if (policy.reviewThreshold >= policy.denyThreshold) {
      setToast("The review threshold must be lower than the deny threshold.");
      return;
    }
    const r = await call("/api/policy", {
      method: "PATCH",
      body: JSON.stringify(policy),
    });
    if (r) {
      setState((s) => ({ ...s, policy }));
      setToast("Policy saved to local gateway.");
    }
  }
  async function run(s: Scenario) {
    setMenu(false);
    const r = await call(`/api/scenarios/${s.id}/run`, { method: "POST" });
    if (r) {
      const d: Evaluation[] = await r.json();
      setState((x) => ({
        ...x,
        evaluations: [...d, ...x.evaluations].sort(
          (a, b) => +new Date(b.timestamp) - +new Date(a.timestamp),
        ),
      }));
      setToast(`Scenario “${s.title}” evaluated.`);
    }
  }
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const source = String(f.get("source") || "").trim();
    const request = {
      type: f.get("type"),
      name: f.get("name"),
      sessionId: f.get("session"),
      content: f.get("content") || undefined,
      metadata: {
        exists:
          f.get("exists") === "unknown"
            ? undefined
            : f.get("exists") === "true",
        signed:
          f.get("signed") === "unknown"
            ? undefined
            : f.get("signed") === "true",
        ageDays: f.get("age") ? Number(f.get("age")) : undefined,
        downloads: f.get("downloads") ? Number(f.get("downloads")) : undefined,
      },
      ...(source ? { source } : {}),
    } as ArtifactRequest;
    const r = await call("/api/evaluate", {
      method: "POST",
      body: JSON.stringify(request),
    });
    if (r) {
      const ev = await r.json();
      setState((s) => ({
        ...s,
        evaluations: [ev, ...s.evaluations].sort(
          (a, b) => +new Date(b.timestamp) - +new Date(a.timestamp),
        ),
      }));
      setModal(false);
      setSelected(ev);
      setToast("Artifact evaluated locally.");
    }
  }
  async function exportAudit() {
    const r = await call("/api/export");
    if (r) {
      const data = await r.text(),
        a = document.createElement("a");
      a.href = URL.createObjectURL(
        new Blob([data], { type: "application/json" }),
      );
      a.download = "mosaic-audit.json";
      a.click();
      URL.revokeObjectURL(a.href);
    }
  }
  return (
    <div className="app-shell">
      <aside className={mobile ? "sidebar open" : "sidebar"}>
        <div className="brand">
          <i className="mark">
            <b />
            <b />
            <b />
            <b />
          </i>
          <span>MOSAIC</span>
          <button
            aria-label="Close navigation"
            className="mobile-close"
            onClick={() => setMobile(false)}
          >
            <X size={18} />
          </button>
        </div>
        <div className="workspace">
          <span>WORKSPACE</span>
          <strong>Local evaluation</strong>
          <em className={online ? "gateway online" : "gateway"}>
            <span />
            {online ? "Gateway online" : "Gateway offline"}
          </em>
        </div>
        <nav>
          {nav.map((n) => (
            <button
              key={n.label}
              className={active === n.label ? "nav active" : "nav"}
              onClick={() => {
                setActive(n.label);
                setQuery("");
                setType("all");
                setDecision("all");
                setMobile(false);
              }}
            >
              <n.icon size={18} />
              {n.label}
              {n.label === "Review queue" && reviews > 0 && (
                <small>{reviews}</small>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div className="hash">
            <ShieldCheck size={17} />
            <span>
              Hash-linked
              <br />
              <strong>local receipts</strong>
            </span>
          </div>
          <button disabled={!online || busy} onClick={exportAudit}>
            <ArrowDownToLine size={17} />
            Export audit
          </button>
        </div>
      </aside>
      {toast && (
        <div className="toast" role="status">
          <CircleAlert size={17} />
          {toast}
          {!online && <button onClick={loadState}>Retry</button>}
          <button
            aria-label="Dismiss notification"
            onClick={() => setToast("")}
          >
            <X size={16} />
          </button>
        </div>
      )}
      <main>
        <header>
          <button
            aria-label="Open navigation"
            className="hamburger"
            onClick={() => setMobile(true)}
          >
            <Menu />
          </button>
          <div className="crumb">
            <span>WORKSPACE</span>
            <ChevronRight size={14} />
            <strong>LOCAL</strong>
          </div>
          <div className="header-right">
            <span className={online ? "local-dot online" : "local-dot"}>
              <i />
              {online ? "Gateway online" : "Gateway offline"}
            </span>
            <button
              className="refresh-btn"
              aria-label="Refresh gateway state"
              title="Refresh observations and gateway status"
              disabled={loading || busy}
              onClick={loadState}
            >
              <RefreshCw size={18} />
            </button>
            <button
              className="icon-btn"
              aria-label="Open policy settings"
              onClick={() => setActive("Policy")}
            >
              <Settings2 size={19} />
            </button>
            <span className="avatar" aria-label="Local workspace">
              AF
            </span>
          </div>
        </header>
        {active !== "Policy" && (
          <>
            <section className="hero">
              <div>
                <p className="eyebrow">
                  {active.toUpperCase()} <span>·</span> SYNTHETIC DEMO DATA
                </p>
                <h1>
                  {active === "Overview" ? (
                    <>
                      Every artifact.
                      <br />
                      One checkpoint.
                    </>
                  ) : active === "Requests" ? (
                    "Artifact requests"
                  ) : (
                    "Human review queue"
                  )}
                </h1>
                <p className="lede">
                  Inspect packages, skills, MCP tools, and remote URLs before
                  they enter an agent session.
                </p>
              </div>
              <div className="hero-actions">
                <div className="scenario">
                  <button
                    disabled={!online || busy}
                    onClick={() => setMenu(!menu)}
                  >
                    <Sparkles size={17} />
                    Run scenario
                    <ChevronRight size={15} />
                  </button>
                  {menu && (
                    <div className="scenario-menu">
                      {state.scenarios.map((s) => (
                        <button
                          disabled={busy}
                          key={s.id}
                          onClick={() => run(s)}
                        >
                          <strong>{s.title}</strong>
                          <span>{s.description}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <button
                  disabled={!online || busy}
                  className="primary"
                  onClick={(e) => {
                    opener.current = e.currentTarget;
                    setModal(true);
                  }}
                >
                  <Plus size={18} />
                  Evaluate artifact
                </button>
              </div>
            </section>
            <section className="metrics">
              <Metric
                n={state.evaluations.length}
                label="Artifacts evaluated"
              />
              <Metric n={counts("allow")} label="Cleared" cls="good" />
              <Metric n={reviews} label="Needs review" cls="warn" />
              <Metric n={counts("deny")} label="Stopped" cls="bad" />
            </section>
            <section className="coverage">
              <div>
                <p className="eyebrow">COVERAGE</p>
                <h2>Artifact types</h2>
              </div>
              <div className="coverage-bars">
                {(["package", "skill", "mcp", "url"] as ArtifactType[]).map(
                  (t) => {
                    let v = state.evaluations.filter(
                      (e) => e.request.type === t,
                    ).length;
                    let label = {
                      package: "Packages",
                      skill: "Skills",
                      mcp: "MCP servers",
                      url: "URLs",
                    }[t];
                    return (
                      <div className="coverage-row" key={t}>
                        <span className="typechip">{typeIcons[t]}</span>
                        <b>{label}</b>
                        <div>
                          <i
                            style={{
                              width: `${state.evaluations.length ? Math.max(6, (v / state.evaluations.length) * 100) : 0}%`,
                            }}
                          />
                        </div>
                        <strong>{v}</strong>
                      </div>
                    );
                  },
                )}
              </div>
            </section>
            <section className="content-grid">
              <div className="requests panel">
                <div className="section-head">
                  <div>
                    <p className="eyebrow">OBSERVATIONS</p>
                    <h2>
                      {active === "Overview"
                        ? "Recent requests"
                        : active === "Requests"
                          ? "All requests"
                          : "Awaiting review"}
                    </h2>
                  </div>
                  {active === "Overview" && (
                    <button
                      className="text-btn"
                      onClick={() => setActive("Requests")}
                    >
                      View all <ChevronRight size={15} />
                    </button>
                  )}
                </div>
                <div className="filters">
                  <label>
                    <Search size={16} />
                    <input
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="Search artifacts"
                    />
                  </label>
                  <select
                    value={type}
                    onChange={(e) => setType(e.target.value)}
                    aria-label="Filter by type"
                  >
                    <option value="all">All types</option>
                    {(["package", "skill", "mcp", "url"] as ArtifactType[]).map(
                      (x) => (
                        <option key={x}>{x}</option>
                      ),
                    )}
                  </select>
                  <select
                    value={decision}
                    onChange={(e) => setDecision(e.target.value)}
                    aria-label="Filter by decision"
                  >
                    <option value="all">All decisions</option>
                    <option value="allow">Allowed</option>
                    <option value="review">Review</option>
                    <option value="deny">Denied</option>
                  </select>
                </div>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Artifact</th>
                        <th>Session</th>
                        <th>Score</th>
                        <th>Decision</th>
                        <th>Observed</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {loading ? (
                        <tr>
                          <td colSpan={6} className="empty">
                            Loading local state…
                          </td>
                        </tr>
                      ) : items.length ? (
                        items.map((e) => (
                          <tr
                            key={e.id}
                            onClick={(x) => {
                              opener.current = x.currentTarget;
                              setSelected(e);
                            }}
                            tabIndex={0}
                            onKeyDown={(x) =>
                              x.key === "Enter" && setSelected(e)
                            }
                          >
                            <td>
                              <span className="typechip">
                                {typeIcons[e.request.type]}
                              </span>
                              <div>
                                <strong>{e.request.name}</strong>
                                <small>{e.request.source || "no source"}</small>
                              </div>
                            </td>
                            <td>
                              <code>{e.request.sessionId}</code>
                            </td>
                            <td>
                              <div className="score">
                                <i style={{ width: `${e.score}%` }} />
                                <b>{e.score}</b>
                              </div>
                            </td>
                            <td>
                              <span className={tone(resolved(e))}>
                                {resolved(e)}
                              </span>
                            </td>
                            <td>
                              <small>{date(e.timestamp)}</small>
                            </td>
                            <td>
                              <MoreHorizontal size={18} />
                            </td>
                          </tr>
                        ))
                      ) : (
                        <tr>
                          <td colSpan={6} className="empty">
                            No matching observations.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
              <aside className="right-rail">
                <div className="panel activity">
                  <div className="section-head">
                    <div>
                      <p className="eyebrow">SESSION</p>
                      <h2>Activity</h2>
                    </div>
                    <span className="live">LOCAL</span>
                  </div>
                  <div className="activity-list">
                    {state.evaluations.slice(0, 4).map((e) => (
                      <div key={e.id}>
                        <span
                          className={tone(e.review?.decision || e.decision)}
                        >
                          {e.review?.decision || e.decision}
                        </span>
                        <p>
                          <strong>{e.request.name}</strong>
                          <small>
                            {date(e.timestamp)} · {e.durationMs}ms
                          </small>
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="panel policy-card">
                  <div className="policy-icon">
                    <SlidersHorizontal size={18} />
                  </div>
                  <p className="eyebrow">ACTIVE POLICY</p>
                  <h2>Local standard</h2>
                  <p>
                    Review at <b>{state.policy.reviewThreshold}</b> · stop at{" "}
                    <b>{state.policy.denyThreshold}</b>
                  </p>
                  <button
                    className="text-btn"
                    onClick={() => setActive("Policy")}
                  >
                    Edit policy <ChevronRight size={15} />
                  </button>
                </div>
              </aside>
            </section>
          </>
        )}
        {active === "Policy" && (
          <section className="policy-editor panel">
            <div>
              <p className="eyebrow">POLICY</p>
              <h2>Decision thresholds</h2>
              <p>
                Scores run from 0 to 100. Changes apply to the local gateway.
              </p>
            </div>
            <div className="policy-controls">
              <label>
                Review threshold <output>{policy.reviewThreshold}</output>
                <input
                  type="range"
                  min="1"
                  max="99"
                  value={policy.reviewThreshold}
                  onChange={(e) =>
                    setPolicy({ ...policy, reviewThreshold: +e.target.value })
                  }
                />
              </label>
              <label>
                Deny threshold <output>{policy.denyThreshold}</output>
                <input
                  type="range"
                  min="1"
                  max="100"
                  value={policy.denyThreshold}
                  onChange={(e) =>
                    setPolicy({ ...policy, denyThreshold: +e.target.value })
                  }
                />
              </label>
              <label className="switch">
                Cross-request correlation{" "}
                <input
                  type="checkbox"
                  checked={policy.correlationEnabled}
                  onChange={(e) =>
                    setPolicy({
                      ...policy,
                      correlationEnabled: e.target.checked,
                    })
                  }
                />
                <i />
              </label>
              <button className="primary" disabled={!online || busy || policy.reviewThreshold >= policy.denyThreshold} onClick={savePolicy}>
                Save policy
              </button>
            </div>
          </section>
        )}
      </main>
      {selected && (
        <div
          className="overlay"
          role="presentation"
          onMouseDown={() => setSelected(null)}
        >
          <aside
            className="drawer"
            ref={drawer}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-label="Evaluation details"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <button
              aria-label="Close evaluation details"
              className="drawer-close"
              onClick={() => setSelected(null)}
            >
              <X />
            </button>
            <p className="eyebrow">EVALUATION · {selected.id}</p>
            <h2>{selected.request.name}</h2>
            <div className="drawer-meta">
              <span className="typechip">
                {typeIcons[selected.request.type]}
              </span>
              <span>{selected.request.type}</span>
              <code>{selected.request.sessionId}</code>
            </div>
            <div className="decision-banner">
              <span className={tone(resolved(selected))}>
                {resolved(selected)}
              </span>
              <b>
                Risk score <strong>{selected.score}</strong>/100
              </b>
            </div>
            <h3>Signal breakdown</h3>
            {selected.signals.length ? (
              selected.signals.map((s) => (
                <div className="signal" key={s.id}>
                  <div>
                    <span>{s.label}</span>
                    <b>{s.score} points</b>
                  </div>
                  <div className="signal-bar">
                    <i style={{ width: `${s.score}%` }} />
                  </div>
                  <small>{s.reason}</small>
                </div>
              ))
            ) : (
              <p className="empty-signals">
                No configured indicators were returned for this evaluation.
              </p>
            )}
            <div className="receipt">
              <KeyRound size={16} />
              <div>
                <small>Hash-linked local receipt</small>
                <code>
                  {selected.receipt.hash} ← {selected.receipt.previousHash}
                </code>
              </div>
            </div>
            {selected.decision === "review" && !selected.review && (
              <div className="review-box">
                <label>
                  Reviewer note
                  <textarea
                    required
                    id="review-note"
                    placeholder="Reason for this decision"
                  />
                </label>
                <div>
                  <button
                    disabled={busy || !online}
                    onClick={() => review("deny")}
                    className="deny-btn"
                  >
                    Deny
                  </button>
                  <button
                    disabled={busy || !online}
                    onClick={() => review("allow")}
                    className="primary"
                  >
                    <Check size={16} />
                    Allow
                  </button>
                </div>
              </div>
            )}
            {selected.review && (
              <p className="reviewed">
                <Check size={16} />
                Reviewed as {selected.review.decision}
                {selected.review.note && `: ${selected.review.note}`}
              </p>
            )}
          </aside>
        </div>
      )}
      {modal && (
        <div className="overlay" onMouseDown={() => setModal(false)}>
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="eval-title"
            ref={dialog}
            tabIndex={-1}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <button
              aria-label="Close evaluation form"
              className="drawer-close"
              onClick={() => setModal(false)}
            >
              <X />
            </button>
            <p className="eyebrow">LOCAL GATEWAY</p>
            <h2 id="eval-title">Evaluate an artifact</h2>
            <p>
              Submit an artifact to the local evaluation gateway. This is a
              synthetic demo workspace.
            </p>
            <form onSubmit={submit}>
              <label>
                Artifact type
                <select name="type" defaultValue="package">
                  <option value="package">Package</option>
                  <option value="skill">Skill</option>
                  <option value="mcp">MCP tool</option>
                  <option value="url">Remote URL</option>
                </select>
              </label>
              <label>
                Artifact name
                <input
                  required
                  name="name"
                  placeholder="example-package@1.0.0"
                  autoFocus
                />
              </label>
              <div className="form-row">
                <label>
                  Session ID
                  <input required name="session" defaultValue="local-manual" />
                </label>
                <label>
                  Source
                  <input name="source" placeholder="registry or URL" />
                </label>
              </div>
              <div className="form-row">
                <label>
                  Artifact exists
                  <select name="exists" defaultValue="unknown">
                    <option value="unknown">Unknown</option>
                    <option value="true">Reported present</option>
                    <option value="false">Not found</option>
                  </select>
                </label>
                <label>
                  Signature state
                  <select name="signed" defaultValue="unknown">
                    <option value="unknown">Unknown</option>
                    <option value="true">Reported signed</option>
                    <option value="false">Reported unsigned</option>
                  </select>
                </label>
              </div>
              <div className="form-row">
                <label>
                  Age in days
                  <input
                    min="0"
                    name="age"
                    type="number"
                    placeholder="Optional"
                  />
                </label>
                <label>
                  Downloads
                  <input
                    min="0"
                    name="downloads"
                    type="number"
                    placeholder="Optional"
                  />
                </label>
              </div>
              <label>
                Content or metadata{" "}
                <textarea
                  name="content"
                  placeholder="Optional contextual details for this evaluation"
                />
              </label>
              <button
                className="primary"
                type="submit"
                disabled={!online || busy}
              >
                <ShieldCheck size={17} />
                Evaluate locally
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
function Metric({
  n,
  label,
  cls = "",
}: {
  n: number;
  label: string;
  cls?: string;
}) {
  return (
    <div className={`metric ${cls}`}>
      <strong>{n}</strong>
      <span>{label}</span>
    </div>
  );
}
