import { randomUUID } from "node:crypto";
import { Wallet, getAddress, Provider } from "ethers";
import { getStore, Store, WalletRecord } from "../store.js";
import { session as defaultSession, Session } from "../keystore/session.js";
import { decrypt, encrypt } from "../keystore/crypto.js";

/** Public wallet view — never includes key material. */
export interface WalletView { id: string; label: string; address: string; group: string | null; createdAt: string; source: string; isMain: boolean }

export function normalizePrivateKey(raw: string): string | null {
  const s = raw.trim().replace(/^["']|["']$/g, "");
  const hex = s.startsWith("0x") || s.startsWith("0X") ? s.slice(2) : s;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return null;
  if (/^0+$/.test(hex)) return null;
  try { new Wallet("0x" + hex); return "0x" + hex.toLowerCase(); } catch { return null; }
}

/**
 * Parse bulk text: one key per line, or CSV "label,key" / "key,label". Blank lines and
 * lines starting with # are ignored. Header rows are skipped. Returns line numbers for
 * invalid entries (never the content).
 */
export function parseBulkKeys(text: string): { entries: { key: string; label?: string; line: number }[]; invalidLines: number[] } {
  const entries: { key: string; label?: string; line: number }[] = [];
  const invalidLines: number[] = [];
  text.split(/\r?\n/).forEach((rawLine, i) => {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) return;
    const parts = line.split(/[,;\t]/).map((p) => p.trim()).filter(Boolean);
    if (i === 0 && parts.some((p) => /^(label|name|private_?key|key)$/i.test(p))) return; // header
    let key: string | null = null; let label: string | undefined;
    for (const p of parts) {
      const k = normalizePrivateKey(p);
      if (k && !key) key = k; else if (!label) label = p.slice(0, 64);
    }
    if (key) entries.push({ key, label, line: i + 1 }); else invalidLines.push(i + 1);
  });
  return { entries, invalidLines };
}

export class WalletService {
  constructor(private storeRef: () => Store = getStore, private sess: Session = defaultSession) {}
  private get store() { return this.storeRef(); }

  view(w: WalletRecord): WalletView {
    return { id: w.id, label: w.label, address: w.address, group: w.group, createdAt: w.createdAt, source: w.source, isMain: this.store.db.mainWalletId === w.id };
  }
  list(group?: string | null): WalletView[] {
    return this.store.db.wallets.filter((w) => group === undefined || w.group === group).map((w) => this.view(w));
  }
  get(id: string): WalletRecord {
    const w = this.store.db.wallets.find((x) => x.id === id);
    if (!w) throw Object.assign(new Error(`Wallet ${id} not found`), { statusCode: 404 });
    return w;
  }
  byAddress(addr: string) { return this.store.db.wallets.find((w) => w.address.toLowerCase() === addr.toLowerCase()); }

  private add(key: string, label: string, group: string | null, source: WalletRecord["source"]): { wallet?: WalletView; duplicate?: boolean } {
    const kek = this.sess.requireKek();
    const address = getAddress(new Wallet(key).address);
    if (this.byAddress(address)) return { duplicate: true };
    const rec: WalletRecord = {
      id: randomUUID(), label: label || `wallet-${address.slice(2, 8)}`, address, group, source,
      createdAt: new Date().toISOString(), enc: encrypt(kek, key, address.toLowerCase()),
    };
    this.store.update((d) => {
      d.wallets.push(rec);
      if (group && !d.groups.includes(group)) d.groups.push(group);
    });
    return { wallet: this.view(rec) };
  }

  importOne(rawKey: string, label: string, group: string | null = null): WalletView {
    const key = normalizePrivateKey(rawKey);
    if (!key) throw Object.assign(new Error("Invalid private key (expected 64 hex characters)"), { statusCode: 400 });
    const r = this.add(key, label, group, "imported");
    if (r.duplicate) throw Object.assign(new Error("Wallet already imported"), { statusCode: 409 });
    return r.wallet!;
  }

  importBulk(text: string, group: string | null = null, labelPrefix = "wallet") {
    const { entries, invalidLines } = parseBulkKeys(text);
    const imported: WalletView[] = []; let duplicates = 0;
    entries.forEach((e, i) => {
      const r = this.add(e.key, e.label ?? `${labelPrefix}-${this.store.db.wallets.length + 1}`, group, "imported");
      if (r.duplicate) duplicates++; else imported.push(r.wallet!);
      void i;
    });
    return { imported, duplicates, invalidLines };
  }

  generate(count: number, group: string | null = null, labelPrefix = "gen"): WalletView[] {
    if (!Number.isInteger(count) || count < 1 || count > 500) throw Object.assign(new Error("count must be 1..500"), { statusCode: 400 });
    const out: WalletView[] = [];
    for (let i = 0; i < count; i++) {
      const w = Wallet.createRandom();
      out.push(this.add(w.privateKey, `${labelPrefix}-${this.store.db.wallets.length + 1}`, group, "generated").wallet!);
    }
    return out;
  }

  update(id: string, patch: { label?: string; group?: string | null }) {
    this.get(id);
    this.store.update((d) => {
      const w = d.wallets.find((x) => x.id === id)!;
      if (patch.label !== undefined) w.label = patch.label.slice(0, 64);
      if (patch.group !== undefined) { w.group = patch.group; if (patch.group && !d.groups.includes(patch.group)) d.groups.push(patch.group); }
    });
    return this.view(this.get(id));
  }

  remove(id: string) {
    this.get(id);
    this.store.update((d) => {
      d.wallets = d.wallets.filter((w) => w.id !== id);
      if (d.mainWalletId === id) d.mainWalletId = null;
    });
  }

  setMain(id: string | null) {
    if (id) this.get(id);
    this.store.update((d) => { d.mainWalletId = id; });
  }

  groups() {
    const d = this.store.db;
    return d.groups.map((g) => ({ name: g, count: d.wallets.filter((w) => w.group === g).length }));
  }
  createGroup(name: string) {
    const n = name.trim().slice(0, 48);
    if (!n) throw Object.assign(new Error("group name required"), { statusCode: 400 });
    this.store.update((d) => { if (!d.groups.includes(n)) d.groups.push(n); });
  }
  deleteGroup(name: string) {
    this.store.update((d) => {
      d.groups = d.groups.filter((g) => g !== name);
      d.wallets.forEach((w) => { if (w.group === name) w.group = null; });
    });
  }

  /** INTERNAL: decrypt a signer. Never return this (or its key) from the API. */
  signer(id: string, provider?: Provider): Wallet {
    const kek = this.sess.requireKek();
    const w = this.get(id);
    const key = decrypt(kek, w.enc, w.address.toLowerCase());
    return new Wallet(key, provider);
  }
}

export const wallets = new WalletService();
