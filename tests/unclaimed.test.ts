import assert from "node:assert/strict";
import { test } from "node:test";
import { UNCLAIMED, UNCLAIMED_LABELS } from "../src/lib/unclaimed.ts";

test("the unclaimed totals shown on the home page add up, and every source has its label", () => {
  assert.ok(UNCLAIMED.sources.length >= 10);
  assert.equal(
    UNCLAIMED.totalUsd,
    UNCLAIMED.sources.reduce((s, x) => s + x.usd, 0),
  );
  for (const s of UNCLAIMED.sources) {
    const label = UNCLAIMED_LABELS[s.id];
    assert.ok(label, `${s.id} has a label (src/lib/unclaimed.ts)`);
    assert.ok(s.usd > 0 && s.parts.length > 0, s.id);
    assert.equal(
      s.usd,
      s.parts.reduce((sum, p) => sum + p.usd, 0),
      s.id,
    );
    // A label that quotes a count needs the source to have one.
    if (label.en.includes("{n}") || label.fr.includes("{n}")) assert.ok(s.count, `${s.id} has a count`);
  }
  const sorted = [...UNCLAIMED.sources].sort((a, b) => b.usd - a.usd);
  assert.deepEqual(
    UNCLAIMED.sources.map((s) => s.id),
    sorted.map((s) => s.id),
    "largest first",
  );
  assert.ok(UNCLAIMED.measuredAt > 1_790_000_000 && UNCLAIMED.measuredAt < Date.now() / 1000 + 86_400);
});
