"use client";
// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useState } from "react";
import { useTelegram } from "@/lib/telegram";

/**
 * Checkbox confirm with an inline action button at the end of the card (web and Mini App alike).
 * Telegram's native MainButton is not used: Telegram draws it outside the page, below our fixed tab bar.
 */
export function ConfirmBox({
  statement,
  label,
  onConfirm,
}: {
  /** What the member confirms, e.g. "I confirm this will broadcast real transactions (2 mints, est. cost up to 0.01 ETH)". */
  statement: string;
  label: string;
  onConfirm: () => Promise<void> | void;
}) {
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const { haptic } = useTelegram();
  const go = useCallback(async () => {
    if (!checked || busy) return;
    setBusy(true);
    try {
      await onConfirm();
      haptic("success");
    } catch {
      haptic("error");
    } finally {
      setBusy(false);
    }
  }, [checked, busy, onConfirm, haptic]);
  return (
    <div className="notice confirm-box">
      <label className="confirm-check">
        <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
        <span>{statement}</span>
      </label>
      <button className="danger confirm-action" disabled={!checked || busy} onClick={go}>
        {busy ? "Sending…" : label}
      </button>
    </div>
  );
}
