import { decodeAbiParameters, encodeFunctionData, formatUnits, multicall3Abi, parseAbi, toEventSelector, zeroAddress, type Address, type Hex } from "viem";
import { l1Client } from "../clients";
import { addressTopic, getLogs } from "../explorer";
import { L1 } from "../networks";
import { ethAsset } from "../tokens";
import { bulkRead } from "./bulk";
import { makeFinding, type CheckOutput, type FindingSource } from "./common";
import { LEGACY_GUIDE } from "./exchanges";
import { wouldSucceed } from "./simulate";

/**
 * ETH locked in the deeds of ENS's first .eth registrar (the 2017–2019 auctions). Each name won at
 * auction has a Deed contract holding the price paid (or, if the auction was never finalized, the
 * whole bid). Since ENS moved .eth to its permanent registrar in May 2019, the old registrar lets a
 * deed's owner call releaseDeed(labelhash) at any time: the deed sends 100% of its ETH to its owner.
 * Today's ownership of the name isn't affected.
 *
 * Finding a wallet's deeds:
 *   - names it won: BidRevealed events, which carry the bidder as an indexed topic (status 2 = winning bid);
 *   - deeds moved to it with the registrar's transfer(): no event names the new owner, so they come
 *     from a snapshot published with the site (public/legacy/ens-deeds, 10,262 deeds as of Oct 1, 2026).
 *     Deeds can't be created anymore, so only later transfers could be missing from it.
 * Every candidate is then checked on-chain: the registrar's entry, the deed's owner and its balance.
 */

export const ENS_DEEDS: FindingSource = { id: "ens-deeds", name: "ENS auction deposits", guideId: LEGACY_GUIDE, explorer: "https://etherscan.io" };

const REGISTRAR: Address = "0x6090A6e47849629b7245Dfa1Ca21D94cd15878Ef";
const MULTICALL3: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";
const BID_REVEALED = toEventSelector("BidRevealed(bytes32,address,uint256,uint8)");
/** Registrar state of a name whose auction is over and that has an owner. */
const OWNED = 2;
const MIN_USD = 5;
/** Deeds shown one by one; the rest of a wallet's deeds are summed up in one more finding. */
const SHOWN = 10;
/** Releases simulated per wallet (the largest deeds); the others are proven by the same contract state. */
const SIMULATED = 5;

const registrarAbi = parseAbi([
  "function entries(bytes32) view returns (uint8 mode, address deed, uint256 registrationDate, uint256 value, uint256 highestBid)",
  "function releaseDeed(bytes32 hash)",
]);
const deedAbi = parseAbi(["function owner() view returns (address)"]);

/** Full-history event search on Ethereum's RPC nodes (the log timestamps aren't needed). */
const LOGS = { ...L1, noTimestamps: true };

/** Files published with the site, from anywhere the checks run (LOSTFUNDS_SITE overrides it outside a browser). */
const siteFile = (path: string) =>
  `${typeof window === "undefined" ? (typeof process !== "undefined" && process.env.LOSTFUNDS_SITE) || "https://lostfunds.vercel.app" : ""}${path}`;

