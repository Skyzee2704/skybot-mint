// SPDX-License-Identifier: AGPL-3.0-only
import { KALOS_SEADROP, OPENSEA_SEADROP } from "./types.js";

export function chooseSeaDrop(allowed: string[] | null, fromKalosLink: boolean): { use: "kalos" | "opensea"; warning?: string } {
  if (!allowed) {
    return {
      use: "kalos",
      warning: fromKalosLink
        ? undefined
        : "Could not read which SeaDrop this contract allows. Using Kalos because it has a drop for this address.",
    };
  }
  const set = new Set(allowed.map((a) => a.toLowerCase()));
  const hasK = set.has(KALOS_SEADROP.toLowerCase());
  const hasO = set.has(OPENSEA_SEADROP.toLowerCase());
  if (hasK && !hasO)
    return {
      use: "kalos",
      warning: fromKalosLink
        ? undefined
        : "OpenSea may list this collection, but the contract allows the Kalos SeaDrop, so stages come from Kalos.",
    };
  if (hasO && !hasK)
    return {
      use: "opensea",
      warning: "Kalos lists this drop, but the contract allows the OpenSea SeaDrop, so stages come from OpenSea.",
    };
  if (hasK && hasO)
    return fromKalosLink
      ? { use: "kalos", warning: "The contract allows both SeaDrops. Using Kalos because the link is a Kalos drop." }
      : { use: "opensea", warning: "The contract allows both SeaDrops. Using OpenSea because the link is not a Kalos drop." };
  return fromKalosLink
    ? { use: "kalos", warning: "The contract's SeaDrop list does not include Kalos or OpenSea. Using the Kalos drop record." }
    : { use: "opensea" };
}
