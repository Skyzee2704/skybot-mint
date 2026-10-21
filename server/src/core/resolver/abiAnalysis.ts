import { FunctionFragment, Interface } from "ethers";

/** Static analysis of a (verified) ABI to find public-mint functions and useful getters. */
export type ArgRole = "quantity" | "recipient" | "tokenId" | "proof" | "signature" | "unknown";
export interface MintCandidate {
  signature: string; // e.g. mint(uint256)
  selector: string;
  name: string;
  payable: boolean;
  inputs: { name: string; type: string; role: ArgRole }[];
  supported: boolean; // all args can be filled automatically (tokenId needs user input but is supported)
  needsTokenId: boolean;
  reason?: string;
  score: number;
}
export interface GetterMap {
  price?: string; maxSupply?: string; totalSupply?: string; maxPerWallet?: string; maxPerTx?: string;
  saleActive?: string; paused?: string; mintedBy?: string; name?: string; symbol?: string;
}

const MINT_NAME = /(mint|claim|purchase|buy|adopt)/i;
const ADMIN_NAME = /^(set|toggle|withdraw|owner|admin|dev|team|reserve|airdrop|gift|grant|revoke|renounce|transfer|approve|safe|burn|pause|unpause|update|lock|freeze|reveal|flip|enable|disable|start|stop|init|configure|emergency)|(owner|admin|dev|team|reserve|airdrop|gift|treasury|crossmint|for(address|team|owner))mint|mint(reserve|team|dev|owner|admin|airdrop|for|to_owner|batchto)|onlyowner/i;
const QTY = /(qty|quant|amount|amt|count|num|number|tokens|_n$|^n$|howmany|mintamount|_mintamount|units|size)/i;
const RECIP = /(to|recipient|receiver|account|minter|wallet|user|owner|addr|beneficiary)/i;
const TOKENID = /(tokenid|_id$|^id$|^_?tokenId$|typeid)/i;
const PREFERRED = /^(mint|publicmint|mintpublic|publicsalemint|purchase|claim|buy|mintnft|mintnfts|publicMint)$/i;

export function roleFor(input: { name: string; type: string }, counts: { uints: number; addrs: number }): ArgRole {
  const n = input.name || "";
  if (input.type === "bytes32[]") return "proof";
  if (input.type === "bytes" && /sig/i.test(n)) return "signature";
  if (input.type === "bytes") return /proof|data/i.test(n) ? "proof" : "signature";
  if (input.type.startsWith("uint")) {
    if (TOKENID.test(n)) return "tokenId";
    if (QTY.test(n) || counts.uints === 1) return "quantity";
    return "unknown";
  }
  if (input.type === "address") {
    if (RECIP.test(n) || counts.addrs === 1) return "recipient";
    return "unknown";
  }
  return "unknown";
}

export function findMintCandidates(abi: any[]): MintCandidate[] {
  const iface = new Interface(abi);
  const out: MintCandidate[] = [];
  iface.forEachFunction((f: FunctionFragment) => {
    if (f.stateMutability === "view" || f.stateMutability === "pure") return;
    if (!MINT_NAME.test(f.name) || ADMIN_NAME.test(f.name)) return;
    const counts = { uints: f.inputs.filter((i) => i.type.startsWith("uint")).length, addrs: f.inputs.filter((i) => i.type === "address").length };
    const inputs = f.inputs.map((i) => ({ name: i.name, type: i.type, role: roleFor(i, counts) }));
    const bad = inputs.filter((i) => i.role === "proof" || i.role === "signature" || i.role === "unknown");
    const roleDupes = ["quantity", "recipient"].some((r) => inputs.filter((i) => i.role === r).length > 1);
    let score = 0;
    if (f.payable) score += 3;
    if (PREFERRED.test(f.name)) score += 3;
    if (/public/i.test(f.name)) score += 2;
    if (/(allow|white|pre|wl|presale|signed|og|vip)/i.test(f.name)) score -= 3;
    if (inputs.some((i) => i.role === "quantity")) score += 2;
    if (bad.length) score -= 6;
    if (roleDupes) score -= 4;
    const supported = bad.length === 0 && !roleDupes;
    out.push({
      signature: f.format("sighash"), selector: f.selector, name: f.name, payable: f.payable, inputs,
      supported, needsTokenId: inputs.some((i) => i.role === "tokenId"),
      reason: supported ? undefined : bad.some((b) => b.role === "proof" || b.role === "signature") ? "needs allowlist proof/signature" : "has arguments that cannot be filled automatically",
      score,
    });
  });
  return out.sort((a, b) => b.score - a.score);
}

