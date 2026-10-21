import { Contract, getAddress } from "ethers";
import { CHAINS, ChainConfig, getChain, requireChain } from "../../config/chains.js";
import { getPool, RpcPool } from "../rpc/pool.js";
import { parseInput, ParsedInput } from "./parseInput.js";
import { OpenSeaClient, OsDrop, OpenSeaUnavailable } from "./opensea.js";
import { readSeaDrop, SeaDropInfo, SEADROP_ADDRESS } from "./seadrop.js";
import { analyzeGeneric, GenericInfo } from "./generic.js";

export interface Stage {
  name: string;
  type: "public" | "allowlist" | "signed" | "token_gated" | "unknown";
  priceWei: string | null;
  start: string | null; // ISO
  end: string | null;
  maxPerWallet: number | null;
  status: "active" | "upcoming" | "ended" | "unknown";
  source: "onchain" | "opensea";
}

export interface ResolvedTarget {
  input: string;
  parsed: ParsedInput;
  chain: { key: string; chainId: number; name: string; nativeSymbol: string; explorer: string };
  contract: string;
  kind: "seadrop" | "generic";
  name: string | null;
  symbol: string | null;
  standard: "erc721" | "erc1155" | "unknown";
  slug: string | null;
  opensea: { apiKey: boolean; drop: OsDrop | null; error: string | null; url: string | null };
  seadrop: SeaDropInfo | null;
  generic: GenericInfo | null;
  stages: Stage[];
  supply: { total: string | null; max: string | null; remaining: string | null };
  recommendedStrategy: "seadrop_public" | "opensea_api" | "generic" | "none";
  warnings: string[];
  resolvedAt: string;
}

function stageStatus(startSec: number | null, endSec: number | null, now = Date.now() / 1000): Stage["status"] {
  if (startSec === null) return "unknown";
  if (now < startSec) return "upcoming";
  if (endSec !== null && now >= endSec) return "ended";
  return "active";
}
const iso = (sec: number | null) => (sec ? new Date(sec * 1000).toISOString() : null);
const toSec = (s?: string | null) => (s ? Math.floor(new Date(s).getTime() / 1000) : null);

function mapOsStageType(t?: string): Stage["type"] {
  const s = (t ?? "").toLowerCase();
  if (s.includes("public")) return "public";
  if (s.includes("token")) return "token_gated";
  if (s.includes("sign")) return "signed";
  if (s.includes("allow") || s.includes("presale") || s.includes("private")) return "allowlist";
  return "unknown";
}

async function detectStandard(pool: RpcPool, addr: string): Promise<ResolvedTarget["standard"]> {
  const c = new Contract(addr, ["function supportsInterface(bytes4) view returns (bool)"], pool.endpoints[0].provider);
  try {
    return await pool.read(async (p) => {
      const cc = c.connect(p) as Contract;
      const [is721, is1155] = await Promise.all([cc.supportsInterface("0x80ac58cd").catch(() => false), cc.supportsInterface("0xd9b67a26").catch(() => false)]);
      return is721 ? "erc721" : is1155 ? "erc1155" : "unknown";
    }, "supportsInterface");
  } catch { return "unknown"; }
}

async function readNameSymbol(pool: RpcPool, addr: string) {
  try {
    return await pool.read(async (p) => {
      const c = new Contract(addr, ["function name() view returns (string)", "function symbol() view returns (string)"], p);
      const [n, s] = await Promise.all([c.name().catch(() => null), c.symbol().catch(() => null)]);
      return { name: n as string | null, symbol: s as string | null };
    }, "name/symbol");
  } catch { return { name: null, symbol: null }; }
}

export interface ResolveOptions { input: string; chain?: string; os?: OpenSeaClient; poolFor?: (c: ChainConfig) => RpcPool }

