"use client";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { api, fmtEth, short } from "@/lib/api";
import { ChainSelect } from "@/components/ChainSelect";
import { ConfirmBox } from "@/components/Confirm";

type Strategy = "seadrop_public" | "opensea_api" | "generic";
const STRAT_LABEL: Record<Strategy, string> = { seadrop_public: "SeaDrop public (on-chain)", opensea_api: "OpenSea mint API (official)", generic: "Generic contract mint" };

export default function MintPage() {
  const [input, setInput] = useState(""); const [chain, setChain] = useState("");
  const [t, setT] = useState<any>(null); const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState<string | null>(null);
  const [strategy, setStrategy] = useState<Strategy | "">("");
  const [sig, setSig] = useState(""); const [priceEth, setPriceEth] = useState(""); const [tokenId, setTokenId] = useState("");
  const [qty, setQty] = useState(1); const [elig, setElig] = useState<any>(null);
  const [sel, setSel] = useState<Record<string, number>>({}); const [groupFilter, setGroupFilter] = useState("__all");
  const [gasMode, setGasMode] = useState("normal"); const [when, setWhen] = useState<"now" | "stage" | "custom">("now");
  const [stageStart, setStageStart] = useState(""); const [custom, setCustom] = useState(""); const [offsetMs, setOffsetMs] = useState(0);
  const [sim, setSim] = useState<any>(null); const [job, setJob] = useState<any>(null);

  const doResolve = async (inp = input, ch = chain) => {
    if (!inp.trim()) return;
    setErr(null); setT(null); setElig(null); setSim(null); setJob(null); setBusy("Resolving…");
    try {
      const r = await api("/api/resolve", { body: { input: inp.trim(), chain: ch || undefined } });
      setT(r); if (!ch) setChain(r.chain.key);
      setStrategy(r.recommendedStrategy === "none" ? "" : r.recommendedStrategy);
      const s = r.generic?.selected; setSig(s?.signature ?? "");
      setPriceEth(r.generic?.values?.priceWei ? fmtEth(r.generic.values.priceWei, 18) : "0");
      const up = r.stages.find((x: any) => x.status === "upcoming" && x.start); setStageStart(up?.start ?? "");
    } catch (e: any) { setErr(e.message); } finally { setBusy(null); }
  };
  useEffect(() => { const q = new URLSearchParams(window.location.search); const i = q.get("input"); const c = q.get("chain") ?? ""; if (i) { setInput(i); setChain(c); doResolve(i, c); } }, []); // eslint-disable-line

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
    const [w, f = ""] = (priceEth || "0").split("."); const wei = (BigInt(w || "0") * 10n ** 18n + BigInt((f + "0".repeat(18)).slice(0, 18) || "0")).toString();
    return { signature: sig, priceWei: wei, tokenId: cand?.needsTokenId ? tokenId : undefined };
  };

  const checkElig = async () => {
    setErr(null); setSim(null); setBusy("Checking wallets…");
    try {
      const r = await api("/api/eligibility", { body: { chain: t.chain.key, contract: t.contract, input: t.input, strategy, quantity: qty } });
      setElig(r); setSel(Object.fromEntries(r.rows.filter((x: any) => x.eligible).map((x: any) => [x.walletId, x.suggestedQty || qty])));
    } catch (e: any) { setErr(e.message); } finally { setBusy(null); }
  };

  const runAt = when === "now" ? null : when === "stage" ? stageStart || null : custom ? new Date(custom).toISOString() : null;
  const simulate = async () => {
    setErr(null); setSim(null); setBusy("Simulating…");
    try {
      const body = { chain: t.chain.key, contract: t.contract, input: t.input, strategy, slug: t.slug, wallets: Object.entries(sel).filter(([, q]) => q > 0).map(([walletId, quantity]) => ({ walletId, quantity })), generic: genericPayload(), gasMode, runAt, offsetMs };
      setSim(await api("/api/simulate", { body }));
    } catch (e: any) { setErr(e.message); } finally { setBusy(null); }
  };

  const rows = (elig?.rows ?? []).filter((r: any) => groupFilter === "__all" || (r.group ?? "__none") === groupFilter);
  const groups = [...new Set<string>((elig?.rows ?? []).map((r: any) => r.group ?? "__none"))];
  const sym = t?.chain?.nativeSymbol ?? "";

  return (
    <>
      <div className="card">
        <h2>Mint — paste an OpenSea link, collection slug, or contract address</h2>
        <div className="row">
          <input style={{ flex: 1, minWidth: 360 }} placeholder="https://opensea.io/collection/… · 0x… · slug" value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && doResolve()} />
          <ChainSelect value={chain} onChange={setChain} allowAuto />
          <button onClick={() => doResolve()} disabled={!!busy}>Resolve</button>
        </div>
        {busy && <p className="muted">{busy}</p>}
        {err && <div className="err">{err}</div>}
      </div>

      {t && <TargetCard t={t} />}

      {t && (
        <div className="card"><h2>1 · Strategy</h2>
          {!strategies.length && <div className="err">No supported mint path found for this contract.</div>}
          <div className="row">
            <select value={strategy} onChange={(e) => { setStrategy(e.target.value as Strategy); setElig(null); setSim(null); }}>
              <option value="">Choose…</option>{strategies.map((s) => <option key={s} value={s}>{STRAT_LABEL[s]}{s === t.recommendedStrategy ? " (recommended)" : ""}</option>)}
            </select>
            {strategy === "opensea_api" && !t.opensea.apiKey && <span className="warn">OPENSEA_API_KEY not set — this path will fail</span>}
            {strategy === "generic" && (<>
              <select value={sig} onChange={(e) => setSig(e.target.value)}>
                {t.generic.candidates.filter((c: any) => c.supported).map((c: any) => <option key={c.signature} value={c.signature}>{c.signature}{c.payable ? " payable" : ""}</option>)}
              </select>
              <label>price/NFT <input value={priceEth} onChange={(e) => setPriceEth(e.target.value)} style={{ width: 110 }} /> {sym}</label>
              {cand?.needsTokenId && <label>tokenId <input value={tokenId} onChange={(e) => setTokenId(e.target.value)} style={{ width: 90 }} /></label>}
            </>)}
            <label>qty / wallet <input type="number" min={1} max={100} value={qty} onChange={(e) => setQty(Number(e.target.value))} style={{ width: 70 }} /></label>
            <button disabled={!strategy || !!busy} onClick={checkElig}>Check wallets</button>
          </div>
          {strategy === "generic" && <p className="muted">Generic price is read from the contract when a getter exists; verify it. Allowlist/merkle proofs are not supported for generic contracts.</p>}
        </div>
      )}

      {elig && (
        <div className="card"><h2>2 · Wallet eligibility</h2>
          <p className="muted">Price {elig.priceWei ? `${fmtEth(elig.priceWei)} ${sym}` : "unknown"} · gas est. max fee {Number(BigInt(elig.maxFeePerGas)) / 1e9} gwei</p>
          {elig.notes.map((n: string) => <div key={n} className="notice">{n}</div>)}
          <div className="row" style={{ marginBottom: 8 }}>
            <select value={groupFilter} onChange={(e) => setGroupFilter(e.target.value)}><option value="__all">All groups</option>{groups.map((g) => <option key={g} value={g}>{g === "__none" ? "(no group)" : g}</option>)}</select>
            <button className="secondary" onClick={() => setSel((s) => ({ ...s, ...Object.fromEntries(rows.filter((r: any) => r.eligible).map((r: any) => [r.walletId, s[r.walletId] || r.suggestedQty || qty])) }))}>Select eligible</button>
            <button className="secondary" onClick={() => setSel({})}>Clear</button>
            <span className="muted">{Object.keys(sel).length} wallets · {Object.values(sel).reduce((a, b) => a + b, 0)} NFTs</span>
          </div>
          <table>
            <thead><tr><th></th><th>Wallet</th><th>Balance</th><th>Minted / limit</th><th>Allowlist</th><th>Qty</th><th>Est. cost</th><th>Notes</th></tr></thead>
            <tbody>{rows.map((r: any) => (
              <tr key={r.walletId}>
                <td><input type="checkbox" checked={r.walletId in sel} onChange={(e) => setSel((s) => { const n = { ...s }; if (e.target.checked) n[r.walletId] = r.suggestedQty || qty; else delete n[r.walletId]; return n; })} /></td>
                <td>{r.label} <span className="mono muted">{short(r.address)}</span></td>
                <td className="mono">{Number(r.balance).toFixed(5)}</td>
                <td>{r.mintedSoFar ?? "?"} / {r.maxPerWallet ?? "∞"}</td>
                <td><span className={r.allowlist === "eligible" ? "ok" : r.allowlist === "not_eligible" ? "bad" : "muted"}>{r.allowlist}</span></td>
                <td><input type="number" min={0} max={100} style={{ width: 64 }} value={sel[r.walletId] ?? 0} onChange={(e) => setSel((s) => ({ ...s, [r.walletId]: Number(e.target.value) }))} /></td>
                <td className="mono">{Number(r.estCost).toFixed(5)}</td>
                <td className={r.eligible ? "muted" : "bad"}>{r.reasons.join("; ")}</td>
              </tr>))}
              {!rows.length && <tr><td colSpan={8} className="muted">No wallets. Add some on the <Link href="/wallets">Wallets</Link> page.</td></tr>}
            </tbody>
          </table>
          <h2 style={{ marginTop: 16 }}>3 · Timing & gas</h2>
          <div className="row">
            <select value={gasMode} onChange={(e) => setGasMode(e.target.value)}><option value="eco">eco</option><option value="normal">normal</option><option value="aggressive">aggressive</option></select>
            <label><input type="radio" checked={when === "now"} onChange={() => setWhen("now")} /> Mint now</label>
            <label><input type="radio" checked={when === "stage"} disabled={!stageStart} onChange={() => setWhen("stage")} /> At stage start {stageStart ? `(${new Date(stageStart).toLocaleString()})` : "(none upcoming)"}</label>
            <label><input type="radio" checked={when === "custom"} onChange={() => setWhen("custom")} /> At</label>
            <input type="datetime-local" value={custom} onChange={(e) => { setCustom(e.target.value); setWhen("custom"); }} />
            {when !== "now" && <label>offset ms <input type="number" value={offsetMs} min={-5000} max={60000} onChange={(e) => setOffsetMs(Number(e.target.value))} style={{ width: 90 }} /></label>}
            <button disabled={!Object.values(sel).some((q) => q > 0) || !!busy} onClick={simulate}>Simulate</button>
          </div>
        </div>
      )}

      {sim && (
        <div className="card"><h2>4 · Simulation & confirm</h2>
          <div className="grid">
            <KV k="Wallets / NFTs" v={`${sim.summary.wallets} / ${sim.summary.totalNfts}`} />
            <KV k="Mint value" v={`${sim.summary.totalValue} ${sym}`} />
            <KV k="Max gas" v={`${sim.summary.totalMaxGas} ${sym}`} />
            <KV k="Worst-case total" v={`${sim.summary.totalMax} ${sym}`} />
            <KV k="Max fee" v={`${sim.summary.maxFeePerGasGwei.toFixed(3)} gwei${sim.summary.feesCapped ? " (capped)" : ""}`} />
            <KV k="Daily spent / cap" v={`${sim.summary.dailySpent} / ${sim.summary.dailyCap}`} />
            <KV k="Max price / NFT" v={sim.summary.maxPricePerNft} />
            <KV k="When" v={sim.summary.runAt ? new Date(sim.summary.runAt).toLocaleString() : "now"} />
          </div>
          {sim.blockers.map((b: string) => <div key={b} className="err">{b}</div>)}
          <table style={{ marginTop: 10 }}><thead><tr><th>Wallet</th><th>Qty</th><th>Result</th><th>Gas limit</th><th>Value</th><th>Selector</th></tr></thead>
            <tbody>{sim.rows.map((r: any) => <tr key={r.walletId}><td>{r.label} <span className="mono muted">{short(r.address)}</span></td><td>{r.quantity}</td>
              <td>{r.ok ? <span className="ok">ok</span> : r.expectedRevertBeforeStart ? <span className="warn">reverts now (not started) — will retry at start</span> : <span className="bad">{r.error}</span>}</td>
              <td className="mono">{r.gasLimit}</td><td className="mono">{fmtEth(r.valueWei)}</td><td className="mono">{r.selector}</td></tr>)}</tbody></table>
          {sim.planId && !job && <ConfirmBox phrase={sim.confirmPhrase} label={sim.summary.runAt ? "Schedule mint" : "Mint now"} onConfirm={async (p) => { try { const r = await api("/api/mint/execute", { body: { planId: sim.planId, confirmPhrase: p } }); setJob(r.job); } catch (e: any) { setErr(e.message); } }} />}
          {job && <div className="notice">Job <span className="mono">{job.id}</span> {job.status}. Follow it on <Link href={`/jobs?id=${job.id}`}>Jobs</Link>.</div>}
        </div>
      )}
    </>
  );
}

