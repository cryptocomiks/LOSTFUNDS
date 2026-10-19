/**
 * Writes src/lib/source-meta.json: the list of checks without their code, so the page can show
 * names, groups and counts without loading the checks themselves (those load in the background).
 * Runs before every build; tests/source-meta.test.ts fails if the committed file is stale.
 */
import { writeFileSync } from "node:fs";
import { SOURCES } from "../src/lib/sources.ts";

export const sourceMeta = () => SOURCES.map(({ id, name, group, bridgeUrl, accepts }) => ({ id, name, group, bridgeUrl, accepts }));

if (process.argv[1]?.endsWith("gen-source-meta.ts")) {
  writeFileSync(new URL("../src/lib/source-meta.json", import.meta.url), JSON.stringify(sourceMeta(), null, 1) + "\n");
  console.log(`source-meta.json: ${SOURCES.length} checks`);
}
