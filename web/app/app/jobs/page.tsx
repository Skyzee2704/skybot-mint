"use client";
// SPDX-License-Identifier: AGPL-3.0-only
import { Fragment, useEffect, useState } from "react";
import { strategyLabel } from "@/lib/labels";
import { useApi } from "@/components/AppShell";
import { short } from "@/lib/api";

export default function JobsPage() {
  const api = useApi();
  const [jobs, setJobs] = useState<any[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = () =>
    api("/api/jobs")
      .then((r) => setJobs(r.jobs))
      .catch((e) => setErr(e.message));
  useEffect(() => {
    load();
    const i = setInterval(load, 3000);
    return () => clearInterval(i);
  }, []); // eslint-disable-line
  return (
    <div className="card">
      <h2>Jobs</h2>
      {err && <div className="err">{err}</div>}
      <table>
        <thead>
          <tr>
            <th>Created</th>
            <th>Status</th>
            <th>Chain</th>
            <th>Contract</th>
            <th>Strategy</th>
            <th>Results</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((j) => (
            <Fragment key={j.id}>
              <tr onClick={() => setOpen(open === j.id ? null : j.id)} style={{ cursor: "pointer" }}>
                <td>{new Date(j.createdAt).toLocaleString()}</td>
                <td className={j.status === "done" ? "ok" : j.status === "failed" ? "bad" : "warn"}>{j.status}</td>
                <td>{j.chain}</td>
                <td className="mono">{short(j.target)}</td>
                <td>{strategyLabel(j.strategy)}</td>
                <td>
                  {(j.results || []).length
                    ? `${(j.results || []).filter((r: any) => r.status === "confirmed").length}/${(j.results || []).length} confirmed`
                    : "—"}
                </td>
                <td>
                  {["scheduled", "waiting_unlock"].includes(j.status) && (
                    <button
                      className="ghost"
                      onClick={(e) => {
                        e.stopPropagation();
                        api(`/api/jobs/${j.id}/cancel`, { body: {} }).then(load);
                      }}
                    >
                      Cancel
                    </button>
                  )}
                </td>
              </tr>
              {open === j.id && (
                <tr>
                  <td colSpan={7}>
                    {j.error && <div className="err">{j.error}</div>}
                    <table>
                      <thead>
                        <tr>
                          <th>Wallet</th>
                          <th>Qty</th>
                          <th>Status</th>
                          <th>Tx</th>
                          <th>Token IDs</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(j.results || []).map((r: any) => (
                          <tr key={r.walletId}>
                            <td className="mono">{short(r.address)}</td>
                            <td>{r.quantity}</td>
                            <td>{r.status}</td>
                            <td>
                              {r.txHash ? (
                                <a className="mono" href={r.explorer} target="_blank">
                                  {short(r.txHash)}
                                </a>
                              ) : (
                                "—"
                              )}
                            </td>
                            <td className="mono">{r.tokenIds?.join(", ") || "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <pre className="mono muted" style={{ whiteSpace: "pre-wrap" }}>
                      {(j.log || []).join("\n")}
                    </pre>
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
          {!jobs.length && (
            <tr>
              <td colSpan={7} className="muted">
                No jobs yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
