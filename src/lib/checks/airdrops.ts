import { encodeFunctionData, formatUnits, getAddress, parseAbi, type Address, type Hex } from "viem";
import { l1Client } from "../clients";
import { evmClient } from "../evm";
import { accountsData, findProgramAddress } from "../solana";
import { base58 } from "@scure/base";
import type { Asset } from "../types";
import type { CheckOutput, FindingSource } from "./common";
import { makeFinding, now } from "./common";
import { wouldSucceed } from "./simulate";

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

/** Findings worth less than this (once priced) are dust and hidden. */
const AIRDROP_MIN_USD = 2;

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

/** Uniswap-style MerkleDistributor with isClaimed(index), whose list comes from `find`. */
function merkleDistributor(distributor: Address, find: (user: Address) => Promise<{ index: number; amount: bigint } | null>) {
  return async (user: string): Promise<Lookup> => {
    const entry = await find(user as Address);
    if (!entry) return null;
    const claimed = await l1Client().readContract({ address: distributor, abi: distributorAbi, functionName: "isClaimed", args: [BigInt(entry.index)] });
    return claimed ? { claimed: true } : { claimed: false, amount: entry.amount };
  };
}

/** Fetches a URL once per page load (JSON or text), retrying later if it failed. */
function once<T>(url: string, parse: (r: Response) => Promise<T>) {
  let p: Promise<T> | undefined;
  return () =>
    (p ??= fetch(url, { signal: AbortSignal.timeout(20_000) })
      .then((r) => {
        if (!r.ok) throw new Error(`eligibility list: HTTP ${r.status}`);
        return parse(r);
      })
      .catch((e) => {
        p = undefined;
        throw e;
      }));
}

/** Lido publishes its lists as CSV: index, account, amount (hex), proof. */
function lidoCsv(url: string) {
  const load = once(url, async (r) => {
    const rows = new Map<string, { index: number; amount: bigint }>();
    for (const m of (await r.text()).matchAll(/^(\d+),(0x[0-9a-fA-F]{40}),(0x[0-9a-fA-F]+),/gm))
      rows.set(m[2].toLowerCase(), { index: Number(m[1]), amount: BigInt(m[3]) });
    return rows;
  });
  return async (user: Address) => (await load()).get(user.toLowerCase()) ?? null;
}

/** Files published with the site (a compact copy of a project's list), from anywhere the checks run. */
const siteFile = (path: string) => `${typeof window === "undefined" ? "https://lostfunds.vercel.app" : ""}${path}`;

const CURVE_VESTING: Address = "0x575CCD8e2D300e2377B43478339E364000318E2c";
const curveAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function initial_locked(address) view returns (uint256)",
]);

const safeVestingAbi = parseAbi([
  "function vestings(bytes32) view returns (address account, uint8 curveType, bool managed, uint16 durationWeeks, uint64 startDate, uint128 amount, uint128 amountClaimed, uint64 pausingDate, bool cancelled)",
  "function calculateVestedAmount(bytes32) view returns (uint128 vestedAmount, uint128 claimedAmount)",
]);

/** Safe's allocations are vestings (one address can have several): claimable = vested so far − already claimed. Never-redeemed ones expired in 2022–23. */
async function safeLookup(user: string): Promise<Lookup> {
  const res = await fetch(`https://safe-claiming-app-data.safe.global/allocations/1/${user}.json`, { signal: AbortSignal.timeout(20_000) });
  if (res.status === 404 || res.status === 403) return null;
  if (!res.ok) throw new Error(`Safe allocations: HTTP ${res.status}`);
  const list = (await res.json()) as { vestingId: Hex; contract: Address }[];
  let amount = 0n;
  let redeemed = false;
  for (const a of list) {
    const read = <F extends "vestings" | "calculateVestedAmount">(functionName: F) =>
      l1Client().readContract({ address: a.contract, abi: safeVestingAbi, functionName, args: [a.vestingId] } as never) as Promise<
        F extends "vestings" ? readonly [Address, number, boolean, number, bigint, bigint, bigint, bigint, boolean] : readonly [bigint, bigint]
      >;
    const [account, , , , , , , , cancelled] = await read("vestings");
    if (account === "0x0000000000000000000000000000000000000000" || cancelled) continue; // never redeemed: expired
    redeemed = true;
    const [vested, claimed] = await read("calculateVestedAmount");
    if (vested > claimed) amount += vested - claimed;
  }
  if (!redeemed) return null;
  return amount > 0n ? { claimed: false, amount } : { claimed: true };
}

