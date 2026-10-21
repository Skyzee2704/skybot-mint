import { AbiCoder, id, TransactionReceipt } from "ethers";
import type { RpcPool } from "../rpc/pool.js";

const T721 = id("Transfer(address,address,uint256)");
const T1155_SINGLE = id("TransferSingle(address,address,address,uint256,uint256)");
const T1155_BATCH = id("TransferBatch(address,address,address,uint256[],uint256[])");
const topicAddr = (t: string) => ("0x" + t.slice(26)).toLowerCase();

/** Token IDs minted (from == 0x0) to `wallet` by `contract` in a receipt. Handles ERC-721 and ERC-1155. */
export function parseMintedTokenIds(logs: readonly { address: string; topics: readonly string[]; data: string }[], contract: string, wallet: string): string[] {
  const out: string[] = []; const c = contract.toLowerCase(); const w = wallet.toLowerCase();
  const zero = "0x" + "0".repeat(40);
  for (const l of logs) {
    if (l.address.toLowerCase() !== c) continue;
    const t0 = l.topics[0];
    if (t0 === T721 && l.topics.length === 4) {
      if (topicAddr(l.topics[1]) === zero && topicAddr(l.topics[2]) === w) out.push(BigInt(l.topics[3]).toString());
    } else if (t0 === T1155_SINGLE && l.topics.length === 4) {
      if (topicAddr(l.topics[2]) === zero && topicAddr(l.topics[3]) === w) {
        const [tid] = AbiCoder.defaultAbiCoder().decode(["uint256", "uint256"], l.data);
        out.push(BigInt(tid).toString());
      }
    } else if (t0 === T1155_BATCH && l.topics.length === 4) {
      if (topicAddr(l.topics[2]) === zero && topicAddr(l.topics[3]) === w) {
        const [ids] = AbiCoder.defaultAbiCoder().decode(["uint256[]", "uint256[]"], l.data);
        for (const x of ids) out.push(BigInt(x).toString());
      }
    }
  }
  return out;
}

export async function waitForReceipt(pool: RpcPool, hash: string, timeoutMs = 180_000, pollMs = 1500): Promise<TransactionReceipt | null> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try { const r = await pool.read((p) => p.getTransactionReceipt(hash), "receipt"); if (r) return r; } catch { /* rotate & keep polling */ }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return null;
}
