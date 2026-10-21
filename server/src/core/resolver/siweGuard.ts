// SPDX-License-Identifier: AGPL-3.0-only
/**
 * HARD SAFETY GUARD for silent OpenSea sign-in signing (browser auto-sign and server signer).
 * Accepts ONLY the exact OpenSea SIWE login text for the expected wallet with a fresh issuedAt and a
 * well-formed nonce. Anything else (other domains, extra lines, typed data, hex payloads) is refused.
 * Dependency-free so the web app can import it too.
 */
export const OPENSEA_SIWE_STATEMENT =
  "Click to sign in and accept the Platform Terms of Service (https://opensea.io/tos) and Privacy Policy (https://opensea.io/privacy).";

export interface OpenSeaSiweFields {
  domain: "opensea.io";
  address: string;
  statement: string;
  uri: "https://opensea.io";
  version: "1";
  chainId: "1";
  nonce: string;
  issuedAt: string;
  accountType: "Ethereum";
}

const MAX_AGE_MS = 10 * 60_000;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const RE = new RegExp(
  "^opensea\\.io wants you to sign in with your Ethereum account:\\n(0x[0-9a-fA-F]{40})\\n\\n" +
    esc(OPENSEA_SIWE_STATEMENT) +
    "\\n\\nURI: https://opensea\\.io\\nVersion: 1\\nChain ID: 1\\nNonce: ([A-Za-z0-9-]{8,128})\\nIssued At: (\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?Z)$",
);

export class SiweGuardError extends Error {
  code = "SIWE_GUARD";
}

/** Validate the full message text; returns the parsed fields or throws SiweGuardError. */
export function assertOpenSeaSiwe(message: unknown, expectedAddress: string, nowMs = Date.now()): OpenSeaSiweFields {
  if (typeof message !== "string" || message.length > 700) throw new SiweGuardError("Refused: not an OpenSea sign-in message");
  const m = RE.exec(message);
  if (!m) throw new SiweGuardError("Refused: not an OpenSea sign-in message");
  const [, address, nonce, issuedAt] = m as unknown as [string, string, string, string];
  if (address.toLowerCase() !== String(expectedAddress).toLowerCase())
    throw new SiweGuardError("Refused: sign-in message is for a different wallet");
  const t = Date.parse(issuedAt);
  if (!Number.isFinite(t) || Math.abs(nowMs - t) > MAX_AGE_MS) throw new SiweGuardError("Refused: sign-in message is not fresh");
  return {
    domain: "opensea.io",
    address,
    statement: OPENSEA_SIWE_STATEMENT,
    uri: "https://opensea.io",
    version: "1",
    chainId: "1",
    nonce,
    issuedAt,
    accountType: "Ethereum",
  };
}

/** Fields sent with the message must describe exactly the same message. */
export function assertFieldsMatch(message: string, fields: Record<string, string>, expectedAddress: string, nowMs = Date.now()) {
  const f = assertOpenSeaSiwe(message, expectedAddress, nowMs);
  for (const k of Object.keys(f) as (keyof OpenSeaSiweFields)[])
    if (String(fields[k]) !== String(f[k])) throw new SiweGuardError(`Refused: field ${k} does not match the message`);
  return f;
}
