// SPDX-License-Identifier: AGPL-3.0-only
/**
 * For transactions we build ourselves, an eth_call probe starts about a second before T0.
 * The T0 broadcast does not wait for it. If that send is refused because the stage is not
 * live yet, the same signed transaction is sent again once the probe passes.
 */

/** How long before T0 the eth_call loop starts. */
export const SIM_LEAD_MS = 1_000;
/** Gap between eth_call attempts. */
export const SIM_INTERVAL_MS = 50;

const NOT_LIVE =
  /not active|not started|has not started|not live|too early|before the start|mint ?not ?started|dropstage|timestamp too early|sale (is )?not (open|started)/i;

export function isStageNotLive(text: string): boolean {
  return NOT_LIVE.test(text);
}

export interface StageProbe {
  /** Resolves true once eth_call stops reverting for "not live". */
  wait(): Promise<boolean>;
}

/**
 * Starts the probe without blocking the caller. `call` should perform the eth_call and
 * throw when the stage is not live yet.
 */
export function startStageProbe(opts: {
  fireAt: number;
  deadline: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  call: () => Promise<void>;
}): StageProbe {
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms))));
  let passed = false;
  let settled = false;
  const waiters: Array<(ok: boolean) => void> = [];
  const finish = (ok: boolean) => {
    if (settled) return;
    settled = true;
    passed = ok;
    while (waiters.length) waiters.shift()!(ok);
  };
  void (async () => {
    const begin = opts.fireAt - SIM_LEAD_MS;
    if (now() < begin) await sleep(begin - now());
    while (!settled && now() < opts.deadline) {
      try {
        await opts.call();
        finish(true);
        return;
      } catch (e: any) {
        const msg = String(e?.shortMessage ?? e?.message ?? e);
        if (!isStageNotLive(msg)) {
          finish(false);
          return;
        }
      }
      if (now() >= opts.deadline) break;
      await sleep(Math.min(SIM_INTERVAL_MS, Math.max(0, opts.deadline - now())));
    }
    finish(false);
  })();
  return {
    wait: () => (settled ? Promise.resolve(passed) : new Promise((resolve) => waiters.push(resolve))),
  };
}

/**
 * First send is always attempted immediately. A second send happens only after the probe
 * passes and only when the first refusal looks like "stage not live yet".
 */
export async function sendWhenLive<T extends { ok: boolean; errors: string[] }>(
  send: () => Promise<T>,
  ready: StageProbe | undefined,
): Promise<T> {
  const first = await send();
  if (first.ok || !ready || !isStageNotLive(first.errors.join(" "))) return first;
  if (!(await ready.wait())) return first;
  return send();
}
