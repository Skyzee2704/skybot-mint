// SPDX-License-Identifier: AGPL-3.0-only
// OpenSea session expiry: JWT expiry / near-expiry, PAT reuse, revoked sessions, 429s and missing signers —
// none of them may require the member to open the app when the server signer is on the wallet.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Wallet } from "ethers";

process.env.DATABASE_URL = "pglite:memory";
process.env.SESSION_SECRET = "s".repeat(48);
process.env.PRIVY_APP_ID = "app";
process.env.PRIVY_APP_SECRET = "secret-for-tests";
process.env.PRIVY_SIWE_AUTH_PRIVATE_KEY = "k";
process.env.PRIVY_SIWE_KEY_QUORUM_ID = "quorum1";
process.env.PRIVY_SIWE_POLICY_ID = "policy1";
process.env.OPENSEA_API_KEY = "os-key";

const keys = new Map<string, Wallet>(); // privy wallet id → local key (stands in for Privy)
const signerOn = new Map<string, boolean>();
const signCalls: string[] = [];
vi.mock("../src/auth/privy.js", () => ({
  getPrivy: () => ({
    wallets: () => ({
      get: async (id: string) => ({ id, additional_signers: signerOn.get(id) ? [{ signer_id: "quorum1" }] : [] }),
      ethereum: () => ({
        signMessage: async (id: string, p: { message: string }) => {
          signCalls.push(id);
          if (!signerOn.get(id)) throw new Error("401 Unauthorized: signer not authorized for this wallet");
          return { signature: await keys.get(id)!.signMessage(p.message) };
        },
      }),
    }),
    users: () => ({ _get: async () => ({ linked_accounts: [] }) }),
  }),
}));

/* ---------- fake OpenSea ---------- */
const jwtFor = (expSec: number) =>
  `h.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + expSec })).toString("base64url")}.s`;
