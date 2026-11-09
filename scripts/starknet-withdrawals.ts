/**
 * Builds public/legacy/starknet: every Starknet → Ethereum message still waiting on Ethereum
 * (sent by Starknet, never consumed), by L1 recipient, for messages that look like token
 * withdrawals (payload: 0, recipient, [token,] amount low, amount high).
 *   NODE_USE_ENV_PROXY=1 npx tsx scripts/starknet-withdrawals.ts
 * The check reads the file for the address, then searches only the blocks after SNAPSHOT_BLOCK
 * (written to public/legacy/starknet/meta.json) live, and re-checks every message on-chain.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { createPublicClient, http, parseAbi, type Hex } from "viem";
import { mainnet } from "viem/chains";
import { isWithdrawal, LEGACY_BRIDGE_TOKENS, LOG_MESSAGE_TO_L1 as event, messageHash, STARKNET_CORE as CORE } from "../src/lib/checks/starknet.ts";

const FIRST_BLOCK = 13_500_000n; // Starknet Alpha on mainnet: November 2021
const CHUNK = 100_000n;
const logs = createPublicClient({ chain: mainnet, transport: http("https://gateway.tenderly.co/public/mainnet", { timeout: 60_000, retryCount: 4 }) });
const reads = createPublicClient({ chain: mainnet, transport: http("https://ethereum-rpc.publicnode.com", { timeout: 60_000, retryCount: 4 }) });
const coreAbi = parseAbi(["function l2ToL1Messages(bytes32) view returns (uint256)"]);

/** A range's logs, split in halves while the node refuses it (too many results, response too large). */
async function fetchRange(from: bigint, to: bigint): Promise<Awaited<ReturnType<typeof logs.getLogs<typeof event>>>> {
  try {
    return await logs.getLogs({ address: CORE, event, fromBlock: from, toBlock: to });
  } catch (e) {
    if (to - from < 100n) throw e;
    const mid = (from + to) / 2n;
    return [...(await fetchRange(from, mid)), ...(await fetchRange(mid + 1n, to))];
  }
}

const head = await logs.getBlockNumber();
const all: { from: bigint; to: Hex; payload: readonly bigint[]; block: bigint }[] = [];
for (let start = FIRST_BLOCK; start <= head; start += CHUNK) {
  const end = start + CHUNK - 1n > head ? head : start + CHUNK - 1n;
  const got = await fetchRange(start, end);
  for (const l of got) all.push({ from: l.args.fromAddress!, to: l.args.toAddress!, payload: l.args.payload!, block: l.blockNumber });
  process.stdout.write(`\r${end} ${all.length} messages`);
}
console.log();
/**
 * Withdrawal-shaped messages worth about $5 or more: the page hides smaller findings on Ethereum
 * anyway, and leaving dust out keeps the files small. Tokens not in this table are all kept.
 */
const DUST: Record<string, bigint> = {
  eth: 2n * 10n ** 15n, // ETH (legacy bridge, or the "ETH" marker)
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": 5_000_000n, // USDC
  "0xdac17f958d2ee523a2206206994597c13d831ec7": 5_000_000n, // USDT
  "0x6b175474e89094c44da98b954eedeac495271d0f": 5n * 10n ** 18n, // DAI
  "0x5f98805a4e8be255a32880fdec7f6728c6568ba0": 5n * 10n ** 18n, // LUSD
  "0xca14007eff0db1f8135f4c25b34de49ab0d42766": 50n * 10n ** 18n, // STRK
  "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0": 2n * 10n ** 15n, // wstETH
  "0xae78736cd615f374d3085123a210448e74fc6393": 2n * 10n ** 15n, // rETH
  "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599": 5_000n, // WBTC
};
const tokenOf = (to: Hex, payload: readonly bigint[]) =>
  payload.length === 5
    ? payload[2] === 0x455448n
      ? "eth"
      : `0x${payload[2].toString(16).padStart(40, "0")}`
    : (LEGACY_BRIDGE_TOKENS[to.toLowerCase()]?.token?.toLowerCase() ?? (LEGACY_BRIDGE_TOKENS[to.toLowerCase()] ? "eth" : "unknown"));
const amountOf = (payload: readonly bigint[]) => payload[payload.length - 2] + (payload[payload.length - 1] << 128n);
const withdrawals = all.filter((m) => isWithdrawal(m.payload) && amountOf(m.payload) >= (DUST[tokenOf(m.to, m.payload)] ?? 1n));
const hashes = withdrawals.map((m) => messageHash(m.from, m.to, m.payload));
const unique = [...new Set(hashes)];
const pending = new Map<Hex, bigint>();
for (let i = 0; i < unique.length; i += 500) {
  const r = await reads.multicall({ contracts: unique.slice(i, i + 500).map((h) => ({ address: CORE, abi: coreAbi, functionName: "l2ToL1Messages", args: [h] }) as const), allowFailure: false });
  r.forEach((n, k) => n > 0n && pending.set(unique[i + k], n));
  process.stdout.write(`\r${Math.min(i + 500, unique.length)}/${unique.length} checked, ${pending.size} pending`);
}
console.log();

const dir = new URL("../public/legacy/starknet/", import.meta.url);
mkdirSync(dir, { recursive: true });
const byPrefix: Record<string, Record<string, [string, Hex, string[]][]>> = {};
const seen = new Set<Hex>();
withdrawals.forEach((m, i) => {
  if (!pending.has(hashes[i]) || seen.has(hashes[i])) return;
  seen.add(hashes[i]);
  const recipient = `0x${m.payload[1].toString(16).padStart(40, "0")}`;
  ((byPrefix[recipient[2]] ??= {})[recipient] ??= []).push([`0x${m.from.toString(16)}`, m.to.toLowerCase() as Hex, m.payload.map((x) => `0x${x.toString(16)}`)]);
});
for (const p of "0123456789abcdef") writeFileSync(new URL(`${p}.json`, dir), JSON.stringify(byPrefix[p] ?? {}) + "\n");
writeFileSync(new URL("meta.json", dir), JSON.stringify({ snapshotBlock: Number(head), messages: all.length, pending: seen.size }) + "\n");
console.log(`snapshot at block ${head}: ${all.length} messages, ${withdrawals.length} withdrawals, ${seen.size} still pending`);
