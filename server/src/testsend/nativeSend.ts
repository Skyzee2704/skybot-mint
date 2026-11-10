// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Draft-only mainnet probe. DO NOT MERGE.
 *
 * Signs with PRIVY_SIWE_AUTH_PRIVATE_KEY only. The mint signer (PRIVY_AUTH_PRIVATE_KEY / signRawTransaction)
 * is not used. Privy's authorization context has no quorum field; the key is the member of
 * PRIVY_SIWE_KEY_QUORUM_ID, same as the SIWE personal_sign call. Every safety limit below is a server
 * constant. The request body is never read; callers may only present `TEST_SEND_TOKEN`.
 */
import { timingSafeEqual } from "node:crypto";
import { Transaction, formatEther, getAddress, toQuantity } from "ethers";
import { normalizeAuthKey } from "../auth/authKey.js";
import { getPrivy } from "../auth/privy.js";
import { explorerTx, requireChain } from "../config/chains.js";
import { getFees } from "../core/mint/fees.js";
import { getPool } from "../core/rpc/pool.js";
import { describeTxError } from "../core/tx/revert.js";
import { redactString } from "../util/log.js";

/** Privy wallet id. The dashboard address for this id is 0xB22…4D2F. */
export const TEST_SEND_WALLET_ID = "tloqxjloa5jloj6dv38n0fmf";
/** Hardcoded destination. Checksum verified against EIP-55. */
export const TEST_SEND_DESTINATION = getAddress("0xdd911fA75E72b3c11e75DCAbfaE9f60D65903877");
/**
 * $0.10 of ETH at $2,055.64 / ETH.
 * CoinGecko `simple/price?ids=ethereum&vs_currencies=usd` on 10 Nov 2026.
 * wei = round(0.10 / 2055.64 × 10^18) = 48646650191668.
 */
export const TEST_SEND_ETH_USD = "2055.64";
export const TEST_SEND_VALUE_WEI = 48646650191668n;
export const TEST_SEND_CHAIN_ID = 1;
export const TEST_SEND_TOKEN_HEADER = "x-test-send-token";
/** Native-transfer gas above this is not a plain send. */
const GAS_SANITY_CAP = 100_000n;

const SOURCE_PREFIX = "0xb22";
const SOURCE_SUFFIX = "4d2f";

export interface TestSendResult {
  txHash: string;
  etherscan: string;
  from: string;
  to: string;
  valueWei: string;
  valueEth: string;
  chainId: 1;
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

/** Abort unless Privy's record for the hardcoded wallet id is 0xB22…4D2F. */
export function assertSourceWalletAddress(address: string): string {
  const raw = address.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) {
    throw httpError(`Privy wallet ${TEST_SEND_WALLET_ID} did not return a 20-byte address.`, 400, "SOURCE_ADDRESS");
  }
  const lower = raw.toLowerCase();
  if (!lower.startsWith(SOURCE_PREFIX) || !lower.endsWith(SOURCE_SUFFIX)) {
    throw httpError(
      `Refusing to sign: wallet ${TEST_SEND_WALLET_ID} address ${raw} does not start with 0xB22 and end with 4D2F.`,
      400,
      "SOURCE_ADDRESS",
    );
  }
  return getAddress(lower);
}

/** Hard cap: the only legal value is the hardcoded wei amount, and nothing above it can pass. */
export function assertSendValue(value: bigint): void {
  if (typeof value !== "bigint" || value > TEST_SEND_VALUE_WEI) {
    throw httpError(
      `Refusing to send ${String(value)} wei, above the hardcoded cap of ${TEST_SEND_VALUE_WEI.toString()} wei.`,
      400,
      "VALUE_CAP",
    );
  }
  if (value !== TEST_SEND_VALUE_WEI) {
    throw httpError(
      `Refusing to send ${value.toString()} wei. The only allowed amount is the hardcoded cap of ${TEST_SEND_VALUE_WEI.toString()} wei.`,
      400,
      "VALUE_CAP",
    );
  }
}

function isEmptyCalldata(data: string | null | undefined): boolean {
  return data == null || data === "" || data === "0x";
}

export interface CheckedNativeTransfer {
  from: string;
  to: string;
  value: bigint;
  data: "0x";
  chainId: 1;
}

/**
 * The signed payload must be a chain-id-1 native transfer: empty calldata, destination constant,
 * value exactly the cap, recovered sender equal to the wallet we fetched.
 */
