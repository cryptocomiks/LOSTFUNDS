import { decodeFunctionResult, encodeFunctionData, parseAbi, type Address, type Hex, type PublicClient } from "viem";
import { l1Client } from "../clients";
import { formatDate } from "../format";
import type { Finding } from "../types";
import { makeFinding, type CheckOutput } from "./common";
import { DUST_ETHEREUM, dryRun, dryRunRepeated, ETHERSCAN, rewardSource } from "./claims";

/**
 * Fee distributors: Curve (and Balancer) share their protocol fees every week with the holders of
 * their vote-escrow (veCRV, veBAL), who must claim them. Only addresses that ever locked (one
 * view, `user_point_epoch`) are dry-run. One claim only covers a limited number of weeks (50 on
 * Curve, 20 on Balancer), so the claim is repeated in one simulated block (eth_simulateV1) until
 * it returns nothing; nodes that can't do that get a single claim, reported as "at least".
 */

export const CURVE_FEES = rewardSource("curve-fees", "Curve fees");
export const BALANCER_FEES = rewardSource("balancer-fees", "Balancer fees");

const WEEK = 604_800;
const VECRV: Address = "0x5f3b5DfEb7B28CDbD7FAba78963EE202a494e2A2";
const VEBAL: Address = "0xC128a9954e6c874eA3d62ce62B468bA073093F25";

const veAbi = parseAbi([
  "function user_point_epoch(address) view returns (uint256)",
  "function user_point_history__ts(address, uint256) view returns (uint256)",
]);
const curveAbi = parseAbi([
  "function claim(address _addr) returns (uint256)",
  "function time_cursor_of(address) view returns (uint256)",
  "function start_time() view returns (uint256)",
]);
const balancerAbi = parseAbi([
  "function claimTokens(address user, address[] tokens) returns (uint256[])",
  "function getUserTokenTimeCursor(address user, address token) view returns (uint256)",
]);

interface Claimed {
  /** Total per token, over every claim needed. */
  amounts: bigint[];
  /** Number of claim transactions it takes. */
  claims: number;
  /** False: there may be more than `amounts` (claims left after the ones simulated). */
  complete: boolean;
}

/** Claims again and again (one simulated block) until a claim returns nothing. Null if the claim is rejected. */
async function claimAll(c: PublicClient, tx: { from: Address; to: Address; data: Hex }, decode: (r: Hex) => readonly bigint[], max: number): Promise<Claimed | null> {
  const runs = (await dryRunRepeated(c, tx, max)) ?? [await dryRun(c, { ...tx, gas: 10_000_000n })];
  let amounts: bigint[] | undefined;
  let claims = 0;
  for (const r of runs) {
    if (r === null) break;
    const got = decode(r);
    if (got.every((x) => x === 0n)) return { amounts: amounts ?? got.map(() => 0n), claims, complete: true };
    amounts = amounts ? amounts.map((a, i) => a + got[i]) : [...got];
    claims++;
  }
  return amounts ? { amounts, claims, complete: false } : null;
}

const roundUpToWeek = (t: number) => Math.ceil(t / WEEK) * WEEK;

/** How many claims it takes, or that there may be more ("at least"). */
function claimsNote(c: Claimed, weeks: number) {
  if (!c.complete) return `This is at least what's waiting: one claim covers up to ${weeks} weeks, so claim again until nothing is left.`;
  if (c.claims > 1) return `It takes ${c.claims} claims to get it all: one claim covers up to ${weeks} weeks.`;
  return "";
}

const CURVE_DISTRIBUTORS = [
  {
    key: "3crv",
    label: "Curve fees (3CRV)",
    contract: "0xA464e6DCda8AC41e03616F95f4BC98a13b8922Dc" as Address,
    symbol: "3CRV",
    token: "0x6c3F90f043a72FA612cbac8115EE7e52BDe6E490" as Address,
    paidIn: "3CRV, the LP token of Curve's 3pool (DAI/USDC/USDT)",
  },
  {
    key: "crvusd",
    label: "Curve fees (crvUSD)",
    contract: "0xD16d5eC345Dd86Fb63C6a9C43c517210F1027914" as Address,
    symbol: "crvUSD",
    token: "0xf939E0A03FB07F59A73314E73794Be0E57ac1b4E" as Address,
    paidIn: "crvUSD (since mid-2024)",
  },
];
/** 3CRV fees started in September 2020: 7 claims of 50 weeks cover everything until 2027. */
const CURVE_MAX_CLAIMS = 8;

const uint = (r: Hex) => (r.length >= 66 ? BigInt(r.slice(0, 66)) : 0n);

