"use client";
// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from "react";
import { useApi, useShell } from "@/components/AppShell";
import { useLinkAccount, usePrivy } from "@privy-io/react-auth";
import { useTelegram } from "@/lib/telegram";

export default function SettingsPage() {
  const api = useApi();
  const { tgOnly, connectPrivy } = useShell();
  const { isMiniApp, initData } = useTelegram();
  const [st, setSt] = useState<any>(null);
  const [edit, setEdit] = useState<Record<string, any>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [health, setHealth] = useState<any[] | null>(null);
  const { authenticated, user } = usePrivy();
  const { linkEmail, linkGoogle, linkTelegram } = useLinkAccount({
    onSuccess: () => {
      setMsg("Login linked. You can now sign in with it to reach this same account.");
      // Let the server pick up the newly linked account (email / Telegram) from the refreshed identity token.
      api("/api/me").catch(() => {});
      load().catch(() => {});
    },
    onError: (code: unknown) => setErr(`Could not link this login (${String(code)}). It may already belong to another account.`),
  });

  const load = () =>
    api("/api/settings").then((s) => {
      setSt(s);
      setEdit(Object.fromEntries(s.chains.map((c: any) => [c.key, { maxPricePerNft: c.maxPricePerNft, maxDailySpend: c.maxDailySpend }])));
    });
  useEffect(() => {
    load().catch((e) => setErr(e.message));
    const i = setInterval(() => load().catch(() => {}), 5000);
    return () => clearInterval(i);
  }, []); // eslint-disable-line

  const save = async (patch: any) => {
    setErr(null);
    setMsg(null);
    try {
      const s = await api("/api/settings", { method: "PUT", body: patch });
      setSt((x: any) => ({ ...x, ...s }));
      setMsg("Saved");
    } catch (e: any) {
      setErr(e.message);
    }
  };

  const email = user?.email?.address ?? null;
  const google = user?.google?.email ?? null;
  const telegram = user?.telegram?.username ?? (user?.telegram ? String(user.telegram.telegramUserId) : null);

  return (
    <>
      {err && <div className="err">{err}</div>}
      {msg && <div className="notice">{msg}</div>}

      <div className="card">
        <h2>Sign-In Methods</h2>
        <p className="muted">
          Email, Google and Telegram all open the same SkyBOT account. Link each one once and use whichever is handy, on the web or inside
          Telegram.
        </p>
        {tgOnly || !authenticated ? (
          <>
            <p className="muted">
              You are signed in with a Telegram session{st?.telegram?.username ? ` (@${st.telegram.username})` : ""}. Connect with Privy to
              link email or Google and to import wallets.
            </p>
            <button onClick={connectPrivy}>Connect with Privy</button>
          </>
        ) : (
          <table>
            <tbody>
              <tr>
                <td>Telegram</td>
                <td>{telegram ? <span className="pill accent">@{telegram}</span> : <span className="muted">Not linked</span>}</td>
                <td>
                  {!telegram && (
                    <button
                      className="ghost"
                      onClick={() => linkTelegram(isMiniApp && initData ? { launchParams: { initDataRaw: initData } } : undefined)}
                    >
                      Link Telegram
                    </button>
                  )}
                </td>
              </tr>
              <tr>
                <td>Email</td>
                <td>{email ? <span className="pill accent">{email}</span> : <span className="muted">Not linked</span>}</td>
                <td>
                  {!email && (
                    <button className="ghost" onClick={linkEmail}>
                      Link Email
                    </button>
                  )}
                </td>
              </tr>
              <tr>
                <td>Google</td>
                <td>{google ? <span className="pill accent">{google}</span> : <span className="muted">Not linked</span>}</td>
                <td>
                  {!google && (
                    <button className="ghost" onClick={linkGoogle}>
                      Link Google
                    </button>
                  )}
                </td>
              </tr>
            </tbody>
          </table>
        )}
        {st?.telegram?.botUsername && (
          <p className="muted" style={{ marginTop: 10 }}>
            Bot:{" "}
            <a href={`https://t.me/${st.telegram.botUsername}`} target="_blank" rel="noreferrer">
              @{st.telegram.botUsername}
            </a>{" "}
            for /mint, /wallets and job notifications.
          </p>
        )}
      </div>

      {st && (
        <div className="card">
          <h2>Spend Caps (Optional)</h2>
          <p className="muted">Off = unlimited. Always on: {st.alwaysOn?.join(" · ")}</p>
          <div className="row" style={{ marginBottom: 10 }}>
            <label>
              <input type="checkbox" checked={st.priceCapEnabled} onChange={(e) => save({ priceCapEnabled: e.target.checked })} /> Max Price
              / NFT
            </label>
            <label>
              <input type="checkbox" checked={st.dailyCapEnabled} onChange={(e) => save({ dailyCapEnabled: e.target.checked })} /> Max Daily
              Spend
            </label>
          </div>
          <table>
            <thead>
              <tr>
                <th>Chain</th>
                <th>Max / NFT</th>
                <th>Max Daily</th>
                <th>Spent Today</th>
              </tr>
            </thead>
            <tbody>
              {st.chains.map((ch: any) => (
                <tr key={ch.key}>
                  <td>{ch.name}</td>
                  <td>
                    <input
                      disabled={!st.priceCapEnabled}
                      value={edit[ch.key]?.maxPricePerNft ?? ""}
                      onChange={(e) => setEdit((x) => ({ ...x, [ch.key]: { ...x[ch.key], maxPricePerNft: e.target.value } }))}
                      style={{ width: 100 }}
                    />{" "}
                    {ch.nativeSymbol}
                  </td>
                  <td>
                    <input
                      disabled={!st.dailyCapEnabled}
                      value={edit[ch.key]?.maxDailySpend ?? ""}
                      onChange={(e) => setEdit((x) => ({ ...x, [ch.key]: { ...x[ch.key], maxDailySpend: e.target.value } }))}
                      style={{ width: 100 }}
                    />{" "}
                    {ch.nativeSymbol}
                  </td>
                  <td className="mono">{ch.dailySpent}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <button style={{ marginTop: 10 }} disabled={!st.priceCapEnabled && !st.dailyCapEnabled} onClick={() => save({ caps: edit })}>
            Save Cap Values
          </button>
        </div>
      )}

      <div className="card">
        <h2>OpenSea Verification</h2>
        <p className="muted">
          To check upcoming OpenSea stages, SkyBOT signs OpenSea&apos;s off-chain sign-in message for your wallets (free, no gas, never a
          transaction), which accepts OpenSea&apos;s{" "}
          <a href="https://opensea.io/tos" target="_blank" rel="noreferrer">
            Terms of Service
          </a>
          .
        </p>
      </div>

      <div className="card">
        <h2>Chain Health</h2>
        <button className="ghost" onClick={async () => setHealth(await api("/api/chains/health"))}>
          Run Check
        </button>
        {health && (
          <table style={{ marginTop: 10 }}>
            <thead>
              <tr>
                <th>Chain</th>
                <th>OK</th>
                <th>Block</th>
              </tr>
            </thead>
            <tbody>
              {health.map((h) => (
                <tr key={h.key}>
                  <td>{h.key}</td>
                  <td className={h.ok ? "ok" : "bad"}>{h.ok ? "ok" : h.error}</td>
                  <td className="mono">{h.block}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
