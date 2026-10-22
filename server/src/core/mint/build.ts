// SPDX-License-Identifier: AGPL-3.0-only
import { Interface, getAddress } from "ethers";
import { requireChain } from "../../config/chains.js";
import { OpenSeaClient, OpenSeaHttpError } from "../resolver/opensea.js";
import { ResolvedTarget } from "../resolver/resolver.js";
import { SEADROP_ADDRESS, encodeMintPublic } from "../resolver/seadrop.js";
import { isDangerousFunctionName, assertSafeMintTx } from "../safety/safety.js";
import { osStage } from "./stage.js";
import { stageEndedAt } from "./stageEligibility.js";
import { BuiltTx, MintRequest } from "./types.js";

/** Map official mint-API errors. 422 is also returned for an unfunded minter, which says nothing about allowlist status. */
export function osErrorCode(status: number, message = ""): string {
  if (status === 409) return "NOT_ACTIVE";
  if (status === 422) return /insufficient (balance|funds)/i.test(message) ? "INSUFFICIENT_FUNDS" : "NOT_ELIGIBLE";
  return `HTTP_${status}`;
}
export class MintBuildError extends Error {
  statusCode = 422;
  constructor(
    m: string,
    public code = "BUILD",
  ) {
    super(m);
  }
}

/** Allowed `to` for each strategy — anything else is rejected by the safety guard. */
export function allowedTargets(t: ResolvedTarget, req: MintRequest): string[] {
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
): Promise<BuiltTx> {
  const chain = requireChain(t.chain.key);
  const chosen = req.stage ? (t.stages.find((s) => s.name === req.stage) ?? null) : null;
  if (chosen && stageEndedAt(chosen, Date.now())) throw new MintBuildError(`The ${chosen.name} stage has ended`, "STAGE_ENDED");
  let tx: BuiltTx;
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
      const slug = req.slug ?? t.slug;
      if (!slug) throw new MintBuildError("OpenSea slug unknown for this contract — cannot use OpenSea mint API");
      if (!os.available) throw new MintBuildError("OPENSEA_API_KEY not set — OpenSea mint API unavailable");
      try {
        const r = await os.buildMint(slug, wallet, quantity);
        const value = BigInt(r.value || "0x0");
        tx = { to: getAddress(r.to), data: r.data, value };
        if (r.chain && r.chain !== chain.openseaChain && r.chain !== chain.key)
          throw new MintBuildError(`OpenSea returned chain "${r.chain}" but target is ${chain.key}`);
      } catch (e: any) {
        if (e instanceof OpenSeaHttpError) {
          const code = osErrorCode(e.status, e.message);
          throw new MintBuildError(`OpenSea: ${e.message || e.status}`, code);
        }
        throw e;
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
  const osPrice = req.strategy === "opensea_api" ? (chosen?.priceWei ?? osStage(t).priceWei) : null;
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
