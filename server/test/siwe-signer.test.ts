// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, describe, expect, it, vi } from "vitest";

const store: Record<string, any> = {};
const update = vi.fn(async (id: string, p: any) => ({ id, ...p }));
vi.mock("../src/auth/privy.js", () => ({
  getPrivy: () => ({ wallets: () => ({ get: async (id: string) => store[id], update }) }),
}));

describe("sign-in-only signer attach", () => {
  beforeEach(() => {
    process.env.PRIVY_APP_ID = "app";
    process.env.PRIVY_APP_SECRET = "secret";
    process.env.PRIVY_SIWE_AUTH_PRIVATE_KEY = "k";
    process.env.PRIVY_SIWE_KEY_QUORUM_ID = "quorum1";
    process.env.PRIVY_SIWE_POLICY_ID = "policy1";
    delete process.env.PRIVY_AUTH_PRIVATE_KEY;
    delete process.env.PRIVY_AUTH_KEY_QUORUM_ID;
    update.mockClear();
  });

  it("no-op when the quorum is already a signer", async () => {
    const { ensureSignerOnWallet } = await import("../src/users/siweSigner.js");
    store.w1 = { id: "w1", owner_id: "user-owner", additional_signers: [{ signer_id: "quorum1", override_policy_ids: ["policy1"] }] };
    expect(await ensureSignerOnWallet("w1", "jwt")).toBe("already");
    expect(update).not.toHaveBeenCalled();
  });

  it("user-owned wallet without the member's token: Privy needs the owner's authorization", async () => {
    const { ensureSignerOnWallet } = await import("../src/users/siweSigner.js");
    store.w2 = { id: "w2", owner_id: "user-owner", additional_signers: [] };
    expect(await ensureSignerOnWallet("w2", null)).toBe("needs_owner");
    expect(update).not.toHaveBeenCalled();
  });

  it("with the member's access token: adds only the sign-in quorum + policy and keeps existing signers", async () => {
    const { ensureSignerOnWallet } = await import("../src/users/siweSigner.js");
    store.w3 = { id: "w3", owner_id: "user-owner", additional_signers: [{ signer_id: "other", override_policy_ids: ["p9"] }] };
    expect(await ensureSignerOnWallet("w3", "user-jwt")).toBe("attached");
    const [id, body] = update.mock.calls[0]!;
    expect(id).toBe("w3");
    expect(body.authorization_context).toEqual({ user_jwts: ["user-jwt"] });
    expect(body.additional_signers).toEqual([
      { signer_id: "other", override_policy_ids: ["p9"] },
      { signer_id: "quorum1", override_policy_ids: ["policy1"] },
    ]);
    expect(body.owner).toBeUndefined();
    expect(body.owner_id).toBeUndefined();
  });

  it("app-owned (key quorum) wallet can be updated offline with the app key", async () => {
    process.env.PRIVY_AUTH_PRIVATE_KEY = "appkey";
    process.env.PRIVY_AUTH_KEY_QUORUM_ID = "appquorum";
    const { ensureSignerOnWallet } = await import("../src/users/siweSigner.js");
    store.w4 = { id: "w4", owner_id: "appquorum", additional_signers: [] };
    expect(await ensureSignerOnWallet("w4", null)).toBe("attached");
    expect(update.mock.calls[0]![1].authorization_context).toEqual({ authorization_private_keys: ["appkey"] });
  });

  it("recognises real Privy wallet ids vs stored addresses", async () => {
    const { looksLikePrivyWalletId } = await import("../src/users/siweSigner.js");
    expect(looksLikePrivyWalletId("0x668B4B1631c9cE86175Af9ED7ac344f0f79927A0")).toBe(false);
    expect(looksLikePrivyWalletId("nf4at5ep4y3kh67plz432adk")).toBe(true);
    expect(looksLikePrivyWalletId(null)).toBe(false);
  });
});
