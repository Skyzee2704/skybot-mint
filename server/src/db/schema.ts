// SPDX-License-Identifier: AGPL-3.0-only
import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";

/** Multi-user SkyBOT Mint schema. All user-owned rows carry userId. */
export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    privyUserId: text("privy_user_id").notNull().unique(),
    email: text("email"),
    name: text("name"),
    role: text("role").notNull().default("user"),
    /** IANA timezone reported by the user's browser (auto-saved); used for Telegram messages. */
    timezone: text("timezone"),
    disabled: integer("disabled", { mode: "boolean" }).notNull().default(false),
    telegramUserId: text("telegram_user_id").unique(),
    telegramUsername: text("telegram_username"),
    createdAt: text("created_at").notNull(),
    lastSeenAt: text("last_seen_at").notNull(),
  },
  (t) => [index("users_email_idx").on(t.email)],
);

export const wallets = sqliteTable(
  "wallets",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    privyWalletId: text("privy_wallet_id"),
    address: text("address").notNull(),
    label: text("label").notNull().default(""),
    /** Retired (wallet groups were removed from the app on 2026-10-22). Kept so existing databases stay valid. */
    groupName: text("group_name"),
    source: text("source").notNull(),
    hdIndex: integer("hd_index"),
    isMain: integer("is_main", { mode: "boolean" }).notNull().default(false),
    createdAt: text("created_at").notNull(),
    /** Soft delete: hidden from SkyBOT (lists, sync, eligibility, mint, withdraw). Privy custody is untouched. */
    removedAt: text("removed_at"),
  },
  (t) => [uniqueIndex("wallets_user_addr").on(t.userId, t.address), index("wallets_user_idx").on(t.userId)],
);

/** Retired: wallet groups were removed from the app (2026-10-22). Table kept, unused, so existing data is safe. */
export const groups = sqliteTable(
  "groups",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [uniqueIndex("groups_user_name").on(t.userId, t.name)],
);

export const jobs = sqliteTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: text("created_at").notNull(),
    status: text("status").notNull(),
    runAt: text("run_at"),
    chain: text("chain").notNull(),
    target: text("target").notNull(),
    strategy: text("strategy").notNull(),
    requestJson: text("request_json").notNull(),
    resultsJson: text("results_json").notNull().default("[]"),
    error: text("error"),
    logJson: text("log_json").notNull().default("[]"),
  },
  (t) => [index("jobs_user_idx").on(t.userId), index("jobs_status_idx").on(t.status)],
);

export const settings = sqliteTable("settings", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  priceCapEnabled: integer("price_cap_enabled", { mode: "boolean" }).notNull().default(false),
  dailyCapEnabled: integer("daily_cap_enabled", { mode: "boolean" }).notNull().default(false),
  openseaWalletLogin: integer("opensea_wallet_login", { mode: "boolean" }).notNull().default(false),
  capsJson: text("caps_json").notNull().default("{}"),
});

export const spend = sqliteTable(
  "spend",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    day: text("day").notNull(),
    chain: text("chain").notNull(),
    wei: text("wei").notNull(),
    at: text("at").notNull(),
    ref: text("ref").notNull(),
  },
  (t) => [index("spend_user_day").on(t.userId, t.day, t.chain)],
);

export const minted = sqliteTable(
  "minted",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    chain: text("chain").notNull(),
    contract: text("contract").notNull(),
    wallet: text("wallet").notNull(),
    tokenIdsJson: text("token_ids_json").notNull(),
    txHash: text("tx_hash").notNull(),
    at: text("at").notNull(),
  },
  (t) => [index("minted_user_idx").on(t.userId)],
);

export const telegramLinks = sqliteTable("telegram_links", {
  /** For web→TG: real user id. For TG→web reverse: "pending:<telegramUserId>". No FK — pending rows are not users. */
  code: text("code").primaryKey(),
  userId: text("user_id").notNull(),
  expiresAt: text("expires_at").notNull(),
  /** Optional JSON: { telegramUsername?: string } for reverse codes. */
  metaJson: text("meta_json").notNull().default("{}"),
});

export const rateBuckets = sqliteTable("rate_buckets", {
  key: text("key").primaryKey(),
  count: integer("count").notNull().default(0),
  windowStart: integer("window_start").notNull(),
});

/** Security-relevant actions (withdrawals, admin actions). Never contains keys or tokens. */
export const auditLog = sqliteTable(
  "audit_log",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    at: text("at").notNull(),
    action: text("action").notNull(),
    chain: text("chain"),
    target: text("target"),
    detailJson: text("detail_json").notNull().default("{}"),
  },
  (t) => [index("audit_user_idx").on(t.userId, t.action)],
);

