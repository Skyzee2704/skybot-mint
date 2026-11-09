// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { Interface } from "ethers";
import { parseInput } from "../src/core/resolver/parseInput.js";
import { decideDrop, stageClock, wantOf } from "../src/core/kalos/decide.js";
import { encodeMintAllowList, kalosIface } from "../src/core/kalos/calldata.js";
import { chooseSeaDrop } from "../src/core/kalos/source.js";
import { kalosStages } from "../src/core/kalos/target.js";
import { KALOS_SEADROP, OPENSEA_SEADROP, type KalosDrop, type KalosEligibility } from "../src/core/kalos/types.js";

const drops = JSON.parse(readFileSync(new URL("./fixtures/kalos/drops.json", import.meta.url), "utf8")).drops as KalosDrop[];
const elyantElig = JSON.parse(readFileSync(new URL("./fixtures/kalos/elyant-eligible.json", import.meta.url), "utf8")) as KalosEligibility;
const emptyElig = JSON.parse(readFileSync(new URL("./fixtures/kalos/elyant-empty.json", import.meta.url), "utf8")) as KalosEligibility;
const elyant = drops.find((d) => d.slug === "elyant")!;
const blobs = drops.find((d) => d.slug === "pixel-blobs")!;

describe("Kalos drops", () => {
  it("parses kalos.fun drop URLs", () => {
    expect(parseInput("https://kalos.fun/drops/elyant")).toMatchObject({
      kind: "slug",
      value: "elyant",
      chainHint: "elysium",
      source: "kalos",
    });
    expect(parseInput("https://www.kalos.fun/drop/pixel-blobs/overview")).toMatchObject({
      kind: "slug",
      value: "pixel-blobs",
      source: "kalos",
    });
  });

  it("Elyant: minted 1 and Colony cap 2 means want 1", () => {
    const now = 1794240000; // during Colony, after Hives
    const rows = decideDrop({ drop: elyant, elig: elyantElig, minted: 1, nowSec: now });
    const colony = rows.find((r) => r.name === "Colony")!;
    const hives = rows.find((r) => r.name === "Hives")!;
    expect(wantOf(2, 1)).toBe(1);
    expect(colony.want).toBe(1);
    expect(colony.eligible).toBe(true);
    expect(colony.clock).toBe("active");
    expect(colony.entry?.proof.length).toBeGreaterThan(0);
    expect(hives.clock).toBe("ended");
    expect(hives.reason).toBe("stage closed");
    expect(hives.eligible).toBe(false);
  });

  it("Pixel Blobs: minted 1 and cap 1 means want 0", () => {
    const now = 1794240000; // inside GTD
    const rows = decideDrop({ drop: blobs, elig: elyantElig, minted: 1, nowSec: now });
    const gtd = rows.find((r) => r.name === "GTD")!;
    expect(gtd.want).toBe(0);
    expect(gtd.reason).toBe("cap reached");
    expect(gtd.eligible).toBe(false);
  });

  it("trusts the drop clock when eligibility mintParams are still open", () => {
    const stale: KalosEligibility = {
      ...elyantElig,
      entries: elyantElig.entries.map((e) => (e.stageIndex === 1 ? { ...e, mintParams: { ...e.mintParams, endTime: "1999999999" } } : e)),
    };
    const now = 1794240000; // Hives has ended on the drop object
    const hives = decideDrop({ drop: elyant, elig: stale, minted: 0, nowSec: now }).find((r) => r.name === "Hives")!;
    expect(stageClock(1794231000, 1794236400, now)).toBe("ended");
    expect(hives.reason).toBe("stage closed");
    expect(hives.entry?.mintParams.endTime).toBe("1999999999");
  });

  it("empty eligibility entries are not on the list", () => {
    const now = 1794240000;
    const colony = decideDrop({ drop: elyant, elig: emptyElig, minted: 0, nowSec: now }).find((r) => r.name === "Colony")!;
    expect(colony.reason).toBe("not on list");
    expect(colony.eligible).toBe(false);
  });

  it("copies the eligibility proof and mintParams into mintAllowList calldata", () => {
    const entry = elyantElig.entries[1];
    const data = encodeMintAllowList(elyant.address, elyant.feeRecipient, 1, entry.mintParams, entry.proof);
    const decoded = kalosIface.decodeFunctionData("mintAllowList", data);
    expect(decoded.proof.map((p: string) => p.toLowerCase())).toEqual(entry.proof.map((p) => p.toLowerCase()));
    expect(decoded.mintParams.mintPrice).toBe(BigInt(entry.mintParams.mintPrice));
    expect(decoded.mintParams.dropStageIndex).toBe(BigInt(entry.mintParams.dropStageIndex));
    expect(decoded.mintParams.restrictFeeRecipients).toBe(true);
    expect(decoded.quantity).toBe(1n);
    expect(data.startsWith(new Interface([kalosIface.getFunction("mintAllowList")]).getFunction("mintAllowList")!.selector)).toBe(true);
  });

  it("a short balance does not remove allowlist eligibility, and SeaDrop choice follows the contract", () => {
    const now = 1794240000;
    const colony = decideDrop({
      drop: elyant,
      elig: elyantElig,
      minted: 1,
      nowSec: now,
      balanceWei: 0n,
      gasWei: 1n,
    }).find((r) => r.name === "Colony")!;
    expect(colony.eligible).toBe(true);
    expect(colony.reason).toBe("insufficient balance");
    expect(chooseSeaDrop([KALOS_SEADROP], false).use).toBe("kalos");
    expect(chooseSeaDrop([OPENSEA_SEADROP], true).use).toBe("opensea");
    const stages = kalosStages(elyant, now);
    expect(stages.find((s) => s.name === "Colony")).toMatchObject({ source: "kalos", priceWei: "8000000000000000", kalosIndex: 2 });
    expect(stages.find((s) => s.name === "Public")?.type).toBe("public");
  });
});
