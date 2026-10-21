"use client";
// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from "react";

/** Current time, re-rendered every `ms` (for live countdowns). */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}
