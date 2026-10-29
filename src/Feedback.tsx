import { useEffect, useMemo, useState } from "react";
import { BadgeCheck, Ban, CircleAlert, History, ShieldOff } from "lucide-react";
import type { Evaluation, FeedbackReason, MemoryRule, Policy } from "../shared/types";
import {
  DEFAULT_TRUST_DAYS,
  FEEDBACK_REASONS,
  OUTCOME_LABELS,
  TRUST_EXPIRY_DAYS,
  feedbackMetrics,
  feedbackOutcome,
  highSeveritySignals,
  ruleDecisionOf,
  ruleStatus,
  thresholdWhatIf,
} from "../shared/feedback";
import { SCORING_VERSION, SIGNAL_RULES } from "../shared/scoring";
import { blockKeyOf } from "../shared/names";
import { decisionLabel, typeLabel } from "./ui";

export interface ReviewSubmission {
  decision: "allow" | "deny";
  note: string;
  reason: FeedbackReason;
  remember: boolean;
  expiresInDays?: number;
}

const date = (stamp: string) => new Date(stamp).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
const signalLabel = (id: string) => SIGNAL_RULES[id as keyof typeof SIGNAL_RULES]?.label ?? id;
const percent = (value: number | null) => (value === null ? "—" : `${Math.round(value * 100)}%`);

/** Explains how decision memory changed (or did not change) this evaluation. */
export function MemoryNotice({ evaluation }: { evaluation: Evaluation }) {
  const memory = evaluation.memory;
  if (!memory) return null;
  const withoutRule = `Without this rule the score alone gave: ${decisionLabel[ruleDecisionOf(evaluation)]}.`;
  if (memory.applied?.effect === "trust") {
    return (
      <div className="memory-notice trust">
        <BadgeCheck size={18} />
        <div>
          <strong>Allowed by a trust rule</strong>
          <p>{memory.applied.reviewer} trusted this exact version on {date(memory.applied.createdAt)}: “{memory.applied.note}”. Trust ends {memory.applied.expiresAt ? date(memory.applied.expiresAt) : "when revoked"}.</p>
          <small>{withoutRule}</small>
        </div>
      </div>
    );
  }
  if (memory.applied?.effect === "block") {
    return (
      <div className="memory-notice block">
        <Ban size={18} />
        <div>
          <strong>Denied by a block rule</strong>
          <p>{memory.applied.reviewer} blocked this artifact name on {date(memory.applied.createdAt)}: “{memory.applied.note}”. Blocks cover every version and stay until revoked.</p>
          <small>{withoutRule}</small>
        </div>
      </div>
    );
  }
  if (memory.changedSinceTrust) {
    return (
      <div className="memory-notice changed">
        <CircleAlert size={18} />
        <div>
          <strong>Held because this artifact changed</strong>
          <p>{memory.changedSinceTrust.reviewer} trusted a different version on {date(memory.changedSinceTrust.trustedAt)}. Its content, source claims or permissions are not the same now, so a person must look again.</p>
          <small>Score alone gave: {decisionLabel[ruleDecisionOf(evaluation)]}. Changed versions are held for review at minimum.</small>
        </div>
      </div>
    );
  }
  if (memory.trustSuspended) {
    return (
      <div className="memory-notice changed">
        <ShieldOff size={18} />
        <div>
          <strong>Trust set aside</strong>
          <p>This exact version is trusted, but new warning signs appeared that the reviewer did not see: {memory.trustSuspended.newSignals.map(signalLabel).join(", ")}.</p>
          <small>The normal score-based decision applies.</small>
        </div>
      </div>
    );
  }
  if (memory.expiredTrust) {
    return (
      <div className="memory-notice expired">
        <History size={18} />
        <div>
          <strong>Trust expired</strong>
          <p>Trust for this exact version ended on {date(memory.expiredTrust.expiredAt)}. It was scored normally.</p>
        </div>
      </div>
    );
  }
  return null;
}

