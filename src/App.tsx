import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  CheckCheck,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Circle,
  CircleAlert,
  Fingerprint,
  GitBranch,
  Layers3,
  Menu,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Terminal,
  X,
} from "lucide-react";
import type {
  AppState,
  ArtifactRequest,
  Decision,
  Evaluation,
  Policy,
  Scenario,
} from "../shared/types";
import {
  ArtifactIcon,
  Badge,
  Boundary,
  correlation,
  decisionIcon,
  decisionLabel,
  INITIAL_POLICY,
  latest,
  resolved,
  shortSession,
  time,
  TYPES,
  typeIcon,
  typeLabel,
} from "./ui";
import { EvaluationDialog } from "./EvaluationDialog";
import { PolicyEditor } from "./PolicyEditor";
type View = "Overview" | "Requests" | "Review queue" | "Policy";
const views = [
  { label: "Overview" as View, icon: Layers3 },
  { label: "Requests" as View, icon: Activity },
  { label: "Review queue" as View, icon: ShieldCheck },
  { label: "Policy" as View, icon: SlidersHorizontal },
];

export default function App() {
  const [state, setState] = useState<AppState>({
    evaluations: [],
    policy: INITIAL_POLICY,
    scenarios: [],
  });
  const [view, setView] = useState<View>("Overview");
  const [loading, setLoading] = useState(true),
    [online, setOnline] = useState(false),
    [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(""),
    [synced, setSynced] = useState("");
  const [query, setQuery] = useState(""),
    [type, setType] = useState("all"),
    [decision, setDecision] = useState("all"),
    [page, setPage] = useState(0);
  const [session, setSession] = useState(""),
    [sessionFilter, setSessionFilter] = useState("");
  const [selected, setSelected] = useState<Evaluation | null>(null),
    [modal, setModal] = useState(false),
    [scenarioMenu, setScenarioMenu] = useState(false),
    [mobile, setMobile] = useState(false);
  const opener = useRef<HTMLElement | null>(null),
    search = useRef<HTMLInputElement>(null);
  const blocked = busy || !online;
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/state");
      if (!response.ok) throw Error();
      const data: AppState = await response.json();
      setState({ ...data, evaluations: latest(data.evaluations) });
      setOnline(true);
      setSynced(new Date().toISOString());
    } catch {
      setOnline(false);
      setNotice("Gateway unavailable. Start the local server, then refresh.");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 5500);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    setPage(0);
  }, [query, type, decision, view, sessionFilter]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setScenarioMenu(false);
        setMobile(false);
      }
      if (
        selected ||
        modal ||
        /INPUT|TEXTAREA|SELECT/.test((event.target as HTMLElement).tagName) ||
        event.metaKey ||
        event.ctrlKey
      )
        return;
      if (event.key === "/" && view !== "Policy") {
        event.preventDefault();
        search.current?.focus();
      }
      if (event.key === "n" && !blocked) {
        opener.current = document.activeElement as HTMLElement;
        setModal(true);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [selected, modal, view, blocked]);
  async function api<T>(url: string, options?: RequestInit): Promise<T | null> {
    if (blocked) return null;
    setBusy(true);
    try {
      const response = await fetch(url, {
        headers: { "Content-Type": "application/json" },
        ...options,
      });
      const body = await response.json();
      if (!response.ok) {
        setNotice(body.error || "The request could not be completed.");
        return null;
      }
      setSynced(new Date().toISOString());
      return body as T;
    } catch {
      setOnline(false);
      setNotice("Connection lost. Your saved observations are still shown.");
      return null;
    } finally {
      setBusy(false);
    }
  }
  function navigate(next: View) {
    setView(next);
    setQuery("");
    setType("all");
    setDecision("all");
    setSessionFilter("");
    setMobile(false);
    setScenarioMenu(false);
  }
  function inspect(e: Evaluation) {
    opener.current = document.activeElement as HTMLElement;
    setSelected(e);
  }
  function closeDialog() {
    setSelected(null);
    setModal(false);
    setTimeout(() => opener.current?.focus(), 0);
  }
  function addEvaluations(evaluations: Evaluation[]) {
    setState((current) => ({
      ...current,
      evaluations: latest([...evaluations, ...current.evaluations]),
    }));
  }
  async function run(scenario: Scenario) {
    setScenarioMenu(false);
    const results = await api<Evaluation[]>(
      `/api/scenarios/${scenario.id}/run`,
      { method: "POST" },
    );
    if (results) {
      addEvaluations(results);
      setSession(results[0].request.sessionId);
      setView("Overview");
      setNotice(
        `Workflow replayed · ${results.length} evaluation${results.length === 1 ? "" : "s"} recorded.`,
      );
    }
  }
  async function review(next: "allow" | "deny", note: string) {
    if (!selected) return;
    const updated = await api<Evaluation>(`/api/reviews/${selected.id}`, {
      method: "POST",
      body: JSON.stringify({ decision: next, note }),
    });
    if (updated) {
      setState((current) => ({
        ...current,
        evaluations: current.evaluations.map((item) =>
          item.id === updated.id ? updated : item,
        ),
      }));
      setSelected(updated);
      setNotice("Review saved to the audit trail.");
    }
  }
  async function savePolicy(policy: Policy) {
    const saved = await api<Policy>("/api/policy", {
      method: "PATCH",
      body: JSON.stringify(policy),
    });
    if (saved) {
      setState((current) => ({ ...current, policy: saved }));
      setNotice("Policy updated. New evaluations will use these thresholds.");
    }
  }
  async function exportAudit() {
    const result = await api<unknown>("/api/export");
    if (result) {
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(result, null, 2)], {
          type: "application/json",
        }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = "mosaic-audit.json";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice("Audit export prepared.");
    }
  }
  async function submit(request: ArtifactRequest) {
    const result = await api<Evaluation>("/api/evaluate", {
      method: "POST",
      body: JSON.stringify(request),
    });
    if (result) {
      addEvaluations([result]);
      setModal(false);
      setSelected(result);
      setSession(result.request.sessionId);
      setNotice("Evaluation recorded.");
    }
  }
  const pending = state.evaluations.filter((e) => resolved(e) === "review");
  const counts = {
    allow: state.evaluations.filter((e) => resolved(e) === "allow").length,
    review: pending.length,
    deny: state.evaluations.filter((e) => resolved(e) === "deny").length,
  };
  const sessions = useMemo(() => {
    const groups = new Map<string, Evaluation[]>();
    for (const e of [...state.evaluations].reverse()) {
      const id = e.request.sessionId;
      groups.set(id, [...(groups.get(id) || []), e]);
    }
    return [...groups.entries()].sort((a, b) =>
      b[1].at(-1)!.timestamp.localeCompare(a[1].at(-1)!.timestamp),
    );
  }, [state.evaluations]);
  const activeSession =
    sessions.find(([id]) => id === session) ??
    sessions.find(([, list]) => list.length > 1) ??
    sessions[0];
  const filtered = state.evaluations.filter(
    (e) =>
      (type === "all" || e.request.type === type) &&
      (decision === "all" || resolved(e) === decision) &&
      (view !== "Review queue" || resolved(e) === "review") &&
      (!sessionFilter || e.request.sessionId === sessionFilter) &&
      `${e.request.name} ${e.request.source || ""} ${e.request.sessionId}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const pageSize = view === "Overview" ? 6 : 10,
    pageCount = Math.max(1, Math.ceil(filtered.length / pageSize)),
    currentPage = Math.min(page, pageCount - 1),
    visible = filtered.slice(
      currentPage * pageSize,
      (currentPage + 1) * pageSize,
    );
  const subtitle =
    view === "Overview"
      ? "Track artifact requests, inspect evidence, and resolve holds."
      : view === "Requests"
        ? "Every evaluated artifact, with the evidence behind its decision."
        : view === "Review queue"
          ? "Resolve held requests with a recorded human decision."
          : "Set the boundaries for your next evaluation.";
  return (
    <div className="shell">
      {mobile && (
        <button
          className="nav-scrim"
          aria-label="Close navigation"
          onClick={() => setMobile(false)}
        />
      )}
      <aside
        className={`sidebar ${mobile ? "is-open" : ""}`}
        inert={!!selected || modal}
      >
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            navigate("Overview");
          }}
        >
          <span className="brand-mark">
            {Array.from({ length: 9 }, (_, i) => (
              <i key={i} />
            ))}
          </span>
          <span>
            MOSAIC<small>ARTIFACT CONTROL</small>
          </span>
        </a>
        <div className="workspace">
          <span className="workspace-symbol">
            <Terminal size={16} />
          </span>
          <span>
            Local workspace<small>Development environment</small>
          </span>
          <span className="workspace-dot" />
        </div>
        <p className="nav-caption">WORKSPACE</p>
        <nav>
          {views.map((item) => (
            <button
              key={item.label}
              className={view === item.label ? "nav-item active" : "nav-item"}
              aria-current={view === item.label ? "page" : undefined}
              onClick={() => navigate(item.label)}
            >
              <item.icon size={17} />
              <span>{item.label}</span>
              {item.label === "Review queue" && (
                <small
                  className={
                    pending.length ? "nav-count attention" : "nav-count"
                  }
                >
                  {pending.length}
                </small>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-note">
          <GitBranch size={22} />
          <strong>Cross-artifact history</strong>
          <p>Inspect related requests within a shared session.</p>
          <button onClick={() => navigate("Overview")}>
            Inspect a session
            <ArrowUpRight size={14} />
          </button>
        </div>
        <div className="sidebar-bottom">
          <button onClick={() => void exportAudit()} disabled={blocked}>
            <ArrowDownToLine size={16} />
            Export audit trail
            <ArrowUpRight size={13} />
          </button>
          <div className="runtime">
            <span className={online ? "status-dot" : "status-dot offline"} />
            Local gateway<span>v0.1</span>
          </div>
        </div>
      </aside>
      <div className="main-shell" inert={!!selected || modal}>
        <header className="topbar">
          <div className="breadcrumbs">
            <button
              className="icon-button menu-button"
              aria-label="Open navigation"
              onClick={() => setMobile(!mobile)}
            >
              <Menu size={20} />
            </button>
            <span>Workspace</span>
            <ChevronRight size={13} />
            <strong>{view}</strong>
          </div>
          <div className="topbar-tools">
            <span className="fixture-chip">
              <span />
              Synthetic fixtures
            </span>
            <span className={`connection ${online ? "" : "disconnected"}`}>
              <i />
              {loading ? "Connecting" : online ? "API reachable" : "Offline"}
            </span>
            <button
              className="icon-button"
              title="Refresh observations"
              aria-label="Refresh gateway state"
              disabled={loading || busy}
              onClick={() => void load()}
            >
              <RefreshCw size={15} className={loading ? "spin" : ""} />
            </button>
            <span className="local-avatar" title="Local workspace">
              L
            </span>
          </div>
        </header>
        <main>
          <div className="page-heading">
            <div>
              <div className="overline">
                <span className="orange-square" />
                MOSAIC / CONTROL PLANE
              </div>
              <h1>{view === "Overview" ? "Artifact overview" : view}</h1>
              <p>{subtitle}</p>
            </div>
            <div className="page-actions">
              <div className="scenario-wrap">
                <button
                  className="button secondary"
                  disabled={blocked}
                  aria-expanded={scenarioMenu}
                  onClick={() => setScenarioMenu(!scenarioMenu)}
                >
                  <Play size={14} />
                  Replay workflow
                  <ChevronDown size={13} />
                </button>
                {scenarioMenu && (
                  <>
                    <button
                      className="menu-dismiss"
                      aria-label="Close workflow menu"
                      onClick={() => setScenarioMenu(false)}
                    />
                    <div className="scenario-menu">
                      <div className="menu-label">
                        SYNTHETIC WORKFLOWS<span>{state.scenarios.length}</span>
                      </div>
                      {state.scenarios.map((s, index) => (
                        <button key={s.id} onClick={() => void run(s)}>
                          <span className="scenario-index">0{index + 1}</span>
                          <span>
                            <strong>{s.title}</strong>
                            <small>{s.description}</small>
                          </span>
                          <ArrowUpRight size={15} />
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
              <button
                className="button primary"
                disabled={blocked}
                onClick={(e) => {
                  opener.current = e.currentTarget;
                  setModal(true);
                }}
              >
                <Plus size={16} />
                New evaluation<kbd>N</kbd>
              </button>
            </div>
          </div>
          {!online && !loading && (
            <div className="offline-banner">
              <CircleAlert size={17} />
              <span>
                Gateway offline. Showing the last loaded observations.
              </span>
              <button onClick={() => void load()}>
                Reconnect
                <RefreshCw size={14} />
              </button>
            </div>
          )}
          {view !== "Policy" && (
            <>
              <section className="metric-band" aria-label="Evaluation totals">
                <button
                  onClick={() => {
                    setDecision("all");
                    setSessionFilter("");
                  }}
                  className="metric total"
                >
                  <span className="metric-label">
                    Evaluated artifacts
                    <Layers3 size={15} />
                  </span>
                  <strong>
                    {loading ? "—" : state.evaluations.length}
                    <small>across {sessions.length} sessions</small>
                  </strong>
                  <div className="microbars" aria-hidden="true">
                    {state.evaluations
                      .slice(0, 24)
                      .reverse()
                      .map((e) => (
                        <i
                          key={e.id}
                          className={resolved(e)}
                          style={{ height: `${Math.max(15, e.score)}%` }}
                        />
                      ))}
                  </div>
                </button>
                {(["allow", "review", "deny"] as Decision[]).map((d) => {
                  const Icon = decisionIcon[d];
                  return (
                    <button
                      key={d}
                      className={`metric ${d} ${decision === d ? "metric-selected" : ""}`}
                      onClick={() => {
                        setDecision(decision === d ? "all" : d);
                        if (view === "Review queue" && d !== "review")
                          setView("Requests");
                      }}
                    >
                      <span className="metric-label">
                        {d === "review" ? "Awaiting review" : decisionLabel[d]}
                        <Icon size={15} />
                      </span>
                      <strong>
                        {loading ? "—" : counts[d]}
                        <small>
                          {d === "allow"
                            ? "cleared by policy or review"
                            : d === "review"
                              ? "waiting for your decision"
                              : "denied by policy or review"}
                        </small>
                      </strong>
                      <span className="metric-link">
                        {d === "review" && counts[d]
                          ? "Open requests"
                          : "View observations"}
                        <ArrowUpRight size={13} />
                      </span>
                    </button>
                  );
                })}
              </section>
              {view === "Overview" && (
                <div className="overview-top">
                  <section className="panel session-panel">
                    <div className="panel-heading">
                      <div>
                        <span className="section-kicker">
                          CROSS-ARTIFACT CONTEXT
                        </span>
                        <h2>
                          Session trace
                          <span className="label-tag">
                            {activeSession?.[1].length ?? 0} events
                          </span>
                        </h2>
                      </div>
                      <label className="session-picker">
                        <GitBranch size={14} />
                        <select
                          aria-label="Choose session"
                          value={activeSession?.[0] ?? ""}
                          onChange={(e) => setSession(e.target.value)}
                        >
                          {sessions.map(([id]) => (
                            <option key={id} value={id}>
                              {shortSession(id)}
                            </option>
                          ))}
                        </select>
                        <ChevronDown size={12} />
                      </label>
                    </div>
                    <div className="session-canvas">
                      {activeSession ? (
                        <>
                          <div className="session-start">
                            <span>
                              <Terminal size={16} />
                            </span>
                            <small>
                              {activeSession[1].length > 5 ? "LATEST" : "SESSION"}
                              <br />
                              {activeSession[1].length > 5 ? "EVENTS" : "START"}
                            </small>
                          </div>
                          {activeSession[1].slice(-5).map((e, index) => (
                            <div className="trace-step" key={e.id}>
                              <div className="trace-connector">
                                <span />
                                <ChevronRight size={14} />
                              </div>
                              <button
                                className={`trace-node ${resolved(e)}`}
                                onClick={() => inspect(e)}
                              >
                                <div className="trace-top">
                                  <ArtifactIcon type={e.request.type} />
                                  <span className="trace-number">
                                    0
                                    {Math.max(0, activeSession[1].length - 5) +
                                      index +
                                      1}
                                  </span>
                                </div>
                                <strong>{e.request.name}</strong>
                                <small>{typeLabel[e.request.type]}</small>
                                <div className="trace-bottom">
                                  <span className="trace-score">
                                    {e.score}
                                    <small>/100</small>
                                  </span>
                                  <Badge decision={resolved(e)} />
                                </div>
                              </button>
                            </div>
                          ))}
                        </>
                      ) : (
                        <div className="empty">
                          Run a workflow to inspect its session history.
                        </div>
                      )}
                    </div>
                    <div className="session-caption">
                      <GitBranch size={14} />
                      <span>
                        {activeSession?.[1].some((e) => correlation(e) > 0) ? (
                          <>
                            Related earlier requests added{" "}
                            <strong>
                              +{Math.max(...activeSession[1].map(correlation))}{" "}
                              risk points
                            </strong>{" "}
                            to a later evaluation.
                          </>
                        ) : (
                          "Shared session history brings related artifact requests into view."
                        )}
                      </span>
                      {activeSession && (
                        <button
                          onClick={() => {
                            navigate("Requests");
                            setSessionFilter(activeSession[0]);
                          }}
                        >
                          View session
                          <ArrowRight size={13} />
                        </button>
                      )}
                    </div>
                  </section>
                  <section className="panel policy-summary">
                    <div className="panel-heading">
                      <div>
                        <span className="section-kicker">
                          DECISION BOUNDARIES
                        </span>
                        <h2>Active policy</h2>
                      </div>
                      <Settings2 size={16} />
                    </div>
                    <div className="policy-name">
                      <span className="policy-symbol">
                        <ShieldCheck size={22} />
                      </span>
                      <div>
                        <strong>Local standard</strong>
                        <small>Applied before the caller proceeds</small>
                      </div>
                    </div>
                    <Boundary policy={state.policy} />
                    <div className="policy-legend">
                      <span>
                        <i className="allow" />
                        Allow
                      </span>
                      <span>
                        <i className="review" />
                        Review
                      </span>
                      <span>
                        <i className="deny" />
                        Deny
                      </span>
                    </div>
                    <div className="policy-bottom">
                      <span>
                        <GitBranch size={13} />
                        Correlation{" "}
                        {state.policy.correlationEnabled ? "on" : "off"}
                      </span>
                      <button onClick={() => navigate("Policy")}>
                        Edit policy
                        <ArrowUpRight size={13} />
                      </button>
                    </div>
                  </section>
                </div>
              )}
              <div
                className={
                  view === "Overview" ? "stream-layout" : "stream-layout full"
                }
              >
                <section className="panel stream-panel">
                  <div className="panel-heading">
                    <div>
                      <span className="section-kicker">
                        {view === "Review queue"
                          ? "HUMAN CHECKPOINT"
                          : "OBSERVATIONS"}
                      </span>
                      <h2>
                        {view === "Overview"
                          ? "Decision stream"
                          : view === "Review queue"
                            ? "Pending decisions"
                            : "All requests"}
                        <span className="label-tag">{filtered.length}</span>
                      </h2>
                    </div>
                    <span className="table-hint">
                      <Circle size={7} fill="currentColor" />
                      Stored locally
                    </span>
                  </div>
                  <div
                    className="type-tabs"
                    role="group"
                    aria-label="Artifact type filter"
                  >
                    <button
                      className={type === "all" ? "active" : ""}
                      onClick={() => setType("all")}
                    >
                      All artifacts<span>{state.evaluations.length}</span>
                    </button>
                    {TYPES.map((t) => {
                      const Icon = typeIcon[t];
                      return (
                        <button
                          key={t}
                          className={type === t ? "active" : ""}
                          onClick={() => setType(t)}
                        >
                          <Icon size={14} />
                          {t === "mcp"
                            ? "MCP"
                            : t === "url"
                              ? "URLs"
                              : `${typeLabel[t]}s`}
                          <span>
                            {
                              state.evaluations.filter(
                                (e) => e.request.type === t,
                              ).length
                            }
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  <div className="filter-row">
                    <label className="search-field">
                      <Search size={15} />
                      <input
                        ref={search}
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="Find an artifact or session…"
                        aria-label="Search requests"
                      />
                      <kbd>/</kbd>
                    </label>
                    <select
                      className="decision-select"
                      aria-label="Filter by decision"
                      value={decision}
                      onChange={(e) => setDecision(e.target.value)}
                    >
                      <option value="all">All decisions</option>
                      <option value="allow">Allowed</option>
                      <option value="review">Needs review</option>
                      <option value="deny">Denied</option>
                    </select>
                    {(query ||
                      type !== "all" ||
                      decision !== "all" ||
                      sessionFilter) && (
                      <button
                        className="clear-filter"
                        aria-label="Clear all filters"
                        onClick={() => {
                          setQuery("");
                          setType("all");
                          setDecision("all");
                          setSessionFilter("");
                        }}
                      >
                        <X size={14} />
                      </button>
                    )}
                  </div>
                  {sessionFilter && (
                    <div className="session-filter">
                      <GitBranch size={12} />
                      {shortSession(sessionFilter)}
                      <button
                        aria-label="Remove session filter"
                        onClick={() => setSessionFilter("")}
                      >
                        <X size={12} />
                      </button>
                    </div>
                  )}
                  <div className="table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>Artifact / source</th>
                          <th>Risk score</th>
                          <th>Decision</th>
                          <th>Evaluated</th>
                          <th>
                            <span className="sr-only">Inspect</span>
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {loading && !state.evaluations.length ? (
                          <tr>
                            <td colSpan={5} className="empty">
                              Loading observations…
                            </td>
                          </tr>
                        ) : visible.length ? (
                          visible.map((e) => (
                            <tr key={e.id}>
                              <td>
                                <button
                                  className="artifact-cell"
                                  onClick={() => inspect(e)}
                                >
                                  <ArtifactIcon type={e.request.type} />
                                  <span>
                                    <strong>{e.request.name}</strong>
                                    <small>
                                      {e.request.source ||
                                        shortSession(e.request.sessionId)}
                                    </small>
                                  </span>
                                </button>
                              </td>
                              <td>
                                <div className={`risk-cell ${e.decision}`}>
                                  <span>
                                    {String(e.score).padStart(2, "0")}
                                  </span>
                                  <div>
                                    <i style={{ width: `${e.score}%` }} />
                                  </div>
                                  {correlation(e) > 0 && (
                                    <GitBranch
                                      size={12}
                                      aria-label="Includes session correlation"
                                    />
                                  )}
                                </div>
                              </td>
                              <td>
                                <Badge decision={resolved(e)} />
                                {e.review && (
                                  <span
                                    className="review-indicator"
                                    title="Human review recorded"
                                  >
                                    <CheckCheck size={12} />
                                  </span>
                                )}
                              </td>
                              <td>
                                <time
                                  dateTime={e.timestamp}
                                  title={new Date(e.timestamp).toLocaleString()}
                                >
                                  {time(e.timestamp)}
                                </time>
                              </td>
                              <td>
                                <button
                                  className="row-open"
                                  aria-label={`Inspect ${e.request.name}`}
                                  onClick={() => inspect(e)}
                                >
                                  <ArrowUpRight size={15} />
                                </button>
                              </td>
                            </tr>
                          ))
                        ) : (
                          <tr>
                            <td colSpan={5}>
                              <div className="empty-state">
                                <Search size={24} />
                                <strong>
                                  {view === "Review queue" &&
                                  !query &&
                                  type === "all" &&
                                  decision === "all"
                                    ? "You’re all caught up."
                                    : "No matching requests"}
                                </strong>
                                <span>
                                  {view === "Review queue"
                                    ? "Held requests appear here for a human decision."
                                    : "Try another filter, or evaluate a new artifact."}
                                </span>
                              </div>
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                  <div className="table-footer">
                    <span>
                      {filtered.length
                        ? `${currentPage * pageSize + 1}–${Math.min((currentPage + 1) * pageSize, filtered.length)} of ${filtered.length} observations`
                        : "0 observations"}
                    </span>
                    <div>
                      <button
                        aria-label="Previous page"
                        disabled={currentPage === 0}
                        onClick={() => setPage(currentPage - 1)}
                      >
                        <ChevronLeft size={15} />
                      </button>
                      <span>
                        {currentPage + 1} / {pageCount}
                      </span>
                      <button
                        aria-label="Next page"
                        disabled={currentPage + 1 >= pageCount}
                        onClick={() => setPage(currentPage + 1)}
                      >
                        <ChevronRight size={15} />
                      </button>
                    </div>
                  </div>
                </section>
                {view === "Overview" && (
                  <aside className="inbox">
                    <section className="panel review-panel">
                      <div className="panel-heading">
                        <div>
                          <span className="section-kicker">
                            YOUR CHECKPOINT
                          </span>
                          <h2>Review inbox</h2>
                        </div>
                        <span className="inbox-count">{pending.length}</span>
                      </div>
                      {pending.length ? (
                        <>
                          <p className="panel-description">
                            These requests are waiting on a human decision.
                          </p>
                          <div className="review-list">
                            {pending.slice(0, 3).map((e) => (
                              <button key={e.id} onClick={() => inspect(e)}>
                                <span className="review-card-top">
                                  <ArtifactIcon type={e.request.type} />
                                  <span>
                                    {e.score}
                                    <small>/100</small>
                                  </span>
                                </span>
                                <strong>{e.request.name}</strong>
                                <p>
                                  {[...e.signals].sort(
                                    (a, b) => b.score - a.score,
                                  )[0]?.label ?? "Policy threshold reached"}
                                </p>
                                <span className="review-card-action">
                                  Inspect & decide
                                  <ArrowRight size={14} />
                                </span>
                              </button>
                            ))}
                          </div>
                          <button
                            className="panel-bottom-link"
                            onClick={() => navigate("Review queue")}
                          >
                            Open review queue
                            <ArrowUpRight size={14} />
                          </button>
                        </>
                      ) : (
                        <div className="inbox-empty">
                          <CheckCheck size={30} />
                          <strong>No decisions waiting.</strong>
                          <p>New held requests will appear here.</p>
                        </div>
                      )}
                    </section>
                    <div className="audit-note">
                      <Fingerprint size={20} />
                      <div>
                        <strong>Exportable audit history</strong>
                        <p>
                          Hash-linked evaluations, stored locally and ready to
                          export.
                        </p>
                        <button
                          onClick={() => void exportAudit()}
                          disabled={blocked}
                        >
                          Download audit
                          <ArrowDownToLine size={12} />
                        </button>
                      </div>
                    </div>
                  </aside>
                )}
              </div>
            </>
          )}
          {view === "Policy" && (
            <PolicyEditor
              saved={state.policy}
              blocked={blocked}
              onSave={savePolicy}
            />
          )}
          <footer className="workspace-footer">
            <span>
              <Terminal size={12} />
              LOCAL EVALUATION GATEWAY
            </span>
            <span>
              {synced ? `Last synced ${time(synced)}` : "Waiting for gateway"}
              <i />
              MVP · v0.1
            </span>
          </footer>
        </main>
      </div>
      {notice && (
        <div className="notification" role="status">
          <CircleAlert size={16} />
          <span>{notice}</span>
          <button
            aria-label="Dismiss notification"
            onClick={() => setNotice("")}
          >
            <X size={14} />
          </button>
        </div>
      )}
      {(selected || modal) && (
        <EvaluationDialog
          selected={selected}
          blocked={blocked}
          busy={busy}
          onClose={closeDialog}
          onReview={review}
          onSubmit={submit}
        />
      )}
    </div>
  );
}
