// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Draft-only probe. DO NOT MERGE.
 *
 * Signs with PRIVY_SIWE_AUTH_PRIVATE_KEY only. The mint signer (PRIVY_AUTH_PRIVATE_KEY / signRawTransaction)
 * is not used. Privy's authorization context has no quorum field; the key is the member of
 * PRIVY_SIWE_KEY_QUORUM_ID, same as the SIWE personal_sign call.
 *
 * The request may choose an allowlisted wallet, a repo chain, a positive native amount, and a destination.
 * There is no server-side amount cap: a Privy policy denial is the limit, and it is returned verbatim.
 */
import { timingSafeEqual } from "node:crypto";
import { Transaction, formatEther, getAddress, toQuantity } from "ethers";
import { normalizeAuthKey } from "../auth/authKey.js";
import { getPrivy } from "../auth/privy.js";
import { CHAINS, explorerTx, getChain, rpcsForChain, type ChainConfig } from "../config/chains.js";
import { getFees } from "../core/mint/fees.js";
import { getPool } from "../core/rpc/pool.js";
import { describeTxError } from "../core/tx/revert.js";
import { parseAmount, validateDestination } from "../core/withdraw.js";
import { redactString } from "../util/log.js";

/** Used when TEST_SEND_WALLET_IDS is unset. */
export const TEST_SEND_DEFAULT_WALLET_ID = "tloqxjloa5jloj6dv38n0fmf";
export const TEST_SEND_TOKEN_HEADER = "x-test-send-token";
/** Native-transfer gas above this is not a plain send. This is not a value cap. */
const GAS_SANITY_CAP = 100_000n;

export interface TestSendChainOption {
  chainId: number;
  name: string;
  nativeSymbol: string;
}

export interface TestSendResult {
  txHash: string;
  explorer: string;
  from: string;
  to: string;
  valueWei: string;
  valueNative: string;
  nativeSymbol: string;
  chainId: number;
}

export interface TestSendInput {
  walletId: string;
  chainId: number;
  amount: string;
  destination: string;
}

function httpError(message: string, statusCode: number, code: string): Error {
  return Object.assign(new Error(message), { statusCode, code });
}

function tokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Disabled when `TEST_SEND_TOKEN` is unset. Wrong or missing header is unauthorized. Never echoes either value. */
export function assertTestSendToken(header: string | null | undefined): void {
  const expected = process.env.TEST_SEND_TOKEN?.trim();
  if (!expected) {
    throw httpError("Test send is disabled because TEST_SEND_TOKEN is not set.", 503, "TEST_SEND_DISABLED");
  }
  const got = (header ?? "").trim();
  if (!got || got.length > 512 || !tokenMatches(got, expected)) {
    throw httpError("Unauthorized.", 401, "TEST_SEND_UNAUTHORIZED");
  }
}

/** Comma-separated Privy wallet ids. Unset or blank falls back to the original test wallet. */
export function testSendWalletAllowlist(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.TEST_SEND_WALLET_IDS;
  const source = raw === undefined || !raw.trim() ? TEST_SEND_DEFAULT_WALLET_ID : raw;
  const ids: string[] = [];
  for (const part of source.split(",")) {
    const id = part.trim();
    if (!id || ids.includes(id)) continue;
    if (id.length > 100) throw httpError("TEST_SEND_WALLET_IDS has an entry longer than 100 characters.", 500, "WALLET_ALLOWLIST");
    ids.push(id);
  }
  return ids.length ? ids : [TEST_SEND_DEFAULT_WALLET_ID];
}

export function assertWalletAllowed(walletId: string, env: NodeJS.ProcessEnv = process.env): void {
  if (!testSendWalletAllowlist(env).includes(walletId)) {
    throw httpError("Wallet is not in TEST_SEND_WALLET_IDS.", 400, "WALLET_NOT_ALLOWLISTED");
  }
}

/** Chains SkyBOT already supports, in registry order. Symbols and ids come from that registry. */
export function testSendChainOptions(): TestSendChainOption[] {
  return CHAINS.map((c) => ({ chainId: c.chainId, name: c.name, nativeSymbol: c.nativeSymbol }));
}

