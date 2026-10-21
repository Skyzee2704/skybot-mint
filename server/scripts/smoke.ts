/**
 * Read-only smoke test: never signs or sends transactions.
 *  1. every configured chain: eth_chainId check through the pool + SeaDrop eth_getCode
 *  2. resolve a known SeaDrop drop, a slug and a generic contract
 * Run: ENV_FILES=/path/to/rpc.env npm run smoke
 */
import { CHAINS, rpcsForChain } from "../src/config/chains.js";
import { getPool } from "../src/core/rpc/pool.js";
import { SEADROP_ADDRESS } from "../src/core/resolver/seadrop.js";
import { resolveTarget } from "../src/core/resolver/resolver.js";
import { formatEther } from "ethers";

const short = (t: any) => ({
  chain: t.chain.key, contract: t.contract, kind: t.kind, name: t.name, standard: t.standard, slug: t.slug,
  strategy: t.recommendedStrategy, supply: t.supply,
  stages: t.stages.map((s: any) => `${s.name} | ${s.priceWei !== null ? formatEther(s.priceWei) : "?"} | ${s.status} | ${s.start ?? "-"}`),
  generic: t.generic ? { abiSource: t.generic.abiSource, selected: t.generic.selected?.signature ?? null, candidates: t.generic.candidates.map((c: any) => `${c.signature}${c.supported ? "" : " (" + c.reason + ")"}`), price: t.generic.values.priceWei } : null,
  warnings: t.warnings,
});

async function main() {
  console.log("== chain health ==");
  await Promise.all(CHAINS.map(async (c) => {
    const pool = getPool(c);
    const r = rpcsForChain(c);
    try {
      const id = await pool.checkChainId();
      const code = await pool.read((p) => p.getCode(SEADROP_ADDRESS), "getCode");
      console.log(`${c.key.padEnd(10)} chainId=${id} ok | private=${r.hasPrivate} read=${r.read.length} send=${r.send.length} | SeaDrop ${code.length > 2 ? `deployed (${(code.length - 2) / 2} bytes)` : "NOT deployed"}`);
    } catch (e: any) { console.log(`${c.key.padEnd(10)} FAILED: ${String(e.message).replace(/https?:\/\/\S+/g, "<rpc>")}`); }
    const bad = pool.status().filter((s) => s.disabled || s.failures);
    if (bad.length) console.log(`   endpoint issues: ${bad.map((b) => `${b.url}: ${b.lastError}`).join("; ")}`);
  }));

  const cases = [
    { input: "0x06ea2bf75bedc071be4c20361656c665145b38d4", chain: "ethereum", note: "SeaDrop (plop-fun)" },
    { input: "https://opensea.io/collection/plop-fun", note: "slug via OpenSea" },
    { input: "0xBd3531dA5CF5857e7CfAA92426877b022e612cf8", chain: "ethereum", note: "generic (Pudgy Penguins)" },
  ];
  for (const c of cases) {
    console.log(`\n== resolve: ${c.note} ==`);
    try { console.log(JSON.stringify(short(await resolveTarget({ input: c.input, chain: c.chain })), null, 2)); }
    catch (e: any) { console.log("ERROR:", String(e.message).replace(/https?:\/\/\S+/g, "<rpc>")); }
  }
}
main().then(() => process.exit(0));