const GETTERS: [keyof GetterMap, RegExp, "none" | "address"][] = [
  ["price", /^(_?public)?(mint|sale|token|nft)?_?(price|cost|fee)$|^(publicsaleprice|publicprice|mintprice|price|cost|getprice|getmintprice|mint_price|PRICE|MINT_PRICE|PUBLIC_PRICE)$/i, "none"],
  ["maxSupply", /^(max_?supply|maxtokens|collectionsize|max_?tokens|supplylimit|MAX_SUPPLY|maxmintsupply|totalmaxsupply|max_?elements)$/i, "none"],
  ["totalSupply", /^(totalsupply|totalminted|_totalminted)$/i, "none"],
  ["maxPerWallet", /^(max_?per_?(wallet|address)|max_?mints?_?per_?(wallet|address)|walletlimit|maxmintamountperwallet|max_?per_?wallet_?public|MAX_PER_WALLET|maxpublicmint)$/i, "none"],
  ["maxPerTx", /^(max_?per_?tx|maxmintamountpertx|max_?mint_?amount|MAX_PER_TX|maxbatchsize|maxmintpertx)$/i, "none"],
  ["saleActive", /^(is)?_?(public)?_?(sale|mint)_?(is)?_?(active|live|open|enabled|started|on)$|^(saleisactive|ispublicsaleactive|publicsaleactive|mintactive|mintenabled|ismintactive|publicsaleopen|saleactive|mintopen|publicmintenabled)$/i, "none"],
  ["paused", /^(paused|ispaused|mintpaused)$/i, "none"],
  ["mintedBy", /^(numberminted|mintedby|_?numberminted|mintedcount|mintcount|addressmintedbalance|mintedperwallet|minted|walletmints|mintedamount|publicminted)$/i, "address"],
  ["name", /^name$/, "none"],
  ["symbol", /^symbol$/, "none"],
];

export function findGetters(abi: any[]): GetterMap {
  const iface = new Interface(abi);
  const out: GetterMap = {};
  iface.forEachFunction((f) => {
    if (f.stateMutability !== "view" && f.stateMutability !== "pure") return;
    for (const [key, re, arg] of GETTERS) {
      if (out[key]) continue;
      const argsOk = arg === "none" ? f.inputs.length === 0 : f.inputs.length === 1 && f.inputs[0].type === "address";
      const outOk = key === "name" || key === "symbol" ? f.outputs.length === 1 && f.outputs[0].type === "string"
        : key === "saleActive" || key === "paused" ? f.outputs.length === 1 && (f.outputs[0].type === "bool" || f.outputs[0].type.startsWith("uint"))
        : f.outputs.length === 1 && f.outputs[0].type.startsWith("uint");
      if (argsOk && outOk && re.test(f.name)) out[key] = f.format("sighash");
    }
  });
  return out;
}

/** Common signatures used when no verified ABI is available (matched against bytecode selectors). */
export const PROBE_MINT_SIGNATURES = [
  "mint(uint256)", "publicMint(uint256)", "mintPublic(uint256)", "mint(address,uint256)", "mint(uint256,address)",
  "mintTo(address,uint256)", "claim(uint256)", "purchase(uint256)", "publicSaleMint(uint256)", "mintNFT(uint256)",
  "mintNFTs(uint256)", "buy(uint256)", "mint()", "freeMint(uint256)", "safeMint(address,uint256)",
];
export const PROBE_GETTERS: GetterMap = {};
export const PROBE_GETTER_SIGS: Record<keyof GetterMap, string[]> = {
  price: ["mintPrice()", "price()", "cost()", "publicPrice()", "publicSalePrice()", "PRICE()", "MINT_PRICE()", "getPrice()"],
  maxSupply: ["maxSupply()", "MAX_SUPPLY()", "collectionSize()", "maxTokens()"],
  totalSupply: ["totalSupply()", "totalMinted()"],
  maxPerWallet: ["maxPerWallet()", "maxPerAddress()", "MAX_PER_WALLET()", "maxMintPerWallet()", "walletLimit()"],
  maxPerTx: ["maxPerTx()", "maxMintAmountPerTx()", "MAX_PER_TX()"],
  saleActive: ["saleIsActive()", "publicSaleActive()", "isPublicSaleActive()", "mintActive()", "saleActive()", "mintEnabled()"],
  paused: ["paused()"],
  mintedBy: ["numberMinted(address)", "mintedBy(address)", "addressMintedBalance(address)", "mintCount(address)"],
  name: ["name()"],
  symbol: ["symbol()"],
};

/** Build a synthetic ABI fragment for probe signatures. */
export function probeFragment(sig: string, kind: "mint" | "getter", key?: keyof GetterMap): string {
  if (kind === "mint") return `function ${sig} payable`;
  const ret = key === "name" || key === "symbol" ? "string" : key === "saleActive" || key === "paused" ? "bool" : "uint256";
  return `function ${sig} view returns (${ret})`;
}

/** True if a 4-byte selector appears as a PUSH4 operand in runtime bytecode (heuristic dispatcher scan). */
export function bytecodeHasSelector(code: string, selector: string): boolean {
  const c = code.toLowerCase().replace(/^0x/, "");
  const s = selector.toLowerCase().replace(/^0x/, "");
  return c.includes("63" + s);
}
