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
import type { resolveTarget } from "../core/resolver/resolver.js";
import { resolveCached } from "../core/resolver/cache.js";
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

import { esc, formatCheck, parseCheckArgs } from "./check.js";
import { formatDropSummary, openSeaUrl } from "./format.js";
import { formatDateTime } from "../util/time.js";
export { esc };

const tzFooter = (tz: string | null | undefined) => (tz ? "" : "\n<i>Times in UTC. Open SkyBOT once to see your own timezone.</i>");

/** Back-compat alias: the compact drop summary used by /mint and plain links. */
export function summarize(t: Awaited<ReturnType<typeof resolveTarget>>, timeZone: string | null = null): string {
  return formatDropSummary(t, timeZone);
}

/** Callback payload for "Check eligibility" (≤ 64 bytes): the OpenSea slug when it fits, else chain + contract. */
export function checkCallbackData(t: { slug: string | null; chain: { key: string }; contract: string }): string {
  if (t.slug && `chk:s:${t.slug}`.length <= 64) return `chk:s:${t.slug}`;
  return `chk:a:${t.chain.key}:${t.contract}`.slice(0, 64);
}
export function parseCheckCallback(data: string): { input: string; chain?: string } | null {
  const m = /^chk:s:(.+)$/.exec(data);
  if (m) return { input: m[1]! };
  const a = /^chk:a:([a-z0-9-]+):(0x[0-9a-fA-F]{40})$/.exec(data);
  return a ? { input: a[2]!, chain: a[1]! } : null;
}

/** web_app buttons only work in private chats; groups get a plain URL button. */
function addOpenButton(kb: InlineKeyboard, chatType: string | undefined, label: string, url: string) {
  if (publicHttpsReady() && chatType === "private") kb.webApp(label, url);
  else kb.url(label, url);
  return kb;
}

/** Keyboard under a drop summary: [Open in SkyBOT] [Check eligibility] / [OpenSea]. */
export function dropKeyboard(
  t: Awaited<ReturnType<typeof resolveTarget>>,
  input: string,
  chatType: string | undefined,
  opts: { check?: boolean } = {},
) {
  const kb = new InlineKeyboard();
  addOpenButton(kb, chatType, "Open in SkyBOT", dashUrl(mintPath(input, t.chain.key)));
  if (opts.check !== false) kb.text("Check eligibility", checkCallbackData(t));
  const os = openSeaUrl(t);
  if (os) kb.row().url("OpenSea", os);
  return kb;
}
const mintPath = (input: string, chain: string) => `/app/mint?input=${encodeURIComponent(input)}&chain=${encodeURIComponent(chain)}`;

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

export const BOT_COMMANDS = [
  { command: "start", description: "Welcome and open the dashboard" },
  { command: "check", description: "Eligibility of all your wallets: /check <link|address>" },
  { command: "mint", description: "Drop summary, then mint in the dashboard" },
  { command: "wallets", description: "List your wallets" },
  { command: "jobs", description: "Recent and scheduled mints" },
  { command: "withdraw", description: "Withdraw funds from your wallets" },
  { command: "help", description: "How to use SkyBOT Mint" },
];

/** Keep the command menu in sync after a deploy (once per instance; one getMyCommands call when nothing changed). */
let commandsSynced = false;
async function syncCommandsOnce(bot: Bot) {
  if (commandsSynced) return;
  commandsSynced = true;
  try {
    const cur = await bot.api.getMyCommands();
    const same =
      cur.length === BOT_COMMANDS.length &&
      cur.every((c, i) => c.command === BOT_COMMANDS[i]!.command && c.description === BOT_COMMANDS[i]!.description);
    if (!same) await configureBotProfile(bot);
  } catch (e: any) {
    log.warn("telegram command sync failed", redactString(String(e?.message ?? e)));
  }
}

