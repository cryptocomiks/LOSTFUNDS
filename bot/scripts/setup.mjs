/**
 * One-time setup of the bot on Telegram's side. Run it again whenever the texts or the URL change.
 *
 *   TELEGRAM_BOT_TOKEN=… node scripts/setup.mjs
 *       sets the command list, the descriptions and the menu button (opens the site as a Mini App)
 *
 *   TELEGRAM_BOT_TOKEN=… TELEGRAM_WEBHOOK_SECRET=… node scripts/setup.mjs https://<bot-project>.vercel.app
 *       same, and points Telegram's webhook at <that address>/api/webhook
 */
import { profileCalls } from "../lib/bot.js";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error("Set TELEGRAM_BOT_TOKEN.");
  process.exit(1);
}

async function call(method, params = {}) {
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
  });
  const body = await r.json().catch(() => ({}));
  console.log(`${body.ok ? "ok  " : "FAIL"} ${method}${body.ok ? "" : `: ${body.description ?? r.status}`}`);
  if (!body.ok) process.exitCode = 1;
  return body.result;
}

const config = {};
if (process.env.SITE_URL) config.siteUrl = process.env.SITE_URL;

const me = await call("getMe");
if (!me) process.exit(1);
console.log(`     @${me.username}`);

for (const c of profileCalls(config)) await call(c.method, c.params);

const base = process.argv[2];
if (base) {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret || !/^[A-Za-z0-9_-]{16,256}$/.test(secret)) {
    console.error("Set TELEGRAM_WEBHOOK_SECRET (16+ characters: letters, digits, _ and -), the same value as on Vercel.");
    process.exit(1);
  }
  await call("setWebhook", {
    url: `${base.replace(/\/+$/, "")}/api/webhook`,
    secret_token: secret,
    allowed_updates: ["message", "inline_query", "callback_query"],
    drop_pending_updates: true,
  });
  const info = await call("getWebhookInfo");
  if (info) console.log(`     webhook: ${info.url}${info.last_error_message ? ` (last error: ${info.last_error_message})` : ""}`);
} else {
  console.log("     no URL given: webhook left as it is");
}
if (!me.supports_inline_queries) console.log("     inline mode is off: enable it in @BotFather with /setinline (optional)");
