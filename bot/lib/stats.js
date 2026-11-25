/**
 * Usage counts for the bot's owner (/stats), kept in a Redis database reached over HTTPS
 * (Upstash, added from Vercel's Storage tab: it sets KV_REST_API_URL and KV_REST_API_TOKEN).
 *
 * Users are counted with HyperLogLog, which keeps an estimate of how many distinct users there
 * were, not the list of who they are: no user id, address or message is stored. Without the
 * database nothing is counted and the bot works the same.
 */

const DAY_TTL = 100 * 86400;

function db() {
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url: url.replace(/\/+$/, ""), token } : null;
}

export const statsEnabled = () => db() !== null;

/** Runs Redis commands in one request. Returns their results, or null if there is no database or it failed. */
async function pipeline(commands) {
  const d = db();
  if (!d || !commands.length) return null;
  try {
    const r = await fetch(`${d.url}/pipeline`, {
      method: "POST",
      headers: { authorization: `Bearer ${d.token}`, "content-type": "application/json" },
      body: JSON.stringify(commands),
      signal: AbortSignal.timeout(4000),
    });
    if (!r.ok) return null;
    return (await r.json()).map((x) => x.result);
  } catch {
    return null;
  }
}

const day = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
const lastDays = (n, now = Date.now()) => Array.from({ length: n }, (_, i) => `u:${day(now - i * 86400_000)}`);

/** The Redis commands that count one event by one user (pure, for tests). */
export function trackCommands(userId, event, now = Date.now()) {
  const d = day(now);
  const commands = [["INCR", `n:${event}`], ["INCR", `n:${event}:${d}`], ["EXPIRE", `n:${event}:${d}`, DAY_TTL]];
  if (userId !== undefined) commands.push(["PFADD", "u:all", String(userId)], ["PFADD", `u:${d}`, String(userId)], ["EXPIRE", `u:${d}`, DAY_TTL]);
  return commands;
}

/** What an update counts as, or null when it isn't counted. */
export function eventOf(update, replies) {
  const text = update?.message?.text;
  if (typeof text === "string") {
    if (/^\/start(@\w+)?(\s|$)/i.test(text) && !text.trim().includes(" ")) return "start";
    // A reply with a button to a check: an address was sent.
    if (replies.some((c) => JSON.stringify(c.params.reply_markup ?? "").includes("?address="))) return "address";
    return "message";
  }
  if (update?.callback_query) return update.callback_query.data === "claim" ? "claim" : update.callback_query.data === "demo" ? "demo" : null;
  if (update?.inline_query) return "inline";
  return null;
}

export const userOf = (update) => (update?.message ?? update?.callback_query ?? update?.inline_query)?.from?.id;

/** Counts one update. Never throws, never slows the reply by more than the database's timeout. */
export async function track(userId, event) {
  if (event) await pipeline(trackCommands(userId, event));
}

/** Counts a finished check reported by the site: one check, and what it found. */
export async function trackResult(userId, summary) {
  const d = day();
  const commands = trackCommands(userId, "check");
  if (summary.count > 0) commands.push(["INCR", "n:found"], ["INCR", `n:found:${d}`], ["EXPIRE", `n:found:${d}`, DAY_TTL]);
  if (summary.total > 0) commands.push(["INCRBYFLOAT", "usd:found", String(Math.round(summary.total * 100) / 100)]);
  await pipeline(commands);
}

const EVENTS = ["start", "address", "check", "found", "claim", "demo"];

/** The /stats message, or null when the database can't be read. */
export async function statsText(now = Date.now()) {
  const d = day(now);
  const r = await pipeline([
    ["PFCOUNT", "u:all"],
    ["PFCOUNT", `u:${d}`],
    ["PFCOUNT", ...lastDays(7, now)],
    ["PFCOUNT", ...lastDays(30, now)],
    ["GET", "usd:found"],
    ...EVENTS.map((e) => ["GET", `n:${e}`]),
    ...EVENTS.map((e) => ["GET", `n:${e}:${d}`]),
  ]);
  if (!r) return null;
  const n = (v) => Number(v ?? 0).toLocaleString("en-US");
  const [all, today, week, month, usd] = r;
  const total = Object.fromEntries(EVENTS.map((e, i) => [e, r[5 + i]]));
  const daily = Object.fromEntries(EVENTS.map((e, i) => [e, r[5 + EVENTS.length + i]]));
  const row = (label, e) => `${label}: <b>${n(total[e])}</b> (today ${n(daily[e])})`;
  return [
    `📊 <b>Bot statistics</b>`,
    ``,
    `👥 <b>Users</b>`,
    `Total: <b>${n(all)}</b>`,
    `Today: <b>${n(today)}</b> · 7 days: <b>${n(week)}</b> · 30 days: <b>${n(month)}</b>`,
    ``,
    `📈 <b>Activity</b>`,
    row("▶️ /start", "start"),
    row("📨 Addresses sent", "address"),
    row("🔍 Checks finished", "check"),
    row("🎉 Checks that found something", "found"),
    row("✅ How to claim", "claim"),
    row("✨ Example tried", "demo"),
    ``,
    `💰 Total found for users: <b>$${Math.round(Number(usd ?? 0)).toLocaleString("en-US")}</b>`,
    ``,
    `<i>User numbers are estimates (±1%), counted without storing who the users are. Days are UTC.</i>`,
  ].join("\n");
}
