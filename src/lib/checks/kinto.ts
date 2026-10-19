import { encodeFunctionData, parseAbi, type Address } from "viem";
import { l1Client } from "../clients";
import { formatAmount } from "../format";
import { makeFinding, type CheckOutput, type FindingSource } from "./common";
import { LEGACY_GUIDE } from "./exchanges";
import { wouldSucceed } from "./simulate";

/**
 * Kinto, an Ethereum L2, shut down on September 30, 2025. What its users had not withdrawn by then (at least $50 per
 * address) was turned into USDC on Ethereum and put in KintoLeftOver, a claim contract with no deadline: each address's
 * amount is stored on-chain, and acceptAndClaim() pays it to that address. About 157,000 USDC for ~800 addresses was
 * still unclaimed on Oct 19, 2026. One view (in Ethereum's shared multicall), then the claim simulated from the user.
 */

export const KINTO: FindingSource = { id: "kinto", name: "Kinto (shut down)", guideId: LEGACY_GUIDE, explorer: "https://etherscan.io" };

export const KINTO_LEFTOVER: Address = "0x47A56a558892De88367108183Df913852617e77C";
const USDC: Address = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const MIN_USD = 5;

const abi = parseAbi(["function userInfos(address) view returns (uint256 amount, bool claimed)", "function acceptAndClaim()"]);

export async function checkKinto(user: Address): Promise<CheckOutput> {
  const c = l1Client();
  const [amount, claimed] = await c.readContract({ address: KINTO_LEFTOVER, abi, functionName: "userInfos", args: [user] });
  if (amount === 0n) return { findings: [], completed: 0 };
  if (claimed) return { findings: [], completed: 1 };
  // The contract may hold less than every address is owed: only show what it would pay right now.
  if (!(await wouldSucceed(c, { from: user, to: KINTO_LEFTOVER, data: encodeFunctionData({ abi, functionName: "acceptAndClaim" }) })))
    return { findings: [], completed: 0 };
  return {
    findings: [
      makeFinding(KINTO, {
        key: "leftover",
        label: "Kinto leftover balance",
        status: "ready",
        asset: { symbol: "USDC", decimals: 6, amount, token: USDC, tokenChain: "ethereum" },
        txHash: KINTO_LEFTOVER,
        txUrl: `https://etherscan.io/address/${KINTO_LEFTOVER}#writeContract`,
        linkLabel: "Open the claim contract",
        timestamp: 1759190400, // Kinto shut down on Sep 30, 2025
        dateLabel: "Shut down",
        claimAt: "Etherscan → KintoLeftOver → Write Contract → acceptAndClaim, from this wallet",
        minUsd: MIN_USD,
        note: `Kinto shut down in September 2025. What this address still had there was converted to ${formatAmount(amount, 6)} USDC, waiting on Ethereum in Kinto's KintoLeftOver contract, with no deadline. Call acceptAndClaim() (no arguments) from this wallet: the USDC is sent to it in the same transaction.`,
      }),
    ],
    completed: 0,
  };
}
