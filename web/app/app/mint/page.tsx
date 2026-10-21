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
import { formatDateTime, localTimeZone, zoneLabel, zonedWallTimeToDate } from "@/lib/time";
import { useNow } from "@/lib/useNow";
import { clampQty } from "@nft-mint-bot/server/qty";
import { groupByStage, summarizeGroup, verdictText } from "@nft-mint-bot/server/stage-eligibility";

type Strategy = "seadrop_public" | "opensea_api" | "generic";
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
  const [when, setWhen] = useState<"now" | "stage" | "custom">("now");
  const [stageStart, setStageStart] = useState("");
  const [custom, setCustom] = useState("");
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
      setSel(Object.fromEntries(r.rows.filter((x: any) => x.eligibleIgnoringBalance).map((x: any) => [x.walletId, true])));
      setQtys(Object.fromEntries(r.rows.map((x: any) => [x.walletId, clampQty(x.suggestedQty || 1, Math.max(1, x.maxQty ?? 1))])));
      setForce({});
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(null);
    }
  };
  /** Stepper bound: stage per-wallet limit minus already minted (at least 1 so any wallet can be simulated). */
  const maxFor = (r: any) => Math.max(1, r.maxQty ?? 1);
  const qtyFor = (r: any) => clampQty(qtys[r.walletId] ?? 1, maxFor(r));
  const setQtyFor = (r: any, q: number) => setQtys((m) => ({ ...m, [r.walletId]: clampQty(q, maxFor(r)) }));
  const rowCostWei = (r: any) => BigInt(r.unitPriceWei ?? "0") * BigInt(qtyFor(r)) + BigInt(r.gasCostWei ?? "0");
  const customDate = when === "custom" && custom ? zonedWallTimeToDate(custom, tz ?? "UTC") : null;
  const runAt = when === "now" ? null : when === "stage" ? stageStart || null : customDate ? customDate.toISOString() : null;
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
              .filter((r: any) => sel[r.walletId] && qtyFor(r) > 0)
              .map((r: any) => ({ walletId: r.walletId, quantity: qtyFor(r) })),
            generic: genericPayload(),
            gasMode,
            runAt,
            offsetMs,
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
  const selRows = rows.filter((r: any) => sel[r.walletId]);
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
                    <td>{s.priceWei == null ? "Unknown" : s.priceWei === "0" ? "Free" : `${fmtEth(s.priceWei)} ${sym}`}</td>
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
          {stageGroups.length > 0 && (
            <div className="stage-groups">
              {stageGroups.map((g) => {
                const sum = summarizeGroup(g);
                return (
                  <div key={g.stage.name} className="stage-group">
                    <div className="stage-group-head">
                      <b>{g.stage.name}</b>
                      <span className="muted small">
                        {[
                          g.stage.priceWei != null ? (g.stage.priceWei === "0" ? "Free" : `${fmtEth(g.stage.priceWei)} ${sym}`) : null,
                          g.stage.maxPerWallet ? `max ${g.stage.maxPerWallet}/wallet` : null,
                          stageWhen(g.stage),
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                      <span className="spacer" />
                      <span className={g.eligible ? "ok small" : "muted small"}>
                        {g.eligible}/{g.total} eligible
                      </span>
                    </div>
                    {sum.eligible.length > 0 && (
                      <div className="wallet-chips">
                        {sum.eligible.map((w) => (
                          <span key={w.walletId} className="chip ok" title={w.address}>
                            ✓ {w.label} <span className="mono muted">{short(w.address)}</span>
                            {w.max ? <span className="muted"> · max {w.max}</span> : null}
                            {w.note ? <span className="warn"> · {w.note}</span> : null}
                          </span>
                        ))}
                      </div>
                    )}
                    {sum.eligible.length === 0 && sum.unknown.length === 0 && (
                      <div className="bad small">{g.total === 1 ? "Not eligible" : `None of your ${g.total} wallets are eligible`}</div>
                    )}
                    {(sum.notEligible.length > 0 && (sum.eligible.length > 0 || sum.unknown.length > 0)) || sum.unknown.length > 0 ? (
                      <details className="small">
                        <summary className="muted">
                          {[
                            sum.notEligible.length && (sum.eligible.length || sum.unknown.length)
                              ? `${sum.notEligible.length} not eligible`
                              : null,
                            sum.unknown.length ? `${sum.unknown.length} ${verdictText(sum.unknown[0]!)}` : null,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </summary>
                        <div className="wallet-chips">
                          {[...sum.notEligible, ...sum.unknown].map((w) => (
                            <span key={w.walletId} className={`chip ${STATE_CLASS[w.state]}`} title={w.address}>
                              {STATE_ICON[w.state]} {w.label} <span className="mono muted">{short(w.address)}</span>
                            </span>
                          ))}
                        </div>
                      </details>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
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
            <button
              className="ghost"
              onClick={() => setQtys((m) => ({ ...m, ...Object.fromEntries(rows.map((r: any) => [r.walletId, maxFor(r)])) }))}
            >
              Set All to Max
            </button>
            <span className="spacer" />
            <span className="muted">
              {selRows.length} selected · {totalNfts} NFT(s) · ~{fmtEth(totalWei.toString())} {sym}
            </span>
          </div>
          <table>
            <thead>
              <tr>
                <th></th>
                <th>Wallet</th>
                <th>Eligibility</th>
                <th className="hide-sm">Simulation</th>
                <th>Quantity</th>
                <th>Est. Cost</th>
                <th className="hide-sm">Balance</th>
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
                      <Access r={r} />
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
                    <td>
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
                      <div className="muted small">{r.maxQty > 0 ? `max ${r.maxQty}` : "none left"}</div>
                      {other.length > 0 && <div className="bad small">{other.join("; ")}</div>}
                    </td>
                    <td className="mono">
                      ~{fmtEth(rowCostWei(r).toString())} {sym}
                    </td>
                    <td className="hide-sm">
                      <span className={BigInt(r.balanceWei ?? "0") >= rowCostWei(r) ? "ok" : "warn"}>
                        {fmtEth(r.balanceWei, 5)} {sym}
                      </span>
                    </td>
                  </tr>
                );
              })}
              {!rows.length && (
                <tr>
                  <td colSpan={7} className="muted">
                    No wallets. Add some on <Link href="/app/wallets">Wallets</Link>.
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
            <label>
              <input type="radio" checked={when === "now"} onChange={() => setWhen("now")} /> Now
            </label>
            <label>
              <input type="radio" checked={when === "stage"} disabled={!stageStart} onChange={() => setWhen("stage")} /> At stage start
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
              <label title="Send this many milliseconds before (negative) or after (positive) the chosen time">
                Offset (ms){" "}
                <input type="number" value={offsetMs} onChange={(e) => setOffsetMs(Number(e.target.value))} style={{ width: 90 }} />
              </label>
            )}
            <button disabled={!selRows.length || !!busy || (when === "custom" && !customDate)} onClick={() => simulate()}>
              Simulate
            </button>
          </div>
          <p className="muted small" style={{ marginTop: 8 }}>
            {tz ? `Times use your timezone: ${zoneLabel(tz)}.` : ""}
            {when === "stage" && stageStart ? ` Runs at ${fmt(stageStart)}.` : ""}
            {when === "custom" && customDate ? ` Runs at ${fmt(customDate)}.` : ""}
            {when === "custom" && custom && !customDate ? " That local time doesn't exist in your timezone (clock change)." : ""}
            {when === "custom" && customDate && customDate.getTime() < now ? " This time is in the past, so it runs immediately." : ""}
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
              {sim.summary.dailySpent} / {sim.summary.dailyCap}
            </div>
          </div>
          {sim.summary.runAt && <p className="muted">Scheduled for {fmt(sim.summary.runAt)}</p>}
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

const STATE_ICON = { eligible: "✓", not_eligible: "✕", unverified: "?", unknown: "?" } as const;
const STATE_CLASS = { eligible: "ok", not_eligible: "bad", unverified: "muted", unknown: "muted" } as const;

/** Verdict for the stage being minted (per-stage details are listed above the table). */
function Access({ r }: { r: any }) {
  const a = r?.access;
  if (!a) return <span className="muted">—</span>;
  if (r.needsOpenSeaLogin) return <span className="muted">Not verified yet</span>;
  const label =
    a.status === "yes"
      ? "Eligible"
      : a.status === "public"
        ? "Eligible (public)"
        : a.status === "no"
          ? "Not eligible"
          : a.status === "n/a"
            ? "No allowlist"
            : "Unknown";
  const cls = a.status === "yes" || a.status === "public" ? "ok" : a.status === "no" ? "bad" : "muted";
  return <b className={cls}>{label}</b>;
}
