// SPDX-License-Identifier: AGPL-3.0-only
import { formatEther } from "ethers";

/** Human amount plus the chain's native symbol. Never invents a symbol. */
export function nativeText(wei: bigint, symbol: string): string {
  const neg = wei < 0n;
  const s = formatEther(neg ? -wei : wei);
  const [i, d = ""] = s.split(".");
  const frac = d.slice(0, 8).replace(/0+$/, "");
  const n = `${neg ? "-" : ""}${frac ? `${i}.${frac}` : i}`;
  return symbol ? `${n} ${symbol}` : n;
}