const CONVEX_AIRDROP: Address = "0x2E088A0A19dda628B4304301d1EA70b114e4AcCd";
const convexList = once(siteFile("/airdrops/convex-cvx.json"), (r) => r.json() as Promise<Record<string, string>>);

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

const balanceOfAbi = parseAbi(["function balanceOf(address) view returns (uint256)"]);

const longDate = (ts: number) => new Date(ts * 1000).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

/** One loader per file, fetched once per page load. */
function fileCache<T>(urlOf: (key: string) => string) {
  const loaders = new Map<string, () => Promise<T>>();
  return (key: string) => {
    let load = loaders.get(key);
    if (!load) loaders.set(key, (load = once(urlOf(key), (r) => r.json() as Promise<T>)));
    return load();
  };
}

/**
 * dYdX's retroactive and trading rewards (2021–2023): cumulative amounts in a Merkle tree whose last root (epoch 31) is
 * on IPFS, 5 MB for 73,638 addresses. The site ships only the addresses that still had at least $1 to claim, split by
 * their first hex digit (~70 KB each); what was claimed since is read on-chain. The tokens come from a rewards treasury.
 */
const DYDX_DISTRIBUTOR: Address = "0x01d3348601968aB85b4bb028979006eac235a588";
const DYDX_ROOT = "0xfff42f5cf67f68dcc76f19b2a5f7b115948bc27ca5d734ecd57f2a04e4285e08";
const DYDX_TREASURY: Address = "0x639192D54431F8c816368D3FB4107Bc168d0E871";
const DYDX_TOKEN: Address = "0x92D6C1e31e14520e676a687F0a93788B716BEff5";
const dydxAbi = parseAbi([
  "function getActiveRoot() view returns (bytes32 merkleRoot, uint256 epoch, bytes ipfsCid)",
  "function getClaimed(address) view returns (uint256)",
]);
const dydxList = fileCache<Record<string, string>>((digit) => siteFile(`/airdrops/dydx/${digit}.json`));

async function dydxLookup(user: string): Promise<Lookup> {
  const me = user.toLowerCase();
  const cumulative = (await dydxList(me[2]))[me];
  if (!cumulative) return null;
  const c = l1Client();
  const [[root], claimed, treasury] = await Promise.all([
    c.readContract({ address: DYDX_DISTRIBUTOR, abi: dydxAbi, functionName: "getActiveRoot" }),
    c.readContract({ address: DYDX_DISTRIBUTOR, abi: dydxAbi, functionName: "getClaimed", args: [user as Address] }),
    c.readContract({ address: DYDX_TOKEN, abi: balanceOfAbi, functionName: "balanceOf", args: [DYDX_TREASURY] }),
  ]);
  // A new root would make the published amounts stale: fail rather than guess.
  if (root.toLowerCase() !== DYDX_ROOT) throw new Error("dYdX rewards: new Merkle root, the list is out of date");
  const left = BigInt(cumulative) - claimed;
  if (left <= 0n) return { claimed: true };
  if (treasury < left) return null; // the rewards treasury can no longer pay it
  return { claimed: false, amount: left };
}

/**
 * GnosisDAO's COW for those who locked GNO in 2021: a Merkle drop into a 4-year vesting (Giveth's TokenDistro), fully
 * vested since February 2026, on Ethereum and on Gnosis Chain. Proofs come from Gnosis's repo, sorted by address in
 * chunks of 64, as CoW Swap's Account page reads them. The first claim (with the proof) pays out everything vested;
 * after that, the rest is claimed from the TokenDistro.
 */
