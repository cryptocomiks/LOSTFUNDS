import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { sourceMeta } from "../scripts/gen-source-meta.ts";

test("the page's list of checks matches the checks (run `npx tsx scripts/gen-source-meta.ts` after adding one)", () => {
  const committed = JSON.parse(readFileSync(new URL("../src/lib/source-meta.json", import.meta.url), "utf8"));
  assert.deepEqual(committed, sourceMeta());
});
