"use client";
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * NFT grid for the NFTs page: small thumbnails, lazy images (IntersectionObserver + loading=lazy) inside fixed
 * aspect-ratio boxes (no layout shift), and window virtualization when the list is large, so hundreds of NFTs
 * render only what's on screen.
 */
import { useWindowVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";

export const VIRTUALIZE_AT = 60;
const CARD_MIN = 170;
const GAP = 10;

/** Smaller image for grids: OpenSea CDN size params, Cloudinary (Alchemy) transformation; others unchanged. */
export function thumb(url: string | null, px = 256): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (/(^|\.)seadn\.io$/.test(u.hostname)) {
      u.searchParams.set("w", String(px));
      u.searchParams.set("auto", "format");
      return u.toString();
    }
    if (
      u.hostname === "res.cloudinary.com" &&
      u.pathname.includes("/image/upload/") &&
      !/\/upload\/(thumbnailv2|[a-z]_)/.test(u.pathname)
    ) {
      u.pathname = u.pathname.replace("/image/upload/", `/image/upload/w_${px},h_${px},c_fill,f_auto/`);
      return u.toString();
    }
  } catch {
    return null;
  }
  return url;
}

/** Loads the image only when it is near the viewport; fades in, never changes the box size. */
export function LazyImg({ src }: { src: string }) {
  const ref = useRef<HTMLImageElement>(null);
  const [show, setShow] = useState(false);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") return setShow(true);
    const io = new IntersectionObserver(
      (es) => {
        if (es.some((e) => e.isIntersecting)) {
          setShow(true);
          io.disconnect();
        }
      },
      { rootMargin: "400px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <img
      ref={ref}
      src={show ? src : undefined}
      alt=""
      loading="lazy"
      decoding="async"
      width={256}
      height={256}
      referrerPolicy="no-referrer"
      onLoad={() => setLoaded(true)}
      style={{ opacity: loaded ? 1 : 0, transition: "opacity .2s" }}
    />
  );
}

type Row<T> = { type: "h"; g: string; items: T[] } | { type: "r"; g: string; items: T[]; idx: number };

export function NftGrid<T extends { key: string }>({
  groups,
  header,
  card,
}: {
  groups: [string, T[]][];
  header: (g: string, items: T[]) => ReactNode;
  card: (item: T) => ReactNode;
}) {
  const total = groups.reduce((s, [, xs]) => s + xs.length, 0);
  if (total < VIRTUALIZE_AT)
    return (
      <>
        {groups.map(([g, items]) => (
          <div key={g} style={{ marginTop: 16 }}>
            {header(g, items)}
            <div className="nft-grid">{items.map(card)}</div>
          </div>
        ))}
      </>
    );
  return <Virtual groups={groups} header={header} card={card} />;
}

function Virtual<T extends { key: string }>({
  groups,
  header,
  card,
}: {
  groups: [string, T[]][];
  header: (g: string, items: T[]) => ReactNode;
  card: (item: T) => ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [top, setTop] = useState(0);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => {
      setWidth(el.clientWidth);
      setTop(el.getBoundingClientRect().top + window.scrollY);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const cols = Math.max(1, Math.floor((width + GAP) / (CARD_MIN + GAP)));
  const cardW = width ? (width - GAP * (cols - 1)) / cols : CARD_MIN;
  const rows = useMemo(() => {
    const out: Row<T>[] = [];
    for (const [g, items] of groups) {
      out.push({ type: "h", g, items });
      for (let i = 0; i < items.length; i += cols) out.push({ type: "r", g, items: items.slice(i, i + cols), idx: i });
    }
    return out;
  }, [groups, cols]);
  const v = useWindowVirtualizer({
    count: rows.length,
    estimateSize: (i) => (rows[i].type === "h" ? 52 : cardW + 16 + 92 + GAP),
    overscan: 3,
    scrollMargin: top,
    getItemKey: (i) => (rows[i].type === "h" ? `h:${rows[i].g}` : `r:${rows[i].g}:${(rows[i] as any).idx}:${cols}`),
  });
  return (
    <div ref={box} style={{ marginTop: 8 }}>
      <div style={{ height: v.getTotalSize(), position: "relative" }}>
        {v.getVirtualItems().map((r) => {
          const row = rows[r.index];
          return (
            <div
              key={r.key}
              data-index={r.index}
              ref={v.measureElement}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${r.start - v.options.scrollMargin}px)`,
              }}
            >
              {row.type === "h" ? (
                <div style={{ paddingTop: 16 }}>{header(row.g, row.items)}</div>
              ) : (
                <div
                  className="nft-grid"
                  style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, marginTop: 0, paddingBottom: GAP }}
                >
                  {row.items.map(card)}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