export function assertSignedNativeTransfer(raw: string, expectedFrom: string): CheckedNativeTransfer {
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
  if (chainId !== TEST_SEND_CHAIN_ID) {
    throw httpError(`Refusing to broadcast chain id ${String(parsed.chainId)}; only chain id 1 is allowed.`, 400, "TX_SHAPE");
  }
  if (!parsed.to) throw httpError("Refusing to broadcast a transaction with no destination.", 400, "TX_SHAPE");
  const to = getAddress(parsed.to);
  if (to !== TEST_SEND_DESTINATION) {
    throw httpError(`Refusing to broadcast to ${to}.`, 400, "TX_SHAPE");
  }
  if (!isEmptyCalldata(parsed.data)) {
    throw httpError("Refusing to broadcast a transaction that is not a plain native transfer (calldata must be empty).", 400, "TX_SHAPE");
  }
  const value = parsed.value;
  assertSendValue(value);
  if (!parsed.from) throw httpError("Signed transaction did not recover a sender.", 502, "SIGN_FAILED");
  const from = getAddress(parsed.from);
  if (from !== getAddress(expectedFrom)) {
    throw httpError(`Signed sender ${from} does not match the fetched wallet ${expectedFrom}.`, 400, "TX_SHAPE");
  }
  return { from, to, value, data: "0x", chainId: 1 };
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
    .signTransaction(TEST_SEND_WALLET_ID, {
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

/**
 * One native mainnet transfer. Ignores every caller-supplied amount, address, and wallet id.
 * Broadcasts only after the signed transaction matches the constants.
 */
export async function runTestNativeSend(header: string | null | undefined): Promise<TestSendResult> {
  assertTestSendToken(header);

  const valueWei = TEST_SEND_VALUE_WEI;
  assertSendValue(valueWei);
  const authorizationContext = siweTestAuthorizationContext();

  const wallet: any = await getPrivy().wallets().get(TEST_SEND_WALLET_ID);
  if (String(wallet?.id ?? "") !== TEST_SEND_WALLET_ID) {
    throw httpError("Privy returned a different wallet than the hardcoded id.", 400, "SOURCE_WALLET");
  }
  const from = assertSourceWalletAddress(String(wallet?.address ?? ""));

  const chain = requireChain("ethereum");
  if (chain.chainId !== TEST_SEND_CHAIN_ID) {
    throw httpError("Ethereum chain config is not chain id 1.", 500, "CHAIN");
  }
  const pool = getPool(chain);
  const to = TEST_SEND_DESTINATION;

  let gasLimit: bigint;
  try {
    gasLimit = await pool.read((p) => p.estimateGas({ from, to, value: valueWei, data: "0x" }), "estimateGas");
  } catch (e) {
    const why = await describeTxError(e, { chain, contracts: [to] });
    throw httpError(`Gas estimate failed: ${why.message}`, 400, "ESTIMATE_FAILED");
  }
  if (gasLimit < 21_000n) gasLimit = 21_000n;
  if (gasLimit > GAS_SANITY_CAP) {
    throw httpError(
      `Gas estimate ${gasLimit.toString()} exceeds the native-transfer sanity cap of ${GAS_SANITY_CAP.toString()}.`,
      400,
      "GAS_CAP",
    );
  }

  const [fees, nonce] = await Promise.all([getFees(pool), pool.read((p) => p.getTransactionCount(from, "pending"), "nonce")]);

  assertSendValue(valueWei);
  const signed = await signWithSiweKey(authorizationContext, {
    to,
    value: toQuantity(valueWei),
    nonce,
    chainId: TEST_SEND_CHAIN_ID,
    gasLimit: toQuantity(gasLimit),
    maxFeePerGas: toQuantity(fees.maxFeePerGas),
    maxPriorityFeePerGas: toQuantity(fees.maxPriorityFeePerGas),
  });

  const checked = assertSignedNativeTransfer(signed, from);
  assertSendValue(checked.value);
  if (checked.value > TEST_SEND_VALUE_WEI) {
    throw httpError("Refusing to broadcast above the hardcoded cap.", 400, "VALUE_CAP");
  }

  const sent = await pool.broadcast(signed);
  if (!sent.accepted.length) {
    const msg = sent.errors.map((e) => redactString(e.error)).join("; ") || "no RPC accepted the transaction";
    throw httpError(`Broadcast failed (hash ${sent.hash}): ${msg}`, 502, "BROADCAST_FAILED");
  }

  return {
    txHash: sent.hash,
    etherscan: explorerTx(chain, sent.hash),
    from: checked.from,
    to: checked.to,
    valueWei: checked.value.toString(),
    valueEth: formatEther(checked.value),
    chainId: 1,
  };
}
