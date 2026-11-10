"use client";
// SPDX-License-Identifier: AGPL-3.0-only
import { useState, type FormEvent } from "react";

/** Suggested starting destination. The server accepts any checksummed address. */
const DEFAULT_DESTINATION = "0xdd911fA75E72b3c11e75DCAbfaE9f60D65903877";

export interface TestSendChainOption {
  chainId: number;
  name: string;
  nativeSymbol: string;
}

type Sent = {
  txHash: string;
  explorer: string;
  from?: string;
  to?: string;
  valueWei?: string;
  valueNative?: string;
  nativeSymbol?: string;
  chainId?: number;
};

export function TestSendForm({ wallets, chains }: { wallets: string[]; chains: TestSendChainOption[] }) {
  const [walletId, setWalletId] = useState(wallets[0] ?? "");
  const [chainId, setChainId] = useState(String(chains.find((c) => c.chainId === 1)?.chainId ?? chains[0]?.chainId ?? ""));
  const [amount, setAmount] = useState("");
  const [destination, setDestination] = useState(DEFAULT_DESTINATION);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<Sent | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const chain = chains.find((c) => String(c.chainId) === chainId);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setSent(null);
    setErrorText(null);
    try {
      const res = await fetch("/api/test/server-sign-native-send", {
        method: "POST",
        headers: { "content-type": "application/json", "x-test-send-token": token },
        body: JSON.stringify({ walletId, chainId: Number(chainId), amount, destination }),
      });
      const text = await res.text();
      let body: any = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = null;
      }
      if (res.ok && body && typeof body.txHash === "string" && typeof body.explorer === "string") {
        setSent(body as Sent);
      } else {
        const from = body && typeof body.from === "string" ? `\nFrom ${body.from}` : "";
        setErrorText((text.trim() ? `HTTP ${res.status}\n${text}` : `HTTP ${res.status} (empty body)`) + from);
      }
    } catch (err) {
      setErrorText(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={{ maxWidth: 760, margin: "40px auto", padding: "0 16px 48px" }}>
      <p className="pill accent">DO NOT MERGE</p>
      <h1 style={{ marginTop: 12 }}>Server-sign native send</h1>
      <p className="warn">
        Draft test. One real native transfer, signed with PRIVY_SIWE_AUTH_PRIVATE_KEY. The mint signer is not used. There is no amount cap
        here; a Privy policy is the limit. The token stays in the request header.
      </p>
      <form onSubmit={onSubmit} className="card">
        <label htmlFor="test-send-wallet">
          <b>Source wallet</b>
        </label>
        <select id="test-send-wallet" value={walletId} onChange={(ev) => setWalletId(ev.target.value)} style={{ marginTop: 8 }}>
          {wallets.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
        <p className="muted">Allowlist from TEST_SEND_WALLET_IDS. The server fetches the address from Privy and refuses any other id.</p>

        <label htmlFor="test-send-chain">
          <b>Chain</b>
        </label>
        <select id="test-send-chain" value={chainId} onChange={(ev) => setChainId(ev.target.value)} style={{ marginTop: 8 }}>
          {chains.map((c) => (
            <option key={c.chainId} value={c.chainId}>
              {c.name} · {c.chainId} · {c.nativeSymbol}
            </option>
          ))}
        </select>

        <label htmlFor="test-send-amount" style={{ display: "block", marginTop: 14 }}>
          <b>Amount{chain ? ` (${chain.nativeSymbol})` : ""}</b>
        </label>
        <input
          id="test-send-amount"
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          placeholder="0.0005"
          value={amount}
          onChange={(ev) => setAmount(ev.target.value)}
          style={{ marginTop: 8 }}
        />

        <label htmlFor="test-send-dest" style={{ display: "block", marginTop: 14 }}>
          <b>Destination</b>
        </label>
        <input
          id="test-send-dest"
          className="mono"
          autoComplete="off"
          spellCheck={false}
          value={destination}
          onChange={(ev) => setDestination(ev.target.value)}
          style={{ marginTop: 8 }}
        />

        <label htmlFor="test-send-token" style={{ display: "block", marginTop: 14 }}>
          <b>TEST_SEND_TOKEN</b>
        </label>
        <input
          id="test-send-token"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={token}
          onChange={(ev) => setToken(ev.target.value)}
          style={{ marginTop: 8 }}
        />
        <div className="row" style={{ marginTop: 14 }}>
          <button className="btn" type="submit" disabled={busy || !wallets.length || !chains.length}>
            {busy ? "Sending…" : "Send"}
          </button>
        </div>
      </form>
      {sent && (
        <div className="card">
          <p className="ok">Broadcast accepted.</p>
          {sent.from && (
            <p>
              From <span className="mono">{sent.from}</span>
            </p>
          )}
          {sent.to && (
            <p>
              To <span className="mono">{sent.to}</span>
            </p>
          )}
          {sent.valueNative && (
            <p>
              Amount <span className="mono">{sent.valueNative}</span> {sent.nativeSymbol} ({sent.valueWei} wei)
            </p>
          )}
          <p>
            Tx <span className="mono">{sent.txHash}</span>
          </p>
          <p>
            <a href={sent.explorer} target="_blank" rel="noopener noreferrer">
              {sent.explorer}
            </a>
          </p>
        </div>
      )}
      {errorText && (
        <div className="err" role="alert">
          <b>Error</b>
          <pre className="mono" style={{ whiteSpace: "pre-wrap", margin: "8px 0 0" }}>
            {errorText}
          </pre>
        </div>
      )}
    </main>
  );
}
