"use client";
// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from "react";
import { useApi } from "@/components/AppShell";

export default function AdminPage() {
  const api = useApi();
  const [users, setUsers] = useState<any[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const load = () =>
    api("/api/admin/users")
      .then((r) => setUsers(r.users))
      .catch((e) => setErr(e.message));
  useEffect(() => {
    load();
  }, []); // eslint-disable-line
  return (
    <div className="card">
      <h2>Admin · Users</h2>
      {err && <div className="err">{err}</div>}
      <table>
        <thead>
          <tr>
            <th>Email</th>
            <th>Role</th>
            <th>Wallets</th>
            <th>Jobs</th>
            <th>Telegram</th>
            <th>Last Seen</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td>
                {u.email ?? u.id.slice(0, 8)} {u.disabled && <span className="pill">disabled</span>}
              </td>
              <td>{u.role}</td>
              <td>{u.walletCount}</td>
              <td>{u.jobCount}</td>
              <td>{u.telegramLinked ? `@${u.telegramUsername || "linked"}` : "—"}</td>
              <td className="muted">{new Date(u.lastSeenAt).toLocaleString()}</td>
              <td>
                {u.role !== "admin" && (
                  <button
                    className="ghost"
                    onClick={() => api(`/api/admin/users/${u.id}/disable`, { body: { disabled: !u.disabled } }).then(load)}
                  >
                    {u.disabled ? "Enable" : "Disable"}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
