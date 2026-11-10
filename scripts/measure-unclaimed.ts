/**
 * Measures, on-chain, how much is waiting to be claimed in the places the site checks, and writes
 * src/lib/unclaimed-totals.json (shown on the home page, with the date).
 *   NODE_USE_ENV_PROXY=1 npx tsx scripts/measure-unclaimed.ts
 *
 * Only sources whose total can be read exactly are measured: a contract that holds nothing but
 * what it owes its users (a claim distributor, a surplus pool, an old exchange's deposits…), or a
 * list the site already ships. Most checks have no such total (bridge withdrawals, rewards,
 * airdrops with a deadline, empty token accounts), so the sum is a floor, not an estimate.
 * A source that fails to read is left out and reported; the file is only written when at least
 * MIN_SOURCES were measured.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { base58 } from "@scure/base";
import { erc20Abi, formatUnits, multicall3Abi, parseAbi, zeroAddress, type Address, type Hex, type PublicClient } from "viem";
import { l1BulkClient, l1Client, l2Client } from "../src/lib/clients.ts";
import { DEPOSIT_EXCHANGES } from "../src/lib/checks/exchanges.ts";
import { LIQUITY_V2_BRANCHES } from "../src/lib/checks/liquity-v2.ts";
import { LEGACY_BRIDGE_TOKENS, type StoredMessage } from "../src/lib/checks/starknet.ts";
import { STARGATE_CHAINS } from "../src/lib/checks/stargate.ts";
import { ZKSYNC_LITE_CLAIM } from "../src/lib/checks/zksync-lite.ts";
import { evmClient } from "../src/lib/evm.ts";
import { NETWORKS } from "../src/lib/networks.ts";
import { rpc, SOLANA_INDEX_RPCS } from "../src/lib/solana.ts";

const MIN_SOURCES = 10;
const MULTICALL3: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";

/** An amount of one asset, with its DefiLlama price key. */
interface Part {
  symbol: string;
  amount: number;
  priceKey: string;
}
const ETH = "coingecko:ethereum";
const eth = (wei: bigint, symbol = "ETH"): Part => ({ symbol, amount: Number(formatUnits(wei, 18)), priceKey: ETH });
const token = (symbol: string, raw: bigint, decimals: number, address: string, chain = "ethereum"): Part => ({
  symbol,
  amount: Number(formatUnits(raw, decimals)),
  priceKey: `${chain}:${address.toLowerCase()}`,
});

const l1 = l1Client();
const ethOf = (address: Address, c: PublicClient = l1) => c.getBalance({ address });
const balanceOf = (tokenAddress: Address, holder: Address, c: PublicClient = l1) => c.readContract({ address: tokenAddress, abi: erc20Abi, functionName: "balanceOf", args: [holder] });
const net = (id: string) => l2Client(NETWORKS.find((n) => n.id === id)!);

const WETH: Address = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const TOKENS = {
  WETH: [WETH, 18],
  wstETH: ["0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0", 18],
  rETH: ["0xae78736Cd615f374D3085123A210448E74Fc6393", 18],
  USDC: ["0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", 6],
  USDT: ["0xdAC17F958D2ee523a2206206994597C13D831ec7", 6],
  DAI: ["0x6B175474E89094C44Da98b954EedeAC495271d0F", 18],
  WBTC: ["0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", 8],
} as const satisfies Record<string, readonly [Address, number]>;
const held = async (symbols: (keyof typeof TOKENS)[], holder: Address) =>
  Promise.all(symbols.map(async (s) => token(s, await balanceOf(TOKENS[s][0], holder), TOKENS[s][1], TOKENS[s][0])));

