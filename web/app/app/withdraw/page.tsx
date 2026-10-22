"use client";
// SPDX-License-Identifier: AGPL-3.0-only
import { CopyAddress } from "@/components/CopyAddress";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { assertSignableChain, withSignTimeout } from "@/lib/signing";
import { usePrivy, useSignTransaction } from "@privy-io/react-auth";
import { fmtEth, short } from "@/lib/api";
import { useApi, useShell } from "@/components/AppShell";
import { ChainSelect } from "@/components/ChainSelect";
import { useWalletList } from "@/lib/wallets";

type Status = "queued" | "signing" | "sent" | "confirmed" | "failed" | "skipped";
type RunState = Record<string, { status: Status; hash?: string; explorer?: string; error?: string }>;

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

export default function WithdrawPage() {
  const api = useApi();
  const { userId, tgOnly, connectPrivy } = useShell();
  const { authenticated } = usePrivy();
  const { signTransaction } = useSignTransaction();
  const list = useWalletList(api, userId);
  const [chain, setChain] = useState("base");
  const [balances, setBalances] = useState<Record<string, string>>({});
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [to, setTo] = useState("");
  const [quote, setQuote] = useState<any>(null);
  const [checked, setChecked] = useState(false);
  const [run, setRun] = useState<RunState>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const stopRef = useRef<AbortController | null>(null);
  useEffect(() => {
    const w = new URLSearchParams(window.location.search).get("wallet");
    if (w) setPicked({ [w]: true });
  }, []);

  useEffect(() => {
    setBalances({});
    setQuote(null);
    if (!list.wallets.length) return;
    api("/api/wallets/balances", { body: { chain } })
      .then((r) => setBalances(Object.fromEntries(r.balances.map((b: any) => [b.walletId, b.balanceWei ?? "error"]))))
      .catch(() => {});
  }, [chain, list.wallets.length]); // eslint-disable-line

  const ids = list.wallets.filter((w) => picked[w.id]).map((w) => w.id);
  const allPicked = list.wallets.length > 0 && ids.length === list.wallets.length;
  const toValid = ADDR_RE.test(to.trim());
  const running = Object.values(run).some((r) => r.status === "signing" || r.status === "sent" || r.status === "queued");
  const signingNow = Object.values(run).some((r) => r.status === "signing" || r.status === "queued");
  const reset = () => {
    setQuote(null);
    setChecked(false);
    setRun({});
  };

  const review = async (only?: string[]) => {
    setErr(null);
    reset();
    setBusy("Preparing withdrawal…");
    try {
      const q = await api("/api/withdraw/quote", {
        body: { chain, to: to.trim(), wallets: (only ?? ids).map((walletId) => ({ walletId, amount: (amounts[walletId] ?? "").trim() || "max" })) },
      });
      setQuote(q);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(null);
    }
  };

  const poll = async (walletId: string, hash: string) => {
    // Backs off from 3 s to 10 s; final receipts are cached server-side.
    for (let i = 0; i < 45; i++) {
      await new Promise((r) => setTimeout(r, Math.min(10_000, 3000 + i * 1000)));
      try {
        const s = (await api("/api/tx/status", { body: { chain: quote.chain, hashes: [hash] } })).statuses[0];
        if (s && s.status !== "pending") {
          setRun((r) => (r[walletId] ? { ...r, [walletId]: { ...r[walletId], status: s.status } } : r));
          return;
        }
      } catch {
        /* keep polling */
      }
    }
  };

  const send = async () => {
    setErr(null);
    const items = quote.items as any[];
    setRun(Object.fromEntries(items.map((i) => [i.walletId, { status: i.tx ? "queued" : "skipped", error: i.skip ?? undefined }])));
    const stop = new AbortController();
    stopRef.current = stop;
    // Sequential: one Privy signature at a time, each broadcast immediately.
    for (const it of items.filter((i) => i.tx)) {
      if (stop.signal.aborted) {
        setRun((r) => ({ ...r, [it.walletId]: { status: "skipped", error: "stopped before signing" } }));
        continue;
      }
      setRun((r) => ({ ...r, [it.walletId]: { status: "signing" } }));
      try {
        assertSignableChain(it.tx.chainId);
        // Never wait forever on the wallet: 60 s timeout, and Stop aborts the wait (nothing is broadcast unsigned).
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
            { address: it.address, uiOptions: { showWalletUIs: false } },
          ),
          { signal: stop.signal, what: "Wallet signature" },
        );
        if (stop.signal.aborted) throw new Error("Stopped. Nothing was sent.");
        const r = await api("/api/withdraw/send", {
          body: { chain: quote.chain, walletId: it.walletId, tx: it.tx, quoteToken: it.quoteToken, signed: signature },
        });
        setRun((s) => ({ ...s, [it.walletId]: { status: "sent", hash: r.hash, explorer: r.explorer } }));
        void poll(it.walletId, r.hash);
      } catch (e: any) {
        setRun((s) => ({ ...s, [it.walletId]: { status: "failed", error: String(e?.message ?? e).slice(0, 200) } }));
      }
    }
    stopRef.current = null;
  };
  const unsent = ((quote?.items ?? []) as any[])
    .filter((i) => i.tx && run[i.walletId] && ["failed", "skipped"].includes(run[i.walletId].status))
    .map((i) => i.walletId as string);

  const sym = quote?.nativeSymbol ?? "";
  const ready = quote?.items?.filter((i: any) => i.tx) ?? [];

  return (
    <>
      <div className="card">
        <h2>Withdraw</h2>
        <p className="muted">
          Send the native token from one or more of your wallets to a single address. Each transfer is signed by your Privy wallet in this
          browser; SkyBOT checks that the signed transaction matches what you reviewed before broadcasting it.
        </p>
        {!authenticated && tgOnly && (
          <div className="notice row" style={{ justifyContent: "space-between" }}>
            <span>Withdrawals are signed with your Privy wallet. Connect with Privy to continue.</span>
            <button onClick={connectPrivy}>Connect with Privy</button>
          </div>
        )}
        <div className="row">
          <ChainSelect
            value={chain}
            onChange={(c) => {
              setChain(c);
              reset();
            }}
          />
          <button className="ghost" onClick={() => setPicked(allPicked ? {} : Object.fromEntries(list.wallets.map((w) => [w.id, true])))}>
            {allPicked ? "Clear" : "Select All"}
          </button>
          <button className="ghost" onClick={() => setAmounts({})}>
            Max for All
          </button>
          <span className="muted">
            {ids.length} of {list.wallets.length} selected
          </span>
        </div>
        <table style={{ marginTop: 10 }}>
          <thead>
            <tr>
              <th></th>
              <th>Wallet</th>
              <th>Balance</th>
              <th>Amount</th>
            </tr>
          </thead>
          <tbody>
            {list.loading &&
              [0, 1].map((i) => (
                <tr key={i}>
                  <td colSpan={4}>
                    <span className="skeleton" style={{ width: "60%" }} />
                  </td>
                </tr>
              ))}
            {list.wallets.map((w) => (
              <tr key={w.id}>
                <td>
                  <input
                    type="checkbox"
                    checked={Boolean(picked[w.id])}
                    onChange={(e) => {
                      setPicked((p) => ({ ...p, [w.id]: e.target.checked }));
                      reset();
                    }}
                    aria-label={`Select ${w.label}`}
                  />
                </td>
                <td>
                  {w.label} <span className="mono muted">{short(w.address)}</span> <CopyAddress address={w.address} />
                </td>
                <td className="mono">
                  {balances[w.id] === undefined ? (
                    <span className="skeleton" style={{ width: 70 }} />
                  ) : balances[w.id] === "error" ? (
                    <span className="muted">unavailable</span>
                  ) : (
                    fmtEth(balances[w.id], 6)
                  )}
                </td>
                <td>
                  <input
                    inputMode="decimal"
                    placeholder="Max"
                    value={amounts[w.id] ?? ""}
                    disabled={!picked[w.id]}
                    onChange={(e) => {
                      setAmounts((a) => ({ ...a, [w.id]: e.target.value.replace(/[^0-9.]/g, "") }));
                      reset();
                    }}
                    style={{ width: 140 }}
                    aria-label={`Amount for ${w.label}`}
                  />
                </td>
              </tr>
            ))}
            {!list.loading && !list.wallets.length && (
              <tr>
                <td colSpan={4} className="muted">
                  No wallets yet. Add some on <Link href="/app/wallets">Wallets</Link>.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        <div className="row" style={{ marginTop: 12 }}>
          <input
            className="mono"
            style={{ flex: 1, minWidth: 280 }}
            placeholder="Destination address (0x…)"
            value={to}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => {
              setTo(e.target.value.trim());
              reset();
            }}
          />
          <button disabled={!ids.length || !toValid || !!busy || running} onClick={() => review()}>
            Review Withdrawal
          </button>
        </div>
        {to && !toValid && <p className="bad">Enter a full 0x address (42 characters). ENS names are not supported.</p>}
        {busy && <p className="muted">{busy}</p>}
        {err && <div className="err">{err}</div>}
      </div>

      {quote && (
        <div className="card">
          <h2>Confirm Withdrawal</h2>
          <div className="kv">
            <b>Destination on {quote.chainName}</b>
            <div className="mono" style={{ fontSize: 16, wordBreak: "break-all", padding: "8px 0" }}>
              {quote.destination.address}
            </div>
            <span className="muted">
              {quote.destination.isContract ? "Smart contract" : "Regular wallet (EOA)"}
              {quote.destination.ownWallet ? ` · your wallet "${quote.destination.ownWallet}"` : ""}
              {quote.destination.seenBefore ? " · used before" : ""}
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
                <th>From</th>
                <th>Amount</th>
                <th>Network Fee</th>
                <th>Left in Wallet</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {quote.items.map((i: any) => {
                const st = run[i.walletId];
                return (
                  <tr key={i.walletId}>
                    <td>
                      {i.label} <span className="mono muted">{short(i.address)}</span> <CopyAddress address={i.address} />
                    </td>
                    <td className="mono">{i.tx ? `${fmtEth(i.valueWei, 8)} ${sym}` : "—"}</td>
                    <td className="mono">{i.tx ? `${fmtEth(i.feeWei, 9)} ${sym}` : "—"}</td>
                    <td className="mono">{i.tx ? (i.exactZero && i.leftoverWei === "0" ? "0" : `~${fmtEth(i.leftoverWei, 9)}`) : "—"}</td>
                    <td>
                      {!st ? (
                        i.skip ? (
                          <span className="warn">Skipped: {i.skip}</span>
                        ) : (
                          <span className="muted">Ready</span>
                        )
                      ) : (
                        <span
                          className={
                            st.status === "confirmed" ? "ok" : st.status === "failed" ? "bad" : st.status === "skipped" ? "warn" : ""
                          }
                        >
                          {st.status[0].toUpperCase() + st.status.slice(1)}
                          {st.error ? `: ${st.error}` : ""}{" "}
                          {st.explorer && (
                            <a href={st.explorer} target="_blank" rel="noreferrer">
                              View
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
              <b>Total Sent</b>
              {fmtEth(quote.totals.valueWei, 8)} {sym}
            </div>
            <div className="kv">
              <b>Total Network Fees</b>
              {fmtEth(quote.totals.feeWei, 9)} {sym}
            </div>
            <div className="kv">
              <b>Transfers</b>
              {ready.length}
            </div>
          </div>
          {signingNow && (
            <div className="row" style={{ marginTop: 12 }}>
              <span className="muted">Waiting for your wallet signature (up to 60s per transfer)…</span>
              <button className="ghost" onClick={() => stopRef.current?.abort()}>
                Stop
              </button>
            </div>
          )}
          {!signingNow && Object.keys(run).length > 0 && (
            <div className="row" style={{ marginTop: 12 }}>
              {unsent.length > 0 && <button onClick={() => review(unsent)}>Retry {unsent.length} Unsent</button>}
              <button className="ghost" onClick={reset}>
                Close
              </button>
            </div>
          )}
          {!Object.keys(run).length && (
            <>
              <label className="row" style={{ marginTop: 12 }}>
                <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} style={{ width: "auto" }} />
                <span>I checked the full destination address above. Transfers cannot be reversed.</span>
              </label>
              <div className="row" style={{ marginTop: 8 }}>
                <button disabled={!checked || !ready.length || !authenticated} onClick={send}>
                  Send {ready.length} Transfer{ready.length === 1 ? "" : "s"}
                </button>
                <button className="ghost" onClick={reset}>
                  Cancel
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}