const os = {
  pats: new Map<string, { revoked: boolean }>(),
  rejectJwts: new Set<string>(),
  fail429: { nonce: 0, verify: 0, exchange: 0 },
  calls: [] as string[],
  patExpiresAt: null as string | null,
  n: 0,
};
function resetOs() {
  os.pats.clear();
  os.rejectJwts.clear();
  os.fail429 = { nonce: 0, verify: 0, exchange: 0 };
  os.calls = [];
  os.patExpiresAt = null;
}
const json = (b: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json", ...headers } });
const tooMany = () => json({ error: { code: 429 } }, 429, { "retry-after": "0" });
async function fakeFetch(input: any, init: any = {}): Promise<Response> {
  const url = String(input);
  const m = (init.method ?? "GET").toUpperCase();
  const path = new URL(url).pathname;
  os.calls.push(`${m} ${path}`);
  if (path === "/api/v2/auth/siwe/nonce") return os.fail429.nonce-- > 0 ? tooMany() : json({ nonce: `nonce${++os.n}abcdef` });
  if (path === "/api/v2/auth/siwe/verify") {
    if (os.fail429.verify-- > 0) return tooMany();
    return new Response("{}", { status: 200, headers: { "set-cookie": "access_token=sess; Path=/; HttpOnly" } });
  }
  if (path === "/api/v2/auth/tokens" && m === "POST") {
    const id = `pat${++os.n}`;
    os.pats.set(id, { revoked: false });
    const days = JSON.parse(init.body).expiresInDays;
    return json({ id, token: `tok-${id}`, expiresAt: os.patExpiresAt ?? new Date(Date.now() + days * 86_400_000).toISOString() });
  }
  if (path === "/api/v2/auth/tokens/exchange") {
    if (os.fail429.exchange-- > 0) return tooMany();
    const id = JSON.parse(init.body).subjectToken.replace(/^tok-/, "");
    const p = os.pats.get(id);
    if (!p || p.revoked) return json({ error: { message: "Token exchange is not available" } }, 403);
    return json({ accessToken: jwtFor(3599) + id + os.n++, expiresIn: 3599 });
  }
  if (path.startsWith("/api/v2/auth/tokens/") && m === "DELETE") {
    os.pats.get(path.split("/").pop()!)!.revoked = true;
    return json({});
  }
  if (/\/api\/v2\/drops\/[^/]+\/eligibility$/.test(path)) {
    const auth = String(init.headers?.authorization ?? "").replace(/^Bearer /, "");
    if (os.rejectJwts.has(auth)) return json({ error: "expired" }, 401);
    return json({ stages: [{ stage_uuid: "s1", is_eligible: true, price: "0", max_total_mintable_by_wallet: "1" }] });
  }
  return json({ error: "unexpected " + path }, 500);
}

describe("OpenSea session expiry never needs the app", () => {
  let S: typeof import("../src/core/resolver/openseaSession.js");
  let A: typeof import("../src/core/resolver/openseaAuth.js");
  let db: any;
  let schema: typeof import("../src/db/schema.js");
  const user = "u1";
  const mk = (n: number, signer = true) => {
    const k = Wallet.createRandom();
    const id = `privywalletid${String(n).padStart(6, "0")}`;
    keys.set(id, k as any);
    signerOn.set(id, signer);
    return { address: k.address, privyWalletId: id };
  };
  const forgetMemory = (address: string) => A.forgetJwt(address);

  beforeAll(async () => {
    vi.stubGlobal("fetch", fakeFetch);
    const client = await import("../src/db/client.js");
    await client.ensureDb();
    db = client.getDb();
    schema = await import("../src/db/schema.js");
    S = await import("../src/core/resolver/openseaSession.js");
    A = await import("../src/core/resolver/openseaAuth.js");
  });
  beforeEach(() => {
    resetOs();
    signCalls.length = 0;
  });

  it("first check signs in once on the server and keeps a 90-day read:eligibility PAT (not revoked)", async () => {
    const w = mk(1);
    const r = await S.walletJwt(user, w, { serverSign: true });
    expect(r).toMatchObject({ via: "signin" });
    expect(signCalls).toEqual([w.privyWalletId]);
    const pat = await S.loadPat(user, w.address);
    expect(pat).toBeTruthy();
    expect(Date.parse(pat!.expiresAt) - Date.now()).toBeGreaterThan(80 * 86_400_000);
    expect(os.calls.some((c) => c.startsWith("DELETE"))).toBe(false);
    // Stored encrypted, never in clear text.
    const row = (await db.select().from(schema.openseaPats))[0];
    expect(row.patEnc).not.toContain(pat!.token);
  });

  it("expired JWT: re-minted from the PAT with one request and no new signature", async () => {
    const w = mk(2);
    await S.walletJwt(user, w, { serverSign: true });
    signCalls.length = 0;
    os.calls = [];
    forgetMemory(w.address);
    await S.storeJwt(user, w.address, jwtFor(-60)); // expired a minute ago
    const r = await S.walletJwt(user, w, { serverSign: true });
    expect(r.via).toBe("pat");
    expect(signCalls).toEqual([]);
    expect(os.calls).toEqual(["POST /api/v2/auth/tokens/exchange"]);
  });

  it("near-expiry JWT (under 5 minutes left) counts as expired", async () => {
    const w = mk(3);
    await S.walletJwt(user, w, { serverSign: true });
    forgetMemory(w.address);
    await S.storeJwt(user, w.address, jwtFor(180));
    expect(await S.loadJwt(user, w.address)).toBeNull();
    expect((await S.walletJwt(user, w, { serverSign: true })).via).toBe("pat");
  });

  it("revoked/expired PAT (403): dropped and replaced by a silent server sign-in", async () => {
    const w = mk(4);
    await S.walletJwt(user, w, { serverSign: true });
    const old = await S.loadPat(user, w.address);
    os.pats.get(old!.id)!.revoked = true;
    forgetMemory(w.address);
    await S.dropJwt(w.address);
    signCalls.length = 0;
    const r = await S.walletJwt(user, w, { serverSign: true });
    expect(r.via).toBe("signin");
    expect(signCalls).toHaveLength(1);
    const now = await S.loadPat(user, w.address);
    expect(now!.id).not.toBe(old!.id);
  });

  it("PAT within 7 days of expiry is renewed proactively; renewal failure still answers from the old PAT", async () => {
    const w = mk(5);
    os.patExpiresAt = new Date(Date.now() + 2 * 86_400_000).toISOString();
    await S.walletJwt(user, w, { serverSign: true });
    os.patExpiresAt = null;
    forgetMemory(w.address);
    await S.dropJwt(w.address);
    signCalls.length = 0;
    const r = await S.walletJwt(user, w, { serverSign: true });
    expect(r.via).toBe("signin");
    expect(Date.parse((await S.loadPat(user, w.address))!.expiresAt) - Date.now()).toBeGreaterThan(80 * 86_400_000);

    const w2 = mk(6);
    os.patExpiresAt = new Date(Date.now() + 86_400_000).toISOString();
    await S.walletJwt(user, w2, { serverSign: true });
    forgetMemory(w2.address);
    await S.dropJwt(w2.address);
    signerOn.set(w2.privyWalletId, false); // renewal can't sign → keep using the still-valid PAT
    const r2 = await S.walletJwt(user, w2, { serverSign: true });
    expect(r2).toMatchObject({ via: "pat" });
  });

  it("OpenSea rejects the session at the eligibility call (401): re-auth + single retry in the same check", async () => {
    const w = mk(7);
    const first = await S.walletJwt(user, w, { serverSign: true });
    os.rejectJwts.add(first.jwt!);
    os.calls = [];
    const stages = await S.eligibilityWithReauth(user, w, first.jwt!, "drop", { serverSign: true });
    expect(stages[0]).toMatchObject({ stage_uuid: "s1", is_eligible: true });
    expect(os.calls.filter((c) => c.endsWith("/eligibility"))).toHaveLength(2); // one retry only
    expect(await S.loadJwt(user, w.address)).not.toBe(first.jwt);
  });

  it("rejected session and re-auth impossible: error carries the per-wallet reason", async () => {
    const w = mk(8, false);
    const bad = jwtFor(3000);
    os.rejectJwts.add(bad);
    await expect(S.eligibilityWithReauth(user, w, bad, "drop", { serverSign: true })).rejects.toMatchObject({ signInReason: "no_signer" });
  });

  it("429 on OpenSea auth is retried (Retry-After) and succeeds; persistent 429 reports rate_limited", async () => {
    const w = mk(9);
    os.fail429.nonce = 1;
    os.fail429.verify = 1;
    expect((await S.walletJwt(user, w, { serverSign: true })).via).toBe("signin");
    const w2 = mk(10);
    os.fail429.nonce = 99;
    expect(await S.walletJwt(user, w2, { serverSign: true })).toEqual({ jwt: null, reason: "rate_limited" });
  });

  it("wallet without the sign-in signer reports no_signer (and Privy is never asked to sign anything else)", async () => {
    const w = mk(11, false);
    expect(await S.walletJwt(user, w, { serverSign: true })).toEqual({ jwt: null, reason: "no_signer" });
    expect(signCalls).toEqual([w.privyWalletId]);
  });

  it("another member never gets this wallet's PAT or JWT", async () => {
    const w = mk(12);
    await S.walletJwt(user, w, { serverSign: true });
    forgetMemory(w.address);
    expect(await S.loadJwt("someone-else", w.address)).toBeNull();
    expect(await S.loadPat("someone-else", w.address)).toBeNull();
  });

  it("parallel checks never run more than one full sign-in at a time", async () => {
    const ws = [mk(13), mk(14), mk(15), mk(16)];
    let live = 0;
    let peak = 0;
    const orig = fakeFetch;
    vi.stubGlobal("fetch", async (u: any, i: any) => {
      const nonce = String(u).endsWith("/siwe/nonce");
      if (nonce) peak = Math.max(peak, ++live);
      const r = await orig(u, i);
      if (String(u).endsWith("/auth/tokens/exchange")) live = Math.max(0, live - 1);
      return r;
    });
    const rs = await Promise.all(ws.map((w) => S.walletJwt(user, w, { serverSign: true })));
    vi.stubGlobal("fetch", fakeFetch);
    expect(rs.every((r) => r.jwt)).toBe(true);
    expect(peak).toBe(1);
  });
});

describe("/check text for wallets that still can't be verified", () => {
  it("names each wallet with its reason and the one fix", async () => {
    const { unverifiedNotes } = await import("../src/bot/check.js");
    const out = unverifiedNotes([
      { label: "wallet-5", unverifiedReason: "rate_limited" },
      { label: "Wallet 7", unverifiedReason: "rate_limited" },
      { label: "wallet-8", unverifiedReason: "no_signer" },
      { label: "x", unverifiedReason: null },
    ]).join("\n");
    expect(out).toContain("Not verified: wallet-8. Automatic checks aren't enabled");
    expect(out).toContain("Tap Open in SkyBOT once");
    expect(out).toContain("Not verified: wallet-5, Wallet 7. OpenSea is rate-limiting");
    expect(out).toContain("Not verified: x. SkyBOT couldn't sign these wallets in");
    expect(out).not.toMatch(/Open SkyBOT once and future checks/);
  });
});
