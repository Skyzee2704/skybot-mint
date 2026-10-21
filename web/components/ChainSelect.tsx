"use client";
import { useEffect, useState } from "react";
import { useApi } from "./AppShell";
export function useChains() {
  const api = useApi();
  const [chains, setChains] = useState<{ key: string; name: string; nativeSymbol: string }[]>([]);
  useEffect(() => { api("/api/status").then((s) => setChains(s.chains)).catch(() => {}); }, []); // eslint-disable-line
  return chains;
}
export function ChainSelect({ value, onChange, allowAuto = false }: { value: string; onChange: (v: string) => void; allowAuto?: boolean }) {
  const chains = useChains();
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} style={{ width: "auto", minWidth: 140 }}>
      {allowAuto && <option value="">Auto-detect</option>}
      {chains.map((c) => <option key={c.key} value={c.key}>{c.name}</option>)}
    </select>
  );
}
