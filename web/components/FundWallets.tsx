"use client";
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Fund Wallets: split native coin from the Main wallet evenly across the member's other wallets.
 * Sequential transfers from ONE sender (consecutive nonces), each signed by the member's Privy wallet in this
 * browser and verified by the server against the reviewed quote before broadcasting. Web and Mini App only.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { usePrivy, useSignTransaction } from "@privy-io/react-auth";
import { CopyAddress } from "@/components/CopyAddress";
import { ChainSelect } from "@/components/ChainSelect";
import { fmtEth, fmtNative, short } from "@/lib/api";
import { assertSignableChain, withSignTimeout } from "@/lib/signing";
import { balancesAsOf, balancesFetcher, balancesKey, revalidate } from "@/lib/swr";
import type { useApi } from "@/components/AppShell";
import { usePersistedChain } from "@/lib/chainPref";
import { useLang } from "@/lib/i18n";
import { ScrollArea } from "@/components/ScrollArea";

type W = { id: string; label: string; address: string; isMain: boolean };
type Status = "queued" | "signing" | "sent" | "confirmed" | "failed" | "skipped";
type RunState = Record<string, { status: Status; hash?: string; explorer?: string; error?: string }>;

/** Decimal native amount → wei (no float rounding); null when invalid. */
export function toWei(v: string, decimals = 18): bigint | null {
  const s = v.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const [w, f = ""] = s.split(".");
  if (f.length > decimals) return null;
  return BigInt(w) * 10n ** BigInt(decimals) + BigInt((f + "0".repeat(decimals)).slice(0, decimals) || "0");
}

