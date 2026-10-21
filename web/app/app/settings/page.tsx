"use client";
import { useEffect, useState } from "react";
import { useApi } from "@/components/AppShell";

export default function SettingsPage() {
  const api = useApi();
  const [st, setSt] = useState<any>(null); const [edit, setEdit] = useState<Record<string, any>>({});
  const [link, setLink] = useState<any>(null); const [claim, setClaim] = useState("");
  const [msg, setMsg] = useState<string | null>(null); const [err, setErr] = useState<string | null>(null);
  const [health, setHealth] = useState<any[] | null>(null);

  const load = () => api("/api/settings").then((s) => { setSt(s); setEdit(Object.fromEntries(s.chains.map((c: any) => [c.key, { maxPricePerNft: c.maxPricePerNft, maxDailySpend: c.maxDailySpend }]))); });
  useEffect(() => { load().catch((e) => setErr(e.message)); const i = setInterval(() => load().catch(() => {}), 5000); return () => clearInterval(i); }, []); // eslint-disable-line

  const save = async (patch: any) => { setErr(null); setMsg(null); try { const s = await api("/api/settings", { method: "PUT", body: patch }); setSt((x: any) => ({ ...x, ...s })); setMsg("Saved"); } catch (e: any) { setErr(e.message); } };

  return (
    <>
      {err && <div className="err">{err}</div>}{msg && <div className="notice">{msg}</div>}

      <div className="card">
        <h2>Connect Telegram</h2>
        <p className="muted">Link your Telegram so /mint, /wallets and job notifications use this SkyBOT account. No public domain needed.</p>
        {st?.telegram?.linked ? (
          <div className="row">
            <span className="pill accent">Linked @{st.telegram.username || st.telegram.linked}</span>
            <button className="ghost" onClick={() => api("/api/telegram/unlink", { body: {} }).then(() => { setMsg("Unlinked"); load(); })}>Unlink</button>
          </div>
        ) : (
          <>
            <div className="row">
              <button onClick={async () => { const r = await api("/api/telegram/link-code", { body: {} }); setLink(r); }}>Generate deep link</button>
            </div>
            {link && (
              <div className="notice">
                <p>Open this link on your phone (expires soon):</p>
                {link.deepLink ? <p><a href={link.deepLink} target="_blank" rel="noreferrer">{link.deepLink}</a></p> : <p className="mono">/start link_{link.code}</p>}
                <p className="muted">Or tell the bot: <code>/start link_{link.code}</code></p>
              </div>
            )}
            <hr style={{ borderColor: "var(--line)", margin: "16px 0" }} />
            <p className="muted">Or paste a code from Telegram <b>/link</b>:</p>
            <div className="row">
              <input value={claim} onChange={(e) => setClaim(e.target.value.trim())} placeholder="code from /link" style={{ maxWidth: 280 }} />
              <button className="ghost" disabled={!claim} onClick={() => api("/api/telegram/claim-code", { body: { code: claim } }).then(() => { setMsg("Linked!"); setClaim(""); load(); }).catch((e) => setErr(e.message))}>Claim</button>
            </div>
          </>
        )}
      </div>

      {st && <div className="card"><h2>Spend caps (optional)</h2>
        <p className="muted">Off = unlimited. Always on: {st.alwaysOn?.join(" · ")}</p>
        <div className="row" style={{ marginBottom: 10 }}>
          <label><input type="checkbox" checked={st.priceCapEnabled} onChange={(e) => save({ priceCapEnabled: e.target.checked })} /> Max price / NFT</label>
          <label><input type="checkbox" checked={st.dailyCapEnabled} onChange={(e) => save({ dailyCapEnabled: e.target.checked })} /> Max daily spend</label>
        </div>
        <table><thead><tr><th>Chain</th><th>Max / NFT</th><th>Max daily</th><th>Spent today</th></tr></thead>
          <tbody>{st.chains.map((ch: any) => (
            <tr key={ch.key}><td>{ch.name}</td>
              <td><input disabled={!st.priceCapEnabled} value={edit[ch.key]?.maxPricePerNft ?? ""} onChange={(e) => setEdit((x) => ({ ...x, [ch.key]: { ...x[ch.key], maxPricePerNft: e.target.value } }))} style={{ width: 100 }} /> {ch.nativeSymbol}</td>
              <td><input disabled={!st.dailyCapEnabled} value={edit[ch.key]?.maxDailySpend ?? ""} onChange={(e) => setEdit((x) => ({ ...x, [ch.key]: { ...x[ch.key], maxDailySpend: e.target.value } }))} style={{ width: 100 }} /> {ch.nativeSymbol}</td>
              <td className="mono">{ch.dailySpent}</td></tr>
          ))}</tbody></table>
        <button style={{ marginTop: 10 }} disabled={!st.priceCapEnabled && !st.dailyCapEnabled} onClick={() => save({ caps: edit })}>Save cap values</button>
      </div>}

      <div className="card"><h2>Chain health</h2>
        <button className="ghost" onClick={async () => setHealth(await api("/api/chains/health"))}>Run check</button>
        {health && <table style={{ marginTop: 10 }}><thead><tr><th>Chain</th><th>OK</th><th>Block</th></tr></thead>
          <tbody>{health.map((h) => <tr key={h.key}><td>{h.key}</td><td className={h.ok ? "ok" : "bad"}>{h.ok ? "ok" : h.error}</td><td className="mono">{h.block}</td></tr>)}</tbody></table>}
      </div>
    </>
  );
}
