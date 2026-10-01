import { encodeFunctionData, parseAbi, zeroAddress, type Address, type Hex } from "viem";
import { l1Client } from "../clients";
import { addPrices } from "../tokens";
import type { Asset } from "../types";
import { bulkRead } from "./bulk";
import { makeFinding, type CheckOutput, type FindingSource } from "./common";
import { DEPOSIT_TOKENS } from "./exchange-tokens";
import { wouldSucceed } from "./simulate";

/**
 * Old exchanges that kept their users' deposits in their own contract (2016–2020). Whatever a user
 * never withdrew is still there, and these contracts let the user withdraw it without the operator:
 *   - EtherDelta and its clones (Token.Store, SingularX): withdraw(amount) for ETH and
 *     withdrawToken(token, amount) for tokens, at any time.
 *   - IDEX v1: withdraw(token, amount), once the account has been inactive for
 *     `inactivityReleasePeriod` blocks (240 blocks, under an hour).
 *   - Switcheo (BrokerV2): announceWithdraw(asset, amount), then slowWithdraw(user, asset, amount)
 *     once `slowWithdrawDelay` has passed (0 since the exchange closed, at most 7 days).
 *
 * The contracts can't list a user's tokens, and most don't index their events by user, so the check
 * reads the balance of ETH and of every token worth checking (DEPOSIT_TOKENS) in a single multicall,
 * then simulates withdrawing (for Switcheo, announcing) each balance from the user's own address.
 */

export const LEGACY_GUIDE = "legacy-deposits";
const MIN_USD = 5;

export interface DepositExchange {
  id: string;
  name: string;
  kind: "etherdelta" | "idex" | "switcheo";
  /**
   * The exchange's contracts (several versions for EtherDelta), with their letter in DEPOSIT_TOKENS
   * and the official withdrawal app that still serves that contract, if any.
   */
  contracts: { address: Address; tokens: string; app?: string }[];
}

export const DEPOSIT_EXCHANGES: DepositExchange[] = [
  {
    id: "etherdelta",
    name: "EtherDelta",
    kind: "etherdelta",
    contracts: [
      // Since Feb 2017, also used by ForkDelta, whose site kept a withdrawal tool when it shut down (Dec 2022).
      { address: "0x8d12A197cB00D4747a1fe03395095ce2A5CC6819", tokens: "e", app: "forkdelta.app/shutdown/withdraw" },
      { address: "0x373C55C277b866A69dC047cAd488154AB9759466", tokens: "o" }, // Oct 2016
      { address: "0x4aEa7cf559F67ceDCAD07E12aE6bc00F07E8cf65", tokens: "o" }, // Aug 2016
      { address: "0x2136bbBa2eDcA21AFDddee838fFf19eA70D10F03", tokens: "o" }, // Aug 2016
      { address: "0xc6b330dF38D6eF288C953F1F2835723531073CE2", tokens: "o" }, // Jul 2016
    ],
  },
  {
    id: "idex",
    name: "IDEX v1",
    kind: "idex",
    contracts: [{ address: "0x2a0c0DBEcC7E4D658f48E01e3fA353F44050c208", tokens: "i" }],
  },
  {
    id: "tokenstore",
    name: "Token.Store",
    kind: "etherdelta",
    contracts: [{ address: "0x1cE7AE555139c5EF5A57CC8d814a867ee6Ee33D8", tokens: "t" }],
  },
  {
    id: "singularx",
    name: "SingularX",
    kind: "etherdelta",
    contracts: [{ address: "0x9a2d163aB40F88C625Fd475e807Bbc3556566f80", tokens: "s" }],
  },
  {
    id: "switcheo",
    name: "Switcheo",
    kind: "switcheo",
    contracts: [{ address: "0x7ee7Ca6E75dE79e618e88bDf80d0B1DB136b22D0", tokens: "w" }],
  },
];

const abi = parseAbi([
  "function balanceOf(address token, address user) view returns (uint256)",
  // EtherDelta and clones
  "function withdraw(uint256 amount)",
  "function withdrawToken(address token, uint256 amount)",
]);
const idexAbi = parseAbi(["function withdraw(address token, uint256 amount) returns (bool)"]);
const switcheoAbi = parseAbi([
  "function balances(address user, address assetId) view returns (uint256)",
  "function slowWithdrawDelay() view returns (uint256)",
  "function announceWithdraw(address _assetId, uint256 _amount)",
]);

/** Where to withdraw, shown as text: the official app if one is left, and Etherscan's Write Contract tab. */
export const exchangeClaimAt = (contract: Address, fn: string, app?: string) =>
  `${app ? `${app}, or ` : ""}Etherscan → Write Contract → ${fn}, on ${contract}`;

/** Switcheo's wait between announcing and withdrawing, in words. */
const wait = (seconds: bigint) => (seconds === 0n ? "right after" : `${Math.ceil(Number(seconds) / 3600)} hours after`);

