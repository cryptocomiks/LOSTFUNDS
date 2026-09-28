/** Runs every network check against the real chains. Usage: npx tsx tests/live.ts 0xADDRESS */
import { checkNetwork } from "../src/lib/checker.ts";
import { NETWORKS } from "../src/lib/networks.ts";

const user = process.argv[2] as `0x${string}`;
const t0 = Date.now();
await Promise.all(
  NETWORKS.map(async (n) => {
    const s = Date.now();
    const r = await checkNetwork(n, user);
    console.log(
      `${n.name.padEnd(14)} ${r.state.padEnd(6)} ${((Date.now() - s) / 1000).toFixed(1)}s  completed=${r.completed} found=${r.findings.length}` +
        (r.error ? `  ERROR: ${r.error}` : "") +
        r.findings.map((f) => `\n    - ${f.status} ${f.asset.amount} ${f.asset.symbol} ${f.txUrl}`).join(""),
    );
  }),
);
console.log(`total ${((Date.now() - t0) / 1000).toFixed(1)}s`);
