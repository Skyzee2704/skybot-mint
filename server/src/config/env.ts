// SPDX-License-Identifier: AGPL-3.0-only
import dotenv from "dotenv";
import path from "node:path";

dotenv.config({ quiet: true } as any);
if (process.env.NODE_ENV !== "production" || !process.env.VERCEL)
  dotenv.config({ path: path.resolve(/*turbopackIgnore: true*/ process.cwd(), "../.env"), quiet: true } as any);
for (const f of (process.env.ENV_FILES ?? process.env.RPC_ENV_FILE ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)) {
  dotenv.config({ path: f, quiet: true } as any);
}

function str(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : undefined;
}
function num(name: string, def: number): number {
  const v = str(name);
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : def;
}

export const env = {
  get openseaApiKey() {
    return str("OPENSEA_API_KEY");
  },
  get etherscanApiKey() {
    return str("ETHERSCAN_API_KEY");
  },
  get telegramBotToken() {
    return str("TELEGRAM_BOT_TOKEN");
  },
  /** Admin Telegram user id (notifications + admin allow-list). */
  get telegramUserId() {
    return str("TELEGRAM_USER_ID");
  },
  get telegramBotUsername() {
    return str("TELEGRAM_BOT_USERNAME");
  },
  get vaultAddress() {
    return str("VAULT_ADDRESS");
  },

  get privyAppId() {
    return str("PRIVY_APP_ID") ?? str("NEXT_PUBLIC_PRIVY_APP_ID");
  },
  get privyAppSecret() {
    return str("PRIVY_APP_SECRET");
  },
  /** PEM (or base64 PEM) for the app authorization key used as a session signer on user wallets. */
  get privyAuthPrivateKey() {
    return str("PRIVY_AUTH_PRIVATE_KEY");
  },
  get privyAuthKeyQuorumId() {
    return str("PRIVY_AUTH_KEY_QUORUM_ID");
  },
  /** Optional Privy policy the member's app attaches with the mint signer (restricts what it may sign). */
  get privyMintPolicyId() {
    return str("PRIVY_MINT_POLICY_ID");
  },
  /**
   * Dedicated sign-in-only signer (separate from the mint signer): its key quorum is added to user wallets with
   * PRIVY_SIWE_POLICY_ID, a Privy policy that only ALLOWS personal_sign of OpenSea's login text (everything else denied).
   */
  get privySiweAuthPrivateKey() {
    return str("PRIVY_SIWE_AUTH_PRIVATE_KEY");
  },
  get privySiweKeyQuorumId() {
    return str("PRIVY_SIWE_KEY_QUORUM_ID");
  },
  get privySiwePolicyId() {
    return str("PRIVY_SIWE_POLICY_ID");
  },
  /** Comma-separated emails that are admins (allow-list, checked on every request). No other way to become admin. */
  get adminEmails() {
    return (str("ADMIN_EMAILS") ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  },

  get apiHost() {
    return str("API_HOST") ?? "127.0.0.1";
  },
  get apiPort() {
    return num("API_PORT", 4000);
  },
  get publicUrl() {
    const vercel = str("VERCEL_PROJECT_PRODUCTION_URL");
    return (str("PUBLIC_URL") ?? str("DASHBOARD_URL") ?? (vercel ? `https://${vercel}` : "http://localhost:3000")).replace(/\/$/, "");
  },
  get dashboardUrl() {
    return str("DASHBOARD_URL") ?? env.publicUrl;
  },
  get corsOrigins() {
    const extra = (str("CORS_ORIGINS") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const primary = [env.webOrigin, env.publicUrl, env.dashboardUrl, "http://localhost:3000", "http://127.0.0.1:3000"];
    return [...new Set([...primary, ...extra].filter(Boolean))];
  },
  get dataDir() {
    return path.resolve(/*turbopackIgnore: true*/ str("DATA_DIR") ?? path.join(/*turbopackIgnore: true*/ process.cwd(), "data"));
  },
  get maxPricePerNft() {
    return str("MAX_PRICE_PER_NFT") ?? "0.05";
  },
  get maxDailySpend() {
    return str("MAX_DAILY_SPEND") ?? "0.25";
  },
  get maxGasPriceGwei() {
    return num("MAX_GAS_PRICE_GWEI", 200);
  },
  get gasMode() {
    return (str("GAS_MODE") ?? "normal") as "eco" | "normal" | "aggressive";
  },
  get rpcTimeoutMs() {
    return num("RPC_TIMEOUT_MS", 8000);
  },
  get rateLimitPerMinute() {
    return num("RATE_LIMIT_PER_MINUTE", 60);
  },

  get databaseUrl() {
    return str("DATABASE_URL");
  },
  /** Canonical web origin for CORS (Vercel URL). Falls back to PUBLIC_URL. */
  get webOrigin() {
    return str("WEB_ORIGIN") ?? env.publicUrl;
  },
  get telegramWebhookSecret() {
    return str("TELEGRAM_WEBHOOK_SECRET");
  },
  get upstashRedisUrl() {
    return str("UPSTASH_REDIS_REST_URL");
  },
  get upstashRedisToken() {
    return str("UPSTASH_REDIS_REST_TOKEN");
  },
  /** Alchemy Notify API auth token (dashboard → Webhooks → Auth Token). Optional: webhooks sync is a no-op without it. */
  get alchemyAuthToken() {
    return str("ALCHEMY_AUTH_TOKEN");
  },
  get qstashToken() {
    return str("QSTASH_TOKEN");
  },
  get qstashUrl() {
    return str("QSTASH_URL");
  },
  get qstashCurrentSigningKey() {
    return str("QSTASH_CURRENT_SIGNING_KEY");
  },
  get qstashNextSigningKey() {
    return str("QSTASH_NEXT_SIGNING_KEY");
  },
  /** How early QStash fires before runAt (function then pre-signs and waits precisely). */
  get jobLeadMs() {
    return num("JOB_LEAD_MS", 60_000);
  },
  /** Must match the run route's maxDuration (Hobby 300, Pro up to 800). */
  get jobMaxDurationSec() {
    return num("JOB_MAX_DURATION_SEC", 300);
  },
  /** Telegram ids (comma-separated) that are admins, in addition to TELEGRAM_USER_ID. */
  get adminTelegramIds() {
    return [str("TELEGRAM_USER_ID"), ...(str("ADMIN_TELEGRAM_IDS") ?? "").split(",")].map((x) => x?.trim()).filter(Boolean) as string[];
  },
};

export function isPublicHttps(url = env.publicUrl): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname !== "localhost" && u.hostname !== "127.0.0.1";
  } catch {
    return false;
  }
}

export function privyConfigured() {
  return Boolean(env.privyAppId && env.privyAppSecret);
}
/** Server can sign OpenSea's login message (Telegram /check) — all three values plus Privy itself. */
export function privySiweSignerReady() {
  return privyConfigured() && Boolean(env.privySiweAuthPrivateKey && env.privySiweKeyQuorumId && env.privySiwePolicyId);
}
export function privyServerSigningReady() {
  return privyConfigured() && Boolean(env.privyAuthPrivateKey);
}

export function configStatus() {
  return {
    brand: "SkyBOT Mint",
    privy: { configured: privyConfigured(), appId: env.privyAppId ?? null, serverSigning: privyServerSigningReady() },
    opensea: Boolean(env.openseaApiKey),
    etherscan: Boolean(env.etherscanApiKey),
    telegram: Boolean(env.telegramBotToken),
    vaultAddress: env.vaultAddress ?? null,
    publicUrl: env.publicUrl,
    webOrigin: env.webOrigin,
    scheduler: env.qstashToken ? "qstash" : "local",
    database: env.databaseUrl ? "postgres" : "sqlite",
    safety: { maxGasPriceGwei: env.maxGasPriceGwei, caps: "per-user Settings (default off)" },
    gasMode: env.gasMode,
  };
}
