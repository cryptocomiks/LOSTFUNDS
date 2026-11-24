import assert from "node:assert/strict";
import { describe, test } from "node:test";
import handler from "../api/webhook.js";
import { DEMO_ADDRESS, handleUpdate, parseTarget, profileCalls } from "../lib/bot.js";

const EVM = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const SOL = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const SITE = "https://www.fundscheckers.com";

const msg = (text, type = "private") => ({ message: { chat: { id: 7, type }, text } });
const buttons = (call) => call.params.reply_markup?.inline_keyboard.flat() ?? [];

describe("parseTarget", () => {
  test("addresses, alone or inside a sentence", () => {
    assert.deepEqual(parseTarget(EVM), { kind: "evm", value: EVM });
    assert.deepEqual(parseTarget(`check ${EVM}, please`), { kind: "evm", value: EVM });
    assert.deepEqual(parseTarget(SOL), { kind: "solana", value: SOL });
  });
  test("names only when they are the whole message", () => {
    assert.deepEqual(parseTarget("Vitalik.eth"), { kind: "name", value: "vitalik.eth" });
    assert.equal(parseTarget("see you at the cafe.tomorrow maybe"), null);
  });
  test("transaction hashes and everything else", () => {
    assert.deepEqual(parseTarget(`0x${"ab".repeat(32)}`), { kind: "tx" });
    assert.equal(parseTarget("hello"), null);
    assert.equal(parseTarget("0x1234"), null);
    // 32+ base58 characters that don't decode to 32 bytes
    assert.equal(parseTarget("z".repeat(44)), null);
    assert.equal(parseTarget(""), null);
  });
});

describe("messages", () => {
  test("/start welcomes with a Mini App button", () => {
    const [c] = handleUpdate(msg("/start"));
    assert.equal(c.method, "sendPhoto");
    assert.equal(c.params.photo, `${SITE}/og.png`);
    assert.ok(c.params.caption.length <= 1024);
    assert.equal(c.params.chat_id, 7);
    assert.equal(buttons(c)[0].callback_data, "demo");
    assert.deepEqual(buttons(c)[1].web_app, { url: `${SITE}/` });
    const [, demo] = handleUpdate({ callback_query: { id: "d1", data: "demo", message: { chat: { id: 7, type: "private" } } } });
    assert.equal(buttons(demo)[0].web_app.url, `${SITE}/?address=${DEMO_ADDRESS}`);
  });
  test("how to claim: by command, and by the button under a reply", () => {
    const [byCommand] = handleUpdate(msg("/claim"));
    assert.match(byCommand.params.text, /official site/);
    const [reply] = handleUpdate(msg(EVM));
    assert.ok(buttons(reply).some((b) => b.callback_data === "claim"));
    const [ack, steps] = handleUpdate({ callback_query: { id: "c1", data: "claim", message: { chat: { id: 7, type: "private" } } } });
    assert.deepEqual(ack, { method: "answerCallbackQuery", params: { callback_query_id: "c1" } });
    assert.equal(steps.params.text, byCommand.params.text);
    assert.equal(handleUpdate({ callback_query: { id: "c2", data: "other" } }).length, 1);
    for (const c of [byCommand, reply]) assert.ok(c.params.text.length <= 4096);
  });
  test("an address opens the check for it", () => {
    for (const text of [EVM, `/check ${EVM}`, `/start ${EVM}`, `/check@Fundscheckersbot ${EVM}`]) {
      const [c] = handleUpdate(msg(text));
      assert.equal(buttons(c)[0].web_app.url, `${SITE}/?address=${EVM}`, text);
    }
    const [c] = handleUpdate(msg("vitalik.eth"));
    assert.equal(buttons(c)[0].web_app.url, `${SITE}/?address=vitalik.eth`);
  });
  test("anything else gets an explanation, no button", () => {
    for (const text of ["hello", `0x${"ab".repeat(32)}`, "/check"]) {
      const [c] = handleUpdate(msg(text));
      assert.equal(c.method, "sendMessage");
      assert.equal(buttons(c).length, 0, text);
    }
  });
  test("groups: commands only, plain links instead of Mini App buttons", () => {
    assert.deepEqual(handleUpdate(msg(EVM, "supergroup")), []);
    assert.deepEqual(handleUpdate(msg(`/check@OtherBot ${EVM}`, "group")), []);
    const [c] = handleUpdate(msg(`/check ${EVM}`, "group"));
    assert.equal(buttons(c)[0].url, `${SITE}/?address=${EVM}`);
    assert.equal(buttons(c)[0].web_app, undefined);
  });
  test("user text is never echoed as HTML", () => {
    const [c] = handleUpdate(msg("<b>x</b>.eth"));
    assert.ok(!c.params.text.includes("<b>x</b>"));
  });
  test("updates the bot doesn't handle are ignored", () => {
    assert.deepEqual(handleUpdate({ edited_message: {} }), []);
    assert.deepEqual(handleUpdate({ message: { chat: { id: 1, type: "private" }, photo: [] } }), []);
    assert.deepEqual(handleUpdate(null), []);
  });
  test("site and bot name can be overridden", () => {
    const [c] = handleUpdate(msg(EVM), { siteUrl: "https://example.org/" });
    assert.equal(buttons(c)[0].web_app.url, `https://example.org/?address=${EVM}`);
  });
});

