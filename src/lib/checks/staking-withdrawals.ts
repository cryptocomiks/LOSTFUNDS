import { encodeFunctionData, parseAbi, toEventSelector, type Address, type Hex, type PublicClient } from "viem";
import { l1Client } from "../clients";
import { addressTopic, getLogs } from "../explorer";
import { formatAmount } from "../format";
import { L1 } from "../networks";
import type { Asset, Finding, WithdrawalStatus } from "../types";
import { bulkRead } from "./bulk";
import { makeFinding, type CheckOutput, type FindingSource } from "./common";
import { DUST_ETHEREUM, dryRun, ETHERSCAN, rewardSource } from "./claims";

/**
 * Liquid staking withdrawals never claimed. Unstaking a liquid staking token for ETH takes two
 * steps everywhere: a request, then, days later, a claim that nobody sends for you. Until the
 * claim, the ETH waits in the protocol's withdrawal contract. In November 2026:
 *  - Mantle mETH: 339 finalized requests never claimed, 1,141 ETH;
 *  - Stader ETHx: about 200 among the last 1,500 requests, 264 ETH;
 *  - Frax frxETH: 125 matured redemption tickets, 146 ETH (some since 2024);
 *  - Swell swETH: 147 processed exit NFTs among the last 2,000;
 *  - Kelp rsETH: unlocked requests waiting for completeWithdrawal.
 * (Lido has its own check; ether.fi and Renzo had no finalized request left unclaimed.)
 * A finalized request is reported once its claim simulates from the address; one still in the
 * protocol's queue is shown as waiting.
 */

const ETH = (amount: bigint): Asset => ({ symbol: "ETH", decimals: 18, amount });
/** Requests read per protocol (the latest ones). */
const MAX_REQUESTS = 20;

interface Request {
  key: string;
  asset: Asset;
  ready: boolean;
  /** Unix seconds when a waiting request can be claimed, when the protocol says so. */
  readyAt?: number;
  /** The claim, sent by the user. */
  claim: { to: Address; data: Hex };
}

/** One protocol's findings: ready requests whose claim simulates, and waiting ones. */
async function findings(
  c: PublicClient,
  user: Address,
  src: FindingSource,
  p: { name: string; token: string; contract: Address; app: string; fn: string; appFr: string },
  requests: Request[],
): Promise<Finding[]> {
  const out = await Promise.all(
    requests.map(async (r): Promise<Finding | null> => {
      if (r.asset.amount === 0n) return null;
      if (r.ready && (await dryRun(c, { from: user, to: r.claim.to, data: r.claim.data })) === null) return null;
      const status: WithdrawalStatus = r.ready ? "ready" : "waiting";
      const amount = `${formatAmount(r.asset.amount, r.asset.decimals)} ${r.asset.symbol}`;
      const amountFr = `${formatAmount(r.asset.amount, r.asset.decimals, "fr")} ${r.asset.symbol}`;
      return makeFinding(src, {
        key: r.key,
        label: r.ready ? `${p.name}: withdrawal never claimed` : `${p.name}: withdrawal in the queue`,
        status,
        ...(r.readyAt && !r.ready && { readyAt: r.readyAt }),
        asset: r.asset,
        txHash: p.contract,
        txUrl: `${ETHERSCAN}/address/${p.contract}#writeProxyContract`,
        linkLabel: "View contract",
        timestamp: 0,
        claimAt: `${p.app}, or Etherscan (${p.fn})`,
        minUsd: DUST_ETHEREUM,
        note: r.ready
          ? `You asked ${p.name} to turn ${p.token} back into ${r.asset.symbol}, and the request is finalized: ${amount} wait in ${p.name}'s withdrawal contract. They are not sent automatically, you have to claim them.`
          : `You asked ${p.name} to turn ${p.token} back into ${r.asset.symbol}: about ${amount}, still in ${p.name}'s withdrawal queue. Once it is finalized, come back to claim it: it is not sent automatically.`,
        fr: {
          label: r.ready ? `${p.name} : retrait jamais réclamé` : `${p.name} : retrait dans la file d'attente`,
          claimAt: `${p.appFr}, ou Etherscan (${p.fn})`,
          linkLabel: "Voir le contrat",
          note: r.ready
            ? `Vous avez demandé à ${p.name} de reconvertir des ${p.token} en ${r.asset.symbol}, et la demande est finalisée : ${amountFr} attendent dans le contrat de retrait de ${p.name}. Ils ne sont pas envoyés automatiquement, c'est à vous de les réclamer.`
            : `Vous avez demandé à ${p.name} de reconvertir des ${p.token} en ${r.asset.symbol} : environ ${amountFr}, encore dans la file de retrait de ${p.name}. Une fois la demande finalisée, revenez la réclamer : rien n'est envoyé automatiquement.`,
        },
      });
    }),
  );
  return out.filter((f): f is Finding => f !== null);
}

