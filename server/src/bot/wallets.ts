// SPDX-License-Identifier: AGPL-3.0-only
import { nativeText } from "../util/native.js";
import { esc, shortAddr } from "./format.js";

export interface WalletLine {
  label: string;
  address: string;
  isMain: boolean;
}
export interface ChainBalance {
  address: string;
  chain: string;
  symbol: string;
  wei: bigint | null;
}

/**
 * One block per wallet. Non-zero balances stay per chain with that chain's symbol.
 * Different native coins are never added together.
 */
export function formatWalletBalances(wallets: WalletLine[], rows: ChainBalance[]): string {
  return wallets
    .map((w) => {
      const mine = rows.filter((r) => r.address.toLowerCase() === w.address.toLowerCase());
      const held = mine.filter((r) => r.wei !== null && r.wei > 0n);
      const unread = mine.filter((r) => r.wei === null).length;
      const lines = held.map((r) => `${nativeText(r.wei!, r.symbol)} on ${esc(r.chain)}`);
      if (!lines.length) lines.push(unread ? "Balance unavailable" : "No native balance");
      else if (unread) lines.push(`${unread} chain${unread === 1 ? "" : "s"} unread`);
      return `${w.isMain ? "★ " : ""}<b>${esc(w.label)}</b>\n<code>${shortAddr(w.address)}</code>\n${lines.join("\n")}`;
    })
    .join("\n\n");
}
