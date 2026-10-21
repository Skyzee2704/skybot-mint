"use client";
// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useMemo, useState } from "react";
import { STRATEGY_LABELS } from "@/lib/labels";
import Link from "next/link";
import { fmtEth, short } from "@/lib/api";
import { useApi, useShell } from "@/components/AppShell";
import { usePrivy, useSignMessage } from "@privy-io/react-auth";
import { useWalletList } from "@/lib/wallets";
import { ChainSelect } from "@/components/ChainSelect";
import { ConfirmBox } from "@/components/Confirm";

type Strategy = "seadrop_public" | "opensea_api" | "generic";
const STRAT = STRATEGY_LABELS as Record<Strategy, string>;

export default function MintPage() {
  const api = useApi();
  const { userId, tgOnly, connectPrivy } = useShell();
  const { authenticated } = usePrivy();
  const { signMessage } = useSignMessage();
  const walletList = useWalletList(api, userId);
  const [scope, setScope] = useState<"all" | "select">("all");
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [qtyMode, setQtyMode] = useState<"max" | "custom">("max");
  const [input, setInput] = useState("");
  const [chain, setChain] = useState("");
  const [t, setT] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [strategy, setStrategy] = useState<Strategy | "">("");
  const [sig, setSig] = useState("");
  const [priceEth, setPriceEth] = useState("");
  const [tokenId, setTokenId] = useState("");
  const [qty, setQty] = useState(1);
  const [elig, setElig] = useState<any>(null);
  const [sel, setSel] = useState<Record<string, boolean>>({});
  const [verifyNote, setVerifyNote] = useState<string | null>(null);
  const [gasMode, setGasMode] = useState("normal");
  const [when, setWhen] = useState<"now" | "stage" | "custom">("now");
  const [stageStart, setStageStart] = useState("");
  const [custom, setCustom] = useState("");
  const [offsetMs, setOffsetMs] = useState(0);
  const [sim, setSim] = useState<any>(null);
  const [job, setJob] = useState<any>(null);

  const doResolve = async (inp = input, ch = chain) => {
    if (!inp.trim()) return;
    setErr(null);
    setT(null);
    setElig(null);
    setSim(null);
    setJob(null);
    setBusy("Resolving…");
    try {
      const r = await api("/api/resolve", { body: { input: inp.trim(), chain: ch || undefined } });
      setT(r);
      if (!ch) setChain(r.chain.key);
      setStrategy(r.recommendedStrategy === "none" ? "" : r.recommendedStrategy);
      setSig(r.generic?.selected?.signature ?? "");
      setPriceEth(r.generic?.values?.priceWei ? fmtEth(r.generic.values.priceWei, 18) : "0");
      const up = r.stages.find((x: any) => x.status === "upcoming" && x.start);
      setStageStart(up?.start ?? "");
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(null);
    }
  };
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const i = q.get("input");
    const c = q.get("chain") ?? "";
    if (i) {
      setInput(i);
      setChain(c);
      doResolve(i, c);
    }
  }, []); // eslint-disable-line

  const strategies = useMemo<Strategy[]>(() => {
    if (!t) return [];
    const s: Strategy[] = [];
    if (t.kind === "seadrop") s.push("seadrop_public");
    if (t.kind === "seadrop" && t.slug) s.push("opensea_api");
    if (t.generic?.candidates?.some((c: any) => c.supported)) s.push("generic");
    return s;
  }, [t]);
  const cand = t?.generic?.candidates?.find((c: any) => c.signature === sig);
  const genericPayload = () => {
    if (strategy !== "generic") return undefined;
    const [w, f = ""] = (priceEth || "0").split(".");
    const wei = (BigInt(w || "0") * 10n ** 18n + BigInt((f + "0".repeat(18)).slice(0, 18) || "0")).toString();
    return { signature: sig, priceWei: wei, tokenId: cand?.needsTokenId ? tokenId : undefined };
  };

  const pickedIds = Object.keys(picked).filter((k) => picked[k]);
  const walletIds = scope === "all" ? undefined : pickedIds;

  /** Browser-side OpenSea sign-in (Privy embedded wallet, off-chain, no gas). Returns proofs for the server. */
  const openseaProofs = async (ids: string[]) => {
    const { messages } = await api("/api/opensea/siwe/prepare", { body: { walletIds: ids } });
    const proofs: any[] = [];
    let failed = 0;
    for (const m of messages) {
      try {
        const { signature } = await signMessage({ message: m.message }, { address: m.address, uiOptions: { showWalletUIs: false } });
        proofs.push({ walletId: m.walletId, fields: m.fields, signature });
      } catch {
        failed++;
      }
    }
    return { proofs, failed };
  };

  const checkElig = async (opts: { verify?: boolean } = {}) => {
    setErr(null);
    setSim(null);
    setVerifyNote(null);
    setBusy(opts.verify ? "Verifying with OpenSea…" : "Checking wallets…");
    try {
      const base = { chain: t.chain.key, contract: t.contract, input: t.input, strategy, walletIds, generic: genericPayload() };
      let r = await api("/api/eligibility", { body: base });
      const need = r.rows.filter((x: any) => x.needsOpenSeaLogin).map((x: any) => x.walletId);
      if (need.length && (opts.verify || r.openseaAutoVerify)) {
        if (!authenticated) setVerifyNote("OpenSea verification signs with your Privy wallet. Connect with Privy first.");
        else {
          setBusy(`Verifying ${need.length} wallet(s) with OpenSea…`);
          const { proofs, failed } = await openseaProofs(need);
          if (proofs.length) r = await api("/api/eligibility", { body: { ...base, siwe: proofs } });
          if (failed)
            setVerifyNote(`${failed} wallet(s) could not sign the OpenSea sign-in message (only Privy wallets on this device can sign).`);
        }
      }
      setElig(r);
      setSel(Object.fromEntries(r.rows.filter((x: any) => x.eligibleIgnoringBalance).map((x: any) => [x.walletId, true])));
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(null);
    }
  };
  /** Quantity per selected wallet: the stage maximum still available to it, or the custom number (capped). */
  const qtyFor = (r: any) => {
    const max = Math.max(0, r.suggestedQty ?? 0);
    return qtyMode === "max" ? max : Math.min(Math.max(1, qty), max || qty);
  };
  const runAt = when === "now" ? null : when === "stage" ? stageStart || null : custom ? new Date(custom).toISOString() : null;
  const simulate = async () => {
    setErr(null);
    setSim(null);
    setBusy("Simulating…");
    try {
      setSim(
        await api("/api/simulate", {
          body: {
            chain: t.chain.key,
            contract: t.contract,
            input: t.input,
            strategy,
            slug: t.slug,
            wallets: rows
              .filter((r: any) => sel[r.walletId] && qtyFor(r) > 0)
              .map((r: any) => ({ walletId: r.walletId, quantity: qtyFor(r) })),
            generic: genericPayload(),
            gasMode,
            runAt,
            offsetMs,
          },
        }),
      );
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(null);
    }
  };
  const rows = elig?.rows ?? [];
  const sym = t?.chain?.nativeSymbol ?? "";

  return (
    <>
      <div className="card">
        <h2>Mint</h2>
        <p className="muted">Paste an OpenSea link, collection slug, or contract address.</p>
        <div className="row">
          <input
            style={{ flex: 1, minWidth: 260 }}
            placeholder="https://opensea.io/collection/… · 0x… · slug"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && doResolve()}
          />
          <ChainSelect value={chain} onChange={setChain} allowAuto />
          <button onClick={() => doResolve()} disabled={!!busy}>
            Resolve
          </button>
        </div>
        {busy && <p className="muted">{busy}</p>}
        {err && <div className="err">{err}</div>}
      </div>

      {t && (
        <div className="card">
          <h2>
            {t.name ?? "Contract"} {t.symbol && <span className="muted">({t.symbol})</span>} <span className="pill">{t.kind}</span>{" "}
            <span className="pill">{t.standard}</span>
          </h2>
          <div className="grid">
            <div className="kv">
              <b>Chain</b>
              {t.chain.name}
            </div>
            <div className="kv">
              <b>Contract</b>
              <span className="mono">{short(t.contract)}</span>
            </div>
            <div className="kv">
              <b>Supply</b>
              {t.supply.total ?? "?"} / {t.supply.max ?? "?"} ({t.supply.remaining ?? "?"} left)
            </div>
            <div className="kv">
              <b>Recommended</b>
              {t.recommendedStrategy}
            </div>
          </div>
          {t.stages?.length > 0 && (
            <table style={{ marginTop: 12 }}>
              <thead>
                <tr>
                  <th>Stage</th>
                  <th>Type</th>
                  <th>Price</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {t.stages.map((s: any, i: number) => (
                  <tr key={i}>
                    <td>{s.name}</td>
                    <td>{s.type}</td>
                    <td>{s.priceWei != null ? `${fmtEth(s.priceWei)} ${sym}` : "?"}</td>
                    <td className={s.status === "active" ? "ok" : s.status === "upcoming" ? "warn" : "muted"}>{s.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {t.warnings?.map((w: string) => (
            <div key={w} className="notice">
              {w}
            </div>
          ))}
        </div>
      )}

      {t && (
        <div className="card">
          <h2>1 · Strategy</h2>
          <div className="row">
            <select
              value={strategy}
              onChange={(e) => {
                setStrategy(e.target.value as Strategy);
                setElig(null);
                setSim(null);
              }}
              style={{ width: "auto" }}
            >
              <option value="">Choose…</option>
              {strategies.map((s) => (
                <option key={s} value={s}>
                  {STRAT[s]}
                  {s === t.recommendedStrategy ? " ★" : ""}
                </option>
              ))}
            </select>
            {strategy === "generic" && (
              <>
                <select value={sig} onChange={(e) => setSig(e.target.value)} style={{ width: "auto" }}>
                  {t.generic.candidates
                    .filter((c: any) => c.supported)
                    .map((c: any) => (
                      <option key={c.signature} value={c.signature}>
                        {c.signature}
                      </option>
                    ))}
                </select>
                <label>
                  price <input value={priceEth} onChange={(e) => setPriceEth(e.target.value)} style={{ width: 110 }} /> {sym}
                </label>
                {cand?.needsTokenId && (
                  <label>
                    tokenId <input value={tokenId} onChange={(e) => setTokenId(e.target.value)} style={{ width: 90 }} />
                  </label>
                )}
              </>
            )}
          </div>
          <div className="row" style={{ marginTop: 12 }}>
            <div className="segmented" role="radiogroup" aria-label="Wallets to check">
              <button className={scope === "all" ? "on" : ""} onClick={() => setScope("all")}>
                Check all wallets
              </button>
              <button className={scope === "select" ? "on" : ""} onClick={() => setScope("select")}>
                Select wallets
              </button>
            </div>
            <button disabled={!strategy || !!busy || (scope === "select" && !pickedIds.length)} onClick={() => checkElig()}>
              Check Eligibility
            </button>
            <span className="muted">
              {scope === "all"
                ? walletList.loading
                  ? "Loading wallets…"
                  : `${walletList.wallets.length} wallet(s)`
                : `${pickedIds.length} of ${walletList.wallets.length} selected`}
            </span>
          </div>
          {scope === "select" && (
            <>
              <div className="row" style={{ marginTop: 8 }}>
                <button className="ghost" onClick={() => setPicked(Object.fromEntries(walletList.wallets.map((w) => [w.id, true])))}>
                  Select All
                </button>
                <button className="ghost" onClick={() => setPicked({})}>
                  Clear
                </button>
              </div>
              <div className="wallet-pick">
                {walletList.loading &&
                  [0, 1, 2].map((i) => (
                    <label key={i}>
                      <span className="skeleton" style={{ width: 160 }} />
                    </label>
                  ))}
                {walletList.wallets.map((w) => (
                  <label key={w.id} className={picked[w.id] ? "on" : ""}>
                    <input
                      type="checkbox"
                      checked={Boolean(picked[w.id])}
                      onChange={(e) => setPicked((p) => ({ ...p, [w.id]: e.target.checked }))}
                    />
                    <span>
                      {w.label} <span className="mono muted">{short(w.address)}</span>
                    </span>
                  </label>
                ))}
                {!walletList.loading && !walletList.wallets.length && (
                  <span className="muted">
                    No wallets yet. Add some on <Link href="/app/wallets">Wallets</Link>.
                  </span>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {elig && (
        <div className="card">
          <h2>2 · Wallet Eligibility</h2>
          {elig.notes?.map((n: string) => (
            <div key={n} className="notice">
              {n}
            </div>
          ))}
          {rows.some((r: any) => r.needsOpenSeaLogin) && (
            <div className="notice row" style={{ justifyContent: "space-between" }}>
              <span>
                {rows.filter((r: any) => r.needsOpenSeaLogin).length} wallet(s) need OpenSea verification for this stage. Each wallet signs
                OpenSea&apos;s sign-in message in your browser: off-chain, no gas, no balance needed. Signing in accepts OpenSea&apos;s
                Terms for that wallet.
              </span>
              {tgOnly && !authenticated ? (
                <button onClick={connectPrivy}>Connect with Privy</button>
              ) : (
                <button disabled={!!busy} onClick={() => checkElig({ verify: true })}>
                  Verify with OpenSea
                </button>
              )}
            </div>
          )}
          {verifyNote && <div className="notice">{verifyNote}</div>}
          <div className="row" style={{ marginBottom: 8 }}>
            <button
              className="ghost"
              onClick={() =>
                setSel(Object.fromEntries(rows.filter((r: any) => r.eligibleIgnoringBalance).map((r: any) => [r.walletId, true])))
              }
            >
              Select Eligible
            </button>
            <button
              className="ghost"
              onClick={() => setSel(Object.fromEntries(rows.filter((r: any) => r.eligible).map((r: any) => [r.walletId, true])))}
            >
              Select Ready to Mint
            </button>
            <button className="ghost" onClick={() => setSel({})}>
              Clear
            </button>
            <span className="spacer" />
            <label>
              Quantity per wallet{" "}
              <select value={qtyMode} onChange={(e) => setQtyMode(e.target.value as "max" | "custom")} style={{ width: "auto" }}>
                <option value="max">Max allowed</option>
                <option value="custom">Custom</option>
              </select>
            </label>
            {qtyMode === "custom" && (
              <input
                type="number"
                min={1}
                max={1000}
                value={qty}
                onChange={(e) => setQty(Math.max(1, Number(e.target.value) || 1))}
                style={{ width: 80 }}
                aria-label="Quantity per wallet"
              />
            )}
            <span className="muted">{Object.values(sel).filter(Boolean).length} selected</span>
          </div>
          <table>
            <thead>
              <tr>
                <th></th>
                <th>Wallet</th>
                <th>Eligibility</th>
                <th className="hide-sm">Simulation</th>
                <th>Qty</th>
                <th>Mint Readiness</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r: any) => {
                const other = r.reasons.filter((x: string) => !x.startsWith("insufficient balance"));
                return (
                  <tr key={r.walletId}>
                    <td>
                      <input
                        type="checkbox"
                        checked={Boolean(sel[r.walletId])}
                        onChange={(e) => setSel((s) => ({ ...s, [r.walletId]: e.target.checked }))}
                      />
                    </td>
                    <td>
                      {r.label} <span className="mono muted">{short(r.address)}</span>
                    </td>
                    <td>
                      <Access a={r.access} stages={r.stages} />
                    </td>
                    <td className="hide-sm">
                      {r.simulation?.ok === true ? (
                        <span className="ok">passes</span>
                      ) : r.simulation?.ok === false ? (
                        <span className="bad">{r.simulation.reason}</span>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td className="mono">{sel[r.walletId] ? qtyFor(r) : <span className="muted">{r.suggestedQty}</span>}</td>
                    <td>
                      {other.length > 0 && <div className="bad">{other.join("; ")}</div>}
                      {r.balanceOk ? (
                        <span className="ok">
                          Funded ({Number(r.balance).toFixed(5)} {sym})
                        </span>
                      ) : (
                        <span className="warn">
                          Needs ~{Number(r.estCost).toFixed(6)} {sym} · has {Number(r.balance).toFixed(5)}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
              {!rows.length && (
                <tr>
                  <td colSpan={6} className="muted">
                    No wallets. Add some on <Link href="/app/wallets">Wallets</Link>.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          <h2 style={{ marginTop: 16 }}>3 · Timing</h2>
          <div className="row">
            <select value={gasMode} onChange={(e) => setGasMode(e.target.value)} style={{ width: "auto" }}>
              <option value="eco">eco</option>
              <option value="normal">normal</option>
              <option value="aggressive">aggressive</option>
            </select>
            <label>
              <input type="radio" checked={when === "now"} onChange={() => setWhen("now")} /> Now
            </label>
            <label>
              <input type="radio" checked={when === "stage"} disabled={!stageStart} onChange={() => setWhen("stage")} /> Stage Start
            </label>
            <label>
              <input type="radio" checked={when === "custom"} onChange={() => setWhen("custom")} /> Custom
            </label>
            <input
              type="datetime-local"
              value={custom}
              onChange={(e) => {
                setCustom(e.target.value);
                setWhen("custom");
              }}
              style={{ width: "auto" }}
            />
            {when !== "now" && (
              <label>
                offset ms{" "}
                <input type="number" value={offsetMs} onChange={(e) => setOffsetMs(Number(e.target.value))} style={{ width: 90 }} />
              </label>
            )}
            <button disabled={!rows.some((r: any) => sel[r.walletId] && qtyFor(r) > 0) || !!busy} onClick={simulate}>
              Simulate
            </button>
          </div>
        </div>
      )}

      {sim && (
        <div className="card">
          <h2>4 · Confirm</h2>
          <div className="grid">
            <div className="kv">
              <b>NFTs</b>
              {sim.summary.totalNfts}
            </div>
            <div className="kv">
              <b>Value</b>
              {sim.summary.totalValue} {sym}
            </div>
            <div className="kv">
              <b>Max Gas</b>
              {sim.summary.totalMaxGas} {sym}
            </div>
            <div className="kv">
              <b>Worst Case</b>
              {sim.summary.totalMax} {sym}
            </div>
            <div className="kv">
              <b>Daily / Cap</b>
              {sim.summary.dailySpent} / {sim.summary.dailyCap}
            </div>
          </div>
          {sim.blockers?.map((b: string) => (
            <div key={b} className="err">
              {b}
            </div>
          ))}
          {sim.planId && !job && (
            <ConfirmBox
              phrase={sim.confirmPhrase}
              label={sim.summary.runAt ? "Schedule Mint" : "Mint Now"}
              onConfirm={async (p) => {
                try {
                  const r = await api("/api/mint/execute", { body: { planId: sim.planId, confirmPhrase: p } });
                  setJob(r.job);
                } catch (e: any) {
                  setErr(e.message);
                }
              }}
            />
          )}
          {job && (
            <div className="notice">
              Job <span className="mono">{job.id}</span> {job.status}. Track on <Link href="/app/jobs">Jobs</Link>.
            </div>
          )}
        </div>
      )}
    </>
  );
}

const ACCESS_LABEL: Record<string, string> = {
  yes: "Eligible",
  public: "Eligible (public)",
  no: "Not eligible",
  unknown: "Unknown",
  "n/a": "No allowlist",
};

function Access({ a, stages }: { a: any; stages?: any[] | null }) {
  if (!a) return <span className="muted">—</span>;
  const cls = a.status === "yes" || a.status === "public" ? "ok" : a.status === "no" ? "bad" : "muted";
  return (
    <div>
      <b className={cls}>{ACCESS_LABEL[a.status] ?? a.status}</b>
      <div className="muted" style={{ fontSize: 12 }}>
        {a.detail ? `${a.detail} · ` : ""}
        {a.source}
      </div>
      {stages && stages.length > 1 && (
        <div className="stage-list">
          {stages.map((s: any) => (
            <span key={s.uuid ?? s.label} className={s.eligible ? "ok" : s.eligible === false ? "bad" : "muted"} style={{ marginRight: 8 }}>
              {s.label ?? s.type}: {s.eligible ? "yes" : s.eligible === false ? "no" : "?"}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
