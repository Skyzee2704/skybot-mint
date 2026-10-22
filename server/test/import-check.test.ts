// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { Wallet } from "ethers";

delete process.env.PRIVY_APP_ID;
delete process.env.PRIVY_APP_SECRET;
delete process.env.NEXT_PUBLIC_PRIVY_APP_ID;

const me = "did:privy:me";
const other = "did:privy:other";

async function proof(w: Wallet, issuedAt = new Date().toISOString()) {
  const { importCheckMessage } = await import("../src/users/importCheck.js");
  return { address: w.address, issuedAt, signature: await w.signMessage(importCheckMessage(w.address, issuedAt)) };
}

describe("import check (archived / existing wallets in Privy)", () => {
  const w = Wallet.createRandom();

  it("rejects missing, foreign, tampered or expired proofs before asking Privy", async () => {
    const { importPreflight } = await import("../src/users/importCheck.js");
    let asked = 0;
    const lookup = async () => (asked++, { found: false as const });
    const someoneElse = Wallet.createRandom();
    const p = await proof(w);
    await expect(importPreflight(me, { ...p, address: someoneElse.address }, { lookup })).rejects.toMatchObject({ statusCode: 400 });
    await expect(importPreflight(me, { ...(await proof(someoneElse)), address: w.address }, { lookup })).rejects.toMatchObject({
      statusCode: 400,
    });
    await expect(importPreflight(me, { ...p, issuedAt: new Date(Date.now() - 3_600_000).toISOString() }, { lookup })).rejects.toMatchObject(
      {
        statusCode: 400,
      },
    );
    await expect(importPreflight(me, { ...p, signature: "0x" + "11".repeat(65) }, { lookup })).rejects.toMatchObject({ statusCode: 400 });
    expect(asked).toBe(0);
  });

  it("archived in another account: explains Privy keeps it reserved", async () => {
    const { importPreflight, IMPORT_CHECK_MESSAGES } = await import("../src/users/importCheck.js");
    const r = await importPreflight(me, await proof(w), {
      lookup: async () => ({ found: true, id: "wid", archived: true, ownerPrivyUserId: other }),
    });
    expect(r).toMatchObject({ status: "archived_other", address: w.address, message: IMPORT_CHECK_MESSAGES.archived_other });
    expect(r.message).toMatch(/another SkyBOT Mint account/);
    expect(r.message).toMatch(/can't be imported again/);
    expect(r).not.toHaveProperty("privyWalletId"); // never hand out another member's wallet id
  });

  it("archived in this account, or with an unknown owner", async () => {
    const { importPreflight } = await import("../src/users/importCheck.js");
    const mine = await importPreflight(me, await proof(w), {
      lookup: async () => ({ found: true, id: "wid", archived: true, ownerPrivyUserId: me }),
    });
    expect(mine.status).toBe("archived_yours");
    const unknownOwner = await importPreflight(me, await proof(w), {
      lookup: async () => ({ found: true, id: "wid", archived: true, ownerPrivyUserId: null }),
    });
    expect(unknownOwner.status).toBe("archived_other");
  });

  it("active in another account: no hijack, no wallet id", async () => {
    const { importPreflight } = await import("../src/users/importCheck.js");
    const r = await importPreflight(me, await proof(w), {
      lookup: async () => ({ found: true, id: "wid", archived: false, ownerPrivyUserId: other }),
      mine: async () => null,
    });
    expect(r.status).toBe("other_account");
    expect(r).not.toHaveProperty("privyWalletId");
  });

  it("active in this account (entity or linked accounts): add back without importing", async () => {
    const { importPreflight } = await import("../src/users/importCheck.js");
    const byEntity = await importPreflight(me, await proof(w), {
      lookup: async () => ({ found: true, id: "wid", archived: false, ownerPrivyUserId: me }),
      mine: async () => null,
    });
    expect(byEntity).toMatchObject({ status: "in_your_account", privyWalletId: "wid" });
    const byLink = await importPreflight(me, await proof(w), {
      lookup: async () => ({ found: true, id: "wid", archived: false, ownerPrivyUserId: null }),
      mine: async () => ({ id: "wid2", source: "imported" as const, createdAt: null }),
    });
    expect(byLink).toMatchObject({ status: "in_your_account", privyWalletId: "wid2" });
  });

  it("not in Privy → available; Privy unreachable → unknown (normal import continues)", async () => {
    const { importPreflight } = await import("../src/users/importCheck.js");
    expect((await importPreflight(me, await proof(w), { lookup: async () => ({ found: false }) })).status).toBe("available");
    expect((await importPreflight(me, await proof(w), { lookup: async () => null })).status).toBe("unknown");
    // Telegram-only members (no Privy user) never match "yours".
    const tg = await importPreflight("tg:1", await proof(w), {
      lookup: async () => ({ found: true, id: "wid", archived: true, ownerPrivyUserId: "tg:1" }),
    });
    expect(tg.status).toBe("archived_other");
  });

  it("server and web build the same check message", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const web = fs.readFileSync(path.resolve(__dirname, "../../web/lib/importCheck.ts"), "utf8");
    const srv = fs.readFileSync(path.resolve(__dirname, "../src/users/importCheck.ts"), "utf8");
    const tpl = (s: string) => s.match(/return `(\$\{IMPORT_CHECK_TITLE\}[^`]*)`;/)?.[1];
    expect(tpl(web)).toBeTruthy();
    expect(tpl(web)).toBe(tpl(srv));
    expect(web).toContain('IMPORT_CHECK_TITLE = "SkyBOT Mint import check"');
  });

  it("the import-check route requires a session and a well-formed signature", async () => {
    const src = (await import("node:fs")).readFileSync(new URL("../src/api/server.ts", import.meta.url), "utf8");
    expect(src).toMatch(/a\.post\("\/api\/wallets\/import-check"/);
    expect(src).toMatch(/signature: z\.string\(\)\.regex\(\/\^0x\[0-9a-fA-F\]\{130\}\$\/\)/);
  });
});