/** The recorded human verdict and what it says about CARD's own call. */
export function FeedbackResult({ evaluation, rules }: { evaluation: Evaluation; rules: MemoryRule[] }) {
  const review = evaluation.review!;
  const outcome = feedbackOutcome(evaluation)!;
  const rule = review.ruleId ? rules.find((item) => item.id === review.ruleId) : undefined;
  const heldRequest = evaluation.decision === "review";
  return (
    <div className={`review-resolution outcome-${outcome}`}>
      <BadgeCheck size={20} />
      <div>
        <strong>
          {heldRequest ? `Human review · ${decisionLabel[review.decision]}` : `Human feedback · ${review.decision === "allow" ? "Safe" : "Unsafe"}`}
        </strong>
        <p>{review.note}</p>
        <dl className="feedback-facts">
          <dt>Verdict on CARD</dt><dd>{OUTCOME_LABELS[outcome]}</dd>
          {review.reason && <><dt>Reason</dt><dd>{FEEDBACK_REASONS[review.reason].label}</dd></>}
          {review.reviewer && <><dt>Reviewer</dt><dd>{review.reviewer}</dd></>}
          {rule && <><dt>Remembered</dt><dd>{rule.effect === "trust" ? `Trusted this exact version until ${date(rule.expiresAt!)}` : "Blocked this name, every version, until revoked"}{rule.revoked ? " (since revoked)" : ""}</dd></>}
        </dl>
        <small>{new Date(review.timestamp).toLocaleString()}</small>
      </div>
    </div>
  );
}

