import { encodeFunctionData, parseAbi, type Address } from "viem";
import { l1Client } from "../clients";
import { formatAmount } from "../format";
import { makeFinding, now, type CheckOutput } from "./common";
import { DUST_ETHEREUM, dryRun, ETHERSCAN, rewardSource } from "./claims";

/**
 * Ethena: unstaking sUSDe takes two steps. The first one starts a cooldown and moves the USDe to
 * a silo; once the cooldown is over, the USDe must be taken out with unstake(), and it waits in
 * the silo until then (16M USDe were there in November 2026, cooldowns in progress included).
 * One view (cooldowns); a finished cooldown is reported once unstake simulates from the address,
 * a running one as waiting, with its end date.
 */

export const ETHENA = rewardSource("ethena-unstake", "Ethena unstaking");

const SUSDE: Address = "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497";
const USDE: Address = "0x4c9EDD5852cd905f086C759E8383e09bff1E68B3";

const abi = parseAbi(["function cooldowns(address) view returns (uint104 cooldownEnd, uint152 underlyingAmount)", "function unstake(address receiver)"]);

export async function checkEthena(user: Address): Promise<CheckOutput> {
  const c = l1Client();
  const [end, amount] = await c.readContract({ address: SUSDE, abi, functionName: "cooldowns", args: [user] });
  if (amount === 0n) return { findings: [], completed: 0 };
  const cooldownEnd = Number(end);
  const ready = now() >= cooldownEnd;
  if (ready && (await dryRun(c, { from: user, to: SUSDE, data: encodeFunctionData({ abi, functionName: "unstake", args: [user] }) })) === null) return { findings: [], completed: 0 };
  return {
    findings: [
      makeFinding(ETHENA, {
        key: "cooldown",
        label: "Ethena: unstaked USDe never withdrawn",
        status: ready ? "ready" : "waiting",
        ...(!ready && { readyAt: cooldownEnd }),
        asset: { symbol: "USDe", decimals: 18, amount, token: USDE, tokenChain: "ethereum" },
        txHash: SUSDE,
        txUrl: `${ETHERSCAN}/address/${SUSDE}#writeContract`,
        linkLabel: "View contract",
        timestamp: cooldownEnd,
        dateLabel: ready ? "Cooldown ended" : "Cooldown ends",
        claimAt: "app.ethena.fi (Stake → Withdraw), or Etherscan (sUSDe → unstake, with your address)",
        minUsd: DUST_ETHEREUM,
        note: ready
          ? `You unstaked ${formatAmount(amount, 18)} USDe from Ethena's sUSDe and the cooldown is over, but the USDe was never withdrawn. It waits in Ethena's silo, earning nothing, until you call unstake.`
          : `You unstaked ${formatAmount(amount, 18)} USDe from Ethena's sUSDe. It is in its cooldown: once it ends, the USDe is not sent to you, you have to withdraw it.`,
        fr: {
          label: "Ethena : USDe déstakés jamais retirés",
          dateLabel: ready ? "Cooldown terminé le" : "Fin du cooldown le",
          claimAt: "app.ethena.fi (Stake → Withdraw), ou Etherscan (sUSDe → unstake, avec votre adresse)",
          linkLabel: "Voir le contrat",
          note: ready
            ? `Vous avez déstaké ${formatAmount(amount, 18, "fr")} USDe du sUSDe d'Ethena et le cooldown est terminé, mais les USDe n'ont jamais été retirés. Ils attendent dans le silo d'Ethena, sans rien rapporter, jusqu'à ce que vous appeliez unstake.`
            : `Vous avez déstaké ${formatAmount(amount, 18, "fr")} USDe du sUSDe d'Ethena. Ils sont dans leur période de cooldown : à la fin, les USDe ne vous sont pas envoyés, c'est à vous de les retirer.`,
        },
      }),
    ],
    completed: 0,
  };
}