/** Repo RPC list only. No invented public URL. Empty when private RPCs are absent and the registry has none. */
export function assertTestSendRpc(chain: ChainConfig): void {
  if (rpcsForChain(chain).read.length === 0) {
    throw httpError(`RPC not configured for chain ${chain.name} (${chain.chainId}).`, 400, "RPC_NOT_CONFIGURED");
  }
}

/** Repo RPC list only. No invented public URL. */
export function resolveTestSendChain(chainId: number): ChainConfig {
  const chain = getChain(chainId);
  if (!chain) {
    const supported = CHAINS.map((c) => `${c.name} (${c.chainId})`).join(", ");
    throw httpError(`Unsupported chain "${chainId}". Supported: ${supported}.`, 400, "BAD_CHAIN");
  }
  assertTestSendRpc(chain);
  return chain;
}

/** Positive decimal native amount. No upper cap — Privy policy is the limit. */
export function parseTestSendAmount(amount: string): bigint {
  const parsed = parseAmount(amount);
  if (parsed.kind !== "exact" || parsed.wei <= 0n) throw httpError("Amount must be greater than 0.", 400, "BAD_AMOUNT");
  return parsed.wei;
}

export function parseTestSendBody(body: unknown): TestSendInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw httpError("JSON body required.", 400, "BAD_BODY");
  const b = body as Record<string, unknown>;
  const walletId = typeof b.walletId === "string" ? b.walletId.trim() : "";
  const destination = typeof b.destination === "string" ? b.destination.trim() : "";
  const chainRaw = b.chainId;
  const chainId = typeof chainRaw === "number" ? chainRaw : typeof chainRaw === "string" && /^\d+$/.test(chainRaw) ? Number(chainRaw) : NaN;
  if (!walletId) throw httpError("Wallet is required.", 400, "BAD_WALLET");
  if (!Number.isInteger(chainId)) throw httpError("Chain is required.", 400, "BAD_CHAIN");
  if (typeof b.amount !== "string" || !b.amount.trim()) throw httpError("Amount must be a decimal string.", 400, "BAD_AMOUNT");
  if (!destination) throw httpError("Destination is required.", 400, "BAD_ADDRESS");
  return { walletId, chainId, amount: b.amount.trim(), destination };
}

function isEmptyCalldata(data: string | null | undefined): boolean {
  return data == null || data === "" || data === "0x";
}

export interface CheckedNativeTransfer {
  from: string;
  to: string;
  value: bigint;
  data: "0x";
  chainId: number;
}

/**
 * The signed payload must be the requested native transfer: empty calldata, same chain, destination,
 * value, and recovered sender. Value only has to be > 0; there is no wei ceiling.
 */
export function assertSignedNativeTransfer(
  raw: string,
  expected: { from: string; to: string; value: bigint; chainId: number },
): CheckedNativeTransfer {
  if (!/^0x[0-9a-fA-F]+$/.test(raw)) {
    throw httpError("Privy did not return a signed transaction.", 502, "SIGN_FAILED");
  }
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
  if (!parsed.to) throw httpError("Refusing to broadcast a transaction with no destination.", 400, "TX_SHAPE");
  const to = getAddress(parsed.to);
  if (to !== getAddress(expected.to)) throw httpError(`Refusing to broadcast to ${to}.`, 400, "TX_SHAPE");
  if (!isEmptyCalldata(parsed.data)) {
    throw httpError("Refusing to broadcast a transaction that is not a plain native transfer (calldata must be empty).", 400, "TX_SHAPE");
  }
  const value = parsed.value;
  if (value <= 0n) throw httpError("Refusing to broadcast a zero-value transfer.", 400, "BAD_AMOUNT");
  if (value !== expected.value) {
    throw httpError(
      `Refusing to broadcast ${value.toString()} wei; the request amount is ${expected.value.toString()} wei.`,
      400,
      "TX_SHAPE",
    );
  }
  if (!parsed.from) throw httpError("Signed transaction did not recover a sender.", 502, "SIGN_FAILED");
  const from = getAddress(parsed.from);
  if (from !== getAddress(expected.from)) {
    throw httpError(`Signed sender ${from} does not match the fetched wallet ${expected.from}.`, 400, "TX_SHAPE");
  }
  return { from, to, value, data: "0x", chainId };
}