/* ───────────────────────── Stader (ETHx) ───────────────────────── */

export const STADER = rewardSource("stader-withdrawals", "Stader withdrawals");
const STADER_MANAGER: Address = "0x9F0491B32DBce587c50c4C43AB303b06478193A7";
const staderAbi = parseAbi([
  "function getRequestIdsByUser(address) view returns (uint256[])",
  "function userWithdrawRequests(uint256) view returns (address owner, uint256 ethXAmount, uint256 ethExpected, uint256 ethFinalized, uint256 requestBlock)",
  "function nextRequestIdToFinalize() view returns (uint256)",
  "function claim(uint256 requestId)",
]);

export async function checkStader(user: Address): Promise<CheckOutput> {
  const c = l1Client();
  const ids = (await c.readContract({ address: STADER_MANAGER, abi: staderAbi, functionName: "getRequestIdsByUser", args: [user] })).slice(-MAX_REQUESTS);
  if (!ids.length) return { findings: [], completed: 0 };
  const [next, ...requests] = await Promise.all([
    c.readContract({ address: STADER_MANAGER, abi: staderAbi, functionName: "nextRequestIdToFinalize" }),
    ...ids.map((id) => c.readContract({ address: STADER_MANAGER, abi: staderAbi, functionName: "userWithdrawRequests", args: [id] })),
  ]);
  return {
    findings: await findings(
      c,
      user,
      STADER,
      { name: "Stader", token: "ETHx", contract: STADER_MANAGER, app: "staderlabs.com/eth (Withdrawals → Claim)", appFr: "staderlabs.com/eth (Withdrawals → Claim)", fn: "UserWithdrawalManager → claim" },
      ids.map((id, i) => {
        const [, , expected, finalized] = requests[i];
        const ready = id < next;
        return { key: `stader-${id}`, asset: ETH(ready ? finalized : expected), ready, claim: { to: STADER_MANAGER, data: encodeFunctionData({ abi: staderAbi, functionName: "claim", args: [id] }) } };
      }),
    ),
    completed: 0,
  };
}

/* ───────────────────────── Swell (swETH) ───────────────────────── */

export const SWELL = rewardSource("swell-withdrawals", "Swell withdrawals");
const SWEXIT: Address = "0x48C11b86807627AF70a34662D4865cF854251663";
const swellAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function tokenOfOwnerByIndex(address, uint256) view returns (uint256)",
  "function withdrawalRequests(uint256) view returns (uint256 amount, uint256 lastTokenIdProcessed, uint256 rateWhenCreated)",
  "function getProcessedRateForTokenId(uint256) view returns (bool isProcessed, uint256 processedRate)",
  "function finalizeWithdrawal(uint256 tokenId)",
]);

export async function checkSwell(user: Address): Promise<CheckOutput> {
  const c = l1Client();
  const count = Number(await c.readContract({ address: SWEXIT, abi: swellAbi, functionName: "balanceOf", args: [user] }));
  if (!count) return { findings: [], completed: 0 };
  const ids = await Promise.all(
    Array.from({ length: Math.min(count, MAX_REQUESTS) }, (_, i) => c.readContract({ address: SWEXIT, abi: swellAbi, functionName: "tokenOfOwnerByIndex", args: [user, BigInt(count - 1 - i)] })),
  );
  const requests = await Promise.all(
    ids.map((id) =>
      Promise.all([
        c.readContract({ address: SWEXIT, abi: swellAbi, functionName: "withdrawalRequests", args: [id] }),
        c.readContract({ address: SWEXIT, abi: swellAbi, functionName: "getProcessedRateForTokenId", args: [id] }),
      ]),
    ),
  );
  return {
    findings: await findings(
      c,
      user,
      SWELL,
      { name: "Swell", token: "swETH", contract: SWEXIT, app: "app.swellnetwork.io (Withdraw → Claim)", appFr: "app.swellnetwork.io (Withdraw → Claim)", fn: "swEXIT → finalizeWithdrawal" },
      ids.map((id, i) => {
        const [[amount, , rateWhenCreated], [processed, processedRate]] = requests[i];
        // Swell pays the lower of the rate at the request and the rate when it was processed.
        const rate = processed && processedRate < rateWhenCreated ? processedRate : rateWhenCreated;
        return { key: `swell-${id}`, asset: ETH((amount * rate) / 10n ** 18n), ready: processed, claim: { to: SWEXIT, data: encodeFunctionData({ abi: swellAbi, functionName: "finalizeWithdrawal", args: [id] }) } };
      }),
    ),
    completed: 0,
  };
}

