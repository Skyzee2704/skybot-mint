// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Privy server client.
 * Custody model: user wallets live in Privy. SkyBOT never stores raw private keys.
 * Server signing uses an app authorization key (session signer) + Privy policies.
 * Private-key import must happen client-side via Privy React (`importWallet`) —
 * the server import helper is disabled unless ALLOW_SERVER_KEY_IMPORT=1 (dev only).
 */
import { PrivyClient } from "@privy-io/node";
import { env, privyConfigured, privyServerSigningReady } from "../config/env.js";
import { log } from "../util/log.js";

let client: PrivyClient | null = null;

export function getPrivy(): PrivyClient {
  if (!privyConfigured())
    throw Object.assign(new Error("Privy is not configured. Set PRIVY_APP_ID and PRIVY_APP_SECRET."), {
      statusCode: 503,
      code: "PRIVY_NOT_CONFIGURED",
    });
  if (!client) {
    client = new PrivyClient({ appId: env.privyAppId!, appSecret: env.privyAppSecret! });
    log.info("Privy client initialized");
  }
  return client;
}

export interface VerifiedPrivyUser {
  privyUserId: string;
  sessionId?: string;
  appId: string;
}

/** Verify a Privy access token. Never logs the token. */
export async function verifyPrivyAccessToken(accessToken: string): Promise<VerifiedPrivyUser> {
  const privy = getPrivy();
  const claims = await privy.utils().auth().verifyAccessToken(accessToken);
  return { privyUserId: claims.user_id, sessionId: (claims as any).session_id, appId: claims.app_id };
}

export function authContext() {
  if (!privyServerSigningReady()) return undefined;
  return { authorization_private_keys: [env.privyAuthPrivateKey!] };
}

/** Create N ethereum wallets owned by a Privy user (server wallets API — keys stay in Privy). */
export async function createPrivyWallets(privyUserId: string, count: number) {
  const privy = getPrivy();
  const out: { id: string; address: string }[] = [];
  for (let i = 0; i < count; i++) {
    const w = await privy.wallets().create({ chain_type: "ethereum", owner: { user_id: privyUserId } });
    out.push({ id: w.id, address: w.address });
  }
  return out;
}

/**
 * @deprecated Prefer client-side Privy `importWallet`. Disabled in production.
 * Only enabled when ALLOW_SERVER_KEY_IMPORT=1 AND NODE_ENV !== production.
 */
export async function importPrivyWallet(_privyUserId: string, _privateKey: string): Promise<{ id: string; address: string }> {
  const allow = process.env.ALLOW_SERVER_KEY_IMPORT === "1" && process.env.NODE_ENV !== "production";
  if (!allow) {
    throw Object.assign(
      new Error("Server-side private key import is disabled. Use Privy importWallet in the browser — keys never touch SkyBOT."),
      { statusCode: 403, code: "KEY_IMPORT_CLIENT_ONLY" },
    );
  }
  throw Object.assign(new Error("Server key import path removed for security. Use client Privy importWallet."), {
    statusCode: 403,
    code: "KEY_IMPORT_REMOVED",
  });
}

/** Sign a raw EIP-1559 tx via Privy session signer. Broadcast stays on our RPC pool. */
export async function signRawTransaction(
  privyWalletId: string,
  tx: {
    to: string;
    data?: string;
    value?: string;
    nonce: number;
    chainId: number;
    gasLimit: string;
    maxFeePerGas: string;
    maxPriorityFeePerGas: string;
  },
) {
  const privy = getPrivy();
  const ctx = authContext();
  if (!ctx)
    throw Object.assign(
      new Error(
        "Server signing not configured — set PRIVY_AUTH_PRIVATE_KEY and add the app authorization key as a session signer on user wallets.",
      ),
      { statusCode: 503, code: "PRIVY_SIGNING_NOT_CONFIGURED" },
    );
  // Defense in depth: refuse approve / transfer selectors even if caller messed up
  const data = (tx.data ?? "0x").toLowerCase();
  const sel = data.slice(0, 10);
  const DENY = new Set([
    "0x095ea7b3",
    "0xa22cb465",
    "0xa9059cbb",
    "0x23b872dd",
    "0x42842e0e",
    "0xb88d4fde",
    "0xf242432a",
    "0x2eb2c2d6",
    "0x87517c45",
    "0xf2fde38b",
  ]);
  if (DENY.has(sel)) {
    throw Object.assign(new Error(`Refusing to sign dangerous selector ${sel}`), { statusCode: 400, code: "POLICY_DENY_SELECTOR" });
  }
  const res = await privy
    .wallets()
    .ethereum()
    .signTransaction(privyWalletId, {
      params: {
        transaction: {
          to: tx.to,
          data: tx.data,
          value: tx.value ?? "0x0",
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
  return (res as any).signed_transaction as string;
}

export { privyConfigured, privyServerSigningReady };
