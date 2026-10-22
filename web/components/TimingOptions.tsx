// SPDX-License-Identifier: AGPL-3.0-only
import type { TimingOption } from "@nft-mint-bot/server/stage-eligibility";

type Fmt = (when: string | number | Date | null | undefined) => string;

/** Title (bold) and detail line for one timing choice. */
export function timingText(o: TimingOption, fmt: Fmt): { title: string; sub: string } {
  if (o.kind === "now")
    return { title: "Now", sub: o.stage ? `${o.name} is live${o.stage.end ? ` · ends ${fmt(o.stage.end)}` : ""}` : "Mint immediately" };
  if (o.live) return { title: o.name, sub: `Live now${o.stage?.end ? ` · ends ${fmt(o.stage.end)}` : ""}` };
  return { title: o.name, sub: fmt(o.runAt) };
}

/** Mint · Timing radio list: one full-width row per option (radio left, name bold, time beneath). */
export function TimingOptions({
  options,
  chosenKey,
  fmt,
  onPick,
}: {
  options: TimingOption[];
  chosenKey: string | null;
  fmt: Fmt;
  onPick: (key: string) => void;
}) {
  if (!options.length) return <div className="notice">No mint stage is live or scheduled for the selected wallets.</div>;
  return (
    <div className="timing-options" role="radiogroup" aria-label="When to mint">
      {options.map((o) => {
        const { title, sub } = timingText(o, fmt);
        return (
          <label key={o.key} className={`timing-option${chosenKey === o.key ? " on" : ""}`}>
            <input type="radio" name="timing" checked={chosenKey === o.key} onChange={() => onPick(o.key)} />
            <span className="timing-text">
              <b>{title}</b>
              <span className="timing-sub">{sub}</span>
            </span>
          </label>
        );
      })}
    </div>
  );
}
