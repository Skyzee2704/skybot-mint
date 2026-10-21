import dotenv from "dotenv";
import path from "node:path";

dotenv.config({ quiet: true } as any);
dotenv.config({ path: path.resolve(process.cwd(), "../.env"), quiet: true } as any);
for (const f of (process.env.ENV_FILES ?? process.env.RPC_ENV_FILE ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
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
  get openseaApiKey() { return str("OPENSEA_API_KEY"); },
  get etherscanApiKey() { return str("ETHERSCAN_API_KEY"); },
  get telegramBotToken() { return str("TELEGRAM_BOT_TOKEN"); },
  /** Admin Telegram user id (notifications + admin role mapping). Not an access restriction. */
  get telegramUserId() { return str("TELEGRAM_USER_ID"); },
  get telegramBotUsername() { return str("TELEGRAM_BOT_USERNAME"); },
  get vaultAddress() { return str("VAULT_ADDRESS"); },

  get privyAppId() { return str("PRIVY_APP_ID"); },
  get privyAppSecret() { return str("PRIVY_APP_SECRET"); },
  /** PEM (or base64 PEM) for the app authorization key used as a session signer on user wallets. */
  get privyAuthPrivateKey() { return str("PRIVY_AUTH_PRIVATE_KEY"); },
  get privyAuthKeyQuorumId() { return str("PRIVY_AUTH_KEY_QUORUM_ID"); },
  /** Comma-separated emails that become admins on first login. First user is also admin. */
  get adminEmails() { return (str("ADMIN_EMAILS") ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean); },

  get apiHost() { return str("API_HOST") ?? "127.0.0.1"; },
  get apiPort() { return num("API_PORT", 4000); },
  get publicUrl() { return str("PUBLIC_URL") ?? str("DASHBOARD_URL") ?? "http://localhost:3000"; },
  get dashboardUrl() { return str("DASHBOARD_URL") ?? env.publicUrl; },
  get corsOrigins() {
    const extra = (str("CORS_ORIGINS") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const primary = [env.webOrigin, env.publicUrl, env.dashboardUrl, "http://localhost:3000", "http://127.0.0.1:3000"];
    return [...new Set([...primary, ...extra].filter(Boolean))];
  },
  get dataDir() { return path.resolve(str("DATA_DIR") ?? path.join(process.cwd(), "data")); },
  get maxPricePerNft() { return str("MAX_PRICE_PER_NFT") ?? "0.05"; },
  get maxDailySpend() { return str("MAX_DAILY_SPEND") ?? "0.25"; },
  get maxGasPriceGwei() { return num("MAX_GAS_PRICE_GWEI", 200); },
  get gasMode() { return (str("GAS_MODE") ?? "normal") as "eco" | "normal" | "aggressive"; },
  get rpcTimeoutMs() { return num("RPC_TIMEOUT_MS", 8000); },
  get rateLimitPerMinute() { return num("RATE_LIMIT_PER_MINUTE", 60); },

  get databaseUrl() { return str("DATABASE_URL"); },
  /** Canonical web origin for CORS (Vercel URL). Falls back to PUBLIC_URL. */
  get webOrigin() { return str("WEB_ORIGIN") ?? env.publicUrl; },
  /** Public API base (Railway/Render). When set, Telegram uses webhook mode. */
  get publicApiUrl() { return str("PUBLIC_API_URL"); },
  get telegramWebhookSecret() { return str("TELEGRAM_WEBHOOK_SECRET"); },
};

export function isPublicHttps(url = env.publicUrl): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname !== "localhost" && u.hostname !== "127.0.0.1";
  } catch { return false; }
}


export function privyConfigured() {
  return Boolean(env.privyAppId && env.privyAppSecret);
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
    publicApiUrl: env.publicApiUrl ?? null,
    database: env.databaseUrl ? "postgres" : "sqlite",
    safety: { maxGasPriceGwei: env.maxGasPriceGwei, caps: "per-user Settings (default off)" },
    gasMode: env.gasMode,
  };
}
