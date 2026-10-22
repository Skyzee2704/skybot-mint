"use client";
// SPDX-License-Identifier: AGPL-3.0-only
import { CopyAddress } from "@/components/CopyAddress";
import { short } from "@/lib/api";
import { useEffect, useRef, useState } from "react";
import { useWalletList } from "@/lib/wallets";
import {
  ago,
  balancesAsOf,
  balancesFetcher,
  balancesKey,
  revalidate,
  useSWR,
} from "@/lib/swr";
import { useNow } from "@/lib/useNow";
import { useCreateWallet, useExportWallet, useImportWallet, useWallets, usePrivy } from "@privy-io/react-auth";
import { useApi, useShell } from "@/components/AppShell";
import { ChainSelect } from "@/components/ChainSelect";
import Link from "next/link";
import { FundWallets } from "@/components/FundWallets";
import { usePersistedChain } from "@/lib/chainPref";

export default function WalletsPage() {
  const api = useApi();
  const { createWallet } = useCreateWallet();
  const { importWallet } = useImportWallet();
  const { wallets: privyWallets } = useWallets();
  const { user, authenticated } = usePrivy();
  const { connectPrivy, userId } = useShell();
  const list = useWalletList(api, userId);
  // Wallets removed in this session stay hidden even if an in-flight refresh still returns them.
  const goneIds = useRef(new Set<string>());
  const goneAddrs = useRef(new Set<string>());
  const data = { wallets: (list.wallets as any[]).filter((w) => !goneIds.current.has(w.id)) };
  const removedList = list.removedWallets as any[];
  const [removal, setRemoval] = useState<{ w: any; chk: any | null; loading: boolean } | null>(null);
  const load = list.reload;
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [key, setKey] = useState("");
  const [label, setLabel] = useState("");
  const [genN, setGenN] = useState(3);
  const [chain, setChain] = usePersistedChain("balances");
  const [busy, setBusy] = useState(false);
  const now = useNow(5000);

  // Stale-while-revalidate: last balances render instantly (per user, this device), refreshed in the background.
  // The server answers from its 30 s cache unless an Alchemy webhook reported a transfer for that wallet.
  const bal = useSWR(list.loading ? null : balancesKey(chain), balancesFetcher(api, chain), { freshMs: 10_000, asOf: balancesAsOf });
  const balances: Record<string, string> = Object.fromEntries(
    (bal.data?.balances ?? []).map((b: any) => [b.walletId, b.balance ?? "error"]),
  );
  const [manual, setManual] = useState(false);
  const refreshBalances = async () => {
    setManual(true);
    try {
      await revalidate(balancesKey(chain), balancesFetcher(api, chain, true), { force: true, asOf: balancesAsOf });
    } finally {
      setManual(false);
    }
  };
  // A wallet the cached result doesn't know yet (just created / imported): fetch now.
  const walletIdsKey = data.wallets.map((w) => w.id).join(",");
  useEffect(() => {
    if (bal.data && data.wallets.some((w) => !(w.id in balances))) void bal.revalidate(true);
  }, [walletIdsKey, !!bal.data]); // eslint-disable-line
  const balLoading = manual || (bal.validating && !bal.data);

  // Keep server DB in sync with Privy-linked wallets — only when Privy knows a wallet we don't (no reload otherwise).
  useEffect(() => {
    if (list.refreshing) return;
    // Removed / deleted wallets still exist in Privy — never re-sync them (the server refuses too).
    const known = new Set([...list.wallets, ...removedList].map((w: any) => w.address.toLowerCase()).concat([...goneAddrs.current]));
    const missing = (privyWallets ?? [])
      .filter((w) => w.walletClientType === "privy" && !known.has(w.address.toLowerCase()))
      .map((w) => {
        // Connected-wallet objects carry no Privy wallet id; the linked account does (and the server also asks Privy).
        const acct = ((user?.linkedAccounts ?? []) as any[]).find(
          (a) => a?.type === "wallet" && String(a?.address ?? "").toLowerCase() === w.address.toLowerCase(),
        );
        return {
          privyWalletId: acct?.id ?? (w as any).id ?? w.address,
          address: w.address,
          source: "privy",
          imported: Boolean((w as any).imported || acct?.imported),
        };
      });
    if (!missing.length) return;
    api("/api/wallets/sync", { body: { wallets: missing } })
      .then((r: any) => {
        for (const x of r?.wallets ?? []) if (x?.skipped) goneAddrs.current.add(String(x.address).toLowerCase());
        if ((r?.wallets ?? []).some((x: any) => !x?.skipped)) void load();
      })
      .catch(() => {});
  }, [privyWallets, list.refreshing]); // eslint-disable-line

  const startRemoval = async (w: any) => {
    setErr(null);
    setMsg(null);
    setRemoval({ w, chk: null, loading: true });
    try {
      const chk = await api(`/api/wallets/${w.id}/removal-check`);
      setRemoval({ w, chk, loading: false });
    } catch (e: any) {
      setRemoval(null);
      setErr(e.message);
    }
  };
  const removeWallet = async (
    w: any,
    mode: "delete" | "hide",
    opts: { acknowledge?: boolean; confirmLabel?: string; newMainId?: string } = {},
  ) => {
    setBusy(true);
    setErr(null);
    // Optimistic: drop the row now (and from the cache) so it never flashes back.
    goneIds.current.add(w.id);
    goneAddrs.current.add(w.address.toLowerCase());
    list.mutate((d) => ({
      ...d,
      wallets: d.wallets.filter((x) => x.id !== w.id),
      removedWallets: mode === "hide" ? [...(d.removedWallets ?? []), { ...w, removedAt: new Date().toISOString() }] : d.removedWallets,
    }));
    try {
      const r = await api(`/api/wallets/${w.id}`, { method: "DELETE", body: { confirm: "DELETE", mode, ...opts } });
      setMsg(r.message ?? "Wallet removed.");
      setRemoval(null);
    } catch (e: any) {
      goneIds.current.delete(w.id);
      goneAddrs.current.delete(w.address.toLowerCase());
      setErr(e.message);
    } finally {
      await load();
      setBusy(false);
    }
  };

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
          only via Privy UI. Removing a wallet never moves funds: hide it (restorable), or remove it for good, which archives it in Privy
          (wallets that still hold funds need an explicit confirmation).
        </p>
        <div className="row" style={{ marginBottom: 10 }}>
          <ChainSelect value={chain} onChange={setChain} />
          <button className="ghost" disabled={balLoading} onClick={refreshBalances}>
            {manual ? "Refreshing…" : "Refresh Balances"}
          </button>
          <span className="muted small" style={{ minWidth: 120 }}>
            {bal.at ? `Updated ${ago(bal.at, now)}` : ""}
            {bal.validating && bal.data ? " · checking…" : ""}
          </span>
        </div>
        <table className="cards">
          <thead>
            <tr>
              <th>Label</th>
              <th>Address</th>
              <th>Balance</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {data.wallets.map((w) => (
              <tr key={w.id}>
                <td>
                  {w.label} {w.isMain && <span className="pill accent">Main</span>}{" "}
                  <span
                    className="tag"
                    title={w.source === "imported" ? "Imported with a private key (held by Privy)" : "Created by Privy"}
                  >
                    {w.source === "imported" ? "Imported" : "Created"}
                  </span>
                </td>
                <td className="mono" title={w.address}>
                  <span className="addr-full">{w.address}</span>
                  <span className="addr-short">{short(w.address)}</span>
                  <CopyAddress address={w.address} />
                </td>
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
                    <button className="ghost" onClick={() =>
                        run(async () => {
                          list.setMainLocal(w.id);
                          await api(`/api/wallets/${w.id}/main`, { body: {} }).catch(async (e) => {
                            await load(); // undo the optimistic reorder
                            throw e;
                          });
                        }, "Main set")
                      }>
                      Set Main
                    </button>
                  )}
                  <button className="danger" disabled={busy} onClick={() => startRemoval(w)}>
                    Remove
                  </button>
                </td>
              </tr>
            ))}
            {list.loading &&
              [0, 1, 2].map((i) => (
                <tr key={`sk${i}`}>
                  {[90, 260, 70, 120].map((wd, j) => (
                    <td key={j}>
                      <span className="skeleton" style={{ width: wd }} />
                    </td>
                  ))}
                </tr>
              ))}
            {!list.loading && !data.wallets.length && (
              <tr>
                <td colSpan={4} className="muted">
                  No wallets yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        {removal && (
          <RemovalPanel
            removal={removal}
            busy={busy}
            onCancel={() => setRemoval(null)}
            others={data.wallets.filter((x: any) => x.id !== removal.w.id)}
            canExport={authenticated && (privyWallets ?? []).some((x: any) => x.address?.toLowerCase() === removal.w.address.toLowerCase())}
            onRemove={(mode, opts) => removeWallet(removal.w, mode, opts)}
          />
        )}
        {removedList.length > 0 && (
          <details style={{ marginTop: 12 }}>
            <summary className="muted">Removed wallets ({removedList.length})</summary>
            <p className="muted small">Hidden from SkyBOT. They stay in your Privy account with their funds.</p>
            <table>
              <tbody>
                {removedList.map((w: any) => (
                  <tr key={w.id}>
                    <td>{w.label}</td>
                    <td className="mono">
                      {short(w.address)} <CopyAddress address={w.address} />
                    </td>
                    <td>
                      <button
                        className="ghost"
                        disabled={busy}
                        onClick={() =>
                          run(
                            async () => {
                              goneIds.current.delete(w.id);
                              await api(`/api/wallets/${w.id}/restore`, { body: {} });
                            },
                            `${w.label || "Wallet"} restored`,
                          )
                        }
                      >
                        Restore
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        )}
      </div>

      <FundWallets api={api} wallets={data.wallets} />

      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(300px,1fr))" }}>
        <div className="card">
          <h2>Create Wallets</h2>
          <p className="muted">Creates Privy embedded wallets owned by you, then syncs them here.</p>
          <div className="row">
            <input type="number" min={1} max={50} value={genN} onChange={(e) => setGenN(Number(e.target.value))} style={{ width: 80 }} />
            <button
              disabled={busy}
              onClick={() =>
                run(async () => {
                  // Prefer server-side generation (needs Privy app secret); fall back to client createWallet loop.
                  try {
                    await api("/api/wallets/generate", { body: { count: genN } });
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
                            imported: true,
                            address: (w as any).address ?? (w as any).walletClient?.account?.address,
                            label,
                            source: "imported",
                            restore: true,
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
                Keys are exported only in Privy&apos;s own window (Export Private Key in the remove dialog, or home.privy.io); SkyBOT never sees them.
              </p>
              <p className="muted" style={{ fontSize: 12 }}>
                Signed in as {user?.email?.address ?? "—"} · {privyWallets?.length ?? 0} Privy wallet(s) connected
              </p>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function RemovalPanel({
  removal,
  busy,
  others,
  canExport,
  onCancel,
  onRemove,
}: {
  removal: { w: any; chk: any | null; loading: boolean };
  busy: boolean;
  others: any[];
  canExport: boolean;
  onCancel: () => void;
  onRemove: (mode: "delete" | "hide", opts: { acknowledge?: boolean; confirmLabel?: string; newMainId?: string }) => void;
}) {
  const { w, chk, loading } = removal;
  const { exportWallet } = useExportWallet();
  const [ack, setAck] = useState(false);
  const [newMain, setNewMain] = useState<string>(others[0]?.id ?? "");
  const [exportErr, setExportErr] = useState<string | null>(null);
  const funded: any[] = chk?.funded ?? [];
  const unchecked: any[] = chk?.unchecked ?? [];
  const nfts = Number(chk?.heldNfts ?? 0) + Number(chk?.mintedNfts ?? 0);
  const fmt = (f: any) =>
    `${Number(f.balance)
      .toFixed(6)
      .replace(/\.?0+$/, "")} ${f.symbol}`;
  const archive = chk?.deleteMode === "archive_and_delete";
  const hideOnly = chk?.deleteMode === "hide_only";
  const needsConfirm = Boolean(chk?.requiresConfirmation);
  const confirmed = !needsConfirm || ack;
  const mainOpts = w.isMain && others.length ? { newMainId: newMain || undefined } : {};
  return (
    <div className="notice removal" role="dialog" aria-label={`Remove ${w.label}`} style={{ marginTop: 12 }}>
      <b>
        Remove {w.label || "wallet"} <span className="mono muted">{short(w.address)}</span>
        {chk?.walletKind && chk.walletKind !== "unknown" && (
          <span className="pill" style={{ marginLeft: 6 }}>
            {chk.walletKind === "imported" ? "Imported" : chk.walletKind === "primary" ? "Primary Privy wallet" : "Created"}
          </span>
        )}
      </b>
      {loading && <p className="muted">Checking balances on all chains…</p>}
      {chk && (
        <>
          {funded.length > 0 || unchecked.length > 0 || nfts > 0 ? (
            <div className="warn">
              <p style={{ margin: "6px 0" }}>This wallet still holds:</p>
              <ul style={{ margin: "0 0 6px 18px" }}>
                {funded.map((f) => (
                  <li key={f.chain}>
                    {fmt(f)} on {f.chainName}
                  </li>
                ))}
                {unchecked.map((u) => (
                  <li key={u.chain}>Unknown balance on {u.chainName} (couldn&apos;t be read)</li>
                ))}
                {nfts > 0 && <li>{nfts} NFT(s) per the last holdings scan</li>}
              </ul>
              <div className="row">
                {funded.length > 0 && (
                  <Link className="button ghost" href={`/app/withdraw?wallet=${encodeURIComponent(w.id)}`}>
                    Withdraw first
                  </Link>
                )}
                {nfts > 0 && (
                  <Link className="button ghost" href="/app/nfts">
                    Send NFTs first
                  </Link>
                )}
              </div>
            </div>
          ) : (
            <p>Empty on all {chk.balances.length} chains.</p>
          )}
          {(chk.warnings ?? []).map((n: string) => (
            <p key={n} className={chk.walletKind === "created" ? "bad" : ""} style={{ margin: "6px 0" }}>
              {n}
            </p>
          ))}
          {archive && chk.walletKind !== "imported" && (
            <div className="row">
              <button
                className="ghost"
                disabled={!canExport}
                title={canExport ? "" : "Connect with Privy in this browser to export"}
                onClick={async () => {
                  setExportErr(null);
                  try {
                    await exportWallet({ address: w.address });
                  } catch (e: any) {
                    setExportErr(e?.message ?? "Export failed");
                  }
                }}
              >
                Export Private Key (Privy)
              </button>
              {!canExport && <span className="muted small">Connect with Privy in a browser to export, or use home.privy.io.</span>}
              {exportErr && <span className="bad small">{exportErr}</span>}
            </div>
          )}
          {(chk.notes ?? []).map((n: string) => (
            <p key={n} className="muted small">
              {n}
            </p>
          ))}
          {w.isMain && others.length > 0 && (
            <label className="row" style={{ gap: 8 }}>
              <span>New Main wallet</span>
              <select value={newMain} onChange={(e) => setNewMain(e.target.value)} style={{ width: "auto" }}>
                {others.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label} ({short(o.address)})
                  </option>
                ))}
              </select>
            </label>
          )}
          {needsConfirm && !hideOnly && (
            <div style={{ margin: "8px 0" }}>
              <label className="confirm-check">
                <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                <span>I understand funds and NFTs left in this wallet will no longer be accessible from SkyBOT.</span>
              </label>
            </div>
          )}
          <div className="row">
            {!hideOnly && (
              <button
                className="danger"
                disabled={busy || !confirmed}
                onClick={() => {
                  if (needsConfirm || confirm(`Remove ${w.label || "this wallet"} permanently? This can't be undone in SkyBOT.`))
                    onRemove("delete", { ...(needsConfirm ? { acknowledge: ack } : {}), ...mainOpts });
                }}
              >
                {archive ? "Remove and Archive in Privy" : "Remove from SkyBOT"}
              </button>
            )}
            <button className={hideOnly ? "" : "ghost"} disabled={busy} onClick={() => onRemove("hide", mainOpts)}>
              Hide from SkyBOT (restorable)
            </button>
            <button className="ghost" disabled={busy} onClick={onCancel}>
              Cancel
            </button>
          </div>
        </>
      )}
    </div>
  );
}