/* ───────────────────────── Frax (frxETH) ───────────────────────── */

export const FRAX = rewardSource("frax-redemptions", "Frax redemptions");
const FRAX_QUEUE: Address = "0x82bA8da44Cd5261762e629dd5c605b17715727bd";
const fraxAbi = parseAbi([
  "function redemptionQueueState() view returns (uint64 nextNftId, uint64 queueLengthSecs, uint64 redemptionFee, uint64 earlyExitFee)",
  "function nftInformation(uint256) view returns (bool hasBeenRedeemed, uint64 maturity, uint120 amount, uint64 earlyExitFee)",
  "function ownerOf(uint256) view returns (address)",
  "function burnRedemptionTicketNft(uint256 nftId, address recipient)",
]);

export async function checkFrax(user: Address): Promise<CheckOutput> {
  const c = l1Client();
  // The tickets aren't enumerable by owner, and there are few (under 2,000): every ticket's state
  // in one multicall, then the owners of the ones not redeemed yet.
  const [next] = await c.readContract({ address: FRAX_QUEUE, abi: fraxAbi, functionName: "redemptionQueueState" });
  const all = Array.from({ length: Number(next) }, (_, i) => BigInt(i));
  const info = (await bulkRead(all.map((id) => ({ address: FRAX_QUEUE, abi: fraxAbi, functionName: "nftInformation", args: [id] })))) as (readonly [boolean, bigint, bigint, bigint])[];
  const open = all.filter((_, i) => !info[i][0] && info[i][2] > 0n);
  if (!open.length) return { findings: [], completed: 0 };
  const owners = (await bulkRead(open.map((id) => ({ address: FRAX_QUEUE, abi: fraxAbi, functionName: "ownerOf", args: [id] })))) as Address[];
  const mine = open.filter((_, i) => owners[i].toLowerCase() === user.toLowerCase()).slice(-MAX_REQUESTS);
  const now = BigInt(Math.floor(Date.now() / 1000));
  return {
    findings: await findings(
      c,
      user,
      FRAX,
      { name: "Frax", token: "frxETH", contract: FRAX_QUEUE, app: "app.frax.finance (frxETH → Redeem → Claim)", appFr: "app.frax.finance (frxETH → Redeem → Claim)", fn: "FraxEtherRedemptionQueue → burnRedemptionTicketNft" },
      mine.map((id) => {
        const [, maturity, amount] = info[Number(id)];
        return {
          key: `frax-${id}`,
          asset: ETH(amount),
          ready: maturity <= now,
          readyAt: Number(maturity),
          claim: { to: FRAX_QUEUE, data: encodeFunctionData({ abi: fraxAbi, functionName: "burnRedemptionTicketNft", args: [id, user] }) },
        };
      }),
    ),
    completed: 0,
  };
}

/* ───────────────────────── Mantle (mETH) ───────────────────────── */

export const METH = rewardSource("meth-withdrawals", "Mantle mETH withdrawals");
const METH_STAKING: Address = "0xe3cBd06D7dadB3F4e6557bAb7EdD924CD1489E8f";
const METH_REQUESTS: Address = "0x38fDF7b489316e03eD8754ad339cb5c4483FDcf9";
/** UnstakeRequestCreated(id indexed, requester indexed, mETHLocked, ethRequested, cumulativeETHRequested, blockNumber). */
const METH_CREATED = toEventSelector("UnstakeRequestCreated(uint256,address,uint256,uint256,uint256,uint256)");
const methAbi = parseAbi([
  "function requestByID(uint256) view returns ((uint64 blockNumber, address requester, uint128 id, uint128 mETHLocked, uint128 ethRequested, uint128 cumulativeETHRequested))",
  "function requestInfo(uint256) view returns (bool isFinalized, uint256 claimableAmount)",
  "function claimUnstakeRequest(uint256 unstakeRequestID)",
]);

