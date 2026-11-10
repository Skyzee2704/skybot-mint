"use client";
// SPDX-License-Identifier: AGPL-3.0-only
import { useState, type FormEvent } from "react";

/**
 * Display only. The POST body is empty. Wallet, destination, amount, and chain are hardcoded
 * on the server (server/src/testsend/nativeSend.ts) and are not taken from this form.
 * ETH/USD $2055.64 (CoinGecko, 10 Nov 2026) → 48646650191668 wei ≈ $0.10.
 */
const SOURCE_WALLET_ID = "tloqxjloa5jloj6dv38n0fmf";
const DESTINATION = "0xdd911fA75E72b3c11e75DCAbfaE9f60D65903877";
const VALUE_WEI = "48646650191668";
const VALUE_ETH = "0.000048646650191668";
const ETH_USD = "2055.64";

type Sent = { txHash: string; etherscan: string; from?: string; to?: string; valueWei?: string; valueEth?: string };

export function TestSendForm() {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<Sent | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setSent(null);
    setErrorText(null);
    try {
      const res = await fetch("/api/test/server-sign-native-send", {
        method: "POST",
        headers: { "x-test-send-token": token },
      });
      const text = await res.text();
      let body: any = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = null;
      }
      if (res.ok && body && typeof body.txHash === "string" && typeof body.etherscan === "string") {
        setSent(body as Sent);
      } else {
        setErrorText(text.trim() ? `HTTP ${res.status}\n${text}` : `HTTP ${res.status} (empty body)`);
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
        Draft test. One real Ethereum mainnet transfer, signed with PRIVY_SIWE_AUTH_PRIVATE_KEY. The mint signer is not used. Nothing here
        is read from the request except the token header.
      </p>
      <div className="card">
        <div className="grid">
          <div className="kv">
            <b>Source wallet</b>
            <span className="mono">{SOURCE_WALLET_ID}</span>
            <div className="muted">
              Address must start with 0xB22 and end with 4D2F. The server fetches it from Privy and aborts otherwise.
            </div>
          </div>
          <div className="kv">
            <b>Destination</b>
            <span className="mono">{DESTINATION}</span>
          </div>
          <div className="kv">
            <b>Amount</b>
            <span className="mono">{VALUE_ETH} ETH</span>
            <div className="mono">{VALUE_WEI} wei</div>
            <div className="muted">${ETH_USD}/ETH on CoinGecko, 10 Nov 2026, about $0.10. Chain id 1. Empty calldata.</div>
          </div>
        </div>
      </div>
      <form onSubmit={onSubmit} className="card">
        <label htmlFor="test-send-token">
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
          <button className="btn" type="submit" disabled={busy}>
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
          <p>
            Tx <span className="mono">{sent.txHash}</span>
          </p>
          <p>
            <a href={sent.etherscan} target="_blank" rel="noopener noreferrer">
              {sent.etherscan}
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