function KV({ k, v }: { k: string; v: React.ReactNode }) { return <div className="kv"><b>{k}</b>{v}</div>; }

function TargetCard({ t }: { t: any }) {
  const sym = t.chain.nativeSymbol;
  return (
    <div className="card">
      <h2>{t.name ?? t.opensea?.drop?.collection_name ?? "Unnamed contract"} {t.symbol && <span className="muted">({t.symbol})</span>} <span className="pill">{t.kind}</span> <span className="pill">{t.standard}</span></h2>
      <div className="grid">
        <KV k="Chain" v={`${t.chain.name} (${t.chain.chainId})`} />
        <KV k="Contract" v={<a className="mono" href={`${t.chain.explorer}/address/${t.contract}`} target="_blank">{short(t.contract)}</a>} />
        <KV k="Slug" v={t.slug ? (t.opensea.url ? <a href={t.opensea.url} target="_blank">{t.slug}</a> : t.slug) : "—"} />
        <KV k="Supply" v={`${t.supply.total ?? "?"} / ${t.supply.max ?? "?"} (${t.supply.remaining ?? "?"} left)`} />
        <KV k="Recommended" v={t.recommendedStrategy} />
        {t.generic && <KV k="ABI source" v={`${t.generic.abiSource}${t.generic.implementation ? " (proxy)" : ""}`} />}
        {t.generic?.values?.priceWei && <KV k="Price (getter)" v={`${fmtEth(t.generic.values.priceWei)} ${sym}`} />}
        {t.generic?.values?.saleActive !== undefined && <KV k="Sale active" v={String(t.generic.values.saleActive)} />}
        {t.generic?.values?.paused !== undefined && <KV k="Paused" v={String(t.generic.values.paused)} />}
      </div>
      {t.stages.length > 0 && (
        <table style={{ marginTop: 12 }}><thead><tr><th>Stage</th><th>Type</th><th>Price</th><th>Start</th><th>End</th><th>Max/wallet</th><th>Status</th><th>Source</th></tr></thead>
          <tbody>{t.stages.map((s: any, i: number) => <tr key={i}><td>{s.name}</td><td>{s.type}</td><td>{s.priceWei !== null ? `${fmtEth(s.priceWei)} ${sym}` : "?"}</td>
            <td>{s.start ? new Date(s.start).toLocaleString() : "?"}</td><td>{s.end ? new Date(s.end).toLocaleString() : "—"}</td><td>{s.maxPerWallet ?? "—"}</td>
            <td className={s.status === "active" ? "ok" : s.status === "upcoming" ? "warn" : "muted"}>{s.status}</td><td className="muted">{s.source}</td></tr>)}</tbody></table>
      )}
      {t.warnings.map((w: string) => <div key={w} className="notice">{w}</div>)}
      {t.opensea?.error && <p className="muted">OpenSea: {t.opensea.error}</p>}
    </div>
  );
}
