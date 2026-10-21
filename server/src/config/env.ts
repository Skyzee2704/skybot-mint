import dotenv from "dotenv";
import path from "node:path";

// Load .env, then any extra env files (e.g. ENV_FILES=/workspace/secrets/rpc.env). Existing vars win.
dotenv.config({ quiet: true } as any); // server/.env
dotenv.config({ path: path.resolve(process.cwd(), "../.env"), quiet: true } as any); // repo-root .env
for (const f of (process.env.ENV_FILES ?? process.env.RPC_ENV_FILE ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
  dotenv.config({ path: f, quiet: true } as any);
}

/** All runtime config comes from process.env; every value is optional with a safe default. */
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
  get telegramUserId() { return str("TELEGRAM_USER_ID"); },
  get vaultAddress() { return str("VAULT_ADDRESS"); },
  get apiHost() { return str("API_HOST") ?? "127.0.0.1"; },
  get apiPort() { return num("API_PORT", 4000); },
  get dashboardUrl() { return str("DASHBOARD_URL") ?? "http://localhost:3000"; },
  get dataDir() { return path.resolve(str("DATA_DIR") ?? path.join(process.cwd(), "data")); },
  get sessionTtlMinutes() { return num("SESSION_TTL_MINUTES", 240); },
  /** Safety caps (native units, e.g. ETH). Per-chain overrides live in chains.ts. */
  get maxPricePerNft() { return str("MAX_PRICE_PER_NFT") ?? "0.05"; },
  get maxDailySpend() { return str("MAX_DAILY_SPEND") ?? "0.25"; },
  get maxGasPriceGwei() { return num("MAX_GAS_PRICE_GWEI", 200); },
  get gasMode() { return (str("GAS_MODE") ?? "normal") as "eco" | "normal" | "aggressive"; },
  get rpcTimeoutMs() { return num("RPC_TIMEOUT_MS", 8000); },
  get scryptN() { return num("KEYSTORE_SCRYPT_N", 2 ** 17); },
};

export function configStatus() {
  return {
    opensea: Boolean(env.openseaApiKey),
    etherscan: Boolean(env.etherscanApiKey),
    telegram: Boolean(env.telegramBotToken && env.telegramUserId),
    vaultAddress: env.vaultAddress ?? null,
    safety: { maxGasPriceGwei: env.maxGasPriceGwei, caps: "see Settings (default off)" },
    gasMode: env.gasMode,
  };
}
