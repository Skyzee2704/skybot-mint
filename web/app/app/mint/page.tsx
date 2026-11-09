"use client";
// SPDX-License-Identifier: AGPL-3.0-only
import { withSignTimeout } from "@/lib/signing";
import { useEffect, useMemo, useState } from "react";
import { STRATEGY_LABELS } from "@/lib/labels";
import Link from "next/link";
import { fmtEth, short } from "@/lib/api";
import { useApi, useShell } from "@/components/AppShell";
import { usePrivy, useSignMessage, useWallets } from "@privy-io/react-auth";
import { assertOpenSeaSiwe } from "@nft-mint-bot/server/siwe";
import { useWalletList } from "@/lib/wallets";
import { ChainSelect } from "@/components/ChainSelect";
import { ConfirmBox } from "@/components/Confirm";
import { formatDateTime, localTimeZone, zoneLabel } from "@/lib/time";
import { useNow } from "@/lib/useNow";
import { clampQty } from "@nft-mint-bot/server/qty";
import {
  groupByStage,
  mintStageOptions,
  pickTimingOption,
  stageWalletView,
  summarizeGroup,
  type StageWalletView,
} from "@nft-mint-bot/server/stage-eligibility";

type Strategy = "seadrop_public" | "opensea_api" | "generic" | "kalos";
const STRAT = STRATEGY_LABELS as Record<Strategy, string>;

