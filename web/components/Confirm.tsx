"use client";
import { useState } from "react";
/** Typed-phrase confirmation for any action that moves funds. */
export function ConfirmBox({ phrase, label, onConfirm, danger = true }: { phrase: string; label: string; onConfirm: (typed: string) => Promise<void> | void; danger?: boolean }) {
  const [typed, setTyped] = useState(""); const [busy, setBusy] = useState(false);
  return (
    <div className="notice">
      <div>Type <b className="mono">{phrase}</b> to confirm. This broadcasts real transactions.</div>
      <div className="row" style={{ marginTop: 8 }}>
        <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={phrase} style={{ minWidth: 240 }} />
        <button className={danger ? "danger" : ""} disabled={typed !== phrase || busy} onClick={async () => { setBusy(true); try { await onConfirm(typed); } finally { setBusy(false); } }}>{busy ? "Sending…" : label}</button>
      </div>
    </div>
  );
}
