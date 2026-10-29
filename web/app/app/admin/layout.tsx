"use client";
// SPDX-License-Identifier: AGPL-3.0-only
import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/app/admin", label: "Users" },
  { href: "/app/admin/gallery", label: "Gallery" },
];

/** Admin sub-navigation (Users · Gallery). Every admin API is gated server-side; this is only navigation. */
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  return (
    <>
      <nav className="segmented admin-tabs" aria-label="Admin">
        {TABS.map((t) => (
          <Link key={t.href} href={t.href} className={path === t.href ? "on" : ""} aria-current={path === t.href ? "page" : undefined}>
            {t.label}
          </Link>
        ))}
      </nav>
      {children}
    </>
  );
}
