import { timingSafeEqual } from "node:crypto";
import { handleUpdate } from "../lib/bot.js";

/**
 * Telegram webhook (Vercel function, POST /api/webhook).
 *
 * Environment:
 *   TELEGRAM_BOT_TOKEN       the token from @BotFather (required)
 *   TELEGRAM_WEBHOOK_SECRET  the secret given to setWebhook: requests without it are refused (required)
 *   SITE_URL, BOT_USERNAME   optional overrides of lib/bot.js DEFAULTS
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
    for (const c of handleUpdate(update, config)) await call(token, c);
  } catch (e) {
    console.error("update failed:", e?.name ?? "error");
  }
  // Always 200: a failed reply must not make Telegram resend the same update for hours.
  return res.status(200).json({ ok: true });
}