export async function checkCurveFees(user: Address): Promise<CheckOutput> {
  const c = l1Client();
  const epochs = await c.readContract({ address: VECRV, abi: veAbi, functionName: "user_point_epoch", args: [user] });
  if (epochs === 0n) return { findings: [], completed: 0 }; // never locked CRV: no fees
  const firstLock = c.readContract({ address: VECRV, abi: veAbi, functionName: "user_point_history__ts", args: [user, 1n] });
  const findings = await Promise.all(
    CURVE_DISTRIBUTORS.map(async (d): Promise<Finding | null> => {
      const data = encodeFunctionData({ abi: curveAbi, functionName: "claim", args: [user] });
      const [claimed, cursor, start, first] = await Promise.all([
        claimAll(c, { from: user, to: d.contract, data }, (r) => [uint(r)], CURVE_MAX_CLAIMS),
        c.readContract({ address: d.contract, abi: curveAbi, functionName: "time_cursor_of", args: [user] }),
        c.readContract({ address: d.contract, abi: curveAbi, functionName: "start_time" }),
        firstLock,
      ]);
      if (!claimed || claimed.amounts[0] === 0n) return null;
      // The first week not claimed yet: the user's cursor, or (never claimed) the first week after their first lock.
      const since = Number(cursor) || Math.max(Number(start), roundUpToWeek(Number(first)));
      return makeFinding(CURVE_FEES, {
        key: d.key,
        label: d.label,
        status: "ready",
        asset: { symbol: d.symbol, decimals: 18, amount: claimed.amounts[0], token: d.token, tokenChain: "ethereum" },
        txHash: d.contract,
        txUrl: `${ETHERSCAN}/address/${d.contract}#writeContract`,
        timestamp: since,
        dateLabel: "Unclaimed since",
        claimAt: "curve.finance (DAO page)",
        minUsd: DUST_ETHEREUM,
        note: `Curve shares its fees every week with veCRV holders, paid in ${d.paidIn}. This address held veCRV and hasn't claimed its share since ${formatDate(since)}. ${claimsNote(claimed, 50)}`.trim(),
      });
    }),
  );
  return { findings: findings.filter((f) => f !== null), completed: 0 };
}

/** Balancer's veBAL fee distributor. Older payouts in bb-a-USD (retired boosted-pool tokens) aren't counted. */
const BALANCER_DISTRIBUTOR: Address = "0xD3cf852898b21fc233251427c2DC93d3d604F3BB";
const BALANCER_TOKENS = [
  { symbol: "BAL", decimals: 18, token: "0xba100000625a3754423978a60c9317c58a424e3D" as Address },
  { symbol: "USDC", decimals: 6, token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address },
];
/** Fees started in April 2022: 13 claims of 20 weeks cover everything until mid-2027. */
const BALANCER_MAX_CLAIMS = 13;

export async function checkBalancerFees(user: Address): Promise<CheckOutput> {
  const c = l1Client();
  const epochs = await c.readContract({ address: VEBAL, abi: veAbi, functionName: "user_point_epoch", args: [user] });
  if (epochs === 0n) return { findings: [], completed: 0 }; // never locked: no fees
  const data = encodeFunctionData({ abi: balancerAbi, functionName: "claimTokens", args: [user, BALANCER_TOKENS.map((t) => t.token)] });
  const decode = (r: Hex) => decodeFunctionResult({ abi: balancerAbi, functionName: "claimTokens", data: r });
  const [claimed, ...cursors] = await Promise.all([
    claimAll(c, { from: user, to: BALANCER_DISTRIBUTOR, data }, decode, BALANCER_MAX_CLAIMS),
    // The first week of each token not claimed yet.
    ...BALANCER_TOKENS.map((t) =>
      c.readContract({ address: BALANCER_DISTRIBUTOR, abi: balancerAbi, functionName: "getUserTokenTimeCursor", args: [user, t.token] }),
    ),
  ]);
  if (!claimed) return { findings: [], completed: 0 };
  const findings = BALANCER_TOKENS.flatMap((t, i) => {
    const amount = claimed.amounts[i];
    if (!amount) return [];
    const since = Number(cursors[i]);
    return [
      makeFinding(BALANCER_FEES, {
        key: t.symbol.toLowerCase(),
        label: `Balancer fees (${t.symbol})`,
        status: "ready",
        asset: { symbol: t.symbol, decimals: t.decimals, amount, token: t.token, tokenChain: "ethereum" },
        txHash: BALANCER_DISTRIBUTOR,
        txUrl: `${ETHERSCAN}/address/${BALANCER_DISTRIBUTOR}#writeContract`,
        timestamp: since,
        dateLabel: "Unclaimed since",
        claimAt: "balancer.fi (veBAL)",
        minUsd: DUST_ETHEREUM,
        note: `Balancer shares its fees every week with veBAL holders, in BAL and USDC. This address held veBAL and hasn't claimed its ${t.symbol} since ${formatDate(since)}. ${claimsNote(claimed, 20)}`.trim(),
      }),
    ];
  });
  return { findings, completed: 0 };
}
