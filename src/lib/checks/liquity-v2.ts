import { encodeFunctionData, parseAbi, type Address } from "viem";
import { l1Client } from "../clients";
import { formatAmount } from "../format";
import type { Asset, Finding } from "../types";
import { makeFinding, type CheckOutput } from "./common";
import { DUST_ETHEREUM, dryRun, ETHERSCAN, rewardSource } from "./claims";
import { accountsOf, type Kind } from "./liquity";

/**
 * Liquity v2 (BOLD), both deployments: the current one (May 2025) and the first one, wound down
 * when Liquity relaunched. When a trove is liquidated, the collateral above what covers its debt
 * is set aside in its branch's CollSurplusPool for the trove's owner, who must claim it from the
 * branch's BorrowerOperations: nothing is sent. About 35 ETH worth (WETH, wstETH, rETH) waited
 * there in November 2026, most of it on the first deployment. The wallet, its DSProxy and its
 * Instadapp accounts are checked (one view per branch each); a balance is reported once
 * claimCollateral simulates from the account that holds it.
 */

export const LIQUITY_V2 = rewardSource("liquity-v2", "Liquity v2");

const TOKENS = {
  WETH: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  wstETH: "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0",
  rETH: "0xae78736Cd615f374D3085123A210448E74Fc6393",
} as const satisfies Record<string, Address>;

export const LIQUITY_V2_BRANCHES: { deployment: "current" | "first"; collateral: keyof typeof TOKENS; borrowerOperations: Address; collSurplusPool: Address }[] = [
  { deployment: "current", collateral: "WETH", borrowerOperations: "0x372abd1810eaf23cb9d941bbe7596dfb2c46bc65", collSurplusPool: "0xedbe2509e502c0320d2e7f8b6746a49b4b50e2bf" },
  { deployment: "current", collateral: "wstETH", borrowerOperations: "0xa741a32f9dcfe6adba088fd0f97e90742d7d5da3", collSurplusPool: "0x36e6cbdf68f64cf00fc3a6c634a25be32dd0a235" },
  { deployment: "current", collateral: "rETH", borrowerOperations: "0xe8119fc02953b27a1b48d2573855738485a17329", collSurplusPool: "0xba4a2bd8b76df84cac98eba3f4b967d8423192bf" },
  { deployment: "first", collateral: "WETH", borrowerOperations: "0x0b995602b5a797823f92027e8b40c0f2d97aff1c", collSurplusPool: "0x46720b3d63e38583d8f6d77d52c52df32604ef4b" },
  { deployment: "first", collateral: "wstETH", borrowerOperations: "0x94c1610a7373919bd9cfb09ded19894601f4a1be", collSurplusPool: "0xc8e5bda2efc25f04d5feb56eee80e3d8af74cb7f" },
  { deployment: "first", collateral: "rETH", borrowerOperations: "0xa351d5b9cda9eb518727c3ceff02208915fda60d", collSurplusPool: "0xc6f43d9eea6f9955038959a34ea5002f346e2cad" },
];

const abi = parseAbi(["function getCollateral(address _account) view returns (uint256)", "function claimCollateral()"]);

const VIA: Record<Kind, string> = { wallet: "", dsproxy: " through your DSProxy", dsa: " through your Instadapp account" };
const APP: Record<Kind, string> = {
  wallet: "Etherscan (the branch's BorrowerOperations → claimCollateral)",
  dsproxy: "the app that opened the trove (e.g. DeFi Saver)",
  dsa: "instadapp.io",
};

export async function checkLiquityV2(user: Address): Promise<CheckOutput> {
  const c = l1Client();
  const accounts = await accountsOf(user);
  const pairs = accounts.flatMap((a) => LIQUITY_V2_BRANCHES.map((b) => ({ ...a, b })));
  const balances = await Promise.all(pairs.map(({ address, b }) => c.readContract({ address: b.collSurplusPool, abi, functionName: "getCollateral", args: [address] })));
  const findings: Finding[] = [];
  await Promise.all(
    pairs.map(async ({ address: account, kind, b }, i) => {
      const amount = balances[i];
      if (amount === 0n) return;
      if ((await dryRun(c, { from: account, to: b.borrowerOperations, data: encodeFunctionData({ abi, functionName: "claimCollateral" }) })) === null) return;
      const asset: Asset = { symbol: b.collateral, decimals: 18, amount, token: TOKENS[b.collateral], tokenChain: "ethereum" };
      const first = b.deployment === "first";
      findings.push(
        makeFinding(LIQUITY_V2, {
          key: `${b.deployment}:${b.collateral}:${account}`,
          label: `Liquity v2${first ? " (first deployment)" : ""}: collateral left after liquidation`,
          status: "ready",
          asset,
          txHash: b.borrowerOperations,
          txUrl: `${ETHERSCAN}/address/${b.borrowerOperations}#writeContract`,
          linkLabel: "View contract",
          timestamp: 0,
          claimAt: APP[kind],
          minUsd: DUST_ETHEREUM,
          note:
            `A ${b.collateral} trove you opened${VIA[kind]}${kind === "wallet" ? "" : ` (held by ${account})`} on Liquity v2${first ? "'s first deployment, wound down when Liquity relaunched in 2025," : ""} was liquidated, ` +
            `and the ${formatAmount(amount, 18)} ${b.collateral} above its debt was set aside for you. It is never sent: call claimCollateral() on the ${b.collateral} branch's BorrowerOperations (${b.borrowerOperations}).`,
        }),
      );
    }),
  );
  return { findings, completed: 0 };
}
