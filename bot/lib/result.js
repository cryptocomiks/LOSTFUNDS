/**
 * The summary the bot writes in the chat once a check started from Telegram has finished.
 *
 * The check runs in the Mini App (the site, on the user's device). When it ends, the site posts the
 * totals here with Telegram's signed launch data, which proves which Telegram user opened it. The
 * address itself is never sent. Nothing is stored.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Checks the Mini App's launch data against the bot token (Telegram's documented HMAC scheme).
 * @returns {number | null} The Telegram user's id, or null if the data isn't genuine or is too old.
 */
export function verifyInitData(initData, token, now = Date.now() / 1000, maxAge = 86400) {
  if (typeof initData !== "string" || initData.length > 4096) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) return null;
  params.delete("hash");
  const check = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  const expected = createHmac("sha256", secret).update(check).digest();
  if (!timingSafeEqual(expected, Buffer.from(hash, "hex"))) return null;
  const authDate = Number(params.get("auth_date"));
  if (!Number.isFinite(authDate) || now - authDate > maxAge) return null;
  try {
    const id = JSON.parse(params.get("user") ?? "null")?.id;
    return Number.isSafeInteger(id) ? id : null;
  } catch {
    return null;
  }
}

const usd = (n) => (n >= 1000 ? `$${Math.round(n).toLocaleString("en-US")}` : `$${n.toFixed(2)}`);
const text = (v, max) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
const amount = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);

const MAX_ITEMS = 8;

/**
 * What the site sent, reduced to what the message needs. Everything is treated as untrusted text.
 * @returns {{ items: { what: string, where: string, usd?: number, later: boolean }[], count: number, total: number, failed: number } | null}
 */
export function readSummary(body) {
  if (!body || typeof body !== "object" || !Array.isArray(body.items)) return null;
  const items = body.items.slice(0, 50).flatMap((i) => {
    const what = text(i?.what, 40);
    const where = text(i?.where, 60);
    return what && where ? [{ what, where, usd: amount(i.usd), later: i.later === true }] : [];
  });
  return {
    items,
    count: items.length,
    total: items.reduce((s, i) => s + (i.usd ?? 0), 0),
    failed: Math.min(amount(body.failed) ?? 0, 999),
  };
}

/** The message for the chat: what was found, then what to do. */
export function summaryMessage(chatId, s) {
  const lines = [];
  let keyboard;
  if (s.count === 0) {
    lines.push("✅ <b>Check finished: nothing is waiting for this address.</b>", "", "Good news in a way: you left nothing behind in the 100+ sources checked.", "", "👇 Have another wallet? Paste its address.");
  } else {
    const places = `${s.count} place${s.count > 1 ? "s" : ""}`;
    lines.push(s.total >= 1 ? `🎉 <b>Found ≈ ${usd(s.total)} in ${places}!</b>` : `🎉 <b>Found something in ${places}!</b>`, "");
    for (const i of s.items.slice(0, MAX_ITEMS))
      lines.push(`${i.later ? "⏳" : "💰"} <b>${esc(i.what)}</b>${i.usd !== undefined && i.usd >= 0.01 ? ` (≈ ${usd(i.usd)})` : ""} · ${esc(i.where)}`);
    if (s.count > MAX_ITEMS) lines.push(`… and ${s.count - MAX_ITEMS} more in the app.`);
    if (s.items.some((i) => i.later)) lines.push("", "⏳ = not claimable yet, the app shows when.");
    lines.push("", "👉 <b>Next step:</b> tap <b>How to claim</b> for the steps to follow. Each result in the app has its own link to the official site.");
    keyboard = [[{ text: "✅ How to claim", callback_data: "claim" }]];
  }
  if (s.failed > 0)
    lines.push("", `⚠️ ${s.failed} check${s.failed > 1 ? "s" : ""} couldn't be completed (busy data sources). Open the app again and press Retry on them.`);
  return {
    method: "sendMessage",
    params: {
      chat_id: chatId,
      text: lines.join("\n"),
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
    },
  };
}
