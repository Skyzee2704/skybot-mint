// SPDX-License-Identifier: AGPL-3.0-only
"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useLang } from "@/lib/i18n";

/**
 * Scrollable container with an obvious "more below" hint and a visible
 * scroll indicator. On phones the native scrollbar is hidden until the
 * user actually scrolls, so a scrollbar alone doesn't tell anyone the
 * list continues — this shows:
 *  - a gradient fade + a "scroll down" pill at the bottom edge while
 *    there is still content below, and
 *  - a custom orange scroll thumb on a bordered dark track at the right
 *    edge (touch devices only; desktop keeps the native orange
 *    scrollbar, which is draggable there).
 * Both only appear when the content actually overflows (few items =
 * no scroll = no hint, no thumb) and the hint disappears once the
 * user reaches the bottom.
 */
export function ScrollArea({ className, children, hint }: { className?: string; children: ReactNode; hint?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [showHint, setShowHint] = useState(false);
  const [metrics, setMetrics] = useState({ scrollTop: 0, scrollHeight: 0, clientHeight: 0 });
  const { t } = useLang();
  const update = () => {
    const el = ref.current;
    if (!el) return;
    const { scrollTop, scrollHeight, clientHeight } = el;
    setMetrics({ scrollTop, scrollHeight, clientHeight });
    setShowHint(scrollHeight - scrollTop - clientHeight > 8);
  };
  useEffect(() => {
    update();
    const el = ref.current;
    if (!el) return;
    el.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, []);
  // Re-check when the list changes (loaded, filtered, selected).
  useEffect(update);
  const overflow = metrics.scrollHeight > metrics.clientHeight + 8;
  const thumbH = overflow ? Math.max(metrics.clientHeight / metrics.scrollHeight, 0.12) : 0;
  const thumbTop =
    overflow && metrics.scrollHeight > metrics.clientHeight
      ? (metrics.scrollTop / (metrics.scrollHeight - metrics.clientHeight)) * (1 - thumbH)
      : 0;
  return (
    <div className="scroll-area-wrap">
      <div ref={ref} className={className} onScroll={update}>
        {children}
      </div>
      {overflow && (
        <div className="scroll-track" aria-hidden>
          <div className="scroll-thumb" style={{ height: `${thumbH * 100}%`, top: `${thumbTop * 100}%` }} />
        </div>
      )}
      {showHint && (
        <div className="scroll-hint" aria-hidden>
          <span className="scroll-hint-arrow">↓</span> {hint ?? t("Scroll down for more")}
        </div>
      )}
    </div>
  );
}
