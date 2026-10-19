import { decodeFunctionResult, encodeFunctionData, parseAbi, type Address } from "viem";
import { evmClient } from "../evm";
import { formatAmount } from "../format";
import type { Finding } from "../types";
import { makeFinding, type CheckOutput } from "./common";
import { DUST_ETHEREUM, DUST_L2, dryRun, rewardSource } from "./claims";

/**
 * Stargate's veSTG USDC. When LayerZero bought Stargate (DAO vote of August 2025), those who held veSTG at the
 * snapshot of August 10, 2025 got half of Stargate's revenue for six months, paid by a VeDistributor on each chain
 * where veSTG lived (same address on all seven), in USDC (USDT on BNB Chain). Each holder's share follows their veSTG
 * balance at the snapshot and stays claimable, with no deadline: about $790k was still unclaimed on Oct 19, 2026.
 *
 * One view per chain (getUsdcClaimable); claimUsdc() is then simulated from the user, and the amount shown is what
 * it returns.
 */

export const STARGATE_USDC = rewardSource("stargate-vestg", "Stargate veSTG USDC");

/** The VeDistributor, deployed at the same address on every chain. */
export const VE_DISTRIBUTOR: Address = "0x1E68BE052a9a9ff04714582831457a9B319Bcafe";

export const STARGATE_CHAINS: { chainId: number; name: string; symbol: string; decimals: number; token: Address; tokenChain: string; explorer: string }[] = [
  { chainId: 1, name: "Ethereum", symbol: "USDC", decimals: 6, token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", tokenChain: "ethereum", explorer: "https://etherscan.io" },
  { chainId: 42161, name: "Arbitrum", symbol: "USDC", decimals: 6, token: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", tokenChain: "arbitrum", explorer: "https://arbiscan.io" },
  { chainId: 56, name: "BNB Chain", symbol: "USDT", decimals: 18, token: "0x55d398326f99059fF775485246999027B3197955", tokenChain: "bsc", explorer: "https://bscscan.com" },
  { chainId: 137, name: "Polygon", symbol: "USDC", decimals: 6, token: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", tokenChain: "polygon", explorer: "https://polygonscan.com" },
  { chainId: 10, name: "OP Mainnet", symbol: "USDC", decimals: 6, token: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", tokenChain: "optimism", explorer: "https://optimistic.etherscan.io" },
  { chainId: 43114, name: "Avalanche", symbol: "USDC", decimals: 6, token: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", tokenChain: "avax", explorer: "https://snowtrace.io" },
  { chainId: 250, name: "Fantom", symbol: "USDC", decimals: 6, token: "0x28a92dde19D9989F39A49905d7C9C2FAc7799bDf", tokenChain: "fantom", explorer: "https://ftmscout.com" },
];

const abi = parseAbi([
  "function getUsdcClaimable(address _user) view returns (uint256 usdcClaimable)",
  "function userClaimedAmounts(address user) view returns (uint256 claimedAmount)",
  "function claimUsdc() returns (uint256 usdcClaimed)",
]);

/** The finding on one chain, "claimed" when this address already took all of its share, null when it has none. */
async function claimable(user: Address, chain: (typeof STARGATE_CHAINS)[number]): Promise<Finding | "claimed" | null> {
  const c = evmClient(chain.chainId)!;
  // Both views travel in the chain's one multicall.
  const [left, taken] = await Promise.all([
    c.readContract({ address: VE_DISTRIBUTOR, abi, functionName: "getUsdcClaimable", args: [user] }),
    c.readContract({ address: VE_DISTRIBUTOR, abi, functionName: "userClaimedAmounts", args: [user] }),
  ]);
  if (left === 0n) return taken > 0n ? "claimed" : null;
  // What the claim pays, from the user's own address (it reverts when paused or when the distributor runs short).
  const ret = await dryRun(c, { from: user, to: VE_DISTRIBUTOR, data: encodeFunctionData({ abi, functionName: "claimUsdc" }) });
  if (ret === null) return null;
  const amount = decodeFunctionResult({ abi, functionName: "claimUsdc", data: ret });
  if (amount === 0n) return null;
  return makeFinding(STARGATE_USDC, {
    key: String(chain.chainId),
    label: `Stargate veSTG revenue share (${chain.name})`,
    status: "ready",
    asset: { symbol: chain.symbol, decimals: chain.decimals, amount, token: chain.token, tokenChain: chain.tokenChain },
    txHash: VE_DISTRIBUTOR,
    txUrl: `${chain.explorer}/address/${VE_DISTRIBUTOR}#writeContract`,
    linkLabel: "Open the distributor",
    timestamp: 1754842920, // the veSTG snapshot, Aug 10, 2025
    dateLabel: "Snapshot",
    claimAt: `stargate.finance (Stake), or claimUsdc() on the distributor on ${new URL(chain.explorer).host}`,
    minUsd: chain.chainId === 1 ? DUST_ETHEREUM : DUST_L2,
    note: `This address held veSTG on ${chain.name} at the snapshot of August 10, 2025, when LayerZero bought Stargate: veSTG holders got half of Stargate's revenue for the six months that followed. Its share, ${formatAmount(amount, chain.decimals)} ${chain.symbol}, was never claimed. There is no deadline: claim it on stargate.finance, or call claimUsdc() (no arguments) on the distributor from this address.`,
  });
}

export async function checkStargateUsdc(user: Address): Promise<CheckOutput> {
  const results = await Promise.allSettled(STARGATE_CHAINS.map((chain) => claimable(user, chain)));
  const failed = results.flatMap((r, i) => (r.status === "rejected" ? [`${STARGATE_CHAINS[i].name}: ${(r.reason as Error)?.message?.split("\n")[0] ?? r.reason}`] : []));
  if (failed.length === STARGATE_CHAINS.length) throw (results[0] as PromiseRejectedResult).reason;
  const found = results.flatMap((r) => (r.status === "fulfilled" && r.value ? [r.value] : []));
  const findings = found.filter((f): f is Finding => f !== "claimed");
  return { findings, completed: found.length - findings.length, ...(failed.length && { error: failed.join(" · ") }) };
}