const LGNO_DATA = "https://raw.githubusercontent.com/gnosis/locked-gno-cow-merkle-distro/main";
const lgnoAbi = parseAbi([
  "function isClaimed(uint256 index) view returns (bool)",
  "function claim(uint256 index, uint256 amount, bytes32[] merkleProof)",
  "function claimableNow(address) view returns (uint256)",
  "function claim()",
]);
/** First address of each chunk, as in CoW Swap's index (checked against every address in the repo). */
const LGNO_CHUNKS = {
  mainnet:
    "00000081c22fe36e0b47a4f1c67041301f945014 0d78a4b2657dd319ae1f47ce5e529d03e984cef5 2059a96525c364560a806ca035a40c9f379ebca9 32ae635f5136adb181a442cc890be39263bc13c8 44dde9695027ca6acb7cdf3b361c37056122e4af 51ffd343d6fecab9e9c5640f0e6a67dec31bc76c 63829da9dc103b63d984391f7580eddb220ba6d9 773d161310d07cafc6f767ca24f43e52163b9be6 8642214d3cb4eb38ee618be37f78dd74a3093869 98b7a46a33d60f71522115ab7e2ec8f0fc294038 aa942b60823be690a17576207b819807891d71f6 bbf7bfc4d9acce27082613e2c14d9fe8d1a54a29 cb11673592cc6c4b9584f33bbba6c6cf07dde3f7 db0b39341290a30510e46e7692195fe16097e0df e91f64ca1da165ca8437686b69a022156550837b f64c2e6679e089cd1c3e303ca1245d4941747700",
  gnosisChain:
    "00000000cc0b822819f03424dacf9077fdaa58a3 06d4b89475a53111e8939b1ae8af7e14804a5186 0f1c44076d4cf58e1458a418393e6be57f3519f9 1702f2d0df7c99011a690461c34e51bd81cbab48 1ec30dec8378e6df6988da0e8a2b49b17055f0aa 26404746cd2228018f86c98f580e5030b06ff3c8 3047fa36aa687014f3ead30e4873adc3f58467bf 3812364136fe59a5db130666925be092050bd8ba 4193e4ca2241d4d16356a94da537e3c3a600678c 499487f6be895b71cf57881c22d5f6d855fcb8a2 52077db357420b6999b6b78c46c3ab2fc596fba8 5aa6a1d420bf8fa45d141af73e9230e1e8c3dc16 61fde66b0a208be7096ffa314d7cd92f519b2352 6b504204a85e0231b1a1b1926b9264939f29c65e 7246a274656e797fab4b02eb1e0581d46f0358e2 79a074122be96e1fc9bdd32dba04759421d12f90 817a33e007afb85ec23da7de231c1902cf4686c1 882289186d7b1b9cd35191780761ee80975f0fd1 90fa3f3c3a290ee19bbc94dc539dede8e21ce28f 99c72eb5c22c38137541ef4b9a2fd0316c42b510 a1e63c0f203df1314153ad6648bd38fd99774d85 abe8430e3f0beca32915da84e530f81a01379953 b6271e5a916f3764c5d3387dff14922249d9d70f bf8ab1e63a9b883a6b5a396cb5a36138af6e020a c789026a0f0b15c532c77405491331997f2b2bbc ce57ebed9ac38402dcaa44f65a1c9b04e26b8283 d64c69277d2c842c9ab17683479ac063aa35d4f5 dfeb9c25186aadf1487979be7da312f95fd55275 e6f44434c052c00d280bc236c8f58d8a9e42eec8 ee9ec3273c52ea783b86cfefab32b50b1b26fce7 f6330ad6f2d488f6f29cf45e8fa5bf798e3b8df3 ff36b9cb75c9178841d8b75baf9776bfa59fbe9d",
};

function cowForLockedGno(chainId: number, dir: keyof typeof LGNO_CHUNKS, merkleDistro: Address, tokenDistro: Address) {
  const firsts = LGNO_CHUNKS[dir].split(" ").map((a) => `0x${a}`);
  const chunk = fileCache<Record<string, Entry>>((i) => `${LGNO_DATA}/${dir}/chunk_${i}.json`);
  return async (user: string): Promise<Lookup> => {
    const me = user.toLowerCase();
    const i = firsts.findLastIndex((first) => first <= me);
    if (i < 0) return null;
    const entry = (await chunk(String(i)))[me];
    if (!entry) return null;
    const c = evmClient(chainId)!;
    const from = user as Address;
    if (!(await c.readContract({ address: merkleDistro, abi: lgnoAbi, functionName: "isClaimed", args: [BigInt(entry.index)] }))) {
      const data = encodeFunctionData({ abi: lgnoAbi, functionName: "claim", args: [BigInt(entry.index), BigInt(entry.amount), entry.proof] });
      return (await wouldSucceed(c, { from, to: merkleDistro, data })) ? { claimed: false, amount: BigInt(entry.amount) } : null;
    }
    const left = await c.readContract({ address: tokenDistro, abi: lgnoAbi, functionName: "claimableNow", args: [from] });
    if (!left) return { claimed: true };
    const data = encodeFunctionData({ abi: lgnoAbi, functionName: "claim" });
    if (!(await wouldSucceed(c, { from, to: tokenDistro, data }))) return null;
    return {
      claimed: false,
      amount: left,
      note: "This address started claiming its COW for locked GNO but never collected the rest, fully vested since February 2026. There is no deadline.",
    };
  };
}

