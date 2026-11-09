import { encodeFunctionData, parseAbi, type Address, type PublicClient } from "viem";
import { l2Client } from "../clients";
import { evmClient } from "../evm";
import { formatAmount } from "../format";
import { NETWORKS } from "../networks";
import type { Finding } from "../types";
import { makeFinding, type CheckOutput } from "./common";
import { DUST_ETHEREUM, DUST_L2, dryRun, rewardSource } from "./claims";

/**
 * Zora's protocol rewards: every mint of a Zora NFT or coin pays part of its fee in ETH to the
 * creator, the referrer who shared the mint link and the platform it was minted on. The ETH is
 * credited in ProtocolRewards (same address on every chain), never sent: about 114 ETH waited
 * there in November 2026. One balanceOf per chain; reported once withdraw simulates.
 */

export const ZORA_REWARDS = rewardSource("zora-rewards", "Zora protocol rewards");

const PROTOCOL_REWARDS: Address = "0x7777777F279eba3d3Ad8F4E708545291A6fDBA8B";
const abi = parseAbi(["function balanceOf(address) view returns (uint256)", "function withdraw(address to, uint256 amount)"]);

const net = (id: string) => l2Client(NETWORKS.find((n) => n.id === id)!);
const CHAINS: { name: string; client: () => PublicClient; explorer: string; dust: number }[] = [
  { name: "Zora", client: () => net("zora"), explorer: "https://explorer.zora.energy", dust: DUST_L2 },
  { name: "Base", client: () => net("base"), explorer: "https://basescan.org", dust: DUST_L2 },
  { name: "OP Mainnet", client: () => net("optimism"), explorer: "https://optimistic.etherscan.io", dust: DUST_L2 },
  { name: "Arbitrum", client: () => evmClient(42161)!, explorer: "https://arbiscan.io", dust: DUST_L2 },
  { name: "Ethereum", client: () => evmClient(1)!, explorer: "https://etherscan.io", dust: DUST_ETHEREUM },
];

export async function checkZoraRewards(user: Address): Promise<CheckOutput> {
  const results = await Promise.allSettled(
    CHAINS.map(async (chain): Promise<Finding | null> => {
      const c = chain.client();
      const balance = await c.readContract({ address: PROTOCOL_REWARDS, abi, functionName: "balanceOf", args: [user] });
      if (balance === 0n) return null;
      if ((await dryRun(c, { from: user, to: PROTOCOL_REWARDS, data: encodeFunctionData({ abi, functionName: "withdraw", args: [user, balance] }) })) === null) return null;
      return makeFinding(ZORA_REWARDS, {
        key: chain.name,
        label: `Zora rewards · ${chain.name}`,
        status: "ready",
        asset: { symbol: "ETH", decimals: 18, amount: balance },
        txHash: PROTOCOL_REWARDS,
        txUrl: `${chain.explorer}/address/${PROTOCOL_REWARDS}#writeContract`,
        linkLabel: "View contract",
        timestamp: 0,
        claimAt: "zora.co (your profile → rewards), or the explorer (ProtocolRewards → withdraw)",
        minUsd: chain.dust,
        note: `Mints of NFTs or coins this address created, or of mint links it shared, earned it ${formatAmount(balance, 18)} ETH of Zora protocol rewards on ${chain.name}. They are credited to it, never sent: withdraw(your address, amount) pays them out.`,
      });
    }),
  );
  const findings = results.flatMap((r) => (r.status === "fulfilled" && r.value ? [r.value] : []));
  const failed = results.flatMap((r, i) => (r.status === "rejected" ? [`${CHAINS[i].name}: ${String((r.reason as Error)?.message ?? r.reason).split("\n")[0]}`] : []));
  if (failed.length === CHAINS.length) throw new Error(failed.join(" · "));
  return { findings, completed: 0, ...(failed.length && { error: failed.join(" · ") }) };
}
