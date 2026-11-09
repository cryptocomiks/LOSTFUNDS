import { base58 } from "@scure/base";
import { formatAmount } from "../format";
import { associatedTokenAddress, findProgramAddress, rpc } from "../solana";
import type { Finding } from "../types";
import { makeFinding, type CheckOutput, type FindingSource } from "./common";

/**
 * Creator fees on pump.fun. Every trade of a coin pays its creator a fee, which piles up in a
 * vault until the creator collects it:
 *  - on the bonding curve (pump.fun's own program), as SOL in the "creator-vault" PDA of the
 *    creator, minus the rent that keeps the vault alive;
 *  - once the coin has moved to PumpSwap, as wrapped SOL in the token account of the
 *    "creator_vault" PDA of PumpSwap's program.
 * Both addresses are derived from the wallet: two accounts and the rent minimum, one request
 * each to a regular node (no index query).
 */

export const PUMP_FEES: FindingSource = { id: "pumpfun-creator-fees", name: "pump.fun creator fees", guideId: "reclaim" };

const PUMP = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const PUMPSWAP = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
const WSOL = "So11111111111111111111111111111111111111112";
const seed = (s: string) => new TextEncoder().encode(s);
const sol = (lamports: bigint) => ({ symbol: "SOL", decimals: 9, amount: lamports, priceKey: "coingecko:solana" });

export const pumpVault = (creator: string) => findProgramAddress([seed("creator-vault"), base58.decode(creator)], PUMP);
export const pumpSwapVaultAccount = (creator: string) =>
  associatedTokenAddress(findProgramAddress([seed("creator_vault"), base58.decode(creator)], PUMPSWAP), WSOL);

export async function checkPumpFees(creator: string): Promise<CheckOutput> {
  const vault = pumpVault(creator);
  const swapVault = pumpSwapVaultAccount(creator);
  const [{ value }, rent] = await Promise.all([
    rpc<{ value: ({ lamports: number; data: [string, string] } | null)[] }>("getMultipleAccounts", [[vault, swapVault], { encoding: "base64" }]),
    rpc<number>("getMinimumBalanceForRentExemption", [0]),
  ]);
  const [vaultAccount, swapAccount] = value;
  const findings: Finding[] = [];
  const curveFees = vaultAccount ? BigInt(vaultAccount.lamports) - BigInt(rent) : 0n;
  if (curveFees > 0n)
    findings.push(
      makeFinding(PUMP_FEES, {
        key: "curve",
        label: "pump.fun creator fees",
        status: "ready",
        asset: sol(curveFees),
        txHash: vault,
        txUrl: `https://solscan.io/account/${vault}`,
        linkLabel: "View vault",
        timestamp: 0,
        claimAt: "pump.fun (your profile → creator rewards)",
        minUsd: 1,
        note: `Trades of the coins this wallet created on pump.fun paid it ${formatAmount(curveFees, 9)} SOL in creator fees, waiting in its creator vault until collected. Nothing is sent automatically.`,
      }),
    );
  // A token account: mint (32 bytes), owner (32), then the amount (u64).
  const swapData = swapAccount && Uint8Array.from(atob(swapAccount.data[0]), (ch) => ch.charCodeAt(0));
  const swapFees = swapData && swapData.length >= 72 ? new DataView(swapData.buffer).getBigUint64(64, true) : 0n;
  if (swapFees > 0n)
    findings.push(
      makeFinding(PUMP_FEES, {
        key: "pumpswap",
        label: "PumpSwap creator fees",
        status: "ready",
        asset: sol(swapFees),
        txHash: swapVault,
        txUrl: `https://solscan.io/account/${swapVault}`,
        linkLabel: "View vault",
        timestamp: 0,
        claimAt: "pump.fun (your profile → creator rewards)",
        minUsd: 1,
        note: `Coins this wallet created moved from pump.fun to PumpSwap, where their trades paid it ${formatAmount(swapFees, 9)} SOL (as wrapped SOL) in creator fees. They wait in its PumpSwap creator vault until collected.`,
      }),
    );
  return { findings, completed: 0 };
}
