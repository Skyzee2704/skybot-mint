import { Bot } from "grammy";
import { env } from "../config/env.js";
import { resolveTarget } from "../core/resolver/resolver.js";
import { remember } from "../core/resolver/cache.js";
import { getStore } from "../core/store.js";
import { onJobUpdate } from "../worker/worker.js";
import { session } from "../core/keystore/session.js";
import { log, redactString } from "../util/log.js";
import { formatEther } from "ethers";

/**
 * Telegram bot (grammY). Disabled unless TELEGRAM_BOT_TOKEN and TELEGRAM_USER_ID are set.
 * Only the configured user may talk to it. This first cut is read-only + notifications:
 * paste a link/address -> drop summary + dashboard link. Minting is confirmed in the dashboard.
 */
export function summarize(t: Awaited<ReturnType<typeof resolveTarget>>): string {
  const lines = [
    `*${t.name ?? "Unknown"}* (${t.symbol ?? "?"}) on ${t.chain.name}`,
    `Contract: \`${t.contract}\``,
    `Type: ${t.kind === "seadrop" ? "OpenSea SeaDrop" : "Generic contract"} · ${t.standard}`,
    `Supply: ${t.supply.total ?? "?"}/${t.supply.max ?? "?"} (remaining ${t.supply.remaining ?? "?"})`,
    ...t.stages.map((s) => `• ${s.name}: ${s.priceWei !== null ? formatEther(s.priceWei) + " " + t.chain.nativeSymbol : "price ?"} · ${s.status}${s.start ? " · starts " + s.start : ""}`),
    `Strategy: ${t.recommendedStrategy}`,
    ...t.warnings.map((w) => `⚠️ ${w}`),
  ];
  return lines.join("\n");
}

export async function startTelegram(): Promise<Bot | null> {
  const token = env.telegramBotToken; const userId = env.telegramUserId;
  if (!token) { log.info("Telegram bot disabled (TELEGRAM_BOT_TOKEN not set)"); return null; }
  if (!userId) { log.warn("Telegram bot disabled: TELEGRAM_USER_ID not set (refusing to run an open bot)"); return null; }
  const bot = new Bot(token);
  bot.use(async (ctx, next) => { if (String(ctx.from?.id) !== userId) return; await next(); });
  bot.command("start", (ctx) => ctx.reply("NFT mint bot ready. Paste an OpenSea link, slug, or contract address (optionally followed by a chain, e.g. `0x… base`).", { parse_mode: "Markdown" }));
  bot.command("status", (ctx) => ctx.reply(`Keystore: ${session.unlocked ? "unlocked" : "locked"}\nWallets: ${getStore().db.wallets.length}\nDashboard: ${env.dashboardUrl}`));
  bot.command("jobs", (ctx) => {
    const jobs = getStore().db.jobs.slice(0, 10);
    return ctx.reply(jobs.length ? jobs.map((j) => `${j.status} · ${j.chain} · ${j.target.slice(0, 10)}… · ${j.runAt ?? "now"}`).join("\n") : "No jobs");
  });
  bot.on("message:text", async (ctx) => {
    const [input, chain] = ctx.message.text.trim().split(/\s+/);
    try {
      const t = remember(await resolveTarget({ input, chain }));
      await ctx.reply(`${summarize(t)}\n\nOpen the dashboard to check eligibility and mint: ${env.dashboardUrl}/?input=${encodeURIComponent(input)}&chain=${t.chain.key}`, { parse_mode: "Markdown" });
    } catch (e: any) { await ctx.reply(`Could not resolve: ${redactString(e.message)}`); }
  });
  bot.catch((e) => log.error("telegram error", e.error));
  onJobUpdate((j) => {
    if (j.status !== "done" && j.status !== "failed") return;
    const ok = (j.results as any[]).filter((r) => r.status === "confirmed");
    const msg = `Job ${j.status}: ${j.chain} ${j.target}\n${ok.length} wallet(s) minted${ok.length ? ": " + ok.map((r) => `${r.address.slice(0, 8)}… [${(r.tokenIds ?? []).join(",")}]`).join("; ") : ""}${j.error ? "\n" + j.error : ""}`;
    bot.api.sendMessage(userId, msg).catch((e) => log.warn("telegram notify failed", e));
  });
  void bot.start({ onStart: () => log.info("Telegram bot started") }).catch((e) => log.error("Telegram bot failed to start", e));
  return bot;
}
