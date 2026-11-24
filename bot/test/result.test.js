import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, test } from "node:test";
import handler from "../api/result.js";
import { readSummary, summaryMessage, verifyInitData } from "../lib/result.js";

const TOKEN = "123:test";

/** Launch data signed the way Telegram signs it. */
function initData(token, fields) {
  const p = new URLSearchParams(fields);
  const check = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  p.set("hash", createHmac("sha256", secret).update(check).digest("hex"));
  return p.toString();
}
const now = Math.floor(Date.now() / 1000);
const genuine = (over = {}) => initData(TOKEN, { auth_date: String(now), query_id: "q", user: JSON.stringify({ id: 42, first_name: "A" }), ...over });

describe("verifyInitData", () => {
  test("genuine data gives the user's id", () => {
    assert.equal(verifyInitData(genuine(), TOKEN), 42);
  });
  test("anything else is refused", () => {
    assert.equal(verifyInitData(genuine().replace("%22id%22%3A42", "%22id%22%3A43"), TOKEN), null, "tampered user");
    assert.equal(verifyInitData(initData("999:other", { auth_date: String(now), user: '{"id":42}' }), TOKEN), null, "signed by another bot");
    assert.equal(verifyInitData(genuine({ auth_date: String(now - 2 * 86400) }), TOKEN), null, "too old");
    assert.equal(verifyInitData(genuine({ user: "{}" }), TOKEN), null, "no user");
    for (const bad of ["", "hash=zz", undefined, 12, "x".repeat(5000)]) assert.equal(verifyInitData(bad, TOKEN), null);
  });
});

describe("summary", () => {
  test("findings: total, lines, and the How to claim button", () => {
    const s = readSummary({ items: [{ what: "0.016 ETH", where: "Maker SCD vaults", usd: 27.1, later: false }, { what: "5 ARB", where: "Arbitrum One", later: true }], failed: 0 });
    const { params } = summaryMessage(42, s);
    assert.equal(params.chat_id, 42);
    assert.match(params.text, /Found ≈ \$27\.10 in 2 places/);
    assert.match(params.text, /💰 <b>0\.016 ETH<\/b> \(≈ \$27\.10\) · Maker SCD vaults/);
    assert.match(params.text, /⏳ <b>5 ARB<\/b> · Arbitrum One/);
    assert.equal(params.reply_markup.inline_keyboard[0][0].callback_data, "claim");
  });
  test("nothing found, with failed checks", () => {
    const { params } = summaryMessage(42, readSummary({ items: [], failed: 3 }));
    assert.match(params.text, /nothing is waiting/);
    assert.match(params.text, /3 checks couldn't be completed/);
    assert.equal(params.reply_markup, undefined);
  });
  test("what the site sends is untrusted: escaped, capped, junk dropped", () => {
    const many = Array.from({ length: 80 }, (_, i) => ({ what: `<b>${i}</b> ${"x".repeat(200)}`, where: "<a href='x'>w</a>", usd: "1e9" }));
    const s = readSummary({ items: [...many, { what: "", where: "x" }, null, 5], failed: -4 });
    assert.equal(s.count, 50);
    assert.equal(s.total, 0);
    assert.equal(s.failed, 0);
    const { params } = summaryMessage(1, s);
    assert.ok(!params.text.includes("<a href"));
    assert.ok(!params.text.includes("<b>0</b>"));
    assert.match(params.text, /and 42 more in the app/);
    assert.ok(params.text.length <= 4096);
    assert.equal(readSummary({ items: "no" }), null);
    assert.equal(readSummary(null), null);
  });
});

describe("POST /api/result", () => {
  function response() {
    const res = { code: 0, headers: {}, status: (c) => ((res.code = c), res), json: () => res, end: () => res, setHeader: (k, v) => (res.headers[k] = v) };
    return res;
  }
  test("writes to the user who opened the Mini App, and to nobody on bad data", async () => {
    process.env.TELEGRAM_BOT_TOKEN = TOKEN;
    const sent = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      sent.push({ url: String(url), body: JSON.parse(init.body) });
      return Response.json({ ok: true });
    };
    try {
      const post = (body, origin) => handler({ method: "POST", headers: origin ? { origin } : {}, body }, response());
      // The site posts JSON as text/plain (no CORS preflight), so the body arrives as a string.
      const ok = await post(JSON.stringify({ initData: genuine(), items: [{ what: "1 ETH", where: "Base", usd: 1600 }], failed: 0 }), "https://www.fundscheckers.com");
      assert.equal(ok.code, 200);
      assert.equal(ok.headers["Access-Control-Allow-Origin"], "https://www.fundscheckers.com");
      assert.equal(sent.length, 1);
      assert.equal(sent[0].body.chat_id, 42);
      assert.match(sent[0].body.text, /\$1,600/);

      assert.equal((await post({ initData: "forged", items: [] })).code, 401);
      assert.equal((await post({ initData: genuine() })).code, 400);
      assert.equal((await post("not json")).code, 400);
      assert.equal((await post({ initData: genuine(), items: [] }, "https://evil.example")).headers["Access-Control-Allow-Origin"], undefined);
      assert.equal(sent.length, 2);
      assert.equal((await handler({ method: "GET", headers: {} }, response())).code, 405);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
