import { useEffect, useState } from "react";
import { Check, CircleAlert, GitBranch } from "lucide-react";
import type { Decision, Policy } from "../shared/types";
import { Badge, Boundary } from "./ui";
export function PolicyEditor({
  saved,
  blocked,
  onSave,
}: {
  saved: Policy;
  blocked: boolean;
  onSave: (policy: Policy) => Promise<void>;
}) {
  const [review, setReview] = useState(String(saved.reviewThreshold));
  const [deny, setDeny] = useState(String(saved.denyThreshold));
  const [correlationEnabled, setCorrelation] = useState(saved.correlationEnabled);
  const [previewScore, setPreviewScore] = useState(50);
  function discard() {
    setReview(String(saved.reviewThreshold));
    setDeny(String(saved.denyThreshold));
    setCorrelation(saved.correlationEnabled);
  }
  useEffect(() => {
    setReview(String(saved.reviewThreshold));
    setDeny(String(saved.denyThreshold));
    setCorrelation(saved.correlationEnabled);
  }, [saved.reviewThreshold, saved.denyThreshold, saved.correlationEnabled]);
  const valid = review.trim() !== "" && deny.trim() !== "" &&
    Number.isInteger(Number(review)) && Number.isInteger(Number(deny)) &&
    Number(review) >= 0 && Number(deny) <= 100 && Number(review) < Number(deny);
  const draft = { reviewThreshold: Number(review), denyThreshold: Number(deny), correlationEnabled };
  const policy = valid ? draft : saved;
  const dirty = review !== String(saved.reviewThreshold) || deny !== String(saved.denyThreshold) || correlationEnabled !== saved.correlationEnabled;
  const verdict: Decision =
    previewScore >= policy.denyThreshold
      ? "deny"
      : previewScore >= policy.reviewThreshold
        ? "review"
        : "allow";
  return (
    <div className="policy-layout">
      <form className="panel policy-editor" noValidate onSubmit={(event) => {
        event.preventDefault();
        if (valid && dirty && !blocked) void onSave(draft);
      }}>
        <div className="panel-heading">
          <div>
            <span className="section-kicker">THRESHOLD POLICY</span>
            <h2>Decision thresholds</h2>
          </div>
          <span className="label-tag">
            {dirty ? "Unsaved changes" : "Saved"}
          </span>
        </div>
        <p className="panel-description">
          Requests receive a score from 0 to 100. These boundaries decide which
          requests proceed, pause, or stop.
        </p>
        <Boundary policy={policy} />
        <div className="threshold-field">
          <label htmlFor="review-threshold">
            <span className="policy-dot review" />
            Hold for review<small>At this score or above</small>
          </label>
          <input
            id="review-threshold"
            type="number"
            min={0}
            max={99}
            value={review}
            aria-invalid={!valid}
            aria-describedby={!valid ? "threshold-error" : undefined}
            onChange={(e) => setReview(e.target.value)}
          />
          <input
            aria-label="Review threshold slider"
            type="range"
            min={0}
            max={policy.denyThreshold - 1}
            value={policy.reviewThreshold}
            onChange={(e) =>
              setReview(e.target.value)
            }
          />
        </div>
        <div className="threshold-field">
          <label htmlFor="deny-threshold">
            <span className="policy-dot deny" />
            Deny the request<small>At this score or above</small>
          </label>
          <input
            id="deny-threshold"
            type="number"
            min={1}
            max={100}
            value={deny}
            aria-invalid={!valid}
            aria-describedby={!valid ? "threshold-error" : undefined}
            onChange={(e) => setDeny(e.target.value)}
          />
          <input
            aria-label="Deny threshold slider"
            type="range"
            min={policy.reviewThreshold + 1}
            max={100}
            value={policy.denyThreshold}
            onChange={(e) =>
              setDeny(e.target.value)
            }
          />
        </div>
        {!valid && <p id="threshold-error" role="alert" className="policy-error">Enter whole numbers from 0 to 100. Review must be lower than deny. The preview uses the saved policy until these values are valid.</p>}
        <div className="correlation-control">
          <div>
            <GitBranch size={20} />
            <span>
              <strong>Cross-artifact correlation</strong>
              <small>Include recent activity from the same session.</small>
            </span>
          </div>
          <button
            role="switch"
            type="button"
            aria-label="Cross-artifact correlation"
            aria-checked={correlationEnabled}
            className={`toggle ${correlationEnabled ? "on" : ""}`}
            onClick={() => setCorrelation(!correlationEnabled)}
          >
            <i />
          </button>
        </div>
        <div className="policy-actions">
          <button
            className="button secondary"
            type="button"
            disabled={!dirty}
            onClick={discard}
          >
            Discard changes
          </button>
          <button
            className="button primary"
            disabled={blocked || !dirty || !valid}
            type="submit"
          >
            <Check size={15} />
            Save policy
          </button>
        </div>
      </form>
      <div>
        <section className="panel policy-preview">
          <span className="section-kicker">TRY A SCORE</span>
          <h2>Decision preview</h2>
          <p>Move the slider to see how your thresholds apply.</p>
          <div className={`preview-number ${verdict}`}>
            {previewScore}
            <small>/100</small>
          </div>
          <input
            type="range"
            aria-label="Preview risk score"
            min={0}
            max={100}
            value={previewScore}
            onChange={(e) => setPreviewScore(+e.target.value)}
          />
          <Badge decision={verdict} />
          <small className="preview-note">
            Preview only. No evaluation is recorded.
          </small>
        </section>
        <div className="policy-info">
          <CircleAlert size={18} />
          <p>
            Changes apply to future evaluations. Existing scores and decisions
            remain in the audit trail.
          </p>
        </div>
      </div>
    </div>
  );
}
