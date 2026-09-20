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
  const [policy, setPolicy] = useState(saved),
    [previewScore, setPreviewScore] = useState(50);
  useEffect(() => setPolicy(saved), [saved]);
  const dirty = JSON.stringify(policy) !== JSON.stringify(saved);
  const verdict: Decision =
    previewScore >= policy.denyThreshold
      ? "deny"
      : previewScore >= policy.reviewThreshold
        ? "review"
        : "allow";
  return (
    <div className="policy-layout">
      <section className="panel policy-editor">
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
            min={1}
            max={policy.denyThreshold - 1}
            value={policy.reviewThreshold}
            onChange={(e) =>
              setPolicy((p) => ({
                ...p,
                reviewThreshold: Math.min(
                  p.denyThreshold - 1,
                  Math.max(1, +e.target.value),
                ),
              }))
            }
          />
          <input
            aria-label="Review threshold slider"
            type="range"
            min={1}
            max={policy.denyThreshold - 1}
            value={policy.reviewThreshold}
            onChange={(e) =>
              setPolicy({ ...policy, reviewThreshold: +e.target.value })
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
            min={policy.reviewThreshold + 1}
            max={100}
            value={policy.denyThreshold}
            onChange={(e) =>
              setPolicy((p) => ({
                ...p,
                denyThreshold: Math.max(
                  p.reviewThreshold + 1,
                  Math.min(100, +e.target.value),
                ),
              }))
            }
          />
          <input
            aria-label="Deny threshold slider"
            type="range"
            min={policy.reviewThreshold + 1}
            max={100}
            value={policy.denyThreshold}
            onChange={(e) =>
              setPolicy({ ...policy, denyThreshold: +e.target.value })
            }
          />
        </div>
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
            aria-label="Cross-artifact correlation"
            aria-checked={policy.correlationEnabled}
            className={`toggle ${policy.correlationEnabled ? "on" : ""}`}
            onClick={() =>
              setPolicy({
                ...policy,
                correlationEnabled: !policy.correlationEnabled,
              })
            }
          >
            <i />
          </button>
        </div>
        <div className="policy-actions">
          <button
            className="button secondary"
            disabled={!dirty || blocked}
            onClick={() => setPolicy(saved)}
          >
            Discard changes
          </button>
          <button
            className="button primary"
            disabled={blocked || !dirty}
            onClick={() => void onSave(policy)}
          >
            <Check size={15} />
            Save policy
          </button>
        </div>
      </section>
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
