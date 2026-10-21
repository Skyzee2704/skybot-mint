// SPDX-License-Identifier: AGPL-3.0-only
import { Contract, formatEther } from "ethers";
import { requireChain } from "../../config/chains.js";
import { getPool } from "../rpc/pool.js";
import { OpenSeaClient } from "../resolver/opensea.js";
import { ResolvedTarget } from "../resolver/resolver.js";
import { SEADROP_ABI, SEADROP_ADDRESS, seadropMintedBy } from "../resolver/seadrop.js";
import { AccessResult, MerkleInfo, SimResult, classifyRevert, getMerkleInfo, merkleAccess, simulateIgnoringBalance } from "./access.js";
import { genericMintedBy } from "../resolver/generic.js";
import { listWallets } from "../../users/service.js";
import { getFees } from "./fees.js";
import { cachedBalance } from "../../util/balanceCache.js";
import { MintBuildError, buildMintTx } from "./build.js";
import { MintRequest, Strategy } from "./types.js";
import { cachedJwt, eligibilityWithJwt, jwtFromSignature, validateSiweFields } from "../resolver/openseaAuth.js";
import type { OsStage } from "../resolver/opensea.js";

export interface StageVerdict {
  uuid: string | null;
  label: string | null;
  type: string | null;
  start: string | null;
  eligible: boolean | null;
  maxPerWallet: number | null;
  priceWei: string | null;
}

export interface SiweProof {
  walletId: string;
  fields: Record<string, string>;
  signature: string;
}

export interface EligibilityRow {
  walletId: string;
  label: string;
  address: string;
  group: string | null;
  balanceWei: string;
  balance: string;
  mintedSoFar: number | null;
  maxPerWallet: number | null;
  remainingForWallet: number | null;
  suggestedQty: number;
  estCostWei: string;
  estCost: string;
  /** Allowlist / access verdict — independent of balance. */
  access: AccessResult;
  /** Contract-level simulation with a fake balance (stateOverride). null = not run. */
  simulation: SimResult | null;
  /** Balance verdict (price x qty + gas). */
  balanceOk: boolean;
  /** Can mint once funded (access not "no", simulation not failed, no limit/supply/stage blockers). */
  eligibleIgnoringBalance: boolean;
  eligible: boolean;
  /** Non-balance blockers (limits, supply, stage, access). */
  reasons: string[];
  /** Kept for older clients: legacy allowlist label. */
  allowlist: "eligible" | "not_eligible" | "not_active" | "unknown" | "n/a";
  /** Per-stage verdicts from OpenSea's eligibility API (upcoming stages included). */
  stages: StageVerdict[] | null;
  /** OpenSea can answer for this wallet once it signs OpenSea's off-chain sign-in message. */
  needsOpenSeaLogin: boolean;
}

const DEFAULT_GAS: Record<Strategy, bigint> = { seadrop_public: 180_000n, opensea_api: 220_000n, generic: 200_000n };

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]);
      }
    }),
  );
  return out;
}

export { osStage, stagePriceWei } from "./stage.js";
import { stagePriceWei, osStage } from "./stage.js";

/** Pure decision logic (unit-tested). */
export function decide(input: {
  balance: bigint;
  priceWei: bigint;
  gasCostWei: bigint;
  desiredQty: number;
  maxPerWallet: number | null;
  minted: number | null;
  supplyRemaining: bigint | null;
  stageEnded: boolean;
}) {
  const reasons: string[] = [];
  let remaining: number | null = null;
  if (input.maxPerWallet !== null && input.maxPerWallet > 0 && input.minted !== null)
    remaining = Math.max(0, input.maxPerWallet - input.minted);
  let qty = input.desiredQty;
  if (remaining !== null) qty = Math.min(qty, remaining);
  if (input.supplyRemaining !== null) qty = Math.min(qty, Number(input.supplyRemaining > 1000n ? 1000n : input.supplyRemaining));
  if (input.stageEnded) reasons.push("stage ended");
  if (remaining === 0) reasons.push("per-wallet limit reached");
  if (input.supplyRemaining === 0n) reasons.push("sold out");
  const q = Math.max(qty, 1);
  const cost = input.priceWei * BigInt(q) + input.gasCostWei;
  if (input.balance < cost) reasons.push(`insufficient balance (need ~${formatEther(cost)})`);
  return { suggestedQty: Math.max(0, qty), remaining, cost, reasons };
}

export interface EligibilityOptions {
  generic?: MintRequest["generic"];
  openseaWalletLogin?: boolean;
  /** Browser-signed OpenSea sign-in messages (Privy embedded wallets), one per wallet. */
  siwe?: SiweProof[];
}

