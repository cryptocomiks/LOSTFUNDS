import { decodeFunctionResult, encodeFunctionData, parseAbi, type Address } from "viem";
import { evmClient } from "../evm";
import { formatAmount } from "../format";
import type { Finding } from "../types";
import { makeFinding, type CheckOutput } from "./common";
import { DUST_ETHEREUM, DUST_L2, dryRun, rewardSource } from "./claims";

/**
 * What Stargate's veSTG holders are owed since LayerZero bought Stargate (DAO vote of August 2025), on each of the
 * seven chains where veSTG lived:
 *  - USDC revenue share: those who held veSTG at the snapshot of August 10, 2025 got half of Stargate's revenue for
 *    six months, paid by a VeDistributor (same address on every chain) in USDC (USDT on BNB Chain), pro rata to their
 *    veSTG at the snapshot. No deadline; about $790k was still unclaimed on Oct 19, 2026.
 *  - locked STG: every veSTG contract was unlocked, so the STG still in it (14.3M on Oct 19, 2026) can be withdrawn at
 *    any time, then converted into ZRO at stargate.finance until December 15, 2026 (1 STG = 0.08634 ZRO).
 *
 * Three views per chain, in its one multicall; then claimUsdc() and withdraw() are simulated from the user, and the
 * USDC shown is what claimUsdc() returns.
 */

export const STARGATE_VESTG = rewardSource("stargate-vestg", "Stargate veSTG");

/** The VeDistributor, deployed at the same address on every chain. */
export const VE_DISTRIBUTOR: Address = "0x1E68BE052a9a9ff04714582831457a9B319Bcafe";
/** Last day STG converts into ZRO (LayerZero's announcement of September 15, 2026). */
const ZRO_CONVERSION_END = "December 15, 2026";

export const STARGATE_CHAINS: {
  chainId: number;
  name: string;
  /** The revenue share's token (USDC, or USDT on BNB Chain). */
  symbol: string;
  decimals: number;
  token: Address;
  tokenChain: string;
  ve: Address;
  stg: Address;
  explorer: string;
}[] = [
  {
    chainId: 1,
    name: "Ethereum",
    symbol: "USDC",
    decimals: 6,
    token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    tokenChain: "ethereum",
    ve: "0x0e42acBD23FAee03249DAFF896b78d7e79fBD58E",
    stg: "0xAf5191B0De278C7286d6C7CC6ab6BB8A73bA2Cd6",
    explorer: "https://etherscan.io",
  },
  {
    chainId: 42161,
    name: "Arbitrum",
    symbol: "USDC",
    decimals: 6,
    token: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    tokenChain: "arbitrum",
    ve: "0xfBd849E6007f9BC3CC2D6Eb159c045B8dc660268",
    stg: "0x6694340fc020c5E6B96567843da2df01b2CE1eb6",
    explorer: "https://arbiscan.io",
  },
  {
    chainId: 56,
    name: "BNB Chain",
    symbol: "USDT",
    decimals: 18,
    token: "0x55d398326f99059fF775485246999027B3197955",
    tokenChain: "bsc",
    ve: "0xD4888870C8686c748232719051b677791dBDa26D",
    stg: "0xB0D502E938ed5f4df2E681fE6E419ff29631d62b",
    explorer: "https://bscscan.com",
  },
  {
    chainId: 137,
    name: "Polygon",
    symbol: "USDC",
    decimals: 6,
    token: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
    tokenChain: "polygon",
    ve: "0x3AB2DA31bBD886A7eDF68a6b60D3CDe657D3A15D",
    stg: "0x2F6F07CDcf3588944Bf4C42aC74ff24bF56e7590",
    explorer: "https://polygonscan.com",
  },
  {
    chainId: 10,
    name: "OP Mainnet",
    symbol: "USDC",
    decimals: 6,
    token: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
    tokenChain: "optimism",
    ve: "0x43d2761ed16C89A2C4342e2B16A3C61Ccf88f05B",
    stg: "0x296F55F8Fb28E498B858d0BcDA06D955B2Cb3f97",
    explorer: "https://optimistic.etherscan.io",
  },
  {
    chainId: 43114,
    name: "Avalanche",
    symbol: "USDC",
    decimals: 6,
    token: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
    tokenChain: "avax",
    ve: "0xCa0F57D295bbcE554DA2c07b005b7d6565a58fCE",
    stg: "0x2F6F07CDcf3588944Bf4C42aC74ff24bF56e7590",
    explorer: "https://snowtrace.io",
  },
  {
    chainId: 250,
    name: "Fantom",
    symbol: "USDC",
    decimals: 6,
    token: "0x28a92dde19D9989F39A49905d7C9C2FAc7799bDf",
    tokenChain: "fantom",
    ve: "0x933421675cDC8c280e5F21f0e061E77849293dba",
    stg: "0x2F6F07CDcf3588944Bf4C42aC74ff24bF56e7590",
    explorer: "https://ftmscout.com",
  },
];

