// SPDX-License-Identifier: AGPL-3.0-only
/** Verify Upstash-Signature on QStash deliveries (current + next signing keys, body hash, url). */
import { env } from "../config/env.js";

export async function verifyQStash(signature: string | null, rawBody: string, url?: string): Promise<boolean> {
  const cur = env.qstashCurrentSigningKey,
    next = env.qstashNextSigningKey;
  if (!cur || !next || !signature) return false;
  const { Receiver } = await import("@upstash/qstash");
  try {
    return await new Receiver({ currentSigningKey: cur, nextSigningKey: next }).verify({
      signature,
      body: rawBody,
      ...(url ? { url } : {}),
      clockTolerance: 5,
    });
  } catch {
    return false;
  }
}
