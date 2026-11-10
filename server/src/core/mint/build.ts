// SPDX-License-Identifier: AGPL-3.0-only
import { Contract, Interface, getAddress } from "ethers";
import { requireChain } from "../../config/chains.js";
import { OpenSeaClient, OpenSeaHttpError } from "../resolver/opensea.js";
import type { OpenSeaMintSample } from "./openseaLimit.js";
import { ResolvedTarget } from "../resolver/resolver.js";
import { SEADROP_ADDRESS, encodeMintPublic } from "../resolver/seadrop.js";
import { encodeKalosMintPublic, encodeMintAllowList } from "../kalos/calldata.js";
import { fetchKalosEligibility } from "../kalos/client.js";
import { stageClock, wantOf } from "../kalos/decide.js";
import { getPool } from "../rpc/pool.js";
import { simulateIgnoringBalance } from "./access.js";
import { readableAllowListTx } from "./access.js";
import { isDangerousFunctionName, assertSafeMintTx } from "../safety/safety.js";
import { osStage } from "./stage.js";
import { stageEndedAt } from "./stageEligibility.js";
import { BuiltTx, MintRequest } from "./types.js";

/** Map official mint-API errors. 422 is also returned for an unfunded minter, which says nothing about allowlist status. */
export function osErrorCode(status: number, message = ""): string {
  if (status === 409) return "NOT_ACTIVE";
  if (status === 429) return "RATE_LIMIT";
  if (status === 422) return /insufficient (balance|funds)/i.test(message) ? "INSUFFICIENT_FUNDS" : "NOT_ELIGIBLE";
  return `HTTP_${status}`;
}
export class MintBuildError extends Error {
  statusCode = 422;
  retryAfterMs?: number;
  rateLimit?: OpenSeaMintSample;
  constructor(
    m: string,
    public code = "BUILD",
  ) {
    super(m);
  }
}

/** Allowed `to` for each strategy — anything else is rejected by the safety guard. */
export function allowedTargets(t: ResolvedTarget, req: MintRequest): string[] {
  if (req.strategy === "kalos" && t.kalos) return [t.kalos.seaDrop, t.contract];
  return req.strategy === "generic" ? [t.contract] : [SEADROP_ADDRESS, t.contract];
}

/**
 * Build the mint tx for one wallet. Prices/ABI come from the server-side resolved target,
 * never from the client (except generic price override, which is capped by safety).
 */
