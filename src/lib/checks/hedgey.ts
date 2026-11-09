import { decodeAbiParameters, encodeFunctionData, parseAbi, toEventSelector, type Address, type Hex, type PublicClient } from "viem";
import { l1Client, l2Client } from "../clients";
import { evmChain } from "../evm";
import { getLogs, type ExplorerTarget } from "../explorer";
import { formatAmount } from "../format";
import { L1, NETWORKS } from "../networks";
import { addPrices, mapLimit, tokenMeta } from "../tokens";
import type { Asset, Finding } from "../types";
import { makeFinding, now, type CheckOutput, type FindingSource } from "./common";

/**
 * Every claim campaign run on Hedgey (airdrops, grants, community distributions), on Ethereum,
 * OP Mainnet, Base and Arbitrum. Hedgey's ClaimCampaigns contract (same address on each chain)
 * announces each campaign with an event; the ones still open (end in the future, tokens left)
 * are asked for the address's proof from Hedgey's public API, then the claim is dry-run from the
 * address. Only tokens with a market price are shown. Campaigns already in the airdrop list
 * (checks/airdrops.ts) are left out here.
 */

export const HEDGEY: FindingSource = { id: "hedgey-claims", name: "Hedgey claims", guideId: "airdrops" };

const CLAIM_CAMPAIGNS: Address = "0x8A2725a6f04816A5274dDD9FEaDd3bd0C253C1A6";
const CAMPAIGN_STARTED = toEventSelector("CampaignStarted(bytes16,(address,address,uint256,uint256,uint256,uint8,bytes32,bool),uint256)");
const CAMPAIGN = { type: "tuple", components: ["address", "address", "uint256", "uint256", "uint256", "uint8", "bytes32", "bool"].map((type) => ({ type })) } as const;
/** Campaigns with their own entry in the airdrop list. */
const LISTED = new Set(["0x431f05ff38d04f86a30665d8d511d3c0"]);
/** Proof requests to Hedgey at once. */
const CONCURRENCY = 6;

const abi = parseAbi([
  "function campaigns(bytes16) view returns (address manager, address token, uint256 amount, uint256 start, uint256 end, uint8 tokenLockup, bytes32 root, bool delegating)",
  "function claimed(bytes16, address) view returns (bool)",
  "function claim(bytes16 campaignId, bytes32[] proof, uint256 claimAmount)",
]);

const net = (id: string) => NETWORKS.find((n) => n.id === id)!;
const CHAINS: { name: string; chainId: number; logs: ExplorerTarget & { noTimestamps: true }; client: () => PublicClient; explorer: string }[] = [
  { name: "Ethereum", chainId: 1, logs: { ...L1, noTimestamps: true }, client: l1Client, explorer: "https://etherscan.io" },
  { name: "OP Mainnet", chainId: 10, logs: { ...net("optimism"), noTimestamps: true }, client: () => l2Client(net("optimism")), explorer: "https://optimistic.etherscan.io" },
  { name: "Base", chainId: 8453, logs: { ...net("base"), noTimestamps: true }, client: () => l2Client(net("base")), explorer: "https://basescan.org" },
  { name: "Arbitrum", chainId: 42161, logs: { ...net("arbitrum"), noTimestamps: true }, client: () => l2Client(net("arbitrum")), explorer: "https://arbiscan.io" },
];

const uuidOf = (id: Hex) => `${id.slice(2, 10)}-${id.slice(10, 14)}-${id.slice(14, 18)}-${id.slice(18, 22)}-${id.slice(22, 34)}`;

async function checkChain(chain: (typeof CHAINS)[number], user: Address): Promise<Finding[]> {
  const t = now();
  const logs = await getLogs(chain.logs, CLAIM_CAMPAIGNS, [CAMPAIGN_STARTED]);
  const ids = [
    ...new Set(
      logs
        .filter((l) => Number((decodeAbiParameters([CAMPAIGN, { type: "uint256" }], l.data)[0] as readonly unknown[])[4]) > t)
        .map((l) => l.topics[1].slice(0, 34).toLowerCase() as Hex),
    ),
  ].filter((id) => !LISTED.has(id));
  if (!ids.length) return [];

  const c = chain.client();
  const live = await Promise.all(ids.map((id) => c.readContract({ address: CLAIM_CAMPAIGNS, abi, functionName: "campaigns", args: [id] })));
  const open = ids.map((id, i) => ({ id, token: live[i][1], left: live[i][2], end: Number(live[i][4]) })).filter((x) => x.left > 0n && x.end > t);

  const proofs = await mapLimit(open, CONCURRENCY, async (x) => {
    const res = await fetch(`https://api.hedgey.finance/token-claims/proof/${uuidOf(x.id)}/${user}`, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`Hedgey API: HTTP ${res.status}`);
    const j = (await res.json()) as { amount?: string; proof?: Hex[] };
    return j.amount && j.proof ? { amount: BigInt(j.amount), proof: j.proof } : null;
  });
  const eligible = open.map((x, i) => ({ ...x, p: proofs[i] })).filter((x): x is typeof x & { p: { amount: bigint; proof: Hex[] } } => !!x.p && x.left >= x.p.amount);
  if (!eligible.length) return [];

  const out: Finding[] = [];
  await Promise.all(
    eligible.map(async (x) => {
      const claimed = await c.readContract({ address: CLAIM_CAMPAIGNS, abi, functionName: "claimed", args: [x.id, user] });
      if (claimed) return;
      const data = encodeFunctionData({ abi, functionName: "claim", args: [x.id, x.p.proof, x.p.amount] });
      try {
        await c.call({ account: user, to: CLAIM_CAMPAIGNS, data, gas: 3_000_000n });
      } catch {
        return;
      }
      const meta = await tokenMeta([c], x.token);
      if (!meta) return;
      const asset: Asset = { symbol: meta.symbol, decimals: meta.decimals, amount: x.p.amount, token: x.token, tokenChain: evmChain(chain.chainId)?.llama ?? "ethereum" };
      await addPrices([asset]);
      if (asset.usd === undefined) return; // no market price: worthless or spam token
      const end = new Date(x.end * 1000).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
      out.push(
        makeFinding(HEDGEY, {
          key: `${chain.chainId}:${x.id}`,
          label: `Hedgey claim · ${meta.symbol} · ${chain.name}`,
          status: "ready",
          asset,
          txHash: CLAIM_CAMPAIGNS,
          txUrl: `https://app.hedgey.finance/claim/${uuidOf(x.id)}`,
          linkLabel: "Open the claim page",
          timestamp: 0,
          claimAt: `app.hedgey.finance/claim/${uuidOf(x.id)}, before ${end}`,
          minUsd: 2,
          note: `This address can claim ${formatAmount(x.p.amount, meta.decimals)} ${meta.symbol} from a Hedgey claim campaign on ${chain.name} (an airdrop or distribution by the token's team). It was never claimed, and the campaign closes on ${end}.`,
        }),
      );
    }),
  );
  return out;
}

export async function checkHedgey(user: Address): Promise<CheckOutput> {
  const results = await Promise.allSettled(CHAINS.map((chain) => checkChain(chain, user)));
  const failed = results.flatMap((r, i) => (r.status === "rejected" ? [`${CHAINS[i].name}: ${String((r.reason as Error)?.message ?? r.reason).split("\n")[0]}`] : []));
  if (failed.length === CHAINS.length) throw new Error(failed.join(" · "));
  return { findings: results.flatMap((r) => (r.status === "fulfilled" ? r.value : [])), completed: 0, ...(failed.length && { error: failed.join(" · ") }) };
}
