import { describe, expect, it } from "vitest";
import { CHAINS } from "../src/config/chains.js";
import { PRIVY_CHAINS } from "../../web/lib/privyChains.js";
import { SigningError, assertSignableChain, withSignTimeout } from "../../web/lib/signing.js";

describe("browser signing guards", () => {
  it("configures every SkyBOT chain in Privy (Ink/Robinhood/Arc are not Privy defaults)", () => {
    const ids = new Set(PRIVY_CHAINS.map((c) => c.id));
    for (const c of CHAINS) {
      expect(ids.has(c.chainId)).toBe(true);
      const chain = PRIVY_CHAINS.find((x) => x.id === c.chainId)!;
      expect(chain.rpcUrls.default.http.length).toBeGreaterThan(0);
      // Never ship keyed RPC URLs to the browser.
      expect(chain.rpcUrls.default.http.join(" ")).not.toMatch(/alchemy|infura|\/v2\//i);
    }
    for (const id of [57073, 4663, 5042]) expect(() => assertSignableChain(id)).not.toThrow();
    expect(() => assertSignableChain(999999)).toThrow(SigningError);
  });

  it("times out a signature that never settles", async () => {
    const never = new Promise<string>(() => {});
    await expect(withSignTimeout(never, { ms: 20 })).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  it("stops on abort and passes through results/errors", async () => {
    const ac = new AbortController();
    const p = withSignTimeout(new Promise<string>(() => {}), { ms: 10_000, signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toMatchObject({ code: "CANCELLED" });
    await expect(withSignTimeout(Promise.resolve("sig"), { ms: 50 })).resolves.toBe("sig");
    await expect(withSignTimeout(Promise.reject(new Error("user rejected")), { ms: 50 })).rejects.toThrow("user rejected");
  });
});
