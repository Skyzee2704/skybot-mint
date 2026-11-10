// SPDX-License-Identifier: AGPL-3.0-only
import { Agent } from "undici";
import { describe, expect, it } from "vitest";
import { installKeepAlive, keepAliveInstalled, KEEP_ALIVE_TIMEOUT_MS } from "../src/util/keepalive.js";

describe("keep-alive dispatcher", () => {
  it("installs one undici agent with keep-alive and reports that it is the global dispatcher", () => {
    const agent = installKeepAlive();
    expect(agent).toBeInstanceOf(Agent);
    expect(keepAliveInstalled()).toBe(true);
    expect(installKeepAlive()).toBe(agent);
    expect(KEEP_ALIVE_TIMEOUT_MS).toBe(30_000);
  });
});
