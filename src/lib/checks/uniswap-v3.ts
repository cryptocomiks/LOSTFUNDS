import { decodeFunctionResult, encodeFunctionData, parseAbi, type Address } from "viem";
import { evmChain, evmClient } from "../evm";
import { formatAmount } from "../format";
import { addPrices, tokenMeta } from "../tokens";
import type { Asset, Finding } from "../types";
import { makeFinding, type CheckOutput } from "./common";
import { DUST_ETHEREUM, DUST_L2, dryRun, rewardSource } from "./claims";

/**
 * Uniswap v3 positions: trading fees are never sent to the liquidity provider, they pile up in
 * the position until collected, and removing the liquidity leaves the tokens in it until they are
 * collected too. For each position NFT the address holds (Ethereum, Base, Arbitrum, OP Mainnet,
 * Polygon), collect() is run as an eth_call from the address: what it returns is exactly what a
 * real collect would pay (fees earned up to this block, and tokens from liquidity already
 * removed). Liquidity still in the position isn't counted: it isn't forgotten, and its owner can
 * see it in any wallet. Only tokens with a market price are shown.
 */

export const UNISWAP_V3 = rewardSource("uniswap-v3-fees", "Uniswap v3 fees");

const CHAINS: { chainId: number; name: string; manager: Address; dust: number; slug: string }[] = [
  { chainId: 1, name: "Ethereum", manager: "0xC36442b4a4522E871399CD717aBDD847Ab11FE88", dust: DUST_ETHEREUM, slug: "ethereum" },
  { chainId: 8453, name: "Base", manager: "0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1", dust: DUST_L2, slug: "base" },
  { chainId: 42161, name: "Arbitrum", manager: "0xC36442b4a4522E871399CD717aBDD847Ab11FE88", dust: DUST_L2, slug: "arbitrum" },
  { chainId: 10, name: "OP Mainnet", manager: "0xC36442b4a4522E871399CD717aBDD847Ab11FE88", dust: DUST_L2, slug: "optimism" },
  { chainId: 137, name: "Polygon", manager: "0xC36442b4a4522E871399CD717aBDD847Ab11FE88", dust: DUST_L2, slug: "polygon" },
];
/** More positions than this on one chain: only the most recent ones are read. */
const MAX_POSITIONS = 40;
const MAX_UINT128 = 2n ** 128n - 1n;

const abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function tokenOfOwnerByIndex(address, uint256) view returns (uint256)",
  "function positions(uint256) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
  "function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max)) returns (uint256 amount0, uint256 amount1)",
]);

async function checkChain(chain: (typeof CHAINS)[number], user: Address): Promise<Finding[]> {
  const c = evmClient(chain.chainId);
  if (!c) return [];
  const count = Number(await c.readContract({ address: chain.manager, abi, functionName: "balanceOf", args: [user] }));
  if (!count) return [];
  // The latest positions (the enumeration is in the order they were received).
  const indices = Array.from({ length: Math.min(count, MAX_POSITIONS) }, (_, i) => BigInt(count - 1 - i));
  const ids = await Promise.all(indices.map((i) => c.readContract({ address: chain.manager, abi, functionName: "tokenOfOwnerByIndex", args: [user, i] })));
  const llama = evmChain(chain.chainId)?.llama ?? chain.slug;

  const out: Finding[] = [];
  await Promise.all(
    ids.map(async (id) => {
      const data = encodeFunctionData({ abi, functionName: "collect", args: [{ tokenId: id, recipient: user, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 }] });
      const result = await dryRun(c, { from: user, to: chain.manager, data });
      if (result === null || result === "0x") return;
      const [amount0, amount1] = decodeFunctionResult({ abi, functionName: "collect", data: result });
      if (amount0 === 0n && amount1 === 0n) return;
      const position = await c.readContract({ address: chain.manager, abi, functionName: "positions", args: [id] });
      const [token0, token1, liquidity] = [position[2], position[3], position[7]];
      const assets = (
        await Promise.all(
          (
            [
              [token0, amount0],
              [token1, amount1],
            ] as const
          ).map(async ([token, amount]): Promise<Asset | null> => {
            if (amount === 0n) return null;
            const meta = await tokenMeta([c], token);
            return meta ? { symbol: meta.symbol, decimals: meta.decimals, amount, token, tokenChain: llama } : null;
          }),
        )
      ).filter((a): a is Asset => a !== null);
      await addPrices(assets);
      const pairName = `${(await tokenMeta([c], token0))?.symbol ?? "?"}/${(await tokenMeta([c], token1))?.symbol ?? "?"}`;
      for (const asset of assets) {
        if (asset.usd === undefined) continue; // no market price: a worthless or spam token
        out.push(
          makeFinding(UNISWAP_V3, {
            key: `${chain.chainId}:${id}:${asset.token}`,
            label: `Uniswap v3 · ${pairName} #${id} · ${chain.name}`,
            status: "ready",
            asset,
            txHash: chain.manager,
            txUrl: `https://app.uniswap.org/positions/v3/${chain.slug}/${id}`,
            linkLabel: "View position",
            timestamp: 0,
            claimAt: "app.uniswap.org (Pool → your position → Collect fees)",
            minUsd: chain.dust,
            note:
              liquidity === 0n
                ? `Your Uniswap v3 position #${id} (${pairName}, ${chain.name}) has no liquidity left, but ${formatAmount(asset.amount, asset.decimals)} ${asset.symbol} were never collected from it. They stay in the position until you collect them.`
                : `Your Uniswap v3 position #${id} (${pairName}, ${chain.name}) has earned ${formatAmount(asset.amount, asset.decimals)} ${asset.symbol} in trading fees that were never collected. Fees are not added to the position or sent to you: they wait until you collect them. Your liquidity itself isn't counted here.`,
            fr: {
              label: `Uniswap v3 · ${pairName} n° ${id} · ${chain.name}`,
              linkLabel: "Voir la position",
              claimAt: "app.uniswap.org (Pool → votre position → Collect fees)",
              note:
                liquidity === 0n
                  ? `Votre position Uniswap v3 n° ${id} (${pairName}, ${chain.name}) n'a plus de liquidité, mais ${formatAmount(asset.amount, asset.decimals, "fr")} ${asset.symbol} n'en ont jamais été collectés. Ils restent dans la position tant que vous ne les collectez pas.`
                  : `Votre position Uniswap v3 n° ${id} (${pairName}, ${chain.name}) a gagné ${formatAmount(asset.amount, asset.decimals, "fr")} ${asset.symbol} de frais de trading jamais collectés. Les frais ne sont ni ajoutés à la position ni envoyés : ils attendent que vous les collectiez. Votre liquidité elle-même n'est pas comptée ici.`,
            },
          }),
        );
      }
    }),
  );
  return out;
}

export async function checkUniswapV3(user: Address): Promise<CheckOutput> {
  const results = await Promise.allSettled(CHAINS.map((chain) => checkChain(chain, user)));
  const failed = results.flatMap((r, i) => (r.status === "rejected" ? [`${CHAINS[i].name}: ${String((r.reason as Error)?.message ?? r.reason).split("\n")[0]}`] : []));
  if (failed.length === CHAINS.length) throw new Error(failed.join(" · "));
  return { findings: results.flatMap((r) => (r.status === "fulfilled" ? r.value : [])), completed: 0, ...(failed.length && { error: failed.join(" · ") }) };
}
