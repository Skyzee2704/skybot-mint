"use client";
// SPDX-License-Identifier: AGPL-3.0-only
import { CopyAddress } from "@/components/CopyAddress";
import { SKYBOT_TOKEN_ADDRESS, VOLTA_TOKEN_URL } from "@/lib/constants";

/** Landing card for the $SKYBOT token contract. The address is copied exactly as published. */
export function TokenContract() {
  return (
    <section className="token-ca card" aria-labelledby="skybot-token-heading">
      <div className="token-ca-head">
        <h2 id="skybot-token-heading">$SKYBOT</h2>
        <span className="pill">Contract address</span>
      </div>
      <p className="token-ca-note muted">
        Live on{" "}
        <a href={VOLTA_TOKEN_URL} target="_blank" rel="noopener noreferrer">
          Volta.family
        </a>
        .{" "}
        <a href={VOLTA_TOKEN_URL} target="_blank" rel="noopener noreferrer">
          View on Volta.family
        </a>
      </p>
      <div className="token-ca-row">
        <code className="token-ca-addr">{SKYBOT_TOKEN_ADDRESS}</code>
        <CopyAddress address={SKYBOT_TOKEN_ADDRESS} exact label="Copy" className="token-ca-copy" />
      </div>
    </section>
  );
}
