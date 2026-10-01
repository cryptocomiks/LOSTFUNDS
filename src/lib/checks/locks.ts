import { encodeFunctionData, parseAbi, type Address, type Hex } from "viem";
import { l1Client } from "../clients";
import { formatAmount, formatDate } from "../format";
import type { Finding } from "../types";
import { makeFinding, now, type CheckOutput } from "./common";
import { DUST_ETHEREUM, dryRun, ETHERSCAN, rewardSource } from "./claims";

/**
 * Expired vote-escrow locks: tokens locked for voting power (veCRV, veBAL, veFXS, veSDT, vePENDLE,
 * vlCVX). When a lock ends nothing is sent back: the tokens stay in the contract until their owner
 * withdraws them. One read per contract finds the expired locks (all in one multicall); each is
 * reported once its withdrawal simulates from the user's address.
 */

export const LOCKS = rewardSource("expired-locks", "Expired locks");

interface Lock {
  key: string;
  /** e.g. "Curve's veCRV". */
  name: string;
  label: string;
  contract: Address;
  symbol: string;
  token: Address;
  claimAt: string;
}

/** Curve-style vote-escrows: locked(address) → (amount, end), then withdraw(). */
const VOTE_ESCROWS: Lock[] = [
  {
    key: "vecrv",
    name: "Curve's veCRV",
    label: "Curve lock (veCRV)",
    contract: "0x5f3b5DfEb7B28CDbD7FAba78963EE202a494e2A2",
    symbol: "CRV",
    token: "0xD533a949740bb3306d119CC777fa900bA034cd52",
    claimAt: "curve.finance (DAO → Lock)",
  },
  {
    key: "vebal",
    name: "Balancer's veBAL",
    label: "Balancer lock (veBAL)",
    contract: "0xC128a9954e6c874eA3d62ce62B468bA073093F25",
    symbol: "B-80BAL-20WETH",
    token: "0x5c6Ee304399DBdB9C8Ef030aB642B10820DB8F56",
    claimAt: "balancer.fi (veBAL)",
  },
  {
    key: "vefxs",
    name: "Frax's veFXS",
    label: "Frax lock (veFXS)",
    contract: "0xc8418aF6358FFddA74e09Ca9CC3Fe03Ca6aDC5b0",
    symbol: "FXS",
    token: "0x3432B6A60D23Ca0dFCa7761B7ab56459D9C964D0",
    claimAt: "app.frax.finance",
  },
  {
    key: "vesdt",
    name: "Stake DAO's veSDT",
    label: "Stake DAO lock (veSDT)",
    contract: "0x0C30476f66034E11782938DF8e4384970B6c9e8a",
    symbol: "SDT",
    token: "0x73968b9a57c6E53d41345FD57a6E6ae27d6CDB2F",
    claimAt: "stakedao.org",
  },
];

const VEPENDLE: Lock = {
  key: "vependle",
  name: "Pendle's vePENDLE",
  label: "Pendle lock (vePENDLE)",
  contract: "0x4f30A9D41B80ecC5B94306AB4364951AE3170210",
  symbol: "PENDLE",
  token: "0x808507121B80c02388fAd14726482e061B8da827",
  claimAt: "app.pendle.finance/vependle",
};

const VLCVX: Lock = {
  key: "vlcvx",
  name: "Convex's vlCVX",
  label: "Convex lock (vlCVX)",
  contract: "0x72a19342e8F1838460eBFCCEf09F6585e32db86E",
  symbol: "CVX",
  token: "0x4e3FBD56CD56c3e72c1403e103b45Db9da5B9D2B",
  claimAt: "convexfinance.com",
};

const veAbi = parseAbi(["function locked(address) view returns (int128 amount, uint256 end)", "function withdraw()"]);
const pendleAbi = parseAbi(["function positionData(address) view returns (uint128 amount, uint128 expiry)", "function withdraw() returns (uint128)"]);
const vlcvxAbi = parseAbi([
  "function lockedBalances(address) view returns (uint256 total, uint256 unlockable, uint256 locked, (uint112 amount, uint112 boosted, uint32 unlockTime)[] lockData)",
  "function balances(address) view returns (uint112 locked, uint112 boosted, uint32 nextUnlockIndex)",
  "function userLocks(address, uint256) view returns (uint112 amount, uint112 boosted, uint32 unlockTime)",
  "function processExpiredLocks(bool _relock)",
]);

const WITHDRAW = encodeFunctionData({ abi: veAbi, functionName: "withdraw" });
const PROCESS_EXPIRED = encodeFunctionData({ abi: vlcvxAbi, functionName: "processExpiredLocks", args: [false] });

interface Expired {
  lock: Lock;
  amount: bigint;
  /** When the lock ended (unix seconds). */
  end: number;
  /** The withdrawal transaction. */
  data: Hex;
  note?: string;
}

export async function checkLocks(user: Address): Promise<CheckOutput> {
  const c = l1Client();
  const t = now();
  const [escrows, pendle, cvx] = await Promise.all([
    Promise.all(VOTE_ESCROWS.map((v) => c.readContract({ address: v.contract, abi: veAbi, functionName: "locked", args: [user] }))),
    c.readContract({ address: VEPENDLE.contract, abi: pendleAbi, functionName: "positionData", args: [user] }),
    c.readContract({ address: VLCVX.contract, abi: vlcvxAbi, functionName: "lockedBalances", args: [user] }),
  ]);

  const expired: Expired[] = [];
  escrows.forEach(([amount, end], i) => {
    if (amount > 0n && end <= BigInt(t)) expired.push({ lock: VOTE_ESCROWS[i], amount, end: Number(end), data: WITHDRAW });
  });
  if (pendle[0] > 0n && pendle[1] <= BigInt(t)) expired.push({ lock: VEPENDLE, amount: pendle[0], end: Number(pendle[1]), data: WITHDRAW });
  const unlockable = cvx[1];
  if (unlockable > 0n) {
    // The oldest expired lock is the next one to unlock.
    const [, , next] = await c.readContract({ address: VLCVX.contract, abi: vlcvxAbi, functionName: "balances", args: [user] });
    const [, , unlockTime] = await c.readContract({ address: VLCVX.contract, abi: vlcvxAbi, functionName: "userLocks", args: [user, BigInt(next)] });
    expired.push({
      lock: VLCVX,
      amount: unlockable,
      end: unlockTime,
      data: PROCESS_EXPIRED,
      note: "Withdraw it soon: 4 weeks after a lock ends, anyone can process it for you and keep a fee taken from it, growing every week.",
    });
  }

  const findings = await Promise.all(
    expired.map(async (e): Promise<Finding | null> => {
      if ((await dryRun(c, { from: user, to: e.lock.contract, data: e.data })) === null) return null;
      return makeFinding(LOCKS, {
        key: e.lock.key,
        label: e.lock.label,
        status: "ready",
        asset: { symbol: e.lock.symbol, decimals: 18, amount: e.amount, token: e.lock.token, tokenChain: "ethereum" },
        txHash: e.lock.contract,
        txUrl: `${ETHERSCAN}/address/${e.lock.contract}#writeContract`,
        timestamp: e.end,
        dateLabel: "Lock ended",
        claimAt: e.lock.claimAt,
        minUsd: DUST_ETHEREUM,
        note: `${formatAmount(e.amount, 18)} ${e.lock.symbol} locked in ${e.lock.name} was never withdrawn. The lock ended on ${formatDate(e.end)}, but the tokens stay in the contract until you withdraw them.${e.note ? ` ${e.note}` : ""}`,
      });
    }),
  );
  return { findings: findings.filter((f) => f !== null), completed: 0 };
}
