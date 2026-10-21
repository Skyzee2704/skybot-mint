import fs from "node:fs";
import path from "node:path";
import { env } from "../config/env.js";

/** Minimal JSON-file persistence with atomic writes (single-user, single-process app). */
export interface KeystoreMeta {
  version: 1;
  kdf: "scrypt";
  salt: string; // base64
  N: number; r: number; p: number;
  verifier: EncBlob;
}
export interface EncBlob { iv: string; ct: string; tag: string }
export interface WalletRecord {
  id: string;
  label: string;
  address: string;
  group: string | null;
  createdAt: string;
  source: "imported" | "generated";
  enc: EncBlob;
}
export interface JobRecord {
  id: string;
  createdAt: string;
  status: "scheduled" | "running" | "done" | "failed" | "cancelled" | "waiting_unlock";
  runAt: string | null; // ISO; null = immediate
  chain: string;
  target: string; // NFT contract
  strategy: string;
  request: unknown; // serialized mint request (no secrets)
  results: unknown[];
  error?: string;
  log: string[];
}
export interface SpendEntry { day: string; chain: string; wei: string; at: string; ref: string }
export interface MintedRecord { chain: string; contract: string; wallet: string; tokenIds: string[]; txHash: string; at: string }

/** User-editable runtime settings (dashboard → Settings). Caps are OFF (unlimited) unless enabled. */
export interface SettingsShape {
  priceCapEnabled: boolean;
  dailyCapEnabled: boolean;
  /** Per-chain cap values in native units; missing = chain/env default. */
  caps: Record<string, { maxPricePerNft?: string; maxDailySpend?: string }>;
  /** Opt-in: sign an off-chain SIWE login per wallet to use OpenSea's eligibility endpoint (upcoming stages). */
  openseaWalletLogin: boolean;
}
export const DEFAULT_SETTINGS: SettingsShape = { priceCapEnabled: false, dailyCapEnabled: false, caps: {}, openseaWalletLogin: false };

export interface DbShape {
  settings: SettingsShape;
  keystore: KeystoreMeta | null;
  wallets: WalletRecord[];
  groups: string[];
  mainWalletId: string | null;
  jobs: JobRecord[];
  spend: SpendEntry[];
  minted: MintedRecord[];
}

const EMPTY: DbShape = { settings: structuredClone(DEFAULT_SETTINGS), keystore: null, wallets: [], groups: [], mainWalletId: null, jobs: [], spend: [], minted: [] };

export class Store {
  private data: DbShape;
  constructor(private readonly file: string) {
    this.data = Store.load(file);
  }
  static load(file: string): DbShape {
    try {
      const raw = fs.readFileSync(file, "utf8");
      const parsed = JSON.parse(raw);
      return { ...structuredClone(EMPTY), ...parsed, settings: { ...structuredClone(DEFAULT_SETTINGS), ...(parsed.settings ?? {}) } };
    } catch (e: any) {
      if (e.code === "ENOENT") return structuredClone(EMPTY);
      throw e;
    }
  }
  get db(): DbShape { return this.data; }
  /** Mutate and persist atomically (write temp file with 0600, then rename). */
  update<T>(fn: (d: DbShape) => T): T {
    const out = fn(this.data);
    this.flush();
    return out;
  }
  flush() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}

let singleton: Store | null = null;
export function getStore(): Store {
  if (!singleton) singleton = new Store(path.join(env.dataDir, "db.json"));
  return singleton;
}
export function setStore(s: Store) { singleton = s; }
