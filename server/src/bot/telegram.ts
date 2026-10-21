// SPDX-License-Identifier: AGPL-3.0-only
/**
 * SkyBOT Mint Telegram bot — multi-user + Mini App.
 * Account linking (works without public domain):
 *   (a) Web → Telegram: Settings generates code + https://t.me/<bot>?start=link_<code>
 *   (b) Telegram → Web: /link gives a code to paste in Settings
 * Mini App (requires PUBLIC_URL=https://…):
 *   Menu button + /start "Open Dashboard" open the dashboard inside Telegram.
 */
import { Bot, InlineKeyboard } from "grammy";
import { env } from "../config/env.js";
import { resolveTarget } from "../core/resolver/resolver.js";
import { remember } from "../core/resolver/cache.js";
import { consumeTelegramLink, userByTelegram, createReverseTelegramCode, unlinkTelegram, type AppUser } from "../users/service.js";
import { publicHttpsReady } from "./telegramWebApp.js";
import { log, redactString } from "../util/log.js";
import { formatEther } from "ethers";

export const esc = (s: unknown) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

export function summarize(t: Awaited<ReturnType<typeof resolveTarget>>): string {
  return [
    `<b>${esc(t.name ?? "Unknown")}</b> (${esc(t.symbol ?? "?")}) on ${esc(t.chain.name)}`,
    `Contract: <code>${t.contract}</code>${t.slug ? ` · <a href="https://opensea.io/collection/${encodeURIComponent(t.slug)}">OpenSea</a>` : ""}`,
    `Type: ${t.kind === "seadrop" ? "OpenSea SeaDrop" : "Generic"} · ${t.standard}`,
    `Supply: ${t.supply.total ?? "?"}/${t.supply.max ?? "?"} (remaining ${t.supply.remaining ?? "?"})`,
    ...t.stages.map(
      (s) =>
        `• ${esc(s.name)} [${s.type}]: ${s.priceWei !== null ? formatEther(s.priceWei) + " " + t.chain.nativeSymbol : "price ?"} · ${s.status}${s.start ? " · " + s.start.replace(".000Z", "Z") : ""}`,
    ),
    `Strategy: ${t.recommendedStrategy}`,
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
    { command: "link", description: "Get a code to paste on the web" },
    { command: "unlink", description: "Disconnect Telegram from SkyBOT" },
    { command: "mint", description: "Resolve a drop: /mint <link|address>" },
    { command: "wallets", description: "List your wallets" },
    { command: "jobs", description: "Recent mint jobs" },
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
    "<b>Link your account</b> (required before minting):",
    "1. Open the dashboard → Settings → <i>Connect Telegram</i>, tap the deep link, or",
    "2. Send /link here and paste the code into Settings.",
    "",
    mini
      ? "Tap <b>Open Dashboard</b> or the menu button to open SkyBOT inside Telegram."
      : "Dashboard opens in the browser until PUBLIC_URL is a public https:// URL.",
    "",
    "<b>Commands</b>",
    "/mint &lt;link|address&gt; — drop summary + open dashboard",
    "/wallets — your wallets",
    "/jobs — recent jobs",
    "/unlink — disconnect Telegram",
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
        await ctx.reply(`Could not link: ${esc(e.message)}\nGenerate a new code in Settings.`, { parse_mode: "HTML" });
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

  bot.command("link", async (ctx) => {
    const existing = await linkedUser(ctx);
    if (existing) {
      await ctx.reply(`Already linked as ${esc(existing.email ?? existing.id.slice(0, 8))}. /unlink first to re-link.`, {
        parse_mode: "HTML",
      });
      return;
    }
    const { code, expiresAt } = await createReverseTelegramCode(String(ctx.from!.id), ctx.from?.username ?? null);
    await ctx.reply(
      `Paste this one-time code in the dashboard → <b>Settings → Connect Telegram</b>:\n\n<code>${code}</code>\n\nExpires ${esc(expiresAt)}.`,
      { parse_mode: "HTML" },
    );
  });

  bot.command("unlink", async (ctx) => {
    const u = await linkedUser(ctx);
    if (!u) {
      await ctx.reply("Not linked.");
      return;
    }
    await unlinkTelegram(u.id);
    await ctx.reply("Unlinked. You can /link again anytime.");
  });

  bot.command("wallets", async (ctx) => {
    const u = await linkedUser(ctx);
    if (!u) return ctx.reply("Link your account first: open Settings in the dashboard, or /link.");
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
    if (!u) return ctx.reply("Link your account first.");
    const { listJobs } = await import("../core/jobs/repo.js");
    const js = await listJobs(u.id, 10);
    if (!js.length) return ctx.reply("No jobs yet.");
    await ctx.reply(js.map((j) => `${j.status} · ${j.chain} · <code>${j.target.slice(0, 10)}…</code> · ${j.runAt ?? "now"}`).join("\n"), {
      parse_mode: "HTML",
    });
  });

  bot.command("mint", async (ctx) => {
    const u = await linkedUser(ctx);
    if (!u) return ctx.reply("Link your account first: Settings → Connect Telegram, or /link.");
    const arg = (ctx.message?.text ?? "").replace(/^\/mint(@\w+)?\s*/, "").trim();
    if (!arg) return ctx.reply("Usage: /mint &lt;opensea link | slug | 0xaddress&gt; [chain]", { parse_mode: "HTML" });
    const [input, chain] = arg.split(/\s+/);
    try {
      const t = remember(await resolveTarget({ input, chain }));
      const path = `/app/mint?input=${encodeURIComponent(input)}&chain=${t.chain.key}`;
      const kb = new InlineKeyboard();
      if (mini) kb.webApp("Open Dashboard", dashUrl(path));
      else kb.url("Check eligibility & mint", dashUrl(path));
      await ctx.reply(`${summarize(t)}\n\nOpen the dashboard to pick wallets, simulate, and confirm.`, {
        parse_mode: "HTML",
        reply_markup: kb,
        link_preview_options: { is_disabled: true },
      });
    } catch (e: any) {
      await ctx.reply(`Could not resolve: ${esc(redactString(e.message))}`, { parse_mode: "HTML" });
    }
  });

  bot.on("message:text", async (ctx) => {
    if (ctx.message.text.startsWith("/")) return ctx.reply("Unknown command. /help");
    const u = await linkedUser(ctx);
    if (!u) return ctx.reply("Link your account first. /help");
    const [input, chain] = ctx.message.text.trim().split(/\s+/);
    try {
      const t = remember(await resolveTarget({ input, chain }));
      const path = `/app/mint?input=${encodeURIComponent(input)}&chain=${t.chain.key}`;
      const kb = new InlineKeyboard();
      if (mini) kb.webApp("Open Dashboard", dashUrl(path));
      else kb.url("Open in SkyBOT", dashUrl(path));
      await ctx.reply(`${summarize(t)}`, { parse_mode: "HTML", reply_markup: kb, link_preview_options: { is_disabled: true } });
    } catch (e: any) {
      await ctx.reply(`Could not resolve: ${esc(redactString(e.message))}`, { parse_mode: "HTML" });
    }
  });

  bot.catch((e) => log.error("telegram error", redactString(String((e.error as any)?.message ?? e.error))));
  return bot;
}