export async function buildMintTx(
  t: ResolvedTarget,
  req: MintRequest,
  wallet: string,
  quantity: number,
  os = new OpenSeaClient(),
  userId = "system",
  call: { mintTimeoutMs?: number; mintJobId?: string; walletIndex?: number; onMintSample?: (sample: OpenSeaMintSample) => void } = {},
): Promise<BuiltTx> {
  const chain = requireChain(t.chain.key);
  const chosen = req.stage ? (t.stages.find((s) => s.name === req.stage) ?? null) : null;
  if (chosen && stageEndedAt(chosen, Date.now())) throw new MintBuildError(`The ${chosen.name} stage has ended`, "STAGE_ENDED");
  let tx: BuiltTx;
  let builtLocal = false;
  switch (req.strategy) {
    case "seadrop_public": {
      const sd = t.seadrop;
      if (!sd?.publicDrop) throw new MintBuildError("No on-chain public SeaDrop stage for this contract");
      if (!sd.feeRecipient) throw new MintBuildError("Drop restricts fee recipients and none are allowed");
      tx = {
        to: SEADROP_ADDRESS,
        data: encodeMintPublic(t.contract, sd.feeRecipient, quantity),
        value: BigInt(sd.publicDrop.mintPriceWei) * BigInt(quantity),
      };
      break;
    }
    case "opensea_api": {
      // A readable merkle list can be proven locally. Signed GTD/FCFS cannot: only OpenSea's signer has the key.
      if (chosen?.type === "allowlist" && t.seadrop?.feeRecipient) {
        try {
          const local = await readableAllowListTx(chain, t.contract, wallet, quantity, t.seadrop.feeRecipient);
          if (local) {
            tx = { to: SEADROP_ADDRESS, data: local.data, value: local.value };
            builtLocal = true;
            break;
          }
        } catch {
          /* fall through to the mint API */
        }
      }
      const slug = req.slug ?? t.slug;
      if (!slug) throw new MintBuildError("OpenSea slug unknown for this contract — cannot use OpenSea mint API");
      if (!os.available) throw new MintBuildError("OPENSEA_API_KEY not set — OpenSea mint API unavailable");
      try {
        const r = await os.buildMint(slug, wallet, quantity, call.mintTimeoutMs, {
          jobId: call.mintJobId,
          walletIndex: call.walletIndex,
          onSample: call.onMintSample,
        });
        const value = BigInt(r.value || "0x0");
        tx = { to: getAddress(r.to), data: r.data, value };
        if (r.chain && r.chain !== chain.openseaChain && r.chain !== chain.key && chain.openseaChain)
          throw new MintBuildError(`OpenSea returned chain "${r.chain}" but target is ${chain.key}`);
      } catch (e: any) {
        if (e instanceof OpenSeaHttpError) {
          const code = osErrorCode(e.status, e.message);
          const err = new MintBuildError(`OpenSea: ${e.message || e.status}`, code);
          if (e.retryAfterMs !== undefined) err.retryAfterMs = e.retryAfterMs;
          if (e.rateLimit) err.rateLimit = e.rateLimit;
          throw err;
        }
        if (call.mintTimeoutMs && /abort|timeout/i.test(`${e?.name ?? ""} ${e?.message ?? e}`))
          throw new MintBuildError("OpenSea mint timed out", "RETRY");
        throw e;
      }
      break;
    }
    case "kalos": {
      const k = t.kalos;
      if (!k) throw new MintBuildError("This target is not a Kalos drop");
      if (!chosen) throw new MintBuildError("Pick a Kalos stage");
      const pool = getPool(chain);
      const minted = await pool
        .read(async (p) => {
          const c = new Contract(t.contract, ["function getMintStats(address) view returns (uint256,uint256,uint256)"], p);
          const stats = await c.getMintStats(wallet);
          return Number(stats[0]);
        }, "getMintStats")
        .catch(() => 0);
      const cap = chosen.maxPerWallet ?? 0;
      const want = wantOf(cap, minted);
      if (want <= 0) throw new MintBuildError("cap reached", "NOT_ELIGIBLE");
      if (quantity > want) throw new MintBuildError(`Quantity ${quantity} is above the remaining allowance of ${want}`, "NOT_ELIGIBLE");
      const nowSec = Math.floor(Date.now() / 1000);
      const start = chosen.start ? Math.floor(new Date(chosen.start).getTime() / 1000) : 0;
      const end = chosen.end ? Math.floor(new Date(chosen.end).getTime() / 1000) : 0;
      const clock = start && end ? stageClock(start, end, nowSec) : "active";
      if (clock === "ended") throw new MintBuildError(`The ${chosen.name} stage has ended`, "STAGE_ENDED");
      if (chosen.type === "public" || chosen.kalosIndex === undefined) {
        const price = BigInt(chosen.priceWei ?? "0");
        tx = { to: k.seaDrop, data: encodeKalosMintPublic(t.contract, k.feeRecipient, quantity), value: price * BigInt(quantity) };
      } else {
        const elig = await fetchKalosEligibility(k.slug, wallet);
        const entry = elig.entries.find((e) => e.stageIndex === chosen.kalosIndex);
        if (!entry?.proof?.length) throw new MintBuildError("not on list", "NOT_ELIGIBLE");
        const price = BigInt(entry.mintParams.mintPrice);
        tx = {
          to: k.seaDrop,
          data: encodeMintAllowList(t.contract, k.feeRecipient, quantity, entry.mintParams, entry.proof),
          value: price * BigInt(quantity),
        };
      }
      builtLocal = true;
      if (clock === "active") {
        const sim = await simulateIgnoringBalance(pool, { from: wallet, to: tx.to, data: tx.data, value: tx.value });
        if (sim.ok === false) throw new MintBuildError(sim.reason || "Kalos mint simulation reverted", "SIMULATION");
      }
      break;
    }
    case "generic": {
      const g = t.generic;
      if (!g) throw new MintBuildError("Target is not a generic contract");
      const sig = req.generic?.signature ?? g.selected?.signature;
      const cand = g.candidates.find((c) => c.signature === sig);
      if (!cand) throw new MintBuildError(`Mint function ${sig} is not among detected candidates`);
      if (!cand.supported) throw new MintBuildError(`${cand.signature}: ${cand.reason}`);
      if (isDangerousFunctionName(cand.name)) throw new MintBuildError(`Blocked function ${cand.name}`);
      const frag = g.fragments.find((f) => {
        try {
          return new Interface([f]).getFunction(cand.signature) !== null;
        } catch {
          return false;
        }
      });
      if (!frag) throw new MintBuildError("ABI fragment missing for selected function");
      const iface = new Interface([frag]);
      const args = cand.inputs.map((i) => {
        if (i.role === "quantity") return BigInt(quantity);
        if (i.role === "recipient") return wallet;
        if (i.role === "tokenId") {
          if (req.generic?.tokenId === undefined) throw new MintBuildError("tokenId required for this mint function");
          return BigInt(req.generic.tokenId);
        }
        throw new MintBuildError(`Cannot fill argument ${i.name}`);
      });
      const priceWei = BigInt(req.generic?.priceWei ?? g.values.priceWei ?? "0");
      // Functions without a quantity arg mint 1 per call.
      const effectiveQty = cand.inputs.some((i) => i.role === "quantity") ? quantity : 1;
      if (effectiveQty !== quantity) throw new MintBuildError(`${cand.signature} mints one per call; set quantity 1`);
      tx = { to: getAddress(t.contract), data: iface.encodeFunctionData(cand.signature, args), value: priceWei * BigInt(quantity) };
      break;
    }
    default:
      throw new MintBuildError(`Unknown strategy ${(req as any).strategy}`);
  }
  // Price guard: the chosen stage's price when the member picked one, else the stage OpenSea mints into now.
  const osPrice = req.strategy === "opensea_api" && !builtLocal ? (chosen?.priceWei ?? osStage(t).priceWei) : null;
  await assertSafeMintTx(
    { ...tx, chainId: chain.chainId },
    {
      userId,
      chain,
      allowedTargets: allowedTargets(t, req),
      quantity,
      expectedMaxValueWei: osPrice !== null ? BigInt(osPrice) * BigInt(quantity) : null,
    },
  );
  return tx;
}