/** Expired, non-permanent veNFT locks: every token id, read in large multicalls. */
async function expiredLocks(chainId: number, escrow: Address): Promise<{ amount: bigint; count: number }> {
  const c = evmClient(chainId)!;
  const abi = parseAbi(["function tokenId() view returns (uint256)", "function locked(uint256) view returns ((int128 amount, uint256 end, bool isPermanent))"]);
  const last = Number(await c.readContract({ address: escrow, abi, functionName: "tokenId" }));
  const now = BigInt(Math.floor(Date.now() / 1000));
  let amount = 0n;
  let count = 0;
  const STEP = 1500;
  for (let from = 1; from <= last; from += STEP) {
    const ids = Array.from({ length: Math.min(STEP, last - from + 1) }, (_, i) => BigInt(from + i));
    const r = await c.multicall({ contracts: ids.map((id) => ({ address: escrow, abi, functionName: "locked", args: [id] }) as const), batchSize: 1_000_000 });
    for (const x of r)
      if (x.status === "success" && !x.result.isPermanent && x.result.amount > 0n && x.result.end < now) {
        amount += x.result.amount;
        count++;
      }
    process.stdout.write(`\r  veNFTs ${chainId}: ${Math.min(from + STEP - 1, last)}/${last}`);
  }
  process.stdout.write("\n");
  return { amount, count };
}

