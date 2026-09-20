import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  Check,
  CheckCheck,
  ChevronDown,
  Circle,
  Fingerprint,
  GitBranch,
  Plus,
  ShieldCheck,
  X,
} from "lucide-react";
import type {
  ArtifactRequest,
  ArtifactType,
  Evaluation,
} from "../shared/types";
import {
  ArtifactIcon,
  Badge,
  decisionLabel,
  resolved,
  time,
  TYPES,
  typeIcon,
  typeLabel,
} from "./ui";

interface Props {
  selected: Evaluation | null;
  blocked: boolean;
  busy: boolean;
  onClose: () => void;
  onReview: (decision: "allow" | "deny", note: string) => Promise<void>;
  onSubmit: (request: ArtifactRequest) => Promise<void>;
}
export function EvaluationDialog({
  selected,
  blocked,
  busy,
  onClose,
  onReview,
  onSubmit,
}: Props) {
  const dialog = useRef<HTMLDivElement>(null);
  const [formType, setFormType] = useState<ArtifactType>("package"),
    [note, setNote] = useState("");
  useEffect(() => {
    setNote("");
    dialog.current?.focus();
  }, [selected?.id]);
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
      const box = dialog.current;
      if (event.key !== "Tab" || !box) return;
      const nodes = [
        ...box.querySelectorAll<HTMLElement>(
          "button:not(:disabled),input:not(:disabled),select,textarea,summary,[href]",
        ),
      ].filter((node) => node.getClientRects().length);
      if (
        event.shiftKey &&
        (document.activeElement === nodes[0] || document.activeElement === box)
      ) {
        event.preventDefault();
        nodes.at(-1)?.focus();
      } else if (!event.shiftKey && document.activeElement === nodes.at(-1)) {
        event.preventDefault();
        nodes[0]?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, onClose]);
  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = (key: string) => String(form.get(key) || "").trim();
    const flag = (key: string) =>
      text(key) === "unknown" ? undefined : text(key) === "true";
    void onSubmit({
      type: formType,
      name: text("name"),
      sessionId: text("session"),
      source: text("source") || undefined,
      content: text("content") || undefined,
      metadata: {
        exists: flag("exists"),
        signed: flag("signed"),
        ageDays: text("age") ? Number(text("age")) : undefined,
        downloads: text("downloads") ? Number(text("downloads")) : undefined,
        permissions: form.getAll("permission") as string[],
      },
    });
  }
  return (
    <div
      className={`overlay ${selected ? "drawer-overlay" : ""}`}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div
        className={selected ? "inspector" : "evaluation-modal"}
        ref={dialog}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={selected ? "Evaluation details" : "New evaluation"}
      >
        <button
          className="dialog-close icon-button"
          disabled={busy}
          aria-label="Close dialog"
          onClick={onClose}
        >
          <X size={20} />
        </button>
        {selected ? (
          <>
            <div className="inspector-heading">
              <span className="section-kicker">EVALUATION DETAIL</span>
              <ArtifactIcon type={selected.request.type} />
              <h2>{selected.request.name}</h2>
              <p>
                {typeLabel[selected.request.type]}
                <span>·</span>
                {time(selected.timestamp)}
              </p>
            </div>
            <div className={`inspector-verdict ${resolved(selected)}`}>
              <div>
                <span>RISK SCORE</span>
                <strong>
                  {selected.score}
                  <small>/100</small>
                </strong>
              </div>
              <Badge decision={resolved(selected)} />
            </div>
            <div className="inspector-section">
              <div className="subheading">
                <h3>What informed this decision</h3>
                <span>{selected.signals.length} signals</span>
              </div>
              {selected.signals.length ? (
                [...selected.signals]
                  .sort((a, b) => b.score - a.score)
                  .map((s) => (
                    <div
                      className={`signal ${s.id.includes("correlation") ? "correlated" : ""}`}
                      key={s.id}
                    >
                      <div>
                        <span>
                          {s.id.includes("correlation") ? (
                            <GitBranch size={13} />
                          ) : (
                            <Circle size={7} fill="currentColor" />
                          )}
                          {s.label}
                        </span>
                        <strong>+{s.score * s.weight}</strong>
                      </div>
                      <p>{s.reason}</p>
                      <div className="signal-track">
                        <i style={{ width: `${s.score * s.weight}%` }} />
                      </div>
                    </div>
                  ))
              ) : (
                <div className="no-signals">
                  <CheckCheck size={19} />
                  <p>
                    No configured indicators matched. A low score does not
                    verify the artifact’s safety.
                  </p>
                </div>
              )}
            </div>
            <div className="inspector-section">
              <h3>Request context</h3>
              <dl className="request-context">
                <dt>Session</dt>
                <dd>{selected.request.sessionId}</dd>
                <dt>Source</dt>
                <dd>{selected.request.source || "Not supplied"}</dd>
                <dt>Scoring time</dt>
                <dd>{selected.durationMs} ms</dd>
                <dt>Original decision</dt>
                <dd>{decisionLabel[selected.decision]}</dd>
              </dl>
              <details className="request-evidence">
                <summary>
                  Supplied metadata & content
                  <ChevronDown size={14} />
                </summary>
                <pre>
                  {JSON.stringify(
                    {
                      metadata: selected.request.metadata ?? {},
                      content: selected.request.content ?? null,
                    },
                    null,
                    2,
                  )}
                </pre>
              </details>
            </div>
            <div className="receipt-block">
              <Fingerprint size={17} />
              <div>
                <strong>Hash-linked receipt</strong>
                <code>{selected.receipt.hash}</code>
                <small>Original evaluation · SHA-256</small>
              </div>
            </div>
            {selected.decision === "review" && !selected.review && (
              <div className="review-action-panel">
                <span className="section-kicker">YOUR DECISION</span>
                <h3>Allow this request to proceed?</h3>
                <p>Your note is saved alongside the original evaluation.</p>
                <label className="sr-only" htmlFor="review-note">
                  Reviewer note
                </label>
                <textarea
                  id="review-note"
                  maxLength={500}
                  placeholder="Add a reason for your decision…"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
                <div>
                  <button
                    className="button deny-button"
                    disabled={blocked || !note.trim()}
                    onClick={() => void onReview("deny", note.trim())}
                  >
                    <X size={15} />
                    Deny request
                  </button>
                  <button
                    className="button approve-button"
                    disabled={blocked || !note.trim()}
                    onClick={() => void onReview("allow", note.trim())}
                  >
                    <Check size={15} />
                    Allow request
                  </button>
                </div>
              </div>
            )}
            {selected.review && (
              <div className="review-resolution">
                <CheckCheck size={20} />
                <div>
                  <strong>
                    Human review · {decisionLabel[selected.review.decision]}
                  </strong>
                  <p>{selected.review.note}</p>
                  <small>
                    {new Date(selected.review.timestamp).toLocaleString()}
                  </small>
                </div>
              </div>
            )}
          </>
        ) : (
          <>
            <span className="section-kicker">LOCAL GATEWAY</span>
            <h2>Evaluate an artifact</h2>
            <p className="modal-description">
              Submit a request and inspect the evidence behind its score.
            </p>
            <form onSubmit={submit}>
              <div
                className="form-types"
                role="group"
                aria-label="Artifact type"
              >
                {TYPES.map((t) => {
                  const Icon = typeIcon[t];
                  return (
                    <button
                      key={t}
                      type="button"
                      aria-pressed={formType === t}
                      className={formType === t ? "active" : ""}
                      onClick={() => setFormType(t)}
                    >
                      <Icon size={19} />
                      {typeLabel[t]}
                    </button>
                  );
                })}
              </div>
              <label className="form-field">
                Artifact name
                <input
                  name="name"
                  required
                  maxLength={120}
                  placeholder={
                    formType === "package"
                      ? "e.g. react@19.0.0"
                      : "A name for this artifact"
                  }
                />
              </label>
              <div className="form-columns">
                <label className="form-field">
                  Session ID
                  <input
                    name="session"
                    required
                    maxLength={120}
                    defaultValue="manual-session"
                  />
                </label>
                <label className="form-field">
                  {formType === "url" ? "URL to evaluate" : "Source"}
                  <input
                    name="source"
                    maxLength={1500}
                    placeholder={
                      formType === "url"
                        ? "https://example.com/resource"
                        : "Optional registry or URL"
                    }
                  />
                </label>
              </div>
              <div className="evidence-heading">
                <span>SUPPLIED EVIDENCE</span>
                <small>Reported by you · not independently verified</small>
              </div>
              <div className="form-columns">
                <label className="form-field">
                  Artifact existence
                  <select name="exists" defaultValue="unknown">
                    <option value="unknown">Unknown</option>
                    <option value="true">Reported present</option>
                    <option value="false">Not found</option>
                  </select>
                </label>
                <label className="form-field">
                  Signature
                  <select name="signed" defaultValue="unknown">
                    <option value="unknown">Unknown</option>
                    <option value="true">Reported signed</option>
                    <option value="false">Reported unsigned</option>
                  </select>
                </label>
              </div>
              <div className="form-columns">
                <label className="form-field">
                  Age in days
                  <input
                    type="number"
                    min={0}
                    max={1000000000}
                    name="age"
                    placeholder="Unknown"
                  />
                </label>
                <label className="form-field">
                  Downloads
                  <input
                    type="number"
                    min={0}
                    max={1000000000}
                    name="downloads"
                    placeholder="Unknown"
                  />
                </label>
              </div>
              <details className="advanced-fields">
                <summary>
                  Content & permissions
                  <Plus size={14} />
                </summary>
                <label className="form-field">
                  Static content
                  <textarea
                    name="content"
                    maxLength={4000}
                    placeholder="Paste a manifest, skill text, or other content to inspect."
                  />
                </label>
                <div className="permission-options">
                  {[
                    "read:workspace",
                    "filesystem:write",
                    "network:egress",
                    "secrets:read",
                  ].map((p) => (
                    <label key={p}>
                      <input type="checkbox" name="permission" value={p} />
                      {p}
                    </label>
                  ))}
                </div>
              </details>
              <div className="modal-footer">
                <span>
                  <ShieldCheck size={15} />
                  Artifacts are never executed.
                </span>
                <button
                  className="button primary"
                  disabled={blocked}
                  type="submit"
                >
                  {busy ? "Evaluating…" : "Evaluate request"}
                  <ArrowRight size={15} />
                </button>
              </div>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
