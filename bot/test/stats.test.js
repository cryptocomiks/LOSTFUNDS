import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import handler from "../api/webhook.js";
import { handleUpdate } from "../lib/bot.js";
import { eventOf, statsText, trackCommands } from "../lib/stats.js";

const EVM = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const msg = (text, from = 7) => ({ message: { chat: { id: from, type: "private" }, from: { id: from }, text } });
const NOW = Date.UTC(2026, 10, 25, 12);

describe("what is counted", () => {
  test("one event: totals, the day's totals, and the user in the estimators only", () => {
    const c = trackCommands(42, "start", NOW);
    assert.deepEqual(c[0], ["INCR", "n:start"]);
    assert.deepEqual(c[1], ["INCR", "n:start:2026-11-25"]);
    assert.deepEqual(c.filter((x) => x[0] === "PFADD"), [["PFADD", "u:all", "42"], ["PFADD", "u:2026-11-25", "42"]]);
    // The id only ever goes into HyperLogLog (PFADD), which can't give it back.
    for (const x of c) if (x[0] !== "PFADD") assert.ok(!x.includes("42"));
  });
  test("events by update", () => {
    const ev = (u) => eventOf(u, handleUpdate(u));
    assert.equal(ev(msg("/start")), "start");
    assert.equal(ev(msg(EVM)), "address");
    assert.equal(ev(msg(`/start ${EVM}`)), "address");
    assert.equal(ev(msg("hello")), "message");
    assert.equal(ev({ callback_query: { id: "1", data: "claim", from: { id: 1 } } }), "claim");
    assert.equal(ev({ edited_message: {} }), null);
  });
});

describe("with a database", () => {
  let realFetch;
  let redis;
  let telegram;
  beforeEach(() => {
    process.env.TELEGRAM_BOT_TOKEN = "123:test";
    process.env.TELEGRAM_WEBHOOK_SECRET = "s".repeat(32);
    process.env.KV_REST_API_URL = "https://db.example";
    process.env.KV_REST_API_TOKEN = "t";
    process.env.ADMIN_ID = "99";
    redis = [];
    telegram = [];
    realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      if (String(url) === "https://db.example/pipeline") {
        redis.push(body);
        return Response.json(body.map(([cmd]) => ({ result: cmd === "PFCOUNT" ? 1234 : cmd === "GET" ? "5" : 1 })));
      }
      telegram.push(body);
      return Response.json({ ok: true });
    };
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    for (const k of ["KV_REST_API_URL", "KV_REST_API_TOKEN", "ADMIN_ID"]) delete process.env[k];
  });
  const post = (update) => {
    const res = { code: 0, status: (c) => ((res.code = c), res), json: () => res };
    return handler({ method: "POST", headers: { "x-telegram-bot-api-secret-token": "s".repeat(32) }, body: update }, res);
  };

  test("an update is answered, then counted", async () => {
    await post(msg(EVM));
    assert.equal(telegram.length, 1);
    assert.equal(redis.length, 1);
    assert.deepEqual(redis[0][0], ["INCR", "n:address"]);
    assert.ok(!JSON.stringify(redis).includes(EVM), "no address in the database");
  });
  test("/stats answers the owner only", async () => {
    await post(msg("/stats", 99));
    assert.match(telegram[0].text, /Total: <b>1,234<\/b>/);
    assert.match(telegram[0].text, /\/start: <b>5<\/b>/);
    assert.equal(telegram[0].chat_id, 99);

    await post(msg("/stats", 7));
    assert.ok(!telegram[1].text.includes("statistics"), "a stranger gets the ordinary help");
  });
  test("the message covers 7 and 30 days", async () => {
    await statsText(NOW);
    const [, , week, month] = redis[0];
    assert.equal(week.length, 8);
    assert.equal(month.length, 31);
    assert.equal(week[7], "u:2026-11-19");
  });
  test("a database that is down never stops the bot", async () => {
    globalThis.fetch = async (url, init) => {
      if (String(url).startsWith("https://db.example")) throw new Error("down");
      telegram.push(JSON.parse(init.body));
      return Response.json({ ok: true });
    };
    assert.equal((await post(msg(EVM))).code, 200);
    assert.equal(telegram.length, 1);
    assert.equal(await statsText(), null);
  });
});

test("/id gives the user their own id, in private only", () => {
  const [c] = handleUpdate(msg("/id", 55));
  assert.match(c.params.text, /<code>55<\/code>/);
  assert.deepEqual(handleUpdate({ message: { chat: { id: -1, type: "group" }, from: { id: 55 }, text: "/id" } }), []);
});
