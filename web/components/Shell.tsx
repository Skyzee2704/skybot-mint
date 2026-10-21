"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api, setToken, getToken } from "@/lib/api";

type Status = { initialized: boolean; unlocked: boolean; sessionExpiresAt: string | null; config: any; chains: any[] };

/** Top nav + unlock gate. All pages render only after the keystore is unlocked. */
export function Shell({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [pw, setPw] = useState(""); const [pw2, setPw2] = useState("");
  const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const load = useCallback(() => api<Status>("/api/status").then(setStatus).catch((e) => setErr(e.message)), []);
  useEffect(() => { load(); const h = () => load(); window.addEventListener("nmb:locked", h); return () => window.removeEventListener("nmb:locked", h); }, [load]);

  const unlock = async () => {
    setErr(null);
    if (!status?.initialized && pw !== pw2) { setErr("Passwords do not match"); return; }
    setBusy(true);
    try { const r = await api<{ token: string }>("/api/session/unlock", { body: { password: pw } }); setToken(r.token); setPw(""); setPw2(""); await load(); }
    catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  const lock = async () => { await api("/api/session/lock", { body: {} }).catch(() => {}); setToken(null); load(); };

  const ready = status?.unlocked && getToken();
  return (
    <>
      <nav>
        <span className="brand">NFT Mint Bot</span>
        <Link href="/">Mint</Link><Link href="/wallets">Wallets</Link><Link href="/jobs">Jobs</Link><Link href="/settings">Settings</Link>
        <span className="spacer" />
        {status && <span className="muted">{status.unlocked ? `unlocked until ${new Date(status.sessionExpiresAt!).toLocaleTimeString()}` : "locked"}</span>}
        {ready && <button className="secondary" onClick={lock}>Lock</button>}
      </nav>
      <main>
        {!status && !err && <p className="muted">Connecting to API…</p>}
        {err && !ready && <div className="err">{err}</div>}
        {status && !ready && (
          <div className="card" style={{ maxWidth: 420 }}>
            <h2>{status.initialized ? "Unlock keystore" : "Create master password"}</h2>
            <p className="muted">{status.initialized ? "Keys are encrypted at rest (scrypt + AES-256-GCM). The password unlocks them for this session only." : "This password encrypts every private key you import or generate. It cannot be recovered — store it safely."}</p>
            <div style={{ display: "grid", gap: 8 }}>
              <input type="password" placeholder="Master password (min 8 chars)" value={pw} onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => e.key === "Enter" && unlock()} autoFocus />
              {!status.initialized && <input type="password" placeholder="Repeat password" value={pw2} onChange={(e) => setPw2(e.target.value)} />}
              <button onClick={unlock} disabled={busy || pw.length < 8}>{busy ? "Deriving key…" : status.initialized ? "Unlock" : "Create & unlock"}</button>
            </div>
          </div>
        )}
        {ready && children}
      </main>
    </>
  );
}
