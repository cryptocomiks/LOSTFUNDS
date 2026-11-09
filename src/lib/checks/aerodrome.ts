import { encodeFunctionData, parseAbi, type Address, type PublicClient } from "viem";
import { evmClient } from "../evm";
import { formatAmount } from "../format";
import type { Asset, Finding } from "../types";
import { makeFinding, type CheckOutput } from "./common";
import { DUST_L2, dryRun, rewardSource } from "./claims";

/**
 * Aerodrome (Base) and Velodrome (OP Mainnet) vote-escrow locks (veAERO, veVELO NFTs):
 *  - an expired lock gives nothing back by itself: its AERO / VELO stays in the escrow until the
 *    owner withdraws it (about 16,000 expired veAERO and 3,600 veVELO locks never withdrawn in
 *    November 2026, from a sample);
 *  - rebases (the anti-dilution emissions) pile up in the RewardsDistributor until claimed.
 * The address's veNFTs (balanceOf + ownerToNFTokenIdList), their locks, votes and claimable
 * rebases, one multicall per chain; an expired lock is reported once its withdrawal simulates
 * (after resetting its votes in the same simulated block when it still has some), a rebase once
 * its claim does.
 */

export const VE_DEX = rewardSource("aerodrome-velodrome", "Aerodrome & Velodrome");

const DEXES: { name: string; chainId: number; chain: string; symbol: string; token: Address; tokenChain: string; escrow: Address; distributor: Address; voter: Address; app: string; explorer: string }[] = [
  {
    name: "Aerodrome",
    chainId: 8453,
    chain: "Base",
    symbol: "AERO",
    token: "0x940181a94A35A4569E4529A3CDfB74e38FD98631",
    tokenChain: "base",
    escrow: "0xeBf418Fe2512e7E6bd9b87a8F0f294aCDC67e6B4",
    distributor: "0x227f65131A261548b057215bB1D5Ab2997964C7d",
    voter: "0x16613524e02ad97eDfeF371bC883F2F5d6C480A5",
    app: "aerodrome.finance/dash",
    explorer: "https://basescan.org",
  },
  {
    name: "Velodrome",
    chainId: 10,
    chain: "OP Mainnet",
    symbol: "VELO",
    token: "0x9560e827aF36c94D2Ac33a39bCE1Fe78631088Db",
    tokenChain: "optimism",
    escrow: "0xFAf8FD17D9840595845582fCB047DF13f006787d",
    distributor: "0x9D4736EC60715e71aFe72973f7885DCBC21EA99b",
    voter: "0x41C914ee0c7E1A5edCD0295623e6dC557B5aBf3C",
    app: "velodrome.finance/dash",
    explorer: "https://optimistic.etherscan.io",
  },
];
/** More veNFTs than this in one wallet: only the first ones are read. */
const MAX_NFTS = 50;

const escrowAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function ownerToNFTokenIdList(address, uint256) view returns (uint256)",
  "function locked(uint256) view returns ((int128 amount, uint256 end, bool isPermanent))",
  "function voted(uint256) view returns (bool)",
  "function withdraw(uint256 tokenId)",
]);
const distributorAbi = parseAbi(["function claimable(uint256 tokenId) view returns (uint256)", "function claim(uint256 tokenId) returns (uint256)"]);
const voterAbi = parseAbi(["function reset(uint256 tokenId)"]);

/** Votes reset, then the withdrawal, in one simulated block. Null if rejected or the nodes can't simulate blocks. */
async function resetAndWithdraw(c: PublicClient, user: Address, dex: (typeof DEXES)[number], id: bigint): Promise<boolean> {
  try {
    const [block] = await c.simulateBlocks({
      blocks: [
        {
          calls: [
            { account: user, to: dex.voter, data: encodeFunctionData({ abi: voterAbi, functionName: "reset", args: [id] }) },
            { account: user, to: dex.escrow, data: encodeFunctionData({ abi: escrowAbi, functionName: "withdraw", args: [id] }) },
          ],
        },
      ],
    });
    return block.calls.every((x) => x.status === "success");
  } catch {
    return false;
  }
}

