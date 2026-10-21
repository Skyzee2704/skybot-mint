import { randomBytes } from "node:crypto";
import { env } from "../../config/env.js";
import { getStore, Store } from "../store.js";
import { createKeystoreMeta, unlockKeystore } from "./crypto.js";
import { log } from "../../util/log.js";

/**
 * Holds the KEK in memory while unlocked. Dashboard gets an opaque bearer token only.
 * Lock (manual or TTL expiry) zeroes the KEK and revokes all tokens.
 */
class Session {
  private kek: Buffer | null = null;
  private tokens = new Map<string, number>(); // token -> expiresAt
  private lockTimer: NodeJS.Timeout | null = null;
  private expiresAt = 0;

  constructor(private storeRef: () => Store = getStore) {}

  get initialized() { return Boolean(this.storeRef().db.keystore); }
  get unlocked() { return this.kek !== null && Date.now() < this.expiresAt; }
  get expiry() { return this.unlocked ? new Date(this.expiresAt).toISOString() : null; }

  /** First run: set the master password. Later runs: verify it. Returns a bearer token. */
  unlock(password: string, ttlMinutes = env.sessionTtlMinutes): { token: string; expiresAt: string; created: boolean } {
    const store = this.storeRef();
    let created = false;
    let kek: Buffer;
    if (!store.db.keystore) {
      const r = createKeystoreMeta(password, env.scryptN);
      store.update((d) => { d.keystore = r.meta; });
      kek = r.kek; created = true;
      log.info("Keystore initialized");
    } else {
      kek = unlockKeystore(store.db.keystore, password);
    }
    if (this.kek && this.kek !== kek) this.kek.fill(0);
    this.kek = kek;
    this.expiresAt = Date.now() + ttlMinutes * 60_000;
    if (this.lockTimer) clearTimeout(this.lockTimer);
    this.lockTimer = setTimeout(() => this.lock("ttl"), ttlMinutes * 60_000);
    this.lockTimer.unref?.();
    const token = randomBytes(32).toString("hex");
    this.tokens.set(token, this.expiresAt);
    return { token, expiresAt: new Date(this.expiresAt).toISOString(), created };
  }

  lock(reason = "manual") {
    if (this.kek) this.kek.fill(0);
    this.kek = null;
    this.tokens.clear();
    this.expiresAt = 0;
    if (this.lockTimer) clearTimeout(this.lockTimer);
    log.info(`Keystore locked (${reason})`);
  }

  validToken(token: string | undefined): boolean {
    if (!token) return false;
    const exp = this.tokens.get(token);
    if (!exp) return false;
    if (Date.now() > exp || !this.unlocked) { this.tokens.delete(token); return false; }
    return true;
  }

  /** Internal only — never expose. */
  requireKek(): Buffer {
    if (!this.unlocked || !this.kek) throw Object.assign(new Error("Keystore is locked. Unlock with the master password first."), { statusCode: 423 });
    return this.kek;
  }
}

export const session = new Session();
export { Session };
