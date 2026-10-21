import { Contract, Interface, getAddress } from "ethers";
import type { RpcPool } from "../rpc/pool.js";
import { isRetryable } from "../rpc/pool.js";
import { resolveAbi } from "./etherscan.js";
import {
  GetterMap, MintCandidate, PROBE_GETTER_SIGS, PROBE_MINT_SIGNATURES, bytecodeHasSelector,
  findGetters, findMintCandidates, probeFragment, roleFor,
} from "./abiAnalysis.js";

const EIP1967_IMPL = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

export interface GenericInfo {
  abiSource: "etherscan" | "blockscout" | "sourcify" | "bytecode-probe";
  abiNote?: string;
  contractName?: string;
  implementation?: string;
  candidates: MintCandidate[];
  selected: MintCandidate | null;
  getters: GetterMap;
  values: {
    priceWei?: string; maxSupply?: string; totalSupply?: string; maxPerWallet?: string; maxPerTx?: string;
    saleActive?: boolean; paused?: boolean; name?: string; symbol?: string;
  };
  /** Minimal ABI fragments we need to encode the selected mint + per-wallet reads. */
  fragments: string[];
}

export async function readImplementation(pool: RpcPool, address: string): Promise<string | undefined> {
  const slot = await pool.read((p) => p.getStorage(address, EIP1967_IMPL), "getStorage").catch(() => null);
  if (!slot || /^0x0*$/.test(slot)) return undefined;
  const impl = "0x" + slot.slice(-40);
  return /^0x0{40}$/.test(impl) ? undefined : getAddress(impl);
}

function sigToFragment(abi: any[] | null, sig: string, fallback: string): string {
  if (abi) {
    try { const f = new Interface(abi).getFunction(sig); if (f) return f.format("full"); } catch { /* ignore */ }
  }
  return fallback;
}

export async function analyzeGeneric(pool: RpcPool, address: string, code: string): Promise<GenericInfo> {
  const implementation = await readImplementation(pool, address);
  const implCode = implementation ? await pool.read((p) => p.getCode(implementation), "getCode") : "";
  const { abi, source, note, contractName } = await resolveAbi(pool.chain, address, implementation);

  let candidates: MintCandidate[]; let getters: GetterMap; let abiSource: GenericInfo["abiSource"];
  if (abi) {
    candidates = findMintCandidates(abi);
    getters = findGetters(abi);
    abiSource = source as "etherscan" | "blockscout" | "sourcify";
  } else {
    abiSource = "bytecode-probe";
    const allCode = code + (implCode ?? "");
    candidates = PROBE_MINT_SIGNATURES.flatMap((sig) => {
      const iface = new Interface([probeFragment(sig, "mint")]);
      const f = iface.getFunction(sig)!;
      if (!bytecodeHasSelector(allCode, f.selector)) return [];
      const counts = { uints: f.inputs.filter((i) => i.type.startsWith("uint")).length, addrs: f.inputs.filter((i) => i.type === "address").length };
      const inputs = f.inputs.map((i, idx) => ({ name: `arg${idx}`, type: i.type, role: roleFor({ name: "", type: i.type }, counts) }));
      return [{ signature: sig, selector: f.selector, name: f.name, payable: true, inputs, supported: inputs.every((i) => i.role !== "unknown"), needsTokenId: false, score: 1 } as MintCandidate];
    });
    getters = {};
    for (const [key, sigs] of Object.entries(PROBE_GETTER_SIGS) as [keyof GetterMap, string[]][]) {
      for (const sig of sigs) {
        const f = new Interface([probeFragment(sig, "getter", key)]).getFunction(sig)!;
        if (bytecodeHasSelector(allCode, f.selector)) { getters[key] = sig; break; }
      }
    }
  }

  const getterFragments: Partial<Record<keyof GetterMap, string>> = {};
  for (const [k, sig] of Object.entries(getters) as [keyof GetterMap, string][]) {
    getterFragments[k] = sigToFragment(abi, sig, probeFragment(sig, "getter", k));
  }
  const values: GenericInfo["values"] = {};
  await pool.read(async (p) => {
    const c = new Contract(address, Object.values(getterFragments), p);
    await Promise.all((Object.entries(getters) as [keyof GetterMap, string][]).filter(([k]) => k !== "mintedBy").map(async ([k, sig]) => {
      try {
        const v = await c.getFunction(sig).staticCall();
        if (k === "saleActive" || k === "paused") (values as any)[k] = typeof v === "boolean" ? v : BigInt(v) !== 0n;
        else if (k === "name" || k === "symbol") (values as any)[k] = String(v);
        else (values as any)[k === "price" ? "priceWei" : k] = BigInt(v).toString();
      } catch (e) { if (isRetryable(e)) throw e; }
    }));
  }, "generic-getters");

  const selected = candidates.find((c) => c.supported) ?? null;
  const fragments = [...new Set([
    ...candidates.slice(0, 10).map((c) => sigToFragment(abi, c.signature, probeFragment(c.signature, "mint"))),
    ...Object.values(getterFragments),
  ])];
  return { abiSource, abiNote: note, contractName, implementation, candidates: candidates.slice(0, 10), selected, getters, values, fragments };
}

export async function genericMintedBy(pool: RpcPool, address: string, info: GenericInfo, wallet: string): Promise<number | null> {
  if (!info.getters.mintedBy) return null;
  const frag = info.fragments.find((f) => f.includes(info.getters.mintedBy!.split("(")[0] + "(")) ?? probeFragment(info.getters.mintedBy, "getter", "mintedBy");
  try {
    return await pool.read(async (p) => Number(await new Contract(address, [frag], p).getFunction(info.getters.mintedBy!).staticCall(wallet)), "mintedBy");
  } catch { return null; }
}
