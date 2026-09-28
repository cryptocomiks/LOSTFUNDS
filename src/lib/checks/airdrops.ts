import { getAddress, parseAbi, type Address, type Hex } from "viem";
import { l1Client } from "../clients";
import type { CheckOutput, FindingSource } from "./common";
import { makeFinding } from "./common";

/**
 * Airdrops that can still be claimed (no deadline), checked on-chain.
 *
 * Each one is a Uniswap-style MerkleDistributor: the eligibility list (index,
 * amount, proof per address) is published by the project, and the contract's
 * isClaimed(index) says whether it was claimed. Expired airdrops are not listed.
 */

export const AIRDROPS: FindingSource = { id: "airdrops", name: "Airdrops", guideId: "airdrops" };

const distributorAbi = parseAbi(["function isClaimed(uint256 index) view returns (bool)"]);

interface Entry {
  index: number;
  amount: Hex;
  proof: Hex[];
}

interface Airdrop {
  id: string;
  label: string;
  symbol: string;
  decimals: number;
  token: Address;
  distributor: Address;
  /** Unix seconds of the airdrop, shown as the "sent" date. */
  date: number;
  note: string;
  lookup: (user: Address) => Promise<Entry | null>;
}

/**
 * Uniswap publishes its list split in ~2,500 chunks, plus a mapping of each chunk's
 * first → last address (lowercase). Chunk files are named after their first address.
 */
function chunkedList(base: string) {
  let mapping: Promise<[string, string][]> | undefined;
  const loadMapping = () =>
    (mapping ??= fetch(`${base}/mapping.json`, { signal: AbortSignal.timeout(20_000) })
      .then((r) => {
        if (!r.ok) throw new Error(`eligibility list: HTTP ${r.status}`);
        return r.json() as Promise<Record<string, string>>;
      })
      .then((m) => Object.entries(m).sort(([a], [b]) => (a < b ? -1 : 1)))
      .catch((e) => {
        mapping = undefined;
        throw e;
      }));

  return async (user: Address): Promise<Entry | null> => {
    const me = user.toLowerCase();
    const ranges = await loadMapping();
    // Last chunk whose first address is <= me.
    let lo = 0;
    let hi = ranges.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (ranges[mid][0] <= me) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (found < 0 || me > ranges[found][1].toLowerCase()) return null;
    const res = await fetch(`${base}/${ranges[found][0]}.json`, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`eligibility list: HTTP ${res.status}`);
    const chunk = (await res.json()) as Record<string, Entry>;
    const key = Object.keys(chunk).find((k) => k.toLowerCase() === me);
    return key ? chunk[key] : null;
  };
}

const LIST: Airdrop[] = [
  {
    id: "uni-2020",
    label: "Uniswap airdrop",
    symbol: "UNI",
    decimals: 18,
    token: "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984",
    distributor: "0x090D4613473dEE047c3f2706764f49E0821D256e",
    date: 1600214400, // Sep 16, 2020
    note: "Uniswap's September 2020 airdrop has no deadline, and this address never claimed its UNI.",
    lookup: chunkedList("https://raw.githubusercontent.com/Uniswap/mrkl-drop-data-chunks/final/chunks"),
  },
];

export async function checkAirdrops(user: Address): Promise<CheckOutput> {
  const out: CheckOutput = { findings: [], completed: 0 };
  await Promise.all(
    LIST.map(async (a) => {
      const entry = await a.lookup(getAddress(user));
      if (!entry) return; // not eligible
      const claimed = await l1Client().readContract({
        address: a.distributor,
        abi: distributorAbi,
        functionName: "isClaimed",
        args: [BigInt(entry.index)],
      });
      if (claimed) {
        out.completed++;
        return;
      }
      out.findings.push(
        makeFinding(AIRDROPS, {
          key: a.id,
          label: a.label,
          status: "ready",
          asset: { symbol: a.symbol, decimals: a.decimals, amount: BigInt(entry.amount), token: a.token, tokenChain: "ethereum" },
          txHash: a.distributor,
          txUrl: `https://etherscan.io/address/${a.distributor}#writeContract`,
          timestamp: a.date,
          note: a.note,
        }),
      );
    }),
  );
  return out;
}
