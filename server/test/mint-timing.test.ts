// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { nextRetryDelay, NOT_ACTIVE_RETRY_MS, waitUntil } from "../src/core/mint/executor.js";

describe("mint timing helpers", () => {
  it("aligns a build retry to the start time", () => {
    expect(nextRetryDelay(1000, 1100)).toBe(100);
    expect(nextRetryDelay(1000, 5000)).toBe(NOT_ACTIVE_RETRY_MS);
    expect(nextRetryDelay(2000, 1000)).toBe(NOT_ACTIVE_RETRY_MS);
    expect(nextRetryDelay(1000, undefined)).toBe(NOT_ACTIVE_RETRY_MS);
  });

  it("waitUntil returns at (not before) the target", async () => {
    const at = Date.now() + 120;
    await waitUntil(at);
    expect(Date.now()).toBeGreaterThanOrEqual(at);
    expect(Date.now() - at).toBeLessThan(50);
  });
});
