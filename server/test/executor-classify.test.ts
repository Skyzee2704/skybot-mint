// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { classifyNotEligible, parseOpenSeaActiveStage } from "../src/core/mint/executor.js";

/**
 * Regression for the 2026-11-21 stage bug: a scheduled job for stage X was killed by the
 * first probe at T0−150ms, when OpenSea still had the previous (team) stage active and
 * answered 422 "not eligible for the active drop stage, 'Team Round'". The executor used
 * to treat every 422 NOT_ELIGIBLE as a final verdict; now a 422 is only final once the
 * chosen stage itself is the active one after its start.
 */
describe("parseOpenSeaActiveStage", () => {
  it("extracts the stage OpenSea names in a 422 message", () => {
    expect(
      parseOpenSeaActiveStage(
        "OpenSea: Wallet is not eligible for the active drop stage, 'Team Round' (signed_presale): the wallet is not on this stage's allowlist",
      ),
    ).toBe("Team Round");
    expect(parseOpenSeaActiveStage("Wallet is not eligible for the active drop stage, 'Inner Circle' (signed_presale)")).toBe(
      "Inner Circle",
    );
  });

  it("returns undefined when the message names no stage", () => {
    expect(parseOpenSeaActiveStage("OpenSea: Wallet is not eligible")).toBeUndefined();
    expect(parseOpenSeaActiveStage("")).toBeUndefined();
  });
});

describe("classifyNotEligible", () => {
  const fireAt = 10_000;
  const chosen = "Allowlist Round";
  const otherStage = "OpenSea: Wallet is not eligible for the active drop stage, 'Team Round' (signed_presale)";
  const chosenStageMsg = "OpenSea: Wallet is not eligible for the active drop stage, 'Allowlist Round' (signed_presale)";
  const noNameMsg = "OpenSea: Wallet is not eligible for the active drop stage";

  it("422 before T0 naming another stage retries (closed), it is not a final verdict", () => {
    expect(classifyNotEligible({ message: otherStage, fireAt, chosenStage: chosen, now: fireAt - 150 })).toBe("closed");
  });

  it("422 before T0 with no stage name to compare retries until T0", () => {
    expect(classifyNotEligible({ message: noNameMsg, fireAt, chosenStage: chosen, now: fireAt - 150 })).toBe("closed");
  });

  it("422 before T0 naming the chosen stage itself still retries — the verdict waits for T0", () => {
    expect(classifyNotEligible({ message: chosenStageMsg, fireAt, chosenStage: chosen, now: fireAt - 1 })).toBe("closed");
  });

  it("422 at/after T0 naming another stage retries — the chosen stage has not opened yet", () => {
    expect(classifyNotEligible({ message: otherStage, fireAt, chosenStage: chosen, now: fireAt })).toBe("closed");
    expect(classifyNotEligible({ message: otherStage, fireAt, chosenStage: chosen, now: fireAt + 5_000 })).toBe("closed");
  });

  it("422 at/after T0 against the chosen stage itself is final (live)", () => {
    expect(classifyNotEligible({ message: chosenStageMsg, fireAt, chosenStage: chosen, now: fireAt })).toBe("live");
    expect(classifyNotEligible({ message: chosenStageMsg, fireAt, chosenStage: chosen, now: fireAt + 5_000 })).toBe("live");
  });

  it("422 at/after T0 with no stage name is final — the active stage is the chosen one by then", () => {
    expect(classifyNotEligible({ message: noNameMsg, fireAt, chosenStage: chosen, now: fireAt + 5_000 })).toBe("live");
  });

  it("a mint-now job (no fireAt) keeps the old behavior: a 422 is final", () => {
    expect(classifyNotEligible({ message: otherStage, chosenStage: chosen, now: fireAt })).toBe("live");
    expect(classifyNotEligible({ message: chosenStageMsg, chosenStage: chosen, now: fireAt })).toBe("live");
  });

  it("with no chosen stage to compare against, a post-T0 422 stays final", () => {
    expect(classifyNotEligible({ message: otherStage, fireAt, now: fireAt + 5_000 })).toBe("live");
    expect(classifyNotEligible({ message: otherStage, fireAt, chosenStage: null, now: fireAt + 5_000 })).toBe("live");
  });
});