/** Commands, profile and menu button. Menu button opens the Mini App when PUBLIC_URL is public https. */
export async function configureBotProfile(bot: Bot) {
  await bot.api.setMyName("SkyBOT Mint").catch(() => {});
  await bot.api
    .setMyDescription("SkyBOT Mint — check and mint OpenSea drops and any NFT contract from the web dashboard or the Telegram Mini App.")
    .catch(() => {});
  await bot.api.setMyShortDescription("Mint NFTs with SkyBOT. Tap the menu button to open the dashboard.").catch(() => {});
  await bot.api.setMyCommands(BOT_COMMANDS);
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
  await syncCommandsOnce(webhookBot);
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
    "/jobs — recent and scheduled mints (tap Cancel under a mint that hasn't sent yet)",
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
    const { isCancellable } = await import("../jobs/scheduler.js");
    const js = await listJobs(u.id, 10);
    if (!js.length) return ctx.reply("No jobs yet.");
    // One Cancel button per job that can still be stopped (nothing broadcast yet); numbered like the list.
    const kb = new InlineKeyboard();
    js.forEach((j, i) => {
      if (isCancellable(j)) kb.text(`✖ Cancel #${i + 1}`, `jc:${j.id}`).row();
    });
    await ctx.reply(
      js
        .map(
          (j, i) =>
            `${i + 1}. ${esc(jobStatusLabel(j.status))} · ${esc(j.chain)} · <code>${j.target.slice(0, 6)}…${j.target.slice(-4)}</code>\n   ${
              j.runAt
                ? `${new Date(j.runAt).getTime() > Date.now() ? "runs" : "ran"} ${formatDateTime(j.runAt, { timeZone: u.timezone ?? null })}`
                : `created ${formatDateTime(j.createdAt, { timeZone: u.timezone ?? null })}`
            }`,
        )
        .join("\n") + tzFooter(u.timezone),
      { parse_mode: "HTML", ...(kb.inline_keyboard.length ? { reply_markup: kb } : {}) },
    );
  });

  // [Cancel #n] under /jobs → ask to confirm; [Yes, cancel] → cancel (owner only, same rules as the dashboard).
  bot.callbackQuery(/^jc:/, async (ctx) => {
    const id = ctx.callbackQuery.data.slice(3);
    const u = await linkedUser(ctx);
    if (!u) {
      await ctx.answerCallbackQuery({ text: "Open SkyBOT first to sign in with Telegram.", show_alert: true }).catch(() => {});
      return;
    }
    const { getJob } = await import("../core/jobs/repo.js");
    const j = await getJob(u.id, id);
    await ctx.answerCallbackQuery().catch(() => {});
    if (!j) return ctx.reply("That mint wasn't found.");
    await ctx.reply(
      `Cancel this mint?\n${esc(jobStatusLabel(j.status))} · ${esc(j.chain)} · <code>${j.target.slice(0, 6)}…${j.target.slice(-4)}</code>\nNothing has been sent yet. If it starts sending first, it can't be cancelled.`,
      { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("Yes, cancel", `jcy:${id}`).text("Keep it", "jcn") },
    );
  });

  bot.callbackQuery("jcn", async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Kept." }).catch(() => {});
    await ctx.editMessageText("Kept. The mint will run as planned.").catch(() => {});
  });

  bot.callbackQuery(/^jcy:/, async (ctx) => {
    const id = ctx.callbackQuery.data.slice(4);
    const u = await linkedUser(ctx);
    if (!u) {
      await ctx.answerCallbackQuery({ text: "Open SkyBOT first to sign in with Telegram.", show_alert: true }).catch(() => {});
      return;
    }
    const { cancelJob } = await import("../jobs/scheduler.js");
    try {
      await cancelJob({ id: u.id, admin: false }, id);
      await ctx.answerCallbackQuery({ text: "Cancelled." }).catch(() => {});
      await ctx.editMessageText("✅ Mint cancelled. Nothing was sent and no gas was spent.").catch(() => {});
    } catch (e: any) {
      const msg = redactString(String(e?.message ?? e)).slice(0, 180);
      await ctx.answerCallbackQuery({ text: msg, show_alert: true }).catch(() => {});
      await ctx.editMessageText(`Couldn't cancel: ${esc(msg)}`, { parse_mode: "HTML" }).catch(() => {});
    }
  });

  async function runCheck(ctx: any, u: AppUser, args: { input: string; chain?: string }) {
    try {
      await checkRateLimit(u.id, "tg:check", 6);
    } catch {
      return ctx.reply("Too many checks in a minute. Please wait a moment and try again.");
    }
    await ctx.replyWithChatAction("typing").catch(() => {});
    try {
      const t = await resolveCached(args.input, args.chain);
      const kb = dropKeyboard(t, args.input, ctx.chat?.type, { check: false });
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
  }

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
    await runCheck(ctx, u, args);
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
      const t = await resolveCached(input, chain);
      await ctx.reply(formatDropSummary(t, u.timezone ?? null), {
        parse_mode: "HTML",
        reply_markup: dropKeyboard(t, input, ctx.chat?.type),
        link_preview_options: { is_disabled: true },
      });
    } catch (e: any) {
      await ctx.reply(`Could not resolve: ${esc(redactString(e.message))}`, { parse_mode: "HTML" });
    }
  });

  // [Check eligibility] under a drop summary: same as /check for that collection.
  bot.callbackQuery(/^chk:/, async (ctx) => {
    const args = parseCheckCallback(ctx.callbackQuery.data);
    const u = await linkedUser(ctx);
    if (!u) {
      await ctx.answerCallbackQuery({ text: "Open SkyBOT first to sign in with Telegram.", show_alert: true }).catch(() => {});
      return;
    }
    if (!args) {
      await ctx.answerCallbackQuery({ text: "This button has expired. Send the link again." }).catch(() => {});
      return;
    }
    await ctx.answerCallbackQuery({ text: "Checking your wallets…" }).catch(() => {});
    await runCheck(ctx, u, args);
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
      const t = await resolveCached(input, chain);
      await ctx.reply(formatDropSummary(t, u.timezone ?? null), {
        parse_mode: "HTML",
        reply_markup: dropKeyboard(t, input, ctx.chat?.type),
        link_preview_options: { is_disabled: true },
      });
    } catch (e: any) {
      await ctx.reply(`Could not resolve: ${esc(redactString(e.message))}`, { parse_mode: "HTML" });
    }
  });

  bot.catch((e) => log.error("telegram error", redactString(String((e.error as any)?.message ?? e.error))));
  return bot;
}
