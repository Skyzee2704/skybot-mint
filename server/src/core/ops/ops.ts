import { Contract, Interface, formatEther, getAddress, isAddress, parseEther } from "ethers";
import { explorerTx, requireChain } from "../../config/chains.js";
import { env } from "../../config/env.js";
import { getPool } from "../rpc/pool.js";
import { wallets as walletSvc } from "../wallets/service.js";
import { getStore } from "../store.js";
import { getFees } from "../mint/fees.js";
import { waitForReceipt } from "../mint/receipts.js";
import { consumePlan, createPlan } from "../plans.js";

/* ------------------------------ Fund wallets ------------------------------ */
export interface FundPlan { chain: string; fromWalletId: string; from: string; transfers: { walletId: string; to: string; amountWei: string }[]; gasPerTx: string; maxFeePerGas: string; maxPriorityFeePerGas: string }

export async function previewFund(input: { chain: string; fromWalletId?: string; walletIds: string[]; amountEach: string; topUpTo?: boolean }) {
  const chain = requireChain(input.chain);
  const pool = getPool(chain);
  await pool.checkChainId();
  const fromId = input.fromWalletId ?? getStore().db.mainWalletId;
  if (!fromId) throw Object.assign(new Error("No main wallet set — mark one wallet as main or pass fromWalletId"), { statusCode: 400 });
  const from = walletSvc.get(fromId);
  const target = parseEther(input.amountEach);
  if (target <= 0n) throw Object.assign(new Error("amount must be > 0"), { statusCode: 400 });
  const fees = await getFees(pool, "normal");
  const gasPerTx = 21_000n;
  const transfers: FundPlan["transfers"] = [];
  for (const id of input.walletIds.filter((x) => x !== fromId)) {
    const w = walletSvc.get(id);
    let amt = target;
    if (input.topUpTo) { const bal = await pool.read((p) => p.getBalance(w.address), "balance"); amt = bal >= target ? 0n : target - bal; }
    if (amt > 0n) transfers.push({ walletId: id, to: w.address, amountWei: amt.toString() });
  }
  const total = transfers.reduce((a, t) => a + BigInt(t.amountWei), 0n);
  const gasTotal = gasPerTx * fees.maxFeePerGas * BigInt(transfers.length);
  const balance = await pool.read((p) => p.getBalance(from.address), "balance");
  const plan = createPlan<FundPlan>("fund", { chain: chain.key, fromWalletId: fromId, from: from.address, transfers, gasPerTx: gasPerTx.toString(), maxFeePerGas: fees.maxFeePerGas.toString(), maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString() }, `FUND ${transfers.length}`);
  return {
    planId: plan.id, confirmPhrase: plan.confirmPhrase, chain: chain.key, nativeSymbol: chain.nativeSymbol, from: from.address,
    transfers: transfers.map((t) => ({ ...t, amount: formatEther(t.amountWei) })), total: formatEther(total), maxGas: formatEther(gasTotal),
    fromBalance: formatEther(balance), sufficient: balance >= total + gasTotal,
  };
}

export async function executeFund(planId: string, phrase: string) {
  const plan = consumePlan<FundPlan>(planId, "fund", phrase).data;
  const chain = requireChain(plan.chain);
  const pool = getPool(chain);
  await pool.checkChainId();
  const signer = walletSvc.signer(plan.fromWalletId);
  let nonce = await pool.read((p) => p.getTransactionCount(signer.address, "pending"), "nonce");
  const results = [];
  for (const t of plan.transfers) {
    // Sequential nonces from the single funding wallet; broadcast each to all RPCs.
    const raw = await signer.signTransaction({ type: 2, chainId: chain.chainId, nonce: nonce++, to: t.to, value: BigInt(t.amountWei), gasLimit: BigInt(plan.gasPerTx), maxFeePerGas: BigInt(plan.maxFeePerGas), maxPriorityFeePerGas: BigInt(plan.maxPriorityFeePerGas), data: "0x" });
    const b = await pool.broadcast(raw);
    results.push({ to: t.to, amount: formatEther(t.amountWei), txHash: b.hash, explorer: explorerTx(chain, b.hash), accepted: b.accepted.length > 0, error: b.accepted.length ? null : b.errors[0]?.error ?? "rejected" });
  }
  return { results };
}

/* --------------------------- Sweep NFTs to vault --------------------------- */
const ERC721 = ["function ownerOf(uint256) view returns (address)", "function safeTransferFrom(address from, address to, uint256 tokenId)", "function balanceOf(address) view returns (uint256)", "function tokenOfOwnerByIndex(address,uint256) view returns (uint256)", "function supportsInterface(bytes4) view returns (bool)"];
const ERC1155 = ["function balanceOf(address,uint256) view returns (uint256)", "function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes data)"];
export interface SweepPlan { chain: string; contract: string; vault: string; standard: "erc721" | "erc1155"; items: { walletId: string; from: string; tokenId: string; amount: string }[]; maxFeePerGas: string; maxPriorityFeePerGas: string }

