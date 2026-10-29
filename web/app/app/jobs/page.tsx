"use client";
// SPDX-License-Identifier: AGPL-3.0-only
import { Fragment, useEffect, useState } from "react";
import { strategyLabel } from "@/lib/labels";
import { useApi } from "@/components/AppShell";
import { short } from "@/lib/api";
import { formatDateTime, formatShort, localTimeZone } from "@/lib/time";
import { useNow } from "@/lib/useNow";

const STATUS: Record<string, string> = {
  scheduled: "Scheduled",
  waiting_unlock: "Waiting",
  running: "Running",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};
const RESULT: Record<string, string> = {
  pending: "Pending",
  signed: "Signed",
  broadcast: "Sent",
  confirmed: "Confirmed",
  reverted: "Reverted",
  failed: "Failed",
  timeout: "Timed out",
};
const ISO_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;

export default function JobsPage() {
  const api = useApi();
  const [jobs, setJobs] = useState<any[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tz, setTz] = useState<string | undefined>(undefined);
  useEffect(() => setTz(localTimeZone()), []);
  const now = useNow(1000);
  const fmt = (w: string) => formatDateTime(w, { timeZone: tz, now });
  const load = () =>
    api("/api/jobs")
      .then((r) => setJobs(r.jobs))
      .catch((e) => setErr(e.message));
  // Poll fast only while a job is active and the tab is visible; otherwise slow down (DB reads, no RPC).
  const active = jobs.some((j) => ["scheduled", "waiting_unlock", "running"].includes(j.status));
  useEffect(() => {
    load();
  }, []); // eslint-disable-line
  useEffect(() => {
    const i = setInterval(
      () => {
        if (document.visibilityState === "visible") load();
      },
      active ? 3000 : 30_000,
    );
    return () => clearInterval(i);
  }, [active]); // eslint-disable-line
  return (
    <div className="card">
      <h2>Jobs</h2>
      {err && <div className="err">{err}</div>}
      <table>
        <thead>
          <tr>
            <th>When</th>
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
                <td>
                  {j.runAt && ["scheduled", "waiting_unlock"].includes(j.status) ? (
                    <>
                      Runs {fmt(j.runAt)}
                      <div className="muted small">created {fmt(j.createdAt)}</div>
                    </>
                  ) : (
                    fmt(j.createdAt)
                  )}
                </td>
                <td className={j.status === "done" ? "ok" : j.status === "failed" ? "bad" : "warn"}>{STATUS[j.status] ?? j.status}</td>
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
                            <td>
                              {RESULT[r.status] ?? r.status}
                              {r.error && <div className="err">{r.error}</div>}
                            </td>
                            <td>
                              {r.txHash ? (
                                <a className="mono" href={r.explorer} target="_blank" rel="noreferrer">
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
                      {(j.log || []).map((l: string) => l.replace(ISO_RE, (m) => formatShort(m, { timeZone: tz }))).join("\n")}
                    </pre>
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
          {!jobs.length && (
            <tr>
              <td colSpan={7} className="muted">
                No jobs yet. Simulate and confirm a mint on the Mint page to create one.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