export async function checkMeth(user: Address): Promise<CheckOutput> {
  // The requests an address made: their creation events (full-history search, by requester).
  const logs = await getLogs({ ...L1, noTimestamps: true }, METH_REQUESTS, [METH_CREATED, null, addressTopic(user)]);
  const ids = [...new Set(logs.map((l) => BigInt(l.topics[1])))].slice(-MAX_REQUESTS);
  if (!ids.length) return { findings: [], completed: 0 };
  const c = l1Client();
  const state = await Promise.all(
    ids.map((id) =>
      Promise.all([
        c.readContract({ address: METH_REQUESTS, abi: methAbi, functionName: "requestByID", args: [id] }),
        c.readContract({ address: METH_REQUESTS, abi: methAbi, functionName: "requestInfo", args: [id] }),
      ]),
    ),
  );
  // A claimed request is deleted: its requester reads as the zero address.
  const open = ids.map((id, i) => ({ id, request: state[i][0], info: state[i][1] })).filter((x) => x.request.requester.toLowerCase() === user.toLowerCase());
  return {
    findings: await findings(
      c,
      user,
      METH,
      { name: "Mantle mETH", token: "mETH", contract: METH_STAKING, app: "app.methprotocol.xyz (Unstake → Claim)", appFr: "app.methprotocol.xyz (Unstake → Claim)", fn: "Staking → claimUnstakeRequest" },
      open.map(({ id, request, info }) => ({
        key: `meth-${id}`,
        asset: ETH(info[0] && info[1] > 0n ? info[1] : request.ethRequested),
        ready: info[0],
        claim: { to: METH_STAKING, data: encodeFunctionData({ abi: methAbi, functionName: "claimUnstakeRequest", args: [id] }) },
      })),
    ),
    completed: ids.length - open.length,
  };
}

/* ───────────────────────── Kelp (rsETH) ───────────────────────── */

export const KELP = rewardSource("kelp-withdrawals", "Kelp withdrawals");
const KELP_MANAGER: Address = "0x62De59c08eB5dAE4b7E6F7a8cAd3006d6965ec16";
const KELP_ASSETS: { asset: Address; make: (amount: bigint) => Asset }[] = [
  { asset: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", make: ETH },
  { asset: "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84", make: (amount) => ({ symbol: "stETH", decimals: 18, amount, token: "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84", tokenChain: "ethereum" }) },
  { asset: "0xA35b1B31Ce002FBF2058D22F30f95D405200A15b", make: (amount) => ({ symbol: "ETHx", decimals: 18, amount, token: "0xA35b1B31Ce002FBF2058D22F30f95D405200A15b", tokenChain: "ethereum" }) },
];
const kelpAbi = parseAbi([
  "function userAssociatedNonces(address asset, address user) view returns (uint128 begin, uint128 end)",
  "function getUserWithdrawalRequest(address asset, address user, uint256 index) view returns (uint256 rsETHAmount, uint256 expectedAssetAmount, uint256 withdrawalStartBlock, uint256 userWithdrawalRequestNonce)",
  "function nextLockedNonce(address asset) view returns (uint256)",
  "function completeWithdrawal(address asset, string referralId)",
]);

export async function checkKelp(user: Address): Promise<CheckOutput> {
  const c = l1Client();
  const queues = await Promise.all(KELP_ASSETS.map((a) => c.readContract({ address: KELP_MANAGER, abi: kelpAbi, functionName: "userAssociatedNonces", args: [a.asset, user] })));
  const requests: Request[] = [];
  await Promise.all(
    KELP_ASSETS.map(async (a, i) => {
      const count = Math.min(Number(queues[i][1] - queues[i][0]), MAX_REQUESTS);
      if (count <= 0) return;
      const [nextLocked, ...list] = await Promise.all([
        c.readContract({ address: KELP_MANAGER, abi: kelpAbi, functionName: "nextLockedNonce", args: [a.asset] }),
        ...Array.from({ length: count }, (_, k) => c.readContract({ address: KELP_MANAGER, abi: kelpAbi, functionName: "getUserWithdrawalRequest", args: [a.asset, user, BigInt(k)] })),
      ]);
      // completeWithdrawal pays the oldest request of the asset, one request per call: the dry run
      // proves the first one, the contract's unlock mark (nextLockedNonce) says which others are ready.
      const claim = { to: KELP_MANAGER, data: encodeFunctionData({ abi: kelpAbi, functionName: "completeWithdrawal", args: [a.asset, ""] }) };
      for (const [, expected, , nonce] of list) requests.push({ key: `kelp-${a.asset}-${nonce}`, asset: a.make(expected), ready: nonce < nextLocked, claim });
    }),
  );
  return {
    findings: await findings(
      c,
      user,
      KELP,
      { name: "Kelp", token: "rsETH", contract: KELP_MANAGER, app: "kerneldao.com/kelp (Unstake → Claim)", appFr: "kerneldao.com/kelp (Unstake → Claim)", fn: "LRTWithdrawalManager → completeWithdrawal" },
      requests,
    ),
    completed: 0,
  };
}
