import { encodeFunctionData, parseAbi, toEventSelector, type Address } from "viem";
import { l1Client } from "../clients";
import { addressTopic, getLogs } from "../explorer";
import { formatAmount } from "../format";
import { L1 } from "../networks";
import type { Finding } from "../types";
import { makeFinding, type CheckOutput, type FindingSource } from "./common";
import { DUST_ETHEREUM, dryRun, ETHERSCAN } from "./claims";
import { LEGACY_GUIDE } from "./exchanges";

/**
 * Old Ethereum contracts that keep ETH for their users until they come and take it:
 *  - the CryptoPunks market (2017): ETH from punk sales and outbid offers waits in
 *    pendingWithdrawals, and an open bid keeps its ETH in the contract until withdrawn;
 *  - FoMo3D (2018, the long and quick games): winnings, dividends and referral rewards stay in
 *    each player's vault.
 * One view per contract (plus the punk bids the address entered, from their events); every
 * amount is reported once its withdrawal simulates from the address.
 */

export const CRYPTOPUNKS: FindingSource = { id: "cryptopunks-market", name: "CryptoPunks market", guideId: LEGACY_GUIDE, explorer: ETHERSCAN };
export const FOMO3D: FindingSource = { id: "fomo3d", name: "FoMo3D", guideId: LEGACY_GUIDE, explorer: ETHERSCAN };

const PUNKS: Address = "0xb47e3cd837dDF8e4c57F05d70Ab865de6e193BBB";
const PUNK_BID_ENTERED = toEventSelector("PunkBidEntered(uint256,uint256,address)");
const punksAbi = parseAbi([
  "function pendingWithdrawals(address) view returns (uint256)",
  "function punkBids(uint256) view returns (bool hasBid, uint256 punkIndex, address bidder, uint256 value)",
  "function withdraw()",
  "function withdrawBidForPunk(uint256 punkIndex)",
]);
const ETH = (amount: bigint) => ({ symbol: "ETH", decimals: 18, amount });
/** About a year of Ethereum blocks (12 s each). */
const BLOCKS_PER_YEAR = 2_628_000n;
/** Full-history event search on Ethereum's RPC nodes (the log timestamps aren't needed). */
const LOGS = { ...L1, noTimestamps: true };

export async function checkCryptoPunks(user: Address): Promise<CheckOutput> {
  const c = l1Client();
  const [pending, bidLogs, head] = await Promise.all([
    c.readContract({ address: PUNKS, abi: punksAbi, functionName: "pendingWithdrawals", args: [user] }),
    getLogs(LOGS, PUNKS, [PUNK_BID_ENTERED, null, addressTopic(user)]),
    c.getBlockNumber(),
  ]);
  const findings: Finding[] = [];
  const contractLink = { txHash: PUNKS, txUrl: `${ETHERSCAN}/address/${PUNKS}#writeContract`, linkLabel: "View contract", timestamp: 0, minUsd: DUST_ETHEREUM };
  if (pending > 0n && (await dryRun(c, { from: user, to: PUNKS, data: encodeFunctionData({ abi: punksAbi, functionName: "withdraw" }) })) !== null)
    findings.push(
      makeFinding(CRYPTOPUNKS, {
        key: "pending",
        label: "CryptoPunks: ETH never withdrawn",
        status: "ready",
        asset: ETH(pending),
        ...contractLink,
        claimAt: "Etherscan (CryptoPunksMarket → withdraw)",
        note: `${formatAmount(pending, 18)} ETH from punks this address sold, or offers it made that were outbid, wait in the CryptoPunks market contract. The market never sends them: withdraw() pays them out.`,
      }),
    );

  // Bids still open and entered over a year ago (a recent bid is an offer, not forgotten ETH): the
  // address's PunkBidEntered events, the latest per punk, then punkBids for each.
  const latest = new Map<bigint, bigint>();
  for (const l of bidLogs) {
    const index = BigInt(l.topics[1]);
    if ((latest.get(index) ?? -1n) < l.blockNumber) latest.set(index, l.blockNumber);
  }
  const indices = [...latest].filter(([, block]) => block < head - BLOCKS_PER_YEAR).map(([index]) => index);
  const bids = await Promise.all(indices.map((i) => c.readContract({ address: PUNKS, abi: punksAbi, functionName: "punkBids", args: [i] })));
  const open = indices.filter((_, k) => bids[k][0] && bids[k][2].toLowerCase() === user.toLowerCase());
  await Promise.all(
    open.map(async (index) => {
      const value = bids[indices.indexOf(index)][3];
      if (value === 0n) return;
      const ok = await dryRun(c, { from: user, to: PUNKS, data: encodeFunctionData({ abi: punksAbi, functionName: "withdrawBidForPunk", args: [index] }) });
      if (ok === null) return;
      findings.push(
        makeFinding(CRYPTOPUNKS, {
          key: `bid-${index}`,
          label: `CryptoPunks: open bid on punk #${index}`,
          status: "ready",
          asset: ETH(value),
          ...contractLink,
          claimAt: `Etherscan (CryptoPunksMarket → withdrawBidForPunk ${index})`,
          note: `This address has had a ${formatAmount(value, 18)} ETH bid open on punk #${index} for more than a year, and the ETH stays locked in the CryptoPunks market while it is open. Withdrawing the bid sends it back.`,
        }),
      );
    }),
  );
  return { findings, completed: 0 };
}

