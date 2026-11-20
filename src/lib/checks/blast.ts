import { bytesToHex, concat, encodeAbiParameters, encodeFunctionData, encodePacked, keccak256, parseAbi, type Address, type Hex } from "viem";
import { l1Client } from "../clients";
import { formatAmount } from "../format";
import type { Finding } from "../types";
import { makeFinding, type CheckOutput, type FindingSource } from "./common";
import { DUST_ETHEREUM, dryRun, ETHERSCAN } from "./claims";

/**
 * Blast shut down on November 4, 2026. What its users still had there (ETH, WETH and USDB
 * balances, and withdrawals to Ethereum never finished) is paid by two recovery contracts on
 * Ethereum, in ETH and DAI, to whoever proves their line of Blast's final list (2.2 million
 * accounts). Blast's claim page (blast.io, static files with open CORS) publishes the list by
 * address prefix and the Merkle trees in chunks.
 *
 * Per address and contract: the shard for the address (most stop there), then claimed(user)
 * on-chain, the tree chunk holding the proof (checked here against the tree's root, as Blast's
 * page does), and a dry run of claim() from the user.
 */

export const BLAST: FindingSource = { id: "blast", name: "Blast (shut down)", guideId: "blast", explorer: ETHERSCAN };

export const BLAST_RECOVERY: { id: string; address: Address; what: string; whatFr: string }[] = [
  {
    id: "contract-1",
    address: "0x9D31771458B421C7EA8A06CB8D12663E91617869",
    what: "the balance this address had on Blast",
    whatFr: "le solde que cette adresse avait sur Blast",
  },
  {
    id: "contract-2",
    address: "0x23eA8c6ACEb5673BBd712137cE2Aa33db36CB513",
    what: "withdrawals from Blast to Ethereum that were never finished",
    whatFr: "les retraits de Blast vers Ethereum jamais terminés",
  },
];
const DATA = "https://blast.io/claims";
const DAI: Address = "0x6B175474E89094C44Da98b954EedeAC495271d0F";

const abi = parseAbi([
  "function claimed(address user) view returns (bool)",
  "function claim(address user, uint256 ethAmount, uint256 usdAmount, address[] _redeemers, bytes32[] proof, bytes32 root)",
]);

interface Manifest {
  version: number;
  shardPrefixLength: number;
  chunkDepth: number;
  trees: { root: Hex; leaves: number }[];
}
/** A line of a shard: ETH (wei), USD (18 decimals, paid in DAI), tree, node of the leaf, approved redeemers. */
type Entry = [eth: string, usd: string, tree: number, node: number, redeemers?: Address[], pendingWithdrawals?: number];

async function json<T>(url: string, missing: T): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  // A missing file is a 404 page (GitHub Pages): nobody in that shard.
  if (res.status === 404 || (res.ok && !(res.headers.get("content-type") ?? "").includes("json"))) return missing;
  if (!res.ok) throw new Error(`Blast claim data: HTTP ${res.status}`);
  return (await res.json()) as T;
}