export function FundWallets({ api, wallets, onDone }: { api: ReturnType<typeof useApi>; wallets: W[]; onDone?: () => void }) {
  const { authenticated } = usePrivy();
  const { t } = useLang();
  const { signTransaction } = useSignTransaction();
  const main = wallets.find((w) => w.isMain) ?? null;
  const others = useMemo(() => wallets.filter((w) => !w.isMain), [wallets]);
  const [chain, setChain] = usePersistedChain("fund");
  const [mainBal, setMainBal] = useState<string | null | undefined>(undefined);
  const [balSymbol, setBalSymbol] = useState("");
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [amount, setAmount] = useState("");
  const [max, setMax] = useState(false);
  const [quote, setQuote] = useState<any>(null);
  const [checked, setChecked] = useState(false);
  const [run, setRun] = useState<RunState>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // Compact picker: search + scrollable list, so 50 wallets don't stretch the page.
  const [pickQuery, setPickQuery] = useState("");
  const visibleOthers = others.filter(
    (w) => !pickQuery.trim() || `${w.label ?? ""} ${w.address}`.toLowerCase().includes(pickQuery.trim().toLowerCase()),
  );
  const stopRef = useRef<AbortController | null>(null);

  const ids = others.filter((w) => picked[w.id]).map((w) => w.id);
  const all = others.length > 0 && ids.length === others.length;
  const running = Object.values(run).some((r) => ["queued", "signing", "sent"].includes(r.status));
  const signingNow = Object.values(run).some((r) => r.status === "signing" || r.status === "queued");
  const reset = () => {
    setQuote(null);
    setChecked(false);
    setRun({});
  };

  const loadMain = async (fresh = false) => {
    if (!main) return;
    setMainBal(undefined);
    try {
      const r = await api("/api/wallets/balances", { body: { chain, walletIds: [main.id], ...(fresh ? { fresh: true } : {}) } });
      setBalSymbol(r.nativeSymbol ?? "");
      setMainBal(r.balances?.[0]?.balanceWei ?? null);
    } catch {
      setMainBal(null);
    }
  };
  useEffect(() => {
    reset();
    void loadMain();
  }, [chain, main?.id]); // eslint-disable-line

  const totalWei = max ? null : toWei(amount);
  const perPreview = totalWei !== null && totalWei > 0n && ids.length ? totalWei / BigInt(ids.length) : null;
  const remPreview = perPreview !== null && totalWei !== null ? totalWei - perPreview * BigInt(ids.length) : 0n;
  const overBalance = totalWei !== null && typeof mainBal === "string" && totalWei > BigInt(mainBal);
  const canReview = !!main && ids.length > 0 && (max || (totalWei !== null && totalWei > 0n)) && !busy && !running;

  const review = async (only?: string[], amountWei?: string) => {
    setErr(null);
    reset();
    setBusy(t("Preparing transfers…"));
    try {
      const q = await api("/api/fund/quote", {
        body: {
          chain,
          walletIds: only ?? (all ? "all" : ids),
          ...(amountWei ? { amountWei } : { amount: max ? "max" : amount.trim() }),
        },
      });
      setQuote(q);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(null);
    }
  };

  const poll = async (walletId: string, hash: string, chainKey: string) => {
    for (let i = 0; i < 45; i++) {
      await new Promise((r) => setTimeout(r, Math.min(10_000, 3000 + i * 1000)));
      try {
        const s = (await api("/api/tx/status", { body: { chain: chainKey, hashes: [hash] } })).statuses[0];
        if (s && s.status !== "pending") {
          setRun((r) => (r[walletId] ? { ...r, [walletId]: { ...r[walletId], status: s.status } } : r));
          return;
        }
      } catch {
        /* keep polling */
      }
    }
  };

  const refreshAfter = async () => {
    await revalidate(balancesKey(quote.chain), balancesFetcher(api, quote.chain, true), { force: true, asOf: balancesAsOf }).catch(
      () => {},
    );
    void loadMain();
    onDone?.();
  };

  const send = async () => {
    setErr(null);
    const items = quote.items as any[];
    setRun(Object.fromEntries(items.map((i) => [i.walletId, { status: "queued" as Status }])));
    const stop = new AbortController();
    stopRef.current = stop;
    // One sender, consecutive nonces: after a failure or Stop, later transfers would be stuck, so they are not sent.
    let halted: string | null = null;
    for (const it of items) {
      if (stop.signal.aborted) halted ??= t("stopped before signing");
      if (halted) {
        setRun((r) => ({ ...r, [it.walletId]: { status: "skipped", error: halted! } }));
        continue;
      }
      setRun((r) => ({ ...r, [it.walletId]: { status: "signing" } }));
      try {
        assertSignableChain(it.tx.chainId);
        const { signature } = await withSignTimeout(
          signTransaction(
            {
              to: it.tx.to,
              value: it.tx.value,
              nonce: it.tx.nonce,
              gasLimit: it.tx.gasLimit,
              gasPrice: it.tx.gasPrice,
              chainId: it.tx.chainId,
              type: 0,
              data: "0x",
            },
            { address: quote.main.address, uiOptions: { showWalletUIs: false } },
          ),
          { signal: stop.signal, what: "Wallet signature" },
        );
        if (stop.signal.aborted) throw new Error(t("Stopped. Nothing was sent."));
        const r = await api("/api/fund/send", {
          body: { chain: quote.chain, walletId: it.walletId, tx: it.tx, quoteToken: it.quoteToken, signed: signature },
        });
        setRun((s) => ({ ...s, [it.walletId]: { status: "sent", hash: r.hash, explorer: r.explorer } }));
        void poll(it.walletId, r.hash, quote.chain);
      } catch (e: any) {
        setRun((s) => ({ ...s, [it.walletId]: { status: "failed", error: String(e?.message ?? e).slice(0, 200) } }));
        halted = t("not sent because an earlier transfer did not go through");
      }
    }
    stopRef.current = null;
    void refreshAfter();
  };

  const unsent = ((quote?.items ?? []) as any[])
    .filter((i) => run[i.walletId] && ["failed", "skipped"].includes(run[i.walletId].status))
    .map((i) => i.walletId as string);
  const sentCount = Object.values(run).filter((r) => r.status === "sent" || r.status === "confirmed").length;
  const sym = quote?.nativeSymbol ?? balSymbol;

  if (!main)
    return (
      <div className="card">
        <h2>{t("Fund Wallets")}</h2>
        <p className="muted">{t("Set a Main wallet first. Fund Wallets always sends from your Main wallet.")}</p>
      </div>
    );

  return (
    <div className="card">
      <h2>{t("Fund Wallets")}</h2>
      <p className="muted">
        {t(
          "Split native coin from your Main wallet evenly across your other wallets. Each transfer is signed by your Privy wallet in this browser, and SkyBOT checks it matches what you reviewed before broadcasting.",
        )}
      </p>
      <div className="row">
        <ChainSelect value={chain} onChange={setChain} />
        <span>
          {t("From")} <b>{main.label}</b> <span className="mono muted">{short(main.address)}</span> <CopyAddress address={main.address} />
        </span>
        <span className="mono">
          {mainBal === undefined ? (
            <span className="skeleton" style={{ width: 70 }} />
          ) : mainBal === null ? (
            <span className="muted">{t("balance unavailable")}</span>
          ) : (
            t("Balance {amount}", { amount: fmtNative(mainBal, sym, 6) })
          )}
        </span>
      </div>

      {others.length === 0 ? (
        <p className="muted" style={{ marginTop: 10 }}>
          {t("Add another wallet to fund it from Main.")}
        </p>
      ) : (
        <>
          <div className="row" style={{ marginTop: 10 }}>
            <label className="row" style={{ gap: 6 }}>
              <input
                type="checkbox"
                checked={all}
                onChange={(e) => {
                  setPicked(e.target.checked ? Object.fromEntries(others.map((w) => [w.id, true])) : {});
                  reset();
                }}
                style={{ width: "auto" }}
              />
              {t("Send to all ({count})", { count: others.length })}
            </label>
            <span className="spacer" />
            <span className="muted">{t("{selected} of {total} selected", { selected: ids.length, total: others.length })}</span>
          </div>
          <div className="row" style={{ marginTop: 8 }}>
            <input
              placeholder={t("Search wallets to fund…")}
              value={pickQuery}
              onChange={(e) => setPickQuery(e.target.value)}
              style={{ flex: 1, minWidth: 200 }}
              aria-label={t("Search wallets to fund…")}
            />
          </div>
          <ScrollArea className="wallet-pick">
            {visibleOthers.map((w) => (
              <label key={w.id} className={picked[w.id] ? "on" : ""}>
                <input
                  type="checkbox"
                  checked={Boolean(picked[w.id])}
                  onChange={(e) => {
                    setPicked((p) => ({ ...p, [w.id]: e.target.checked }));
                    reset();
                  }}
                />
                <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {w.label} <span className="mono muted">{short(w.address)}</span>
                </span>
                {perPreview !== null && picked[w.id] && (
                  <span className="mono small muted">+{fmtNative(perPreview.toString(), sym, 6)}</span>
                )}
              </label>
            ))}
            {!visibleOthers.length && <span className="muted small">{t("No wallets match this search.")}</span>}
          </ScrollArea>
          <div className="row" style={{ marginTop: 12 }}>
            <input
              inputMode="decimal"
              placeholder={max ? t("Max") : t("Total amount to split")}
              value={max ? "" : amount}
              disabled={max}
              onChange={(e) => {
                setAmount(e.target.value.replace(/[^0-9.]/g, ""));
                reset();
              }}
              style={{ width: 200 }}
              aria-label="Total amount"
            />
            <button
              className={max ? "" : "ghost"}
              onClick={() => {
                setMax((m) => !m);
                reset();
              }}
              aria-pressed={max}
              title={t("Main balance minus the network fees of all transfers")}
            >
              {t("Max")}
            </button>
            <button disabled={!canReview || overBalance} onClick={() => review()}>
              {t("Review Funding")}
            </button>
          </div>
          <p className="muted small" style={{ marginTop: 6 }}>
            {max
              ? t(
                  "Max sends your Main balance minus the exact network fees for every transfer, split evenly. The exact amount per wallet is shown on review.",
                )
              : perPreview !== null
                ? `${fmtNative(perPreview.toString(), sym, 8)} ${t("per wallet")} × ${ids.length}${
                    remPreview > 0n ? ` ${t("({amount} wei rounding stays in Main)", { amount: remPreview.toString() })}` : ""
                  }. ${t("Network fees are added on review.")}`
                : t("Enter the total to split evenly across the selected wallets.")}
          </p>
          {overBalance && <p className="bad">{t("The amount is more than your Main balance on this chain.")}</p>}
        </>
      )}
      {busy && <p className="muted">{busy}</p>}
      {err && <div className="err">{err}</div>}

      {quote && (
        <div style={{ marginTop: 16 }}>
          <h2>{t("Confirm Funding")}</h2>
          <div className="kv">
            <b>{t("From Main on {chain}", { chain: quote.chainName })}</b>
            <div className="mono" style={{ fontSize: 16, wordBreak: "break-all", padding: "8px 0" }}>
              {quote.main.address}
            </div>
            <span className="muted">
              {quote.main.label} · {t("balance {amount}", { amount: fmtEth(quote.main.balanceWei, 8) })} {sym}
            </span>
          </div>
          {quote.warnings.map((w: string) => (
            <div key={w} className="notice">
              {w}
            </div>
          ))}
          <table style={{ marginTop: 10 }}>
            <thead>
              <tr>
                <th>{t("To")}</th>
                <th>{t("Amount")}</th>
                <th>{t("Network Fee")}</th>
                <th>{t("Status")}</th>
              </tr>
            </thead>
            <tbody>
              {quote.items.map((i: any) => {
                const st = run[i.walletId];
                const stLabel = st ? t(st.status) : "";
                return (
                  <tr key={i.walletId}>
                    <td>
                      {i.label} <span className="mono muted">{short(i.address)}</span> <CopyAddress address={i.address} />
                    </td>
                    <td className="mono">
                      {fmtEth(i.valueWei, 8)} {sym}
                    </td>
                    <td className="mono">
                      {fmtEth(i.feeWei, 9)} {sym}
                    </td>
                    <td>
                      {!st ? (
                        <span className="muted">{t("Ready")}</span>
                      ) : (
                        <span
                          className={
                            st.status === "confirmed" ? "ok" : st.status === "failed" ? "bad" : st.status === "skipped" ? "warn" : ""
                          }
                        >
                          {stLabel[0].toUpperCase() + stLabel.slice(1)}
                          {st.error ? `: ${st.error}` : ""}{" "}
                          {st.explorer && (
                            <a href={st.explorer} target="_blank" rel="noreferrer">
                              {t("View")}
                            </a>
                          )}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="grid" style={{ marginTop: 12 }}>
            <div className="kv">
              <b>{t("Total Sent")}</b>
              {fmtEth(quote.totals.valueWei, 8)} {sym}
            </div>
            <div className="kv">
              <b>{t("Total Network Fees")}</b>
              {fmtEth(quote.totals.feeWei, 9)} {sym}
            </div>
            <div className="kv">
              <b>{t("Left in Main")}</b>~{fmtEth(quote.totals.leftoverWei, 9)} {sym}
            </div>
          </div>
          {signingNow && (
            <div className="row" style={{ marginTop: 12 }}>
              <span className="muted">{t("Waiting for your wallet signature (up to 60s per transfer)…")}</span>
              <button className="ghost" onClick={() => stopRef.current?.abort()}>
                {t("Stop")}
              </button>
            </div>
          )}
          {!signingNow && Object.keys(run).length > 0 && (
            <>
              <p className={unsent.length ? "warn" : "ok"} style={{ marginTop: 12 }}>
                {t("{sent} of {total} transfers sent", { sent: sentCount, total: quote.items.length })}
                {unsent.length ? ` · ${t("{count} not sent", { count: unsent.length })}` : ""}.
              </p>
              <div className="row">
                {unsent.length > 0 && (
                  <button onClick={() => review(unsent, (BigInt(quote.perWalletWei) * BigInt(unsent.length)).toString())}>
                    {t("Retry {count} Unsent", { count: unsent.length })}
                  </button>
                )}
                <button className="ghost" onClick={reset}>
                  {t("Close")}
                </button>
              </div>
            </>
          )}
          {!Object.keys(run).length && (
            <>
              <label className="confirm-check" style={{ marginTop: 12 }}>
                <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
                <span>{t("I reviewed the amounts above. Transfers cannot be reversed.")}</span>
              </label>
              {!authenticated && <p className="muted">{t("Transfers are signed with your Privy wallet. Connect with Privy to send.")}</p>}
              <div className="row" style={{ marginTop: 8 }}>
                <button disabled={!checked || !authenticated || !quote.items.length} onClick={send}>
                  {quote.items.length === 1 ? t("Send 1 Transfer") : t("Send {count} Transfers", { count: quote.items.length })}
                </button>
                <button className="ghost" onClick={reset}>
                  {t("Cancel")}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
