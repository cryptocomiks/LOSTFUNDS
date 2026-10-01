import { encodeFunctionData, parseAbi, type Address, type PublicClient } from "viem";
import { l1Client } from "../clients";
import { evmClient } from "../evm";
import { formatAmount } from "../format";
import type { Finding } from "../types";
import { makeFinding, now, type CheckOutput } from "./common";
import { DUST_ETHEREUM, DUST_L2, dryRun, rewardSource } from "./claims";

/**
 * Synthetix escrow: SNX staking rewards were paid as SNX escrowed for a year. Once an entry's
 * end time has passed it is fully vested, but stays in RewardEscrowV2 until the owner calls
 * vest(entryIDs). About 680,000 SNX on Ethereum and 750,000 on OP Mainnet were waiting in
 * September 2026. Vested entries are read in pages, then vest is simulated from the user.
 */

export const SNX_ESCROW = rewardSource("synthetix-escrow", "Synthetix escrow");

const CHAINS: {
  name: string;
  escrow: Address;
  snx: Address;
  tokenChain: string;
  explorer: string;
  minUsd: number;
  client: () => PublicClient;
}[] = [
  {
    name: "Ethereum",
    escrow: "0xFAd53Cc9480634563E8ec71E8e693Ffd07981d38",
    snx: "0xC011a73ee8576Fb46F5E1c5751cA3B9Fe0af2a6F",
    tokenChain: "ethereum",
    explorer: "https://etherscan.io",
    minUsd: DUST_ETHEREUM,
    client: l1Client,
  },
  {
    name: "OP Mainnet",
    escrow: "0x5Fc9B8d2B7766f061bD84a41255fD1A76Fd1FAa2",
    snx: "0x8700dAec35aF8Ff88c16BdF0418774CB3D7599B4",
    tokenChain: "optimism",
    explorer: "https://optimistic.etherscan.io",
    minUsd: DUST_L2,
    client: () => evmClient(10)!,
  },
];

/** Entries read per call, and pages at most (weekly rewards for years make a few hundred entries). */
const PAGE = 500n;
const MAX_PAGES = 4;

const abi = parseAbi([
  "function numVestingEntries(address account) view returns (uint256)",
  "function getVestingSchedules(address account, uint256 index, uint256 pageSize) view returns ((uint64 endTime, uint256 escrowAmount, uint256 entryID)[])",
  "function getVestingQuantity(address account, uint256[] entryIDs) view returns (uint256)",
  "function vest(uint256[] entryIDs)",
]);

async function vestable(user: Address, chain: (typeof CHAINS)[number]): Promise<Finding | null> {
  const c = chain.client();
  const count = await c.readContract({ address: chain.escrow, abi, functionName: "numVestingEntries", args: [user] });
  if (count === 0n) return null;
  const pages = Array.from({ length: Math.min(MAX_PAGES, Math.ceil(Number(count) / Number(PAGE))) }, (_, k) => BigInt(k) * PAGE);
  const entries = (
    await Promise.all(pages.map((start) => c.readContract({ address: chain.escrow, abi, functionName: "getVestingSchedules", args: [user, start, PAGE] })))
  ).flat();
  const t = BigInt(now());
  const vested = entries.filter((e) => e.escrowAmount > 0n && e.endTime <= t);
  if (!vested.length) return null;
  const ids = vested.map((e) => e.entryID);
  const data = encodeFunctionData({ abi, functionName: "vest", args: [ids] });
  const [amount, ok] = await Promise.all([
    c.readContract({ address: chain.escrow, abi, functionName: "getVestingQuantity", args: [user, ids] }),
    dryRun(c, { from: user, to: chain.escrow, data, gas: 500_000n + 50_000n * BigInt(ids.length) }),
  ]);
  if (ok === null || amount === 0n) return null;
  const since = Number(vested.reduce((min, e) => (e.endTime < min ? e.endTime : min), vested[0].endTime));
  const how = ids.length <= 8 ? `Call vest with the entry IDs [${ids.join(",")}].` : `Call vest with its ${ids.length} vested entry IDs (see the guide).`;
  return makeFinding(SNX_ESCROW, {
    key: chain.tokenChain,
    label: `Synthetix escrow (${chain.name})`,
    status: "ready",
    asset: { symbol: "SNX", decimals: 18, amount, token: chain.snx, tokenChain: chain.tokenChain },
    txHash: chain.escrow,
    txUrl: `${chain.explorer}/address/${chain.escrow}#writeContract`,
    timestamp: since,
    dateLabel: "Vested since",
    claimAt: `${new URL(chain.explorer).host} (RewardEscrowV2, Write Contract → vest)`,
    minUsd: chain.minUsd,
    note: `Synthetix paid staking rewards in SNX escrowed for a year. ${formatAmount(amount, 18)} SNX of this address's escrow on ${chain.name} has fully vested, but stays in the escrow contract until you claim it, with no deadline. ${how}`,
  });
}

export async function checkSynthetixEscrow(user: Address): Promise<CheckOutput> {
  const results = await Promise.allSettled(CHAINS.map((chain) => vestable(user, chain)));
  const failed = results.flatMap((r, i) => (r.status === "rejected" ? [`${CHAINS[i].name}: ${(r.reason as Error)?.message?.split("\n")[0] ?? r.reason}`] : []));
  if (failed.length === CHAINS.length) throw (results[0] as PromiseRejectedResult).reason;
  const findings = results.flatMap((r) => (r.status === "fulfilled" && r.value ? [r.value] : []));
  return { findings, completed: 0, ...(failed.length && { error: failed.join(" · ") }) };
}
