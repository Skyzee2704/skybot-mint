// SPDX-License-Identifier: AGPL-3.0-only
/** Display labels shared across pages. */
export const STRATEGY_LABELS: Record<string, string> = {
  seadrop_public: "SeaDrop Public",
  opensea_api: "OpenSea Mint API",
  generic: "Generic Contract",
};
export const strategyLabel = (s: string) => STRATEGY_LABELS[s] ?? s;