const SOURCES: Record<string, () => Promise<{ parts: Part[]; count?: number }>> = {
  // Everything the claim contract holds is an unclaimed zkSync Lite balance.
  "zksync-lite": async () => ({ parts: [eth(await ethOf(ZKSYNC_LITE_CLAIM)), ...(await held(["USDC", "USDT", "DAI", "WBTC"], ZKSYNC_LITE_CLAIM))] }),
  // The DAO's withdrawal contracts only pay DAO token holders.
  "the-dao": async () => ({
    parts: [eth((await ethOf("0xBf4eD7b27F1d666546E30D74d50d173d20bca754")) + (await ethOf("0x755cdba6AE4F479f7164792B318b2a06c759833B")))],
  }),
  // The UNI left in Uniswap's 2020 MerkleDistributor.
  uniswap: async () => ({
    parts: [token("UNI", await balanceOf("0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984", "0x090D4613473dEE047c3f2706764f49E0821D256e"), 18, "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984")],
  }),
  // ETH deposits still in the old exchanges' contracts (their tokens aren't counted).
  "old-exchanges": async () => {
    const addresses = DEPOSIT_EXCHANGES.flatMap((e) => e.contracts.map((c) => c.address));
    const balances = await Promise.all(addresses.map((a) => ethOf(a)));
    return { parts: [eth(balances.reduce((s, b) => s + b, 0n))] };
  },
  // ETH of the ENS auction deeds in the site's snapshot (deeds that changed hands: a part of all deeds).
  "ens-deeds": async () => {
    const hashes: Hex[] = [];
    for (const p of "0123456789abcdef") for (const list of Object.values(JSON.parse(readFileSync(new URL(`../public/legacy/ens-deeds/${p}.json`, import.meta.url), "utf8")) as Record<string, Hex[]>)) hashes.push(...list);
    const unique = [...new Set(hashes)];
    const registrar: Address = "0x6090A6e47849629b7245Dfa1Ca21D94cd15878Ef";
    const abi = parseAbi(["function entries(bytes32) view returns (uint8, address, uint256, uint256, uint256)"]);
    const bulk = l1BulkClient();
    const seen = new Set<string>();
    let total = 0n;
    let count = 0;
    for (let i = 0; i < unique.length; i += 1000) {
      const entries = await bulk.multicall({ contracts: unique.slice(i, i + 1000).map((h) => ({ address: registrar, abi, functionName: "entries", args: [h] }) as const), allowFailure: false, batchSize: 1_000_000 });
      // A released deed leaves the zero address in its entry: skipped (and each deed counted once).
      const deeds = [...new Set(entries.map((e) => e[1].toLowerCase() as Address))].filter((d) => d !== zeroAddress && !seen.has(d));
      deeds.forEach((d) => seen.add(d));
      if (!deeds.length) continue;
      const balances = await bulk.multicall({
        contracts: deeds.map((d) => ({ address: MULTICALL3, abi: multicall3Abi, functionName: "getEthBalance", args: [d] }) as const),
        allowFailure: false,
        batchSize: 1_000_000,
      });
      for (const b of balances) {
        total += b;
        if (b > 0n) count++;
      }
    }
    return { parts: [eth(total)], count };
  },
  // Liquity v1's CollSurplusPool holds only collateral owed to closed troves' owners; same for v2's six pools.
  liquity: async () => {
    const v1 = await ethOf("0x3D32e8b97Ed5881324241Cf03b2DA5E2EBcE5521");
    const v2 = await Promise.all(LIQUITY_V2_BRANCHES.map(async (b) => token(b.collateral, await balanceOf(TOKENS[b.collateral][0], b.collSurplusPool), 18, TOKENS[b.collateral][0])));
    return { parts: [eth(v1), ...v2] };
  },
  // APE still staked in ApeCoin's original staking contract, whose rewards have ended.
  apecoin: async () => {
    const abi = parseAbi(["function pools(uint256) view returns (uint48, uint16, uint96 stakedAmount, uint96)"]);
    const pools = await Promise.all([0n, 1n, 2n, 3n].map((i) => l1.readContract({ address: "0x5954aB967Bc958940b7EB73ee84797Dc8a2AFbb9", abi, functionName: "pools", args: [i] })));
    return { parts: [token("APE", pools.reduce((s, p) => s + p[2], 0n), 18, "0x4d224452801ACEd8B2F0aebE155379bb5D594381")] };
  },
  // STG left in the veSTG contracts, all unlocked since 2025.
  stargate: async () => {
    const parts: Part[] = [];
    for (const ch of STARGATE_CHAINS) {
      const c = evmClient(ch.chainId);
      if (!c) continue;
      try {
        parts.push(token("STG", await balanceOf(ch.stg, ch.ve, c), 18, "0xAf5191B0De278C7286d6C7CC6ab6BB8A73bA2Cd6"));
      } catch {
        console.log(`  stargate: ${ch.name} unreachable, left out`);
      }
    }
    if (!parts.length) throw new Error("no chain answered");
    return { parts };
  },
  // ETH credited in Zora's ProtocolRewards on each chain.
  "zora-rewards": async () => {
    const rewards: Address = "0x7777777F279eba3d3Ad8F4E708545291A6fDBA8B";
    const clients = [net("zora"), net("base"), net("optimism"), evmClient(42161)!, l1];
    return { parts: [eth((await Promise.all(clients.map((c) => ethOf(rewards, c)))).reduce((s, b) => s + b, 0n))] };
  },
  // Starknet → Ethereum withdrawals in the site's snapshot (each worth about $5 or more), by token.
  starknet: async () => {
    const sums = new Map<string, bigint>();
    let count = 0;
    for (const p of "0123456789abcdef")
      for (const messages of Object.values(JSON.parse(readFileSync(new URL(`../public/legacy/starknet/${p}.json`, import.meta.url), "utf8")) as Record<string, StoredMessage[]>))
        for (const [, to, payload] of messages) {
          const words = payload.map(BigInt);
          const key = words.length === 5 ? (words[2] === 0x455448n ? "eth" : `0x${words[2].toString(16).padStart(40, "0")}`) : LEGACY_BRIDGE_TOKENS[to] ? (LEGACY_BRIDGE_TOKENS[to].token ?? "eth") : undefined;
          if (!key) continue; // a bridge whose withdrawals the check can't confirm
          sums.set(key, (sums.get(key) ?? 0n) + words[words.length - 2] + (words[words.length - 1] << 128n));
          count++;
        }
    const parts: Part[] = [];
    for (const [key, raw] of sums) {
      if (key === "eth") parts.push(eth(raw));
      else {
        try {
          const [symbol, decimals] = await Promise.all([
            l1.readContract({ address: key as Address, abi: erc20Abi, functionName: "symbol" }),
            l1.readContract({ address: key as Address, abi: erc20Abi, functionName: "decimals" }),
          ]);
          parts.push(token(symbol, raw, decimals, key));
        } catch {
          /* not a standard token: left out */
        }
      }
    }
    return { parts, count };
  },
  // Expired veAERO / veVELO locks never withdrawn.
  aerodrome: async () => {
    const r = await expiredLocks(8453, "0xeBf418Fe2512e7E6bd9b87a8F0f294aCDC67e6B4");
    return { parts: [token("AERO", r.amount, 18, "0x940181a94A35A4569E4529A3CDfB74e38FD98631", "base")], count: r.count };
  },
  velodrome: async () => {
    const r = await expiredLocks(10, "0xFAf8FD17D9840595845582fCB047DF13f006787d");
    return { parts: [token("VELO", r.amount, 18, "0x9560e827aF36c94D2Ac33a39bCE1Fe78631088Db", "optimism")], count: r.count };
  },
  // SOL in program buffers that still have an authority (left by unfinished deploys).
  "solana-buffers": async () => {
    const list = await rpc<{ account: { lamports: number } }[]>(
      "getProgramAccounts",
      ["BPFLoaderUpgradeab1e11111111111111111111111", { encoding: "base64", dataSlice: { offset: 0, length: 0 }, filters: [{ memcmp: { offset: 0, bytes: base58.encode(Uint8Array.of(1, 0, 0, 0, 1)) } }] }],
      SOLANA_INDEX_RPCS,
    );
    return { parts: [{ symbol: "SOL", amount: list.reduce((s, a) => s + a.account.lamports, 0) / 1e9, priceKey: "coingecko:solana" }], count: list.length };
  },
  // DigixDAO's refund contract (2020): its ETH is only paid to the remaining DGD holders.
  digixdao: async () => ({ parts: [eth(await ethOf("0x23Ea10CC1e6EBdB499D24E45369A35f43627062f"))] }),
  // USDC left for Kinto's former users.
  kinto: async () => ({ parts: await held(["USDC"], "0x47A56a558892De88367108183Df913852617e77C") }),
};