const isPublicStage = (s: OsStage | null | undefined) => /public/i.test(s?.stage_type ?? "");

export async function checkEligibility(
  t: ResolvedTarget,
  strategy: Strategy,
  userId: string,
  walletIds: string[] | null,
  desiredQty: number | null = null,
  os = new OpenSeaClient(),
  opts: EligibilityOptions = {},
): Promise<{
  rows: EligibilityRow[];
  targetStage: { label: string | null; type: string | null; start: string | null; active: boolean } | null;
  priceWei: string | null;
  maxFeePerGas: string;
  notes: string[];
  allowlistInfo: Record<string, unknown>;
}> {
  const chain = requireChain(t.chain.key);
  const pool = getPool(chain);
  const list = (await listWallets(userId)).filter((w) => !walletIds || walletIds.includes(w.id));
  const fees = await getFees(pool);
  const genericPrice = strategy === "generic" && opts.generic?.priceWei ? BigInt(opts.generic.priceWei) : null;
  const priceKnown = genericPrice ?? stagePriceWei(t, strategy);
  const price = priceKnown ?? 0n;
  const gasCost = DEFAULT_GAS[strategy] * fees.maxFeePerGas;
  const notes: string[] = [];
  if (priceKnown === null) notes.push("Stage price unknown — cost excludes mint price.");
  const pubStage = t.stages.find((s) => s.type === "public" && s.source === "onchain");
  const stageEnded = strategy === "seadrop_public" ? pubStage?.status === "ended" : false;
  const maxPerWallet =
    strategy === "seadrop_public"
      ? (t.seadrop?.publicDrop?.maxPerWallet ?? null)
      : strategy === "generic"
        ? t.generic?.values.maxPerWallet
          ? Number(t.generic.values.maxPerWallet)
          : null
        : osStage(t).maxPerWallet;
  const supplyRemaining = t.supply.remaining !== null ? BigInt(t.supply.remaining) : null;
  // Default quantity = the most each wallet may mint in this stage (or 1 when there is no limit).
  const wantQty = desiredQty ?? (maxPerWallet && maxPerWallet > 0 ? maxPerWallet : 1);
  const useOs = strategy === "opensea_api" && os.available && Boolean(t.slug);
  if (strategy === "opensea_api" && !useOs) notes.push("OpenSea API key or slug missing — allowlist status unknown.");
  const drop = t.opensea?.drop;
  const activeOs = drop?.active_stage ?? null;
  const activeIsPublic = activeOs ? isPublicStage(activeOs) : false;
  const nextOs = drop?.next_stage ?? null;
  const targetOs = activeOs ?? nextOs;
  const proofs = new Map((opts.siwe ?? []).map((p) => [p.walletId, p]));

  // SeaDrop merkle allowlist (rare on current OpenSea drops; they use server-signed stages).
  let merkle: MerkleInfo | null = null;
  if (t.kind === "seadrop" && t.seadrop?.hasAllowList) {
    const root = await pool
      .read((p) => new Contract(SEADROP_ADDRESS, SEADROP_ABI, p).getAllowListMerkleRoot(t.contract) as Promise<string>, "merkleRoot")
      .catch(() => null);
    if (root) merkle = await getMerkleInfo(chain, t.contract, root).catch(() => null);
  }
  const allowlistInfo: Record<string, unknown> = {
    activeStage: activeOs
      ? { label: activeOs.label, type: activeOs.stage_type, allowlistWalletCount: (activeOs as any).allowlist_wallet_count ?? null }
      : null,
    nextStage: nextOs ? { label: nextOs.label, type: nextOs.stage_type, start: nextOs.start_time } : null,
    signedStages: Boolean(t.seadrop?.hasSignedMints),
    merkle: merkle
      ? { state: merkle.state, uri: merkle.uri, detail: merkle.detail }
      : t.seadrop?.hasAllowList
        ? { state: "unknown" }
        : null,
    openseaWalletLogin: Boolean(opts.openseaWalletLogin),
  };
  if (useOs && !activeOs && nextOs)
    notes.push(
      `"${nextOs.label ?? nextOs.stage_type}" has not started yet${nextOs.start_time ? ` (starts ${nextOs.start_time})` : ""}. OpenSea only reveals upcoming-stage allowlists to the wallet itself, so each wallet signs OpenSea's sign-in message (off-chain, no gas, no balance needed).`,
    );
  if (useOs && !activeOs && !nextOs) notes.push("This drop has no active or upcoming stage on OpenSea.");

  const rows = await mapLimit(list, useOs ? 3 : 6, async (w): Promise<EligibilityRow> => {
    const [balance, minted] = await Promise.all([
      cachedBalance(chain.key, w.address, () => pool.read((p) => p.getBalance(w.address), "balance")),
      t.kind === "seadrop"
        ? seadropMintedBy(pool, t.contract, w.address).catch(() => null)
        : t.generic
          ? genericMintedBy(pool, t.contract, t.generic, w.address)
          : Promise.resolve(null),
    ]);
    const d = decide({
      balance,
      priceWei: price,
      gasCostWei: gasCost,
      desiredQty: wantQty,
      maxPerWallet,
      minted,
      supplyRemaining,
      stageEnded,
    });
    const reasons = d.reasons.filter((r) => !r.startsWith("insufficient balance"));
    const qty = Math.max(1, d.suggestedQty);
    let access: AccessResult = {
      status: strategy === "generic" ? "n/a" : strategy === "seadrop_public" ? "public" : "unknown",
      source:
        strategy === "generic" ? "generic contract (no allowlist support)" : strategy === "seadrop_public" ? "SeaDrop public stage" : "—",
    };
    let simulation: SimResult | null = null;
    let legacy: EligibilityRow["allowlist"] = strategy === "opensea_api" ? "unknown" : "n/a";

    let stages: StageVerdict[] | null = null;
    let needsOpenSeaLogin = false;
    if (strategy === "opensea_api") {
      // Active stage: the official mint API answers directly (allowlist is checked before balance).
      if (useOs && activeOs && d.suggestedQty > 0) {
        try {
          const tx = await buildMintTx(
            t,
            { chain: chain.key, contract: t.contract, strategy, slug: t.slug, wallets: [] },
            w.address,
            qty,
            os,
            userId,
          );
          access = {
            status: activeIsPublic ? "public" : "yes",
            source: "OpenSea mint API",
            detail: activeIsPublic ? "public stage" : `allowed in "${activeOs?.label ?? "active stage"}"`,
          };
          legacy = "eligible";
          simulation = await simulateIgnoringBalance(pool, { from: w.address, to: tx.to, data: tx.data, value: tx.value });
        } catch (e: any) {
          if (e instanceof MintBuildError && e.code === "INSUFFICIENT_FUNDS") {
            // Verified: OpenSea checks the stage allowlist BEFORE balance — non-listed wallets get "not on allowlist".
            access = activeIsPublic
              ? { status: "public", source: "OpenSea mint API", detail: "public stage" }
              : {
                  status: "yes",
                  source: "OpenSea mint API (passed allowlist, failed only on balance)",
                  detail: `allowed in "${activeOs?.label ?? "active stage"}"`,
                };
            legacy = activeIsPublic ? "unknown" : "eligible";
          } else if (e instanceof MintBuildError && e.code === "NOT_ELIGIBLE") {
            access = { status: "no", source: "OpenSea mint API", detail: e.message.replace(/^OpenSea: /, "") };
            legacy = "not_eligible";
          } else if (e instanceof MintBuildError && e.code === "NOT_ACTIVE") {
            access = { status: "unknown", source: "OpenSea mint API", detail: "stage not active (409)" };
            legacy = "not_active";
          } else access = { status: "unknown", source: "OpenSea mint API", detail: `check failed: ${String(e.message).slice(0, 120)}` };
        }
      }
      // Upcoming stage (or mint API inconclusive): OpenSea eligibility API with the wallet's own sign-in.
      if (useOs && t.slug && access.status === "unknown" && targetOs) {
        const proof = proofs.get(w.id);
        try {
          let jwt = cachedJwt(w.address);
          if (!jwt && proof) {
            validateSiweFields(proof.fields, w.address);
            jwt = await jwtFromSignature(proof.fields, proof.signature);
          }
          if (!jwt) needsOpenSeaLogin = true;
          else {
            const res = await eligibilityWithJwt(jwt, t.slug);
            const all = drop?.stages?.length
              ? drop.stages
              : [activeOs, nextOs].filter(Boolean as any as (x: OsStage | null) => x is OsStage);
            stages = all.map((s) => {
              const v = res.find((r) => r.stage_uuid === s.uuid);
              return {
                uuid: s.uuid ?? null,
                label: s.label ?? null,
                type: s.stage_type ?? null,
                start: s.start_time ?? null,
                eligible: v ? Boolean(v.is_eligible) : null,
                maxPerWallet: v?.max_total_mintable_by_wallet ? Number(v.max_total_mintable_by_wallet) : null,
                priceWei: v?.price ?? s.price ?? null,
              };
            });
            const target = stages.find((s) => s.uuid === targetOs.uuid);
            const label = targetOs.label ?? targetOs.stage_type ?? "stage";
            if (target?.eligible === true) {
              access = {
                status: isPublicStage(targetOs) ? "public" : "yes",
                source: "OpenSea eligibility API",
                detail: `eligible for "${label}"${activeOs ? "" : " (upcoming)"}`,
              };
              legacy = "eligible";
              if (target.maxPerWallet && target.maxPerWallet > 0) d.suggestedQty = Math.min(d.suggestedQty, target.maxPerWallet);
            } else if (target?.eligible === false) {
              const later = stages.find((s) => s.eligible && s.uuid !== targetOs.uuid);
              access = {
                status: "no",
                source: "OpenSea eligibility API",
                detail: `not eligible for "${label}"${later ? `; eligible for "${later.label ?? later.type}"` : ""}`,
              };
              legacy = "not_eligible";
            } else access = { status: "unknown", source: "OpenSea eligibility API", detail: `no verdict for "${label}"` };
          }
        } catch (e: any) {
          needsOpenSeaLogin = !cachedJwt(w.address);
          access = { status: "unknown", source: "OpenSea eligibility API", detail: `check failed: ${String(e.message).slice(0, 120)}` };
        }
        if (needsOpenSeaLogin && access.status === "unknown")
          access = { status: "unknown", source: "OpenSea", detail: "verify with OpenSea sign-in to check this stage" };
      }
    } else if (d.suggestedQty > 0 || strategy === "seadrop_public") {
      try {
        const tx = await buildMintTx(
          t,
          { chain: chain.key, contract: t.contract, strategy, slug: t.slug, wallets: [], generic: opts.generic },
          w.address,
          qty,
          os,
          userId,
        );
        simulation = await simulateIgnoringBalance(pool, { from: w.address, to: tx.to, data: tx.data, value: tx.value });
      } catch (e: any) {
        simulation = { ok: null, reason: String(e.message).slice(0, 160), source: "build" };
      }
    }
    // Merkle allowlist (on-chain data) fills in when nothing better is known.
    const m = merkleAccess(merkle, w.address);
    if (m && (access.status === "unknown" || (access.status === "public" && strategy !== "seadrop_public"))) access = m;
    if (simulation?.ok === false && access.status === "unknown")
      access = { ...access, status: classifyRevert(simulation.reason), detail: simulation.reason ?? access.detail };

    if (access.status === "no") reasons.push(`not allowlisted (${access.source})`);
    if (simulation?.ok === false && !/NotActive/.test(simulation.reason ?? "")) reasons.push(`simulation reverts: ${simulation.reason}`);
    // For a non-public OpenSea stage, "unknown" access is not good enough to auto-select.
    const accessOk = !(strategy === "opensea_api" && access.status === "unknown" && !(targetOs && isPublicStage(targetOs)));
    const eligibleIgnoringBalance = reasons.length === 0 && d.suggestedQty > 0 && accessOk;
    // Balance is a mint-readiness check only (never an eligibility blocker); cost for the final suggested qty.
    const cost = price * BigInt(Math.max(1, d.suggestedQty)) + gasCost;
    const balanceOk = balance >= cost;
    const balanceNote = `insufficient balance (need ~${formatEther(cost)})`;
    return {
      walletId: w.id,
      label: w.label,
      address: w.address,
      group: w.group,
      balanceWei: balance.toString(),
      balance: formatEther(balance),
      mintedSoFar: minted,
      maxPerWallet,
      remainingForWallet: d.remaining,
      suggestedQty: d.suggestedQty,
      estCostWei: cost.toString(),
      estCost: formatEther(cost),
      access,
      simulation,
      balanceOk,
      eligibleIgnoringBalance,
      eligible: eligibleIgnoringBalance && balanceOk,
      reasons: balanceOk ? reasons : [...reasons, balanceNote],
      allowlist: legacy,
      stages,
      needsOpenSeaLogin,
    };
  });
  const targetStage = targetOs
    ? { label: targetOs.label ?? null, type: targetOs.stage_type ?? null, start: targetOs.start_time ?? null, active: Boolean(activeOs) }
    : null;
  return { rows, targetStage, priceWei: priceKnown?.toString() ?? null, maxFeePerGas: fees.maxFeePerGas.toString(), notes, allowlistInfo };
}