const FOMO_GAMES: { address: Address; name: string }[] = [
  { address: "0xA62142888ABa8370742bE823c1782D17A0389Da1", name: "FoMo3D" },
  { address: "0x4e8ecF79AdE5e2C49B9e30D795517A81e0Bf00B8", name: "FoMo3D Quick" },
];
const fomoAbi = parseAbi([
  "function pIDxAddr_(address) view returns (uint256)",
  "function getPlayerVaults(uint256 pID) view returns (uint256 win, uint256 gen, uint256 aff)",
  "function withdraw()",
]);

export async function checkFomo3d(user: Address): Promise<CheckOutput> {
  const c = l1Client();
  const ids = await Promise.all(FOMO_GAMES.map((g) => c.readContract({ address: g.address, abi: fomoAbi, functionName: "pIDxAddr_", args: [user] })));
  const findings: Finding[] = [];
  await Promise.all(
    FOMO_GAMES.map(async (g, i) => {
      if (ids[i] === 0n) return;
      const [win, gen, aff] = await c.readContract({ address: g.address, abi: fomoAbi, functionName: "getPlayerVaults", args: [ids[i]] });
      const total = win + gen + aff;
      if (total === 0n || (await dryRun(c, { from: user, to: g.address, data: encodeFunctionData({ abi: fomoAbi, functionName: "withdraw" }) })) === null) return;
      const parts = [
        [win, "winnings"],
        [gen, "key dividends"],
        [aff, "referral rewards"],
      ]
        .filter(([v]) => (v as bigint) > 0n)
        .map(([v, what]) => `${formatAmount(v as bigint, 18)} ETH of ${what}`);
      findings.push(
        makeFinding(FOMO3D, {
          key: g.name,
          label: `${g.name}: player vault`,
          status: "ready",
          asset: ETH(total),
          txHash: g.address,
          txUrl: `${ETHERSCAN}/address/${g.address}#writeContract`,
          linkLabel: "View contract",
          timestamp: 0,
          minUsd: DUST_ETHEREUM,
          claimAt: `Etherscan (${g.name} → withdraw)`,
          note: `Playing ${g.name} in 2018 left ${parts.join(", ")} in this address's player vault. It was never withdrawn: withdraw() sends all of it.`,
        }),
      );
    }),
  );
  return { findings, completed: 0 };
}