describe("inline mode", () => {
  test("an address gives a check link, then the generic share", () => {
    const [c] = handleUpdate({ inline_query: { id: "q1", query: EVM } });
    assert.equal(c.method, "answerInlineQuery");
    assert.equal(c.params.inline_query_id, "q1");
    assert.deepEqual(c.params.results.map((r) => r.id), ["check", "site"]);
    assert.equal(c.params.results[0].reply_markup.inline_keyboard[0][0].url, `${SITE}/?address=${EVM}`);
  });
  test("an empty query only offers the share", () => {
    const [c] = handleUpdate({ inline_query: { id: "q2", query: "" } });
    assert.deepEqual(c.params.results.map((r) => r.id), ["site"]);
  });
});

test("profile: commands within Telegram's limits, menu button opens the site", () => {
  const calls = profileCalls();
  const commands = calls.find((c) => c.method === "setMyCommands").params.commands;
  for (const c of commands) assert.match(c.command, /^[a-z0-9_]{1,32}$/);
  assert.ok(calls.find((c) => c.method === "setMyDescription").params.description.length <= 512);
  assert.ok(calls.find((c) => c.method === "setMyShortDescription").params.short_description.length <= 120);
  assert.equal(calls.find((c) => c.method === "setChatMenuButton").params.menu_button.web_app.url, `${SITE}/`);
});

describe("webhook", () => {
  function response() {
    const res = { code: 0, status: (c) => ((res.code = c), res), json: () => res };
    return res;
  }
  const post = (headers, body) => ({ method: "POST", headers, body });

  test("refuses requests without the secret, answers the others", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "123:test";
    process.env.TELEGRAM_WEBHOOK_SECRET = "s".repeat(32);
    const sent = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      sent.push({ url: String(url), body: JSON.parse(init.body) });
      return Response.json({ ok: true });
    };
    try {
      assert.equal((await handler(post({}, msg(EVM)), response())).code, 401);
      assert.equal((await handler(post({ "x-telegram-bot-api-secret-token": "wrong" }, msg(EVM)), response())).code, 401);
      assert.equal(sent.length, 0);
      assert.equal((await handler({ method: "GET", headers: {} }, response())).code, 405);

      const ok = { "x-telegram-bot-api-secret-token": "s".repeat(32) };
      assert.equal((await handler(post(ok, msg(EVM)), response())).code, 200);
      assert.equal(sent.length, 1);
      assert.equal(sent[0].url, "https://api.telegram.org/bot123:test/sendMessage");
      assert.equal(sent[0].body.chat_id, 7);
      // A broken update still gets 200, so Telegram doesn't resend it.
      assert.equal((await handler(post(ok, "not json"), response())).code, 200);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
