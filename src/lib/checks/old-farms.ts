import { encodeFunctionData, parseAbi, type Address } from "viem";
import { l1Client } from "../clients";
import { formatAmount } from "../format";
import type { Finding } from "../types";
import { makeFinding, type CheckOutput, type FindingSource } from "./common";
import { DUST_ETHEREUM, dryRun, ETHERSCAN } from "./claims";
import { LEGACY_GUIDE } from "./exchanges";

/**
 * Uniswap's own liquidity mining of September to November 2020: four StakingRewards contracts
 * where Uniswap v2 pool tokens were staked to earn UNI. The program ended on November 17, 2020,
 * but what was staked is still there (3,100 ETH/DAI pool tokens and smaller, very valuable
 * amounts of the three other pools in November 2026), with the UNI earned and never claimed.
 * Staked pool tokens don't show in a wallet. Two views per farm; reported once exit() (withdraw
 * everything and claim the UNI) simulates from the address.
 */

export const UNI_FARMS: FindingSource = { id: "uniswap-2020-farms", name: "Uniswap 2020 farms", guideId: LEGACY_GUIDE, explorer: ETHERSCAN };

const UNI: Address = "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984";
export const UNI_FARM_LIST: { pair: string; farm: Address; lp: Address }[] = [
  { pair: "ETH/DAI", farm: "0xa1484C3aa22a66C62b77E0AE78E15258bd0cB711", lp: "0xA478c2975Ab1Ea89e8196811F51A7B7Ade33eB11" },
  { pair: "ETH/USDC", farm: "0x7FBa4B8Dc5E7616e59622806932DBea72537A56b", lp: "0xB4e16d0168e52d35CaCD2c6185b44281Ec28C9Dc" },
  { pair: "ETH/USDT", farm: "0x6C3e4cb2E96B01F4b866965A91ed4437839A121a", lp: "0x0d4a11d5EEaaC28EC3F61d100daF4d40471f1852" },
  { pair: "ETH/WBTC", farm: "0xCA35e32e7926b96A9988f61d510E038108d8068e", lp: "0xBb2b8038a1640196FbE3e38816F3e67Cba72D940" },
];

const abi = parseAbi(["function balanceOf(address) view returns (uint256)", "function earned(address) view returns (uint256)", "function exit()"]);

export async function checkUniFarms(user: Address): Promise<CheckOutput> {
  const c = l1Client();
  const state = await Promise.all(
    UNI_FARM_LIST.map((f) =>
      Promise.all([c.readContract({ address: f.farm, abi, functionName: "balanceOf", args: [user] }), c.readContract({ address: f.farm, abi, functionName: "earned", args: [user] })]),
    ),
  );
  const findings: Finding[] = [];
  await Promise.all(
    UNI_FARM_LIST.map(async (f, i) => {
      const [staked, earned] = state[i];
      if (staked === 0n && earned === 0n) return;
      if ((await dryRun(c, { from: user, to: f.farm, data: encodeFunctionData({ abi, functionName: "exit" }) })) === null) return;
      const link = { txHash: f.farm, txUrl: `${ETHERSCAN}/address/${f.farm}#writeContract`, linkLabel: "View contract", timestamp: 0, minUsd: DUST_ETHEREUM };
      const claimAt = `Etherscan (the ${f.pair} StakingRewards contract → exit)`;
      const claimAtFr = `Etherscan (le contrat StakingRewards ${f.pair} → exit)`;
      if (staked > 0n)
        findings.push(
          makeFinding(UNI_FARMS, {
            key: `${f.pair}:lp`,
            label: `Uniswap 2020 farm: ${f.pair} pool tokens still staked`,
            status: "ready",
            asset: { symbol: `${f.pair} UNI-V2`, decimals: 18, amount: staked, token: f.lp, tokenChain: "ethereum" },
            ...link,
            claimAt,
            note: `This address still has ${formatAmount(staked, 18)} Uniswap v2 ${f.pair} pool tokens staked in Uniswap's 2020 UNI farm, which ended on November 17, 2020. They earn nothing there and don't show in your wallet. exit() sends them back; you can then remove the liquidity on Uniswap to get the ETH and the other token.`,
            fr: {
              label: `Ferme Uniswap 2020 : jetons du pool ${f.pair} toujours stakés`,
              note: `Cette adresse a encore ${formatAmount(staked, 18, "fr")} jetons du pool Uniswap v2 ${f.pair} stakés dans la ferme UNI de 2020, terminée le 17 novembre 2020. Ils n'y rapportent rien et n'apparaissent pas dans votre wallet. exit() vous les renvoie ; vous pouvez ensuite retirer la liquidité sur Uniswap pour récupérer l'ETH et l'autre token.`,
              claimAt: claimAtFr,
              linkLabel: "Voir le contrat",
            },
          }),
        );
      if (earned > 0n)
        findings.push(
          makeFinding(UNI_FARMS, {
            key: `${f.pair}:uni`,
            label: `Uniswap 2020 farm: UNI never claimed (${f.pair})`,
            status: "ready",
            asset: { symbol: "UNI", decimals: 18, amount: earned, token: UNI, tokenChain: "ethereum" },
            ...link,
            claimAt,
            note: `Staking ${f.pair} pool tokens in Uniswap's 2020 farm earned this address ${formatAmount(earned, 18)} UNI that were never claimed. exit() (or getReward()) pays them.`,
            fr: {
              label: `Ferme Uniswap 2020 : UNI jamais réclamés (${f.pair})`,
              note: `Le staking de jetons du pool ${f.pair} dans la ferme Uniswap de 2020 a rapporté à cette adresse ${formatAmount(earned, 18, "fr")} UNI jamais réclamés. exit() (ou getReward()) les verse.`,
              claimAt: claimAtFr,
              linkLabel: "Voir le contrat",
            },
          }),
        );
    }),
  );
  return { findings, completed: 0 };
}
