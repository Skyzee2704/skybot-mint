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

type NativeRow = {
  chainId: number;
  name: string;
  nativeSymbol: string;
  balanceWei: string | null;
  balance: string | null;
  error: string | null;
};
type HeldToken = {
  chainId: number;
  chainName: string;
  address: string;
  symbol: string | null;
  name: string | null;
  decimals: number | null;
  balanceRaw: string;
  balance: string;
  source: string;
};
type HeldNft = {
  chainId: number;
  chainName: string;
  contract: string;
  tokenId: string;
  standard: "erc721" | "erc1155";
  balance: string | null;
  collection: string | null;
  name: string | null;
  image: string | null;
};
type Lookup = {
  address: string;
  native: NativeRow[];
  tokens: HeldToken[];
  nfts?: HeldNft[];
  nftDiscovery?: { note: string; errors: string[]; truncated: boolean };
  zeroReads: { chainId: number; address: string; symbol: string | null; decimals: number | null }[];
  discovery: { provider: string | null; configured: boolean; note: string; errors: string[] };
};
type Sent = {
  txHash: string;
  explorer: string;
  from?: string;
  to?: string;
  token?: string;
  contract?: string;
  tokenId?: string;
  standard?: string;
  amount?: string;
  amountRaw?: string;
  symbol?: string | null;
  valueWei?: string;
  valueNative?: string;
  nativeSymbol?: string;
};

async function postJson(url: string, token: string, body: unknown): Promise<{ ok: boolean; status: number; text: string; json: any }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-test-send-token": token },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { ok: res.ok, status: res.status, text, json };
}