/**
 * Avantis' Season 2 AVNT (Base, March 2026): allocations are stored in the contract and were fully unlocked by
 * March 8, 2026. claimAirdrop() pays everything from the eligible wallet. The official window was 60 days, but the
 * contract still pays: the claim is simulated before anything is shown.
 */
const AVANTIS_AIRDROP: Address = "0x7E221Ee3A68D5948c6C472A8FaC5ddeB894E2c1A";
const avantisAbi = parseAbi([
  "function getUserAllocation(address) view returns (uint256)",
  "function getClaimableNow(address) view returns (uint256)",
  "function claimAirdrop()",
]);

async function avantisLookup(user: string): Promise<Lookup> {
  const c = evmClient(8453)!;
  const from = user as Address;
  const [allocation, left] = await Promise.all([
    c.readContract({ address: AVANTIS_AIRDROP, abi: avantisAbi, functionName: "getUserAllocation", args: [from] }),
    c.readContract({ address: AVANTIS_AIRDROP, abi: avantisAbi, functionName: "getClaimableNow", args: [from] }),
  ]);
  if (!allocation) return null;
  if (!left) return { claimed: true };
  const data = encodeFunctionData({ abi: avantisAbi, functionName: "claimAirdrop" });
  return (await wouldSucceed(c, { from, to: AVANTIS_AIRDROP, data })) ? { claimed: false, amount: left } : null;
}

/**
 * Lombard's BARD airdrop, wave 4 (Ethereum, July 2026): Lombard's API gives each wallet's allocation in every wave;
 * this distributor pays until CLAIM_END (October 29, 2026). Earlier waves have expired.
 */
const LOMBARD_API = "https://mainnet.prod.lombard.finance/api/v1/bard/distributor";
const BARD_DISTRIBUTOR: Address = "0x39D438caF425C31f1a4883e0b399cC4Cc1280135";
/** The distributor's CLAIM_END (October 29, 2026): after it, the API isn't even asked. */
const BARD_CLAIM_END = 1793232000;
const BARD_TOKEN: Address = "0xf0DB65D17e30a966C2ae6A21f6BBA71cea6e9754";
const bardAbi = parseAbi([
  "function CLAIM_END() view returns (uint256)",
  "function MERKLE_ROOT() view returns (bytes32)",
  "function hasClaimed(address) view returns (bool)",
  "function paused() view returns (bool)",
]);

async function lombardLookup(user: string): Promise<Lookup> {
  if (now() >= BARD_CLAIM_END) return null;
  const res = await fetch(`${LOMBARD_API}/${user}/hard-claims`, { signal: AbortSignal.timeout(20_000) });
  const body = (await res.json().catch(() => null)) as {
    code?: number;
    claims?: { distributor_address?: string; amount: string; merkle_root?: string }[];
  } | null;
  if (res.status === 404 && body?.code === 5) return null; // "account not found": never eligible
  if (!res.ok || !body) throw new Error(`Lombard API: HTTP ${res.status}`);
  const mine = body.claims?.find((x) => x.distributor_address?.toLowerCase() === BARD_DISTRIBUTOR.toLowerCase());
  if (!mine || !BigInt(mine.amount)) return null; // in earlier (expired) waves only
  const c = l1Client();
  const [end, root, claimed, paused, held] = await Promise.all([
    c.readContract({ address: BARD_DISTRIBUTOR, abi: bardAbi, functionName: "CLAIM_END" }),
    c.readContract({ address: BARD_DISTRIBUTOR, abi: bardAbi, functionName: "MERKLE_ROOT" }),
    c.readContract({ address: BARD_DISTRIBUTOR, abi: bardAbi, functionName: "hasClaimed", args: [user as Address] }),
    c.readContract({ address: BARD_DISTRIBUTOR, abi: bardAbi, functionName: "paused" }),
    c.readContract({ address: BARD_TOKEN, abi: balanceOfAbi, functionName: "balanceOf", args: [BARD_DISTRIBUTOR] }),
  ]);
  if (now() >= Number(end)) return null; // claim period over
  if (claimed) return { claimed: true };
  if (root.toLowerCase() !== mine.merkle_root?.toLowerCase()) throw new Error("Lombard API: allocation from another Merkle root");
  const amount = BigInt(mine.amount);
  if (paused || held < amount) return null;
  return {
    claimed: false,
    amount,
    note: `Lombard's BARD airdrop (wave 4) was never claimed by this address. Claim it before ${longDate(Number(end))}: unclaimed BARD then goes back to Lombard's ecosystem fund.`,
  };
}