const abi = parseAbi([
  "function getUsdcClaimable(address _user) view returns (uint256 usdcClaimable)",
  "function userClaimedAmounts(address user) view returns (uint256 claimedAmount)",
  "function claimUsdc() returns (uint256 usdcClaimed)",
]);
const veAbi = parseAbi(["function locked(address) view returns (int128 amount, uint256 end)", "function withdraw()"]);

/** What one chain holds for the user, and whether it already took a revenue share that is now all claimed. */
async function onChain(user: Address, chain: (typeof STARGATE_CHAINS)[number]): Promise<{ findings: Finding[]; claimed: boolean }> {
  const c = evmClient(chain.chainId)!;
  const [left, taken, [locked]] = await Promise.all([
    c.readContract({ address: VE_DISTRIBUTOR, abi, functionName: "getUsdcClaimable", args: [user] }),
    c.readContract({ address: VE_DISTRIBUTOR, abi, functionName: "userClaimedAmounts", args: [user] }),
    c.readContract({ address: chain.ve, abi: veAbi, functionName: "locked", args: [user] }),
  ]);
  const explorerHost = new URL(chain.explorer).host;
  const minUsd = chain.chainId === 1 ? DUST_ETHEREUM : DUST_L2;
  // Both claims are dry-run from the user's own address: they revert when paused or when the contract runs short.
  const [usdc, withdrawn] = await Promise.all([
    left > 0n ? dryRun(c, { from: user, to: VE_DISTRIBUTOR, data: encodeFunctionData({ abi, functionName: "claimUsdc" }) }) : null,
    locked > 0n ? dryRun(c, { from: user, to: chain.ve, data: encodeFunctionData({ abi: veAbi, functionName: "withdraw" }) }) : null,
  ]);
  const findings: Finding[] = [];
  const paid = usdc === null ? 0n : decodeFunctionResult({ abi, functionName: "claimUsdc", data: usdc });
  if (paid > 0n)
    findings.push(
      makeFinding(STARGATE_VESTG, {
        key: `usdc-${chain.chainId}`,
        label: `Stargate veSTG revenue share (${chain.name})`,
        status: "ready",
        asset: { symbol: chain.symbol, decimals: chain.decimals, amount: paid, token: chain.token, tokenChain: chain.tokenChain },
        txHash: VE_DISTRIBUTOR,
        txUrl: `${chain.explorer}/address/${VE_DISTRIBUTOR}#writeContract`,
        linkLabel: "Open the distributor",
        timestamp: 1754842920, // the veSTG snapshot, Aug 10, 2025
        dateLabel: "Snapshot",
        claimAt: `stargate.finance (Stake), or claimUsdc() on the distributor on ${explorerHost}`,
        minUsd,
        note: `This address held veSTG on ${chain.name} at the snapshot of August 10, 2025, when LayerZero bought Stargate: veSTG holders got half of Stargate's revenue for the six months that followed. Its share, ${formatAmount(paid, chain.decimals)} ${chain.symbol}, was never claimed. There is no deadline: claim it on stargate.finance, or call claimUsdc() (no arguments) on the distributor from this address.`,
      }),
    );
  if (locked > 0n && withdrawn !== null)
    findings.push(
      makeFinding(STARGATE_VESTG, {
        key: `stg-${chain.chainId}`,
        label: `STG locked in veSTG (${chain.name})`,
        status: "ready",
        asset: { symbol: "STG", decimals: 18, amount: locked, token: chain.stg, tokenChain: chain.tokenChain, priceKey: "coingecko:stargate-finance" },
        txHash: chain.ve,
        txUrl: `${chain.explorer}/address/${chain.ve}#writeContract`,
        linkLabel: "Open the veSTG contract",
        timestamp: 0,
        claimAt: `withdraw() on the veSTG contract on ${explorerHost}, then stargate.finance to convert it into ZRO`,
        minUsd,
        note: `${formatAmount(locked, 18)} STG are still locked in veSTG on ${chain.name}. Stargate unlocked every lock when LayerZero bought it, so withdraw() (no arguments) on the veSTG contract sends them back to this address now. STG converts into ZRO at a fixed rate (1 STG = 0.08634 ZRO) on stargate.finance until ${ZRO_CONVERSION_END}.`,
      }),
    );
  return { findings, claimed: left === 0n && taken > 0n };
}

export async function checkStargate(user: Address): Promise<CheckOutput> {
  const results = await Promise.allSettled(STARGATE_CHAINS.map((chain) => onChain(user, chain)));
  const failed = results.flatMap((r, i) => (r.status === "rejected" ? [`${STARGATE_CHAINS[i].name}: ${(r.reason as Error)?.message?.split("\n")[0] ?? r.reason}`] : []));
  if (failed.length === STARGATE_CHAINS.length) throw (results[0] as PromiseRejectedResult).reason;
  const ok = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  return {
    findings: ok.flatMap((r) => r.findings),
    completed: ok.filter((r) => r.claimed).length,
    ...(failed.length && { error: failed.join(" · ") }),
  };
}
