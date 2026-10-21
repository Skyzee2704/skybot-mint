"use client";
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Guard rails around Privy browser signing so a transfer can never hang silently:
 *  - refuse chains Privy isn't configured for (Privy would otherwise never settle the promise);
 *  - time out after SIGN_TIMEOUT_MS with a clear error, so the page can offer Retry;
 *  - let the user stop a batch (the pending signature is abandoned; nothing is broadcast without it).
 */
import { PRIVY_CHAIN_IDS } from "./privyChains";

export const SIGN_TIMEOUT_MS = 60_000;

export class SigningError extends Error {
  constructor(
    message: string,
    readonly code: "TIMEOUT" | "UNSUPPORTED_CHAIN" | "CANCELLED",
  ) {
    super(message);
  }
}

export function assertSignableChain(chainId: number) {
  if (!PRIVY_CHAIN_IDS.has(Number(chainId)))
    throw new SigningError(`Chain ${chainId} is not enabled for in-browser signing. Nothing was sent.`, "UNSUPPORTED_CHAIN");
}

/** Resolve with `p`, or reject after `ms` / when `signal` aborts. The original promise is ignored afterwards. */
export function withSignTimeout<T>(p: Promise<T>, opts: { ms?: number; signal?: AbortSignal; what?: string } = {}): Promise<T> {
  const ms = opts.ms ?? SIGN_TIMEOUT_MS;
  return new Promise<T>((resolve, reject) => {
    if (opts.signal?.aborted) return reject(new SigningError("Stopped. Nothing was sent.", "CANCELLED"));
    const t = setTimeout(
      () =>
        reject(
          new SigningError(
            `${opts.what ?? "Signing"} did not finish within ${Math.round(ms / 1000)}s. Nothing was sent. Reload the page if it keeps happening, then Retry.`,
            "TIMEOUT",
          ),
        ),
      ms,
    );
    const onAbort = () => {
      clearTimeout(t);
      reject(new SigningError("Stopped. Nothing was sent.", "CANCELLED"));
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        clearTimeout(t);
        opts.signal?.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        opts.signal?.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}
