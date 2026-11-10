// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Draft-only balance read and ERC-20 transfer. DO NOT MERGE.
 *
 * Native balances use the repo RPC registry. ERC-20 discovery reuses the Alchemy key the NFT indexer already
 * reads (ALCHEMY_API_KEY, or the key inside an Alchemy RPC URL). Chains with no Alchemy slug in that indexer
 * are not queried. A pasted contract is always read with balanceOf/symbol/decimals over the chain RPC.
 * The transfer is signed here with the SIWE authorization key. It does not call signRawTransaction, so the
 * production selector denylist (which blocks 0xa9059cbb) is not involved.
 */
import { Contract, Interface, Transaction, formatUnits, getAddress, toQuantity } from "ethers";
import { getPrivy } from "../auth/privy.js";
import { CHAINS, explorerTx, type ChainConfig } from "../config/chains.js";
import { ALCHEMY_NFT_NETWORK, alchemyKey } from "../core/nft/indexer.js";
import { getFees } from "../core/mint/fees.js";
import { getPool } from "../core/rpc/pool.js";
import { describeTxError } from "../core/tx/revert.js";
import { parseAmount, validateDestination } from "../core/withdraw.js";
import { redactString } from "../util/log.js";
import {
  assertTestSendRpc,
  assertTestSendToken,
  fetchAllowlistedAddress,
  resolveTestSendChain,
  siweTestAuthorizationContext,
  testSendChainOptions,
} from "./nativeSend.js";

export const ERC20_TRANSFER_SELECTOR = "0xa9059cbb";
const ERC20_IFACE = new Interface([
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);
const SYMBOL_BYTES32 = new Interface(["function symbol() view returns (bytes32)"]);
/** Not a value cap. Stops a broken estimate from requesting a huge gas limit. */
const ERC20_GAS_SANITY_CAP = 500_000n;
const ALCHEMY_PAGE_CAP = 5;
const TOKEN_CAP = 100;

export interface NativeBalanceRow {
  chainId: number;
  name: string;
  nativeSymbol: string;
  balanceWei: string | null;
  balance: string | null;
  error: string | null;
}

export interface HeldToken {
  chainId: number;
  chainName: string;
  address: string;
  symbol: string | null;
  name: string | null;
  decimals: number | null;
  balanceRaw: string;
  balance: string;
  source: "alchemy" | "rpc";
}

export interface TestLookupResult {
  address: string;
  native: NativeBalanceRow[];
  tokens: HeldToken[];
  zeroReads: { chainId: number; address: string; symbol: string | null; decimals: number | null }[];
  discovery: { provider: "alchemy" | null; configured: boolean; note: string; errors: string[] };
}

function httpError(message: string, statusCode: number, code: string): Error {
  return Object.assign(new Error(message), { statusCode, code });
}

export function encodeErc20Transfer(to: string, amount: bigint): string {
  const data = ERC20_IFACE.encodeFunctionData("transfer", [getAddress(to), amount]);
  if (!data.toLowerCase().startsWith(ERC20_TRANSFER_SELECTOR)) {
    throw httpError("ERC-20 transfer encoder did not produce selector 0xa9059cbb.", 500, "ENCODER");
  }
  return data;
}

export function parseErc20Amount(amount: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw httpError(`Token decimals ${String(decimals)} are not usable.`, 400, "BAD_DECIMALS");
  }
  const parsed = parseAmount(amount, decimals);
  if (parsed.kind !== "exact" || parsed.wei <= 0n) throw httpError("Amount must be greater than 0.", 400, "BAD_AMOUNT");
  return parsed.wei;
}

/** Alchemy alchemy_getTokenBalances rows with a positive balance. Zeros are dropped. */
export function nonZeroTokenBalances(payload: any): { contract: string; balance: bigint }[] {
  const rows = payload?.tokenBalances ?? payload?.result?.tokenBalances;
  if (!Array.isArray(rows)) return [];
  const out: { contract: string; balance: bigint }[] = [];
  for (const row of rows) {
    let contract: string;
    try {
      contract = getAddress(String(row?.contractAddress ?? "").toLowerCase());
    } catch {
      continue;
    }
    const hex = String(row?.tokenBalance ?? "");
    if (!/^0x[0-9a-fA-F]*$/.test(hex) || hex === "0x") continue;
    let balance: bigint;
    try {
      balance = BigInt(hex);
    } catch {
      continue;
    }
    if (balance > 0n) out.push({ contract, balance });
  }
  return out;
}

