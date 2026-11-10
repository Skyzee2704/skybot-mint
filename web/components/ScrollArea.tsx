// SPDX-License-Identifier: AGPL-3.0-only
"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useLang } from "@/lib/i18n";

/**
 * Scrollable container with an obvious "more below" hint. On phones the
 * native scrollbar is hidden until the user actually scrolls, so a
 * scrollbar alone doesn't tell anyone the list continues — this shows a
 * gradient fade + a "scroll down" pill at the bottom edge while there is
 * still content below. The hint only appears when the content actually
 * overflows (few items = no scroll = no hint) and disappears once the
 * user reaches the bottom.
 */
export function ScrollArea({ className, children, hint }: { className?: string; children: ReactNode; hint?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [showHint, setShowHint] = useState(false);
  const { t } = useLang();
  const update = () => {
    const el = ref.current;
    if (!el) return;
    setShowHint(el.scrollHeight - el.scrollTop - el.clientHeight > 8);
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
  return (
    <div className="scroll-area-wrap">
      <div ref={ref} className={className} onScroll={update}>
        {children}
      </div>
      {showHint && (
        <div className="scroll-hint" aria-hidden>
          <span className="scroll-hint-arrow">↓</span> {hint ?? t("Scroll down for more")}
        </div>
      )}
    </div>
  );
}
