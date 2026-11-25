import { timingSafeEqual } from "node:crypto";
import { handleUpdate } from "../lib/bot.js";
import { eventOf, statsEnabled, statsText, track, userOf } from "../lib/stats.js";

/**
 * Telegram webhook (Vercel function, POST /api/webhook).
 *
 * Environment:
 *   TELEGRAM_BOT_TOKEN       the token from @BotFather (required)
 *   TELEGRAM_WEBHOOK_SECRET  the secret given to setWebhook: requests without it are refused (required)
 *   SITE_URL, BOT_USERNAME   optional overrides of lib/bot.js DEFAULTS
 *   ADMIN_ID                 the owner's Telegram user id (the bot gives it with /id): only they get /stats
 *   KV_REST_API_URL, KV_REST_API_TOKEN   the Upstash database the counts live in (lib/stats.js)
 */

function sameSecret(given, expected) {
  const a = Buffer.from(String(given ?? ""));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function call(token, { method, params }) {
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) {
    // The token is in the URL: log Telegram's answer only, never the request.
    const body = await r.json().catch(() => ({}));
    console.error(`${method} failed: ${r.status} ${body.description ?? ""}`);
  }
}

/** /stats, for the owner only, in a private chat. Anyone else gets the ordinary reply to an unknown command. */
async function adminReply(update) {
  const msg = update?.message;
  if (!msg || msg.chat?.type !== "private" || !/^\/stats(@\w+)?\s*$/i.test(msg.text ?? "")) return null;
  const adminId = process.env.ADMIN_ID;
  if (!adminId || String(msg.from?.id) !== adminId.trim()) return null;
  const text = !statsEnabled()
    ? "📊 No database is connected yet, so nothing is counted. Add Upstash Redis to this project in Vercel (Storage tab), then redeploy."
    : ((await statsText()) ?? "⚠️ The statistics database didn't answer. Try again in a moment.");
  return [{ method: "sendMessage", params: { chat_id: msg.chat.id, text, parse_mode: "HTML" } }];
}

export default async function handler(req, res) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!token || !secret) return res.status(500).json({ ok: false, error: "bot not configured" });
  if (req.method !== "POST") return res.status(405).json({ ok: false });
  if (!sameSecret(req.headers["x-telegram-bot-api-secret-token"], secret)) return res.status(401).json({ ok: false });

  const config = {};
  if (process.env.SITE_URL) config.siteUrl = process.env.SITE_URL;
  if (process.env.BOT_USERNAME) config.botUsername = process.env.BOT_USERNAME;

  try {
    const update = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const admin = await adminReply(update);
    const replies = admin ?? handleUpdate(update, config);
    for (const c of replies) await call(token, c);
    if (!admin) await track(userOf(update), eventOf(update, replies));
  } catch (e) {
    console.error("update failed:", e?.name ?? "error");
  }
  // Always 200: a failed reply must not make Telegram resend the same update for hours.
  return res.status(200).json({ ok: true });
}
