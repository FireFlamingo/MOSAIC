import type { EvidenceField, EvidenceReport } from "../shared/types";

const LABELS = { exists: "Exists", signed: "Signed provenance", ageDays: "Age", downloads: "Downloads (7 days)" } as const;
const SOURCE = { registry: "Looked up", caller: "Typed by caller", unverified: "Not verified" } as const;

function show(name: keyof typeof LABELS, field: EvidenceField) {
  if (field.value === undefined) return "Unknown";
  if (name === "exists" || name === "signed") return field.value ? "Yes" : "No";
  if (name === "ageDays") return `${field.value} days`;
  return Number(field.value).toLocaleString();
}

/** Where each fact behind the score came from. Age and downloads are shown as context and are not scored. */
export function EvidencePanel({ evidence }: { evidence: EvidenceReport }) {
  const entries = (Object.keys(LABELS) as Array<keyof typeof LABELS>).filter((name) => evidence.fields[name]);
  return (
    <div className="inspector-section evidence-panel">
      <div className="subheading">
        <h3>Where the evidence came from</h3>
        <span>{evidence.registry ? evidence.registry.toUpperCase() : evidence.mode === "live" ? "LIVE LOOKUP" : "CALLER"}</span>
      </div>
      {evidence.note && <p className="evidence-note">{evidence.note}</p>}
      {entries.length > 0 && (
        <dl className="evidence-list">
          {entries.map((name) => {
            const field = evidence.fields[name]!;
            return (
              <div key={name}>
                <dt>{LABELS[name]}{name === "ageDays" || name === "downloads" ? <small>context only, not scored</small> : null}</dt>
                <dd>
                  <strong>{show(name, field)}</strong>
                  <span className={`evidence-source ${field.from}`}>{SOURCE[field.from]}</span>
                  {field.detail && <small>{field.detail}</small>}
                </dd>
              </div>
            );
          })}
        </dl>
      )}
      {evidence.installScripts && (
        <details className="request-evidence" open>
          <summary>Install scripts from the registry</summary>
          <pre>{evidence.installScripts}</pre>
        </details>
      )}
      {evidence.callerClaims && (
        <p className="evidence-note">The caller also claimed {Object.entries(evidence.callerClaims).filter(([key]) => key !== "permissions").map(([key, value]) => `${key} = ${JSON.stringify(value)}`).join(", ") || "nothing checkable"}. Claims CARD can check itself were ignored.</p>
      )}
      {evidence.sources.length > 0 && (
        <p className="evidence-sources">
          Checked {new Date(evidence.fetchedAt).toLocaleString()} ·{" "}
          {evidence.sources.map((source) => <a key={source} href={source} target="_blank" rel="noreferrer">{new URL(source).host}</a>)}
        </p>
      )}
    </div>
  );
}
