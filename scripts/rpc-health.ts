/**
 * Asks every RPC node the checks use for its block number, and lists the dead ones and the
 * networks left without any. Run it from time to time: a network with no live node fails for
 * every visitor.
 *   NODE_USE_ENV_PROXY=1 npx tsx scripts/rpc-health.ts
 */
import { EVM_CHAINS } from "../src/lib/evm.ts";
import { L1, NETWORKS } from "../src/lib/networks.ts";

async function alive(url: string): Promise<string | true> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
        signal: AbortSignal.timeout(12_000),
      });
      const text = await res.text();
      try {
        const j = JSON.parse(text) as { result?: string; error?: { message?: string } };
        if (j.result && BigInt(j.result) > 0n) return true;
        return `HTTP ${res.status}: ${j.error?.message ?? text.slice(0, 80)}`;
      } catch {
        if (attempt) return `HTTP ${res.status}: ${text.slice(0, 80).replace(/\s+/g, " ")}`;
      }
    } catch (e) {
      if (attempt) return String((e as Error).cause ?? (e as Error).message).slice(0, 80);
    }
  }
  return "unreachable";
}

const groups: { name: string; role: string; urls: string[] }[] = [
  { name: "Ethereum", role: "rpcs", urls: L1.rpcs },
  { name: "Ethereum", role: "logsRpcs", urls: L1.logsRpcs ?? [] },
  ...NETWORKS.flatMap((n) => [
    { name: n.name, role: "rpcs", urls: n.rpcs },
    { name: n.name, role: "logsRpcs", urls: n.logsRpcs ?? [] },
  ]),
  ...EVM_CHAINS.map((c) => ({ name: `${c.name} (evm.ts)`, role: "rpcs", urls: c.rpcs })),
];
const urls = [...new Set(groups.flatMap((g) => g.urls))];
const status = new Map<string, string | true>();
for (let i = 0; i < urls.length; i += 12) await Promise.all(urls.slice(i, i + 12).map(async (u) => status.set(u, await alive(u))));

let dead = 0;
for (const g of groups) {
  if (!g.urls.length) continue;
  const bad = g.urls.filter((u) => status.get(u) !== true);
  dead += bad.length;
  if (bad.length === g.urls.length) console.log(`✗ ${g.name} ${g.role}: NO LIVE NODE`);
  for (const u of bad) console.log(`  ${g.name} ${g.role}: ${u} → ${status.get(u)}`);
}
console.log(`\n${urls.length} nodes, ${[...status.values()].filter((s) => s !== true).length} dead`);