async function movedDeeds(user: Address): Promise<Hex[]> {
  const me = user.toLowerCase();
  const res = await fetch(siteFile(`/legacy/ens-deeds/${me[2]}.json`), { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`ENS deeds list: HTTP ${res.status}`);
  return ((await res.json()) as Record<string, Hex[]>)[me] ?? [];
}

async function wonNames(user: Address): Promise<Hex[]> {
  const logs = await getLogs(LOGS, REGISTRAR, [BID_REVEALED, null, addressTopic(user)]);
  return logs
    .filter((l) => decodeAbiParameters([{ type: "uint256" }, { type: "uint8" }], l.data)[1] === 2)
    .map((l) => l.topics[1]);
}

export async function checkEnsDeeds(user: Address): Promise<CheckOutput> {
  const hashes = [...new Set((await Promise.all([wonNames(user), movedDeeds(user)])).flat().map((h) => h.toLowerCase() as Hex))];
  if (!hashes.length) return { findings: [], completed: 0 };

  // The registrar's entry of each name, then each deed's owner and balance (one eth_call each for most wallets).
  const entries = (await bulkRead(hashes.map((h) => ({ address: REGISTRAR, abi: registrarAbi, functionName: "entries", args: [h] })))) as (readonly [
    number,
    Address,
    bigint,
    bigint,
    bigint,
  ])[];
  const live = hashes.map((hash, i) => ({ hash, mode: entries[i][0], deed: entries[i][1], registered: Number(entries[i][2]) })).filter((e) => e.deed !== zeroAddress);
  if (!live.length) return { findings: [], completed: 0 };

  const state = await bulkRead(
    live.flatMap((e) => [
      { address: e.deed, abi: deedAbi, functionName: "owner" },
      { address: MULTICALL3, abi: multicall3Abi, functionName: "getEthBalance", args: [e.deed] },
    ]),
  );
  const mine = live
    .map((e, i) => ({ ...e, owner: state[i * 2] as Address, balance: state[i * 2 + 1] as bigint }))
    .filter((e) => e.owner.toLowerCase() === user.toLowerCase() && e.mode === OWNED && e.balance > 0n)
    .sort((a, b) => (b.balance > a.balance ? 1 : b.balance < a.balance ? -1 : 0));
  if (!mine.length) return { findings: [], completed: 0 };

  // Only the largest releases are simulated: the others rest on the same registrar and deed state.
  // A contract wallet may not accept the refund (the deed sends it with a fixed 2,300 gas and doesn't
  // revert if that fails), so for one the release can't be proven safe.
  const c = l1Client();
  const [code, ...simulated] = await Promise.all([
    c.getCode({ address: user }),
    ...mine.slice(0, SIMULATED).map((e) =>
      wouldSucceed(c, { from: user, to: REGISTRAR, data: encodeFunctionData({ abi: registrarAbi, functionName: "releaseDeed", args: [e.hash] }) }),
    ),
  ]);
  if (simulated.some((ok) => !ok)) {
    // The registrar refused one of them: report only the deeds whose release was simulated.
    mine.splice(0, mine.length, ...mine.slice(0, SIMULATED).filter((_, i) => simulated[i]));
    if (!mine.length) return { findings: [], completed: 0 };
  }
  const contractWallet = !!code && code !== "0x";
  const status = contractWallet ? ("manual" as const) : ("ready" as const);
  const wallet = contractWallet
    ? " This address runs smart-contract code (a contract wallet, or an EIP-7702 account): the deed sends the ETH with a fixed gas allowance that some of these can't receive, so check that yours can before releasing."
    : "";
  const findings = mine.slice(0, mine.length > SHOWN ? SHOWN - 1 : SHOWN).map((e) =>
    makeFinding(ENS_DEEDS, {
      key: e.hash,
      label: "ENS auction deposit",
      status,
      asset: ethAsset(e.balance),
      txHash: e.deed,
      txUrl: `https://etherscan.io/address/${REGISTRAR}#writeContract`,
      linkLabel: "Open the registrar",
      timestamp: e.registered,
      dateLabel: "Registered",
      note: `This ETH paid for a .eth name in ENS's 2017–2019 auctions is still locked in the name's deed. Since 2019 the deed's owner can take it all back at any time, without affecting the name: on Etherscan, call releaseDeed on the old registrar with hash ${e.hash}.${wallet}`,
      claimAt: `Etherscan → Write Contract → releaseDeed, on ${REGISTRAR}`,
      minUsd: MIN_USD,
    }),
  );
  if (mine.length > SHOWN) {
    const rest = mine.slice(SHOWN - 1);
    const total = rest.reduce((s, e) => s + e.balance, 0n);
    findings.push(
      makeFinding(ENS_DEEDS, {
        key: "more",
        label: `ENS auction deposits (${rest.length} more names)`,
        status,
        asset: ethAsset(total),
        txHash: REGISTRAR,
        txUrl: `https://etherscan.io/address/${REGISTRAR}#writeContract`,
        linkLabel: "Open the registrar",
        timestamp: 0,
        note: `${rest.length} more deeds from the 2017–2019 auctions are owned by this address, holding ${Number(formatUnits(total, 18)).toLocaleString("en-US", { maximumFractionDigits: 4 })} ETH in all. Release each one with releaseDeed on the old registrar, with the name's hash: the keccak256 of its label (of "vitalik" for vitalik.eth).${wallet}`,
        claimAt: `Etherscan → Write Contract → releaseDeed, on ${REGISTRAR}`,
        minUsd: MIN_USD,
      }),
    );
  }
  return { findings, completed: 0 };
}