export async function previewSweep(input: { chain: string; contract: string; walletIds: string[]; vault?: string; tokenIds?: string[] }) {
  const chain = requireChain(input.chain);
  const pool = getPool(chain);
  await pool.checkChainId();
  const vaultRaw = input.vault ?? env.vaultAddress;
  if (!vaultRaw || !isAddress(vaultRaw)) throw Object.assign(new Error("Vault address missing/invalid (set VAULT_ADDRESS or pass vault)"), { statusCode: 400 });
  const vault = getAddress(vaultRaw);
  if (walletSvc.byAddress(vault) && input.walletIds.includes(walletSvc.byAddress(vault)!.id)) throw Object.assign(new Error("Vault cannot be one of the source wallets"), { statusCode: 400 });
  const contract = getAddress(input.contract);
  const is721 = await pool.read((p) => new Contract(contract, ERC721, p).supportsInterface("0x80ac58cd").catch(() => false), "supportsInterface");
  const standard: SweepPlan["standard"] = is721 ? "erc721" : "erc1155";
  const items: SweepPlan["items"] = [];
  for (const id of input.walletIds) {
    const w = walletSvc.get(id);
    const known = new Set<string>(input.tokenIds ?? getStore().db.minted.filter((m) => m.chain === chain.key && m.contract.toLowerCase() === contract.toLowerCase() && m.wallet.toLowerCase() === w.address.toLowerCase()).flatMap((m) => m.tokenIds));
    if (standard === "erc721") {
      if (!known.size) { // try ERC721Enumerable
        try {
          const c = new Contract(contract, ERC721, pool.endpoints[0].provider);
          const n = Number(await pool.read((p) => (c.connect(p) as Contract).balanceOf(w.address), "balanceOf"));
          for (let i = 0; i < Math.min(n, 200); i++) known.add((await pool.read((p) => (c.connect(p) as Contract).tokenOfOwnerByIndex(w.address, i), "tokenOfOwnerByIndex")).toString());
        } catch { /* not enumerable */ }
      }
      for (const tid of known) {
        const owner = await pool.read((p) => new Contract(contract, ERC721, p).ownerOf(tid), "ownerOf").catch(() => null);
        if (owner && owner.toLowerCase() === w.address.toLowerCase()) items.push({ walletId: id, from: w.address, tokenId: tid, amount: "1" });
      }
    } else {
      for (const tid of known) {
        const bal = await pool.read((p) => new Contract(contract, ERC1155, p).balanceOf(w.address, tid), "balanceOf1155").catch(() => 0n);
        if (bal > 0n) items.push({ walletId: id, from: w.address, tokenId: tid, amount: bal.toString() });
      }
    }
  }
  const fees = await getFees(pool, "normal");
  const plan = createPlan<SweepPlan>("sweep", { chain: chain.key, contract, vault, standard, items, maxFeePerGas: fees.maxFeePerGas.toString(), maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString() }, `SWEEP ${items.length} TO ${vault.slice(0, 6)}`);
  return { planId: plan.id, confirmPhrase: plan.confirmPhrase, chain: chain.key, contract, vault, standard, items, note: items.length ? null : "No owned tokens found (provide tokenIds if the contract is not enumerable and was not minted by this app)" };
}

export async function executeSweep(planId: string, phrase: string) {
  const plan = consumePlan<SweepPlan>(planId, "sweep", phrase).data;
  const chain = requireChain(plan.chain);
  const pool = getPool(chain);
  await pool.checkChainId();
  const iface = new Interface(plan.standard === "erc721" ? ERC721 : ERC1155);
  const byWallet = new Map<string, SweepPlan["items"]>();
  plan.items.forEach((it) => byWallet.set(it.walletId, [...(byWallet.get(it.walletId) ?? []), it]));
  const results: any[] = [];
  await Promise.all([...byWallet.entries()].map(async ([walletId, items]) => {
    const signer = walletSvc.signer(walletId);
    let nonce = await pool.read((p) => p.getTransactionCount(signer.address, "pending"), "nonce");
    for (const it of items) {
      const data = plan.standard === "erc721"
        ? iface.encodeFunctionData("safeTransferFrom", [it.from, plan.vault, BigInt(it.tokenId)])
        : iface.encodeFunctionData("safeTransferFrom", [it.from, plan.vault, BigInt(it.tokenId), BigInt(it.amount), "0x"]);
      let gasLimit = 120_000n;
      try { gasLimit = ((await pool.read((p) => p.estimateGas({ from: it.from, to: plan.contract, data }), "estimateGas")) * 130n) / 100n; } catch { /* use default */ }
      const raw = await signer.signTransaction({ type: 2, chainId: chain.chainId, nonce: nonce++, to: plan.contract, data, value: 0n, gasLimit, maxFeePerGas: BigInt(plan.maxFeePerGas), maxPriorityFeePerGas: BigInt(plan.maxPriorityFeePerGas) });
      const b = await pool.broadcast(raw);
      results.push({ from: it.from, tokenId: it.tokenId, txHash: b.hash, explorer: explorerTx(chain, b.hash), accepted: b.accepted.length > 0, error: b.accepted.length ? null : b.errors[0]?.error ?? "rejected" });
    }
  }));
  // Confirm in background-ish (bounded) so the dashboard can show status
  await Promise.all(results.filter((r) => r.accepted).map(async (r) => { const rec = await waitForReceipt(pool, r.txHash, 90_000); r.status = rec ? (rec.status === 1 ? "confirmed" : "reverted") : "pending"; }));
  return { results };
}
