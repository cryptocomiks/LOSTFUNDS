import { encodeFunctionData, parseAbi, type Address } from "viem";
import { l1Client } from "../clients";
import { formatAmount } from "../format";
import type { Finding } from "../types";
import { makeFinding, type CheckOutput } from "./common";
import { DUST_ETHEREUM, dryRun, ETHERSCAN, rewardSource } from "./claims";

/**
 * ETH left with NFT marketplaces. To bid, a collector first deposits ETH in the marketplace's
 * own contract, where it no longer shows in the wallet:
 *  - Blur's bidding pool (4,900 ETH in November 2026): everything in it can be withdrawn at any
 *    time, which also cancels the bids it was backing;
 *  - Foundation's FETH (270 ETH): what isn't locked in an offer still open can be withdrawn.
 * One view per marketplace; reported once the withdrawal simulates from the address.
 */

export const NFT_MARKETS = rewardSource("nft-marketplaces", "NFT marketplace balances");

const BLUR_POOL: Address = "0x0000000000A39bb272e79075ade125fd351887Ac";
const FETH: Address = "0x49128CF8ABE9071ee24540a296b5DED3F9D50443";

const abi = parseAbi(["function balanceOf(address) view returns (uint256)", "function withdraw(uint256 amount)", "function withdrawAvailableBalance()"]);

export async function checkNftMarkets(user: Address): Promise<CheckOutput> {
  const c = l1Client();
  const [blur, feth] = await Promise.all([
    c.readContract({ address: BLUR_POOL, abi, functionName: "balanceOf", args: [user] }),
    c.readContract({ address: FETH, abi, functionName: "balanceOf", args: [user] }),
  ]);
  const [blurOk, fethOk] = await Promise.all([
    blur > 0n ? dryRun(c, { from: user, to: BLUR_POOL, data: encodeFunctionData({ abi, functionName: "withdraw", args: [blur] }) }) : null,
    feth > 0n ? dryRun(c, { from: user, to: FETH, data: encodeFunctionData({ abi, functionName: "withdrawAvailableBalance" }) }) : null,
  ]);
  const findings: Finding[] = [];
  if (blurOk !== null)
    findings.push(
      makeFinding(NFT_MARKETS, {
        key: "blur",
        label: "Blur: ETH in the bidding pool",
        status: "ready",
        asset: { symbol: "ETH", decimals: 18, amount: blur },
        txHash: BLUR_POOL,
        txUrl: `${ETHERSCAN}/address/${BLUR_POOL}`,
        linkLabel: "View contract",
        timestamp: 0,
        claimAt: "blur.io (your balance → Withdraw from pool)",
        minUsd: DUST_ETHEREUM,
        note: `This address has ${formatAmount(blur, 18)} ETH in Blur's bidding pool. ETH deposited there to bid on NFTs leaves your wallet and stays in the pool until you withdraw it. Withdrawing is possible at any time, and cancels the bids this ETH was backing.`,
        fr: {
          label: "Blur : ETH dans le pool d'enchères",
          note: `Cette adresse a ${formatAmount(blur, 18, "fr")} ETH dans le pool d'enchères de Blur. L'ETH déposé là pour enchérir sur des NFT quitte votre wallet et reste dans le pool tant que vous ne le retirez pas. Le retrait est possible à tout moment, et annule les offres que cet ETH garantissait.`,
          claimAt: "blur.io (votre solde → Withdraw from pool)",
          linkLabel: "Voir le contrat",
        },
      }),
    );
  if (fethOk !== null)
    findings.push(
      makeFinding(NFT_MARKETS, {
        key: "feth",
        label: "Foundation: ETH in your marketplace balance",
        status: "ready",
        asset: { symbol: "ETH", decimals: 18, amount: feth },
        txHash: FETH,
        txUrl: `${ETHERSCAN}/address/${FETH}#writeProxyContract`,
        linkLabel: "View contract",
        timestamp: 0,
        claimAt: "foundation.app (your balance → Withdraw), or Etherscan (FETH → withdrawAvailableBalance)",
        minUsd: DUST_ETHEREUM,
        note: `This address has ${formatAmount(feth, 18)} ETH in its Foundation marketplace balance (FETH), left by offers that were outbid, expired or cancelled. It isn't locked in any offer: withdrawAvailableBalance() sends it back to your wallet.`,
        fr: {
          label: "Foundation : ETH dans votre solde de marketplace",
          note: `Cette adresse a ${formatAmount(feth, 18, "fr")} ETH dans son solde de marketplace Foundation (FETH), laissés par des offres surenchéries, expirées ou annulées. Ils ne sont bloqués dans aucune offre : withdrawAvailableBalance() les renvoie sur votre wallet.`,
          claimAt: "foundation.app (votre solde → Withdraw), ou Etherscan (FETH → withdrawAvailableBalance)",
          linkLabel: "Voir le contrat",
        },
      }),
    );
  return { findings, completed: 0 };
}
