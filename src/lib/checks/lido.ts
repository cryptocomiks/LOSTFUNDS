import { encodeFunctionData, parseAbi, type Address } from "viem";
import { l1Client } from "../clients";
import { formatAmount, formatDate } from "../format";
import { ethAsset } from "../tokens";
import type { Finding } from "../types";
import { makeFinding, type CheckOutput } from "./common";
import { DUST_ETHEREUM, dryRun, ETHERSCAN, rewardSource } from "./claims";

/**
 * Lido withdrawals: stETH the user asked Lido to unstake. Once Lido finalizes a request, its ETH
 * waits in the withdrawal queue until the holder of the request (an unstETH NFT) claims it, with
 * no deadline. About 25,500 ETH (~$70M) was waiting there in September 2026.
 *
 * The queue lists the unclaimed requests of their current holder. Finalized ones are reported as
 * ready once claiming them simulates from the user's address; the others as waiting, with Lido's
 * own estimate of when they'll be finalized.
 */

export const LIDO = rewardSource("lido-withdrawals", "Lido withdrawals");

const QUEUE: Address = "0x889edC2eDab5f40e902b864aD4d7AdE8E412F9B1";
/** Lido's withdrawal-time estimates (keyless, CORS). Only asked about pending requests. */
const ESTIMATES = "https://wq-api.lido.fi/v2/request-time";
const CLAIM_AT = "stake.lido.fi/withdrawals/claim";
/** Requests per simulated claim (each one adds ~60k gas), and in all (the views' gas grows with it too). */
const PER_CLAIM = 100;
const MAX_REQUESTS = 500;

const abi = parseAbi([
  "function getWithdrawalRequests(address _owner) view returns (uint256[] requestsIds)",
  "function getWithdrawalStatus(uint256[] _requestIds) view returns ((uint256 amountOfStETH, uint256 amountOfShares, address owner, uint256 timestamp, bool isFinalized, bool isClaimed)[] statuses)",
  "function getLastCheckpointIndex() view returns (uint256)",
  "function findCheckpointHints(uint256[] _requestIds, uint256 _firstIndex, uint256 _lastIndex) view returns (uint256[] hintIds)",
  "function getClaimableEther(uint256[] _requestIds, uint256[] _hints) view returns (uint256[] claimableEthValues)",
  "function claimWithdrawals(uint256[] _requestIds, uint256[] _hints)",
]);

const nftUrl = (id: bigint) => `${ETHERSCAN}/nft/${QUEUE}/${id}`;

/** "#1, #2, #3" (the first few). */
function idList(ids: bigint[]) {
  const shown = ids.slice(0, 4).map((id) => `#${id}`);
  return ids.length > 4 ? `${shown.join(", ")} and ${ids.length - 4} more` : shown.join(", ");
}

