/**
 * DB: Postgres when DATABASE_URL is set (Neon / Railway / Render),
 * else local SQLite via libsql file under DATA_DIR.
 */
import { createClient, type Client } from "@libsql/client";
import { drizzle as drizzleLibsql, type LibSQLDatabase } from "drizzle-orm/libsql";
import { drizzle as drizzlePg, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";
import fs from "node:fs";
import path from "node:path";
import { env } from "../config/env.js";

/** Unified handle — schema is SQLite-shaped; Postgres runs the same SQL via cast. */
export type AppDb = LibSQLDatabase<typeof schema>;
type AnyDb = AppDb;

let db: AnyDb | null = null;
let libsql: Client | null = null;
let pgSql: ReturnType<typeof postgres> | null = null;
let migrated = false;
let mode: "sqlite" | "postgres" = "sqlite";

export function dbMode() { return mode; }

export function getDb(): AnyDb {
  if (db) return db;
  const url = env.databaseUrl;
  if (url && (url.startsWith("postgres://") || url.startsWith("postgresql://"))) {
    mode = "postgres";
    pgSql = postgres(url, { max: 8, prepare: false, ssl: "require" });
    db = drizzlePg(pgSql, { schema }) as unknown as AppDb;
  } else {
    mode = "sqlite";
    const dir = env.dataDir;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, "skybot.db");
    libsql = createClient({ url: `file:${file}` });
    db = drizzleLibsql(libsql, { schema });
  }
  void ensureMigrated();
  return db;
}

export async function ensureDb() {
  getDb();
  await ensureMigrated();
  return db!;
}

export function getRawClient() {
  getDb();
  return { mode, libsql, pgSql };
}

async function exec(sql: string) {
  if (mode === "postgres") {
    await pgSql!.unsafe(sql);
  } else {
    await libsql!.executeMultiple(sql);
  }
}

async function ensureMigrated() {
  if (migrated) return;
  // Dialect-neutral DDL (TEXT / INTEGER). Works on SQLite and Postgres.
  const stmts = [
    `CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, privy_user_id TEXT NOT NULL UNIQUE, email TEXT, name TEXT,
      role TEXT NOT NULL DEFAULT 'user', disabled INTEGER NOT NULL DEFAULT 0,
      telegram_user_id TEXT UNIQUE, telegram_username TEXT,
      created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS users_email_idx ON users(email)`,
    `CREATE TABLE IF NOT EXISTS wallets (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      privy_wallet_id TEXT, address TEXT NOT NULL, label TEXT NOT NULL DEFAULT '',
      group_name TEXT, source TEXT NOT NULL, hd_index INTEGER, is_main INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, UNIQUE(user_id, address)
    )`,
    `CREATE INDEX IF NOT EXISTS wallets_user_idx ON wallets(user_id)`,
    `CREATE TABLE IF NOT EXISTS groups (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(user_id, name)
    )`,
    `CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL, status TEXT NOT NULL, run_at TEXT, chain TEXT NOT NULL,
      target TEXT NOT NULL, strategy TEXT NOT NULL, request_json TEXT NOT NULL,
      results_json TEXT NOT NULL DEFAULT '[]', error TEXT, log_json TEXT NOT NULL DEFAULT '[]'
    )`,
    `CREATE INDEX IF NOT EXISTS jobs_user_idx ON jobs(user_id)`,
    `CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs(status)`,
    `CREATE TABLE IF NOT EXISTS settings (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      price_cap_enabled INTEGER NOT NULL DEFAULT 0, daily_cap_enabled INTEGER NOT NULL DEFAULT 0,
      opensea_wallet_login INTEGER NOT NULL DEFAULT 0, caps_json TEXT NOT NULL DEFAULT '{}'
    )`,
    `CREATE TABLE IF NOT EXISTS spend (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      day TEXT NOT NULL, chain TEXT NOT NULL, wei TEXT NOT NULL, at TEXT NOT NULL, ref TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS spend_user_day ON spend(user_id, day, chain)`,
    `CREATE TABLE IF NOT EXISTS minted (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      chain TEXT NOT NULL, contract TEXT NOT NULL, wallet TEXT NOT NULL,
      token_ids_json TEXT NOT NULL, tx_hash TEXT NOT NULL, at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS minted_user_idx ON minted(user_id)`,
    `CREATE TABLE IF NOT EXISTS telegram_links (
      code TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at TEXT NOT NULL, meta_json TEXT NOT NULL DEFAULT '{}'
    )`,
    `CREATE TABLE IF NOT EXISTS rate_buckets (
      key TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0, window_start INTEGER NOT NULL
    )`,
  ];
  if (mode === "postgres") {
    for (const s of stmts) await pgSql!.unsafe(s);
    // Ensure meta_json exists on older telegram_links
    await pgSql!.unsafe(`ALTER TABLE telegram_links ADD COLUMN IF NOT EXISTS meta_json TEXT NOT NULL DEFAULT '{}'`).catch(() => {});
  } else {
    await libsql!.executeMultiple(stmts.join(";\n") + ";");
    const cols = await libsql!.execute("PRAGMA table_info(telegram_links)");
    const names = new Set(cols.rows.map((r: any) => r.name as string));
    if (!names.has("meta_json")) {
      await libsql!.executeMultiple(`
PRAGMA foreign_keys=OFF;
CREATE TABLE telegram_links_v2 (
  code TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at TEXT NOT NULL, meta_json TEXT NOT NULL DEFAULT '{}'
);
INSERT INTO telegram_links_v2 (code, user_id, expires_at, meta_json)
  SELECT code, user_id, expires_at, '{}' FROM telegram_links;
DROP TABLE telegram_links;
ALTER TABLE telegram_links_v2 RENAME TO telegram_links;
PRAGMA foreign_keys=ON;
`);
    }
  }
  migrated = true;
}

export type Db = AppDb;
