"use client";
// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from "react";
import { useApi } from "@/components/AppShell";
import { useLang } from "@/lib/i18n";
import { formatDateTime } from "@/lib/time";

export default function AdminPage() {
  const api = useApi();
  const { t } = useLang();
  const [users, setUsers] = useState<any[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [keys, setKeys] = useState<any[] | null>(null);
  const [keyErr, setKeyErr] = useState<string | null>(null);
  const load = () =>
    api("/api/admin/users")
      .then((r) => setUsers(r.users))
      .catch((e) => setErr(e.message));
  useEffect(() => {
    load();
  }, []); // eslint-disable-line
  return (
    <div className="card">
      <h2>{t("Admin · Users")}</h2>
      <p>
        <button
          className="ghost"
          onClick={() => {
            setKeyErr(null);
            api("/api/admin/opensea-keys/test", { method: "POST" })
              .then((r) => setKeys(r.keys))
              .catch((e) => setKeyErr(e.message));
          }}
        >
          {t("Test OpenSea keys")}
        </button>
      </p>
      {keyErr && <div className="err">{keyErr}</div>}
      {keys && (
        <p className="muted">
          {keys.length
            ? keys
                .map(
                  (k) =>
                    `key ${k.index}: ${k.ok ? `${k.latencyMs}ms` : k.error} remaining ${k.remaining ?? "?"}/${k.limit ?? "?"} cooldown ${Math.ceil((k.cooldownMs ?? 0) / 1000)}s`,
                )
                .join(" · ")
            : t("No OpenSea API keys configured.")}
        </p>
      )}
      {err && <div className="err">{err}</div>}
      <table>
        <thead>
          <tr>
            <th>{t("Email")}</th>
            <th>{t("Role")}</th>
            <th>{t("Wallets")}</th>
            <th>{t("Jobs")}</th>
            <th>Telegram</th>
            <th>{t("Last Seen")}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td>
                {u.email ?? u.id.slice(0, 8)} {u.disabled && <span className="pill">{t("disabled")}</span>}
              </td>
              <td>{u.role}</td>
              <td>{u.walletCount}</td>
              <td>{u.jobCount}</td>
              <td>{u.telegramLinked ? `@${u.telegramUsername || t("linked")}` : "—"}</td>
              <td className="muted">{u.lastSeenAt ? formatDateTime(u.lastSeenAt) : "—"}</td>
              <td>
                {u.role !== "admin" && (
                  <button
                    className="ghost"
                    onClick={() => api(`/api/admin/users/${u.id}/disable`, { body: { disabled: !u.disabled } }).then(load)}
                  >
                    {u.disabled ? t("Enable") : t("Disable")}
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
