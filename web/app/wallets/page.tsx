"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, short } from "@/lib/api";
import { ChainSelect } from "@/components/ChainSelect";
import { ConfirmBox } from "@/components/Confirm";

type W = { id: string; label: string; address: string; group: string | null; source: string; isMain: boolean };

export default function WalletsPage() {
  const [data, setData] = useState<{ wallets: W[]; groups: { name: string; count: number }[] }>({ wallets: [], groups: [] });
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<string>("__all");
  const [msg, setMsg] = useState<string | null>(null); const [err, setErr] = useState<string | null>(null);
  const [chain, setChain] = useState("base"); const [balances, setBalances] = useState<Record<string, string>>({});
  const load = useCallback(() => api("/api/wallets").then(setData).catch((e) => setErr(e.message)), []);
  useEffect(() => { load(); }, [load]);
  const run = async (fn: () => Promise<any>, ok?: string) => { setErr(null); setMsg(null); try { const r = await fn(); if (ok) setMsg(ok); await load(); return r; } catch (e: any) { setErr(e.message); } };
  const shown = useMemo(() => data.wallets.filter((w) => filter === "__all" || (filter === "__none" ? !w.group : w.group === filter)), [data, filter]);
  const toggle = (id: string) => setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  // import forms
  const [key, setKey] = useState(""); const [label, setLabel] = useState(""); const [group, setGroup] = useState("");
  const [bulk, setBulk] = useState(""); const [genN, setGenN] = useState(5); const [newGroup, setNewGroup] = useState("");

  const loadBalances = async () => {
    const r = await run(() => api("/api/wallets/balances", { body: { chain } }));
    if (r) setBalances(Object.fromEntries(r.balances.map((b: any) => [b.walletId, b.balance ?? "err"])));
  };

  return (
    <>
      {err && <div className="err">{err}</div>}{msg && <div className="notice">{msg}</div>}
      <div className="card">
        <h2>Wallets ({data.wallets.length})</h2>
        <div className="row" style={{ marginBottom: 10 }}>
          <select value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="__all">All groups</option><option value="__none">No group</option>
            {data.groups.map((g) => <option key={g.name} value={g.name}>{g.name} ({g.count})</option>)}
          </select>
          <ChainSelect value={chain} onChange={setChain} /><button className="secondary" onClick={loadBalances}>Load balances</button>
          <span className="muted">{sel.size} selected</span>
          <select defaultValue="" onChange={(e) => { const g = e.target.value; e.target.value = ""; if (g) run(async () => { for (const id of sel) await api(`/api/wallets/${id}`, { method: "PATCH", body: { group: g === "__none" ? null : g } }); }, "Group updated"); }}>
            <option value="">Move selected to group…</option><option value="__none">(no group)</option>
            {data.groups.map((g) => <option key={g.name} value={g.name}>{g.name}</option>)}
          </select>
        </div>
        <table>
          <thead><tr><th><input type="checkbox" checked={shown.length > 0 && shown.every((w) => sel.has(w.id))} onChange={(e) => setSel(e.target.checked ? new Set(shown.map((w) => w.id)) : new Set())} /></th><th>Label</th><th>Address</th><th>Group</th><th>Balance</th><th></th></tr></thead>
          <tbody>
            {shown.map((w) => (
              <tr key={w.id}>
                <td><input type="checkbox" checked={sel.has(w.id)} onChange={() => toggle(w.id)} /></td>
                <td>{w.label} {w.isMain && <span className="pill ok">main</span>} <span className="muted">{w.source}</span></td>
                <td className="mono">{w.address}</td><td>{w.group ?? <span className="muted">—</span>}</td>
                <td className="mono">{balances[w.id] ?? ""}</td>
                <td className="row">
                  {!w.isMain && <button className="secondary" onClick={() => run(() => api(`/api/wallets/${w.id}/main`, { body: {} }), "Main wallet set")}>Set main</button>}
                  <button className="danger" onClick={() => { if (confirm(`Delete ${w.label} (${short(w.address)})? The encrypted key is removed permanently. Make sure you have a backup.`)) run(() => api(`/api/wallets/${w.id}`, { method: "DELETE", body: { confirm: "DELETE" } }), "Deleted"); }}>Delete</button>
                </td>
              </tr>
            ))}
            {!shown.length && <tr><td colSpan={6} className="muted">No wallets yet.</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(340px,1fr))" }}>
        <div className="card"><h2>Import one key</h2>
          <div style={{ display: "grid", gap: 8 }}>
            <input type="password" autoComplete="off" placeholder="Private key (0x…64 hex)" value={key} onChange={(e) => setKey(e.target.value)} />
            <input placeholder="Label" value={label} onChange={(e) => setLabel(e.target.value)} />
            <input placeholder="Group (optional)" value={group} onChange={(e) => setGroup(e.target.value)} />
            <button disabled={!key} onClick={() => run(() => api("/api/wallets/import", { body: { key, label, group: group || null } }), "Imported").then(() => setKey(""))}>Import</button>
          </div></div>
        <div className="card"><h2>Bulk import</h2>
          <p className="muted">One key per line, or CSV <span className="mono">label,key</span>. Invalid lines are reported by number only.</p>
          <input type="file" accept=".txt,.csv,text/plain,text/csv" onChange={async (e) => { const f = e.target.files?.[0]; if (f) setBulk(await f.text()); e.target.value = ""; }} />
          <textarea placeholder="0xabc…&#10;label2,0xdef…" value={bulk} onChange={(e) => setBulk(e.target.value)} />
          <div className="row" style={{ marginTop: 8 }}>
            <input placeholder="Group (optional)" value={group} onChange={(e) => setGroup(e.target.value)} />
            <button disabled={!bulk.trim()} onClick={async () => { const r = await run(() => api("/api/wallets/import-bulk", { body: { text: bulk, group: group || null } })); if (r) { setBulk(""); setMsg(`Imported ${r.imported}, duplicates ${r.duplicates}${r.invalidLines.length ? `, invalid lines: ${r.invalidLines.join(", ")}` : ""}`); } }}>Import all</button>
          </div></div>
        <div className="card"><h2>Generate wallets</h2>
          <div className="row">
            <input type="number" min={1} max={500} value={genN} onChange={(e) => setGenN(Number(e.target.value))} style={{ width: 90 }} />
            <input placeholder="Group (optional)" value={group} onChange={(e) => setGroup(e.target.value)} />
            <button onClick={() => run(() => api("/api/wallets/generate", { body: { count: genN, group: group || null } }), `Generated ${genN} wallets`)}>Generate</button>
          </div>
          <p className="muted">Keys are created server-side and stored encrypted; they are never shown.</p>
          <h2 style={{ marginTop: 16 }}>Groups</h2>
          <div className="row"><input placeholder="New group" value={newGroup} onChange={(e) => setNewGroup(e.target.value)} /><button className="secondary" onClick={() => run(() => api("/api/groups", { body: { name: newGroup } }), "Group created").then(() => setNewGroup(""))}>Create</button></div>
          <div style={{ marginTop: 8 }}>{data.groups.map((g) => <span key={g.name} className="pill" style={{ marginRight: 6 }}>{g.name} ({g.count}) <a href="#" onClick={(e) => { e.preventDefault(); run(() => api(`/api/groups/${encodeURIComponent(g.name)}`, { method: "DELETE" }), "Group removed"); }}>×</a></span>)}</div>
        </div>
      </div>

      <FundPanel selected={[...sel]} wallets={data.wallets} />
      <SweepPanel selected={[...sel]} />
    </>
  );
}