/** One verdict per evaluation: resolves a hold, or labels an allow/deny as right or wrong. */
export function FeedbackPanel({
  evaluation,
  rules,
  blocked,
  reviewer,
  onSignIn,
  onSubmit,
}: {
  evaluation: Evaluation;
  rules: MemoryRule[];
  blocked: boolean;
  reviewer?: string;
  onSignIn: () => void;
  onSubmit: (input: ReviewSubmission) => Promise<void>;
}) {
  const [verdict, setVerdict] = useState<"allow" | "deny" | "">("");
  const [reason, setReason] = useState<FeedbackReason | "">("");
  const [note, setNote] = useState("");
  const [remember, setRemember] = useState(false);
  const [days, setDays] = useState<number>(DEFAULT_TRUST_DAYS);
  useEffect(() => {
    setVerdict(""); setReason(""); setNote(""); setRemember(false); setDays(DEFAULT_TRUST_DAYS);
  }, [evaluation.id]);

  const held = evaluation.decision === "review";
  const options: Array<{ value: "allow" | "deny"; label: string }> = held
    ? [{ value: "allow", label: "Allow · it is safe" }, { value: "deny", label: "Deny · it is unsafe" }]
    : evaluation.decision === "allow"
      ? [{ value: "allow", label: "Correct · it is safe" }, { value: "deny", label: "Wrong · report as unsafe" }]
      : [{ value: "allow", label: "Wrong · it is safe (false alarm)" }, { value: "deny", label: "Correct · it is unsafe" }];

  const now = new Date();
  const blockedByRule = rules.some((rule) => rule.effect === "block" && ruleStatus(rule, now) === "active" && rule.matchKey === blockKeyOf(evaluation.request.type, evaluation.request.name));
  const high = highSeveritySignals(evaluation);
  const trustUnavailable = !evaluation.fingerprint
    ? "Recorded before decision memory existed. Submit it again to trust it."
    : high.length
      ? `Contains a high-severity signal (${high.map((s) => s.label).join(", ")}). It can be labelled safe, but CARD never trusts it automatically.`
      : blockedByRule
        ? "An active block covers this name. Revoke the block on Trust & feedback first. A safe verdict never lifts a block on its own."
        : "";
  const blockUnavailable = !evaluation.fingerprint ? "Recorded before decision memory existed. Submit it again to block it." : "";
  const unavailable = verdict === "allow" ? trustUnavailable : verdict === "deny" ? blockUnavailable : "";
  const endsTrust = verdict === "deny" && evaluation.memory?.applied?.effect === "trust";
  const ready = verdict && reason && note.trim() && reviewer && !blocked && !(remember && unavailable);
  const submitLabel = held ? (verdict === "deny" ? "Deny request" : "Allow request") : "Save feedback";

  return (
    <form
      className="review-action-panel feedback-panel"
      onSubmit={(event) => {
        event.preventDefault();
        if (!ready || !verdict || !reason) return;
        void onSubmit({
          decision: verdict, reason, note: note.trim(),
          remember, ...(verdict === "allow" && remember ? { expiresInDays: days } : {}),
        });
      }}
    >
      <span className="section-kicker">{held ? "YOUR DECISION" : "HUMAN FEEDBACK"}</span>
      <h3>{held ? "Allow this request to proceed?" : `Was “${decisionLabel[evaluation.decision]}” the right call?`}</h3>
      <p>{held ? "Your verdict resolves the hold and is saved beside the original evaluation." : "Your verdict does not change what already happened. It records whether CARD was right, and can be remembered for later requests."}</p>
      <fieldset className="verdict-options">
        <legend className="sr-only">Verdict</legend>
        {options.map((option) => (
          <label key={option.value} className={verdict === option.value ? `selected ${option.value}` : ""}>
            <input
              type="radio"
              name="verdict"
              value={option.value}
              checked={verdict === option.value}
              onChange={() => { setVerdict(option.value); setReason(""); setRemember(false); }}
            />
            {option.label}
          </label>
        ))}
      </fieldset>
      {verdict && (
        <>
          <label className="feedback-field" htmlFor="feedback-reason">
            Reason
            <select id="feedback-reason" value={reason} onChange={(event) => setReason(event.target.value as FeedbackReason)}>
              <option value="">Choose a reason…</option>
              {(Object.entries(FEEDBACK_REASONS) as Array<[FeedbackReason, { verdict: string; label: string }]>)
                .filter(([, item]) => item.verdict === verdict)
                .map(([value, item]) => <option key={value} value={value}>{item.label}</option>)}
            </select>
          </label>
          <div className={`remember-option ${unavailable ? "unavailable" : ""}`}>
            <label>
              <input type="checkbox" checked={remember} disabled={!!unavailable} onChange={(event) => setRemember(event.target.checked)} />
              {verdict === "allow" ? "Trust this exact version for later requests" : "Block this name for all later requests"}
            </label>
            {verdict === "allow" && remember && (
              <label className="feedback-inline" htmlFor="trust-days">
                Trust ends after
                <select id="trust-days" value={days} onChange={(event) => setDays(Number(event.target.value))}>
                  {TRUST_EXPIRY_DAYS.map((value) => <option key={value} value={value}>{value} days</option>)}
                </select>
              </label>
            )}
            <small>
              {unavailable || (verdict === "allow"
                ? "Covers only this name, source, content and claims. Any change sends it back to review; any new warning sign sets the trust aside."
                : "Covers every version and spelling of this name. Stays until someone revokes it.")}
            </small>
          </div>
          {endsTrust && <p className="feedback-warning">This request was allowed by a trust rule. Reporting it unsafe ends that trust immediately.</p>}
          {verdict === "allow" && evaluation.memory?.applied?.effect === "block" && <p className="feedback-warning">Recorded as feedback only. The block stays in force until it is revoked.</p>}
        </>
      )}
      <label className="sr-only" htmlFor="review-note">Reviewer note</label>
      <textarea id="review-note" maxLength={500} placeholder="Explain your decision…" value={note} onChange={(event) => setNote(event.target.value)} />
      {reviewer
        ? <p className="feedback-signed-in">Recorded as <strong>{reviewer}</strong> (signed-in reviewer).</p>
        : <p className="feedback-warning">Only a signed-in reviewer can give a verdict. <button type="button" className="link-button" onClick={onSignIn}>Sign in</button></p>}
      <div>
        <button className={`button ${verdict === "deny" ? "deny-button" : "approve-button"}`} type="submit" disabled={!ready}>
          {submitLabel}
        </button>
      </div>
    </form>
  );
}

