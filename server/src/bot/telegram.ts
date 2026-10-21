// SPDX-License-Identifier: AGPL-3.0-only
/**
 * SkyBOT Mint Telegram bot — multi-user + Mini App.
 * Accounts are unified through Privy: opening the Mini App signs the user in with Telegram (seamless
 * Privy login, verified-initData session as fallback), and the same SkyBOT account is used on the web
 * when they sign in with Telegram there or link email/Google in Privy. No manual link codes.
 * Legacy `start=link_<code>` deep links are still honoured for backward compatibility.
 * Mini App (requires PUBLIC_URL=https://…):
 *   Menu button + /start "Open Dashboard" open the dashboard inside Telegram.
 */
import { Bot, InlineKeyboard } from "grammy";
import { env } from "../config/env.js";
import { resolveTarget } from "../core/resolver/resolver.js";
import { remember } from "../core/resolver/cache.js";
import { checkRateLimit, consumeTelegramLink, userByTelegram, unlinkTelegram, type AppUser } from "../users/service.js";

const JOB_STATUS: Record<string, string> = {
  scheduled: "Scheduled",
  waiting_unlock: "Waiting",
  running: "Running",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};
const jobStatusLabel = (s: string) => JOB_STATUS[s] ?? s;
import { publicHttpsReady } from "./telegramWebApp.js";
import { log, redactString } from "../util/log.js";
import { formatEther } from "ethers";

import { esc, formatCheck, parseCheckArgs } from "./check.js";
import { formatDateTime } from "../util/time.js";
export { esc };

const tzFooter = (tz: string | null | undefined) => (tz ? "" : "\n<i>Times in UTC. Open SkyBOT once to see your own timezone.</i>");

export function summarize(t: Awaited<ReturnType<typeof resolveTarget>>, timeZone: string | null = null): string {
  return [
    `<b>${esc(t.name ?? "Unknown")}</b> (${esc(t.symbol ?? "?")}) on ${esc(t.chain.name)}`,
    `Contract: <code>${t.contract}</code>${t.slug ? ` · <a href="https://opensea.io/collection/${encodeURIComponent(t.slug)}">OpenSea</a>` : ""}`,
    `Type: ${t.kind === "seadrop" ? "OpenSea SeaDrop" : "Generic"} · ${t.standard}`,
    `Supply: ${t.supply.total ?? "?"}/${t.supply.max ?? "?"} (remaining ${t.supply.remaining ?? "?"})`,
    ...t.stages.map(
      (s) =>
        `• ${esc(s.name)}: ${s.priceWei !== null ? (s.priceWei === "0" ? "Free" : formatEther(s.priceWei) + " " + t.chain.nativeSymbol) : "price unknown"}${s.maxPerWallet ? ` · max ${s.maxPerWallet}/wallet` : ""} · ${s.status === "upcoming" && s.start ? "starts " + formatDateTime(s.start, { timeZone }) : s.status === "active" ? "live now" : s.status}`,
    ),
    ...t.warnings.map((w) => `⚠️ ${esc(w)}`),
  ].join("\n");
}

async function linkedUser(ctx: { from?: { id: number } | undefined }): Promise<AppUser | null> {
  if (!ctx.from) return null;
  return userByTelegram(String(ctx.from.id));
}

function dashUrl(path = "/app/mint") {
  const base = env.publicUrl.replace(/\/$/, "");
  return `${base}${path.startsWith("/") ? path : "/" + path}`;
}

function openDashboardKeyboard() {
  const kb = new InlineKeyboard();
  if (publicHttpsReady()) {
    kb.webApp("Open Dashboard", dashUrl("/"));
  } else {
    kb.url("Open Dashboard", dashUrl("/"));
  }
  return kb;
}

/** Commands, profile and menu button. Menu button opens the Mini App when PUBLIC_URL is public https. */
export async function configureBotProfile(bot: Bot) {
  await bot.api.setMyName("SkyBOT Mint").catch(() => {});
  await bot.api
    .setMyDescription("SkyBOT Mint — mint OpenSea drops and any NFT contract from Telegram or the web dashboard.")
    .catch(() => {});
  await bot.api.setMyShortDescription("Mint NFTs with SkyBOT. Tap the menu button to open the dashboard.").catch(() => {});
  await bot.api.setMyCommands([
    { command: "start", description: "Welcome and open the dashboard" },
    { command: "check", description: "Eligibility of all your wallets: /check <link|address>" },
    { command: "mint", description: "Drop summary, then mint in the dashboard" },
    { command: "wallets", description: "List your wallets" },
    { command: "jobs", description: "Recent and scheduled mints" },
    { command: "withdraw", description: "Withdraw funds from your wallets" },
    { command: "help", description: "How to use SkyBOT Mint" },
  ]);
  if (publicHttpsReady()) {
    await bot.api.setChatMenuButton({ menu_button: { type: "web_app", text: "SkyBOT Mint", web_app: { url: dashUrl("/") } } });
    return { menuButton: dashUrl("/") };
  }
  await bot.api.setChatMenuButton({ menu_button: { type: "commands" } }).catch(() => {});
  return { menuButton: null };
}

