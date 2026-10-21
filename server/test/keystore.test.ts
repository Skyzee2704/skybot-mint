import { describe, it, expect, beforeEach } from "vitest";
import os from "node:os"; import path from "node:path"; import fs from "node:fs";
process.env.KEYSTORE_SCRYPT_N = String(2 ** 12); // fast for tests
import { createKeystoreMeta, unlockKeystore, encrypt, decrypt } from "../src/core/keystore/crypto.js";
import { Store } from "../src/core/store.js";
import { Session } from "../src/core/keystore/session.js";
import { WalletService, parseBulkKeys, normalizePrivateKey } from "../src/core/wallets/service.js";
import { Wallet } from "ethers";

const K1 = "0x" + "11".repeat(32);
const K2 = "22".repeat(32);

describe("keystore crypto", () => {
  it("round-trips and rejects wrong password", () => {
    const { meta, kek } = createKeystoreMeta("correct horse battery", 2 ** 12);
    const blob = encrypt(kek, K1, "0xabc");
    expect(decrypt(unlockKeystore(meta, "correct horse battery"), blob, "0xabc")).toBe(K1);
    expect(() => unlockKeystore(meta, "wrong password!!")).toThrow(/Wrong master password/);
  });
  it("binds ciphertext to address via AAD", () => {
    const { kek } = createKeystoreMeta("password123", 2 ** 12);
    const blob = encrypt(kek, K1, "0xaaa");
    expect(() => decrypt(kek, blob, "0xbbb")).toThrow();
  });
  it("rejects short passwords", () => { expect(() => createKeystoreMeta("short", 2 ** 12)).toThrow(); });
});

describe("wallet service", () => {
  let store: Store; let sess: Session; let svc: WalletService; let file: string;
  beforeEach(() => {
    file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nmb-")), "db.json");
    store = new Store(file); sess = new Session(() => store); svc = new WalletService(() => store, sess);
  });
  it("requires unlock, imports, never stores plaintext", () => {
    expect(() => svc.importOne(K1, "a")).toThrow(/locked/);
    sess.unlock("my master password");
    const w = svc.importOne(K1, "a", "g1");
    expect(w.address).toBe(new Wallet(K1).address);
    expect((w as any).enc).toBeUndefined();
    const raw = fs.readFileSync(file, "utf8");
    expect(raw).not.toContain("11".repeat(32));
    expect(svc.signer(w.id).address).toBe(w.address);
    expect(() => svc.importOne(K1, "dup")).toThrow(/already/);
  });
  it("bulk import parses csv/txt, reports invalid line numbers only", () => {
    sess.unlock("my master password");
    const r = svc.importBulk(`label,key\nfoo,${K1}\n# comment\n${K2}\nnot-a-key\n\n${K1}`);
    expect(r.imported.length).toBe(2);
    expect(r.duplicates).toBe(1);
    expect(r.invalidLines).toEqual([5]);
    expect(r.imported[0].label).toBe("foo");
  });
  it("generates wallets and groups", () => {
    sess.unlock("my master password");
    const g = svc.generate(3, "batch");
    expect(g).toHaveLength(3);
    expect(svc.groups()).toEqual([{ name: "batch", count: 3 }]);
    svc.deleteGroup("batch");
    expect(svc.list().every((w) => w.group === null)).toBe(true);
  });
  it("lock wipes access; wrong password fails after init", () => {
    sess.unlock("my master password");
    const w = svc.generate(1)[0];
    sess.lock();
    expect(() => svc.signer(w.id)).toThrow(/locked/);
    expect(() => sess.unlock("not the password")).toThrow(/Wrong/);
    const t = sess.unlock("my master password");
    expect(sess.validToken(t.token)).toBe(true);
    expect(sess.validToken("nope")).toBe(false);
  });
  it("normalizes keys", () => {
    expect(normalizePrivateKey(K2)).toBe("0x" + K2);
    expect(normalizePrivateKey("0x" + "00".repeat(32))).toBeNull();
    expect(normalizePrivateKey("0x123")).toBeNull();
    expect(parseBulkKeys(`${K2},label-after`).entries[0].label).toBe("label-after");
  });
});