/** When Lido expects to finalize these requests (best effort: their claim doesn't depend on it). */
async function finalizationEstimate(ids: bigint[]): Promise<number | undefined> {
  try {
    const query = ids.slice(0, 20).map((id) => `ids=${id}`).join("&");
    const res = await fetch(`${ESTIMATES}?${query}`, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return undefined;
    const rows = (await res.json()) as { requestInfo?: { finalizationAt?: string } | null }[];
    const times = rows.map((r) => Date.parse(r.requestInfo?.finalizationAt ?? "")).filter((t) => t > 0);
    return times.length ? Math.ceil(Math.max(...times) / 1000) : undefined;
  } catch {
    return undefined;
  }
}

export async function checkLido(user: Address): Promise<CheckOutput> {
  const c = l1Client();
  const owned = await c.readContract({ address: QUEUE, abi, functionName: "getWithdrawalRequests", args: [user] });
  if (!owned.length) return { findings: [], completed: 0 };
  // Hints must be looked up in ascending order.
  const ids = [...owned].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).slice(0, MAX_REQUESTS);
  const [statuses, last] = await Promise.all([
    c.readContract({ address: QUEUE, abi, functionName: "getWithdrawalStatus", args: [ids] }),
    c.readContract({ address: QUEUE, abi, functionName: "getLastCheckpointIndex" }),
  ]);
  const finalized = ids.filter((_, i) => statuses[i].isFinalized && !statuses[i].isClaimed);
  const pending = ids.filter((_, i) => !statuses[i].isFinalized);
  const requestedAt = (id: bigint) => Number(statuses[ids.indexOf(id)].timestamp);
  const findings: Finding[] = [];

  if (finalized.length) {
    const hints = await c.readContract({ address: QUEUE, abi, functionName: "findCheckpointHints", args: [finalized, 1n, last] });
    const eth = await c.readContract({ address: QUEUE, abi, functionName: "getClaimableEther", args: [finalized, hints] });
    // Claim them as the Lido app does, a batch per transaction. A batch the queue rejects isn't reported.
    const batches = Array.from({ length: Math.ceil(finalized.length / PER_CLAIM) }, (_, b) => b * PER_CLAIM);
    const ok = await Promise.all(
      batches.map(async (start) => {
        const n = Math.min(PER_CLAIM, finalized.length - start);
        const data = encodeFunctionData({
          abi,
          functionName: "claimWithdrawals",
          args: [finalized.slice(start, start + n), hints.slice(start, start + n)],
        });
        return (await dryRun(c, { from: user, to: QUEUE, data, gas: 500_000n + 100_000n * BigInt(n) })) !== null;
      }),
    );
    const claimable = finalized.filter((_, i) => ok[Math.floor(i / PER_CLAIM)] && eth[i] > 0n);
    const amount = claimable.reduce((sum, id) => sum + eth[finalized.indexOf(id)], 0n);
    if (amount > 0n) {
      const first = claimable[0];
      const since = formatDate(requestedAt(first));
      findings.push(
        makeFinding(LIDO, {
          key: "claimable",
          label: "Lido withdrawal",
          status: "ready",
          asset: ethAsset(amount),
          txHash: `request-${first}`,
          txUrl: nftUrl(first),
          timestamp: requestedAt(first),
          dateLabel: "Requested",
          claimAt: CLAIM_AT,
          minUsd: DUST_ETHEREUM,
          note:
            claimable.length === 1
              ? `You asked Lido to unstake this ETH on ${since} (request #${first}). Lido finalized the request, but the ETH stays in its withdrawal queue until you claim it. There's no deadline.`
              : `${claimable.length} Lido withdrawal requests (${idList(claimable)}), the oldest from ${since}, were finalized but never claimed. The ETH stays in Lido's withdrawal queue until you claim it. There's no deadline.`,
        }),
      );
    }
  }

  if (pending.length) {
    const amount = pending.reduce((sum, id) => sum + statuses[ids.indexOf(id)].amountOfStETH, 0n);
    const readyAt = await finalizationEstimate(pending);
    const first = pending[0];
    const one = pending.length === 1;
    const when = readyAt
      ? `Lido hasn't finalized ${one ? "it" : "them"} yet and expects to around ${formatDate(readyAt)}.`
      : `Lido hasn't finalized ${one ? "it" : "them"} yet (it usually takes 1 to 5 days, longer when many people unstake at once).`;
    findings.push(
      makeFinding(LIDO, {
        key: "pending",
        label: "Lido withdrawal",
        status: "waiting",
        readyAt,
        asset: ethAsset(amount),
        txHash: `request-${first}`,
        txUrl: nftUrl(first),
        timestamp: requestedAt(first),
        dateLabel: "Requested",
        claimAt: CLAIM_AT,
        minUsd: DUST_ETHEREUM,
        note: `You asked Lido to unstake ${formatAmount(amount, 18)} stETH (${one ? `request #${first}` : `requests ${idList(pending)}`}). ${when} The ETH isn't sent automatically: claim it then.`,
      }),
    );
  }
  return { findings, completed: 0 };
}
