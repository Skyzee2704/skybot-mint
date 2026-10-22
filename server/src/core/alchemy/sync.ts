// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Keeps one Alchemy Address Activity webhook per supported network pointed at prod, tracking exactly the addresses
 * of every active SkyBOT wallet. Runs from wallet create/import/remove routes (time-boxed) and from housekeeping
 * (reconciliation). Without ALCHEMY_AUTH_TOKEN everything is a graceful no-op.
 *
 * Cheap by default ("auto"): compares a hash of the desired address set with what was last synced and does no
 * Alchemy calls when nothing changed (full re-check at most every 6 h, errored networks retried every 30 min).
 */
import { createHash } from "node:crypto";
import { isNull } from "drizzle-orm";
import { env } from "../../config/env.js";
import { getDb } from "../../db/client.js";
import { alchemyWebhooks, wallets } from "../../db/schema.js";
import { log, redactString } from "../../util/log.js";
import { open, seal } from "../../util/secretBox.js";
import { ALCHEMY_WEBHOOK_NETWORK } from "./networks.js";

export const NOTIFY_API = "https://dashboard.alchemy.com/api";
export const SIGNING_PURPOSE = "alchemy-webhook-signing-key";
const RECHECK_MS = 6 * 3600_000;
const ERROR_RETRY_MS = 30 * 60_000;
const CHUNK = 500;

export type NotifyFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;

export interface RemoteWebhook {
  id: string;
  network: string;
  webhook_type: string;
  webhook_url: string;
  is_active: boolean;
  signing_key?: string;
}

/** Pure: which addresses to add / remove so `current` becomes `desired` (case-insensitive, lower-case output). */
export function diffAddresses(current: Iterable<string>, desired: Iterable<string>) {
  const cur = new Set([...current].map((a) => a.toLowerCase()));
  const want = new Set([...desired].map((a) => a.toLowerCase()));
  return {
    add: [...want].filter((a) => !cur.has(a)).sort(),
    remove: [...cur].filter((a) => !want.has(a)).sort(),
  };
}

export const addressHash = (addrs: string[]) =>
  createHash("sha256")
    .update([...new Set(addrs.map((a) => a.toLowerCase()))].sort().join(","))
    .digest("hex");

export const webhookUrl = () => `${env.publicUrl.replace(/\/$/, "")}/api/webhooks/alchemy`;

/** Every address SkyBOT should watch: active (not removed) wallets of all users, lower-case, unique. */
export async function desiredAddresses(): Promise<string[]> {
  const rows = await getDb().select({ address: wallets.address }).from(wallets).where(isNull(wallets.removedAt));
  return [...new Set(rows.map((r) => r.address.toLowerCase()).filter((a) => /^0x[0-9a-f]{40}$/.test(a)))].sort();
}

