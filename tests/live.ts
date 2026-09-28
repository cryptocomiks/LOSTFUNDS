/**
 * Runs the checks against the real chains.
 *   npx tsx tests/live.ts <Ethereum or Solana address> [checkId…]
 * Behind a proxy, set NODE_USE_ENV_PROXY=1.
 */
import { checkSource } from "../src/lib/checker.ts";
import { sourcesFor } from "../src/lib/checker.ts";

const [user, ...only] = process.argv.slice(2);
const t0 = Date.now();
await Promise.all(
  sourcesFor(user.startsWith("0x") ? "evm" : "solana").filter((s) => !only.length || only.includes(s.id)).map(async (s) => {
    const t = Date.now();
    const r = await checkSource(s, user);
    console.log(
      `${s.name.padEnd(14)} ${r.state.padEnd(6)} ${((Date.now() - t) / 1000).toFixed(1)}s  completed=${r.completed} found=${r.findings.length}` +
        (r.error ? `  ERROR: ${r.error}` : "") +
        r.findings
          .map((f) => `\n    - ${f.status} ${Number(f.asset.amount) / 10 ** f.asset.decimals} ${f.asset.symbol} (${f.networkName}) ${f.txUrl}`)
          .join(""),
    );
  }),
);
console.log(`total ${((Date.now() - t0) / 1000).toFixed(1)}s`);
