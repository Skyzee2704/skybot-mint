"use client";
// SPDX-License-Identifier: AGPL-3.0-only
import { useMemo, useState } from "react";

/** Suggested starting destination. The server accepts any checksummed address. */
const DEFAULT_DESTINATION = "0xdd911fA75E72b3c11e75DCAbfaE9f60D65903877";
const GAS_FLOOR = 21_000n * 1_000_000_000n;

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
  zeroReads: { chainId: number; address: string }[];
  discovery: { note: string; errors: string[] };
};
type Job = {
  id: string;
  chainId: number;
  label: string;
  body: Record<string, unknown>;
  url: string;
};
type RowResult = { id: string; label: string; status: "pending" | "sent" | "failed"; hash?: string; explorer?: string; error?: string };

const tokenKey = (t: { chainId: number; address: string }) => `${t.chainId}:${t.address.toLowerCase()}`;
const nftKey = (n: HeldNft) => `${n.chainId}:${n.contract.toLowerCase()}:${n.tokenId}`;
const short = (a: string) => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

async function postJson(url: string, token: string, body: unknown) {
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

function errorTextOf(res: { status: number; text: string; json: any }) {
  if (res.json && typeof res.json.error === "string" && res.json.error.trim()) {
    return res.json.code ? `${res.json.error}\ncode: ${res.json.code}` : res.json.error;
  }
  return res.text.trim() ? `HTTP ${res.status}\n${res.text}` : `HTTP ${res.status} (empty body)`;
}

function gasWarning(native: NativeRow[], jobs: Job[]): string | null {
  const byChain = new Map<number, number>();
  for (const job of jobs) byChain.set(job.chainId, (byChain.get(job.chainId) ?? 0) + 1);
  const lines: string[] = [];
  for (const [chainId, count] of byChain) {
    const row = native.find((n) => n.chainId === chainId);
    const name = row ? `${row.name} (${row.nativeSymbol})` : `chain ${chainId}`;
    if (!row || row.error || row.balanceWei == null) {
      lines.push(`${name}: native balance is unknown, so gas for ${count} transaction${count === 1 ? "" : "s"} may fail.`);
      continue;
    }
    let wei = 0n;
    try {
      wei = BigInt(row.balanceWei);
    } catch {
      lines.push(`${name}: native balance could not be read.`);
      continue;
    }
    const floor = GAS_FLOOR * BigInt(count);
    if (wei < floor) {
      lines.push(
        `${name}: balance ${row.balance ?? row.balanceWei} looks too low for gas on ${count} transaction${count === 1 ? "" : "s"}.`,
      );
    }
  }
  return lines.length ? lines.join(" ") : null;
}

export function TestSendForm({ wallets, chains }: { wallets: string[]; chains: TestSendChainOption[] }) {
  const [walletId, setWalletId] = useState(wallets[0] ?? "");
  const [chainId, setChainId] = useState(String(chains.find((c) => c.chainId === 1)?.chainId ?? chains[0]?.chainId ?? ""));
  const [allChains, setAllChains] = useState(false);
  const [amount, setAmount] = useState("");
  const [destination, setDestination] = useState(DEFAULT_DESTINATION);
  const [gate, setGate] = useState("");
  const [erc20On, setErc20On] = useState<Record<string, boolean>>({});
  const [erc20Amt, setErc20Amt] = useState<Record<string, string>>({});
  const [nftOn, setNftOn] = useState<Record<string, boolean>>({});
  const [nftAmt, setNftAmt] = useState<Record<string, string>>({});
  const [batch1155, setBatch1155] = useState(false);
  const [paste, setPaste] = useState("");
  const [nftContract, setNftContract] = useState("");
  const [nftTokenId, setNftTokenId] = useState("");
  const [nftStandard, setNftStandard] = useState<"auto" | "erc721" | "erc1155">("auto");
  const [manualAmount, setManualAmount] = useState("1");
  const [busy, setBusy] = useState(false);
  const [lookup, setLookup] = useState<Lookup | null>(null);
  const [confirmJobs, setConfirmJobs] = useState<Job[] | null>(null);
  const [results, setResults] = useState<RowResult[]>([]);
  const [summary, setSummary] = useState<string | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const chain = chains.find((c) => String(c.chainId) === chainId);
  const chainNum = Number(chainId);

  const visibleTokens = useMemo(
    () => (lookup?.tokens ?? []).filter((t) => allChains || t.chainId === chainNum),
    [lookup, allChains, chainNum],
  );
  const visibleNfts = useMemo(() => (lookup?.nfts ?? []).filter((n) => allChains || n.chainId === chainNum), [lookup, allChains, chainNum]);
  const nftGroups = useMemo(() => {
    const groups = new Map<string, { title: string; chainId: number; contract: string; rows: HeldNft[] }>();
    for (const row of visibleNfts) {
      const title = row.collection || row.name || "Collection";
      const id = `${row.chainId}:${row.contract.toLowerCase()}:${title}`;
      const g = groups.get(id) ?? { title, chainId: row.chainId, contract: row.contract, rows: [] };
      g.rows.push(row);
      groups.set(id, g);
    }
    return [...groups.values()];
  }, [visibleNfts]);

  async function load(extra?: { chainId: number; address: string }) {
    setBusy(true);
    setErrorText(null);
    try {
      const contracts = extra?.address ? [extra] : paste.trim() ? [{ chainId: chainNum, address: paste.trim() }] : [];
      const res = await postJson("/api/test/server-sign-native-send/lookup", gate, { walletId, contracts });
      if (!res.ok || !res.json?.native) {
        setErrorText(errorTextOf(res));
        return;
      }
      const data = res.json as Lookup;
      setLookup(data);
      setErc20Amt((prev) => {
        const next = { ...prev };
        for (const t of data.tokens ?? []) if (t.decimals != null && next[tokenKey(t)] == null) next[tokenKey(t)] = t.balance;
        return next;
      });
      setNftAmt((prev) => {
        const next = { ...prev };
        for (const n of data.nfts ?? []) if (n.standard === "erc1155" && n.balance && next[nftKey(n)] == null) next[nftKey(n)] = n.balance;
        return next;
      });
    } catch (err) {
      setErrorText(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function toggleTokens(rows: HeldToken[], on: boolean) {
    setErc20On((prev) => {
      const next = { ...prev };
      for (const row of rows) if (row.decimals != null) next[tokenKey(row)] = on;
      return next;
    });
    if (on) {
      setErc20Amt((prev) => {
        const next = { ...prev };
        for (const row of rows) if (row.decimals != null) next[tokenKey(row)] = row.balance;
        return next;
      });
    }
  }

  function toggleNfts(rows: HeldNft[], on: boolean) {
    setNftOn((prev) => {
      const next = { ...prev };
      for (const row of rows) next[nftKey(row)] = on;
      return next;
    });
  }

  function buildErc20Jobs(): Job[] {
    return visibleTokens
      .filter((row) => erc20On[tokenKey(row)] && row.decimals != null)
      .map((row) => ({
        id: tokenKey(row),
        chainId: row.chainId,
        label: `${row.symbol ?? short(row.address)} on ${row.chainName}`,
        url: "/api/test/server-sign-native-send/erc20",
        body: { walletId, chainId: row.chainId, token: row.address, amount: (erc20Amt[tokenKey(row)] || row.balance).trim(), destination },
      }));
  }

  function buildNftJobs(): Job[] {
    const picked = visibleNfts.filter((row) => nftOn[nftKey(row)]);
    const jobs: Job[] = [];
    const grouped = new Map<string, HeldNft[]>();
    for (const row of picked) {
      if (batch1155 && row.standard === "erc1155") {
        const id = `${row.chainId}:${row.contract.toLowerCase()}`;
        grouped.set(id, [...(grouped.get(id) ?? []), row]);
      } else {
        jobs.push({
          id: nftKey(row),
          chainId: row.chainId,
          label: `${row.collection ?? row.name ?? "NFT"} #${row.tokenId} on ${row.chainName}`,
          url: "/api/test/server-sign-native-send/nft",
          body: {
            walletId,
            chainId: row.chainId,
            contract: row.contract,
            tokenId: row.tokenId,
            standard: row.standard,
            destination,
            ...(row.standard === "erc1155" ? { amount: (nftAmt[nftKey(row)] || row.balance || "1").trim() } : {}),
          },
        });
      }
    }
    for (const rows of grouped.values()) {
      if (rows.length === 1) {
        const row = rows[0];
        jobs.push({
          id: nftKey(row),
          chainId: row.chainId,
          label: `${row.collection ?? "NFT"} #${row.tokenId} on ${row.chainName}`,
          url: "/api/test/server-sign-native-send/nft",
          body: {
            walletId,
            chainId: row.chainId,
            contract: row.contract,
            tokenId: row.tokenId,
            standard: "erc1155",
            amount: (nftAmt[nftKey(row)] || row.balance || "1").trim(),
            destination,
          },
        });
        continue;
      }
      jobs.push({
        id: `batch:${rows[0].chainId}:${rows[0].contract}`,
        chainId: rows[0].chainId,
        label: `${rows[0].collection ?? short(rows[0].contract)} · ${rows.length} ERC-1155s on ${rows[0].chainName}`,
        url: "/api/test/server-sign-native-send/nft",
        body: {
          walletId,
          chainId: rows[0].chainId,
          contract: rows[0].contract,
          standard: "erc1155",
          destination,
          tokenIds: rows.map((r) => r.tokenId),
          amounts: rows.map((r) => (nftAmt[nftKey(r)] || r.balance || "1").trim()),
        },
      });
    }
    return jobs;
  }

  function askConfirm(kind: "erc20" | "nft" | "native") {
    setErrorText(null);
    setSummary(null);
    const jobs =
      kind === "native"
        ? [
            {
              id: "native",
              chainId: chainNum,
              label: `${amount || "?"} ${chain?.nativeSymbol ?? ""} on ${chain?.name ?? chainId}`,
              url: "/api/test/server-sign-native-send",
              body: { walletId, chainId: chainNum, amount: amount.trim(), destination },
            },
          ]
        : kind === "erc20"
          ? buildErc20Jobs()
          : buildNftJobs();
    if (!jobs.length) {
      setErrorText(kind === "native" ? "Enter an amount." : "Select at least one item.");
      return;
    }
    if (!destination.trim()) {
      setErrorText("Destination is required.");
      return;
    }
    setConfirmJobs(jobs);
  }

  async function runJobs(jobs: Job[]) {
    setConfirmJobs(null);
    setBusy(true);
    setResults(jobs.map((job) => ({ id: job.id, label: job.label, status: "pending" })));
    const nonceByChain = new Map<number, number>();
    let sent = 0;
    let failed = 0;
    for (let i = 0; i < jobs.length; i++) {
      const job = jobs[i];
      const nonce = nonceByChain.get(job.chainId);
      const res = await postJson(job.url, gate, { ...job.body, ...(nonce != null ? { nonce } : {}) }).catch((err) => ({
        ok: false,
        status: 0,
        text: err instanceof Error ? err.message : String(err),
        json: null,
      }));
      if (res.ok && res.json && typeof res.json.txHash === "string") {
        sent += 1;
        if (typeof res.json.nonce === "number") nonceByChain.set(job.chainId, res.json.nonce + 1);
        setResults((prev) =>
          prev.map((row, idx) => (idx === i ? { ...row, status: "sent", hash: res.json.txHash, explorer: res.json.explorer } : row)),
        );
      } else {
        failed += 1;
        setResults((prev) => prev.map((row, idx) => (idx === i ? { ...row, status: "failed", error: errorTextOf(res) } : row)));
      }
    }
    setSummary(`${sent} sent, ${failed} failed, ${jobs.length} total.`);
    setBusy(false);
  }

  const warning = confirmJobs && lookup ? gasWarning(lookup.native, confirmJobs) : null;
  const allTokensOn =
    visibleTokens.filter((t) => t.decimals != null).every((t) => erc20On[tokenKey(t)]) && visibleTokens.some((t) => t.decimals != null);
  const allNftsOn = visibleNfts.length > 0 && visibleNfts.every((n) => nftOn[nftKey(n)]);

  return (
    <main className="test-send" style={{ maxWidth: 920, margin: "24px auto", padding: "0 12px 48px" }}>
      <style>{`
        .test-send .row-item { display: flex; gap: 10px; align-items: flex-start; padding: 10px 0; border-bottom: 1px solid var(--line-soft); }
        .test-send .row-item img { width: 40px; height: 40px; object-fit: cover; border-radius: 6px; background: var(--ink); }
        .test-send .grow { flex: 1; min-width: 0; }
        .test-send input.amt { max-width: 160px; }
        @media (max-width: 640px) {
          .test-send .row-item { flex-wrap: wrap; }
          .test-send input.amt, .test-send input, .test-send select { max-width: none; }
        }
      `}</style>
      <p className="pill accent">DO NOT MERGE</p>
      <h1 style={{ marginTop: 12 }}>Server-sign test send</h1>
      <p className="warn">
        Draft test on allowlisted wallets. Each selected token or NFT is its own transaction, sent one after another. Value is 0 for token
        and NFT calls. No amount cap. A Privy policy denial is shown as Privy wrote it.
      </p>

      <div className="card">
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
        <label htmlFor="test-send-token" style={{ display: "block", marginTop: 14 }}>
          <b>TEST_SEND_TOKEN</b>
        </label>
        <input
          id="test-send-token"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={gate}
          onChange={(ev) => setGate(ev.target.value)}
          style={{ marginTop: 8 }}
        />
        <div className="row" style={{ marginTop: 14 }}>
          <button className="btn ghost" type="button" disabled={busy || !gate || !walletId} onClick={() => void load()}>
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
        <div className="row" style={{ marginTop: 10 }}>
          <label>
            <input type="radio" name="scope" checked={!allChains} onChange={() => setAllChains(false)} /> This chain
          </label>
          <label>
            <input type="radio" name="scope" checked={allChains} onChange={() => setAllChains(true)} /> All chains
          </label>
        </div>
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
      </div>

      {lookup && (
        <div className="card">
          <p>
            Wallet <span className="mono">{lookup.address}</span>
          </p>
          <h2>Native balances</h2>
          <div style={{ overflowX: "auto" }}>
            {lookup.native.map((row) => (
              <div key={row.chainId} className="row-item">
                <div className="grow">
                  <b>
                    {row.name} · {row.chainId}
                  </b>
                  <div className="mono">{row.error ? row.error : `${row.balance} ${row.nativeSymbol}`}</div>
                </div>
              </div>
            ))}
          </div>

          <h2>ERC-20</h2>
          <p className="muted">{lookup.discovery.note}</p>
          {lookup.discovery.errors.map((err) => (
            <p key={err} className="warn">
              {err}
            </p>
          ))}
          {visibleTokens.length === 0 ? (
            <p className="muted">No non-zero ERC-20 on this view. Use the paste fallback below.</p>
          ) : (
            <>
              <label>
                <input type="checkbox" checked={allTokensOn} onChange={(ev) => toggleTokens(visibleTokens, ev.target.checked)} /> Select all
              </label>
              {visibleTokens.map((row) => {
                const key = tokenKey(row);
                return (
                  <div key={key} className="row-item">
                    <input
                      type="checkbox"
                      disabled={row.decimals == null}
                      checked={Boolean(erc20On[key])}
                      onChange={(ev) => {
                        setErc20On((prev) => ({ ...prev, [key]: ev.target.checked }));
                        if (ev.target.checked) setErc20Amt((prev) => ({ ...prev, [key]: prev[key] || row.balance }));
                      }}
                    />
                    <div className="grow">
                      <b>
                        {row.symbol ?? row.name ?? "Token"} · {row.chainName}
                      </b>
                      <div className="muted">
                        Balance {row.balance}
                        {row.decimals == null ? " · decimals unknown" : ""} · <span className="mono">{short(row.address)}</span>
                      </div>
                      {erc20On[key] && row.decimals != null && (
                        <div className="row" style={{ marginTop: 6 }}>
                          <input
                            className="amt"
                            value={erc20Amt[key] ?? row.balance}
                            onChange={(ev) => setErc20Amt((prev) => ({ ...prev, [key]: ev.target.value }))}
                          />
                          <button
                            className="btn ghost"
                            type="button"
                            onClick={() => setErc20Amt((prev) => ({ ...prev, [key]: row.balance }))}
                          >
                            Max
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
              <button className="btn" type="button" disabled={busy} onClick={() => askConfirm("erc20")}>
                Send selected
              </button>
            </>
          )}

          <h2>NFTs</h2>
          {lookup.nftDiscovery?.note && <p className="muted">{lookup.nftDiscovery.note}</p>}
          {lookup.nftDiscovery?.truncated && <p className="warn">The NFT list was truncated.</p>}
          {(lookup.nftDiscovery?.errors ?? []).map((err) => (
            <p key={err} className="warn">
              {err}
            </p>
          ))}
          {visibleNfts.length === 0 ? (
            <p className="muted">No held NFTs on this view. Ink and any chain without an Alchemy slug need the manual fields below.</p>
          ) : (
            <>
              <label>
                <input type="checkbox" checked={allNftsOn} onChange={(ev) => toggleNfts(visibleNfts, ev.target.checked)} /> Select all NFTs
              </label>
              <label style={{ marginLeft: 12 }}>
                <input type="checkbox" checked={batch1155} onChange={(ev) => setBatch1155(ev.target.checked)} /> Group ERC-1155s in one
                collection into one transaction
              </label>
              {nftGroups.map((group) => {
                const groupOn = group.rows.every((row) => nftOn[nftKey(row)]);
                return (
                  <div key={`${group.chainId}:${group.contract}:${group.title}`} style={{ marginTop: 12 }}>
                    <label>
                      <input type="checkbox" checked={groupOn} onChange={(ev) => toggleNfts(group.rows, ev.target.checked)} />{" "}
                      <b>{group.title}</b> · {group.rows[0]?.chainName} · <span className="mono">{short(group.contract)}</span>
                    </label>
                    {group.rows.map((row) => {
                      const key = nftKey(row);
                      return (
                        <div key={key} className="row-item">
                          <input
                            type="checkbox"
                            checked={Boolean(nftOn[key])}
                            onChange={(ev) => setNftOn((prev) => ({ ...prev, [key]: ev.target.checked }))}
                          />
                          {row.image ? <img src={row.image} alt="" /> : <span style={{ width: 40 }} />}
                          <div className="grow">
                            <div>
                              #{row.tokenId} · {row.standard === "erc1155" ? "ERC-1155" : "ERC-721"}
                              {row.balance ? ` · balance ${row.balance}` : ""}
                            </div>
                            {row.standard === "erc1155" && nftOn[key] && (
                              <div className="row" style={{ marginTop: 6 }}>
                                <input
                                  className="amt"
                                  value={nftAmt[key] ?? row.balance ?? "1"}
                                  onChange={(ev) => setNftAmt((prev) => ({ ...prev, [key]: ev.target.value }))}
                                />
                                <button
                                  className="btn ghost"
                                  type="button"
                                  onClick={() => setNftAmt((prev) => ({ ...prev, [key]: row.balance ?? "1" }))}
                                >
                                  Max
                                </button>
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                );
              })}
              <button className="btn" type="button" disabled={busy} onClick={() => askConfirm("nft")}>
                Send selected
              </button>
            </>
          )}
        </div>
      )}

      <details className="card">
        <summary>
          <b>Native send and manual fallback</b>
        </summary>
        <p className="muted">Use this for a native transfer, or when a chain such as Ink is not in the Alchemy index.</p>
        <label htmlFor="native-amount">
          <b>Native amount{chain ? ` (${chain.nativeSymbol})` : ""}</b>
        </label>
        <input
          id="native-amount"
          value={amount}
          placeholder="0.0005"
          onChange={(ev) => setAmount(ev.target.value)}
          style={{ marginTop: 8 }}
        />
        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn" type="button" disabled={busy} onClick={() => askConfirm("native")}>
            Send native
          </button>
        </div>
        <label htmlFor="paste-token" style={{ display: "block", marginTop: 14 }}>
          <b>Read a pasted ERC-20</b>
        </label>
        <div className="row" style={{ marginTop: 8 }}>
          <input
            id="paste-token"
            className="mono"
            placeholder="0x… on the selected chain"
            value={paste}
            onChange={(ev) => setPaste(ev.target.value)}
          />
          <button
            className="btn ghost"
            type="button"
            disabled={busy || !gate || !paste.trim()}
            onClick={() => void load({ chainId: chainNum, address: paste.trim() })}
          >
            Read
          </button>
        </div>
        <label htmlFor="manual-nft" style={{ display: "block", marginTop: 14 }}>
          <b>Manual NFT</b>
        </label>
        <input
          id="manual-nft"
          className="mono"
          placeholder="Contract 0x…"
          value={nftContract}
          onChange={(ev) => setNftContract(ev.target.value)}
          style={{ marginTop: 8 }}
        />
        <input
          className="mono"
          placeholder="Token id"
          value={nftTokenId}
          onChange={(ev) => setNftTokenId(ev.target.value)}
          style={{ marginTop: 8 }}
        />
        <select value={nftStandard} onChange={(ev) => setNftStandard(ev.target.value as typeof nftStandard)} style={{ marginTop: 8 }}>
          <option value="auto">Auto (ERC-165)</option>
          <option value="erc721">ERC-721</option>
          <option value="erc1155">ERC-1155</option>
        </select>
        {(nftStandard === "auto" || nftStandard === "erc1155") && (
          <input
            placeholder="ERC-1155 amount"
            value={manualAmount}
            onChange={(ev) => setManualAmount(ev.target.value)}
            style={{ marginTop: 8 }}
          />
        )}
        <div className="row" style={{ marginTop: 10 }}>
          <button
            className="btn"
            type="button"
            disabled={busy || !nftContract.trim() || !nftTokenId.trim()}
            onClick={() => {
              setConfirmJobs([
                {
                  id: `manual:${nftContract}:${nftTokenId}`,
                  chainId: chainNum,
                  label: `Manual NFT ${short(nftContract)} #${nftTokenId}`,
                  url: "/api/test/server-sign-native-send/nft",
                  body: {
                    walletId,
                    chainId: chainNum,
                    contract: nftContract.trim(),
                    tokenId: nftTokenId.trim(),
                    standard: nftStandard,
                    destination,
                    ...(nftStandard !== "erc721" ? { amount: manualAmount.trim() } : {}),
                  },
                },
              ]);
            }}
          >
            Send manual NFT
          </button>
        </div>
      </details>

      {confirmJobs && (
        <div className="card" role="dialog" aria-label="Confirm send">
          <h2>Confirm</h2>
          <p>
            Send <b>{confirmJobs.length}</b> transaction{confirmJobs.length === 1 ? "" : "s"} to <span className="mono">{destination}</span>
            .
          </p>
          <ul>
            {confirmJobs.slice(0, 8).map((job) => (
              <li key={job.id}>{job.label}</li>
            ))}
            {confirmJobs.length > 8 && <li>…and {confirmJobs.length - 8} more</li>}
          </ul>
          {warning && <p className="warn">{warning}</p>}
          <div className="row">
            <button className="btn" type="button" disabled={busy} onClick={() => void runJobs(confirmJobs)}>
              Confirm and send
            </button>
            <button className="btn ghost" type="button" onClick={() => setConfirmJobs(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {results.length > 0 && (
        <div className="card">
          <h2>Progress</h2>
          {results.map((row) => (
            <div key={row.id} className="row-item">
              <div className="grow">
                <b>{row.label}</b>
                <div className={row.status === "failed" ? "bad" : row.status === "sent" ? "ok" : "muted"}>{row.status}</div>
                {row.explorer && row.hash && (
                  <div>
                    <a href={row.explorer} target="_blank" rel="noopener noreferrer">
                      <span className="mono">{short(row.hash)}</span>
                    </a>
                  </div>
                )}
                {row.error && (
                  <pre className="mono" style={{ whiteSpace: "pre-wrap", margin: "6px 0 0" }}>
                    {row.error}
                  </pre>
                )}
              </div>
            </div>
          ))}
          {summary && (
            <p>
              <b>{summary}</b>
            </p>
          )}
        </div>
      )}
      {errorText && (
        <div className="err" role="alert">
          <pre className="mono" style={{ whiteSpace: "pre-wrap", margin: 0 }}>
            {errorText}
          </pre>
        </div>
      )}
    </main>
  );
}