async function checkDex(dex: (typeof DEXES)[number], user: Address): Promise<Finding[]> {
  const c = evmClient(dex.chainId)!;
  const n = await c.readContract({ address: dex.escrow, abi: escrowAbi, functionName: "balanceOf", args: [user] });
  if (n === 0n) return [];
  const ids = await Promise.all(
    Array.from({ length: Math.min(Number(n), MAX_NFTS) }, (_, i) => c.readContract({ address: dex.escrow, abi: escrowAbi, functionName: "ownerToNFTokenIdList", args: [user, BigInt(i)] })),
  );
  const now = BigInt(Math.floor(Date.now() / 1000));
  const asset = (amount: bigint): Asset => ({ symbol: dex.symbol, decimals: 18, amount, token: dex.token, tokenChain: dex.tokenChain });
  const out: Finding[] = [];
  await Promise.all(
    ids.map(async (id) => {
      const [lock, voted, rebase] = await Promise.all([
        c.readContract({ address: dex.escrow, abi: escrowAbi, functionName: "locked", args: [id] }),
        c.readContract({ address: dex.escrow, abi: escrowAbi, functionName: "voted", args: [id] }),
        c.readContract({ address: dex.distributor, abi: distributorAbi, functionName: "claimable", args: [id] }),
      ]);
      const expired = !lock.isPermanent && lock.amount > 0n && lock.end < now;
      const common = { timestamp: 0, minUsd: DUST_L2, claimAt: dex.app, linkLabel: "View veNFT" };
      const url = `${dex.explorer}/nft/${dex.escrow}/${id}`;
      if (expired) {
        const ok = voted
          ? await resetAndWithdraw(c, user, dex, id)
          : (await dryRun(c, { from: user, to: dex.escrow, data: encodeFunctionData({ abi: escrowAbi, functionName: "withdraw", args: [id] }) })) !== null;
        if (ok)
          out.push(
            makeFinding(VE_DEX, {
              key: `${dex.name}:lock:${id}`,
              label: `${dex.name}: expired lock #${id}`,
              status: "ready",
              asset: asset(BigInt(lock.amount)),
              txHash: dex.escrow,
              txUrl: url,
              ...common,
              dateLabel: "Lock ended",
              note:
                `Your ve${dex.symbol} #${id} on ${dex.name} (${dex.chain}) expired, but its ${formatAmount(BigInt(lock.amount), 18)} ${dex.symbol} stay locked in the escrow until you withdraw them.` +
                (voted ? " It still has votes: reset them first (the app does both)." : ""),
            }),
          );
      }
      if (rebase > 0n && (await dryRun(c, { from: user, to: dex.distributor, data: encodeFunctionData({ abi: distributorAbi, functionName: "claim", args: [id] }) })) !== null)
        out.push(
          makeFinding(VE_DEX, {
            key: `${dex.name}:rebase:${id}`,
            label: `${dex.name}: rebases of veNFT #${id}`,
            status: "ready",
            asset: asset(rebase),
            txHash: dex.distributor,
            txUrl: url,
            ...common,
            note: `Your ve${dex.symbol} #${id} on ${dex.name} (${dex.chain}) earned ${formatAmount(rebase, 18)} ${dex.symbol} of rebases that were never claimed.${expired ? " As the lock has expired, claiming sends them straight to your wallet." : ""}`,
          }),
        );
    }),
  );
  return out;
}

export async function checkVeDex(user: Address): Promise<CheckOutput> {
  const results = await Promise.allSettled(DEXES.map((d) => checkDex(d, user)));
  const failed = results.flatMap((r, i) => (r.status === "rejected" ? [`${DEXES[i].name}: ${String((r.reason as Error)?.message ?? r.reason).split("\n")[0]}`] : []));
  if (failed.length === DEXES.length) throw new Error(failed.join(" · "));
  return { findings: results.flatMap((r) => (r.status === "fulfilled" ? r.value : [])), completed: 0, ...(failed.length && { error: failed.join(" · ") }) };
}