function scrubSecrets(message: string): string {
  let msg = message
    .replace(/-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g, "[REDACTED_PEM]")
    .replace(/wallet-auth:[A-Za-z0-9+/=_-]+/gi, "wallet-auth:[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED_JWT]");
  for (const name of ["TEST_SEND_TOKEN", "PRIVY_APP_SECRET", "PRIVY_AUTH_PRIVATE_KEY", "PRIVY_SIWE_AUTH_PRIVATE_KEY"]) {
    const v = process.env[name]?.trim();
    if (v && v.length >= 6 && msg.includes(v)) msg = msg.split(v).join("[REDACTED]");
    const normalized = name.endsWith("PRIVATE_KEY") ? normalizeAuthKey(v) : null;
    if (normalized && normalized.length >= 6 && msg.includes(normalized)) msg = msg.split(normalized).join("[REDACTED]");
  }
  return msg.length > 16000 ? `${msg.slice(0, 16000)}\n[truncated]` : msg;
}

/** Drop secret-bearing fields. Leave policy text (message, code, error) intact. */
function stripSecretFields(v: unknown, depth = 0): unknown {
  if (depth > 6) return "[depth]";
  if (Array.isArray(v)) return v.map((x) => stripSecretFields(x, depth + 1));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (/secret|password|private|authorization|token|^key$|api_key/i.test(k)) continue;
      out[k] = stripSecretFields(val, depth + 1);
    }
    return out;
  }
  return v;
}