function Confusion({ label, value, tone, hint }: { label: string; value: number; tone: string; hint: string }) {
  return (
    <div className={`confusion-cell ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{hint}</small>
    </div>
  );
}

/** Feedback metrics, threshold what-if and the list of remembered rules. */
export function FeedbackView({
  evaluations,
  rules,
  policy,
  blocked,
  onRevoke,
}: {
  evaluations: Evaluation[];
  rules: MemoryRule[];
  policy: Policy;
  blocked: boolean;
  onRevoke: (id: string, note: string) => Promise<void>;
}) {
  const metrics = useMemo(() => feedbackMetrics(evaluations), [evaluations]);
  const thresholds = useMemo(() => [...new Set([10, 15, 20, 25, 30, 35, 40, 50, policy.reviewThreshold])].sort((a, b) => a - b), [policy.reviewThreshold]);
  const whatIf = useMemo(() => thresholdWhatIf(evaluations, thresholds), [evaluations, thresholds]);
  const [revoking, setRevoking] = useState("");
  const [revokeNote, setRevokeNote] = useState("");
  const now = new Date();
  const ordered = [...rules].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const types = Object.entries(metrics.byType) as Array<[keyof typeof typeLabel, { tp: number; fp: number; fn: number; tn: number }]>;

  return (
    <div className="feedback-layout">
      <section className="panel feedback-accuracy">
        <div className="panel-heading">
          <div>
            <span className="section-kicker">HUMAN FEEDBACK</span>
            <h2>How often CARD's rules were right</h2>
          </div>
          <span className="label-tag">{metrics.labelled} of {metrics.total} labelled</span>
        </div>
        <p className="panel-description">Each human verdict is compared with the decision the score alone produced. “Flagged” means the rules returned Needs review or Denied. Unlabelled requests are not counted.</p>
        <div className="confusion-grid">
          <Confusion label="Correctly flagged" value={metrics.overall.tp} tone="tp" hint="Flagged, human said unsafe" />
          <Confusion label="False alarms" value={metrics.overall.fp} tone="fp" hint="Flagged, human said safe" />
          <Confusion label="Missed risks" value={metrics.overall.fn} tone="fn" hint="Allowed, human said unsafe" />
          <Confusion label="Correctly cleared" value={metrics.overall.tn} tone="tn" hint="Allowed, human said safe" />
        </div>
        <dl className="rate-row">
          <div><dt>False-positive rate</dt><dd>{percent(metrics.falsePositiveRate)}</dd><small>false alarms ÷ all safe</small></div>
          <div><dt>Miss rate</dt><dd>{percent(metrics.falseNegativeRate)}</dd><small>missed ÷ all unsafe</small></div>
          <div><dt>Precision</dt><dd>{percent(metrics.precision)}</dd><small>right flags ÷ all flags</small></div>
          <div><dt>Detection rate</dt><dd>{percent(metrics.detectionRate)}</dd><small>caught ÷ all unsafe</small></div>
        </dl>
        {types.length > 0 && (
          <div className="table-scroll">
            <table className="feedback-table">
              <thead><tr><th>Artifact type</th><th>Labelled</th><th>False alarms</th><th>Missed risks</th></tr></thead>
              <tbody>
                {types.map(([type, counts]) => (
                  <tr key={type}><td>{typeLabel[type]}</td><td>{counts.tp + counts.fp + counts.fn + counts.tn}</td><td>{counts.fp}</td><td>{counts.fn}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="feedback-caveat">
          <CircleAlert size={14} />
          Reviewers mostly see held requests, so this sample over-represents flagged items. Treat these figures as a feedback signal about the rules, not a measured accuracy for all traffic. Trust rules later reported unsafe: {metrics.trustErrors}. Blocked requests later labelled safe: {metrics.blockOverturned}.
        </p>
      </section>

      <section className="panel">
        <div className="panel-heading">
          <div>
            <span className="section-kicker">RULE QUALITY</span>
            <h2>Noisiest warning signs</h2>
          </div>
        </div>
        <p className="panel-description">Which signals fired on human-labelled requests, and how often a person then called the request safe.</p>
        {metrics.signals.length ? (
          <div className="table-scroll">
            <table className="feedback-table">
              <thead><tr><th>Signal</th><th>Fired</th><th>False alarms</th><th>Confirmed unsafe</th></tr></thead>
              <tbody>
                {metrics.signals.map((signal) => (
                  <tr key={signal.id}><td>{signal.label}</td><td>{signal.fired}</td><td>{signal.falseAlarms}</td><td>{signal.confirmed}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="feedback-empty">No labelled requests yet. Give a verdict on any evaluation to start.</p>}
      </section>

      <section className="panel">
        <div className="panel-heading">
          <div>
            <span className="section-kicker">WHAT IF</span>
            <h2>Review threshold trade-off</h2>
          </div>
          <span className="label-tag">{whatIf.sample} comparable</span>
        </div>
        <p className="panel-description">Replays labelled requests scored with the current model ({SCORING_VERSION}) against other review thresholds. Nothing changes automatically; adjust the threshold on the Policy page if you choose.</p>
        {whatIf.sample ? (
          <div className="table-scroll">
            <table className="feedback-table">
              <thead><tr><th>Review starts at</th><th>False alarms</th><th>Missed risks</th><th>Correctly flagged</th></tr></thead>
              <tbody>
                {whatIf.rows.map((row) => (
                  <tr key={row.threshold} className={row.threshold === policy.reviewThreshold ? "current" : ""}>
                    <td>{row.threshold}{row.threshold === policy.reviewThreshold ? " (current)" : ""}</td>
                    <td>{row.falseAlarms}</td><td>{row.missed}</td><td>{row.caught}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="feedback-empty">No labelled requests from the current scoring model yet.</p>}
      </section>

      <section className="panel feedback-rules">
        <div className="panel-heading">
          <div>
            <span className="section-kicker">DECISION MEMORY</span>
            <h2>Trusted and blocked artifacts</h2>
          </div>
          <span className="label-tag">{rules.filter((rule) => ruleStatus(rule, now) === "active").length} active</span>
        </div>
        <p className="panel-description">Trust covers one exact version and ends after its expiry. Blocks cover every version of a name and stay until revoked. Revoking keeps the rule in history.</p>
        {ordered.length ? (
          <div className="rule-list">
            {ordered.map((rule) => {
              const status = ruleStatus(rule, now);
              return (
                <div className={`rule-row ${status}`} key={rule.id}>
                  <div className="rule-main">
                    <span className={`rule-chip ${rule.effect}`}>{rule.effect === "trust" ? "Trust" : "Block"}</span>
                    <span className={`rule-chip status-${status}`}>{status === "active" ? "Active" : status === "expired" ? "Expired" : "Revoked"}</span>
                    <strong>{rule.name}</strong>
                    <small>{typeLabel[rule.type]} · {rule.effect === "trust" ? "this exact version" : "every version of this name"}</small>
                  </div>
                  <p>“{rule.note}” · {FEEDBACK_REASONS[rule.reason].label}</p>
                  <small className="rule-meta">
                    {rule.reviewer} · {date(rule.createdAt)} · {rule.expiresAt ? `${status === "expired" ? "ended" : "ends"} ${date(rule.expiresAt)}` : "until revoked"}
                    {rule.revoked && ` · revoked ${date(rule.revoked.at)} (${rule.revoked.cause.replace(/-/g, " ")}): ${rule.revoked.note}`}
                  </small>
                  {status === "active" && (revoking === rule.id ? (
                    <form className="revoke-form" onSubmit={(event) => {
                      event.preventDefault();
                      if (!revokeNote.trim() || blocked) return;
                      void onRevoke(rule.id, revokeNote.trim()).then(() => { setRevoking(""); setRevokeNote(""); });
                    }}>
                      <label className="sr-only" htmlFor={`revoke-${rule.id}`}>Reason for revoking</label>
                      <input id={`revoke-${rule.id}`} maxLength={500} value={revokeNote} onChange={(event) => setRevokeNote(event.target.value)} placeholder="Why revoke this rule?" />
                      <button className="button secondary" type="button" onClick={() => { setRevoking(""); setRevokeNote(""); }}>Cancel</button>
                      <button className="button primary" type="submit" disabled={blocked || !revokeNote.trim()}>Confirm revoke</button>
                    </form>
                  ) : (
                    <button className="button secondary rule-revoke" disabled={blocked} onClick={() => { setRevoking(rule.id); setRevokeNote(""); }}>Revoke</button>
                  ))}
                </div>
              );
            })}
          </div>
        ) : <p className="feedback-empty">No remembered decisions yet. Tick “Trust this exact version” or “Block this name” when giving a verdict.</p>}
      </section>
    </div>
  );
}
