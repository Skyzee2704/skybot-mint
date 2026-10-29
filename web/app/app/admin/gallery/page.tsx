"use client";
// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from "react";
import { useApi, useApiBlob } from "@/components/AppShell";

type Item = { name: string; title: string; aspect: string; type: string; size: number | null };

const mb = (n: number | null) => (n == null ? "unavailable" : `${(n / 1024 / 1024).toFixed(1)} MB`);

/** One private clip: fetched with the admin's auth → Blob → object URL (playback + download). */
function Clip({ item }: { item: Item }) {
  const blob = useApiBlob();
  const [src, setSrc] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let url: string | null = null;
    let live = true;
    blob(`/api/admin/gallery/media/${encodeURIComponent(item.name)}`)
      .then((b) => {
        url = URL.createObjectURL(b);
        if (live) setSrc(url);
        else URL.revokeObjectURL(url);
      })
      .catch((e) => live && setErr(e.message));
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [item.name, blob]);
  return (
    <div className="card gallery-item">
      <h3>{item.title}</h3>
      <div className="gallery-media" style={{ aspectRatio: item.aspect }}>
        {src ? <video src={src} controls playsInline loop muted preload="metadata" /> : <span className="muted">{err ?? "Loading…"}</span>}
      </div>
      <div className="row gallery-meta">
        <span className="muted">
          {item.name} · {mb(item.size)}
        </span>
        <a
          className={`btn${src ? "" : " disabled"}`}
          href={src ?? undefined}
          download={item.name}
          aria-disabled={!src}
          onClick={(e) => !src && e.preventDefault()}
        >
          Download
        </a>
      </div>
    </div>
  );
}

export default function AdminGalleryPage() {
  const api = useApi();
  const [items, setItems] = useState<Item[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api<{ items: Item[] }>("/api/admin/gallery")
      .then((r) => setItems(r.items))
      .catch((e) => setErr(e.message));
  }, [api]);
  return (
    <div className="card">
      <h2>Admin · Gallery</h2>
      <p className="muted">Promo clips — private, admin-only. Not publicly hosted; share the downloaded file.</p>
      {err && <div className="err">{err}</div>}
      {!items && !err && <p className="muted">Loading…</p>}
      <div className="gallery-grid">
        {items?.map((i) => (
          <Clip key={i.name} item={i} />
        ))}
      </div>
    </div>
  );
}
