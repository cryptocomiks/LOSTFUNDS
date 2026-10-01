import { encodeFunctionData, getAddress, isAddress, parseAbi, type Address, type Hex } from "viem";
import { evmChain, evmClient } from "../evm";
import { tokenMeta } from "../tokens";
import type { Finding } from "../types";
import type { CheckOutput, FindingSource } from "./common";
import { makeFinding } from "./common";
import { contractUrl, dustUsd, perChain } from "./multichain";
import { wouldSucceed } from "./simulate";

/**
 * Merkl rewards (incentives of Morpho, Euler, Uniswap pools, chain programs…) earned and never
 * claimed. Merkl's public API lists them for every chain in one call, with the Merkle proofs;
 * each one is then checked where it's paid: what the distributor already sent (claimed), and
 * the claim itself, run as an eth_call from the user's address. Rewards on chains without an
 * RPC in the registry can't be checked that way, so they're left out.
 */

export const MERKL: FindingSource = { id: "merkl", name: "Merkl", guideId: "aave-merkl" };

const API = "https://api.merkl.xyz/v4/users";
const DISTRIBUTOR: Address = "0x3Ef3D8bA38EBe18DB133cEc108f4D14CE00Dd9Ae";
/** Where Merkl's distributor isn't at its usual address (ZK Stack chains derive addresses differently). */
const DISTRIBUTOR_AT: Record<number, Address> = { 324: "0xe117ed7Ef16d3c28fCBA7eC49AFAD77f451a6a21" };
/** Rewards checked on-chain at most, the most valuable first (a handful at most for nearly everyone). */
const MAX_REWARDS = 40;

const distributorAbi = parseAbi([
  "function claimed(address user, address token) view returns (uint208 amount, uint48 timestamp, bytes32 merkleRoot)",
  "function claim(address[] users, address[] tokens, uint256[] amounts, bytes32[][] proofs)",
]);

interface ApiReward {
  token: { address: string; symbol?: string; decimals: number; price?: number | null; type?: string };
  /** Cumulative amount in the current Merkle tree (raw units). */
  amount: string;
  claimed: string;
  proofs: string[];
}
interface ApiChain {
  chain: { id: number; name: string };
  rewards: ApiReward[];
}

interface Candidate {
  chainId: number;
  token: Address;
  amount: bigint;
  proofs: Hex[];
  symbol: string;
  decimals: number;
  price: number;
}

const isUint = (s: unknown): s is string => typeof s === "string" && /^\d+$/.test(s);
const isProof = (p: unknown): p is Hex => typeof p === "string" && /^0x[0-9a-fA-F]{64}$/.test(p);

/** Real tokens with a price (no points or pre-TGE tokens), unclaimed according to the API, worth more than dust. */
function candidates(chains: ApiChain[]): Candidate[] {
  const out: (Candidate & { usd: number })[] = [];
  for (const c of chains) {
    if (!c.chain || !evmClient(c.chain.id)) continue; // no RPC to check it on: never shown unverified
    for (const r of c.rewards ?? []) {
      const t = r.token;
      if (t?.type !== "TOKEN" || !(Number(t.price) > 0) || !isAddress(t.address) || !Number.isInteger(t.decimals)) continue;
      if (!isUint(r.amount) || !isUint(r.claimed) || !Array.isArray(r.proofs) || !r.proofs.every(isProof)) continue;
      const amount = BigInt(r.amount);
      const left = amount - BigInt(r.claimed);
      if (left <= 0n) continue;
      const usd = (Number(left) / 10 ** t.decimals) * Number(t.price);
      if (usd < dustUsd(c.chain.id)) continue;
      out.push({ chainId: c.chain.id, token: getAddress(t.address), amount, proofs: r.proofs, symbol: t.symbol || "tokens", decimals: t.decimals, price: Number(t.price), usd });
    }
  }
  return out.sort((a, b) => b.usd - a.usd).slice(0, MAX_REWARDS);
}

async function verifyChain(chainId: number, list: Candidate[], user: Address): Promise<Finding[]> {
  const client = evmClient(chainId)!;
  const distributor = DISTRIBUTOR_AT[chainId] ?? DISTRIBUTOR;
  const name = evmChain(chainId)!.name;
  const found = await Promise.all(
    list.map(async (r) => {
      const [[claimed], meta] = await Promise.all([
        client.readContract({ address: distributor, abi: distributorAbi, functionName: "claimed", args: [user, r.token] }),
        tokenMeta([client], r.token),
      ]);
      // The API can lag behind a recent claim: what the distributor already paid is authoritative.
      if (r.amount <= claimed) return null;
      const data = encodeFunctionData({ abi: distributorAbi, functionName: "claim", args: [[user], [r.token], [r.amount], [r.proofs]] });
      // Rejected: the proof isn't for the tree on-chain yet (new root still in its dispute period)…
      if (!(await wouldSucceed(client, { from: user, to: distributor, data }))) return null;
      const decimals = meta?.decimals ?? r.decimals;
      const amount = r.amount - claimed;
      return makeFinding(MERKL, {
        key: r.token,
        label: `Merkl · ${name}`,
        status: "ready",
        asset: {
          symbol: meta?.symbol || r.symbol,
          decimals,
          amount,
          token: r.token,
          tokenChain: evmChain(chainId)!.llama,
          // Merkl's own price, used when DefiLlama doesn't know the token.
          usd: (Number(amount) / 10 ** decimals) * r.price,
        },
        txHash: `${chainId}:${distributor}`,
        txUrl: contractUrl(chainId, distributor),
        timestamp: 0,
        note: `Rewards from Merkl campaigns on ${name} (lending, liquidity or chain incentives) that this address earned and never claimed: they can still be claimed.`,
        claimAt: `app.merkl.xyz/users/${user}`,
        minUsd: dustUsd(chainId),
      });
    }),
  );
  return found.filter((f) => f !== null);
}

/** Unclaimed Merkl rewards on every chain Merkl pays on that the registry can check. */
export async function checkMerkl(user: Address): Promise<CheckOutput> {
  const res = await fetch(`${API}/${user}/rewards/summary`, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`Merkl API: HTTP ${res.status}`);
  const chains = (await res.json()) as ApiChain[];
  if (!Array.isArray(chains)) throw new Error("Merkl API: unexpected answer");
  const byChain = new Map<number, Candidate[]>();
  for (const c of candidates(chains)) byChain.set(c.chainId, [...(byChain.get(c.chainId) ?? []), c]);
  return perChain([...byChain], ([id]) => evmChain(id)!.name, ([id, list]) => verifyChain(id, list, user));
}