/** Production: register webhook (secret required) + profile. Called from the admin setup route/script. */
export async function setupTelegramWebhook() {
  const token = env.telegramBotToken;
  if (!token) throw Object.assign(new Error("TELEGRAM_BOT_TOKEN not set"), { statusCode: 503 });
  const secret = env.telegramWebhookSecret;
  if (!secret || secret.length < 16)
    throw Object.assign(new Error("TELEGRAM_WEBHOOK_SECRET missing or too short (≥16 chars)"), { statusCode: 503 });
  if (!publicHttpsReady()) throw Object.assign(new Error("PUBLIC_URL must be a public https URL"), { statusCode: 400 });
  const bot = new Bot(token);
  const url = `${env.publicUrl}/api/telegram/webhook`;
  await bot.api.setWebhook(url, { secret_token: secret, drop_pending_updates: true, allowed_updates: ["message", "callback_query"] });
  const profile = await configureBotProfile(bot);
  const info = await bot.api.getWebhookInfo();
  return { webhook: url, pending: info.pending_update_count, lastError: info.last_error_message ?? null, ...profile };
}

/** Serverless webhook: one cached Bot per instance; botInfo fetched once. */
let webhookBot: Bot | null = null;
export async function handleWebhookUpdate(update: unknown) {
  if (!env.telegramBotToken) throw Object.assign(new Error("bot not configured"), { statusCode: 503 });
  if (!webhookBot) {
    webhookBot = createBot(env.telegramBotToken);
    await webhookBot.init();
  }
  await webhookBot.handleUpdate(update as any);
}

/** Local dev: long polling (deletes any webhook first). */
export async function startPolling(): Promise<Bot | null> {
  const token = env.telegramBotToken;
  if (!token) {
    log.info("Telegram bot disabled (TELEGRAM_BOT_TOKEN not set)");
    return null;
  }
  const bot = createBot(token);
  try {
    const me = await bot.api.getMe();
    log.info(`Telegram bot @${me.username} authenticated`);
    if (me.username) process.env.TELEGRAM_BOT_USERNAME = me.username;
    await bot.api.deleteWebhook({ drop_pending_updates: true }).catch(() => {});
    const p = await configureBotProfile(bot).catch((e) => {
      log.warn("profile setup failed", redactString(String(e?.message ?? e)));
      return { menuButton: null };
    });
    log.info(p.menuButton ? `Mini App menu button → ${p.menuButton}` : "Mini App deferred — PUBLIC_URL is not public https");
  } catch (e: any) {
    log.error("Telegram getMe failed — bot disabled", redactString(String(e?.message ?? e)));
    return null;
  }
  void bot
    .start({ onStart: () => log.info("Telegram bot polling started (local)"), drop_pending_updates: true })
    .catch((e) => log.error("Telegram bot stopped", redactString(String(e?.message ?? e))));
  return bot;
}