function FundPanel({ selected, wallets }: { selected: string[]; wallets: W[] }) {
  const [chain, setChain] = useState("base"); const [amount, setAmount] = useState("0.002"); const [topUp, setTopUp] = useState(true);
  const [plan, setPlan] = useState<any>(null); const [res, setRes] = useState<any>(null); const [err, setErr] = useState<string | null>(null);
  const main = wallets.find((w) => w.isMain);
  return (
    <div className="card"><h2>Fund wallets (distribute from main)</h2>
      <p className="muted">From: {main ? `${main.label} ${main.address}` : <span className="warn">no main wallet set</span>} → {selected.length} selected wallet(s).</p>
      <div className="row">
        <ChainSelect value={chain} onChange={setChain} />
        <input value={amount} onChange={(e) => setAmount(e.target.value)} style={{ width: 120 }} /> <span className="muted">per wallet</span>
        <label><input type="checkbox" checked={topUp} onChange={(e) => setTopUp(e.target.checked)} /> top up to this amount (skip wallets already funded)</label>
        <button disabled={!selected.length || !main} onClick={async () => { setErr(null); setRes(null); try { setPlan(await api("/api/ops/fund/preview", { body: { chain, walletIds: selected, amountEach: amount, topUpTo: topUp } })); } catch (e: any) { setErr(e.message); } }}>Preview</button>
      </div>
      {err && <div className="err">{err}</div>}
      {plan && (<div style={{ marginTop: 10 }}>
        <p>{plan.transfers.length} transfer(s), total <b>{plan.total} {plan.nativeSymbol}</b> + max gas {plan.maxGas}. Main balance {plan.fromBalance} {plan.sufficient ? <span className="ok">sufficient</span> : <span className="bad">INSUFFICIENT</span>}</p>
        <table><tbody>{plan.transfers.map((t: any) => <tr key={t.to}><td className="mono">{t.to}</td><td>{t.amount}</td></tr>)}</tbody></table>
        {plan.sufficient && plan.transfers.length > 0 && <ConfirmBox phrase={plan.confirmPhrase} label="Send funds" onConfirm={async (p) => { try { setRes(await api("/api/ops/fund/execute", { body: { planId: plan.planId, confirmPhrase: p } })); setPlan(null); } catch (e: any) { setErr(e.message); } }} />}
      </div>)}
      {res && <table><tbody>{res.results.map((r: any) => <tr key={r.txHash}><td className="mono">{r.to}</td><td>{r.amount}</td><td>{r.accepted ? <a href={r.explorer} target="_blank">tx</a> : <span className="bad">{r.error}</span>}</td></tr>)}</tbody></table>}
    </div>
  );
}