/** The call that withdraws a whole balance, as Etherscan's Write Contract tab asks for it. */
function withdrawal(kind: DepositExchange["kind"], token: Address, amount: bigint, user: Address, delay: bigint): { data: Hex; fn: string; how: string } {
  if (kind === "switcheo")
    // Only the announcement can be simulated now: the withdrawal needs it on-chain first.
    return {
      data: encodeFunctionData({ abi: switcheoAbi, functionName: "announceWithdraw", args: [token, amount] }),
      fn: "announceWithdraw, then slowWithdraw",
      how: `announceWithdraw with assetId ${token}${token === zeroAddress ? " (ETH)" : ""} and amount ${amount}, then, ${wait(delay)}, slowWithdraw with withdrawer ${user}, the same assetId and amount`,
    };
  if (kind === "idex")
    return {
      data: encodeFunctionData({ abi: idexAbi, functionName: "withdraw", args: [token, amount] }),
      fn: "withdraw",
      how: `withdraw with token ${token}${token === zeroAddress ? " (ETH)" : ""} and amount ${amount}`,
    };
  if (token === zeroAddress)
    return { data: encodeFunctionData({ abi, functionName: "withdraw", args: [amount] }), fn: "withdraw", how: `withdraw with amount ${amount}` };
  return {
    data: encodeFunctionData({ abi, functionName: "withdrawToken", args: [token, amount] }),
    fn: "withdrawToken",
    how: `withdrawToken with token ${token} and amount ${amount}`,
  };
}

/** One exchange's balances for `user`, with each withdrawal simulated from the user's address. */
export async function checkExchange(ex: DepositExchange, user: Address): Promise<CheckOutput> {
  const source: FindingSource = { id: ex.id, name: ex.name, guideId: LEGACY_GUIDE, explorer: "https://etherscan.io" };
  const reads = ex.contracts.flatMap(({ address, tokens, app }) => [
    { contract: address, app, token: zeroAddress as Address, symbol: "ETH", decimals: 18 },
    ...DEPOSIT_TOKENS.filter(([, , , on]) => [...tokens].some((t) => on.includes(t))).map(([token, symbol, decimals]) => ({
      contract: address,
      app,
      token,
      symbol,
      decimals,
    })),
  ]);
  // One eth_call for every balance (and Switcheo's announce-to-withdraw delay).
  const switcheo = ex.kind === "switcheo";
  const balances = await bulkRead([
    ...reads.map((r) =>
      switcheo
        ? { address: r.contract, abi: switcheoAbi, functionName: "balances", args: [user, r.token] }
        : { address: r.contract, abi, functionName: "balanceOf", args: [r.token, user] },
    ),
    ...(switcheo ? [{ address: ex.contracts[0].address, abi: switcheoAbi, functionName: "slowWithdrawDelay" }] : []),
  ]);
  const delay = switcheo ? (balances[reads.length] as bigint) : 0n;
  const held = reads
    .map((r, i) => ({ ...r, amount: balances[i] as bigint }))
    .filter((r) => r.amount > 0n)
    .map((r) => ({
      ...r,
      asset: (r.token === zeroAddress
        ? { symbol: "ETH", decimals: 18, amount: r.amount }
        : { symbol: r.symbol, decimals: r.decimals, amount: r.amount, token: r.token, tokenChain: "ethereum" }) as Asset,
    }));
  if (!held.length) return { findings: [], completed: 0 };

  // Dust isn't worth a simulation (and would be hidden anyway); unpriced balances are kept.
  await addPrices(held.map((h) => h.asset));
  const worth = held.filter((h) => h.asset.usd === undefined || h.asset.usd >= MIN_USD);

  const out: CheckOutput = { findings: [], completed: 0 };
  const errors: string[] = [];
  await Promise.all(
    worth.map(async (h) => {
      const w = withdrawal(ex.kind, h.token, h.amount, user, delay);
      let ok: boolean;
      try {
        ok = await wouldSucceed(l1Client(), { from: user, to: h.contract, data: w.data });
      } catch (e) {
        errors.push(`${h.symbol}: ${(e as Error).message.split("\n")[0]}`);
        return;
      }
      if (!ok) return; // the contract refuses it (token paused, contract wallet that can't take ETH…)
      const intro =
        ex.kind === "idex"
          ? `IDEX v1 isn't operated anymore, but this ${h.symbol} is still in its contract, and the contract lets you withdraw it without IDEX.`
          : ex.kind === "switcheo"
            ? `This ${h.symbol} was left on Switcheo's Ethereum contract. Its escape hatch lets you withdraw it without Switcheo, in two transactions.`
            : `This ${h.symbol} was left on ${ex.name} and never withdrawn. The contract lets you withdraw it at any time, no app needed.`;
      out.findings.push(
        makeFinding(source, {
          key: h.token,
          label: ex.name,
          status: "ready",
          asset: h.asset,
          txHash: h.contract,
          txUrl: `https://etherscan.io/address/${h.contract}#writeContract`,
          linkLabel: "Open the contract",
          timestamp: 0,
          note: `${intro} ${h.app ? `Withdraw it at ${h.app}, or on Etherscan: open` : "On Etherscan, open"} the contract's Write Contract tab, connect this wallet and call ${w.how}.`,
          claimAt: exchangeClaimAt(h.contract, w.fn, h.app),
          minUsd: MIN_USD,
        }),
      );
    }),
  );
  if (errors.length) out.error = `withdrawal check failed: ${errors.join(" · ")}`;
  return out;
}