export function formatTokenAmount(amount: bigint, decimals: number | null): string {
  if (decimals == null || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) return amount.toString();
  return formatUnits(amount, decimals);
}

function decodeSymbol(raw: string): string | null {
  try {
    const [s] = ERC20_IFACE.decodeFunctionResult("symbol", raw);
    const text = String(s).trim();
    return text ? text.slice(0, 32) : null;
  } catch {
    try {
      const [word] = SYMBOL_BYTES32.decodeFunctionResult("symbol", raw);
      const text = Buffer.from(String(word).slice(2), "hex").toString("utf8").replace(/\0/g, "").trim();
      return text ? text.slice(0, 32) : null;
    } catch {
      return null;
    }
  }
}

async function readErc20(chain: ChainConfig, holder: string, token: string): Promise<Omit<HeldToken, "chainId" | "chainName" | "source">> {
  const pool = getPool(chain);
  const contract = getAddress(token);
  const balance = (await pool.read(
    (p) => new Contract(contract, ERC20_IFACE, p).balanceOf(holder) as Promise<bigint>,
    "balanceOf",
  )) as bigint;
  let decimals: number | null = null;
  try {
    const d = await pool.read((p) => new Contract(contract, ERC20_IFACE, p).decimals() as Promise<bigint | number>, "decimals");
    const n = Number(d);
    decimals = Number.isInteger(n) && n >= 0 && n <= 36 ? n : null;
  } catch {
    decimals = null;
  }
  let symbol: string | null = null;
  try {
    const raw = await pool.read((p) => p.call({ to: contract, data: ERC20_IFACE.encodeFunctionData("symbol") }), "symbol");
    symbol = decodeSymbol(raw);
  } catch {
    symbol = null;
  }
  let name: string | null = null;
  try {
    const named = new Interface(["function name() view returns (string)"]);
    const raw = await pool.read((p) => p.call({ to: contract, data: named.encodeFunctionData("name") }), "name");
    name =
      String(named.decodeFunctionResult("name", raw)[0] ?? "")
        .trim()
        .slice(0, 64) || null;
  } catch {
    name = null;
  }
  return { address: contract, symbol, name, decimals, balanceRaw: balance.toString(), balance: formatTokenAmount(balance, decimals) };
}

