import { encodeFunctionData, parseAbi, type Address } from "viem";
import { evmClient } from "../evm";
import { formatAmount } from "../format";
import type { Finding } from "../types";
import { makeFinding, type CheckOutput } from "./common";
import { DUST_L2, dryRun, rewardSource } from "./claims";

/**
 * Livepeer (on Arbitrum): unstaking LPT takes two steps. Unbonding starts a 7-round wait, after
 * which the LPT must be withdrawn by hand: it stays in the BondingManager until then. Delegators
 * also earn ETH fees that are only paid when withdrawn.
 * getDelegator gives the number of unbonding locks; the latest ones are read, and those past
 * their withdraw round are reported once withdrawStake simulates from the delegator. Fees:
 * pendingFees at the current round, then withdrawFees simulated.
 */

export const LIVEPEER = rewardSource("livepeer", "Livepeer", "https://arbiscan.io");

const BONDING_MANAGER: Address = "0x35Bcf3c30594191d53231E4FF333E8A770453e40";
const ROUNDS_MANAGER: Address = "0xdd6f56DcC28D3F5f27084381fE8Df634985cc39f";
const LPT: Address = "0x289ba1701C2F088cf0faf8B3705246331cB8A839";
/** More unbonding locks than this: only the latest are read. */
const MAX_LOCKS = 30;

const abi = parseAbi([
  "function currentRound() view returns (uint256)",
  "function getDelegator(address) view returns (uint256 bondedAmount, uint256 fees, address delegateAddress, uint256 delegatedAmount, uint256 startRound, uint256 lastClaimRound, uint256 nextUnbondingLockId)",
  "function getDelegatorUnbondingLock(address, uint256) view returns (uint256 amount, uint256 withdrawRound)",
  "function pendingFees(address, uint256) view returns (uint256)",
  "function withdrawStake(uint256 unbondingLockId)",
  "function withdrawFees(address recipient, uint256 amount)",
]);

export async function checkLivepeer(user: Address): Promise<CheckOutput> {
  const c = evmClient(42161)!;
  const [delegator, round] = await Promise.all([
    c.readContract({ address: BONDING_MANAGER, abi, functionName: "getDelegator", args: [user] }),
    c.readContract({ address: ROUNDS_MANAGER, abi, functionName: "currentRound" }),
  ]);
  const next = Number(delegator[6]);
  // Never bonded, and no lock ever created: nothing to read.
  if (next === 0 && delegator[0] === 0n && delegator[4] === 0n) return { findings: [], completed: 0 };

  const ids = Array.from({ length: Math.min(next, MAX_LOCKS) }, (_, i) => BigInt(next - 1 - i));
  const [locks, fees] = await Promise.all([
    Promise.all(ids.map((id) => c.readContract({ address: BONDING_MANAGER, abi, functionName: "getDelegatorUnbondingLock", args: [user, id] }))),
    c.readContract({ address: BONDING_MANAGER, abi, functionName: "pendingFees", args: [user, round] }),
  ]);
  const link = { txHash: BONDING_MANAGER, txUrl: `https://arbiscan.io/address/${BONDING_MANAGER}#writeProxyContract`, linkLabel: "View contract", timestamp: 0, minUsd: DUST_L2, claimAt: "explorer.livepeer.org (your account → Withdraw)" };

  const findings: (Finding | null)[] = await Promise.all([
    ...ids.map(async (id, i): Promise<Finding | null> => {
      const [amount, withdrawRound] = locks[i];
      if (amount === 0n || withdrawRound > round) return null;
      if ((await dryRun(c, { from: user, to: BONDING_MANAGER, data: encodeFunctionData({ abi, functionName: "withdrawStake", args: [id] }) })) === null) return null;
      return makeFinding(LIVEPEER, {
        key: `lock-${id}`,
        label: "Livepeer: unstaked LPT never withdrawn",
        status: "ready",
        asset: { symbol: "LPT", decimals: 18, amount, token: LPT, tokenChain: "arbitrum" },
        ...link,
        note: `You unstaked ${formatAmount(amount, 18)} LPT on Livepeer (Arbitrum) and the waiting period is over, but they were never withdrawn: unstaked LPT stays in Livepeer's contract until you withdraw it (unbonding lock #${id}).`,
      });
    }),
    (async (): Promise<Finding | null> => {
      if (fees === 0n) return null;
      if ((await dryRun(c, { from: user, to: BONDING_MANAGER, data: encodeFunctionData({ abi, functionName: "withdrawFees", args: [user, fees] }) })) === null) return null;
      return makeFinding(LIVEPEER, {
        key: "fees",
        label: "Livepeer: ETH fees never withdrawn",
        status: "ready",
        asset: { symbol: "ETH", decimals: 18, amount: fees },
        ...link,
        claimAt: "explorer.livepeer.org (your account → Withdraw fees)",
        note: `Staking LPT on Livepeer (Arbitrum) earned this address ${formatAmount(fees, 18)} ETH in fees that were never withdrawn. They are paid in ETH on Arbitrum when you withdraw them.`,
      });
    })(),
  ]);
  return { findings: findings.filter((f): f is Finding => f !== null), completed: 0 };
}
