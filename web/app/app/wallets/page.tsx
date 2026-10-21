"use client";
// SPDX-License-Identifier: AGPL-3.0-only
import { short } from "@/lib/api";
import { useEffect, useRef, useState } from "react";
import { useWalletList } from "@/lib/wallets";
import { useCreateWallet, useImportWallet, useWallets, usePrivy } from "@privy-io/react-auth";
import { useApi, useShell } from "@/components/AppShell";
import { ChainSelect } from "@/components/ChainSelect";

export default function WalletsPage() {
  const api = useApi();
  const { createWallet } = useCreateWallet();
  const { importWallet } = useImportWallet();
  const { wallets: privyWallets } = useWallets();
  const { user, authenticated } = usePrivy();
  const { connectPrivy, userId } = useShell();
  const list = useWalletList(api, userId);
  const data = { wallets: list.wallets as any[], groups: list.groups };
  const load = list.reload;
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [key, setKey] = useState("");
  const [label, setLabel] = useState("");
  const [group, setGroup] = useState("");
  const [genN, setGenN] = useState(3);
  const [chain, setChain] = useState("base");
  const [balances, setBalances] = useState<Record<string, string>>({});
  const [balLoading, setBalLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  // Balances load lazily (after the list is on screen), all wallets in parallel server-side, 15 s server cache.
  const balKey = `${chain}:${data.wallets.map((w) => w.id).join(",")}`;
  const lastBalKey = useRef("");
  const loadBalances = async (force = false) => {
    if (!data.wallets.length || (!force && lastBalKey.current === balKey)) return;
    lastBalKey.current = balKey;
    setBalLoading(true);
    try {
      const r = await api("/api/wallets/balances", { body: { chain } });
      setBalances(Object.fromEntries(r.balances.map((b: any) => [b.walletId, b.balance ?? "error"])));
    } catch {
      /* balances are best-effort */
    } finally {
      setBalLoading(false);
    }
  };
  useEffect(() => setBalances({}), [chain]);
  useEffect(() => {
    if (!list.refreshing) void loadBalances();
  }, [balKey, list.refreshing]); // eslint-disable-line

  // Keep server DB in sync with Privy-linked wallets — only when Privy knows a wallet we don't (no reload otherwise).
  useEffect(() => {
    if (list.refreshing) return;
    const known = new Set(data.wallets.map((w) => w.address.toLowerCase()));
    const missing = (privyWallets ?? [])
      .filter((w) => w.walletClientType === "privy" && !known.has(w.address.toLowerCase()))
      .map((w) => ({
        privyWalletId: (w as any).id ?? w.address,
        address: w.address,
        source: "privy",
      }));
    if (!missing.length) return;
    api("/api/wallets/sync", { body: { wallets: missing } })
      .then(load)
      .catch(() => {});
  }, [privyWallets, list.refreshing]); // eslint-disable-line

  const run = async (fn: () => Promise<any>, ok?: string) => {
    setErr(null);
    setMsg(null);
    setBusy(true);
    try {
      await fn();
      if (ok) setMsg(ok);
      await load();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {(err ?? list.err) && <div className="err">{err ?? list.err}</div>}
      {msg && <div className="notice">{msg}</div>}
      <div className="card">
        <h2>
          Wallets ({list.loading ? "…" : data.wallets.length}){" "}
          {list.refreshing && !list.loading && (
            <span className="muted" style={{ fontSize: 13, fontWeight: 400 }}>
              updating…
            </span>
          )}
        </h2>
        <p className="muted">
          Wallets are created and held by Privy. SkyBOT never stores or accepts raw private keys. Import uses Privy in the browser; export
          only via Privy UI. Server signing for scheduled mints needs a session signer (Settings / DEPLOY.md).
        </p>
        <div className="row" style={{ marginBottom: 10 }}>
          <ChainSelect value={chain} onChange={setChain} />
          <button className="ghost" disabled={balLoading} onClick={() => loadBalances(true)}>
            {balLoading ? "Refreshing…" : "Refresh Balances"}
          </button>
        </div>
        <table className="cards">
          <thead>
            <tr>
              <th>Label</th>
              <th>Address</th>
              <th>Group</th>
              <th>Balance</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {data.wallets.map((w) => (
              <tr key={w.id}>
                <td>
                  {w.label} {w.isMain && <span className="pill accent">Main</span>}{" "}
                  <span className="tag">{w.source === "privy" ? "Privy" : w.source}</span>
                </td>
                <td className="mono" title={w.address}>
                  <span className="addr-full">{w.address}</span>
                  <span className="addr-short">{short(w.address)}</span>
                </td>
                <td>{w.group ?? "—"}</td>
                <td className="mono">
                  {balances[w.id] !== undefined ? (
                    balances[w.id] === "error" ? (
                      <span className="muted">unavailable</span>
                    ) : (
                      Number(balances[w.id]).toFixed(5)
                    )
                  ) : (
                    <span className="skeleton" style={{ width: 70 }} />
                  )}
                </td>
                <td className="row actions">
                  {!w.isMain && (
                    <button className="ghost" onClick={() => run(() => api(`/api/wallets/${w.id}/main`, { body: {} }), "Main set")}>
                      Set Main
                    </button>
                  )}
                  <button
                    className="danger"
                    onClick={() => {
                      if (confirm(`Remove ${w.label}?`))
                        run(() => api(`/api/wallets/${w.id}`, { method: "DELETE", body: { confirm: "DELETE" } }), "Removed");
                    }}
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
            {list.loading &&
              [0, 1, 2].map((i) => (
                <tr key={`sk${i}`}>
                  {[90, 260, 50, 70, 120].map((wd, j) => (
                    <td key={j}>
                      <span className="skeleton" style={{ width: wd }} />
                    </td>
                  ))}
                </tr>
              ))}
            {!list.loading && !data.wallets.length && (
              <tr>
                <td colSpan={5} className="muted">
                  No wallets yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(300px,1fr))" }}>
        <div className="card">
          <h2>Create Wallets</h2>
          <p className="muted">Creates Privy embedded wallets owned by you, then syncs them here.</p>
          <div className="row">
            <input type="number" min={1} max={50} value={genN} onChange={(e) => setGenN(Number(e.target.value))} style={{ width: 80 }} />
            <input placeholder="Group (optional)" value={group} onChange={(e) => setGroup(e.target.value)} />
            <button
              disabled={busy}
              onClick={() =>
                run(async () => {
                  // Prefer server-side generation (needs Privy app secret); fall back to client createWallet loop.
                  try {
                    await api("/api/wallets/generate", { body: { count: genN, group: group || null } });
                  } catch {
                    for (let i = 0; i < genN; i++) await createWallet({ createAdditional: true });
                  }
                }, `Created ${genN}`)
              }
            >
              Generate
            </button>
          </div>
        </div>
        <div className="card">
          <h2>Import Private Key</h2>
          <p className="muted">Imported into Privy — SkyBOT only keeps the address + Privy wallet id.</p>
          {!authenticated ? (
            <div style={{ display: "grid", gap: 8 }}>
              <p className="muted">Wallet import runs inside Privy, so it needs a Privy session. Connect with Telegram to continue.</p>
              <button onClick={connectPrivy}>Connect with Privy</button>
            </div>
          ) : (
            <div style={{ display: "grid", gap: 8 }}>
              <input
                type="password"
                autoComplete="off"
                placeholder="0x… private key"
                value={key}
                onChange={(e) => setKey(e.target.value)}
              />
              <input placeholder="Label" value={label} onChange={(e) => setLabel(e.target.value)} />
              <button
                disabled={!key || busy}
                onClick={() =>
                  run(async () => {
                    // Client-side only: Privy encrypts the key to Privy. Never POST raw keys to SkyBOT.
                    const w = await importWallet({ privateKey: key });
                    await api("/api/wallets/sync", {
                      body: {
                        wallets: [
                          {
                            privyWalletId: (w as any).id ?? (w as any).walletId ?? "",
                            address: (w as any).address ?? (w as any).walletClient?.account?.address,
                            label,
                            group: group || null,
                            source: "imported",
                          },
                        ],
                      },
                    });
                    setKey("");
                  }, "Imported via Privy")
                }
              >
                Import via Privy
              </button>
              <p className="muted" style={{ fontSize: 12 }}>
                Export your own key only through Privy&apos;s wallet UI — SkyBOT has no export API.
              </p>
            </div>
          )}
        </div>
        <div className="card">
          <h2>Groups</h2>
          <div className="row">
            <input placeholder="New group" value={group} onChange={(e) => setGroup(e.target.value)} />
            <button className="ghost" onClick={() => run(() => api("/api/groups", { body: { name: group } }), "Group created")}>
              Create
            </button>
          </div>
          <div style={{ marginTop: 10 }}>
            {data.groups.map((g) => (
              <span key={g.name} className="pill" style={{ marginRight: 6 }}>
                {g.name} ({g.count})
              </span>
            ))}
          </div>
          <p className="muted" style={{ marginTop: 12 }}>
            Signed in as {user?.email?.address ?? "—"} · {privyWallets?.length ?? 0} Privy wallet(s) connected
          </p>
        </div>
      </div>
    </>
  );
}
