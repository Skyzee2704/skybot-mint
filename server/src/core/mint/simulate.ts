// SPDX-License-Identifier: AGPL-3.0-only
import { formatEther } from "ethers";
import { requireChain } from "../../config/chains.js";
import { getPool } from "../rpc/pool.js";
import { ResolvedTarget } from "../resolver/resolver.js";
import { getWallet } from "../../users/service.js";
import { assertDailyBudget, capsFor, dailySpent, fmtCap } from "../safety/safety.js";
import { buildMintTx } from "./build.js";
import { getFeesCached } from "./fees.js";
import { nativeBalancesBatch } from "../rpc/multicall.js";
import { MintRequest } from "./types.js";
import { createPlan } from "../plans.js";
import { simulateIgnoringBalance } from "./access.js";
import { getAddress, toQuantity } from "ethers";
import { decodeRevertData, revertDataOf } from "../tx/revert.js";
import { applyStageChoice, type StageChoice } from "./stagePlan.js";
import { isPublicStage } from "./stageEligibility.js";
import { savedStageRows } from "./eligibility.js";

export interface SimRow {
  walletId: string;
  label: string;
  address: string;
  quantity: number;
  ok: boolean;
  expectedRevertBeforeStart: boolean;
  gasEstimate: string | null;
  gasLimit: string;
  valueWei: string;
  maxGasCostWei: string;
  totalMaxWei: string;
  to: string | null;
  selector: string | null;
  /** Raw technical error (for the details view). */
  error: string | null;
  /** Plain-English reason shown to the user when the wallet can't mint. */
  reason: string | null;
  /** Contract accepts the call when the wallet is funded (state-override sim). */
  passesIgnoringBalance: boolean | null;
  balanceWei: string;
  funded: boolean;
  /** Will be included in the mint plan. */
  mintable: boolean;
  /** Excluded only because of a failed simulation on a public stage — user may include it explicitly. */
  overridable: boolean;
  /** Left out because the wallet isn't eligible for the chosen stage. */
  skipped?: boolean;
}

/** Turn API / revert errors into a short plain-English reason. */
export function explainMintError(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const m = String(raw);
  if (/not eligible|not on (the )?allow ?list|NOT_ELIGIBLE|allowlist/i.test(m)) return "Not on the allowlist for this stage.";
  if (/InvalidProof|InvalidSignature|PayerNotAllowed|TokenGatedNotTokenOwner/.test(m))
    return "Not on the allowlist (proof or signature rejected).";
  if (/NotActive|not active|no active stage|\b409\b/i.test(m)) return "Stage hasn't started yet.";
  if (/MaxMintedPerWallet|per[- ]wallet|exceeds max.*wallet/i.test(m)) return "Over the per-wallet mint limit.";
  if (/MaxSupply|sold out|exceeds.*supply/i.test(m)) return "Sold out (or not enough supply left for this quantity).";
  if (/IncorrectPayment|wrong (payment|value)|msg\.value/i.test(m)) return "Wrong payment amount for this stage.";
  if (/insufficient funds|INSUFFICIENT_FUNDS|exceeds balance/i.test(m)) return "Not enough balance for price + gas.";
  if (/paused/i.test(m)) return "Minting is paused on the contract.";
  return `Simulation reverted: ${m.slice(0, 160)}`;
}

/** eth_estimateGas with a fake balance (works for unfunded wallets on RPCs that support state overrides). */
async function estimateIgnoringBalance(pool: ReturnType<typeof getPool>, tx: { from: string; to: string; data: string; value: bigint }) {
  const from = getAddress(tx.from);
  return pool.read(
    async (p) =>
      BigInt(
        await p.send("eth_estimateGas", [
          { from, to: getAddress(tx.to), data: tx.data, value: toQuantity(tx.value) },
          "latest",
          { [from]: { balance: "0x" + (10n ** 30n).toString(16) } },
        ]),
      ),
    "estimateGas+stateOverride",
  );
}

export function fallbackGas(strategy: MintRequest["strategy"], qty: number): bigint {
  const base = strategy === "generic" ? 200_000n : 160_000n;
  return base + 40_000n * BigInt(Math.max(0, qty - 1));
}

export function revertReason(e: any): string {
  const data = revertDataOf(e);
  if (data) {
    const d = decodeRevertData(data);
    if (d.via !== "none") return d.message.slice(0, 240);
  }
  return String(e?.reason ?? e?.revert?.name ?? e?.info?.error?.message ?? e?.shortMessage ?? e?.message ?? e).slice(0, 240);
}