async function alchemyRpc(slug: string, key: string, method: string, params: unknown[], fetchImpl: typeof fetch): Promise<any> {
  const res = await fetchImpl(`https://${slug}.g.alchemy.com/v2/${key}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || json?.error) {
    const msg = json?.error?.message ?? `Alchemy ${method} failed (${res.status})`;
    throw new Error(redactString(String(msg)).slice(0, 300));
  }
  return json?.result;
}

async function discoverAlchemy(chain: ChainConfig, holder: string, key: string, fetchImpl: typeof fetch): Promise<HeldToken[]> {
  const slug = ALCHEMY_NFT_NETWORK[chain.key];
  if (!slug) return [];
  const found: { contract: string; balance: bigint }[] = [];
  let pageKey: string | undefined;
  for (let page = 0; page < ALCHEMY_PAGE_CAP && found.length < TOKEN_CAP; page++) {
    const params = pageKey ? [holder, "erc20", { pageKey }] : [holder, "erc20"];
    const result = await alchemyRpc(slug, key, "alchemy_getTokenBalances", params, fetchImpl);
    found.push(...nonZeroTokenBalances(result));
    pageKey = typeof result?.pageKey === "string" && result.pageKey ? result.pageKey : undefined;
    if (!pageKey) break;
  }
  const uniq = new Map<string, bigint>();
  for (const row of found) if (!uniq.has(row.contract)) uniq.set(row.contract, row.balance);
  const rows = [...uniq.entries()].slice(0, TOKEN_CAP);
  const out: HeldToken[] = [];
  for (let i = 0; i < rows.length; i += 6) {
    const chunk = rows.slice(i, i + 6);
    const metas = await Promise.all(
      chunk.map(async ([contract, balance]) => {
        let symbol: string | null = null;
        let name: string | null = null;
        let decimals: number | null = null;
        try {
          const meta = await alchemyRpc(slug, key, "alchemy_getTokenMetadata", [contract], fetchImpl);
          symbol = typeof meta?.symbol === "string" && meta.symbol.trim() ? meta.symbol.trim().slice(0, 32) : null;
          name = typeof meta?.name === "string" && meta.name.trim() ? meta.name.trim().slice(0, 64) : null;
          const d = Number(meta?.decimals);
          decimals = Number.isInteger(d) && d >= 0 && d <= 36 ? d : null;
        } catch {
          /* metadata is optional; the balance is already known */
        }
        return {
          chainId: chain.chainId,
          chainName: chain.name,
          address: contract,
          symbol,
          name,
          decimals,
          balanceRaw: balance.toString(),
          balance: formatTokenAmount(balance, decimals),
          source: "alchemy" as const,
        };
      }),
    );
    out.push(...metas);
  }
  return out;
}

function pastedContracts(body: unknown): { chainId: number; address: string }[] {
  if (!body || typeof body !== "object" || Array.isArray(body)) return [];
  const list = (body as { contracts?: unknown }).contracts;
  if (!Array.isArray(list)) return [];
  const out: { chainId: number; address: string }[] = [];
  for (const row of list.slice(0, 20)) {
    if (!row || typeof row !== "object") continue;
    const chainId = Number((row as { chainId?: unknown }).chainId);
    const address = String((row as { address?: unknown }).address ?? "").trim();
    if (!Number.isInteger(chainId) || !address) continue;
    out.push({ chainId, address });
  }
  return out;
}

/** Native balances on every repo chain, plus non-zero ERC-20s. */
export async function runTestLookup(
  header: string | null | undefined,
  body: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<TestLookupResult> {
  assertTestSendToken(header);
  const walletId =
    body && typeof body === "object" && typeof (body as { walletId?: unknown }).walletId === "string"
      ? (body as { walletId: string }).walletId.trim()
      : "";
  if (!walletId) throw httpError("Wallet is required.", 400, "BAD_WALLET");
  const address = await fetchAllowlistedAddress(walletId);

  const native = await Promise.all(
    CHAINS.map(async (chain): Promise<NativeBalanceRow> => {
      try {
        assertTestSendRpc(chain);
      } catch (e: any) {
        return {
          chainId: chain.chainId,
          name: chain.name,
          nativeSymbol: chain.nativeSymbol,
          balanceWei: null,
          balance: null,
          error: e?.message ?? "RPC not configured",
        };
      }
      try {
        const wei = await getPool(chain).read((p) => p.getBalance(address, "latest"), "balance");
        return {
          chainId: chain.chainId,
          name: chain.name,
          nativeSymbol: chain.nativeSymbol,
          balanceWei: wei.toString(),
          balance: formatUnits(wei, 18),
          error: null,
        };
      } catch (e: any) {
        return {
          chainId: chain.chainId,
          name: chain.name,
          nativeSymbol: chain.nativeSymbol,
          balanceWei: null,
          balance: null,
          error: redactString(String(e?.shortMessage ?? e?.message ?? e)).slice(0, 300),
        };
      }
    }),
  );

  const key = alchemyKey();
  const errors: string[] = [];
  const unsupported = testSendChainOptions()
    .filter((c) => !ALCHEMY_NFT_NETWORK[CHAINS.find((x) => x.chainId === c.chainId)?.key ?? ""])
    .map((c) => c.name);
  let tokens: HeldToken[] = [];
  if (!key) {
    errors.push("ALCHEMY_API_KEY is not set, and no Alchemy RPC URL contains a key. Paste a token contract to read it over RPC.");
  } else {
    const discovered = await Promise.all(
      CHAINS.filter((c) => ALCHEMY_NFT_NETWORK[c.key]).map(async (chain) => {
        try {
          return await discoverAlchemy(chain, address, key, fetchImpl);
        } catch (e: any) {
          errors.push(`${chain.name}: ${redactString(String(e?.message ?? e)).slice(0, 200)}`);
          return [] as HeldToken[];
        }
      }),
    );
    tokens = discovered.flat();
  }
  if (unsupported.length)
    errors.push(`No Alchemy token API in the repo for: ${unsupported.join(", ")}. Paste a contract to read those over RPC.`);

  const zeroReads: TestLookupResult["zeroReads"] = [];
  for (const paste of pastedContracts(body)) {
    let chain: ChainConfig;
    let token: string;
    try {
      chain = resolveTestSendChain(paste.chainId);
      token = validateDestination(paste.address);
    } catch (e: any) {
      errors.push(String(e?.message ?? e));
      continue;
    }
    try {
      const read = await readErc20(chain, address, token);
      if (BigInt(read.balanceRaw) <= 0n) {
        zeroReads.push({ chainId: chain.chainId, address: read.address, symbol: read.symbol, decimals: read.decimals });
        continue;
      }
      const keyId = `${chain.chainId}:${read.address.toLowerCase()}`;
      tokens = tokens.filter((t) => `${t.chainId}:${t.address.toLowerCase()}` !== keyId);
      tokens.push({ ...read, chainId: chain.chainId, chainName: chain.name, source: "rpc" });
    } catch (e: any) {
      errors.push(`${chain.name} ${token}: ${redactString(String(e?.shortMessage ?? e?.message ?? e)).slice(0, 200)}`);
    }
  }

  const note = key
    ? "Non-zero ERC-20 balances come from Alchemy (the same ALCHEMY_API_KEY / Alchemy RPC key the NFT indexer uses). A pasted contract is read with balanceOf, symbol, and decimals on the chain RPC."
    : "Token discovery needs ALCHEMY_API_KEY, or an Alchemy RPC URL (RPC_<CHAIN>=https://….g.alchemy.com/v2/<key>) like the NFT indexer. Paste a token contract to read its balance, symbol, and decimals over RPC.";

  return {
    address,
    native,
    tokens: tokens.slice(0, TOKEN_CAP),
    zeroReads,
    discovery: { provider: key ? "alchemy" : null, configured: Boolean(key), note, errors },
  };
}

export interface CheckedErc20Transfer {
  from: string;
  token: string;
  to: string;
  amount: bigint;
  data: string;
  chainId: number;
}

/** Signed payload must be value 0, to the token, and exactly transfer(to, amount). */
export function assertSignedErc20Transfer(
  raw: string,
  expected: { from: string; token: string; to: string; amount: bigint; chainId: number },
): CheckedErc20Transfer {
  if (!/^0x[0-9a-fA-F]+$/.test(raw)) throw httpError("Privy did not return a signed transaction.", 502, "SIGN_FAILED");
  let parsed: Transaction;
  try {
    parsed = Transaction.from(raw);
  } catch (e: any) {
    throw httpError(`Signed transaction could not be decoded: ${e?.message ?? e}`, 502, "SIGN_FAILED");
  }
  const chainId = parsed.chainId == null ? NaN : Number(parsed.chainId);
  if (chainId !== expected.chainId) {
    throw httpError(`Refusing to broadcast chain id ${String(parsed.chainId)}; the request selected ${expected.chainId}.`, 400, "TX_SHAPE");
  }
  const token = parsed.to ? getAddress(parsed.to) : "";
  if (token !== getAddress(expected.token)) throw httpError(`Refusing to broadcast to ${token || "no contract"}.`, 400, "TX_SHAPE");
  if (parsed.value !== 0n) throw httpError("Refusing to broadcast an ERC-20 transfer with a non-zero native value.", 400, "TX_SHAPE");
  const data = (parsed.data ?? "").toLowerCase();
  const want = encodeErc20Transfer(expected.to, expected.amount).toLowerCase();
  if (data !== want)
    throw httpError("Refusing to broadcast calldata that is not the requested transfer(address,uint256).", 400, "TX_SHAPE");
  if (!parsed.from || getAddress(parsed.from) !== getAddress(expected.from)) {
    throw httpError("Signed sender does not match the fetched wallet.", 400, "TX_SHAPE");
  }
  return { from: getAddress(parsed.from), token, to: getAddress(expected.to), amount: expected.amount, data: want, chainId };
}

function stampFrom(e: unknown, from: string): never {
  if (e && typeof e === "object") (e as { from?: string }).from ??= from;
  throw e;
}

/**
 * ERC-20 transfer signed with the SIWE key. Amount is a positive decimal in token units. No value cap.
 */
export async function runTestErc20Send(
  header: string | null | undefined,
  body: unknown,
): Promise<{
  txHash: string;
  explorer: string;
  from: string;
  to: string;
  token: string;
  amountRaw: string;
  amount: string;
  symbol: string | null;
  decimals: number;
  chainId: number;
}> {
  assertTestSendToken(header);
  const ctx = siweTestAuthorizationContext();
  if (!body || typeof body !== "object" || Array.isArray(body)) throw httpError("JSON body required.", 400, "BAD_BODY");
  const b = body as Record<string, unknown>;
  const walletId = typeof b.walletId === "string" ? b.walletId.trim() : "";
  const tokenRaw = typeof b.token === "string" ? b.token.trim() : "";
  const amount = typeof b.amount === "string" ? b.amount.trim() : "";
  const destination = typeof b.destination === "string" ? b.destination.trim() : "";
  const chainRaw = b.chainId;
  const chainId = typeof chainRaw === "number" ? chainRaw : typeof chainRaw === "string" && /^\d+$/.test(chainRaw) ? Number(chainRaw) : NaN;
  if (!walletId) throw httpError("Wallet is required.", 400, "BAD_WALLET");
  if (!Number.isInteger(chainId)) throw httpError("Chain is required.", 400, "BAD_CHAIN");
  if (!tokenRaw) throw httpError("Token contract is required.", 400, "BAD_TOKEN");
  if (!amount) throw httpError("Amount must be a decimal string.", 400, "BAD_AMOUNT");
  if (!destination) throw httpError("Destination is required.", 400, "BAD_ADDRESS");

  const chain = resolveTestSendChain(chainId);
  const token = validateDestination(tokenRaw);
  const to = validateDestination(destination);
  if (to.toLowerCase() === token.toLowerCase()) throw httpError("Destination is the token contract.", 400, "BAD_ADDRESS");
  const from = await fetchAllowlistedAddress(walletId);
  const meta = await readErc20(chain, from, token);
  if (meta.decimals == null) throw httpError(`Could not read decimals() for ${token} on ${chain.name}.`, 400, "BAD_DECIMALS");
  const amountRaw = parseErc20Amount(amount, meta.decimals);
  const data = encodeErc20Transfer(to, amountRaw);

  const pool = getPool(chain);
  let gasLimit: bigint;
  try {
    gasLimit = await pool.read((p) => p.estimateGas({ from, to: token, value: 0n, data }), "estimateGas");
  } catch (e) {
    const why = await describeTxError(e, { chain, contracts: [token] });
    stampFrom(httpError(`Gas estimate failed: ${why.message}`, 400, "ESTIMATE_FAILED"), from);
  }
  if (gasLimit < 21_000n) gasLimit = 21_000n;
  if (gasLimit > ERC20_GAS_SANITY_CAP) {
    stampFrom(
      httpError(`Gas estimate ${gasLimit.toString()} exceeds the ERC-20 sanity cap of ${ERC20_GAS_SANITY_CAP.toString()}.`, 400, "GAS_CAP"),
      from,
    );
  }
  const [fees, nonce] = await Promise.all([getFees(pool), pool.read((p) => p.getTransactionCount(from, "pending"), "nonce")]);

  let signed: string;
  try {
    const res = await getPrivy()
      .wallets()
      .ethereum()
      .signTransaction(walletId, {
        params: {
          transaction: {
            to: token,
            data,
            value: "0x0",
            nonce,
            chain_id: chain.chainId,
            gas_limit: toQuantity(gasLimit),
            max_fee_per_gas: toQuantity(fees.maxFeePerGas),
            max_priority_fee_per_gas: toQuantity(fees.maxPriorityFeePerGas),
            type: 2,
          },
        },
        authorization_context: ctx,
      } as any);
    signed = (res as any)?.signed_transaction;
    if (typeof signed !== "string" || !/^0x[0-9a-fA-F]+$/.test(signed)) {
      throw httpError("Privy did not return a signed transaction.", 502, "SIGN_FAILED");
    }
  } catch (e) {
    stampFrom(e, from);
  }

  const checked = assertSignedErc20Transfer(signed, { from, token, to, amount: amountRaw, chainId: chain.chainId });
  const sent = await pool.broadcast(signed);
  if (!sent.accepted.length) {
    const msg = sent.errors.map((e) => redactString(e.error)).join("; ") || "no RPC accepted the transaction";
    stampFrom(httpError(`Broadcast failed (hash ${sent.hash}): ${msg}`, 502, "BROADCAST_FAILED"), from);
  }
  return {
    txHash: sent.hash,
    explorer: explorerTx(chain, sent.hash),
    from: checked.from,
    to: checked.to,
    token: checked.token,
    amountRaw: checked.amount.toString(),
    amount: formatTokenAmount(checked.amount, meta.decimals),
    symbol: meta.symbol,
    decimals: meta.decimals,
    chainId: chain.chainId,
  };
}
