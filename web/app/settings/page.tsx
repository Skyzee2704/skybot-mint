"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";

export default function SettingsPage() {
  const [status, setStatus] = useState<any>(null); const [health, setHealth] = useState<any[] | null>(null); const [busy, setBusy] = useState(false);
  const [st, setSt] = useState<any>(null); const [edit, setEdit] = useState<Record<string, { maxPricePerNft: string; maxDailySpend: string }>>({});
  const [msg, setMsg] = useState<string | null>(null); const [err, setErr] = useState<string | null>(null);
  const loadSettings = () => api("/api/settings").then((s) => { setSt(s); setEdit(Object.fromEntries(s.chains.map((c: any) => [c.key, { maxPricePerNft: c.maxPricePerNft, maxDailySpend: c.maxDailySpend }]))); });
  useEffect(() => { api("/api/status").then(setStatus); loadSettings().catch((e) => setErr(e.message)); }, []);
  const save = async (patch: any) => { setErr(null); setMsg(null); try { const s = await api("/api/settings", { method: "PUT", body: patch }); setSt(s); setMsg("Saved"); } catch (e: any) { setErr(e.message); } };
  const check = async () => { setBusy(true); try { setHealth(await api("/api/chains/health")); } finally { setBusy(false); } };
  const c = status?.config;
  return (
    <>
      {err && <div className="err">{err}</div>}{msg && <div className="notice">{msg}</div>}
      {st && <div className="card"><h2>Spend caps (optional)</h2>
        <p className="muted">Off = unlimited (default). Always on regardless: {st.alwaysOn.join(" · ")}.</p>
        <div className="row" style={{ marginBottom: 10 }}>
          <label><input type="checkbox" checked={st.priceCapEnabled} onChange={(e) => save({ priceCapEnabled: e.target.checked })} /> Max price per NFT</label>
          <label><input type="checkbox" checked={st.dailyCapEnabled} onChange={(e) => save({ dailyCapEnabled: e.target.checked })} /> Max daily spend (per chain, UTC day)</label>
        </div>
        <table><thead><tr><th>Chain</th><th>Max price / NFT</th><th>Max daily spend</th><th>Spent today</th></tr></thead>
          <tbody>{st.chains.map((ch: any) => (
            <tr key={ch.key}><td>{ch.name}</td>
              <td><input disabled={!st.priceCapEnabled} value={edit[ch.key]?.maxPricePerNft ?? ""} onChange={(e) => setEdit((x) => ({ ...x, [ch.key]: { ...x[ch.key], maxPricePerNft: e.target.value } }))} style={{ width: 110 }} /> {ch.nativeSymbol}</td>
              <td><input disabled={!st.dailyCapEnabled} value={edit[ch.key]?.maxDailySpend ?? ""} onChange={(e) => setEdit((x) => ({ ...x, [ch.key]: { ...x[ch.key], maxDailySpend: e.target.value } }))} style={{ width: 110 }} /> {ch.nativeSymbol}</td>
              <td className="mono">{ch.dailySpent}</td></tr>))}</tbody></table>
        <button style={{ marginTop: 10 }} disabled={!st.priceCapEnabled && !st.dailyCapEnabled} onClick={() => save({ caps: edit })}>Save cap values</button>
      </div>}
      {st && <div className="card"><h2>Allowlist checks</h2>
        <p className="muted">Active stages are checked through OpenSea's official mint API, which checks the allowlist before balance, so unfunded wallets work too. Contract rules are checked with <span className="mono">eth_call</span> and a fake balance (state override). Nothing is signed.</p>
        <label><input type="checkbox" checked={st.openseaWalletLogin} onChange={(e) => save({ openseaWalletLogin: e.target.checked })} /> <b>OpenSea wallet login for upcoming stages</b></label>
        <p className="muted">When on, each wallet you check signs an off-chain OpenSea sign-in message (SIWE) to call OpenSea's official eligibility endpoint. It is not a transaction and costs no gas, but it signs that wallet in to OpenSea and accepts OpenSea's Terms for it. It is off by default.</p>
      </div>}
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
