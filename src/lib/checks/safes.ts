import { getAddress, parseAbi, type Address } from "viem";
import { evmChain, evmClient } from "../evm";
import { formatAmount } from "../format";
import { addPrices, mapLimit } from "../tokens";
import type { Asset, Finding } from "../types";
import { makeFinding, now, type CheckOutput, type FindingSource } from "./common";
import { LEGACY_GUIDE } from "./exchanges";

/**
 * Forgotten Safes. A Safe (Gnosis Safe) is its own address: what it holds doesn't show in the
 * wallet of its owner, and a Safe created once for a mint, a team or a test is easily forgotten.
 * Safe's public Transaction Service lists the Safes an address owns on each chain; a Safe is
 * reported when
 *   - the address can move its funds alone (threshold 1, read on-chain),
 *   - it has sent nothing for a year (or never), and
 *   - it holds ETH or tokens Safe marks as trusted, with a market price.
 * Shared Safes (2 signatures or more) and Safes in use aren't forgotten money: left out.
 */

export const SAFES: FindingSource = { id: "safes", name: "Forgotten Safes", guideId: LEGACY_GUIDE };

const API = "https://api.safe.global/tx-service";
const CHAINS: { slug: string; chainId: number; explorer: string }[] = [
  { slug: "eth", chainId: 1, explorer: "https://etherscan.io" },
  { slug: "base", chainId: 8453, explorer: "https://basescan.org" },
  { slug: "arb1", chainId: 42161, explorer: "https://arbiscan.io" },
  { slug: "oeth", chainId: 10, explorer: "https://optimistic.etherscan.io" },
  { slug: "pol", chainId: 137, explorer: "https://polygonscan.com" },
  { slug: "gno", chainId: 100, explorer: "https://gnosisscan.io" },
  { slug: "bnb", chainId: 56, explorer: "https://bscscan.com" },
];
/** More Safes than this on one chain: only the first ones are read. */
const MAX_SAFES = 8;
/** Assets shown per Safe (the largest ones). */
const MAX_ASSETS = 4;
const MIN_USD = 10;
const YEAR = 365 * 86_400;

const safeAbi = parseAbi(["function getThreshold() view returns (uint256)"]);

async function api<T>(path: string): Promise<T> {
  const res = await fetch(`${API}/${path}`, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`Safe API: HTTP ${res.status}`);
  return (await res.json()) as T;
}

interface Balance {
  tokenAddress: Address | null;
  token: { symbol: string; decimals: number } | null;
  balance: string;
}

async function checkChain(chain: (typeof CHAINS)[number], user: Address): Promise<Finding[]> {
  const c = evmClient(chain.chainId);
  const info = evmChain(chain.chainId);
  if (!c || !info) return [];
  const { safes } = await api<{ safes: Address[] }>(`${chain.slug}/api/v1/owners/${user}/safes/`);
  if (!safes.length) return [];
  const mine = safes.slice(0, MAX_SAFES);
  // Safes the address controls alone.
  const thresholds = await Promise.all(mine.map((s) => c.readContract({ address: s, abi: safeAbi, functionName: "getThreshold" }).catch(() => 0n)));
  const solo = mine.filter((_, i) => thresholds[i] === 1n);

  const out: Finding[] = [];
  await mapLimit(solo, 2, async (safe) => {
    const balances = await api<Balance[]>(`${chain.slug}/api/v1/safes/${safe}/balances/?trusted=true&exclude_spam=true`);
    const nativeSymbol = info.chain.nativeCurrency.symbol;
    const assets: Asset[] = balances
      .filter((b) => BigInt(b.balance) > 0n && (b.tokenAddress === null || b.token))
      .map((b) =>
        b.tokenAddress === null
          ? { symbol: nativeSymbol, decimals: 18, amount: BigInt(b.balance), priceKey: info.nativePrice }
          : { symbol: b.token!.symbol, decimals: b.token!.decimals, amount: BigInt(b.balance), token: getAddress(b.tokenAddress), tokenChain: info.llama },
      );
    if (!assets.length) return;
    await addPrices(assets);
    const worth = assets.filter((a) => (a.usd ?? 0) >= MIN_USD).sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0));
    if (!worth.length) return;
    // In use? The last transaction the Safe sent.
    const last = await api<{ results: { executionDate: string | null }[] }>(`${chain.slug}/api/v1/safes/${safe}/multisig-transactions/?executed=true&limit=1&ordering=-executionDate`);
    const lastDate = last.results[0]?.executionDate ? Math.floor(Date.parse(last.results[0].executionDate) / 1000) : 0;
    if (lastDate && now() - lastDate < YEAR) return;
    const short = `${safe.slice(0, 6)}…${safe.slice(-4)}`;
    for (const asset of worth.slice(0, MAX_ASSETS))
      out.push(
        makeFinding(SAFES, {
          key: `${chain.chainId}:${safe}:${asset.token ?? "native"}`,
          label: `Safe ${short} · ${info.name}`,
          status: "ready",
          asset,
          txHash: safe,
          txUrl: `${chain.explorer}/address/${safe}`,
          linkLabel: "View Safe",
          timestamp: lastDate,
          dateLabel: "Last used",
          claimAt: "app.safe.global (connect the owner wallet, open the Safe)",
          minUsd: MIN_USD,
          note:
            `This address is the only signer needed on the Safe ${safe} (${info.name}), which holds ${formatAmount(asset.amount, asset.decimals)} ${asset.symbol} ` +
            `and ${lastDate ? "has sent nothing for over a year" : "has never sent a transaction"}. A Safe is a separate address: its funds don't show in your wallet. If you had forgotten it, open it at app.safe.global with this wallet and send the funds wherever you want.`,
        }),
      );
  });
  return out;
}

export async function checkSafes(user: Address): Promise<CheckOutput> {
  const results = await Promise.allSettled(CHAINS.map((chain) => checkChain(chain, user)));
  const failed = results.flatMap((r, i) => (r.status === "rejected" ? [`${CHAINS[i].slug}: ${String((r.reason as Error)?.message ?? r.reason).split("\n")[0]}`] : []));
  if (failed.length === CHAINS.length) throw new Error(failed.join(" · "));
  return { findings: results.flatMap((r) => (r.status === "fulfilled" ? r.value : [])), completed: 0, ...(failed.length && { error: failed.join(" · ") }) };
}
