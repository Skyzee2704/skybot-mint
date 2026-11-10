"use client";
// SPDX-License-Identifier: AGPL-3.0-only
import { CopyAddress } from "@/components/CopyAddress";
import { short } from "@/lib/api";
import { useEffect, useRef, useState } from "react";
import { useWalletList } from "@/lib/wallets";
import { ago, balancesAsOf, balancesFetcher, balancesKey, revalidate, useSWR } from "@/lib/swr";
import { useNow } from "@/lib/useNow";
import { useCreateWallet, useExportWallet, useImportWallet, useWallets, usePrivy } from "@privy-io/react-auth";
import { useApi, useShell } from "@/components/AppShell";
import { ChainSelect } from "@/components/ChainSelect";
import Link from "next/link";
import { FundWallets } from "@/components/FundWallets";
import { usePersistedChain } from "@/lib/chainPref";
import { useLang } from "@/lib/i18n";
import {
  BULK_IMPORT_MAX_KEYS,
  explainImportError,
  nextLabelIndex,
  normalizePrivateKey,
  parseBulkKeys,
  signImportCheck,
} from "@/lib/importCheck";

export default function WalletsPage() {
  const api = useApi();
  const { t } = useLang();
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
  // Compact list: search + 10 per page, so 50 wallets don't stretch the page.
  const PAGE_SIZE = 10;
  const [walletQuery, setWalletQuery] = useState("");
  const [walletPage, setWalletPage] = useState(1);
  const filteredWallets = data.wallets.filter(
    (w) => !walletQuery.trim() || `${w.label ?? ""} ${w.address}`.toLowerCase().includes(walletQuery.trim().toLowerCase()),
  );
  const pageCount = Math.max(1, Math.ceil(filteredWallets.length / PAGE_SIZE));
  const safePage = Math.min(walletPage, pageCount);
  const pageWallets = filteredWallets.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);
  const removedList = list.removedWallets as any[];
  const [removal, setRemoval] = useState<{ w: any; chk: any | null; loading: boolean } | null>(null);
  const load = list.reload;
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [key, setKey] = useState("");
  const [label, setLabel] = useState("");
  const [genN, setGenN] = useState(3);
  const [bulkKeys, setBulkKeys] = useState("");
  const [bulkPrefix, setBulkPrefix] = useState("");
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number } | null>(null);
  const [bulkResults, setBulkResults] = useState<
    { line: number; address: string; label: string; status: "imported" | "already" | "failed"; detail: string }[]
  >([]);
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
      setMsg(r.message ?? t("Wallet removed."));
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
      const r = await fn();
      if (typeof r === "string") setMsg(r);
      else if (ok) setMsg(ok);
      await load();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  // Bulk import: each pasted key goes through the same client-side Privy flow as a single import
  // (normalize -> local import-check signature -> importWallet), then one batch sync at the end.
  // Raw keys are never POSTed to SkyBOT; only addresses + Privy wallet ids are synced.
  const bulkImport = async () => {
    const keys = parseBulkKeys(bulkKeys);
    if (!keys.length) {
      setErr(t("Paste at least one private key."));
      return;
    }
    if (keys.length > BULK_IMPORT_MAX_KEYS) {
      setErr(t("Bulk import is limited to {max} keys at a time.", { max: BULK_IMPORT_MAX_KEYS }));
      return;
    }
    setErr(null);
    setMsg(null);
    setBulkBusy(true);
    setBulkResults([]);
    setBulkProgress({ done: 0, total: keys.length });
    const toSync: any[] = [];
    const results: { line: number; address: string; label: string; status: "imported" | "already" | "failed"; detail: string }[] = [];
    // Continue the label numbering from the labels already in use (WL-1..WL-3 exist -> start at WL-4).
    const startAt = bulkPrefix
      ? nextLabelIndex(
          (list.wallets as any[]).map((w) => String(w.label ?? "")),
          bulkPrefix,
        )
      : 1;
    for (let i = 0; i < keys.length; i++) {
      const label = bulkPrefix ? `${bulkPrefix}-${startAt + i}` : "";
      let address = "";
      try {
        const pk = normalizePrivateKey(keys[i]);
        const chk = await signImportCheck(pk)
          .then((proof) => api("/api/wallets/import-check", { body: proof }))
          .catch(() => ({ status: "unknown" }) as any);
        if (chk.message && chk.status !== "available" && chk.status !== "in_your_account") throw new Error(chk.message);
        address = chk.address ?? "";
        if (chk.status === "in_your_account") {
          // Already this account's wallet in Privy (e.g. hidden in SkyBOT earlier): add it back, no import.
          toSync.push({ privyWalletId: chk.privyWalletId ?? "", address: chk.address, label, restore: true });
          results.push({
            line: i + 1,
            address: chk.address,
            label,
            status: "already",
            detail: t("Already in your Privy account — added back."),
          });
        } else {
          let w: any;
          try {
            w = await importWallet({ privateKey: pk });
          } catch (e: any) {
            throw new Error(explainImportError(e));
          }
          const addr = (w as any).address ?? (w as any).walletClient?.account?.address ?? chk.address ?? "";
          address = addr;
          toSync.push({
            privyWalletId: (w as any).id ?? (w as any).walletId ?? "",
            imported: true,
            address: addr,
            label,
            source: "imported",
            restore: true,
          });
          results.push({ line: i + 1, address: addr, label, status: "imported", detail: t("Imported via Privy.") });
        }
      } catch (e: any) {
        results.push({ line: i + 1, address, label, status: "failed", detail: e?.message ?? "Import failed." });
      }
      setBulkProgress({ done: i + 1, total: keys.length });
      setBulkResults([...results]);
    }
    if (toSync.length) {
      try {
        await api("/api/wallets/sync", { body: { wallets: toSync } });
      } catch (e: any) {
        setErr(
          t("Imported {count} wallet(s) in Privy, but syncing them to SkyBOT failed: {error}", {
            count: toSync.length,
            error: e?.message ?? e,
          }),
        );
      }
    }
    setBulkKeys(""); // don't leave pasted keys in the page
    setBulkBusy(false);
    setBulkProgress(null);
    const ok = results.filter((r) => r.status !== "failed").length;
    const failed = results.length - ok;
    setMsg(t("Bulk import finished: {ok} imported/added back, {failed} failed.", { ok, failed }));
    await load();
  };

  return (
    <>
      {(err ?? list.err) && <div className="err">{err ?? list.err}</div>}
      {msg && <div className="notice">{msg}</div>}
      <div className="card">
        <h2>
          {list.loading ? t("Wallets ({count})", { count: "…" }) : t("Wallets ({count})", { count: data.wallets.length })}{" "}
          {list.refreshing && !list.loading && (
            <span className="muted" style={{ fontSize: 13, fontWeight: 400 }}>
              {t("updating…")}
            </span>
          )}
        </h2>
        <p className="muted">{t("Wallets are held by Privy. SkyBOT never sees your private keys. Removing a wallet never moves funds.")}</p>
        <div className="row" style={{ marginBottom: 10 }}>
          <ChainSelect value={chain} onChange={setChain} />
          <button className="ghost" disabled={balLoading} onClick={refreshBalances}>
            {manual ? t("Refreshing…") : t("Refresh Balances")}
          </button>
          <span className="muted small" style={{ minWidth: 120 }}>
            {bal.at ? t("Updated {time}", { time: ago(bal.at, now) }) : ""}
            {bal.validating && bal.data ? ` · ${t("checking…")}` : ""}
          </span>
          <span className="spacer" />
          <input
            placeholder={t("Search wallets…")}
            value={walletQuery}
            onChange={(e) => {
              setWalletQuery(e.target.value);
              setWalletPage(1);
            }}
            style={{ width: 180 }}
            aria-label={t("Search wallets…")}
          />
        </div>
        <table className="cards">
          <thead>
            <tr>
              <th>{t("Label")}</th>
              <th>{t("Address")}</th>
              <th>{t("Balance")}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {pageWallets.map((w) => (
              <tr key={w.id}>
                <td>
                  {w.label} {w.isMain && <span className="pill accent">{t("Main")}</span>}{" "}
                  <span
                    className="tag"
                    title={w.source === "imported" ? t("Imported with a private key (held by Privy)") : t("Created by Privy")}
                  >
                    {w.source === "imported" ? t("Imported") : t("Created")}
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
                      <span className="muted">{t("unavailable")}</span>
                    ) : (
                      `${Number(balances[w.id]).toFixed(5)} ${bal.data?.nativeSymbol ?? ""}`.trim()
                    )
                  ) : (
                    <span className="skeleton" style={{ width: 70 }} />
                  )}
                </td>
                <td className="row actions">
                  {!w.isMain && (
                    <button
                      className="ghost"
                      onClick={() =>
                        run(async () => {
                          list.setMainLocal(w.id);
                          await api(`/api/wallets/${w.id}/main`, { body: {} }).catch(async (e) => {
                            await load(); // undo the optimistic reorder
                            throw e;
                          });
                        }, t("Main set"))
                      }
                    >
                      {t("Set Main")}
                    </button>
                  )}
                  <button className="danger" disabled={busy} onClick={() => startRemoval(w)}>
                    {t("Remove")}
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
                  {t("No wallets yet.")}
                </td>
              </tr>
            )}
            {!list.loading && data.wallets.length > 0 && !filteredWallets.length && (
              <tr>
                <td colSpan={4} className="muted">
                  {t("No wallets match this search.")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
        {pageCount > 1 && (
          <div className="row" style={{ marginTop: 10, justifyContent: "space-between" }}>
            <button className="ghost" disabled={safePage <= 1} onClick={() => setWalletPage(safePage - 1)}>
              ← {t("Previous")}
            </button>
            <span className="muted small">
              {t("Page {page} of {pages}", { page: safePage, pages: pageCount })} ·{" "}
              {t("{count} wallet(s) found", { count: filteredWallets.length })}
            </span>
            <button className="ghost" disabled={safePage >= pageCount} onClick={() => setWalletPage(safePage + 1)}>
              {t("Next")} →
            </button>
          </div>
        )}
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
            <summary className="muted">{t("Removed wallets ({count})", { count: removedList.length })}</summary>
            <p className="muted small">{t("Hidden from SkyBOT. They stay in your Privy account with their funds.")}</p>
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
                            t("{label} restored", { label: w.label || "Wallet" }),
                          )
                        }
                      >
                        {t("Restore")}
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
          <h2>{t("Create Wallets")}</h2>
          <p className="muted">{t("Creates Privy embedded wallets owned by you, then syncs them here.")}</p>
          <div className="row">
            <input type="number" min={1} max={50} value={genN} onChange={(e) => setGenN(Number(e.target.value))} style={{ width: 80 }} />
            <button
              disabled={busy}
              onClick={() =>
                run(
                  async () => {
                    // Prefer server-side generation (needs Privy app secret); fall back to client createWallet loop.
                    try {
                      await api("/api/wallets/generate", { body: { count: genN } });
                    } catch {
                      for (let i = 0; i < genN; i++) await createWallet({ createAdditional: true });
                    }
                  },
                  t("Created {count}", { count: genN }),
                )
              }
            >
              {t("Generate")}
            </button>
          </div>
        </div>
        <div className="card">
          <h2>{t("Import Private Key")}</h2>
          <p className="muted">{t("Imported into Privy — SkyBOT only keeps the address + Privy wallet id.")}</p>
          {!authenticated ? (
            <div style={{ display: "grid", gap: 8 }}>
              <p className="muted">
                {t("Wallet import runs inside Privy, so it needs a Privy session. Connect with Telegram to continue.")}
              </p>
              <button onClick={connectPrivy}>{t("Connect with Privy")}</button>
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
              <input placeholder={t("Label")} value={label} onChange={(e) => setLabel(e.target.value)} />
              <button
                disabled={!key || busy}
                onClick={() =>
                  run(async () => {
                    // Client-side only: Privy encrypts the key to Privy. Never POST raw keys to SkyBOT.
                    const pk = normalizePrivateKey(key);
                    // Ask first what Privy has for this address; the key only signs a check message locally.
                    const chk = await signImportCheck(pk)
                      .then((proof) => api("/api/wallets/import-check", { body: proof }))
                      .catch(() => ({ status: "unknown" }) as any);
                    if (chk.message && chk.status !== "available" && chk.status !== "in_your_account") throw new Error(chk.message);
                    if (chk.status === "in_your_account") {
                      // Already this account's wallet in Privy (e.g. hidden in SkyBOT earlier): add it back, no import.
                      await api("/api/wallets/sync", {
                        body: { wallets: [{ privyWalletId: chk.privyWalletId ?? "", address: chk.address, label, restore: true }] },
                      });
                      setKey("");
                      return t("This wallet is already in your Privy account: added it back to SkyBOT Mint.");
                    }
                    let w: any;
                    try {
                      w = await importWallet({ privateKey: pk });
                    } catch (e: any) {
                      throw new Error(explainImportError(e));
                    }
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
                  }, t("Imported via Privy"))
                }
              >
                {t("Import via Privy")}
              </button>
              <p className="muted" style={{ fontSize: 12 }}>
                {t(
                  "Keys are exported only in Privy's own window (Export Private Key in the remove dialog, or home.privy.io); SkyBOT never sees them.",
                )}
              </p>
              <p className="muted" style={{ fontSize: 12 }}>
                {t("Signed in as {account} · {count} Privy wallet(s) connected", {
                  account: user?.email?.address ?? "—",
                  count: privyWallets?.length ?? 0,
                })}
              </p>
            </div>
          )}
        </div>
        <div className="card">
          <h2>{t("Bulk Import Private Keys")}</h2>
          <p className="muted">
            {t(
              "Paste many private keys, one per line (max {max}). Each goes through the same Privy import as a single key — SkyBOT only keeps the address + Privy wallet id.",
              { max: BULK_IMPORT_MAX_KEYS },
            )}
          </p>
          {!authenticated ? (
            <div style={{ display: "grid", gap: 8 }}>
              <p className="muted">
                {t("Wallet import runs inside Privy, so it needs a Privy session. Connect with Telegram to continue.")}
              </p>
              <button onClick={connectPrivy}>{t("Connect with Privy")}</button>
            </div>
          ) : (
            <div style={{ display: "grid", gap: 8 }}>
              <textarea
                rows={6}
                autoComplete="off"
                spellCheck={false}
                placeholder={"0x… private key\n0x… private key\n…"}
                value={bulkKeys}
                onChange={(e) => setBulkKeys(e.target.value)}
                style={{ fontFamily: "monospace", resize: "vertical" }}
              />
              <input
                placeholder={t("Label prefix (optional, e.g. WL)")}
                value={bulkPrefix}
                onChange={(e) => setBulkPrefix(e.target.value)}
              />
              <button disabled={!bulkKeys.trim() || bulkBusy} onClick={bulkImport}>
                {bulkBusy && bulkProgress
                  ? t("Importing {done}/{total}…", { done: bulkProgress.done, total: bulkProgress.total })
                  : t("Import All via Privy")}
              </button>
              {bulkResults.length > 0 && (
                <div>
                  <p className="muted small" style={{ margin: "4px 0" }}>
                    {t("{imported} imported · {already} already in account · {failed} failed", {
                      imported: bulkResults.filter((r) => r.status === "imported").length,
                      already: bulkResults.filter((r) => r.status === "already").length,
                      failed: bulkResults.filter((r) => r.status === "failed").length,
                    })}
                  </p>
                  <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
                    {bulkResults.map((r, i) => (
                      <li key={i}>
                        <span className="mono">{r.address ? short(r.address) : `line ${r.line}`}</span>
                        {r.label ? ` (${r.label})` : ""} —{" "}
                        {r.status === "imported" ? t("imported") : r.status === "already" ? t("already in account") : t("failed")}:{" "}
                        {r.detail}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <p className="muted" style={{ fontSize: 12 }}>
                {t(
                  "Keys are sent only to Privy in your browser, never to SkyBOT's server. The pasted keys are cleared when the import finishes.",
                )}
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
  const { t } = useLang();
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
    <div className="notice removal" role="dialog" aria-label={t("Remove {label}", { label: w.label })} style={{ marginTop: 12 }}>
      <b>
        {t("Remove {label}", { label: w.label || "wallet" })} <span className="mono muted">{short(w.address)}</span>
        {chk?.walletKind && chk.walletKind !== "unknown" && (
          <span className="pill" style={{ marginLeft: 6 }}>
            {chk.walletKind === "imported" ? t("Imported") : chk.walletKind === "primary" ? t("Primary Privy wallet") : t("Created")}
          </span>
        )}
      </b>
      {loading && <p className="muted">{t("Checking balances on all chains…")}</p>}
      {chk && (
        <>
          {funded.length > 0 || unchecked.length > 0 || nfts > 0 ? (
            <div className="warn">
              <p style={{ margin: "6px 0" }}>{t("This wallet still holds:")}</p>
              <ul style={{ margin: "0 0 6px 18px" }}>
                {funded.map((f) => (
                  <li key={f.chain}>
                    {fmt(f)} on {f.chainName}
                  </li>
                ))}
                {unchecked.map((u) => (
                  <li key={u.chain}>{t("Unknown balance on {chain} (couldn't be read)", { chain: u.chainName })}</li>
                ))}
                {nfts > 0 && <li>{t("{count} NFT(s) per the last holdings scan", { count: nfts })}</li>}
              </ul>
              <div className="row">
                {funded.length > 0 && (
                  <Link className="button ghost" href={`/app/withdraw?wallet=${encodeURIComponent(w.id)}`}>
                    {t("Withdraw first")}
                  </Link>
                )}
                {nfts > 0 && (
                  <Link className="button ghost" href="/app/nfts">
                    {t("Send NFTs first")}
                  </Link>
                )}
              </div>
            </div>
          ) : (
            <p>{t("Empty on all {count} chains.", { count: chk.balances.length })}</p>
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
                title={canExport ? "" : t("Connect with Privy in this browser to export")}
                onClick={async () => {
                  setExportErr(null);
                  try {
                    await exportWallet({ address: w.address });
                  } catch (e: any) {
                    setExportErr(e?.message ?? t("Export failed"));
                  }
                }}
              >
                {t("Export Private Key (Privy)")}
              </button>
              {!canExport && <span className="muted small">{t("Connect with Privy in a browser to export, or use home.privy.io.")}</span>}
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
              <span>{t("New Main wallet")}</span>
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
                <span>{t("I understand funds and NFTs left in this wallet will no longer be accessible from SkyBOT.")}</span>
              </label>
            </div>
          )}
          <div className="row">
            {!hideOnly && (
              <button
                className="danger"
                disabled={busy || !confirmed}
                onClick={() => {
                  if (
                    needsConfirm ||
                    confirm(t("Remove {label} permanently? This can't be undone in SkyBOT.", { label: w.label || "this wallet" }))
                  )
                    onRemove("delete", { ...(needsConfirm ? { acknowledge: ack } : {}), ...mainOpts });
                }}
              >
                {archive ? t("Remove and Archive in Privy") : t("Remove from SkyBOT")}
              </button>
            )}
            <button className={hideOnly ? "" : "ghost"} disabled={busy} onClick={() => onRemove("hide", mainOpts)}>
              {t("Hide from SkyBOT (restorable)")}
            </button>
            <button className="ghost" disabled={busy} onClick={onCancel}>
              {t("Cancel")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