/** Last OpenSea eligibility-API verdicts per wallet + drop (so /check and later visits don't need a new sign-in). */
export const openseaVerdicts = sqliteTable(
  "opensea_verdicts",
  {
    id: text("id").primaryKey(), // `${walletId}:${slug}`
    userId: text("user_id").notNull(),
    walletId: text("wallet_id").notNull(),
    slug: text("slug").notNull(),
    stagesJson: text("stages_json").notNull(),
    checkedAt: text("checked_at").notNull(),
  },
  (t) => [index("osv_user_slug").on(t.userId, t.slug)],
);

/** Wallets permanently removed (archived in Privy + deleted here). Sync never re-adds these addresses. */
export const walletTombstones = sqliteTable(
  "wallet_tombstones",
  {
    id: text("id").primaryKey(), // `${userId}:${address}`
    userId: text("user_id").notNull(),
    address: text("address").notNull(),
    privyWalletId: text("privy_wallet_id"),
    removedAt: text("removed_at").notNull(),
  },
  (t) => [index("wallet_tombstones_user").on(t.userId)],
);

/** OpenSea read:eligibility JWT per wallet (encrypted). Lets repeat checks skip re-signing. */
export const openseaTokens = sqliteTable("opensea_tokens", {
  id: text("id").primaryKey(), // lower-case wallet address
  userId: text("user_id").notNull(),
  tokenEnc: text("token_enc").notNull(),
  expiresAt: text("expires_at").notNull(),
});

/** OpenSea scoped PAT (read:eligibility only, encrypted) per wallet: mints new wallet JWTs without a signature. */
export const openseaPats = sqliteTable("opensea_pats", {
  id: text("id").primaryKey(), // lower-case wallet address
  userId: text("user_id").notNull(),
  patEnc: text("pat_enc").notNull(),
  expiresAt: text("expires_at").notNull(),
});

/**
 * Cached NFT holdings per wallet × chain (from an NFT indexer, never per-token RPC scans).
 * The NFTs page reads only from here; scans run on first use, on manual Refresh (cooldown) or after a send.
 */
export const nftHoldings = sqliteTable(
  "nft_holdings",
  {
    id: text("id").primaryKey(), // `${walletId}:${chain}`
    userId: text("user_id").notNull(),
    walletId: text("wallet_id").notNull(),
    chain: text("chain").notNull(),
    address: text("address").notNull(),
    itemsJson: text("items_json").notNull().default("[]"),
    source: text("source"),
    error: text("error"),
    truncated: integer("truncated").notNull().default(0),
    scannedAt: text("scanned_at").notNull(),
  },
  (t) => [index("nft_holdings_user").on(t.userId)],
);

/** Wallet × chain pairs holding tokens that still look unrevealed: housekeeping re-checks their token URIs at dueAt. */
export const nftMetaDue = sqliteTable("nft_meta_due", {
  id: text("id").primaryKey(), // `${walletId}:${chain}`
  userId: text("user_id").notNull(),
  walletId: text("wallet_id").notNull(),
  chain: text("chain").notNull(),
  dueAt: integer("due_at").notNull(),
});

/** Last full manual holdings refresh per user (cooldown shared by every serverless instance). */
export const nftScanState = sqliteTable("nft_scan_state", {
  userId: text("user_id").primaryKey(),
  lastRefreshAt: integer("last_refresh_at").notNull(),
});

/** Sign-in-only signer (OpenSea SIWE) status per wallet: attachedAt set once Privy lists the quorum on the wallet. */
export const siweSigners = sqliteTable("siwe_signers", {
  walletId: text("wallet_id").primaryKey(),
  attachedAt: text("attached_at"),
  checkedAt: text("checked_at").notNull(),
  /** Short reason when not attached (e.g. "owner authorization needed"). */
  note: text("note"),
});

/** One Alchemy Address Activity webhook per network (signing key AES-GCM encrypted, never returned by the API). */
export const alchemyWebhooks = sqliteTable("alchemy_webhooks", {
  network: text("network").primaryKey(), // e.g. BASE_MAINNET
  webhookId: text("webhook_id"),
  signingKeyEnc: text("signing_key_enc"),
  addressHash: text("address_hash"),
  addressCount: integer("address_count").notNull().default(0),
  syncedAt: text("synced_at").notNull(),
  error: text("error"),
});

/** Last on-chain activity seen (Alchemy webhook) per chain × address; newer than a cached balance = refetch. */
export const walletActivity = sqliteTable("wallet_activity", {
  id: text("id").primaryKey(), // `${chain}:${lower-case address}`
  chain: text("chain").notNull(),
  address: text("address").notNull(),
  at: integer("at").notNull(), // ms
  kinds: text("kinds").notNull().default(""),
});

/** Debounced NFT holdings re-scans (one row per wallet × chain) queued by webhooks. */
export const nftRescanQueue = sqliteTable("nft_rescan_queue", {
  id: text("id").primaryKey(), // `${walletId}:${chain}`
  userId: text("user_id").notNull(),
  walletId: text("wallet_id").notNull(),
  chain: text("chain").notNull(),
  address: text("address").notNull(),
  dueAt: integer("due_at").notNull(), // ms
  pass: integer("pass").notNull().default(1),
});