function SweepPanel({ selected }: { selected: string[] }) {
  const [chain, setChain] = useState("base"); const [contract, setContract] = useState(""); const [vault, setVault] = useState(""); const [ids, setIds] = useState("");
  const [plan, setPlan] = useState<any>(null); const [res, setRes] = useState<any>(null); const [err, setErr] = useState<string | null>(null);
  return (
    <div className="card"><h2>Sweep NFTs to vault</h2>
      <div className="row">
        <ChainSelect value={chain} onChange={setChain} />
        <input placeholder="NFT contract 0x…" value={contract} onChange={(e) => setContract(e.target.value.trim())} style={{ minWidth: 340 }} />
        <input placeholder="Vault 0x… (default VAULT_ADDRESS)" value={vault} onChange={(e) => setVault(e.target.value.trim())} style={{ minWidth: 340 }} />
        <input placeholder="Token IDs (optional, comma)" value={ids} onChange={(e) => setIds(e.target.value)} />
        <button disabled={!selected.length || !contract} onClick={async () => { setErr(null); setRes(null); try { setPlan(await api("/api/ops/sweep/preview", { body: { chain, contract, walletIds: selected, vault: vault || undefined, tokenIds: ids ? ids.split(/[,\s]+/).filter(Boolean) : undefined } })); } catch (e: any) { setErr(e.message); } }}>Preview</button>
      </div>
      {err && <div className="err">{err}</div>}
      {plan && (<div style={{ marginTop: 10 }}>
        <p>{plan.items.length} token(s) ({plan.standard}) → vault <span className="mono">{plan.vault}</span></p>
        {plan.note && <div className="notice">{plan.note}</div>}
        <table><tbody>{plan.items.map((i: any) => <tr key={i.from + i.tokenId}><td className="mono">{i.from}</td><td>#{i.tokenId}</td><td>×{i.amount}</td></tr>)}</tbody></table>
        {plan.items.length > 0 && <ConfirmBox phrase={plan.confirmPhrase} label="Sweep" onConfirm={async (p) => { try { setRes(await api("/api/ops/sweep/execute", { body: { planId: plan.planId, confirmPhrase: p } })); setPlan(null); } catch (e: any) { setErr(e.message); } }} />}
      </div>)}
      {res && <table><tbody>{res.results.map((r: any) => <tr key={r.txHash}><td className="mono">{r.from}</td><td>#{r.tokenId}</td><td>{r.accepted ? <a href={r.explorer} target="_blank">{r.status ?? "sent"}</a> : <span className="bad">{r.error}</span>}</td></tr>)}</tbody></table>}
    </div>
  );
}