export default function MintPage() {
  const api = useApi();
  const { userId, tgOnly, connectPrivy } = useShell();
  const { authenticated } = usePrivy();
  const { signMessage } = useSignMessage();
  const { wallets: privyWallets } = useWallets();
  const walletList = useWalletList(api, userId);
  const [scope, setScope] = useState<"all" | "select">("all");
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [input, setInput] = useState("");
  const [chain, setChain] = useState("");
  const [t, setT] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [strategy, setStrategy] = useState<Strategy | "">("");
  const [sig, setSig] = useState("");
  const [priceEth, setPriceEth] = useState("");
  const [tokenId, setTokenId] = useState("");
  const [qtys, setQtys] = useState<Record<string, number>>({});
  const [force, setForce] = useState<Record<string, boolean>>({});
  const [elig, setElig] = useState<any>(null);
  const [sel, setSel] = useState<Record<string, boolean>>({});
  const [verifyNote, setVerifyNote] = useState<string | null>(null);
  const [gasMode, setGasMode] = useState("normal");
  /** Timing choice: "now" or a stage name (see mintStageOptions). null = earliest stage some wallet can mint. */
  const [timing, setTiming] = useState<string | null>(null);
  const [timingNote, setTimingNote] = useState<string | null>(null);
  /**
   * Checkbox and quantity edits stick only for the stage they were made on. A different stage
   * (or a fresh eligibility check) snaps back to that stage's eligible wallets and per-wallet max.
   */
  const [selStage, setSelStage] = useState<string | null>(null);
  const [qtyStage, setQtyStage] = useState<string | null>(null);
  const [offsetMs, setOffsetMs] = useState(0);
  const [sim, setSim] = useState<any>(null);
  const [job, setJob] = useState<any>(null);
  const now = useNow(1000);
  const [tz, setTz] = useState<string | null>(null);
  useEffect(() => setTz(localTimeZone()), []);
  const fmt = (when: string | number | Date | null | undefined, relative = true) =>
    when ? formatDateTime(when, { timeZone: tz ?? undefined, relative, now }) : "";

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
      setTiming(null);
      setTimingNote(null);
      setSelStage(null);
      setQtyStage(null);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(null);
    }
  };
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const i = q.get("input") ?? q.get("link");
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
    if (t.dropSource === "kalos" || t.recommendedStrategy === "kalos") s.push("kalos");
    else if (t.kind === "seadrop") s.push("seadrop_public");
    if (t.dropSource !== "kalos" && t.kind === "seadrop" && t.slug) s.push("opensea_api");
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

  /**
   * Silent OpenSea sign-in for embedded Privy wallets on this device (off-chain, no gas, no popup).
   * SAFETY: every message is checked by the SIWE guard first — only OpenSea's exact login text for that same
   * wallet with a fresh nonce is ever signed; anything else is refused. Never typed data or transactions.
   */
  const openseaProofs = async (ids: string[]) => {
    const local = new Set((privyWallets ?? []).filter((w) => w.walletClientType === "privy").map((w) => w.address.toLowerCase()));
    const own = walletList.wallets.filter((w) => ids.includes(w.id) && local.has(w.address.toLowerCase())).map((w) => w.id);
    const proofs: any[] = [];
    let failed = ids.length - own.length;
    if (!own.length) return { proofs, failed };
    const { messages } = await api("/api/opensea/siwe/prepare", { body: { walletIds: own } });
    for (const m of messages) {
      try {
        assertOpenSeaSiwe(m.message, m.address);
        const { signature } = await withSignTimeout(
          signMessage({ message: m.message }, { address: m.address, uiOptions: { showWalletUIs: false } }),
          { what: "OpenSea sign-in" },
        );
        proofs.push({ walletId: m.walletId, fields: m.fields, signature });
      } catch {
        failed++;
      }
    }
    return { proofs, failed };
  };

  const checkElig = async () => {
    setErr(null);
    setSim(null);
    setVerifyNote(null);
    setBusy("Checking wallets…");
    try {
      const base = { chain: t.chain.key, contract: t.contract, input: t.input, strategy, walletIds, generic: genericPayload() };
      let r = await api("/api/eligibility", { body: base });
      const need = r.rows.filter((x: any) => x.needsOpenSeaLogin).map((x: any) => x.walletId);
      if (need.length && authenticated) {
        setBusy(`Verifying ${need.length} wallet(s) with OpenSea…`);
        const { proofs, failed } = await openseaProofs(need);
        if (proofs.length) r = await api("/api/eligibility", { body: { ...base, siwe: proofs } });
        if (failed) setVerifyNote(`${failed} wallet(s) couldn't be verified with OpenSea from this device.`);
      }
      setElig(r);
      // Selection and quantities follow the chosen stage (see viewFor), not the checker's target stage.
      setSelStage(null);
      setQtyStage(null);
      setSel({});
      setQtys({});
      setForce({});
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(null);
    }
  };
  const simulate = async (forceIds: string[] = []) => {
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
              .filter((r: any) => isSel(r) && qtyFor(r) > 0 && (!chosen?.stage || chosenIds.has(r.walletId)))
              .map((r: any) => ({ walletId: r.walletId, quantity: qtyFor(r) })),
            generic: genericPayload(),
            gasMode,
            // The server derives the run time from the stage; runAt is sent only for display consistency checks.
            stage: chosen?.stage?.name ?? null,
            runAt: chosen?.runAt ?? null,
            offsetMs: chosen && !chosen.live ? offsetMs : 0,
            forceWalletIds: forceIds.length ? forceIds : undefined,
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
  // Allowlist stages (Public excluded: every wallet can mint), soonest first, each with its wallet verdicts.
  const stageGroups = useMemo(
    () => (elig?.rows?.length && t?.stages?.length ? groupByStage(t.stages, elig.rows, elig.targetStage ?? null) : []),
    [elig, t],
  );
  const stageWhen = (s: any) =>
    s.status === "active"
      ? s.end
        ? `live · ends ${fmt(s.end)}`
        : "live now"
      : s.status === "upcoming" && s.start
        ? `starts ${fmt(s.start)}`
        : s.start
          ? fmt(s.start)
          : "";
  const sym = t?.chain?.nativeSymbol ?? "";
  const priceLabel = (s: { priceWei?: string | null; paymentSymbol?: string | null }) =>
    s?.priceWei == null ? "Unknown" : s.priceWei === "0" ? "Free" : `${fmtEth(s.priceWei)} ${s.paymentSymbol || sym}`;
  // One source of truth: every stage some wallet can still mint. Not the checker's target stage, and not
  // the current checkboxes (those are filled in from the stage the member picks).
  const options = useMemo(
    () => (t && elig?.rows ? mintStageOptions(t.stages ?? [], elig.rows, elig.targetStage ?? null, now) : []),
    [t, elig, now],
  );
  const { option: chosen, fellBack } = pickTimingOption(options, timing);
  const paySym: string | null = chosen?.stage?.paymentSymbol || null;
  const chosenIds = new Set(chosen?.walletIds ?? []);
  const stageKey = chosen?.key ?? null;
  const supplyRemaining = (() => {
    const n = t?.supply?.remaining;
    if (n == null || n === "") return null;
    const v = Number(n);
    return Number.isSafeInteger(v) ? v : null;
  })();
  const viewFor = (r: any): StageWalletView => stageWalletView(r, chosen?.stage ?? null, elig?.targetStage ?? null, supplyRemaining);
  /** Checked for the chosen stage: the stage's eligible wallets, until the member edits the checkboxes. */
  const isSel = (r: any) => (selStage === stageKey ? Boolean(sel[r.walletId]) : viewFor(r).eligible);
  /** Stepper bound: this stage's per-wallet limit (at least 1 so any wallet can be simulated). */
  const maxFor = (r: any) => Math.max(1, viewFor(r).maxQty);
  const qtyFor = (r: any) => {
    const view = viewFor(r);
    const stored = qtyStage === stageKey ? qtys[r.walletId] : undefined;
    return clampQty(stored ?? (view.suggestedQty > 0 ? view.suggestedQty : 1), maxFor(r));
  };
  const setQtyFor = (r: any, q: number) => {
    const key = stageKey ?? "";
    setQtys((m) => {
      const base = qtyStage === key ? m : Object.fromEntries(rows.map((rr: any) => [rr.walletId, Math.max(1, viewFor(rr).suggestedQty)]));
      return { ...base, [r.walletId]: clampQty(q, maxFor(r)) };
    });
    setQtyStage(key);
  };
  const rowCostWei = (r: any) => BigInt(viewFor(r).unitPriceWei ?? r.unitPriceWei ?? "0") * BigInt(qtyFor(r)) + BigInt(r.gasCostWei ?? "0");
  const pickStage = (key: string) => {
    setTiming(key);
    setTimingNote(null);
    setSelStage(null);
    setQtyStage(null);
  };
  const selRows = rows.filter((r: any) => isSel(r));
  const shownRows = rows.filter((r: any) => viewFor(r).eligible);
  const hiddenCount = rows.length - shownRows.length;
  const coveredStages = new Set(stageGroups.map((g) => g.stage.name));
  // Public (and a plain "Now" when the drop has no stages) have no allowlist card. They join the same picker.
  const extraStages = options.filter((o) => o.kind === "stage" && o.stage && !coveredStages.has(o.stage.name));
  const nowOnly = options.find((o) => o.kind === "now" && !o.stage) ?? null;
  const eligibleIn = (stage: any) =>
    rows.filter((r: any) => stageWalletView(r, stage, elig?.targetStage ?? null, supplyRemaining).eligible).length;
  const minting = selRows.filter((r: any) => !chosen?.stage || chosenIds.has(r.walletId));
  const optionsKey = options.map((o) => `${o.key}:${o.live}`).join("|");
  useEffect(() => {
    if (timing && fellBack && chosen) {
      const gone = timing === "now" ? "No eligible stage is live any more" : `${timing} is no longer available`;
      setTimingNote(`${gone}, so timing switched to ${chosen.kind === "now" ? "Now" : chosen.name}.`);
      setTiming(chosen.key);
      setSelStage(null);
      setQtyStage(null);
    } else if (timing && !chosen) {
      setTiming(null);
      setSelStage(null);
      setQtyStage(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [optionsKey, timing]);
  useEffect(() => setSim(null), [chosen?.key, chosen?.live]);
  const totalWei = selRows.reduce((a: bigint, r: any) => a + rowCostWei(r), 0n);
  const totalNfts = selRows.reduce((a: number, r: any) => a + qtyFor(r), 0);
  const forceIds = Object.keys(force).filter((k) => force[k]);

  return (
    <>
      <div className="card">
        <h2>Mint</h2>
        <p className="muted">Paste an OpenSea link, collection slug, or contract address.</p>
        <div className="row">
          <input
            style={{ flex: 1, minWidth: 260 }}
            placeholder="https://opensea.io/collection/… · kalos.fun/drops/… · 0x… · slug"
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
            {t.name ?? "Contract"} {t.symbol && <span className="muted">({t.symbol})</span>}{" "}
            <span className="pill">{t.dropSource === "kalos" ? "Kalos" : t.kind}</span> <span className="pill">{t.standard}</span>
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
              {STRAT[t.recommendedStrategy as Strategy] ?? "Not mintable with SkyBOT"}
            </div>
          </div>
          {t.stages?.length > 0 && (
            <table style={{ marginTop: 12 }}>
              <thead>
                <tr>
                  <th>Stage</th>
                  <th className="hide-sm">Type</th>
                  <th>Price</th>
                  <th className="hide-sm">Max / wallet</th>
                  <th>Schedule</th>
                </tr>
              </thead>
              <tbody>
                {t.stages.map((s: any, i: number) => (
                  <tr key={i}>
                    <td>{s.name}</td>
                    <td className="hide-sm">{STAGE_TYPE[s.type] ?? s.type}</td>
                    <td>{priceLabel(s)}</td>
                    <td className="hide-sm">{s.maxPerWallet ?? "—"}</td>
                    <td className={s.status === "active" ? "ok" : s.status === "upcoming" ? "warn" : "muted"}>
                      {s.status === "active" ? (
                        <>Live now{s.end ? <div className="muted small">ends {fmt(s.end)}</div> : null}</>
                      ) : s.status === "upcoming" ? (
                        s.start ? (
                          `Starts ${fmt(s.start)}`
                        ) : (
                          "Upcoming"
                        )
                      ) : s.status === "ended" ? (
                        s.end ? (
                          `Ended ${fmt(s.end, false)}`
                        ) : (
                          "Ended"
                        )
                      ) : (
                        "Unknown"
                      )}
                    </td>
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
                setSelStage(null);
                setQtyStage(null);
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
          {elig.noteItems?.some((n: any) => n.kind === "no_stage") && (
            <div className="notice">No mint stage is live or scheduled right now.</div>
          )}
          {elig.notes?.map((n: string) => (
            <div key={n} className="notice">
              {n}
            </div>
          ))}
          {rows.some((r: any) => r.needsOpenSeaLogin) && tgOnly && !authenticated && (
            <div className="notice row" style={{ justifyContent: "space-between" }}>
              <span>Connect with Privy to verify upcoming OpenSea stages for your wallets automatically.</span>
              <button onClick={connectPrivy}>Connect with Privy</button>
            </div>
          )}
          {verifyNote && <div className="notice">{verifyNote}</div>}
          {(stageGroups.length > 0 || extraStages.length > 0 || nowOnly) && (
            <div className="stage-groups" role="radiogroup" aria-label="Mint stage">
              {stageGroups.map((g) => {
                const sum = summarizeGroup(g);
                const offered = options.some((o) => o.kind === "stage" && o.stage?.name === g.stage.name);
                const active = chosen?.stage?.name === g.stage.name;
                const count =
                  sum.unknown.length === g.total
                    ? `${g.total} unknown`
                    : `${g.eligible}/${g.total} eligible${sum.unknown.length ? `, ${sum.unknown.length} unknown` : ""}`;
                return (
                  <StagePick
                    key={g.stage.name}
                    name={g.stage.name}
                    active={active}
                    offered={offered}
                    onPick={() => pickStage(g.stage.name)}
                    count={count}
                    countClass={g.eligible ? "ok small" : sum.unknown.length ? "muted small" : "bad small"}
                    meta={stageMeta(g.stage, sym, stageWhen)}
                  />
                );
              })}
              {extraStages.map((o) => (
                <StagePick
                  key={o.key}
                  name={o.name}
                  active={chosen?.key === o.key || chosen?.stage?.name === o.stage?.name}
                  offered
                  onPick={() => pickStage(o.key)}
                  count={`${eligibleIn(o.stage)}/${rows.length} eligible`}
                  countClass="ok small"
                  meta={stageMeta(o.stage, sym, stageWhen)}
                />
              ))}
              {nowOnly && (
                <StagePick
                  name="Now"
                  active={chosen?.key === "now"}
                  offered
                  onPick={() => pickStage("now")}
                  count="Mint immediately"
                  countClass="ok small"
                  meta=""
                />
              )}
            </div>
          )}
          <div className="row" style={{ marginBottom: 8 }}>
            <button
              className="ghost"
              onClick={() => {
                setSel({});
                setSelStage(stageKey ?? "");
              }}
            >
              Clear
            </button>
            <span className="spacer" />
            <span className="muted">
              {selRows.length} selected · {totalNfts} NFT(s) ·{" "}
              {paySym
                ? `~${fmtEth(selRows.reduce((a: bigint, r: any) => a + BigInt(viewFor(r).unitPriceWei ?? r.unitPriceWei ?? "0") * BigInt(qtyFor(r)), 0n).toString())} ${paySym} + ~${fmtEth(selRows.reduce((a: bigint, r: any) => a + BigInt(r.gasCostWei ?? "0"), 0n).toString())} ${sym} gas`
                : `~${fmtEth(totalWei.toString())} ${sym}`}
            </span>
          </div>
          {hiddenCount > 0 && <p className="muted small">{hiddenCount} not eligible hidden</p>}
          <table className="mint-wallets">
            <thead>
              <tr>
                <th className="col-check"></th>
                <th>Wallet</th>
                <th className="hide-sm">Simulation</th>
                <th className="col-qty">Qty</th>
                <th className="col-cost">Cost</th>
                <th className="hide-sm">Balance</th>
              </tr>
            </thead>
            <tbody>
              {shownRows.map((r: any) => {
                const view = viewFor(r);
                return (
                  <tr key={r.walletId}>
                    <td className="col-check">
                      <input
                        type="checkbox"
                        checked={isSel(r)}
                        onChange={(e) => {
                          const key = stageKey ?? "";
                          setSel((s) => {
                            const base = selStage === key ? s : Object.fromEntries(shownRows.map((rr: any) => [rr.walletId, true]));
                            return { ...base, [r.walletId]: e.target.checked };
                          });
                          setSelStage(key);
                        }}
                      />
                    </td>
                    <td>
                      <span className="wallet-line">
                        <span className="name">{r.label}</span>
                        <span className="mono muted addr" title={r.address}>
                          {tinyAddr(r.address)}
                        </span>
                      </span>
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
                    <td className="col-qty">
                      <div className="stepper" aria-label={`Quantity for ${r.label}`}>
                        <button
                          className="ghost"
                          disabled={qtyFor(r) <= 1}
                          onClick={() => setQtyFor(r, qtyFor(r) - 1)}
                          aria-label="Decrease"
                        >
                          −
                        </button>
                        <input
                          inputMode="numeric"
                          value={qtyFor(r)}
                          onChange={(e) => setQtyFor(r, Number(e.target.value.replace(/\D/g, "")) || 1)}
                          aria-label="Quantity"
                        />
                        <button
                          className="ghost"
                          disabled={qtyFor(r) >= maxFor(r)}
                          onClick={() => setQtyFor(r, qtyFor(r) + 1)}
                          aria-label="Increase"
                        >
                          +
                        </button>
                      </div>
                      <div className="muted small">{view.maxQty > 0 ? `max ${view.maxQty}` : "none left"}</div>
                      {view.reason && <div className={view.reason.startsWith("⚠️") ? "warn small" : "bad small"}>{view.reason}</div>}
                    </td>
                    <td className="mono col-cost">
                      {paySym
                        ? `~${fmtEth((BigInt(viewFor(r).unitPriceWei ?? r.unitPriceWei ?? "0") * BigInt(qtyFor(r))).toString())} ${paySym} + ${fmtEth(r.gasCostWei ?? "0")} ${sym}`
                        : `~${fmtEth(rowCostWei(r).toString())} ${sym}`}
                    </td>
                    <td className="hide-sm">
                      <span className={BigInt(r.balanceWei ?? "0") >= rowCostWei(r) ? "ok" : "warn"}>
                        {fmtEth(r.balanceWei, 5)} {sym}
                      </span>
                    </td>
                  </tr>
                );
              })}
              {!shownRows.length && (
                <tr>
                  <td colSpan={6} className="muted">
                    {rows.length ? (
                      "No wallets are eligible for this stage."
                    ) : (
                      <>
                        No wallets. Add some on <Link href="/app/wallets">Wallets</Link>.
                      </>
                    )}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          <h2 style={{ marginTop: 16 }}>3 · Timing</h2>
          <div className="row">
            <label>
              Gas{" "}
              <select value={gasMode} onChange={(e) => setGasMode(e.target.value)} style={{ width: "auto" }}>
                <option value="eco">Eco</option>
                <option value="normal">Normal</option>
                <option value="aggressive">Aggressive</option>
              </select>
            </label>
            {chosen && !chosen.live && (
              <label title="Send this many milliseconds before (negative) or after (positive) the stage start">
                Offset (ms){" "}
                <input type="number" value={offsetMs} onChange={(e) => setOffsetMs(Number(e.target.value))} style={{ width: 72 }} />
              </label>
            )}
            <button disabled={!minting.length || !chosen || !!busy} onClick={() => simulate()}>
              Simulate
            </button>
          </div>
          {timingNote && <div className="notice">{timingNote}</div>}
          <p className="muted small" style={{ marginTop: 8 }}>
            {!chosen
              ? "Pick a stage above."
              : chosen.live || !chosen.runAt
                ? `Runs now${chosen.stage ? ` · ${chosen.name}` : ""}${minting.length ? ` · ${minting.length} wallet(s)` : ""}.`
                : `Scheduled ${fmt(chosen.runAt)}${offsetMs ? ` (${offsetMs > 0 ? "+" : ""}${offsetMs} ms)` : ""} · ${chosen.name}${minting.length ? ` · ${minting.length} wallet(s)` : ""}.`}
            {tz ? ` ${zoneLabel(tz)}.` : ""}
          </p>
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
              {sim.summary.dailySpent} / {sim.summary.dailyCap} {sym}
            </div>
          </div>
          {sim.summary.stage && (
            <p className="muted">
              Stage: {sim.summary.stage.name}
              {sim.summary.runAt ? ` · scheduled for ${fmt(sim.summary.runAt)}` : " · runs immediately"}
              {sim.summary.runAt && sim.summary.offsetMs ? ` (${sim.summary.offsetMs > 0 ? "+" : ""}${sim.summary.offsetMs} ms)` : ""}
              {sim.summary.skipped ? ` · ${sim.summary.skipped} wallet(s) skipped (not eligible)` : ""}
            </p>
          )}
          {!sim.summary.stage && sim.summary.runAt && <p className="muted">Scheduled for {fmt(sim.summary.runAt)}</p>}
          <table style={{ marginTop: 8 }}>
            <thead>
              <tr>
                <th>Wallet</th>
                <th>Qty</th>
                <th>Result</th>
                <th className="hide-sm">Max Cost</th>
              </tr>
            </thead>
            <tbody>
              {sim.rows.map((r: any) => (
                <tr key={r.walletId}>
                  <td>
                    {r.label} <span className="mono muted">{short(r.address)}</span>
                  </td>
                  <td className="mono">{r.quantity}</td>
                  <td>
                    {r.mintable ? (
                      <span className="ok">{r.reason ? "Will mint · " : "Ready to mint"}</span>
                    ) : (
                      <span className="bad">Won&apos;t mint · </span>
                    )}
                    {r.reason && <span className={r.mintable ? "muted" : ""}>{r.reason}</span>}
                    {r.overridable && (
                      <label className="small" style={{ display: "block", marginTop: 4 }}>
                        <input
                          type="checkbox"
                          checked={Boolean(force[r.walletId])}
                          onChange={(e) => setForce((f) => ({ ...f, [r.walletId]: e.target.checked }))}
                        />{" "}
                        Public stage: include anyway (the transaction may fail and still cost gas)
                      </label>
                    )}
                    {r.error && r.reason && !r.mintable && (
                      <details className="small muted">
                        <summary>Technical details</summary>
                        <span className="mono">{r.error}</span>
                      </details>
                    )}
                  </td>
                  <td className="mono hide-sm">
                    {fmtEth(r.totalMaxWei)} {sym}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {sim.rows.some((r: any) => r.overridable) && (
            <div className="row" style={{ marginTop: 8 }}>
              <button className="ghost" disabled={!!busy} onClick={() => simulate(forceIds)}>
                Re-simulate{forceIds.length ? ` including ${forceIds.length} override(s)` : ""}
              </button>
            </div>
          )}
          {sim.blockers?.map((b: string) => (
            <div key={b} className="err">
              {b}
            </div>
          ))}
          {sim.planId && !job && (
            <ConfirmBox
              key={sim.planId}
              statement={`I confirm this will broadcast real transactions (${sim.summary.totalNfts} mint${sim.summary.totalNfts === 1 ? "" : "s"}, est. cost up to ${sim.summary.totalMax} ${sym}${sim.summary.runAt ? `, at ${fmt(sim.summary.runAt, false)}` : ""}).`}
              label={sim.summary.runAt ? "Schedule Mint" : "Mint Now"}
              onConfirm={async () => {
                try {
                  const r = await api("/api/mint/execute", { body: { planId: sim.planId, confirmed: true, nfts: sim.summary.totalNfts } });
                  setJob(r.job);
                } catch (e: any) {
                  setErr(e.message);
                  throw e;
                }
              }}
            />
          )}
          {job && (
            <div className="notice">
              {job.status === "scheduled" ? "Mint scheduled" : "Mint started"}
              {job.runAt ? ` for ${fmt(job.runAt)}` : ""}. Track it on <Link href="/app/jobs">Jobs</Link>.
            </div>
          )}
        </div>
      )}
    </>
  );
}

const STAGE_TYPE: Record<string, string> = {
  public: "Public",
  signed: "Allowlist (signed)",
  allowlist: "Allowlist",
  token_gated: "Token-gated",
  unknown: "Unknown",
};

const tinyAddr = (a?: string | null) => (a ? `${a.slice(0, 4)}…${a.slice(-2)}` : "");

function stageMeta(s: any, sym: string, when: (s: any) => string) {
  return [
    s?.priceWei != null ? (s.priceWei === "0" ? "Free" : `${fmtEth(s.priceWei)} ${s.paymentSymbol || sym}`) : null,
    s?.maxPerWallet ? `max ${s.maxPerWallet}/wallet` : null,
    when(s),
  ]
    .filter(Boolean)
    .join(" · ");
}

/** One stage in the eligibility picker. The Timing section does not repeat this choice. */
function StagePick({
  name,
  active,
  offered,
  onPick,
  count,
  countClass,
  meta,
}: {
  name: string;
  active: boolean;
  offered: boolean;
  onPick: () => void;
  count: string;
  countClass: string;
  meta: string;
}) {
  return (
    <div className={`stage-group${active ? " on" : ""}`}>
      <div
        className={`stage-group-head${offered ? " pick" : ""}`}
        onClick={offered ? onPick : undefined}
        onKeyDown={
          offered
            ? (e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onPick();
                }
              }
            : undefined
        }
        role={offered ? "radio" : undefined}
        aria-checked={offered ? active : undefined}
        tabIndex={offered ? 0 : undefined}
        title={offered ? `Mint in ${name}` : undefined}
      >
        {offered && <span className={`stage-radio${active ? " on" : ""}`} aria-hidden="true" />}
        <b>{name}</b>
        <span className="spacer" />
        <span className={countClass}>{count}</span>
        {meta ? <span className="stage-meta muted small">{meta}</span> : null}
      </div>
    </div>
  );
}
