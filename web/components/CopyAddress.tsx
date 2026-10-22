"use client";
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Copy-address button: copies the FULL EIP-55 checksummed address. Tries the async Clipboard API, then a hidden
 * textarea + execCommand("copy") (Telegram in-app webviews often block the Clipboard API), and finally shows the
 * address in a selectable toast so the user can copy it by hand. Never triggers the surrounding row / label / summary.
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Copy, X } from "lucide-react";
import { getAddress } from "viem";

const checksum = (a: string) => {
  try {
    return getAddress(a);
  } catch {
    return a;
  }
};

function legacyCopy(text: string): boolean {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;font-size:16px";
  document.body.appendChild(ta);
  const sel = document.getSelection();
  const prev = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
  ta.focus();
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  document.body.removeChild(ta);
  if (prev && sel) {
    sel.removeAllRanges();
    sel.addRange(prev);
  }
  return ok;
}

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  return legacyCopy(text);
}

export function CopyAddress({ address, className }: { address?: string | null; className?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "manual">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastRef = useRef<HTMLDivElement>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  useEffect(() => {
    if (state !== "manual") return;
    // Pre-select the address so a long-press / Ctrl+C copies it.
    const el = toastRef.current?.querySelector(".copy-toast-addr");
    if (el) {
      const r = document.createRange();
      r.selectNodeContents(el);
      const s = document.getSelection();
      s?.removeAllRanges();
      s?.addRange(r);
    }
  }, [state]);
  if (!address) return null;
  const full = checksum(address);

  const onClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault(); // don't toggle a wrapping <label>/<summary>
    if (timer.current) clearTimeout(timer.current);
    if (await copyText(full)) {
      setState("copied");
      timer.current = setTimeout(() => setState("idle"), 1500);
    } else setState("manual");
  };
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();

  return (
    <>
      <button
        type="button"
        className={`copy-addr${state === "copied" ? " copied" : ""}${className ? ` ${className}` : ""}`}
        aria-label={state === "copied" ? "Address copied" : "Copy address"}
        title={state === "copied" ? "Copied" : "Copy address"}
        onClick={onClick}
        onPointerDown={stop}
        onMouseDown={stop}
        onKeyDown={stop}
      >
        {state === "copied" ? <Check size={16} strokeWidth={2.6} aria-hidden /> : <Copy size={16} aria-hidden />}
        {state === "copied" && <span className="copy-addr-label">Copied</span>}
      </button>
      <span className="sr-only" aria-live="polite">
        {state === "copied" ? "Address copied" : ""}
      </span>
      {state === "manual" &&
        typeof document !== "undefined" &&
        createPortal(
          <div className="copy-toast" role="dialog" aria-label="Copy address manually" ref={toastRef} onClick={stop}>
            <div className="copy-toast-head">
              <span>Copying isn&apos;t available here. Select the address and copy it:</span>
              <button type="button" className="copy-toast-close" aria-label="Close" onClick={() => setState("idle")}>
                <X size={18} aria-hidden />
              </button>
            </div>
            <div className="copy-toast-addr mono">{full}</div>
          </div>,
          document.body,
        )}
    </>
  );
}