/**
 * A Hedgey claim campaign: Hedgey's API gives each wallet's amount and proof; the campaign (ClaimCampaigns, same
 * address on every chain) says whether it was claimed and until when. `end` is the campaign's end, checked on-chain too.
 */
const HEDGEY_CAMPAIGNS: Address = "0x8A2725a6f04816A5274dDD9FEaDd3bd0C253C1A6";
const hedgeyAbi = parseAbi([
  "function campaigns(bytes16) view returns (address manager, address token, uint256 amount, uint256 start, uint256 end, uint8 tokenLockup, bytes32 root, bool delegating)",
  "function claimed(bytes16, address) view returns (bool)",
  "function claim(bytes16 campaignId, bytes32[] proof, uint256 claimAmount)",
]);

function hedgeyCampaign(chainId: number, id: Hex, end: number) {
  const uuid = `${id.slice(2, 10)}-${id.slice(10, 14)}-${id.slice(14, 18)}-${id.slice(18, 22)}-${id.slice(22, 34)}`;
  return async (user: string): Promise<Lookup> => {
    if (now() >= end) return null;
    const res = await fetch(`https://api.hedgey.finance/token-claims/proof/${uuid}/${user}`, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`Hedgey API: HTTP ${res.status}`);
    const j = (await res.json()) as { canClaim?: boolean; amount?: string; proof?: Hex[] };
    if (!j.amount || !j.proof) return null; // {"canClaim": false}: not in the campaign
    const c = evmClient(chainId)!;
    const from = user as Address;
    const [campaign, claimed] = await Promise.all([
      c.readContract({ address: HEDGEY_CAMPAIGNS, abi: hedgeyAbi, functionName: "campaigns", args: [id] }),
      c.readContract({ address: HEDGEY_CAMPAIGNS, abi: hedgeyAbi, functionName: "claimed", args: [id, from] }),
    ]);
    if (claimed) return { claimed: true };
    const [, , left, , campaignEnd] = campaign;
    if (now() >= Number(campaignEnd) || left < BigInt(j.amount)) return null; // over, cancelled or emptied
    const data = encodeFunctionData({ abi: hedgeyAbi, functionName: "claim", args: [id, j.proof, BigInt(j.amount)] });
    return (await wouldSucceed(c, { from, to: HEDGEY_CAMPAIGNS, data })) ? { claimed: false, amount: BigInt(j.amount) } : null;
  };
}

/** Doppler Finance's XDP genesis airdrop (Base, September 2026): allocations registered in the contract, claim() until the deadline. */
const DOPPLER_AIRDROP: Address = "0x13125738747498eEf7B17ccd9a0cce395BAb733F";
const DOPPLER_DEADLINE = 1795867200; // claimDeadline: Nov 28, 2026, 12:00 UTC
const dopplerAbi = parseAbi([
  "function allocations(address) view returns (uint256)",
  "function claimed(address) view returns (bool)",
  "function claimDeadline() view returns (uint256)",
  "function claim()",
]);