export async function resolveTarget(opts: ResolveOptions): Promise<ResolvedTarget> {
  const os = opts.os ?? new OpenSeaClient();
  const poolFor = opts.poolFor ?? getPool;
  const parsed = parseInput(opts.input);
  const warnings: string[] = [];
  let slug: string | null = parsed.kind === "slug" ? parsed.value : null;
  let contract: string | null = parsed.kind === "address" ? getAddress(parsed.value.toLowerCase()) : null;
  let chain: ChainConfig | undefined = opts.chain ? requireChain(opts.chain) : parsed.chainHint ? getChain(parsed.chainHint) : undefined;
  if (parsed.chainHint && !getChain(parsed.chainHint)) warnings.push(`Chain "${parsed.chainHint}" from the link is not configured.`);
  if (opts.chain && parsed.chainHint && getChain(parsed.chainHint) && getChain(parsed.chainHint)!.key !== chain!.key) {
    warnings.push(`Link says chain "${parsed.chainHint}" but "${chain!.key}" was selected — using the selected chain.`);
  }

  let drop: OsDrop | null = null; let osError: string | null = null;

  // 1) slug -> contract + chain via official OpenSea API
  if (slug) {
    try {
      const col = await os.getCollection(slug);
      const contracts = (col.contracts ?? []).filter((c) => getChain(c.chain));
      const pick = (chain && contracts.find((c) => getChain(c.chain)!.key === chain!.key)) || contracts[0];
      if (!pick) throw new Error(`Collection "${slug}" has no contract on a configured chain (${(col.contracts ?? []).map((c) => c.chain).join(", ") || "none listed"})`);
      contract = getAddress(pick.address);
      chain = getChain(pick.chain);
    } catch (e: any) {
      if (!contract) throw Object.assign(new Error(`Could not resolve slug "${slug}" via OpenSea: ${e.message}. ${os.available ? "" : "Set OPENSEA_API_KEY or "}paste the contract address + chain instead.`), { statusCode: 400 });
    }
  }
  if (!contract) throw Object.assign(new Error("No contract address could be determined"), { statusCode: 400 });

  // 2) address without chain -> find which configured chain has code there
  if (!chain) {
    const found: ChainConfig[] = [];
    await Promise.all(CHAINS.map(async (c) => {
      try { const code = await poolFor(c).read((p) => p.getCode(contract!), "getCode"); if (code && code !== "0x") found.push(c); } catch { /* chain unreachable */ }
    }));
    if (!found.length) throw Object.assign(new Error(`No contract at ${contract} on any configured chain (${CHAINS.map((c) => c.key).join(", ")})`), { statusCode: 404 });
    found.sort((a, b) => CHAINS.indexOf(a) - CHAINS.indexOf(b));
    chain = found[0];
    if (found.length > 1) warnings.push(`Contract exists on multiple chains (${found.map((c) => c.key).join(", ")}); using ${chain.key}. Select the chain explicitly if wrong.`);
  }

  const pool = poolFor(chain);
  await pool.checkChainId();
  const code = await pool.read((p) => p.getCode(contract!), "getCode");
  if (!code || code === "0x") throw Object.assign(new Error(`No contract code at ${contract} on ${chain.name}`), { statusCode: 404 });

  // 3) contract -> slug (official) so we can use the drops API
  if (!slug && os.available) {
    try { slug = (await os.getContract(chain.openseaChain, contract)).collection ?? null; } catch (e: any) { osError = `contract lookup: ${e.message}`; }
  }
  if (slug) {
    try { drop = await os.getDrop(slug); }
    catch (e: any) { osError = e instanceof OpenSeaUnavailable ? e.message : `drop lookup: ${e.message}`; }
  } else if (!os.available) osError = "OPENSEA_API_KEY not set — stage data from OpenSea unavailable (on-chain data only)";

  // 4) SeaDrop vs generic
  const seadrop = await readSeaDrop(pool, contract);
  const isSeaDrop = Boolean(seadrop) || (drop?.drop_type ?? "").startsWith("seadrop_v1");
  const generic = isSeaDrop ? null : await analyzeGeneric(pool, contract, code);
  const [standard, ns] = await Promise.all([detectStandard(pool, contract), readNameSymbol(pool, contract)]);

  // 5) stages
  const stages: Stage[] = [];
  if (seadrop?.publicDrop) {
    const pd = seadrop.publicDrop;
    stages.push({ name: "Public (on-chain)", type: "public", priceWei: pd.mintPriceWei, start: iso(pd.startTime), end: iso(pd.endTime), maxPerWallet: pd.maxPerWallet, status: stageStatus(pd.startTime, pd.endTime), source: "onchain" });
  }
  for (const s of drop?.stages ?? []) {
    const type = mapOsStageType(s.stage_type);
    if (type === "public" && seadrop?.publicDrop) continue; // on-chain is authoritative
    stages.push({ name: s.label || s.stage_type || "stage", type, priceWei: s.price ?? null, start: s.start_time ?? null, end: s.end_time ?? null, maxPerWallet: s.max_per_wallet ? Number(s.max_per_wallet) : null, status: stageStatus(toSec(s.start_time), toSec(s.end_time)), source: "opensea" });
  }
  if (seadrop && !drop) {
    if (seadrop.hasAllowList) stages.push({ name: "Allowlist (merkle root set; details need OpenSea)", type: "allowlist", priceWei: null, start: null, end: null, maxPerWallet: null, status: "unknown", source: "onchain" });
    if (seadrop.hasSignedMints) stages.push({ name: "Signed/presale (server signer set; needs OpenSea)", type: "signed", priceWei: null, start: null, end: null, maxPerWallet: null, status: "unknown", source: "onchain" });
    if (seadrop.hasTokenGated) stages.push({ name: "Token-gated", type: "token_gated", priceWei: null, start: null, end: null, maxPerWallet: null, status: "unknown", source: "onchain" });
  }
  if (generic) {
    stages.push({ name: generic.selected ? `Contract mint: ${generic.selected.signature}` : "No auto-detectable public mint function", type: "unknown", priceWei: generic.values.priceWei ?? null, start: null, end: null, maxPerWallet: generic.values.maxPerWallet ? Number(generic.values.maxPerWallet) : null, status: generic.values.paused ? "ended" : generic.values.saleActive === false ? "upcoming" : "unknown", source: "onchain" });
    if (generic.abiSource === "bytecode-probe") warnings.push(`No verified ABI found (${generic.abiNote ?? "set ETHERSCAN_API_KEY"}); mint function guessed from bytecode — verify before minting.`);
    if (!generic.selected) warnings.push("No supported public mint function detected. Allowlist/signature mints on non-OpenSea contracts are not supported in this version.");
    if (generic.values.priceWei === undefined) warnings.push("Mint price getter not found — enter the price manually; simulation will confirm.");
  }

  // 6) supply
  const total = seadrop?.totalSupply ?? drop?.total_supply ?? generic?.values.totalSupply ?? null;
  const max = seadrop?.maxSupply ?? drop?.max_supply ?? generic?.values.maxSupply ?? null;
  let remaining: string | null = null;
  if (total !== null && max !== null) { const r = BigInt(max) - BigInt(total); remaining = (r < 0n ? 0n : r).toString(); }

  let recommendedStrategy: ResolvedTarget["recommendedStrategy"] = "none";
  const pub = stages.find((s) => s.type === "public" && s.source === "onchain");
  const activeNonPublic = stages.find((s) => s.source === "opensea" && s.type !== "public" && (s.status === "active" || s.status === "upcoming"));
  if (isSeaDrop) {
    if (pub && pub.status !== "ended") recommendedStrategy = "seadrop_public";
    if (activeNonPublic && os.available && slug && (!pub || pub.status === "upcoming")) recommendedStrategy = "opensea_api";
    if (recommendedStrategy === "none" && os.available && slug) recommendedStrategy = "opensea_api";
    if (pub?.status === "ended" && !activeNonPublic) warnings.push("Public stage has ended.");
    if (seadrop?.publicDrop?.restrictFeeRecipients && !seadrop.feeRecipient) warnings.push("Drop restricts fee recipients and none are allowed — public mint cannot be built.");
    if (seadrop && seadrop.address !== SEADROP_ADDRESS) warnings.push("Unexpected SeaDrop address");
    if ((drop?.drop_type ?? "").includes("erc1155")) warnings.push("ERC-1155 SeaDrop drops are not supported by OpenSea's mint API; only on-chain public stage can be attempted.");
  } else if (generic?.selected) recommendedStrategy = "generic";

  if (remaining === "0") warnings.push("Sold out (remaining supply is 0).");

  return {
    input: opts.input, parsed,
    chain: { key: chain.key, chainId: chain.chainId, name: chain.name, nativeSymbol: chain.nativeSymbol, explorer: chain.explorer },
    contract, kind: isSeaDrop ? "seadrop" : "generic",
    name: ns.name ?? drop?.collection_name ?? generic?.values.name ?? null, symbol: ns.symbol ?? generic?.values.symbol ?? null,
    standard, slug,
    opensea: { apiKey: os.available, drop, error: osError, url: slug ? `https://opensea.io/collection/${slug}` : null },
    seadrop, generic, stages, supply: { total, max, remaining }, recommendedStrategy, warnings, resolvedAt: new Date().toISOString(),
  };
}
