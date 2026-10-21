"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
export function useChains() {
  const [chains, setChains] = useState<{ key: string; name: string; nativeSymbol: string; seadrop: boolean }[]>([]);
  useEffect(() => { api("/api/status").then((s) => setChains(s.chains)).catch(() => {}); }, []);
  return chains;
}
export function ChainSelect({ value, onChange, allowAuto = false }: { value: string; onChange: (v: string) => void; allowAuto?: boolean }) {
  const chains = useChains();
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      {allowAuto && <option value="">Auto-detect chain</option>}
      {chains.map((c) => <option key={c.key} value={c.key}>{c.name}</option>)}
    </select>
  );
}
