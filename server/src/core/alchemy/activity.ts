// SPDX-License-Identifier: AGPL-3.0-only
/** Reads of wallet_activity (written by the Alchemy webhook). */
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../../db/client.js";
import { walletActivity } from "../../db/schema.js";

/** Last webhook-reported activity per lower-case address on a chain (empty map when none / on DB errors). */
export async function activitySince(chain: string, addresses: string[]): Promise<Map<string, number>> {
  const ids = [...new Set(addresses.map((a) => `${chain}:${a.toLowerCase()}`))];
  if (!ids.length) return new Map();
  try {
    const rows = await getDb()
      .select({ address: walletActivity.address, at: walletActivity.at })
      .from(walletActivity)
      .where(and(eq(walletActivity.chain, chain), inArray(walletActivity.id, ids)));
    return new Map(rows.map((r) => [r.address, Number(r.at)]));
  } catch {
    return new Map();
  }
}
