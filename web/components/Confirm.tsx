"use client";
import { useCallback, useState } from "react";
import { useTelegram, useTelegramMainButton } from "@/lib/telegram";

/** Typed-phrase confirm. Inside Telegram the native MainButton becomes the confirm button. */
export function ConfirmBox({ phrase, label, onConfirm }: { phrase: string; label: string; onConfirm: (typed: string) => Promise<void> | void }) {
  const [typed, setTyped] = useState(""); const [busy, setBusy] = useState(false);
  const { isMiniApp, haptic } = useTelegram();
  const go = useCallback(async () => {
    if (typed !== phrase || busy) return;
    setBusy(true);
    try { await onConfirm(typed); haptic("success"); } catch { haptic("error"); } finally { setBusy(false); }
  }, [typed, phrase, busy, onConfirm, haptic]);
  useTelegramMainButton({ text: busy ? "Sending…" : label, visible: isMiniApp, enabled: typed === phrase && !busy, onClick: go });
  return (
    <div className="notice">
      <div>Type <b className="mono">{phrase}</b> to confirm. This broadcasts real transactions.</div>
      <div className="row" style={{ marginTop: 8 }}>
        <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={phrase} style={{ minWidth: 200, maxWidth: 320 }} />
        {!isMiniApp && <button className="danger" disabled={typed !== phrase || busy} onClick={go}>{busy ? "Sending…" : label}</button>}
      </div>
      {isMiniApp && <p className="muted" style={{ fontSize: 12 }}>Use the orange button at the bottom to confirm.</p>}
    </div>
  );
}