export class NotifyClient {
  constructor(
    private token: string,
    private f: NotifyFetch = globalThis.fetch as any,
  ) {}
  private async call(method: string, path: string, body?: unknown): Promise<any> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15_000);
    try {
      const r = await this.f(`${NOTIFY_API}${path}`, {
        method,
        headers: { "X-Alchemy-Token": this.token, accept: "application/json", "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok)
        throw new Error(
          `Alchemy Notify ${method} ${path.split("?")[0]} HTTP ${r.status}: ${String(j?.message ?? j?.error ?? "").slice(0, 160)}`,
        );
      return j;
    } finally {
      clearTimeout(t);
    }
  }
  async listWebhooks(): Promise<RemoteWebhook[]> {
    const j = await this.call("GET", "/team-webhooks");
    return Array.isArray(j?.data) ? j.data : [];
  }
  async createWebhook(network: string, url: string, addresses: string[]): Promise<RemoteWebhook> {
    const j = await this.call("POST", "/create-webhook", {
      network,
      webhook_type: "ADDRESS_ACTIVITY",
      webhook_url: url,
      name: `SkyBOT Mint ${network}`,
      addresses,
    });
    return j?.data;
  }
  async addresses(webhookId: string): Promise<string[]> {
    const out: string[] = [];
    let after: string | null = null;
    for (let i = 0; i < 200; i++) {
      const q = new URLSearchParams({ webhook_id: webhookId, limit: "1000" });
      if (after) q.set("after", after);
      const j = await this.call("GET", `/webhook-addresses?${q}`);
      const page: string[] = Array.isArray(j?.data) ? j.data : [];
      out.push(...page);
      const next = j?.pagination?.cursors?.after;
      if (!page.length || !next || next === after) break;
      after = String(next);
    }
    return out;
  }
  async patchAddresses(webhookId: string, add: string[], remove: string[]) {
    await this.call("PATCH", "/update-webhook-addresses", { webhook_id: webhookId, addresses_to_add: add, addresses_to_remove: remove });
  }
  async setActive(webhookId: string, isActive: boolean) {
    await this.call("PUT", "/update-webhook", { webhook_id: webhookId, is_active: isActive });
  }
}

type Row = typeof alchemyWebhooks.$inferSelect;
export type NetworkStatus = {
  network: string;
  chain: string;
  status: string;
  webhookId?: string | null;
  addresses?: number;
  error?: string;
};

async function saveRow(r: Omit<Row, "signingKeyEnc"> & { signingKey?: string | null; keepKey?: string | null }) {
  const signingKeyEnc = r.signingKey ? seal(SIGNING_PURPOSE, r.signingKey) : (r.keepKey ?? null);
  const values = {
    network: r.network,
    webhookId: r.webhookId,
    signingKeyEnc,
    addressHash: r.addressHash,
    addressCount: r.addressCount,
    syncedAt: r.syncedAt,
    error: r.error,
  };
  const { network: _n, ...set } = values;
  await getDb().insert(alchemyWebhooks).values(values).onConflictDoUpdate({ target: alchemyWebhooks.network, set });
}

let running: Promise<{ status: string; networks: NetworkStatus[] }> | null = null;

/**
 * Create / update the webhooks. mode "auto" skips networks already in sync; "full" re-reads every webhook.
 * Never throws: per-network errors are recorded and returned.
 */
export function syncAlchemyWebhooks(opts: { mode?: "auto" | "full"; fetchImpl?: NotifyFetch; now?: number } = {}) {
  running ??= doSync(opts).finally(() => {
    running = null;
  });
  return running;
}

async function doSync(opts: { mode?: "auto" | "full"; fetchImpl?: NotifyFetch; now?: number }) {
  const token = env.alchemyAuthToken;
  if (!token) return { status: "disabled (ALCHEMY_AUTH_TOKEN not set)", networks: [] as NetworkStatus[] };
  const now = opts.now ?? Date.now();
  const mode = opts.mode ?? "auto";
  const url = webhookUrl();
  const desired = await desiredAddresses();
  const hash = addressHash(desired);
  const rows = new Map((await getDb().select().from(alchemyWebhooks)).map((r) => [r.network, r]));
  const todo = Object.entries(ALCHEMY_WEBHOOK_NETWORK).filter(([, net]) => {
    if (mode === "full") return true;
    const r = rows.get(net);
    if (!r) return true;
    const age = now - Date.parse(r.syncedAt);
    if (r.error) return age > ERROR_RETRY_MS || r.addressHash !== hash;
    return r.addressHash !== hash || age > RECHECK_MS || !r.signingKeyEnc;
  });
  const networks: NetworkStatus[] = Object.entries(ALCHEMY_WEBHOOK_NETWORK)
    .filter(([c]) => !todo.some(([t]) => t === c))
    .map(([chain, network]) => {
      const r = rows.get(network)!;
      return {
        network,
        chain,
        status: r.error ? "error (retry pending)" : "in sync",
        webhookId: r.webhookId,
        addresses: r.addressCount,
        ...(r.error ? { error: r.error } : {}),
      };
    });
  if (!todo.length) return { status: "ok", networks };

  const client = new NotifyClient(token, opts.fetchImpl);
  let remote: RemoteWebhook[];
  try {
    remote = await client.listWebhooks();
  } catch (e: any) {
    const error = redactString(String(e?.message ?? e)).slice(0, 200);
    log.warn("alchemy webhook list failed", error);
    return { status: "error", networks: [...networks, ...todo.map(([chain, network]) => ({ network, chain, status: "error", error }))] };
  }
  for (const [chain, network] of todo) {
    const prev = rows.get(network);
    const base = { network, syncedAt: new Date(now).toISOString() };
    try {
      const mine = remote.filter((w) => w.network === network && w.webhook_type === "ADDRESS_ACTIVITY" && w.webhook_url === url);
      let wh = mine.find((w) => w.id === prev?.webhookId) ?? mine[0];
      let status = "in sync";
      if (!wh) {
        if (!desired.length) {
          networks.push({ network, chain, status: "waiting for wallets" });
          continue;
        }
        wh = await client.createWebhook(network, url, desired.slice(0, CHUNK));
        for (let i = CHUNK; i < desired.length; i += CHUNK) await client.patchAddresses(wh.id, desired.slice(i, i + CHUNK), []);
        status = "created";
      } else {
        const d = diffAddresses(await client.addresses(wh.id), desired);
        for (let i = 0; i < Math.max(d.add.length, d.remove.length); i += CHUNK)
          await client.patchAddresses(wh.id, d.add.slice(i, i + CHUNK), d.remove.slice(i, i + CHUNK));
        if (d.add.length || d.remove.length) status = `updated (+${d.add.length} / -${d.remove.length})`;
        if (wh.is_active === false) {
          await client.setActive(wh.id, true);
          status += ", re-activated";
        }
      }
      await saveRow({
        ...base,
        webhookId: wh.id,
        signingKey: wh.signing_key ?? null,
        keepKey: prev?.webhookId === wh.id ? prev?.signingKeyEnc : null,
        addressHash: hash,
        addressCount: desired.length,
        error: null,
      });
      networks.push({ network, chain, status, webhookId: wh.id, addresses: desired.length });
    } catch (e: any) {
      const error = redactString(String(e?.message ?? e)).slice(0, 200);
      log.warn("alchemy webhook sync failed", { network, error });
      await saveRow({
        ...base,
        webhookId: prev?.webhookId ?? null,
        keepKey: prev?.signingKeyEnc ?? null,
        addressHash: hash,
        addressCount: prev?.addressCount ?? 0,
        error,
      }).catch(() => {});
      networks.push({ network, chain, status: "error", error });
    }
  }
  const order = Object.values(ALCHEMY_WEBHOOK_NETWORK);
  networks.sort((a, b) => order.indexOf(a.network) - order.indexOf(b.network));
  return { status: networks.some((n) => n.status === "error") ? "partial" : "ok", networks };
}

/** Best effort sync after a wallet add/remove, time-boxed so the request never waits long. */
export async function syncAfterWalletChange(timeoutMs = 4_000) {
  if (!env.alchemyAuthToken) return;
  await Promise.race([
    syncAlchemyWebhooks({ mode: "auto" }).catch((e) => log.warn("alchemy sync", String(e?.message ?? e).slice(0, 160))),
    new Promise((r) => setTimeout(r, timeoutMs)),
  ]);
}

/* ---------- signing keys (for verifying deliveries) ---------- */
const keyCache = new Map<string, { key: string | null; at: number }>();
let lastRemoteFetch = 0;

/** Signing key for a webhook id: memory → DB (decrypted) → Alchemy list (at most once a minute, then stored). */
export async function signingKeyFor(webhookId: string, fetchImpl?: NotifyFetch): Promise<string | null> {
  const hit = keyCache.get(webhookId);
  if (hit && Date.now() - hit.at < (hit.key ? 5 * 60_000 : 30_000)) return hit.key;
  const rows = await getDb().select().from(alchemyWebhooks);
  const row = rows.find((r) => r.webhookId === webhookId);
  let key = open(SIGNING_PURPOSE, row?.signingKeyEnc);
  if (!key && env.alchemyAuthToken && Date.now() - lastRemoteFetch > 60_000) {
    lastRemoteFetch = Date.now();
    try {
      const remote = await new NotifyClient(env.alchemyAuthToken, fetchImpl).listWebhooks();
      const wh = remote.find((w) => w.id === webhookId && w.webhook_url === webhookUrl());
      if (wh?.signing_key && Object.values(ALCHEMY_WEBHOOK_NETWORK).includes(wh.network)) {
        key = wh.signing_key;
        const prev = rows.find((r) => r.network === wh.network);
        await saveRow({
          network: wh.network,
          webhookId: wh.id,
          signingKey: key,
          addressHash: prev?.webhookId === wh.id ? (prev?.addressHash ?? null) : null,
          addressCount: prev?.addressCount ?? 0,
          syncedAt: prev?.syncedAt ?? new Date().toISOString(),
          error: prev?.error ?? null,
        });
      }
    } catch (e: any) {
      log.warn("alchemy signing key lookup", redactString(String(e?.message ?? e)).slice(0, 160));
    }
  }
  keyCache.set(webhookId, { key, at: Date.now() });
  return key;
}

export function clearSigningKeyCache() {
  keyCache.clear();
  lastRemoteFetch = 0;
}

/** Status for the admin page / reports (no secrets). */
export async function webhookStatus() {
  const rows = await getDb().select().from(alchemyWebhooks);
  return {
    enabled: Boolean(env.alchemyAuthToken),
    url: webhookUrl(),
    networks: Object.entries(ALCHEMY_WEBHOOK_NETWORK).map(([chain, network]) => {
      const r = rows.find((x) => x.network === network);
      return {
        chain,
        network,
        webhookId: r?.webhookId ?? null,
        hasSigningKey: Boolean(r?.signingKeyEnc),
        addresses: r?.addressCount ?? 0,
        syncedAt: r?.syncedAt ?? null,
        error: r?.error ?? null,
      };
    }),
  };
}
