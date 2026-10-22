"use client";
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * NFT grid for the NFTs page: small thumbnails, lazy images (IntersectionObserver + loading=lazy) inside fixed
 * aspect-ratio boxes (no layout shift), and window virtualization when the list is large, so hundreds of NFTs
 * render only what's on screen.
 */
import { useWindowVirtualizer } from "@tanstack/react-virtual";
import { Grid2x2, Grid3x3, LayoutGrid, List, Columns4 } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";

export const VIRTUALIZE_AT = 60;
const GAP = 10;

/** NFT list layout: one per row (list) or a grid with a fixed number of columns. Saved per device. */
export type NftLayout = "list" | 2 | 3 | 4 | 5;
export const NFT_LAYOUTS: NftLayout[] = ["list", 2, 3, 4, 5];
const LAYOUT_KEY = "skybot:nft-layout";
export const parseLayout = (v: unknown): NftLayout | null =>
  v === "list" ? "list" : [2, 3, 4, 5].includes(Number(v)) ? (Number(v) as NftLayout) : null;
export const colsOf = (l: NftLayout) => (l === "list" ? 1 : l);

export function useNftLayout(): [NftLayout, (l: NftLayout) => void] {
  const [layout, setLayout] = useState<NftLayout>(3);
  useEffect(() => {
    let saved: NftLayout | null = null;
    try {
      saved = parseLayout(localStorage.getItem(LAYOUT_KEY));
    } catch {
      /* storage blocked */
    }
    setLayout(saved ?? (window.innerWidth < 640 ? 2 : 4));
  }, []);
  const set = useCallback((l: NftLayout) => {
    setLayout(l);
    try {
      localStorage.setItem(LAYOUT_KEY, String(l));
    } catch {
      /* storage blocked */
    }
  }, []);
  return [layout, set];
}

const LAYOUT_ICON = { list: List, 2: Grid2x2, 3: Grid3x3, 4: Columns4, 5: LayoutGrid } as const;
const LAYOUT_LABEL = { list: "List", 2: "2 per row", 3: "3 per row", 4: "4 per row", 5: "5 per row" } as const;

/** Compact segmented control: List, 2, 3, 4 or 5 per row (active option in brand orange). */
export function LayoutPicker({ value, onChange }: { value: NftLayout; onChange: (l: NftLayout) => void }) {
  return (
    <div className="segmented layout-picker" role="radiogroup" aria-label="Layout">
      {NFT_LAYOUTS.map((l) => {
        const Icon = LAYOUT_ICON[l];
        return (
          <button
            key={String(l)}
            type="button"
            role="radio"
            aria-checked={value === l}
            aria-label={LAYOUT_LABEL[l]}
            title={LAYOUT_LABEL[l]}
            className={value === l ? "on" : ""}
            onClick={() => onChange(l)}
          >
            <Icon size={15} aria-hidden />
            {l !== "list" && <span className="layout-n">{l}</span>}
          </button>
        );
      })}
    </div>
  );
}

/** Container class for a layout: list rows, or a fixed-column grid (dense styles at 4 and 5 per row). */
export const gridClass = (l: NftLayout) => (l === "list" ? "nft-grid nft-list" : `nft-grid cols-${l}${l >= 4 ? " dense" : ""}`);

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
  layout = 3,
}: {
  groups: [string, T[]][];
  header: (g: string, items: T[]) => ReactNode;
  card: (item: T) => ReactNode;
  layout?: NftLayout;
}) {
  const total = groups.reduce((s, [, xs]) => s + xs.length, 0);
  const cols = colsOf(layout);
  if (total < VIRTUALIZE_AT)
    return (
      <>
        {groups.map(([g, items]) => (
          <div key={g} style={{ marginTop: 16 }}>
            {header(g, items)}
            <div className={gridClass(layout)} style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
              {items.map(card)}
            </div>
          </div>
        ))}
      </>
    );
  return <Virtual groups={groups} header={header} card={card} layout={layout} />;
}

/** Row-based window virtualization: one virtual row = one header or `cols` cards (1 in list layout). */
function Virtual<T extends { key: string }>({
  groups,
  header,
  card,
  layout,
}: {
  groups: [string, T[]][];
  header: (g: string, items: T[]) => ReactNode;
  card: (item: T) => ReactNode;
  layout: NftLayout;
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
  const cols = colsOf(layout);
  const cardW = width ? (width - GAP * (cols - 1)) / cols : 170;
  const rows = useMemo(() => {
    const out: Row<T>[] = [];
    for (const [g, items] of groups) {
      out.push({ type: "h", g, items });
      for (let i = 0; i < items.length; i += cols) out.push({ type: "r", g, items: items.slice(i, i + cols), idx: i });
    }
    return out;
  }, [groups, cols]);
  // Estimates only (rows are measured); list rows are a thumbnail + text, grid rows a square image + meta.
  const rowH = layout === "list" ? 88 + GAP : cardW + 16 + (cols >= 4 ? 56 : 92) + GAP;
  const v = useWindowVirtualizer({
    count: rows.length,
    estimateSize: (i) => (rows[i].type === "h" ? 52 : rowH),
    overscan: layout === "list" ? 8 : 3,
    scrollMargin: top,
    getItemKey: (i) => (rows[i].type === "h" ? `h:${rows[i].g}` : `r:${rows[i].g}:${(rows[i] as any).idx}:${cols}`),
  });
  useEffect(() => v.measure(), [layout]); // eslint-disable-line react-hooks/exhaustive-deps
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
                  className={gridClass(layout)}
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
