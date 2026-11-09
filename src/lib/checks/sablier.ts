import { parseAbi, type Address } from "viem";
import { EVM_CHAINS, evmChain, evmClient } from "../evm";
import { formatAmount } from "../format";
import { addPrices } from "../tokens";
import type { Asset, Finding } from "../types";
import { makeFinding, type CheckOutput } from "./common";
import { DUST_ETHEREUM, DUST_L2, rewardSource } from "./claims";

/**
 * Sablier Lockup streams (vesting, payroll, airdrops that vest) whose recipient is the address:
 * tokens that have vested but were never withdrawn stay in the Lockup contract, and nothing sends
 * them. Sablier's public indexer (every chain and Lockup version in one GraphQL query) lists the
 * address's streams that still hold tokens; each is then read on its own chain
 * (withdrawableAmountOf, and ownerOf: the stream NFT can have been transferred). Only tokens with
 * a market price are shown, so spam streams are left out. Chains without a public RPC in
 * src/lib/evm.ts are skipped.
 */

export const SABLIER = rewardSource("sablier-streams", "Sablier streams");

const INDEXER = "https://indexer.hyperindex.xyz/53b7e25/v1/graphql";
/** More streams than this for one address: only the largest ones are read. */
const MAX_STREAMS = 100;

const lockupAbi = parseAbi(["function withdrawableAmountOf(uint256 streamId) view returns (uint128)", "function ownerOf(uint256 tokenId) view returns (address)"]);

interface Stream {
  /** Sablier's own stream id, e.g. "LL2-137-29" (alias of the contract, chain, stream). */
  alias?: string;
  chainId: string;
  tokenId: string;
  contract: Address;
  version: string;
  endTime: string;
  asset: { address: Address; symbol: string; decimals: string };
}

export async function sablierStreams(user: Address): Promise<Stream[]> {
  const query = `{ LockupStream(limit: ${MAX_STREAMS}, order_by: {depositAmount: desc}, where: {recipient: {_eq: "${user.toLowerCase()}"}, depleted: {_eq: false}, chainId: {_in: [${EVM_CHAINS.map((c) => `"${c.id}"`).join(",")}]}}) { alias chainId tokenId contract version endTime asset { address symbol decimals } } }`;
  const res = await fetch(INDEXER, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Sablier indexer: HTTP ${res.status}`);
  const json = (await res.json()) as { data?: { LockupStream: Stream[] }; errors?: { message: string }[] };
  if (!json.data) throw new Error(`Sablier indexer: ${json.errors?.[0]?.message ?? "no data"}`);
  return json.data.LockupStream;
}

export async function checkSablier(user: Address): Promise<CheckOutput> {
  const streams = (await sablierStreams(user)).filter((s) => evmClient(Number(s.chainId)));
  if (!streams.length) return { findings: [], completed: 0 };

  const reads = await Promise.allSettled(
    streams.map(async (s) => {
      const c = evmClient(Number(s.chainId))!;
      const id = BigInt(s.tokenId);
      const [withdrawable, owner] = await Promise.all([
        c.readContract({ address: s.contract, abi: lockupAbi, functionName: "withdrawableAmountOf", args: [id] }),
        c.readContract({ address: s.contract, abi: lockupAbi, functionName: "ownerOf", args: [id] }),
      ]);
      return owner.toLowerCase() === user.toLowerCase() ? withdrawable : 0n;
    }),
  );
  const failed = reads.filter((r) => r.status === "rejected").length;
  if (failed === streams.length) throw (reads[0] as PromiseRejectedResult).reason;

  const candidates = streams
    .map((s, i) => ({ s, amount: reads[i].status === "fulfilled" ? (reads[i] as PromiseFulfilledResult<bigint>).value : 0n }))
    .filter((x) => x.amount > 0n);
  const assets: Asset[] = candidates.map(({ s, amount }) => ({
    symbol: s.asset.symbol,
    decimals: Number(s.asset.decimals),
    amount,
    token: s.asset.address,
    tokenChain: evmChain(Number(s.chainId))!.llama,
  }));
  await addPrices(assets);

  const findings: Finding[] = [];
  candidates.forEach(({ s }, i) => {
    const asset = assets[i];
    if (asset.usd === undefined) return; // no market price: spam or worthless token
    const chainId = Number(s.chainId);
    const chain = evmChain(chainId)!;
    const ended = Number(s.endTime) * 1000 < Date.now();
    findings.push(
      makeFinding(SABLIER, {
        key: `${chainId}:${s.contract}:${s.tokenId}`,
        label: `Sablier stream #${s.tokenId} · ${chain.name}`,
        status: "ready",
        asset,
        txHash: s.contract,
        txUrl: `https://app.sablier.com/vesting/stream/${s.alias || `${s.contract}-${chainId}-${s.tokenId}`}`,
        linkLabel: "View stream",
        timestamp: 0,
        claimAt: "app.sablier.com (connect, open the stream, Withdraw)",
        minUsd: chainId === 1 ? DUST_ETHEREUM : DUST_L2,
        note: `${formatAmount(asset.amount, asset.decimals)} ${asset.symbol} streamed to this address on Sablier (${chain.name}) have vested and were never withdrawn.${ended ? " The stream has ended: everything left in it is yours to withdraw." : " The rest keeps vesting."}`,
      }),
    );
  });
  return { findings, completed: 0, ...(failed && { error: `${failed} of ${streams.length} Sablier streams could not be read.` }) };
}