export async function simulateMint(t: ResolvedTarget, reqIn: MintRequest, userId: string) {
  let req = reqIn;
  let choice: StageChoice | null = null;
  if (req.stage) {
    // The chosen stage decides run time and wallets (from saved OpenSea verdicts), never the client's clock.
    const ws = await Promise.all(req.wallets.map((wq) => getWallet(userId, wq.walletId)));
    choice = applyStageChoice(t.stages, await savedStageRows(userId, t, ws), req);
    req = choice.req;
  }
  const stagePriceWei = choice?.option.stage?.priceWei ? BigInt(choice.option.stage.priceWei) : null;
  const chain = requireChain(t.chain.key);
  const pool = getPool(chain);
  await pool.checkChainId();
  const fees = await getFeesCached(pool, req.gasMode);
  const runAtMs = req.runAt ? new Date(req.runAt).getTime() : Date.now();
  const beforeStart = runAtMs > Date.now() + 2000;

  const publicStage = choice?.option.stage
    ? isPublicStage(choice.option.stage)
    : req.strategy === "seadrop_public" ||
      (req.strategy === "opensea_api" && /public/i.test((t.opensea?.drop?.active_stage ?? t.opensea?.drop?.next_stage)?.stage_type ?? ""));
  const force = new Set(req.forceWalletIds ?? []);

  const owned = await Promise.all(req.wallets.map((wq) => getWallet(userId, wq.walletId)));
  // Fresh balances for every wallet in one multicall (falls back to per-wallet reads).
  const balances = await nativeBalancesBatch(
    pool,
    owned.map((w) => w.address),
  ).catch(() => new Map<string, bigint>());
  const rows: SimRow[] = await Promise.all(
    req.wallets.map(async (wq, i): Promise<SimRow> => {
      const w = owned[i];
      const balance = balances.get(w.address.toLowerCase()) ?? (await pool.read((p) => p.getBalance(w.address), "balance").catch(() => 0n));
      const base = { walletId: w.id, label: w.label, address: w.address, quantity: wq.quantity, balanceWei: balance.toString() };
      let tx;
      try {
        tx = await buildMintTx(t, req, w.address, wq.quantity, undefined, userId);
      } catch (e: any) {
        const notActive = e.code === "NOT_ACTIVE";
        const unfundedOnly = e.code === "INSUFFICIENT_FUNDS"; // OpenSea checked the allowlist first and only balance failed
        const gl = BigInt(req.gasLimit ?? fallbackGas(req.strategy, wq.quantity));
        const expected = notActive && beforeStart;
        // Before the start OpenSea can't build the tx yet; cost uses the chosen stage's price.
        const estValue = expected && stagePriceWei !== null ? stagePriceWei * BigInt(wq.quantity) : 0n;
        const overridable = publicStage && !unfundedOnly && !notActive;
        return {
          ...base,
          ok: false,
          expectedRevertBeforeStart: expected,
          gasEstimate: null,
          gasLimit: gl.toString(),
          valueWei: estValue.toString(),
          maxGasCostWei: (gl * fees.maxFeePerGas).toString(),
          totalMaxWei: (gl * fees.maxFeePerGas + estValue).toString(),
          to: null,
          selector: null,
          error: e.message,
          reason: expected
            ? "Stage hasn't started yet. The transaction is built and checked again at start time."
            : explainMintError(e.message),
          passesIgnoringBalance: unfundedOnly ? true : null,
          funded: false,
          mintable: expected || (unfundedOnly && beforeStart) || (overridable && force.has(w.id)),
          overridable,
        };
      }
      const sim = await simulateIgnoringBalance(pool, { from: w.address, to: tx.to, data: tx.data, value: tx.value });
      let gasEstimate: bigint | null = null;
      try {
        gasEstimate = await pool.read((p) => p.estimateGas({ from: w.address, to: tx.to, data: tx.data, value: tx.value }), "estimateGas");
      } catch {
        if (sim.ok)
          gasEstimate = await estimateIgnoringBalance(pool, { from: w.address, to: tx.to, data: tx.data, value: tx.value }).catch(
            () => null,
          );
      }
      const gasLimit = BigInt(req.gasLimit ?? (gasEstimate ? (gasEstimate * 125n) / 100n : fallbackGas(req.strategy, wq.quantity)));
      const maxGas = gasLimit * fees.maxFeePerGas;
      const need = tx.value + maxGas;
      const funded = balance >= need;
      const failed = sim.ok === false;
      const expected = failed && beforeStart && /NotActive|not active|before start|stage/i.test(sim.reason ?? "");
      const passes = sim.ok;
      let reason: string | null = null;
      if (failed && !expected) reason = explainMintError(sim.reason);
      else if (expected) reason = "Stage hasn't started yet. Checked again at start time.";
      else if (!funded)
        reason = `Needs ~${formatEther(need)} ${chain.nativeSymbol} (has ${formatEther(balance)}).${beforeStart ? " Fund it before the start time." : ""}`;
      const overridable = publicStage && failed && !expected;
      const mintable = ((passes !== false || expected) && (funded || beforeStart)) || (overridable && force.has(w.id));
      return {
        ...base,
        ok: passes === true && funded,
        expectedRevertBeforeStart: expected,
        gasEstimate: gasEstimate?.toString() ?? null,
        gasLimit: gasLimit.toString(),
        valueWei: tx.value.toString(),
        maxGasCostWei: maxGas.toString(),
        totalMaxWei: need.toString(),
        to: tx.to,
        selector: tx.data.slice(0, 10),
        error: failed ? (sim.reason ?? null) : passes === null ? sim.reason : null,
        reason,
        passesIgnoringBalance: passes,
        funded,
        mintable,
        overridable,
      };
    }),
  );

  for (const c of choice?.capped ?? []) {
    const r = rows.find((x) => x.walletId === c.walletId);
    if (r) r.reason = [`Quantity set to ${c.quantity} (${choice!.option.name} limit per wallet).`, r.reason].filter(Boolean).join(" ");
  }
  if (choice?.skipped.length) {
    const skippedWallets = await Promise.all(choice.skipped.map((s) => getWallet(userId, s.walletId)));
    choice.skipped.forEach((s, i) => {
      const w = skippedWallets[i];
      const q = reqIn.wallets.find((x) => x.walletId === s.walletId)?.quantity ?? 0;
      rows.push({
        walletId: w.id,
        label: w.label,
        address: w.address,
        quantity: q,
        ok: false,
        expectedRevertBeforeStart: false,
        gasEstimate: null,
        gasLimit: "0",
        valueWei: "0",
        maxGasCostWei: "0",
        totalMaxWei: "0",
        to: null,
        selector: null,
        error: null,
        reason: s.reason,
        passesIgnoringBalance: null,
        balanceWei: "0",
        funded: false,
        mintable: false,
        overridable: false,
        skipped: true,
      });
    });
  }
  const totalValue = rows.filter((r) => r.mintable).reduce((a, r) => a + BigInt(r.valueWei), 0n);
  const totalGas = rows.filter((r) => r.mintable).reduce((a, r) => a + BigInt(r.maxGasCostWei), 0n);
  const totalNfts = rows.filter((r) => r.mintable).reduce((a, r) => a + r.quantity, 0);
  const blockers: string[] = [];
  try {
    await assertDailyBudget(userId, chain, totalValue + totalGas);
  } catch (e: any) {
    blockers.push(e.message);
  }
  if (rows.length && !rows.some((r) => r.mintable))
    blockers.push("No selected wallet can mint right now. See the reason next to each wallet.");

  const caps = await capsFor(userId, chain);
  const summary = {
    chain: chain.key,
    nativeSymbol: chain.nativeSymbol,
    wallets: rows.length,
    totalNfts,
    totalValue: formatEther(totalValue),
    totalMaxGas: formatEther(totalGas),
    totalMax: formatEther(totalValue + totalGas),
    maxFeePerGasGwei: Number(fees.maxFeePerGas) / 1e9,
    priorityFeeGwei: Number(fees.maxPriorityFeePerGas) / 1e9,
    feesCapped: fees.capped,
    dailySpent: formatEther(await dailySpent(userId, chain)),
    dailyCap: fmtCap(caps.maxDailySpendWei),
    maxPricePerNft: fmtCap(caps.maxPricePerNftWei),
    runAt: req.runAt ?? null,
    offsetMs: req.offsetMs ?? 0,
    scheduled: beforeStart,
    stage: choice ? { name: choice.option.name, live: choice.option.live, start: choice.option.stage?.start ?? null } : null,
    skipped: choice?.skipped.length ?? 0,
  };
  const okRows = rows.filter((r) => r.mintable);
  const plan =
    blockers.length || okRows.length === 0
      ? null
      : await createPlan(
          userId,
          "mint",
          {
            request: { ...req, wallets: okRows.map((r) => ({ walletId: r.walletId, quantity: r.quantity })) },
            gasHints: Object.fromEntries(rows.map((r) => [r.walletId, r.gasLimit])),
          },
          `MINT ${totalNfts}`,
        );
  return { rows, summary, blockers, planId: plan?.id ?? null, confirmPhrase: plan?.confirmPhrase ?? null };
}