export function createBot(token: string, opts: ConstructorParameters<typeof Bot>[1] = {}): Bot {
  const bot = new Bot(token, opts);
  const mini = publicHttpsReady();

  const HELP = [
    "<b>SkyBOT Mint</b> — mint OpenSea drops &amp; any NFT contract.",
    "",
    "<b>Sign in</b>: tap <b>Open Dashboard</b> (or the menu button). Your SkyBOT account is created with Telegram automatically.",
    "On the web, choose <i>Telegram</i> on the sign-in screen to use the same account. Email and Google can be linked in Settings.",
    "",
    mini
      ? "Tap <b>Open Dashboard</b> or the menu button to open SkyBOT inside Telegram."
      : "Dashboard opens in the browser until PUBLIC_URL is a public https:// URL.",
    "",
    "<b>Commands</b>",
    "/check &lt;link|address&gt; — stages + eligibility of all your wallets (read-only)",
    "/mint &lt;link|address&gt; — drop summary, then mint in the dashboard",
    "/wallets — your wallets",
    "/jobs — recent and scheduled mints",
    "/withdraw — open the Withdraw page",
    "",
    `Dashboard: ${esc(dashUrl("/"))}`,
  ].join("\n");

  bot.command(["start", "help"], async (ctx) => {
    const text = ctx.message?.text ?? "";
    const payload = text.split(/\s+/)[1] ?? "";
    if (payload.startsWith("link_")) {
      const code = payload.slice(5);
      try {
        const u = await consumeTelegramLink(code, String(ctx.from!.id), ctx.from?.username ?? null);
        await ctx.reply(`✅ Linked to SkyBOT as <b>${esc(u.email ?? u.name ?? u.id.slice(0, 8))}</b>.\nYou can /mint, /wallets, /jobs.`, {
          parse_mode: "HTML",
          reply_markup: openDashboardKeyboard(),
        });
      } catch (e: any) {
        await ctx.reply(`Could not link: ${esc(e.message)}\nTap Open Dashboard to sign in with Telegram instead.`, {
          parse_mode: "HTML",
          reply_markup: openDashboardKeyboard(),
        });
      }
      return;
    }
    const u = await linkedUser(ctx);
    const kb = openDashboardKeyboard();
    if (u)
      await ctx.reply(`Welcome back to <b>SkyBOT Mint</b> ✅\nLinked as ${esc(u.email ?? u.name ?? "user")}.\n\n${HELP}`, {
        parse_mode: "HTML",
        reply_markup: kb,
      });
    else await ctx.reply(`Welcome to <b>SkyBOT Mint</b>.\n\n${HELP}`, { parse_mode: "HTML", reply_markup: kb });
  });

  // Legacy command: link codes are replaced by Privy sign-in. Kept so old instructions get a helpful answer.
  bot.command("link", async (ctx) => {
    const existing = await linkedUser(ctx);
    await ctx.reply(
      existing
        ? `Already connected as ${esc(existing.email ?? existing.name ?? existing.id.slice(0, 8))}. Nothing else to do.`
        : "No codes needed anymore. Tap <b>Open Dashboard</b> to sign in with Telegram, or pick <i>Telegram</i> on the web sign-in screen.",
      { parse_mode: "HTML", reply_markup: openDashboardKeyboard() },
    );
  });

  bot.command("unlink", async (ctx) => {
    const u = await linkedUser(ctx);
    if (!u) {
      await ctx.reply("Not linked.");
      return;
    }
    await unlinkTelegram(u.id);
    await ctx.reply("Disconnected. Open the dashboard from this chat any time to connect again.");
  });

  bot.command("wallets", async (ctx) => {
    const u = await linkedUser(ctx);
    if (!u)
      return ctx.reply("Open SkyBOT first: tap Open Dashboard or the menu button to sign in with Telegram.", {
        reply_markup: openDashboardKeyboard(),
      });
    const { listWallets } = await import("../users/service.js");
    const ws = await listWallets(u.id);
    if (!ws.length) return ctx.reply("No wallets yet. Create some in the dashboard.");
    await ctx.reply(
      ws
        .map(
          (w: { isMain: boolean; label: string; address: string }) =>
            `${w.isMain ? "★ " : ""}<b>${esc(w.label)}</b>\n<code>${w.address}</code>`,
        )
        .join("\n\n"),
      { parse_mode: "HTML" },
    );
  });

  bot.command("jobs", async (ctx) => {
    const u = await linkedUser(ctx);
    if (!u)
      return ctx.reply("Open SkyBOT first: tap Open Dashboard or the menu button to sign in with Telegram.", {
        reply_markup: openDashboardKeyboard(),
      });
    const { listJobs } = await import("../core/jobs/repo.js");
    const js = await listJobs(u.id, 10);
    if (!js.length) return ctx.reply("No jobs yet.");
    await ctx.reply(
      js
        .map(
          (j) =>
            `${esc(jobStatusLabel(j.status))} · ${esc(j.chain)} · <code>${j.target.slice(0, 6)}…${j.target.slice(-4)}</code>\n   ${
              j.runAt
                ? `${new Date(j.runAt).getTime() > Date.now() ? "runs" : "ran"} ${formatDateTime(j.runAt, { timeZone: u.timezone ?? null })}`
                : `created ${formatDateTime(j.createdAt, { timeZone: u.timezone ?? null })}`
            }`,
        )
        .join("\n") + tzFooter(u.timezone),
      { parse_mode: "HTML" },
    );
  });

  bot.command("check", async (ctx) => {
    const u = await linkedUser(ctx);
    if (!u)
      return ctx.reply("Open SkyBOT first: tap Open Dashboard or the menu button to sign in with Telegram.", {
        reply_markup: openDashboardKeyboard(),
      });
    const args = parseCheckArgs(ctx.message?.text ?? "");
    if (!args)
      return ctx.reply(
        "Send an OpenSea link or a contract address, for example:\n<code>/check https://opensea.io/collection/name</code>\n<code>/check base:0x1234…abcd</code>",
        { parse_mode: "HTML" },
      );
    try {
      await checkRateLimit(u.id, "tg:check", 6);
    } catch {
      return ctx.reply("Too many checks in a minute. Please wait a moment and try again.");
    }
    await ctx.replyWithChatAction("typing").catch(() => {});
    try {
      const t = remember(await resolveTarget({ input: args.input, chain: args.chain }));
      const path = `/app/mint?input=${encodeURIComponent(args.input)}&chain=${t.chain.key}`;
      const kb = new InlineKeyboard();
      if (mini) kb.webApp("Open in SkyBOT", dashUrl(path));
      else kb.url("Open in SkyBOT", dashUrl(path));
      let rows: any[] = [];
      let targetStage: any = null;
      if (t.recommendedStrategy !== "none") {
        const { checkEligibility } = await import("../core/mint/eligibility.js");
        const r = await checkEligibility(t, t.recommendedStrategy, u.id, null, null, undefined, { serverSign: true });
        rows = r.rows;
        targetStage = r.targetStage;
      }
      const chunks = formatCheck({ target: t, rows, targetStage, timeZone: u.timezone ?? null });
      if (t.recommendedStrategy === "none")
        chunks[chunks.length - 1] += "\n\nSkyBOT can't find a supported mint function on this contract.";
      for (let i = 0; i < chunks.length; i++)
        await ctx.reply(chunks[i], {
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
          ...(i === chunks.length - 1 ? { reply_markup: kb } : {}),
        });
    } catch (e: any) {
      await ctx.reply(`Couldn't check that: ${esc(redactString(String(e?.message ?? e)).slice(0, 200))}`, { parse_mode: "HTML" });
    }
  });

  bot.command("withdraw", async (ctx) => {
    const kb = new InlineKeyboard();
    if (publicHttpsReady()) kb.webApp("Open Withdraw", dashUrl("/app/withdraw"));
    else kb.url("Open Withdraw", dashUrl("/app/withdraw"));
    await ctx.reply("Withdrawals are reviewed and signed in the dashboard. Pick wallets, a destination and amounts there.", {
      reply_markup: kb,
    });
  });

  bot.command("mint", async (ctx) => {
    const u = await linkedUser(ctx);
    if (!u)
      return ctx.reply("Open SkyBOT first: tap Open Dashboard or the menu button to sign in with Telegram.", {
        reply_markup: openDashboardKeyboard(),
      });
    const arg = (ctx.message?.text ?? "").replace(/^\/mint(@\w+)?\s*/, "").trim();
    if (!arg) return ctx.reply("Usage: /mint &lt;opensea link | slug | 0xaddress&gt; [chain]", { parse_mode: "HTML" });
    const [input, chain] = arg.split(/\s+/);
    try {
      const t = remember(await resolveTarget({ input, chain }));
      const path = `/app/mint?input=${encodeURIComponent(input)}&chain=${t.chain.key}`;
      const kb = new InlineKeyboard();
      if (mini) kb.webApp("Open Dashboard", dashUrl(path));
      else kb.url("Check eligibility & mint", dashUrl(path));
      await ctx.reply(
        `${summarize(t, u.timezone ?? null)}\n\nOpen the dashboard to pick wallets, simulate, and confirm.${tzFooter(u.timezone)}`,
        {
          parse_mode: "HTML",
          reply_markup: kb,
          link_preview_options: { is_disabled: true },
        },
      );
    } catch (e: any) {
      await ctx.reply(`Could not resolve: ${esc(redactString(e.message))}`, { parse_mode: "HTML" });
    }
  });

  bot.on("message:text", async (ctx) => {
    if (ctx.message.text.startsWith("/")) return ctx.reply("Unknown command. /help");
    const u = await linkedUser(ctx);
    if (!u)
      return ctx.reply("Open SkyBOT first: tap Open Dashboard or the menu button to sign in with Telegram.", {
        reply_markup: openDashboardKeyboard(),
      });
    const [input, chain] = ctx.message.text.trim().split(/\s+/);
    try {
      const t = remember(await resolveTarget({ input, chain }));
      const path = `/app/mint?input=${encodeURIComponent(input)}&chain=${t.chain.key}`;
      const kb = new InlineKeyboard();
      if (mini) kb.webApp("Open Dashboard", dashUrl(path));
      else kb.url("Open in SkyBOT", dashUrl(path));
      await ctx.reply(
        `${summarize(t, u.timezone ?? null)}${tzFooter(u.timezone)}\n\nTip: /check ${esc(input)} shows eligibility for all your wallets.`,
        {
          parse_mode: "HTML",
          reply_markup: kb,
          link_preview_options: { is_disabled: true },
        },
      );
    } catch (e: any) {
      await ctx.reply(`Could not resolve: ${esc(redactString(e.message))}`, { parse_mode: "HTML" });
    }
  });

  bot.catch((e) => log.error("telegram error", redactString(String((e.error as any)?.message ?? e.error))));
  return bot;
}