export function TestSendForm({ wallets, chains }: { wallets: string[]; chains: TestSendChainOption[] }) {
  const [walletId, setWalletId] = useState(wallets[0] ?? "");
  const [chainId, setChainId] = useState(String(chains.find((c) => c.chainId === 1)?.chainId ?? chains[0]?.chainId ?? ""));
  const [mode, setMode] = useState<"native" | "erc20" | "nft">("native");
  const [amount, setAmount] = useState("");
  const [destination, setDestination] = useState(DEFAULT_DESTINATION);
  const [token, setToken] = useState("");
  const [erc20Token, setErc20Token] = useState("");
  const [paste, setPaste] = useState("");
  const [nftContract, setNftContract] = useState("");
  const [nftTokenId, setNftTokenId] = useState("");
  const [nftStandard, setNftStandard] = useState<"auto" | "erc721" | "erc1155">("auto");
  const [nftAmount, setNftAmount] = useState("1");
  const [busy, setBusy] = useState(false);
  const [lookup, setLookup] = useState<Lookup | null>(null);
  const [sent, setSent] = useState<Sent | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const chain = chains.find((c) => String(c.chainId) === chainId);
  const held = lookup?.tokens.find((t) => t.chainId === Number(chainId) && t.address.toLowerCase() === erc20Token.trim().toLowerCase());

  async function load(extra?: { chainId: number; address: string }) {
    setBusy(true);
    setErrorText(null);
    try {
      const contracts = extra?.address ? [extra] : paste.trim() ? [{ chainId: Number(chainId), address: paste.trim() }] : [];
      const res = await postJson("/api/test/server-sign-native-send/lookup", token, { walletId, contracts });
      if (!res.ok || !res.json?.native) {
        setErrorText(res.text.trim() ? `HTTP ${res.status}\n${res.text}` : `HTTP ${res.status} (empty body)`);
        return;
      }
      setLookup(res.json as Lookup);
    } catch (err) {
      setErrorText(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function selectToken(row: HeldToken) {
    setMode("erc20");
    setChainId(String(row.chainId));
    setErc20Token(row.address);
  }

  function selectNft(row: HeldNft) {
    setMode("nft");
    setChainId(String(row.chainId));
    setNftContract(row.contract);
    setNftTokenId(row.tokenId);
    setNftStandard(row.standard);
    if (row.balance) setNftAmount(row.balance);
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setSent(null);
    setErrorText(null);
    try {
      const url =
        mode === "erc20"
          ? "/api/test/server-sign-native-send/erc20"
          : mode === "nft"
            ? "/api/test/server-sign-native-send/nft"
            : "/api/test/server-sign-native-send";
      const res = await postJson(url, token, {
        walletId,
        chainId: Number(chainId),
        amount: mode === "nft" ? nftAmount : amount,
        destination,
        ...(mode === "erc20" ? { token: erc20Token.trim() } : {}),
        ...(mode === "nft" ? { contract: nftContract.trim(), tokenId: nftTokenId.trim(), standard: nftStandard } : {}),
      });
      if (res.ok && res.json && typeof res.json.txHash === "string" && typeof res.json.explorer === "string") {
        setSent(res.json as Sent);
      } else {
        const from = res.json && typeof res.json.from === "string" ? `\nFrom ${res.json.from}` : "";
        setErrorText((res.text.trim() ? `HTTP ${res.status}\n${res.text}` : `HTTP ${res.status} (empty body)`) + from);
      }
    } catch (err) {
      setErrorText(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={{ maxWidth: 860, margin: "40px auto", padding: "0 16px 48px" }}>
      <p className="pill accent">DO NOT MERGE</p>
      <h1 style={{ marginTop: 12 }}>Server-sign test send</h1>
      <p className="warn">
        Draft test on allowlisted wallets, signed with PRIVY_SIWE_AUTH_PRIVATE_KEY. No amount cap. A Privy policy denial is returned as
        Privy wrote it. The production selector denylist is not on this path.
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
        <p className="muted">Allowlist from TEST_SEND_WALLET_IDS. Reads and sends both require TEST_SEND_TOKEN.</p>

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
          <button className="btn ghost" type="button" disabled={busy || !token || !walletId} onClick={() => void load()}>
            {busy ? "Working…" : "Load balances & tokens"}
          </button>
        </div>

        <label htmlFor="test-send-chain" style={{ display: "block", marginTop: 14 }}>
          <b>Chain</b>
        </label>
        <select id="test-send-chain" value={chainId} onChange={(ev) => setChainId(ev.target.value)} style={{ marginTop: 8 }}>
          {chains.map((c) => (
            <option key={c.chainId} value={c.chainId}>
              {c.name} · {c.chainId} · {c.nativeSymbol}
            </option>
          ))}
        </select>

        <div className="row" style={{ marginTop: 14 }}>
          <label>
            <input type="radio" name="mode" checked={mode === "native"} onChange={() => setMode("native")} /> Native
          </label>
          <label>
            <input type="radio" name="mode" checked={mode === "erc20"} onChange={() => setMode("erc20")} /> ERC-20
          </label>
          <label>
            <input type="radio" name="mode" checked={mode === "nft"} onChange={() => setMode("nft")} /> NFT
          </label>
        </div>

        {mode === "erc20" && (
          <>
            <label htmlFor="test-send-erc20" style={{ display: "block", marginTop: 14 }}>
              <b>Token contract</b>
            </label>
            <input
              id="test-send-erc20"
              className="mono"
              autoComplete="off"
              spellCheck={false}
              placeholder="0x… or pick a held token below"
              value={erc20Token}
              onChange={(ev) => setErc20Token(ev.target.value)}
              style={{ marginTop: 8 }}
            />
            {held && (
              <p className="muted">
                {held.symbol ?? "token"} · {held.decimals ?? "?"} decimals · balance {held.balance}
              </p>
            )}
            <label htmlFor="test-send-paste" style={{ display: "block", marginTop: 14 }}>
              <b>Read a pasted contract</b>
            </label>
            <div className="row" style={{ marginTop: 8 }}>
              <input
                id="test-send-paste"
                className="mono"
                autoComplete="off"
                spellCheck={false}
                placeholder="0x… on the chain selected above"
                value={paste}
                onChange={(ev) => setPaste(ev.target.value)}
              />
              <button
                className="btn ghost"
                type="button"
                disabled={busy || !token || !paste.trim()}
                onClick={() => void load({ chainId: Number(chainId), address: paste.trim() })}
              >
                Read
              </button>
            </div>
          </>
        )}

        {mode === "nft" && (
          <>
            <label htmlFor="test-send-nft" style={{ display: "block", marginTop: 14 }}>
              <b>NFT contract</b>
            </label>
            <input
              id="test-send-nft"
              className="mono"
              autoComplete="off"
              spellCheck={false}
              placeholder="0x… or pick a held NFT below"
              value={nftContract}
              onChange={(ev) => setNftContract(ev.target.value)}
              style={{ marginTop: 8 }}
            />
            <label htmlFor="test-send-token-id" style={{ display: "block", marginTop: 14 }}>
              <b>Token id</b>
            </label>
            <input
              id="test-send-token-id"
              className="mono"
              autoComplete="off"
              spellCheck={false}
              value={nftTokenId}
              onChange={(ev) => setNftTokenId(ev.target.value)}
              style={{ marginTop: 8 }}
            />
            <label htmlFor="test-send-standard" style={{ display: "block", marginTop: 14 }}>
              <b>Standard</b>
            </label>
            <select
              id="test-send-standard"
              value={nftStandard}
              onChange={(ev) => setNftStandard(ev.target.value as typeof nftStandard)}
              style={{ marginTop: 8 }}
            >
              <option value="auto">Auto (ERC-165)</option>
              <option value="erc721">ERC-721</option>
              <option value="erc1155">ERC-1155</option>
            </select>
            {(nftStandard === "erc1155" || nftStandard === "auto") && (
              <>
                <label htmlFor="test-send-nft-amount" style={{ display: "block", marginTop: 14 }}>
                  <b>Amount (ERC-1155)</b>
                </label>
                <input
                  id="test-send-nft-amount"
                  inputMode="numeric"
                  autoComplete="off"
                  spellCheck={false}
                  value={nftAmount}
                  onChange={(ev) => setNftAmount(ev.target.value)}
                  style={{ marginTop: 8 }}
                />
              </>
            )}
            <p className="muted">Chains without an Alchemy NFT slug, including Ink, need a contract and token id.</p>
          </>
        )}

        {mode !== "nft" && (
          <>
            <label htmlFor="test-send-amount" style={{ display: "block", marginTop: 14 }}>
              <b>Amount{mode === "native" && chain ? ` (${chain.nativeSymbol})` : ""}</b>
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
          </>
        )}

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
        <div className="row" style={{ marginTop: 14 }}>
          <button className="btn" type="submit" disabled={busy || !wallets.length || !chains.length}>
            {busy ? "Working…" : mode === "erc20" ? "Send ERC-20" : mode === "nft" ? "Send NFT" : "Send native"}
          </button>
        </div>
      </form>

      {lookup && (
        <div className="card">
          <p>
            Wallet <span className="mono">{lookup.address}</span>
          </p>
          <p className="muted">{lookup.discovery.note}</p>
          {lookup.discovery.errors.map((err) => (
            <p key={err} className="warn">
              {err}
            </p>
          ))}
          <h2>Native balances</h2>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th align="left">Chain</th>
                  <th align="left">Balance</th>
                </tr>
              </thead>
              <tbody>
                {lookup.native.map((row) => (
                  <tr key={row.chainId}>
                    <td>
                      {row.name} · {row.chainId}
                    </td>
                    <td className="mono">{row.error ? row.error : `${row.balance} ${row.nativeSymbol}`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h2>ERC-20 with a balance</h2>
          {lookup.tokens.length === 0 ? (
            <p className="muted">No non-zero ERC-20 balance was found. Paste a contract above to read one over RPC.</p>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th align="left">Token</th>
                    <th align="left">Chain</th>
                    <th align="left">Balance</th>
                    <th align="left">Decimals</th>
                    <th align="left">Contract</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {lookup.tokens.map((row) => (
                    <tr key={`${row.chainId}:${row.address}`}>
                      <td>{row.symbol ?? row.name ?? "—"}</td>
                      <td>
                        {row.chainName} · {row.chainId}
                      </td>
                      <td className="mono">{row.balance}</td>
                      <td>{row.decimals ?? "—"}</td>
                      <td className="mono">{row.address}</td>
                      <td>
                        <button className="btn ghost" type="button" onClick={() => selectToken(row)}>
                          Use
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <h2>NFTs held</h2>
          {lookup.nftDiscovery?.note && <p className="muted">{lookup.nftDiscovery.note}</p>}
          {lookup.nftDiscovery?.truncated && <p className="warn">The NFT list was truncated.</p>}
          {(lookup.nftDiscovery?.errors ?? []).map((err) => (
            <p key={err} className="warn">
              {err}
            </p>
          ))}
          {(lookup.nfts ?? []).length === 0 ? (
            <p className="muted">No held NFTs were returned. Enter a contract and token id in the NFT section.</p>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th align="left" />
                    <th align="left">Collection</th>
                    <th align="left">Chain</th>
                    <th align="left">Standard</th>
                    <th align="left">Token id</th>
                    <th align="left">Balance</th>
                    <th align="left">Contract</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {(lookup.nfts ?? []).map((row) => (
                    <tr key={`${row.chainId}:${row.contract}:${row.tokenId}`}>
                      <td>{row.image ? <img src={row.image} alt="" width={40} height={40} style={{ objectFit: "cover" }} /> : null}</td>
                      <td>{row.collection ?? row.name ?? "—"}</td>
                      <td>
                        {row.chainName} · {row.chainId}
                      </td>
                      <td>{row.standard === "erc1155" ? "ERC-1155" : "ERC-721"}</td>
                      <td className="mono">{row.tokenId}</td>
                      <td>{row.balance ?? "1"}</td>
                      <td className="mono">{row.contract}</td>
                      <td>
                        <button className="btn ghost" type="button" onClick={() => selectNft(row)}>
                          Use
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {lookup.zeroReads.length > 0 && (
            <p className="muted">
              Pasted contracts with a zero balance: {lookup.zeroReads.map((z) => `${z.symbol ?? z.address} on ${z.chainId}`).join(", ")}
            </p>
          )}
        </div>
      )}

      {sent && (
        <div className="card">
          <p className="ok">Broadcast accepted.</p>
          {sent.from && (
            <p>
              From <span className="mono">{sent.from}</span>
            </p>
          )}
          {sent.contract && (
            <p>
              NFT <span className="mono">{sent.contract}</span> #{sent.tokenId}
              {sent.amount ? ` · amount ${sent.amount}` : ""} ({sent.standard})
            </p>
          )}
          {sent.token && (
            <p>
              Token <span className="mono">{sent.token}</span>
              {sent.symbol ? ` (${sent.symbol})` : ""} · {sent.amount} ({sent.amountRaw} raw)
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
