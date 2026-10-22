"use client";
// SPDX-License-Identifier: AGPL-3.0-only
import { CopyAddress } from "@/components/CopyAddress";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePrivy, useSignTransaction } from "@privy-io/react-auth";
import { fmtEth, short } from "@/lib/api";
import { useApi, useShell } from "@/components/AppShell";
import { formatDateTime, localTimeZone } from "@/lib/time";
import { useNow } from "@/lib/useNow";
import { assertSignableChain, withSignTimeout } from "@/lib/signing";
import { NFTS_KEY, ago, mutate as mutateCache, nftsFetcher, useSWR } from "@/lib/swr";
import { LayoutPicker, LazyImg, NftGrid, thumb, useNftLayout } from "@/components/NftGrid";
import { usePersistedChain } from "@/lib/chainPref";

type Item = {
  key: string;
  walletId: string;
  chain: string;
  contract: string;
  tokenId: string;
  standard: "erc721" | "erc1155";
  quantity: string | null;
  name: string | null;
  collection: string | null;
  collectionSlug: string | null;
  image: string | null;
  spam: boolean;
};
type View = {
  wallets: { id: string; label: string; address: string }[];
  chains: { key: string; name: string; nativeSymbol: string; explorer: string }[];
  items: Item[];
  scans: { walletId: string; chain: string; error: string | null; truncated: boolean; scannedAt: string; source: string | null }[];
  missing: number;
  lastRefreshAt: string | null;
  cooldownMs: number;
  /** A webhook-queued re-scan is due at this time (the page re-reads the cache shortly after). */
  rescanDueAt?: string | null;
};
type Status = "queued" | "signing" | "sent" | "confirmed" | "failed" | "skipped";
type RunState = Record<string, { status: Status; hash?: string; explorer?: string; error?: string }>;

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const shortId = (id: string) => (id.length > 12 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id);
const collectionOf = (i: Item) => i.collection ?? short(i.contract);
const label = (s: Status) => s[0].toUpperCase() + s.slice(1);