/* The trees are stored as heaps (node 0 is the root), cut in chunks: the top `depth` levels, then one subtree per chunk. */
const depthOf = (node: number) => 31 - Math.clz32(node + 1);
/** The chunk a node's proof lives in: its ancestor at the chunk depth. */
export function chunkOf(node: number, depth: number): number {
  while (depthOf(node) > depth) node = (node - 1) >> 1;
  return node - (2 ** depth - 1);
}
/** Position of a node's hash in its chunk file (Blast's layout: the shared top levels, then the chunk's subtree level by level). */
export function slotOf(node: number, chunk: number, depth: number, nodes: number): number {
  const top = Math.min(2 ** (depth + 1) - 1, nodes);
  const d = depthOf(node);
  if (d <= depth) return node;
  const subtreeRoot = 2 ** depth - 1 + chunk;
  let slot = top;
  for (let level = 1; level < d - depth; level++) {
    const first = (subtreeRoot + 1) * 2 ** level - 1;
    slot += Math.max(0, Math.min(nodes, first + 2 ** level) - first);
  }
  const first = (subtreeRoot + 1) * 2 ** (d - depth) - 1;
  if (node < first || node >= first + 2 ** (d - depth)) throw new Error(`Blast claim data: node ${node} is not in chunk ${chunk}`);
  return slot + (node - first);
}
const pair = (a: Hex, b: Hex) => keccak256(concat(a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a]));
export const blastLeaf = (user: Address, eth: bigint, usd: bigint, redeemers: Address[]) =>
  keccak256(
    keccak256(
      encodeAbiParameters(
        [{ type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes32" }],
        [user, eth, usd, keccak256(encodePacked(["address[]"], [redeemers]))],
      ),
    ),
  );

async function proofOf(base: string, manifest: Manifest, user: Address, entry: Entry): Promise<{ proof: Hex[]; root: Hex }> {
  const [eth, usd, tree, node, redeemers = []] = entry;
  const { root, leaves } = manifest.trees[tree];
  const nodes = 2 * leaves - 1;
  const chunk = chunkOf(node, manifest.chunkDepth);
  const res = await fetch(`${base}/trees/${tree}/${chunk}.bin`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok || (res.headers.get("content-type") ?? "").includes("html")) throw new Error(`Blast claim data: proofs unavailable (HTTP ${res.status})`);
  const data = new Uint8Array(await res.arrayBuffer());
  const hash = (n: number): Hex => {
    const at = slotOf(n, chunk, manifest.chunkDepth, nodes) * 32;
    if (at + 32 > data.length) throw new Error("Blast claim data: proofs are truncated");
    return bytesToHex(data.subarray(at, at + 32));
  };
  const proof: Hex[] = [];
  for (let n = node; n > 0; n = (n - 1) >> 1) proof.push(hash(n % 2 ? n + 1 : n - 1));
  const leaf = blastLeaf(user, BigInt(eth), BigInt(usd), redeemers);
  if (hash(node) !== leaf || proof.reduce(pair, leaf) !== root.toLowerCase()) throw new Error("Blast claim data: the proof doesn't match the list's root");
  return { proof, root };
}

export async function checkBlast(user: Address): Promise<CheckOutput> {
  const c = l1Client();
  const me = user.toLowerCase();
  const out: CheckOutput = { findings: [], completed: 0 };
  await Promise.all(
    BLAST_RECOVERY.map(async (contract) => {
      const base = `${DATA}/${contract.id}`;
      const manifest = await json<Manifest | null>(`${base}/manifest.json`, null);
      if (!manifest) return;
      if (manifest.version !== 1) throw new Error(`Blast claim data: unsupported version ${manifest.version}`);
      const shard = await json<Record<string, Entry>>(`${base}/shards/${me.slice(2, 2 + manifest.shardPrefixLength)}.json`, {});
      const entry = shard[me];
      if (!entry) return;
      const [eth, usd, , , redeemers = []] = entry;
      if (await c.readContract({ address: contract.address, abi, functionName: "claimed", args: [user] })) {
        out.completed++;
        return;
      }
      const { proof, root } = await proofOf(base, manifest, user, entry);
      const data = encodeFunctionData({ abi, functionName: "claim", args: [user, BigInt(eth), BigInt(usd), redeemers, proof, root] });
      if ((await dryRun(c, { from: user, to: contract.address, data })) === null) return;
      const finding = (key: string, asset: Finding["asset"], paid: string, paidFr: string): Finding =>
        makeFinding(BLAST, {
          key: `${contract.id}:${key}`,
          label: contract.id === "contract-2" ? "Blast: unfinished withdrawals" : "Blast: balance left at the shutdown",
          status: "ready",
          asset,
          txHash: contract.address,
          txUrl: `${ETHERSCAN}/address/${contract.address}`,
          linkLabel: "View recovery contract",
          timestamp: 0,
          claimAt: "blast.io (type it yourself), on Ethereum",
          minUsd: DUST_ETHEREUM,
          note: `Blast shut down on November 4, 2026. ${formatAmount(asset.amount, 18)} ${asset.symbol} are set aside on Ethereum for ${contract.what}${paid}.`,
          fr: {
            label: contract.id === "contract-2" ? "Blast : retraits inachevés" : "Blast : solde resté à l'arrêt",
            note: `Blast s'est arrêté le 4 novembre 2026. ${formatAmount(asset.amount, 18, "fr")} ${asset.symbol} sont mis de côté sur Ethereum pour ${contract.whatFr}${paidFr}.`,
            claimAt: "blast.io (tapez-le vous-même), sur Ethereum",
            linkLabel: "Voir le contrat de récupération",
          },
        });
      if (BigInt(eth) > 0n) out.findings.push(finding("eth", { symbol: "ETH", decimals: 18, amount: BigInt(eth) }, " (its ETH and WETH)", " (ses ETH et WETH)"));
      if (BigInt(usd) > 0n)
        out.findings.push(finding("usd", { symbol: "DAI", decimals: 18, amount: BigInt(usd), token: DAI, tokenChain: "ethereum" }, " (its USDB, paid in DAI)", " (ses USDB, payés en DAI)"));
    }),
  );
  return out;
}