async function dopplerLookup(user: string): Promise<Lookup> {
  if (now() >= DOPPLER_DEADLINE) return null;
  const c = evmClient(8453)!;
  const from = user as Address;
  const [allocation, claimed, deadline] = await Promise.all([
    c.readContract({ address: DOPPLER_AIRDROP, abi: dopplerAbi, functionName: "allocations", args: [from] }),
    c.readContract({ address: DOPPLER_AIRDROP, abi: dopplerAbi, functionName: "claimed", args: [from] }),
    c.readContract({ address: DOPPLER_AIRDROP, abi: dopplerAbi, functionName: "claimDeadline" }),
  ]);
  if (!allocation) return null;
  if (claimed) return { claimed: true };
  if (now() >= Number(deadline)) return null;
  const data = encodeFunctionData({ abi: dopplerAbi, functionName: "claim" });
  if (!(await wouldSucceed(c, { from, to: DOPPLER_AIRDROP, data }))) return null;
  return {
    claimed: false,
    amount: allocation,
    note: `Doppler Finance's XDP genesis airdrop has not been claimed by this wallet yet. Claim it before ${longDate(Number(deadline))} (12:00 UTC), when the claim period ends.`,
  };
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
    id: "curve-2020",
    accepts: ["evm"],
    name: "Curve (CRV)",
    label: "Curve early-user airdrop",
    symbol: "CRV",
    decimals: 18,
    claimAt: "the vesting contract on Etherscan (claim, for your address)",
    date: 1597322954, // Aug 13, 2020
    note: "Curve's August 2020 early-user CRV finished vesting in 2021, and this address never claimed all of it. There is no deadline.",
    txUrl: `https://etherscan.io/address/${CURVE_VESTING}#writeContract`,
    asset: (amount) => ({ symbol: "CRV", decimals: 18, amount, token: "0xD533a949740bb3306d119CC777fa900bA034cd52", tokenChain: "ethereum" }),
    lookup: async (user) => {
      const c = l1Client();
      const [left, locked] = await Promise.all([
        c.readContract({ address: CURVE_VESTING, abi: curveAbi, functionName: "balanceOf", args: [user as Address] }),
        c.readContract({ address: CURVE_VESTING, abi: curveAbi, functionName: "initial_locked", args: [user as Address] }),
      ]);
      if (!locked) return null;
      return left > 0n ? { claimed: false, amount: left } : { claimed: true };
    },
  },
  {
    id: "safe-2022",
    accepts: ["evm"],
    name: "Safe (SAFE)",
    label: "Safe airdrop",
    symbol: "SAFE",
    decimals: 18,
    claimAt: "app.safe.global (SAFE claiming), or claimVestedTokens on the vesting contract",
    date: 1663765355, // Sep 21, 2022
    note: "This address redeemed its SAFE allocation in 2022 but never claimed all the tokens that have vested since. There is no deadline for vested tokens.",
    txUrl: "https://etherscan.io/address/0xA0b937D5c8E32a80E3a8ed4227CD020221544ee6",
    asset: (amount) => ({ symbol: "SAFE", decimals: 18, amount, token: "0x5aFE3855358E112B5647B952709E6165e1c1eEEe", tokenChain: "ethereum" }),
    lookup: safeLookup,
  },
  {
    id: "1inch-2020",
    accepts: ["evm"],
    name: "1inch (1INCH)",
    label: "1inch airdrop",
    symbol: "1INCH",
    decimals: 18,
    claimAt: "the MerkleDistributor on Etherscan (claim, with the index, amount and proof from 1inch's API)",
    date: 1608829629, // Dec 24, 2020
    note: "1inch's December 2020 airdrop has no deadline, and this address never claimed its 1INCH.",
    txUrl: "https://etherscan.io/address/0xE295aD71242373C37C5FdA7B57F26f9eA1088AFe#writeContract",
    asset: (amount) => ({ symbol: "1INCH", decimals: 18, amount, token: "0x111111111117dC0aa78b770fA6A738034120C302", tokenChain: "ethereum" }),
    lookup: merkleDistributor("0xE295aD71242373C37C5FdA7B57F26f9eA1088AFe", async (user) => {
      const res = await fetch(`https://governance.1inch.io/v1.0/distribution/${user}`, { signal: AbortSignal.timeout(20_000) });
      const j = (await res.json().catch(() => null)) as { index?: number; amount?: string } | null;
      if (j && typeof j.index === "number" && j.amount) return { index: j.index, amount: BigInt(j.amount) };
      if (res.ok || (j && "error" in j)) return null; // no allocation
      throw new Error(`1inch API: HTTP ${res.status}`);
    }),
  },
  {
    id: "lido-early-2021",
    accepts: ["evm"],
    name: "Lido early stakers (LDO)",
    label: "Lido early-staker airdrop",
    symbol: "LDO",
    decimals: 18,
    claimAt: "the MerkleDistributor on Etherscan (claim, with your row from github.com/lidofinance/airdrop-data)",
    date: 1609783348, // Jan 4, 2021
    note: "Lido's January 2021 airdrop for early stETH holders has no deadline, and this address never claimed its LDO.",
    txUrl: "https://etherscan.io/address/0x4b3EDb22952Fb4A70140E39FB1adD05A6B49622B#writeContract",
    asset: (amount) => ({ symbol: "LDO", decimals: 18, amount, token: "0x5A98FcBEA516Cf06857215779Fd812CA3beF1B32", tokenChain: "ethereum" }),
    lookup: merkleDistributor(
      "0x4b3EDb22952Fb4A70140E39FB1adD05A6B49622B",
      lidoCsv("https://raw.githubusercontent.com/lidofinance/airdrop-data/main/early_stakers_airdrop.csv"),
    ),
  },
  {
    id: "lido-1inch-2021",
    accepts: ["evm"],
    name: "Lido × 1inch LPs (LDO)",
    label: "Lido airdrop for 1inch LPs",
    symbol: "LDO",
    decimals: 18,
    claimAt: "the MerkleDistributor on Etherscan (claim, with your row from github.com/lidofinance/airdrop-data)",
    date: 1614702071, // Mar 2, 2021
    note: "Lido's March 2021 airdrop for stETH liquidity providers on 1inch has no deadline, and this address never claimed its LDO.",
    txUrl: "https://etherscan.io/address/0xdB46C277dA1599390eAb394327602889E9546296#writeContract",
    asset: (amount) => ({ symbol: "LDO", decimals: 18, amount, token: "0x5A98FcBEA516Cf06857215779Fd812CA3beF1B32", tokenChain: "ethereum" }),
    lookup: merkleDistributor(
      "0xdB46C277dA1599390eAb394327602889E9546296",
      lidoCsv("https://raw.githubusercontent.com/lidofinance/airdrop-data/main/oneinch_lido_airdrop.csv"),
    ),
  },
  {
    id: "convex-2021",
    accepts: ["evm"],
    name: "Convex (CVX)",
    label: "Convex airdrop",
    symbol: "CVX",
    decimals: 18,
    claimAt: "the MerkleAirdrop on Etherscan (claim, with your proof from github.com/convex-eth/platform)",
    date: 1621246646, // May 17, 2021
    note: "Convex's May 2021 airdrop has no deadline, and this address never claimed its CVX.",
    txUrl: `https://etherscan.io/address/${CONVEX_AIRDROP}#writeContract`,
    asset: (amount) => ({ symbol: "CVX", decimals: 18, amount, token: "0x4e3FBD56CD56c3e72c1403e103b45Db9da5B9D2B", tokenChain: "ethereum" }),
    lookup: async (user) => {
      const amount = (await convexList())[user.toLowerCase()];
      if (!amount) return null;
      const claimed = await l1Client().readContract({
        address: CONVEX_AIRDROP,
        abi: parseAbi(["function hasClaimed(address) view returns (bool)"]),
        functionName: "hasClaimed",
        args: [user as Address],
      });
      return claimed ? { claimed: true } : { claimed: false, amount: BigInt(amount) };
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
      return {
        claimed: false,
        amount,
        note: `This wallet holds Sonic airdrop NFTs worth ${Number(formatUnits(amount, 18)).toLocaleString("en-US", { maximumFractionDigits: 2 })} S that were never unlocked. Unlock them before ${longDate(deadline)}: whatever is still locked then is burned.`,
      };
    },
  },
  {
    id: "dydx-2021",
    accepts: ["evm"],
    name: "dYdX (DYDX)",
    label: "dYdX rewards",
    symbol: "DYDX",
    decimals: 18,
    claimAt: "dydx.community (Claim rewards), from the eligible wallet",
    date: 1631059200, // Sep 8, 2021 (retroactive mining rewards; trading rewards until 2023)
    note: "dYdX's retroactive and trading rewards (2021–2023) have no deadline, and this address never claimed all of its DYDX.",
    txUrl: `https://etherscan.io/address/${DYDX_DISTRIBUTOR}`,
    asset: (amount) => ({ symbol: "DYDX", decimals: 18, amount, token: DYDX_TOKEN, tokenChain: "ethereum" }),
    lookup: dydxLookup,
  },
  {
    id: "cow-lgno-2022",
    accepts: ["evm"],
    name: "COW for locked GNO",
    label: "COW for locked GNO",
    symbol: "COW",
    decimals: 18,
    claimAt: "swap.cow.fi → Account (Locked GNO vesting), on Ethereum",
    date: 1644584715, // Feb 11, 2022 (start of the 4-year vesting)
    note: "GnosisDAO's COW for those who locked GNO in 2021 has been fully vested since February 2026, has no deadline, and this address never claimed it.",
    txUrl: "https://etherscan.io/address/0x64646f112FfD6F1B7533359CFaAF7998F23C8c40",
    asset: (amount) => ({ symbol: "COW", decimals: 18, amount, token: "0xDEf1CA1fb7FBcDC777520aa7f396b4E015F497aB", tokenChain: "ethereum" }),
    lookup: cowForLockedGno(1, "mainnet", "0x64646f112FfD6F1B7533359CFaAF7998F23C8c40", "0x68FFAaC7A431f276fe73604C127Bd78E49070c92"),
  },
  {
    id: "cow-lgno-gnosis-2022",
    accepts: ["evm"],
    name: "COW for locked GNO · Gnosis",
    label: "COW for locked GNO (Gnosis Chain)",
    symbol: "COW",
    decimals: 18,
    claimAt: "swap.cow.fi → Account (Locked GNO vesting), on Gnosis Chain",
    date: 1644584715, // Feb 11, 2022 (start of the 4-year vesting)
    note: "GnosisDAO's COW for those who locked GNO on Gnosis Chain in 2021 has been fully vested since February 2026, has no deadline, and this address never claimed it.",
    txUrl: "https://gnosisscan.io/address/0x48D8566887F8c7d99757CE29c2cD39962bfd9547",
    asset: (amount) => ({ symbol: "COW", decimals: 18, amount, token: "0x177127622c4A00F3d409B75571e12cB3c8973d3c", tokenChain: "xdai" }),
    lookup: cowForLockedGno(100, "gnosisChain", "0x48D8566887F8c7d99757CE29c2cD39962bfd9547", "0x3d610e917130f9D036e85A030596807f57e11093"),
  },
  {
    id: "avantis-2026",
    accepts: ["evm"],
    name: "Avantis (AVNT)",
    label: "Avantis Season 2 airdrop",
    symbol: "AVNT",
    decimals: 18,
    claimAt: "claimAirdrop() on the Avantis airdrop contract on Basescan (Write as Proxy), from the eligible wallet",
    date: 1772710200, // Mar 5, 2026
    note: "Avantis' Season 2 AVNT was never claimed by this wallet. The official claim window is over, but the tokens are still in the airdrop contract and claimable until Avantis takes them back: claim soon.",
    txUrl: `https://basescan.org/address/${AVANTIS_AIRDROP}#writeProxyContract`,
    asset: (amount) => ({ symbol: "AVNT", decimals: 18, amount, token: "0x696F9436B67233384889472Cd7cD58A6fB5DF4f1", tokenChain: "base" }),
    lookup: avantisLookup,
  },
  {
    id: "lombard-2026",
    accepts: ["evm"],
    name: "Lombard (BARD)",
    label: "Lombard BARD airdrop",
    symbol: "BARD",
    decimals: 18,
    claimAt: "claim.lombard.finance, before October 29, 2026",
    date: 1784879891, // Jul 24, 2026 (wave 4)
    note: "",
    txUrl: `https://etherscan.io/address/${BARD_DISTRIBUTOR}`,
    asset: (amount) => ({ symbol: "BARD", decimals: 18, amount, token: BARD_TOKEN, tokenChain: "ethereum" }),
    lookup: lombardLookup,
  },
  {
    id: "re-2026",
    accepts: ["evm"],
    name: "Re Protocol (RE)",
    label: "Re Protocol airdrop",
    symbol: "RE",
    decimals: 18,
    claimAt: "app.hedgey.finance/claim/431f05ff-38d0-4f86-a306-65d8d511d3c0, before July 1, 2027",
    date: 1781787600, // Jun 18, 2026
    note: "Re Protocol's RE airdrop (a Hedgey claim campaign) was never claimed by this address. It can be claimed until July 1, 2027.",
    txUrl: `https://etherscan.io/address/${HEDGEY_CAMPAIGNS}`,
    asset: (amount) => ({ symbol: "RE", decimals: 18, amount, token: "0x526526528F35AC738177003b8773B402B8Df8143", tokenChain: "ethereum" }),
    lookup: hedgeyCampaign(1, "0x431f05ff38d04f86a30665d8d511d3c0", 1814461200), // ends Jul 1, 2027, 17:00 UTC
  },
  {
    id: "doppler-2026",
    accepts: ["evm"],
    name: "Doppler Finance (XDP)",
    label: "Doppler Finance XDP airdrop",
    symbol: "XDP",
    decimals: 18,
    claimAt: "app.doppler.finance/airdrop, on Base, before November 28, 2026",
    date: 1790596740, // Sep 28, 2026
    note: "",
    txUrl: `https://basescan.org/address/${DOPPLER_AIRDROP}`,
    asset: (amount) => ({ symbol: "XDP", decimals: 18, amount, token: "0x07b3D902783c3C12b077508c3B5c00113d1291D0", tokenChain: "base" }),
    lookup: dopplerLookup,
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
          claimAt: a.claimAt,
          minUsd: AIRDROP_MIN_USD,
        }),
      );
    }),
  );
  return out;
}
