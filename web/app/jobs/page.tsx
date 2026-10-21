"use client";
import { Fragment, useEffect, useState } from "react";
import { api, short } from "@/lib/api";

export default function JobsPage() {
  const [jobs, setJobs] = useState<any[]>([]); const [open, setOpen] = useState<string | null>(null); const [err, setErr] = useState<string | null>(null);
  const load = () => api("/api/jobs").then((r) => setJobs(r.jobs)).catch((e) => setErr(e.message));
  useEffect(() => { setOpen(new URLSearchParams(window.location.search).get("id")); load(); const i = setInterval(load, 3000); return () => clearInterval(i); }, []);
  return (
    <div className="card"><h2>Jobs</h2>
      {err && <div className="err">{err}</div>}
      <table><thead><tr><th>Created</th><th>Status</th><th>Chain</th><th>Contract</th><th>Strategy</th><th>Run at</th><th>Results</th><th></th></tr></thead>
        <tbody>{jobs.map((j) => (<Fragment key={j.id}>
          <tr onClick={() => setOpen(open === j.id ? null : j.id)} style={{ cursor: "pointer" }}>
            <td>{new Date(j.createdAt).toLocaleString()}</td>
            <td className={j.status === "done" ? "ok" : j.status === "failed" ? "bad" : "warn"}>{j.status}</td>
            <td>{j.chain}</td><td className="mono">{short(j.target)}</td><td>{j.strategy}</td>
            <td>{j.runAt ? new Date(j.runAt).toLocaleString() : "now"}</td>
            <td>{j.results.filter((r: any) => r.status === "confirmed").length}/{j.results.length || j.request?.wallets?.length || 0} confirmed</td>
            <td>{["scheduled", "waiting_unlock"].includes(j.status) && <button className="secondary" onClick={(e) => { e.stopPropagation(); api(`/api/jobs/${j.id}/cancel`, { body: {} }).then(load); }}>Cancel</button>}</td>
          </tr>
          {open === j.id && <tr><td colSpan={8}>
            {j.error && <div className="err">{j.error}</div>}
            <table><thead><tr><th>Wallet</th><th>Qty</th><th>Status</th><th>Tx</th><th>Token IDs</th><th>Error</th></tr></thead>
              <tbody>{j.results.map((r: any) => <tr key={r.walletId}><td className="mono">{short(r.address)}</td><td>{r.quantity}</td><td>{r.status}</td>
                <td>{r.txHash ? <a className="mono" href={r.explorer} target="_blank">{short(r.txHash)}</a> : "—"}</td>
                <td className="mono">{r.tokenIds?.join(", ") || "—"}</td><td className="bad">{r.error ?? ""}</td></tr>)}</tbody></table>
            <pre className="mono muted" style={{ whiteSpace: "pre-wrap" }}>{j.log.join("\n")}</pre>
          </td></tr>}
        </Fragment>))}
          {!jobs.length && <tr><td colSpan={8} className="muted">No jobs yet.</td></tr>}
        </tbody></table>
    </div>
  );
}
