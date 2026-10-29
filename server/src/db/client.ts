// SPDX-License-Identifier: AGPL-3.0-only
/**
 * DB modes:
 *  - postgres (Neon serverless HTTP driver) when DATABASE_URL=postgres(ql)://…  ← Vercel
 *  - pglite (in-process Postgres) when DATABASE_URL=pglite:memory              ← tests of the PG path
 *  - sqlite (libsql file under DATA_DIR) otherwise                              ← local dev
 * One SQLite-shaped drizzle schema; columns are TEXT/INTEGER so the same SQL works on Postgres.
 * Migrations are idempotent and run once per process (guarded promise), or via `npm run db:migrate`.
 */
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import * as schema from "./schema.js";
import fs from "node:fs";
import path from "node:path";
import { env } from "../config/env.js";

export type AppDb = LibSQLDatabase<typeof schema>;
type Mode = "sqlite" | "postgres" | "pglite";

let db: AppDb | null = null;
let mode: Mode = "sqlite";
let exec: ((sql: string) => Promise<unknown>) | null = null;
let ready: Promise<void> | null = null;
let initP: Promise<AppDb> | null = null;

export function dbMode(): Mode {
  const url = env.databaseUrl ?? "";
  if (url.startsWith("pglite:")) return "pglite";
  if (/^postgres(ql)?:\/\//.test(url)) return "postgres";
  return "sqlite";
}

async function init(): Promise<AppDb> {
  mode = dbMode();
  const url = env.databaseUrl ?? "";
  if (mode === "postgres") {
    const { neon } = await import("@neondatabase/serverless");
    const { drizzle } = await import("drizzle-orm/neon-http");
    const sql = neon(url);
    exec = (s) => sql.query(s);
    db = drizzle(sql, { schema }) as unknown as AppDb;
  } else if (mode === "pglite") {
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    const pg = new PGlite();
    exec = (s) => pg.exec(s);
    db = drizzle(pg, { schema }) as unknown as AppDb;
  } else {
    if (process.env.VERCEL) {
      throw new Error("DATABASE_URL (Neon Postgres) is required on Vercel — SQLite is for local development only.");
    }
    const { createClient } = await import("@libsql/client");
    const { drizzle } = await import("drizzle-orm/libsql");
    fs.mkdirSync(env.dataDir, { recursive: true, mode: 0o700 });
    const client = createClient({ url: `file:${path.join(env.dataDir, "skybot.db")}` });
    exec = (s) => client.executeMultiple(s);
    db = drizzle(client, { schema });
  }
  return db!;
}

/** Use everywhere: resolves to a migrated DB handle. */
export async function ensureDb(): Promise<AppDb> {
  initP ??= init();
  const d = await initP;
  ready ??= migrate().catch((e) => {
    ready = null;
    throw e;
  });
  await ready;
  return d;
}

/**
 * Sync accessor kept for existing call sites: returns a proxy that awaits ensureDb() on first use.
 * Every drizzle builder chain starts with select/insert/update/delete, so we forward those lazily.
 */
export function getDb(): AppDb {
  if (db && ready) return db;
  const lazy =
    (method: string) =>
    (...args: any[]) =>
      deferredBuilder(method, args);
  return new Proxy({} as AppDb, { get: (_t, prop: string) => lazy(prop) });
}

/** A thenable that replays a builder chain once the DB is ready. */
function deferredBuilder(first: string, firstArgs: any[]): any {
  const calls: [string, any[]][] = [[first, firstArgs]];
  const p: any = new Proxy(function () {}, {
    get(_t, prop: string) {
      if (prop === "then") {
        return (res: any, rej: any) =>
          ensureDb()
            .then((d) => {
              let cur: any = d;
              for (const [m, a] of calls) cur = cur[m](...a);
              return cur;
            })
            .then(res, rej);
      }
      return (...args: any[]) => {
        calls.push([prop, args]);
        return p;
      };
    },
  });
  return p;
}

const DDL = [
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, privy_user_id TEXT NOT NULL UNIQUE, email TEXT, name TEXT,
    role TEXT NOT NULL DEFAULT 'user', disabled INTEGER NOT NULL DEFAULT 0,
    telegram_user_id TEXT UNIQUE, telegram_username TEXT,
    created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS users_email_idx ON users(email)`,
  `CREATE TABLE IF NOT EXISTS wallets (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    privy_wallet_id TEXT, address TEXT NOT NULL, label TEXT NOT NULL DEFAULT '',
    group_name TEXT, source TEXT NOT NULL, hd_index INTEGER, is_main INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, UNIQUE(user_id, address))`,
  `CREATE INDEX IF NOT EXISTS wallets_user_idx ON wallets(user_id)`,
  `CREATE TABLE IF NOT EXISTS groups (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(user_id, name))`,
  `CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL, status TEXT NOT NULL, run_at TEXT, started_at TEXT, chain TEXT NOT NULL,
    target TEXT NOT NULL, strategy TEXT NOT NULL, request_json TEXT NOT NULL,
    results_json TEXT NOT NULL DEFAULT '[]', error TEXT, log_json TEXT NOT NULL DEFAULT '[]')`,
  `CREATE INDEX IF NOT EXISTS jobs_user_idx ON jobs(user_id)`,
  `CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs(status)`,
  `CREATE TABLE IF NOT EXISTS settings (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    price_cap_enabled INTEGER NOT NULL DEFAULT 0, daily_cap_enabled INTEGER NOT NULL DEFAULT 0,
    opensea_wallet_login INTEGER NOT NULL DEFAULT 0, caps_json TEXT NOT NULL DEFAULT '{}')`,
  `CREATE TABLE IF NOT EXISTS spend (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    day TEXT NOT NULL, chain TEXT NOT NULL, wei TEXT NOT NULL, at TEXT NOT NULL, ref TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS spend_user_day ON spend(user_id, day, chain)`,
  `CREATE TABLE IF NOT EXISTS minted (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    chain TEXT NOT NULL, contract TEXT NOT NULL, wallet TEXT NOT NULL,
    token_ids_json TEXT NOT NULL, tx_hash TEXT NOT NULL, at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS minted_user_idx ON minted(user_id)`,
  `CREATE TABLE IF NOT EXISTS telegram_links (
    code TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at TEXT NOT NULL, meta_json TEXT NOT NULL DEFAULT '{}')`,
  `CREATE TABLE IF NOT EXISTS audit_log (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, at TEXT NOT NULL, action TEXT NOT NULL,
    chain TEXT, target TEXT, detail_json TEXT NOT NULL DEFAULT '{}')`,
  `CREATE INDEX IF NOT EXISTS audit_user_idx ON audit_log(user_id, action)`,
  `CREATE TABLE IF NOT EXISTS opensea_verdicts (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, wallet_id TEXT NOT NULL, slug TEXT NOT NULL,
    stages_json TEXT NOT NULL, checked_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS osv_user_slug ON opensea_verdicts(user_id, slug)`,
  `CREATE TABLE IF NOT EXISTS wallet_tombstones (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, address TEXT NOT NULL, privy_wallet_id TEXT, removed_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS wallet_tombstones_user ON wallet_tombstones(user_id)`,
  `CREATE TABLE IF NOT EXISTS opensea_tokens (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, token_enc TEXT NOT NULL, expires_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS opensea_pats (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, pat_enc TEXT NOT NULL, expires_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS nft_holdings (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, wallet_id TEXT NOT NULL, chain TEXT NOT NULL, address TEXT NOT NULL,
    items_json TEXT NOT NULL DEFAULT '[]', source TEXT, error TEXT, truncated INTEGER NOT NULL DEFAULT 0, scanned_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS nft_holdings_user ON nft_holdings(user_id)`,
  `CREATE TABLE IF NOT EXISTS nft_scan_state (user_id TEXT PRIMARY KEY, last_refresh_at BIGINT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS rate_buckets (
    key TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0, window_start INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS alchemy_webhooks (network TEXT PRIMARY KEY, webhook_id TEXT, signing_key_enc TEXT,
    address_hash TEXT, address_count INTEGER NOT NULL DEFAULT 0, synced_at TEXT NOT NULL, error TEXT)`,
  `CREATE TABLE IF NOT EXISTS wallet_activity (id TEXT PRIMARY KEY, chain TEXT NOT NULL, address TEXT NOT NULL,
    at BIGINT NOT NULL, kinds TEXT NOT NULL DEFAULT '')`,
  `CREATE TABLE IF NOT EXISTS nft_rescan_queue (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, wallet_id TEXT NOT NULL,
    chain TEXT NOT NULL, address TEXT NOT NULL, due_at BIGINT NOT NULL, pass INTEGER NOT NULL DEFAULT 1)`,
  `CREATE TABLE IF NOT EXISTS nft_meta_due (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, wallet_id TEXT NOT NULL,
    chain TEXT NOT NULL, due_at BIGINT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS siwe_signers (wallet_id TEXT PRIMARY KEY, attached_at TEXT, checked_at TEXT NOT NULL, note TEXT)`,
  `CREATE TABLE IF NOT EXISTS mint_signers (wallet_id TEXT PRIMARY KEY, attached_at TEXT, checked_at TEXT NOT NULL, note TEXT)`,
  `CREATE TABLE IF NOT EXISTS plans (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL,
    created_at TEXT NOT NULL, expires_at TEXT NOT NULL, data_json TEXT NOT NULL, confirm_phrase TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS plans_user_idx ON plans(user_id)`,
  `CREATE INDEX IF NOT EXISTS plans_expires_idx ON plans(expires_at)`,
];

async function migrate() {
  if (mode === "sqlite") {
    await exec!(DDL.join(";\n") + ";");
    // legacy local DBs: telegram_links without meta_json / with FK
    const { createClient } = await import("@libsql/client");
    const c = createClient({ url: `file:${path.join(env.dataDir, "skybot.db")}` });
    const cols = await c.execute("PRAGMA table_info(telegram_links)");
    if (!cols.rows.some((r: any) => r.name === "meta_json")) {
      await c.executeMultiple(`PRAGMA foreign_keys=OFF;
CREATE TABLE telegram_links_v2 (code TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at TEXT NOT NULL, meta_json TEXT NOT NULL DEFAULT '{}');
INSERT INTO telegram_links_v2 (code,user_id,expires_at,meta_json) SELECT code,user_id,expires_at,'{}' FROM telegram_links;
DROP TABLE telegram_links; ALTER TABLE telegram_links_v2 RENAME TO telegram_links; PRAGMA foreign_keys=ON;`);
    }
    const ucols = await c.execute("PRAGMA table_info(users)");
    if (!ucols.rows.some((r: any) => r.name === "timezone")) await c.execute("ALTER TABLE users ADD COLUMN timezone TEXT");
    const wcols = await c.execute("PRAGMA table_info(wallets)");
    if (!wcols.rows.some((r: any) => r.name === "removed_at")) await c.execute("ALTER TABLE wallets ADD COLUMN removed_at TEXT");
    const jcols = await c.execute("PRAGMA table_info(jobs)");
    if (!jcols.rows.some((r: any) => r.name === "started_at")) await c.execute("ALTER TABLE jobs ADD COLUMN started_at TEXT");
    c.close();
  } else {
    for (const s of DDL) await exec!(s);
    await exec!(`ALTER TABLE telegram_links ADD COLUMN IF NOT EXISTS meta_json TEXT NOT NULL DEFAULT '{}'`);
    await exec!(`ALTER TABLE users ADD COLUMN IF NOT EXISTS timezone TEXT`);
    await exec!(`ALTER TABLE wallets ADD COLUMN IF NOT EXISTS removed_at TEXT`);
    await exec!(`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS started_at TEXT`);
  }
}

export type Db = AppDb;