function privyBodyText(body: unknown): string | null {
  if (typeof body === "string") return body.trim() || null;
  if (!body || typeof body !== "object") return null;
  try {
    const raw = JSON.stringify(stripSecretFields(body));
    return raw && raw !== "{}" ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Privy's own text, including a policy denial body. Secret material is removed; the denial wording is not rewritten.
 */
export function testSendFailure(e: unknown): { status: number; code: string | null; message: string } {
  const err = e as any;
  const statusFromUs = Number(err?.statusCode);
  const statusFromPrivy = Number(err?.status);
  const status =
    statusFromUs >= 400 && statusFromUs <= 599 ? statusFromUs : statusFromPrivy >= 400 && statusFromPrivy <= 599 ? statusFromPrivy : 500;
  const code = typeof err?.code === "string" && err.code.length < 80 ? err.code : null;
  let message = typeof err?.message === "string" && err.message.trim() ? err.message : "Test send failed";
  const extra = privyBodyText(err?.error);
  if (extra && !message.includes(extra)) message = `${message}\n${extra}`;
  return { status, code, message: scrubSecrets(message) };
}

/**
 * Authorization context for this probe only. The quorum id is required so a preview missing it fails here,
 * but Privy's context type only accepts the private key (the key is the member of that quorum).
 */
export function siweTestAuthorizationContext(): { authorization_private_keys: [string] } {
  const quorumId = process.env.PRIVY_SIWE_KEY_QUORUM_ID?.trim();
  const raw = process.env.PRIVY_SIWE_AUTH_PRIVATE_KEY?.trim();
  const key = raw ? normalizeAuthKey(raw) : null;
  if (!key || !quorumId) {
    throw httpError(
      "Test send signing is not configured. Set PRIVY_SIWE_AUTH_PRIVATE_KEY and PRIVY_SIWE_KEY_QUORUM_ID. This endpoint does not use PRIVY_AUTH_PRIVATE_KEY.",
      503,
      "TEST_SEND_SIGNING_NOT_CONFIGURED",
    );
  }
  return { authorization_private_keys: [key] };
}

async function signWithSiweKey(
  walletId: string,
  ctx: { authorization_private_keys: [string] },
  tx: {
    to: string;
    value: string;
    nonce: number;
    chainId: number;
    gasLimit: string;
    maxFeePerGas: string;
    maxPriorityFeePerGas: string;
  },
): Promise<string> {
  const res = await getPrivy()
    .wallets()
    .ethereum()
    .signTransaction(walletId, {
      params: {
        transaction: {
          to: tx.to,
          data: "0x",
          value: tx.value,
          nonce: tx.nonce,
          chain_id: tx.chainId,
          gas_limit: tx.gasLimit,
          max_fee_per_gas: tx.maxFeePerGas,
          max_priority_fee_per_gas: tx.maxPriorityFeePerGas,
          type: 2,
        },
      },
      authorization_context: ctx,
    } as any);
  const signed = (res as any)?.signed_transaction;
  if (typeof signed !== "string" || !/^0x[0-9a-fA-F]+$/.test(signed)) {
    throw httpError("Privy did not return a signed transaction.", 502, "SIGN_FAILED");
  }
  return signed;
}

function stampFrom(e: unknown, from: string): never {
  if (e && typeof e === "object") (e as { from?: string }).from ??= from;
  throw e;
}

/**
 * One native transfer on a repo chain. Wallet must be allowlisted. Amount must be a positive decimal.
 * Broadcasts only after the signed transaction matches that request.
 */
export async function runTestNativeSend(header: string | null | undefined, body: unknown): Promise<TestSendResult> {
  assertTestSendToken(header);
  const authorizationContext = siweTestAuthorizationContext();
  const input = parseTestSendBody(body);
  assertWalletAllowed(input.walletId);
  const chain = resolveTestSendChain(input.chainId);
  const valueWei = parseTestSendAmount(input.amount);
  const to = validateDestination(input.destination);

  const wallet: any = await getPrivy().wallets().get(input.walletId);
  if (String(wallet?.id ?? "") !== input.walletId) {
    throw httpError("Privy returned a different wallet than the one requested.", 400, "SOURCE_WALLET");
  }
  const rawAddress = String(wallet?.address ?? "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(rawAddress)) {
    throw httpError("Privy did not return a 20-byte address for the selected wallet.", 400, "SOURCE_ADDRESS");
  }
  const from = getAddress(rawAddress.toLowerCase());

  const pool = getPool(chain);
  let gasLimit: bigint;
  try {
    gasLimit = await pool.read((p) => p.estimateGas({ from, to, value: valueWei, data: "0x" }), "estimateGas");
  } catch (e) {
    const why = await describeTxError(e, { chain, contracts: [to] });
    stampFrom(httpError(`Gas estimate failed: ${why.message}`, 400, "ESTIMATE_FAILED"), from);
  }
  if (gasLimit < 21_000n) gasLimit = 21_000n;
  if (gasLimit > GAS_SANITY_CAP) {
    stampFrom(
      httpError(
        `Gas estimate ${gasLimit.toString()} exceeds the native-transfer sanity cap of ${GAS_SANITY_CAP.toString()}.`,
        400,
        "GAS_CAP",
      ),
      from,
    );
  }

  const [fees, nonce] = await Promise.all([getFees(pool), pool.read((p) => p.getTransactionCount(from, "pending"), "nonce")]);

  let signed: string;
  try {
    signed = await signWithSiweKey(input.walletId, authorizationContext, {
      to,
      value: toQuantity(valueWei),
      nonce,
      chainId: chain.chainId,
      gasLimit: toQuantity(gasLimit),
      maxFeePerGas: toQuantity(fees.maxFeePerGas),
      maxPriorityFeePerGas: toQuantity(fees.maxPriorityFeePerGas),
    });
  } catch (e) {
    stampFrom(e, from);
  }

  const checked = assertSignedNativeTransfer(signed, { from, to, value: valueWei, chainId: chain.chainId });
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
    valueWei: checked.value.toString(),
    valueNative: formatEther(checked.value),
    nativeSymbol: chain.nativeSymbol,
    chainId: chain.chainId,
  };
}
