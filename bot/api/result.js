import { trackResult } from "../lib/stats.js";
import { readSummary, summaryMessage, verifyInitData } from "../lib/result.js";

/**
 * POST /api/result, called by the site when a check opened from the bot has finished:
 * { initData, items: [{ what, where, usd?, later? }], failed }.
 * The bot then writes the summary in that user's chat. Only Telegram's signed launch data decides
 * who receives it, so nobody can make the bot write to someone else.
 */

const ORIGINS = (process.env.SITE_ORIGINS ?? "https://www.fundscheckers.com,https://fundscheckers.com").split(",");

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (origin && ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "POST");
    res.setHeader("Access-Control-Allow-Headers", "content-type");
    res.setHeader("Access-Control-Max-Age", "86400");
  }
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false });

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return res.status(500).json({ ok: false });

  let body;
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  } catch {
    return res.status(400).json({ ok: false });
  }
  const userId = verifyInitData(body?.initData, token);
  if (userId === null) return res.status(401).json({ ok: false });
  const summary = readSummary(body);
  if (!summary) return res.status(400).json({ ok: false });

  const { method, params } = summaryMessage(userId, summary);
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(8000),
  }).catch(() => null);
  if (r?.ok) await trackResult(userId, summary);
  // Nothing about the request is logged: not the user, not what was found.
  return res.status(r?.ok ? 200 : 502).json({ ok: !!r?.ok });
}
