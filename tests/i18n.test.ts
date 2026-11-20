import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { makeFinding } from "../src/lib/checks/common.ts";
import { formatAmount } from "../src/lib/format.ts";
import { bridgeFr, SOURCE_FR, sourceName } from "../src/lib/sourceFr.ts";
import { SOURCES } from "../src/lib/sources.ts";

test("amounts are written the French way in French texts", () => {
  assert.equal(formatAmount(1234567890000000000000n, 18), "1,235");
  assert.equal(formatAmount(1234567890000000000000n, 18, "fr").replace(/\s/g, " "), "1 235");
  assert.equal(formatAmount(1500000000000000000n, 18, "fr"), "1,5");
  assert.equal(formatAmount(1n, 18, "fr"), "<0,0001");
});

test("a finding carries its French texts next to the English ones", () => {
  const f = makeFinding(
    { id: "x", name: "X", guideId: "rewards", explorer: "https://etherscan.io" },
    { key: "k", status: "ready", asset: { symbol: "ETH", decimals: 18, amount: 1n }, txHash: "0x1", timestamp: 0, label: "Title", note: "Note", fr: { label: "Titre", note: "Note en français" } },
  );
  assert.deepEqual([f.networkName, f.note, f.fr], ["Title", "Note", { label: "Titre", note: "Note en français" }]);
  assert.equal("fr" in makeFinding({ id: "x", name: "X", guideId: "rewards" }, { key: "k", status: "ready", asset: { symbol: "ETH", decimals: 18, amount: 1n }, txHash: "0x1", timestamp: 0 }), false);
});

test("French names and claim texts of the checks refer to checks that exist", () => {
  for (const id of Object.keys(SOURCE_FR)) assert.ok(SOURCES.some((s) => s.id === id), `${id} is a check`);
  assert.equal(sourceName({ id: "expired-locks", name: "Expired locks" }, "fr"), "Verrous expirés");
  assert.equal(sourceName({ id: "expired-locks", name: "Expired locks" }, "en"), "Expired locks");
  assert.equal(sourceName({ id: "base", name: "Base" }, "fr"), "Base");
  assert.equal(bridgeFr("the official RISE bridge"), "le bridge officiel de RISE");
  assert.equal(bridgeFr("superbridge.app/base"), "superbridge.app/base");
  // A check whose name is plain English words needs a French name.
  const words = /\b(withdrawals|rewards|fees|locks|staking|accounts|stake|tickets|buffers|deposits|market|vaults|claims|streams|shut down|Forgotten|Old)\b/;
  for (const s of SOURCES) if (words.test(s.name)) assert.ok(SOURCE_FR[s.id]?.name, `${s.id} ("${s.name}") has a French name`);
});

test("every check that writes texts for its findings writes them in French too", () => {
  const dir = new URL("../src/lib/checks/", import.meta.url);
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
    if (file === "common.ts") continue;
    const src = readFileSync(new URL(file, dir), "utf8");
    if (!src.includes("makeFinding(")) continue;
    // Texts a visitor reads: a note, a title or a "where to claim" given to makeFinding.
    const texts = (src.match(/^\s+(note|label|claimAt):/gm) ?? []).length;
    if (!texts) continue;
    assert.match(src, /\bfr[:,]|\bfr\b\s*=|Fr\b/, `${file} has ${texts} English texts and no French ones`);
  }
});