export default function NftsPage() {
  const api = useApi();
  const { tgOnly, connectPrivy } = useShell();
  const { authenticated } = usePrivy();
  const { signTransaction } = useSignTransaction();
  // Stale-while-revalidate: the last list renders instantly (per user, this device), refreshed in the background.
  const cached = useSWR<View>(NFTS_KEY, nftsFetcher(api), { freshMs: 10_000 });
  const view = cached.data ?? null;
  const loadedAt = cached.at;
  const [scanning, setScanning] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [wallet, setWallet] = useState("");
  const [chain, setChain] = usePersistedChain("nftsFilter", "");
  const [collection, setCollection] = useState("");
  const [group, setGroup] = useState<"wallet" | "collection">("wallet");
  const [layout, setLayout] = useNftLayout();
  const [showSpam, setShowSpam] = useState(false);
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [qty, setQty] = useState<Record<string, string>>({});
  const [to, setTo] = useState("");
  const [quote, setQuote] = useState<any>(null);
  const [checked, setChecked] = useState(false);
  const [run, setRun] = useState<RunState>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [tz, setTz] = useState<string | undefined>(undefined);
  useEffect(() => setTz(localTimeZone()), []);
  const now = useNow(1000);
  const autoScanned = useRef(false);
  const stopRef = useRef<AbortController | null>(null);

  const accept = useCallback((v: View) => mutateCache(NFTS_KEY, v), []);

  /** Indexer scan. "missing" = wallet/chain pairs never scanned; "all" = manual refresh (60 s cooldown). */
  const scan = useCallback(
    async (mode: "missing" | "all") => {
      setErr(null);
      setScanning(mode === "all" ? "Refreshing holdings…" : "Scanning wallets for NFTs (first time only)…");
      try {
        let r = await api("/api/nfts/refresh", { body: { mode } });
        accept(r);
        // Large accounts: finish the rest of the scan in follow-up calls (no extra cooldown).
        for (let i = 0; i < 6 && r.remaining > 0; i++) {
          r = await api("/api/nfts/refresh", { body: { mode: mode === "all" ? "continue" : "missing" } });
          accept(r);
        }
      } catch (e: any) {
        setErr(e.message);
      } finally {
        setScanning(null);
      }
    },
    [api, accept],
  );

  // Opening the page reads the DB cache only; a scan runs automatically just for wallets never scanned before
  // (decided on the revalidated server view, never on the locally cached copy).
  useEffect(() => {
    if (cached.validating || !view || cached.error) return;
    if (view.missing > 0 && !autoScanned.current) {
      autoScanned.current = true;
      void scan("missing");
    }
  }, [cached.validating, view, cached.error, scan]);
  // A webhook queued a re-scan (NFT moved on-chain): re-read the cache right after it is due.
  const dueAt = view?.rescanDueAt ? Date.parse(view.rescanDueAt) : 0;
  useEffect(() => {
    if (!dueAt) return;
    const t = setTimeout(() => void cached.revalidate(true), Math.max(2_000, dueAt - Date.now() + 8_000));
    return () => clearTimeout(t);
  }, [dueAt]); // eslint-disable-line

  const wallets = useMemo(() => view?.wallets ?? [], [view]);
  const walletById = useMemo(() => new Map(wallets.map((w) => [w.id, w])), [wallets]);
  const chainByKey = useMemo(() => new Map((view?.chains ?? []).map((c) => [c.key, c])), [view]);
  // A remembered chain filter that is no longer offered falls back to "All chains".
  useEffect(() => {
    if (chain && view?.chains?.length && !chainByKey.has(chain)) setChain("");
  }, [chain, view, chainByKey, setChain]);
  const spamCount = (view?.items ?? []).filter((i) => i.spam).length;
  const base = useMemo(
    () =>
      (view?.items ?? []).filter(
        (i) =>
          (showSpam || !i.spam) &&
          (!wallet || i.walletId === wallet) &&
          (!chain || i.chain === chain) &&
          (!q || `${i.name ?? ""} ${i.collection ?? ""} ${i.contract} ${i.tokenId}`.toLowerCase().includes(q.trim().toLowerCase())),
      ),
    [view, showSpam, wallet, chain, q],
  );
  const collections = useMemo(() => [...new Set(base.map(collectionOf))].sort((a, b) => a.localeCompare(b)), [base]);
  const visible = useMemo(() => base.filter((i) => !collection || collectionOf(i) === collection), [base, collection]);
  const groups = useMemo(() => {
    const m = new Map<string, Item[]>();
    for (const i of visible) {
      const g = group === "wallet" ? i.walletId : `${i.chain}:${collectionOf(i)}`;
      m.set(g, [...(m.get(g) ?? []), i]);
    }
    return [...m];
  }, [visible, group]);
  const groupTitle = (g: string, items: Item[]) => {
    if (group === "wallet") {
      const w = walletById.get(g);
      return (
        <>
          {w?.label ?? "Wallet"} <span className="mono muted">{short(w?.address)}</span> <CopyAddress address={w?.address} />
        </>
      );
    }
    return (
      <>
        {collectionOf(items[0])} <span className="pill">{chainByKey.get(items[0].chain)?.name ?? items[0].chain}</span>
      </>
    );
  };

  const selected = (view?.items ?? []).filter((i) => picked[i.key]);
  const allVisiblePicked = visible.length > 0 && visible.every((i) => picked[i.key]);
  const setMany = (items: Item[], on: boolean) => {
    setPicked((p) => {
      const n = { ...p };
      for (const i of items) {
        if (on) n[i.key] = true;
        else delete n[i.key];
      }
      return n;
    });
    resetQuote();
  };
  const qtyFor = (i: Item) => {
    if (i.standard === "erc721") return "1";
    const v = (qty[i.key] ?? "").trim();
    return v || i.quantity || "1";
  };
  const qtyValid = (i: Item) => {
    if (i.standard === "erc721") return true;
    const v = qtyFor(i);
    if (!/^\d+$/.test(v) || BigInt(v) < 1n) return false;
    return i.quantity === null || BigInt(v) <= BigInt(i.quantity);
  };
  const toValid = ADDR_RE.test(to.trim());
  const running = Object.values(run).some((r) => r.status === "signing" || r.status === "sent" || r.status === "queued");
  const signingNow = Object.values(run).some((r) => r.status === "signing" || r.status === "queued");
  const resetQuote = () => {
    setQuote(null);
    setChecked(false);
    setRun({});
  };

  type QuoteIn = { walletId: string; chain: string; contract: string; tokenId: string; standard: string; quantity: string };
  const review = async (list?: QuoteIn[]) => {
    setErr(null);
    resetQuote();
    setBusy("Checking ownership and gas…");
    try {
      setQuote(
        await api("/api/nfts/send/quote", {
          body: {
            to: to.trim(),
            items:
              list ??
              selected.map((i) => ({
                walletId: i.walletId,
                chain: i.chain,
                contract: i.contract,
                tokenId: i.tokenId,
                standard: i.standard,
                quantity: qtyFor(i),
              })),
          },
        }),
      );
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(null);
    }
  };

  /** One batched status request per chain, slowing down from 3 s to 10 s; stops when everything is final. */
  const pollAll = async (sent: { key: string; chain: string; hash: string }[]) => {
    let pending = [...sent];
    for (let i = 0; i < 50 && pending.length; i++) {
      await new Promise((r) => setTimeout(r, Math.min(10_000, 3000 + i * 1000)));
      const byChain = new Map<string, typeof pending>();
      for (const p of pending) byChain.set(p.chain, [...(byChain.get(p.chain) ?? []), p]);
      for (const [c, list] of byChain) {
        try {
          const r = await api("/api/tx/status", { body: { chain: c, hashes: list.map((x) => x.hash) } });
          for (const s of r.statuses) {
            if (s.status === "pending") continue;
            const it = list.find((x) => x.hash.toLowerCase() === s.hash.toLowerCase());
            if (!it) continue;
            // Ignore results for a batch the user already closed / re-quoted.
            setRun((st) => (st[it.key] ? { ...st, [it.key]: { ...st[it.key], status: s.status } } : st));
            pending = pending.filter((x) => x !== it);
          }
        } catch {
          /* keep polling */
        }
      }
    }
  };

  const send = async () => {
    setErr(null);
    const items = quote.items as any[];
    setRun(Object.fromEntries(items.map((i) => [i.key, { status: i.tx ? "queued" : "skipped", error: i.skip ?? undefined }])));
    const sent: { key: string; chain: string; hash: string }[] = [];
    const broken = new Set<string>(); // wallet:chain whose earlier transfer failed (later nonces would be stuck)
    const stop = new AbortController();
    stopRef.current = stop;
    // Sequential: one Privy signature at a time, each broadcast immediately, in nonce order per wallet.
    for (const it of items.filter((i) => i.tx)) {
      const lane = `${it.walletId}:${it.chain}`;
      if (stop.signal.aborted) {
        setRun((r) => ({ ...r, [it.key]: { status: "skipped", error: "stopped before signing" } }));
        continue;
      }
      if (broken.has(lane)) {
        setRun((r) => ({ ...r, [it.key]: { status: "skipped", error: "an earlier transfer from this wallet failed" } }));
        continue;
      }
      setRun((r) => ({ ...r, [it.key]: { status: "signing" } }));
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
              data: it.tx.data,
            },
            { address: it.address, uiOptions: { showWalletUIs: false } },
          ),
          { signal: stop.signal, what: "Wallet signature" },
        );
        if (stop.signal.aborted) throw new Error("Stopped. Nothing was sent.");
        const r = await api("/api/nfts/send", {
          body: { chain: it.chain, walletId: it.walletId, tx: it.tx, quoteToken: it.quoteToken, signed: signature },
        });
        sent.push({ key: it.key, chain: it.chain, hash: r.hash });
        setRun((s) => ({ ...s, [it.key]: { status: "sent", hash: r.hash, explorer: r.explorer } }));
      } catch (e: any) {
        broken.add(lane);
        setRun((s) => ({ ...s, [it.key]: { status: "failed", error: String(e?.message ?? e).slice(0, 200) } }));
      }
    }
    stopRef.current = null;
    // Keep unsent NFTs selected so Retry / a new review can pick them up.
    setPicked((p) => {
      const n = { ...p };
      for (const x of sent) delete n[x.key];
      return n;
    });
    // The server already updated the cached holdings for the affected wallets; re-read the cache (no scan).
    void cached.revalidate(true);
    if (sent.length) await pollAll(sent);
  };

  /** Re-quote everything that wasn't broadcast (fresh nonces, gas and ownership), keeping quantities. */
  const retryUnsent = () => {
    const items = (quote?.items ?? []) as any[];
    const again = items.filter((i) => {
      const st = run[i.key]?.status;
      return i.tx && st !== "sent" && st !== "confirmed";
    });
    if (!again.length) return;
    void review(
      again.map((i) => ({
        walletId: i.walletId,
        chain: i.chain,
        contract: i.contract,
        tokenId: i.tokenId,
        standard: i.standard,
        quantity: i.standard === "erc721" ? "1" : i.quantity,
      })),
    );
  };
  const unsent = ((quote?.items ?? []) as any[]).filter(
    (i) => i.tx && run[i.key] && !["sent", "confirmed", "signing", "queued"].includes(run[i.key].status),
  ).length;

  const cooldownLeft = view ? Math.max(0, view.cooldownMs - (now - loadedAt)) : 0;
  const scanErrors = (view?.scans ?? []).filter((s) => s.error);
  const truncated = (view?.scans ?? []).filter((s) => s.truncated);
  const ready = quote?.items?.filter((i: any) => i.tx) ?? [];
  const fmt = (w: string) => formatDateTime(w, { timeZone: tz, now });

  return (
    <>
      <div className="card">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2 style={{ margin: 0 }}>NFTs</h2>
          <div className="row">
            <span className="muted small">
              {loadedAt ? `Updated ${ago(loadedAt, now)}` : ""}
              {cached.validating && view ? " · checking…" : ""}
              {view?.lastRefreshAt ? ` · last full refresh ${fmt(view.lastRefreshAt)}` : ""}
            </span>
            <button className="ghost" disabled={!!scanning || cooldownLeft > 0 || !wallets.length} onClick={() => scan("all")}>
              {cooldownLeft > 0 ? `Refresh in ${Math.ceil(cooldownLeft / 1000)}s` : "Refresh"}
            </button>
          </div>
        </div>
        <p className="muted">
          NFTs held by your wallets on every supported chain. Holdings are scanned once and saved, so opening this page doesn&apos;t use RPC
          calls. Names and images are checked against each token&apos;s on-chain metadata, so revealed collections update automatically. Use
          Refresh after receiving NFTs elsewhere. Each transfer is signed by your Privy wallet in this browser, and SkyBOT checks it matches
          what you reviewed before broadcasting.
        </p>
        {!authenticated && tgOnly && (
          <div className="notice row" style={{ justifyContent: "space-between" }}>
            <span>Transfers are signed with your Privy wallet. Connect with Privy to send.</span>
            <button onClick={connectPrivy}>Connect with Privy</button>
          </div>
        )}
        {scanning && <p className="muted">{scanning}</p>}
        {(err ?? (!view ? cached.error : null)) && <div className="err">{err ?? cached.error}</div>}
        {scanErrors.length > 0 && (
          <div className="notice small">
            Couldn&apos;t scan {scanErrors.length} wallet/chain pair{scanErrors.length === 1 ? "" : "s"} (
            {[...new Set(scanErrors.map((s) => chainByKey.get(s.chain)?.name ?? s.chain))].join(", ")}). Previous results are kept; try
            Refresh later.
          </div>
        )}
        {truncated.length > 0 && (
          <div className="notice small">Some wallets hold more than 1,000 NFTs on a chain; only the first 1,000 are listed.</div>
        )}

        <div className="row" style={{ marginTop: 10 }}>
          <select value={wallet} onChange={(e) => setWallet(e.target.value)} style={{ width: "auto", minWidth: 160 }} aria-label="Wallet">
            <option value="">All wallets</option>
            {wallets.map((w) => (
              <option key={w.id} value={w.id}>
                {w.label} ({short(w.address)})
              </option>
            ))}
          </select>
          <select value={chain} onChange={(e) => setChain(e.target.value)} style={{ width: "auto", minWidth: 140 }} aria-label="Chain">
            <option value="">All chains</option>
            {(view?.chains ?? []).map((c) => (
              <option key={c.key} value={c.key}>
                {c.name}
              </option>
            ))}
          </select>
          <select
            value={collection}
            onChange={(e) => setCollection(e.target.value)}
            style={{ width: "auto", minWidth: 160 }}
            aria-label="Collection"
          >
            <option value="">All collections</option>
            {collections.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <input
            placeholder="Search name, collection or token ID"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            style={{ flex: 1, minWidth: 200 }}
          />
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <div className="segmented">
            <button className={group === "wallet" ? "on" : ""} onClick={() => setGroup("wallet")}>
              By Wallet
            </button>
            <button className={group === "collection" ? "on" : ""} onClick={() => setGroup("collection")}>
              By Collection
            </button>
          </div>
          <button className="ghost" disabled={!visible.length} onClick={() => setMany(visible, !allVisiblePicked)}>
            {allVisiblePicked ? "Clear Visible" : `Select All (${visible.length})`}
          </button>
          {selected.length > 0 && (
            <button className="ghost" onClick={() => setMany(selected, false)}>
              Clear Selection
            </button>
          )}
          {spamCount > 0 && (
            <label className="row small muted" style={{ gap: 6 }}>
              <input type="checkbox" checked={showSpam} onChange={(e) => setShowSpam(e.target.checked)} style={{ width: "auto" }} />
              Show {spamCount} likely spam
            </label>
          )}
          <span className="spacer" />
          <LayoutPicker value={layout} onChange={setLayout} />
          <span className="muted">
            {selected.length} selected · {visible.length} shown
          </span>
        </div>

        {!view && (
          <div className="nft-grid" style={{ marginTop: 12 }}>
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="nft-card">
                <div className="nft-img skeleton" />
                <span className="skeleton" style={{ width: "70%" }} />
              </div>
            ))}
          </div>
        )}
        {view && !wallets.length && (
          <p className="muted">
            No wallets yet. Add some on <Link href="/app/wallets">Wallets</Link>.
          </p>
        )}
        {view && wallets.length > 0 && !visible.length && !scanning && (
          <p className="muted">{view.items.length ? "No NFTs match these filters." : "No NFTs found in your wallets yet."}</p>
        )}

        <NftGrid
          layout={layout}
          groups={groups}
          header={(g, items) => {
            const all = items.every((i) => picked[i.key]);
            return (
              <div className="row" style={{ justifyContent: "space-between" }}>
                <b>
                  {groupTitle(g, items)} <span className="muted small">· {items.length}</span>
                </b>
                <button className="ghost small" style={{ padding: "4px 12px" }} onClick={() => setMany(items, !all)}>
                  {all ? "Clear" : "Select All"}
                </button>
              </div>
            );
          }}
          card={(i) => {
            const w = walletById.get(i.walletId);
            const on = Boolean(picked[i.key]);
            return (
              <label key={i.key} className={`nft-card${on ? " on" : ""}`}>
                <div className="nft-img">
                  {i.image ? (
                    <LazyImg src={thumb(i.image, layout === "list" || layout >= 4 ? 160 : 256) ?? i.image} />
                  ) : (
                    <span className="muted small">No image</span>
                  )}
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={(e) => setMany([i], e.target.checked)}
                    aria-label={`Select ${i.name ?? i.tokenId}`}
                  />
                </div>
                <div className="nft-meta">
                  <b title={i.name ?? ""}>{i.name ?? `#${shortId(i.tokenId)}`}</b>
                  <span className="muted small" title={i.collection ?? i.contract}>
                    {collectionOf(i)}
                  </span>
                  <span className="small mono" title={i.tokenId}>
                    ID {shortId(i.tokenId)}
                  </span>
                  <span className="row small nft-tags" style={{ gap: 4 }}>
                    <span className="pill">{chainByKey.get(i.chain)?.name ?? i.chain}</span>
                    <span className="tag">{i.standard === "erc721" ? "ERC-721" : `ERC-1155 × ${i.quantity ?? "?"}`}</span>
                    {i.spam && <span className="tag warn">Spam?</span>}
                  </span>
                  {group !== "wallet" && <span className="small muted">{w?.label ?? short(w?.address)}</span>}
                  {i.standard === "erc1155" && on && (
                    <span className="row small" style={{ gap: 6 }} onClick={(e) => e.preventDefault()}>
                      Qty
                      <input
                        inputMode="numeric"
                        value={qty[i.key] ?? i.quantity ?? "1"}
                        onChange={(e) => {
                          setQty((m) => ({ ...m, [i.key]: e.target.value.replace(/[^0-9]/g, "") }));
                          resetQuote();
                        }}
                        style={{ width: 80, padding: "4px 8px" }}
                        aria-label="Quantity"
                      />
                      {i.quantity && (
                        <button
                          className="ghost"
                          style={{ padding: "2px 8px", fontSize: 12 }}
                          onClick={() => {
                            setQty((m) => ({ ...m, [i.key]: i.quantity! }));
                            resetQuote();
                          }}
                        >
                          Max
                        </button>
                      )}
                    </span>
                  )}
                  {!qtyValid(i) && on && <span className="bad small">Quantity must be 1 to {i.quantity ?? "your balance"}</span>}
                </div>
              </label>
            );
          }}
        />
      </div>

      <div className="card">
        <h2>Send Selected NFTs</h2>
        <div className="row">
          <input
            className="mono"
            style={{ flex: 1, minWidth: 280 }}
            placeholder="Destination address (0x…)"
            value={to}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => {
              setTo(e.target.value.trim());
              resetQuote();
            }}
          />
          <button disabled={!selected.length || !toValid || !selected.every(qtyValid) || !!busy || running} onClick={() => review()}>
            Review {selected.length || ""} Transfer{selected.length === 1 ? "" : "s"}
          </button>
        </div>
        {to && !toValid && <p className="bad">Enter a full 0x address (42 characters). ENS names are not supported.</p>}
        {selected.length > 100 && <p className="bad">Select up to 100 NFTs per batch.</p>}
        {busy && <p className="muted">{busy}</p>}
      </div>

      {quote && (
        <div className="card">
          <h2>Confirm Transfer</h2>
          <div className="kv">
            <b>Destination</b>
            <div className="mono" style={{ fontSize: 16, wordBreak: "break-all", padding: "8px 0" }}>
              {quote.destination.address}
            </div>
            <span className="muted">
              {quote.destination.isContract ? `Smart contract on ${quote.destination.contractOn.join(", ")}` : "Regular wallet (EOA)"}
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
                <th>NFT</th>
                <th>From</th>
                <th>Chain</th>
                <th>Qty</th>
                <th>Network Fee</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {quote.items.map((i: any) => {
                const st = run[i.key];
                const it = view?.items.find((x) => x.key === i.key);
                return (
                  <tr key={i.key}>
                    <td>
                      {it?.name ?? `#${shortId(i.tokenId)}`}
                      <div className="muted small">{it ? collectionOf(it) : short(i.contract)}</div>
                    </td>
                    <td>
                      {i.label} <span className="mono muted">{short(i.address)}</span> <CopyAddress address={i.address} />
                    </td>
                    <td>{i.chainName}</td>
                    <td className="mono">{i.standard === "erc721" ? "1" : i.quantity}</td>
                    <td className="mono">{i.tx ? `${fmtEth(i.feeWei, 8)} ${i.nativeSymbol}` : "—"}</td>
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
                          {label(st.status)}
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
              <b>Transfers</b>
              {ready.length} of {quote.items.length}
            </div>
            {quote.chains
              .filter((c: any) => quote.items.some((i: any) => i.chain === c.chain && i.tx))
              .map((c: any) => (
                <div key={c.chain} className="kv">
                  <b>Fees on {c.chainName}</b>
                  {fmtEth(
                    quote.items
                      .filter((i: any) => i.chain === c.chain && i.tx)
                      .reduce((s: bigint, i: any) => s + BigInt(i.feeWei), 0n)
                      .toString(),
                    8,
                  )}{" "}
                  {c.nativeSymbol}
                </div>
              ))}
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
              {unsent > 0 && <button onClick={retryUnsent}>Retry {unsent} Unsent</button>}
              <button className="ghost" onClick={resetQuote}>
                Close
              </button>
            </div>
          )}
          {!Object.keys(run).length && (
            <>
              <label className="row" style={{ marginTop: 12 }}>
                <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} style={{ width: "auto" }} />
                <span>I checked the full destination address above. NFT transfers cannot be reversed.</span>
              </label>
              <div className="row" style={{ marginTop: 8 }}>
                <button disabled={!checked || !ready.length || !authenticated} onClick={send}>
                  Send {ready.length} Transfer{ready.length === 1 ? "" : "s"}
                </button>
                <button className="ghost" onClick={resetQuote}>
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