const measured: { id: string; parts: Part[]; count?: number }[] = [];
for (const [id, run] of Object.entries(SOURCES)) {
  try {
    const r = await run();
    measured.push({ id, ...r });
    console.log(`${id}: ${r.parts.map((p) => `${p.amount.toLocaleString("en-US", { maximumFractionDigits: 2 })} ${p.symbol}`).join(", ")}${r.count ? ` (${r.count})` : ""}`);
  } catch (e) {
    console.log(`${id}: FAILED, left out (${String((e as Error).message).split("\n")[0]})`);
  }
}
if (measured.length < MIN_SOURCES) throw new Error(`only ${measured.length} sources measured: file not written`);

const keys = [...new Set(measured.flatMap((m) => m.parts.map((p) => p.priceKey)))];
const res = await fetch(`https://coins.llama.fi/prices/current/${keys.join(",")}`);
if (!res.ok) throw new Error(`prices: HTTP ${res.status}`);
const prices = ((await res.json()) as { coins: Record<string, { price: number }> }).coins;

const sources = measured
  .map((m) => {
    // Assets without a market price count for nothing.
    const parts = m.parts.map((p) => ({ symbol: p.symbol, amount: p.amount, usd: Math.round(p.amount * (prices[p.priceKey]?.price ?? 0)) })).filter((p) => p.usd > 0);
    // Same symbol on several chains or contracts: one line.
    const merged = [...new Set(parts.map((p) => p.symbol))].map((symbol) => {
      const same = parts.filter((p) => p.symbol === symbol);
      return { symbol, amount: Math.round(same.reduce((s, p) => s + p.amount, 0) * 100) / 100, usd: same.reduce((s, p) => s + p.usd, 0) };
    });
    merged.sort((a, b) => b.usd - a.usd);
    return { id: m.id, usd: merged.reduce((s, p) => s + p.usd, 0), ...(m.count && { count: m.count }), parts: merged };
  })
  .filter((s) => s.usd > 0)
  .sort((a, b) => b.usd - a.usd);
const out = { measuredAt: Math.floor(Date.now() / 1000), totalUsd: sources.reduce((s, x) => s + x.usd, 0), sources };
writeFileSync(new URL("../src/lib/unclaimed-totals.json", import.meta.url), JSON.stringify(out, null, 1) + "\n");
console.log(`\ntotal: $${out.totalUsd.toLocaleString("en-US")} across ${sources.length} sources`);
