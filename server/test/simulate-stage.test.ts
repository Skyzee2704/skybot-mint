// SPDX-License-Identifier: AGPL-3.0-only
/**
 * F-N1 (round 3): simulateMint must judge a mint-API 200 the same way the live executor
 * does. Before the fix it called buildMintTx WITHOUT fireAt, so an unverifiable 200
 * (OpenSea names no stage) was trusted in simulation while the executor throws
 * WRONG_STAGE before T0 — simulate said "ok" and the job then failed at the start.
 * Fake OpenSea + fake pool, no network, no tx.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const addr = (i: number) => "0x" + (i + 1).toString(16).padStart(40, "0");

vi.mock("../src/config/chains.js", async () => {
  const a = await vi.importActual<any>("../src/config/chains.js");
  return {
    ...a,
    requireChain: () => ({ key: "sim", chainId: 1, name: "Sim", nativeSymbol: "ETH", explorer: "" }),
  };
});
vi.mock("../src/core/rpc/pool.js", () => ({
  getPool: () => ({
    checkChainId: async () => {},
    read: async (_fn: any, kind: string) => {
      if (kind === "nonce") return 7;
      if (kind === "estimateGas") return 100_000n;
      if (kind === "balance") return 10n ** 18n;
      throw new Error("unexpected read " + kind);
    },
  }),
}));
vi.mock("../src/core/rpc/multicall.js", () => ({
  nativeBalancesBatch: async (_pool: any, addrs: string[]) => new Map(addrs.map((a) => [a.toLowerCase(), 10n ** 18n])),
}));
vi.mock("../src/core/mint/fees.js", () => ({
  getFeesCached: async () => ({ maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, capped: false }),
  getFees: async () => ({ maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }),
  jobFeesIfFresh: () => null,
  feesMoved: () => false,
  rememberJobFees: () => {},
}));
vi.mock("../src/users/service.js", () => ({
  getWallet: async (_u: string, id: string) => ({ id, address: addr(Number(id.slice(1))), label: id, privyWalletId: "pw-" + id }),
}));
vi.mock("../src/core/safety/safety.js", () => ({
  assertDailyBudget: async () => {},
  recordSpend: async () => {},
  settleSpend: async () => {},
  assertSafeMintTx: async () => {},
  isDangerousFunctionName: () => false,
  capsFor: async () => ({ maxDailySpendWei: null, maxPricePerNftWei: null }),
  dailySpent: async () => 0n,
  fmtCap: (x: any) => String(x ?? ""),
}));
vi.mock("../src/core/mint/access.js", () => ({
  simulateIgnoringBalance: async () => ({ ok: true, reason: null }),
  getMerkleInfo: async () => null,
  merkleAccess: () => null,
  readableAllowListTx: async () => null,
}));
vi.mock("../src/core/mint/eligibility.js", () => ({
  savedStageRows: async (_userId: string, _t: any, ws: any[]) =>
    ws.map((w) => ({
      walletId: w.id,
      label: w.label,
      address: w.address,
      stages: [{ label: "GTD Round", type: "signed", eligible: true, maxPerWallet: 2 }],
    })),
}));
vi.mock("../src/plans.js", () => ({
  createPlan: async () => ({ id: "plan-1", confirmPhrase: "CONFIRM" }),
}));
vi.mock("../src/core/resolver/opensea.js", () => {
  class OpenSeaHttpError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.name = "OpenSeaHttpError";
      this.status = status;
    }
  }
  class OpenSeaClient {
    get available() {
      return true;
    }
    async buildMint() {
      // Blank 200: OpenSea names NO stage for this mint.
      return { to: "0x" + "a".repeat(40), data: "0x" + "cc".repeat(20), value: "0x0", chain: "sim" };
    }
  }
  return { OpenSeaClient, OpenSeaHttpError };
});

function makeTarget(chosenStart: string) {
  return {
    chain: { key: "sim" },
    contract: "0x" + "c".repeat(40),
    input: "fake-drop",
    slug: "fake-drop",
    name: "Fake",
    symbol: "FAKE",
    standard: "erc721",
    kind: "seadrop",
    stages: [
      {
        name: "GTD Round",
        type: "allowlist",
        uuid: "uuid-gtd",
        priceWei: "100",
        start: chosenStart,
        end: null,
        maxPerWallet: 2,
        status: "upcoming",
        source: "opensea",
      },
    ],
    seadrop: null,
    generic: null,
    kalos: null,
    opensea: { apiKey: true, drop: null, error: null, url: null },
    supply: { total: null, max: null, remaining: null },
    recommendedStrategy: "opensea_api",
    warnings: [],
    resolvedAt: new Date().toISOString(),
  };
}

describe("simulateMint stage verification (F-N1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("a blank (unnamed-stage) 200 before T0 is 'stage hasn't started yet', not a green sim", async () => {
    const { simulateMint } = await import("../src/core/mint/simulate.js");
    const runAt = new Date(Date.now() + 60_000).toISOString();
    const t: any = makeTarget(runAt);
    const req: any = {
      chain: "sim",
      contract: t.contract,
      input: "fake-drop",
      strategy: "opensea_api",
      slug: "fake-drop",
      stage: "GTD Round",
      wallets: [{ walletId: "w0", quantity: 1 }],
    };
    const out = await simulateMint(t, req, "u");
    const row = out.rows.find((r) => r.walletId === "w0")!;
    expect(row).toBeDefined();
    // The executor would throw WRONG_STAGE for this 200 before T0; simulate must agree.
    expect(row.expectedRevertBeforeStart).toBe(true);
    expect(row.mintable).toBe(true); // it can mint — at the start, checked again there
    expect(row.to).toBeNull(); // no tx was trusted from the unverifiable 200
    expect(row.valueWei).toBe("100"); // chosen stage's price, not the untrusted 200
    expect(row.reason).toContain("hasn't started yet");
  });
});
