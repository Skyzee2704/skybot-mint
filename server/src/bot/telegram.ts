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
export const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** HTML summary (HTML parse mode is safe for arbitrary collection names, unlike Markdown). */
export function summarize(t: Awaited<ReturnType<typeof resolveTarget>>): string {
  const lines = [
    `<b>${esc(t.name ?? "Unknown")}</b> (${esc(t.symbol ?? "?")}) on ${esc(t.chain.name)}`,
    `Contract: <code>${t.contract}</code>${t.slug ? ` · <a href="https://opensea.io/collection/${encodeURIComponent(t.slug)}">OpenSea</a>` : ""}`,
    `Type: ${t.kind === "seadrop" ? "OpenSea SeaDrop" : "Generic contract"} · ${t.standard}`,
    `Supply: ${t.supply.total ?? "?"}/${t.supply.max ?? "?"} (remaining ${t.supply.remaining ?? "?"})`,
    ...t.stages.map((s) => `• ${esc(s.name)} [${s.type}]: ${s.priceWei !== null ? formatEther(s.priceWei) + " " + t.chain.nativeSymbol : "price ?"} · ${s.status}${s.start ? " · " + s.start.replace(".000Z", "Z") : ""}${s.end ? " → " + s.end.replace(".000Z", "Z") : ""}`),
    `Strategy: ${t.recommendedStrategy}`,
    ...t.warnings.map((w) => `⚠️ ${esc(w)}`),
  ];
  return lines.join("\n");
}

export async function startTelegram(): Promise<Bot | null> {
  const token = env.telegramBotToken; const userId = env.telegramUserId;
  if (!token) { log.info("Telegram bot disabled (TELEGRAM_BOT_TOKEN not set)"); return null; }
  if (!userId) { log.warn("Telegram bot disabled: TELEGRAM_USER_ID not set (refusing to run an open bot)"); return null; }
  const bot = createBot(token, userId);
  try { const me = await bot.api.getMe(); log.info(`Telegram bot @${me.username} authenticated (replies only to the configured user id)`); }
  catch (e: any) { log.error("Telegram getMe failed — bot disabled", redactString(String(e?.message ?? e))); return null; }
  onJobUpdate((j) => {
    if (j.status !== "done" && j.status !== "failed") return;
    const ok = (j.results as any[]).filter((r) => r.status === "confirmed");
    const msg = `Job ${j.status}: ${j.chain} ${j.target}\n${ok.length} wallet(s) minted${ok.length ? ": " + ok.map((r) => `${r.address.slice(0, 8)}… [${(r.tokenIds ?? []).join(",")}]`).join("; ") : ""}${j.error ? "\n" + j.error : ""}`;
    bot.api.sendMessage(userId, msg).catch((e) => log.warn("telegram notify failed", redactString(String(e?.message ?? e))));
  });
  void bot.start({ onStart: () => log.info("Telegram bot polling started"), drop_pending_updates: true }).catch((e) => log.error("Telegram bot stopped", redactString(String(e?.message ?? e))));
  return bot;
}

/** Build the bot with handlers (no network). Exported for tests. */
export function createBot(token: string, userId: string, opts: ConstructorParameters<typeof Bot>[1] = {}): Bot {
  const bot = new Bot(token, opts);
  bot.use(async (ctx, next) => { if (String(ctx.from?.id) !== userId) return; await next(); });
  const HELP = "Bot NFT mint aktif ✅\nPaste an OpenSea link, slug, or contract address (optionally followed by a chain, e.g. <code>0x… base</code>).\n/status · /jobs · /help\nMinting is confirmed in the dashboard.";
  bot.command(["start", "help"], (ctx) => ctx.reply(HELP, { parse_mode: "HTML" }));
  bot.command("status", (ctx) => ctx.reply(`Keystore: ${session.unlocked ? "unlocked" : "locked"}\nWallets: ${getStore().db.wallets.length}\nDashboard: ${env.dashboardUrl}`));
  bot.command("jobs", (ctx) => {
    const jobs = getStore().db.jobs.slice(0, 10);
    return ctx.reply(jobs.length ? jobs.map((j) => `${j.status} · ${j.chain} · ${j.target.slice(0, 10)}… · ${j.runAt ?? "now"}`).join("\n") : "No jobs");
  });
  bot.on("message:text", async (ctx) => {
    if (ctx.message.text.startsWith("/")) return ctx.reply("Unknown command. /help");
    const [input, chain] = ctx.message.text.trim().split(/\s+/);
    try {
      const t = remember(await resolveTarget({ input, chain }));
      await ctx.reply(`${summarize(t)}\n\nDashboard (check eligibility &amp; mint): ${esc(`${env.dashboardUrl}/?input=${encodeURIComponent(input)}&chain=${t.chain.key}`)}`, { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
    } catch (e: any) { await ctx.reply(`Could not resolve: ${redactString(e.message)}`); }
  });
  bot.catch((e) => log.error("telegram error", redactString(String((e.error as any)?.message ?? e.error))));
  return bot;
}
