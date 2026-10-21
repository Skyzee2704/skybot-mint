"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";

export default function SettingsPage() {
  const [status, setStatus] = useState<any>(null); const [health, setHealth] = useState<any[] | null>(null); const [busy, setBusy] = useState(false);
  useEffect(() => { api("/api/status").then(setStatus); }, []);
  const check = async () => { setBusy(true); try { setHealth(await api("/api/chains/health")); } finally { setBusy(false); } };
  const c = status?.config;
  return (
    <>
      <div className="card"><h2>Configuration</h2>
        {c && <div className="grid">{Object.entries(c).map(([k, v]) => <div key={k} className="kv"><b>{k}</b>{typeof v === "object" ? JSON.stringify(v) : String(v)}</div>)}</div>}
        <p className="muted">Secrets are never shown — only whether they are set. Configure via env vars / ENV_FILES (see README).</p>
      </div>
      <div className="card"><h2>Chains & RPCs</h2>
        <button onClick={check} disabled={busy}>{busy ? "Checking…" : "Run health check (read-only)"}</button>
        <table style={{ marginTop: 10 }}><thead><tr><th>Chain</th><th>ID</th><th>SeaDrop</th><th>Private RPC</th><th>Read / send RPCs</th><th>Health</th><th>Block</th></tr></thead>
          <tbody>{status?.chains.map((ch: any) => { const h = health?.find((x) => x.key === ch.key); return (
            <tr key={ch.key}><td>{ch.name}</td><td>{ch.chainId}</td><td>{ch.seadrop ? "yes" : "no"}</td><td>{ch.privateRpc ? "yes" : "public only"}</td><td>{ch.rpcCount} / {ch.sendRpcCount}</td>
              <td>{h ? (h.ok ? <span className="ok">ok</span> : <span className="bad">{h.error}</span>) : "—"}
                {h && <div className="mono muted">{h.endpoints.map((e: any) => `${e.url}${e.sendOnly ? " (send-only)" : ""}${e.lastError ? " ✗" : ""}`).join(" · ")}</div>}</td>
              <td className="mono">{h?.block ?? ""}</td></tr>); })}</tbody></table>
      </div>
    </>
  );
}
