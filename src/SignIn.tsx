import { useEffect, useRef, useState } from "react";
import { KeyRound, X } from "lucide-react";

export interface AuthStatus { configured: boolean; unlocked: boolean; reviewer?: string }

/** Unlocks the reviewer session, or sets the PIN the first time using the code printed in CARD's terminal. */
export function SignIn({ status, onDone, onClose }: { status: AuthStatus; onDone: (status: AuthStatus) => void; onClose: () => void }) {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [pin, setPin] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLFormElement>(null);
  const setup = !status.configured;
  useEffect(() => { box.current?.querySelector("input")?.focus(); }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !busy) onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (setup && pin !== confirm) { setError("The two PINs do not match."); return; }
    setBusy(true);
    setError("");
    try {
      const response = await fetch(setup ? "/api/auth/setup" : "/api/auth/unlock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(setup ? { code: code.trim(), name: name.trim(), pin } : { pin }),
      });
      const body = await response.json();
      if (!response.ok) { setError(body.error || "Sign-in failed."); return; }
      onDone(body as AuthStatus);
    } catch {
      setError("CARD is not reachable.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="overlay" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <form className="evaluation-modal signin-modal" ref={box} role="dialog" aria-modal="true" aria-label={setup ? "Set reviewer PIN" : "Reviewer sign-in"} onSubmit={submit}>
        <button type="button" className="dialog-close icon-button" aria-label="Close sign-in" onClick={onClose} disabled={busy}><X size={20} /></button>
        <span className="section-kicker">HUMAN REVIEWER</span>
        <h2><KeyRound size={20} /> {setup ? "Set your reviewer PIN" : "Sign in to review"}</h2>
        <p className="modal-description">
          {setup
            ? "Only the person with this PIN can approve held requests, change trust rules or edit policy. Enter the one-time setup code shown in the terminal where CARD is running."
            : "Verdicts, rule changes and policy edits are recorded under your name."}
        </p>
        {setup && (
          <>
            <label className="form-field">Setup code<input id="setup-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="e.g. 123-456" autoComplete="off" required /></label>
            <label className="form-field">Your name<input id="setup-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} required /></label>
          </>
        )}
        <label className="form-field">PIN<input id="reviewer-pin" type="password" value={pin} onChange={(e) => setPin(e.target.value)} minLength={6} maxLength={64} autoComplete={setup ? "new-password" : "current-password"} required /></label>
        {setup && <label className="form-field">Confirm PIN<input id="reviewer-pin-confirm" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} minLength={6} maxLength={64} autoComplete="new-password" required /></label>}
        {error && <p className="policy-error" role="alert">{error}</p>}
        <div className="modal-footer">
          <span>{setup ? "At least 6 characters, no spaces." : "Five wrong attempts lock sign-in for a minute."}</span>
          <button className="button primary" type="submit" disabled={busy || !pin}>{busy ? "Checking…" : setup ? "Save PIN and sign in" : "Sign in"}</button>
        </div>
      </form>
    </div>
  );
}
