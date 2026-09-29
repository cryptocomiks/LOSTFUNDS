import { formatUnits, getAddress, parseAbi, type Address, type Hex } from "viem";
import { l1Client } from "../clients";
import { evmClient } from "../evm";
import { accountsData, findProgramAddress } from "../solana";
import { base58 } from "@scure/base";
import type { Asset } from "../types";
import type { CheckOutput, FindingSource } from "./common";
import { makeFinding, now } from "./common";

/**
 * Airdrops that can still be claimed, checked on-chain. Expired ones are not listed,
 * and one with a deadline disappears once the deadline has passed.
 */

export const AIRDROPS: FindingSource = { id: "airdrops", name: "Airdrops", guideId: "airdrops" };

const distributorAbi = parseAbi(["function isClaimed(uint256 index) view returns (bool)"]);

interface Entry {
  index: number;
  amount: Hex;
  proof: Hex[];
}

/** What an airdrop check found for one address. */
type Lookup =
  | null // not eligible
  | { claimed: true }
  | { claimed: false; amount: bigint; note?: string };

export interface Airdrop {
  id: string;
  /** Wallet kinds that can be eligible. */
  accepts: ("evm" | "solana")[];
  /** Name in the checker grid. */
  name: string;
  label: string;
  symbol: string;
  decimals: number;
  /** Where to claim, shown as text. */
  claimAt: string;
  /** Unix seconds of the airdrop, shown as the "Airdropped" date. */
  date: number;
  note: string;
  /** Link shown as "View transaction": the claim contract. */
  txUrl: string;
  asset: (amount: bigint) => Asset;
  /** `user` is a checksummed EVM address or a base58 Solana address, per `accepts`. */
  lookup: (user: string) => Promise<Lookup>;
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

const UNI_DISTRIBUTOR: Address = "0x090D4613473dEE047c3f2706764f49E0821D256e";
const uniList = chunkedList("https://raw.githubusercontent.com/Uniswap/mrkl-drop-data-chunks/final/chunks");

/** Zora's community claim on Base keeps every allocation on-chain, with no deadline and no sweep. */
const ZORA_CLAIM: Address = "0x0000000002ba96c69b95e32caab8fc38bab8b3f8";
const zoraAbi = parseAbi(["function accountClaim(address) view returns ((uint96 allocation, bool claimed))"]);

/** Sonic's airdrop vesting NFT (ERC-1155, id = season). What is still locked is burned after `lockedBurnTime`. */
const SONIC_AIRDROP: Address = "0xE1401171219FD2fD37c8C04a8A753B07706F3567";
const sonicAbi = parseAbi([
  "function getSeasonData(uint8) view returns (uint256 startTime, uint256 maturationTime, uint256 claimsBurnTime, uint256 lockedBurnTime, uint256 instantClaimAvailableBps, bytes32 merkleRoot)",
  "function getSeasonBalances(uint8 season, address user) view returns (uint128 balance, uint128 vested, uint128 penalty)",
]);

/**
 * Kamino's Season 3 KMNO airdrop (Solana). Kamino's API gives each wallet's allocation;
 * a ClaimStatus account exists once it's claimed. Past its clawback date, but the tokens
 * stay claimable until Kamino actually claws them back (the distributor's flag).
 */
const KAMINO_PROGRAM = "KdisqEcXbXKaTrBFqeDLhMmBvymLTwj9GmhDcdJyGat";
const CLAWED_BACK_OFFSET = 265;

async function kaminoLookup(user: string): Promise<Lookup> {
  const res = await fetch(`https://api.kamino.finance/distributor/user/${user}`, { signal: AbortSignal.timeout(20_000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Kamino API: HTTP ${res.status}`);
  const { merkle_tree: tree, amount } = (await res.json()) as { merkle_tree: string; amount: number | string };
  const claimStatus = findProgramAddress(
    [new TextEncoder().encode("ClaimStatus"), base58.decode(user), base58.decode(tree)],
    KAMINO_PROGRAM,
  );
  const [distributor, status] = await accountsData([tree, claimStatus]);
  if (status) return { claimed: true };
  if (!distributor || distributor[CLAWED_BACK_OFFSET] !== 0) return null; // clawed back: no longer claimable
  return { claimed: false, amount: BigInt(amount) };
}

export const AIRDROP_LIST: Airdrop[] = [
  {
    id: "uni-2020",
    accepts: ["evm"],
    name: "Uniswap (UNI)",
    label: "Uniswap airdrop",
    symbol: "UNI",
    decimals: 18,
    claimAt: "app.uniswap.org, or the MerkleDistributor contract on Etherscan",
    date: 1600214400, // Sep 16, 2020
    note: "Uniswap's September 2020 airdrop has no deadline, and this address never claimed its UNI.",
    txUrl: `https://etherscan.io/address/${UNI_DISTRIBUTOR}#writeContract`,
    asset: (amount) => ({ symbol: "UNI", decimals: 18, amount, token: "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984", tokenChain: "ethereum" }),
    lookup: async (user) => {
      const entry = await uniList(user as Address);
      if (!entry) return null;
      const claimed = await l1Client().readContract({
        address: UNI_DISTRIBUTOR,
        abi: distributorAbi,
        functionName: "isClaimed",
        args: [BigInt(entry.index)],
      });
      return claimed ? { claimed: true } : { claimed: false, amount: BigInt(entry.amount) };
    },
  },
  {
    id: "zora-2025",
    accepts: ["evm"],
    name: "Zora (ZORA)",
    label: "Zora airdrop",
    symbol: "ZORA",
    decimals: 18,
    claimAt: "zora.co, or the claim contract on Basescan (claim, sent from the eligible wallet)",
    date: 1745416800, // Apr 23, 2025
    note: "Zora's April 2025 airdrop on Base has no deadline, and this address never claimed its ZORA.",
    txUrl: `https://basescan.org/address/${ZORA_CLAIM}#writeContract`,
    asset: (amount) => ({ symbol: "ZORA", decimals: 18, amount, token: "0x1111111111166b7FE7bd91427724B487980aFc69", tokenChain: "base" }),
    lookup: async (user) => {
      const { allocation, claimed } = await evmClient(8453)!.readContract({
        address: ZORA_CLAIM,
        abi: zoraAbi,
        functionName: "accountClaim",
        args: [user as Address],
      });
      if (!allocation) return null;
      return claimed ? { claimed: true } : { claimed: false, amount: allocation };
    },
  },
  {
    id: "sonic-2025",
    accepts: ["evm"],
    name: "Sonic (S)",
    label: "Sonic airdrop",
    symbol: "S",
    decimals: 18,
    claimAt: "my.soniclabs.com/airdrop",
    date: 1736942400, // Jan 15, 2025 (season 1)
    note: "",
    txUrl: `https://sonicscan.org/address/${SONIC_AIRDROP}`,
    asset: (amount) => ({ symbol: "S", decimals: 18, amount, priceKey: "coingecko:sonic-3" }),
    lookup: async (user) => {
      const c = evmClient(146)!;
      let amount = 0n;
      let deadline = 0;
      for (const season of [1, 2]) {
        const [data, [balance]] = await Promise.all([
          c.readContract({ address: SONIC_AIRDROP, abi: sonicAbi, functionName: "getSeasonData", args: [season] }),
          c.readContract({ address: SONIC_AIRDROP, abi: sonicAbi, functionName: "getSeasonBalances", args: [season, user as Address] }),
        ]);
        const burnAt = Number(data[3]);
        if (balance > 0n && now() < burnAt) {
          amount += balance;
          deadline = deadline ? Math.min(deadline, burnAt) : burnAt;
        }
      }
      if (!amount) return null;
      const day = new Date(deadline * 1000).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
      return {
        claimed: false,
        amount,
        note: `This wallet holds Sonic airdrop NFTs worth ${Number(formatUnits(amount, 18)).toLocaleString("en-US", { maximumFractionDigits: 2 })} S that were never unlocked. Unlock them before ${day}: whatever is still locked then is burned.`,
      };
    },
  },
  {
    id: "kamino-s3",
    accepts: ["solana"],
    name: "Kamino (KMNO)",
    label: "Kamino Season 3 airdrop",
    symbol: "KMNO",
    decimals: 6,
    claimAt: "app.kamino.finance",
    date: 1779890200, // distribution opened May 27, 2026
    note: "Kamino's Season 3 KMNO was never claimed by this wallet. Its official claim period is over, but the tokens are still on-chain and claimable until Kamino takes them back: claim soon.",
    txUrl: `https://solscan.io/account/${KAMINO_PROGRAM}`,
    asset: (amount) => ({ symbol: "KMNO", decimals: 6, amount, priceKey: "solana:KMNo3nJsBXfcpJTVhZcXLW7RmTwTt4GVFE7suUBo9sS" }),
    lookup: kaminoLookup,
  },
];

/** Checks one airdrop, or all of them. */
export async function checkAirdrops(user: string, list: Airdrop[] = AIRDROP_LIST): Promise<CheckOutput> {
  const out: CheckOutput = { findings: [], completed: 0 };
  const kind = user.startsWith("0x") ? "evm" : "solana";
  await Promise.all(
    list.filter((a) => a.accepts.includes(kind)).map(async (a) => {
      const r = await a.lookup(kind === "evm" ? getAddress(user) : user);
      if (!r) return; // not eligible
      if (r.claimed) {
        out.completed++;
        return;
      }
      out.findings.push(
        makeFinding(AIRDROPS, {
          key: a.id,
          label: a.label,
          status: "ready",
          asset: a.asset(r.amount),
          txHash: a.txUrl,
          txUrl: a.txUrl,
          timestamp: a.date,
          note: r.note ?? a.note,
        }),
      );
    }),
  );
  return out;
}
