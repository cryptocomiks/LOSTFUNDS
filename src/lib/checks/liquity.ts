import { encodeFunctionData, parseAbi, zeroAddress, type Address } from "viem";
import { l1Client } from "../clients";
import { formatAmount } from "../format";
import type { Asset, Finding } from "../types";
import { makeFinding, type CheckOutput } from "./common";
import { DUST_ETHEREUM, dryRun, ETHERSCAN, rewardSource } from "./claims";

/**
 * Liquity v1 (Ethereum), three places where ETH and tokens wait for their owner:
 *  - CollSurplusPool: when a trove is redeemed against, or liquidated in Recovery Mode, the
 *    collateral above its debt is set aside for the owner, who must claim it
 *    (BorrowerOperations.claimCollateral). Nothing is sent automatically: 2,200 ETH were
 *    waiting there in November 2026, for about 200 accounts.
 *  - Stability Pool: ETH from liquidations and LQTY rewards, paid on withdrawFromSP.
 *  - LQTY staking: ETH and LUSD fees, paid on unstake.
 * Troves were often opened through a DSProxy (DeFi Saver, Maker-style frontends) or an
 * Instadapp account (DSA): the user's DSProxy, from Maker's ProxyRegistry, and their DSAs,
 * from InstaList, are checked too. One multicall of views per account; each amount is
 * reported once the claim simulates from the account that holds it.
 */

export const LIQUITY = rewardSource("liquity", "Liquity");

const BORROWER_OPERATIONS: Address = "0x24179CD81c9e782A4096035f7eC97fB8B783e007";
const COLL_SURPLUS_POOL: Address = "0x3D32e8b97Ed5881324241Cf03b2DA5E2EBcE5521";
const STABILITY_POOL: Address = "0x66017D22b0f8556afDd19FC67041899Eb65a21bb";
const LQTY_STAKING: Address = "0x4f9Fbb3f1E99B56e0Fe2892e623Ed36A76Fc605d";
/** Maker's DSProxy registry: one proxy per wallet, used by DeFi Saver and others. */
const PROXY_REGISTRY: Address = "0x4678f0a6958e4D2Bc4F1BAF7Bc52E8F3564f3fE4";
/** Instadapp's registry of DSAs (smart accounts) and the wallets that control them. */
const INSTA_LIST: Address = "0x4c8a1BEb8a87765788946D6B19C6C6355194AbEb";
/** More DSAs than this for one wallet: only the first ones are checked. */
const MAX_DSAS = 10;

const ETH = (amount: bigint): Asset => ({ symbol: "ETH", decimals: 18, amount });
const LQTY = (amount: bigint): Asset => ({ symbol: "LQTY", decimals: 18, amount, token: "0x6DEA81C8171D0bA574754EF6F8b412F2Ed88c54D", tokenChain: "ethereum" });
const LUSD = (amount: bigint): Asset => ({ symbol: "LUSD", decimals: 18, amount, token: "0x5f98805A4E8be255a32880FDeC7F6728C6568bA0", tokenChain: "ethereum" });

const abi = parseAbi([
  "function getCollateral(address _account) view returns (uint256)",
  "function getDepositorETHGain(address _depositor) view returns (uint256)",
  "function getDepositorLQTYGain(address _depositor) view returns (uint256)",
  "function getPendingETHGain(address _user) view returns (uint256)",
  "function getPendingLUSDGain(address _user) view returns (uint256)",
  "function claimCollateral()",
  "function withdrawFromSP(uint256 _amount)",
  "function unstake(uint256 _LQTYamount)",
]);
const registryAbi = parseAbi(["function proxies(address) view returns (address)"]);
const instaAbi = parseAbi([
  "function userLink(address) view returns (uint64 first, uint64 last, uint64 count)",
  "function userList(address, uint64) view returns (uint64 prev, uint64 next)",
  "function accountAddr(uint64) view returns (address)",
]);

export type Kind = "wallet" | "dsproxy" | "dsa";
const VIA: Record<Kind, string> = {
  wallet: "",
  dsproxy: " through your DSProxy",
  dsa: " through your Instadapp account",
};
const APP: Record<Kind, string> = {
  wallet: "Etherscan (Liquity BorrowerOperations → claimCollateral)",
  dsproxy: "the app that opened the trove (e.g. DeFi Saver)",
  dsa: "instadapp.io",
};

/** The user's wallet, their DSProxy and their Instadapp accounts, the ways a Liquity position could be held. */
export async function accountsOf(user: Address): Promise<{ address: Address; kind: Kind }[]> {
  const c = l1Client();
  const [proxy, link] = await Promise.all([
    c.readContract({ address: PROXY_REGISTRY, abi: registryAbi, functionName: "proxies", args: [user] }),
    c.readContract({ address: INSTA_LIST, abi: instaAbi, functionName: "userLink", args: [user] }),
  ]);
  const ids: bigint[] = [];
  for (let id = link[0]; id !== 0n && ids.length < Math.min(Number(link[2]), MAX_DSAS); ) {
    ids.push(id);
    [, id] = await c.readContract({ address: INSTA_LIST, abi: instaAbi, functionName: "userList", args: [user, id] });
  }
  const dsas = await Promise.all(ids.map((id) => c.readContract({ address: INSTA_LIST, abi: instaAbi, functionName: "accountAddr", args: [id] })));
  const out: { address: Address; kind: Kind }[] = [{ address: user, kind: "wallet" }];
  if (proxy !== zeroAddress) out.push({ address: proxy, kind: "dsproxy" });
  for (const a of dsas) if (a !== zeroAddress) out.push({ address: a, kind: "dsa" });
  return out.filter((a, i) => out.findIndex((b) => b.address.toLowerCase() === a.address.toLowerCase()) === i);
}

export async function checkLiquity(user: Address): Promise<CheckOutput> {
  const c = l1Client();
  const accounts = await accountsOf(user);
  const read = (address: Address, functionName: "getCollateral" | "getDepositorETHGain" | "getDepositorLQTYGain" | "getPendingETHGain" | "getPendingLUSDGain", account: Address) =>
    c.readContract({ address, abi, functionName, args: [account] });
  const views = await Promise.all(
    accounts.map(({ address: a }) =>
      Promise.all([
        read(COLL_SURPLUS_POOL, "getCollateral", a),
        read(STABILITY_POOL, "getDepositorETHGain", a),
        read(STABILITY_POOL, "getDepositorLQTYGain", a),
        read(LQTY_STAKING, "getPendingETHGain", a),
        read(LQTY_STAKING, "getPendingLUSDGain", a),
      ]),
    ),
  );

  const findings: Finding[] = [];
  await Promise.all(
    accounts.map(async ({ address: account, kind }, i) => {
      const [surplus, spEth, spLqty, stakeEth, stakeLusd] = views[i];
      const owner = kind === "wallet" ? "" : ` (held by ${account})`;
      const finding = (key: string, label: string, contract: Address, asset: Asset, note: string, claimAt: string) =>
        makeFinding(LIQUITY, {
          key: `${key}:${account}`,
          label,
          status: "ready",
          asset,
          txHash: contract,
          txUrl: `${ETHERSCAN}/address/${contract}#writeContract`,
          linkLabel: "View contract",
          timestamp: 0,
          claimAt,
          minUsd: DUST_ETHEREUM,
          note,
        });
      const [surplusOk, spOk, stakeOk] = await Promise.all([
        surplus > 0n ? dryRun(c, { from: account, to: BORROWER_OPERATIONS, data: encodeFunctionData({ abi, functionName: "claimCollateral" }) }) : null,
        spEth > 0n || spLqty > 0n ? dryRun(c, { from: account, to: STABILITY_POOL, data: encodeFunctionData({ abi, functionName: "withdrawFromSP", args: [0n] }) }) : null,
        stakeEth > 0n || stakeLusd > 0n ? dryRun(c, { from: account, to: LQTY_STAKING, data: encodeFunctionData({ abi, functionName: "unstake", args: [0n] }) }) : null,
      ]);
      if (surplusOk !== null)
        findings.push(
          finding(
            "surplus",
            "Liquity: collateral left after your trove closed",
            BORROWER_OPERATIONS,
            ETH(surplus),
            `A Liquity trove you opened${VIA[kind]}${owner} was redeemed against or liquidated in Recovery Mode, and the ${formatAmount(surplus, 18)} ETH of collateral above its debt was set aside for you. Liquity never sends it: it waits until claimCollateral() is called${kind === "wallet" ? " from this address" : " from that account"}.`,
            APP[kind],
          ),
        );
      if (spOk !== null)
        for (const [asset, what] of [
          [ETH(spEth), "ETH from liquidations"],
          [LQTY(spLqty), "LQTY rewards"],
        ] as const)
          if (asset.amount > 0n)
            findings.push(
              finding(
                `sp-${asset.symbol}`,
                "Liquity Stability Pool",
                STABILITY_POOL,
                asset,
                `Your LUSD deposit in Liquity's Stability Pool${VIA[kind]}${owner} earned ${formatAmount(asset.amount, 18)} ${asset.symbol} (${what}) that were never claimed. Withdrawing from the pool, even 0 LUSD, pays them out.`,
                kind === "wallet" ? "a Liquity frontend, or Etherscan (StabilityPool → withdrawFromSP with 0)" : APP[kind],
              ),
            );
      if (stakeOk !== null)
        for (const asset of [ETH(stakeEth), LUSD(stakeLusd)])
          if (asset.amount > 0n)
            findings.push(
              finding(
                `staking-${asset.symbol}`,
                "Liquity LQTY staking",
                LQTY_STAKING,
                asset,
                `Staking LQTY${VIA[kind]}${owner} earned ${formatAmount(asset.amount, 18)} ${asset.symbol} in protocol fees that were never claimed. Unstaking, even 0 LQTY, pays them out.`,
                kind === "wallet" ? "a Liquity frontend, or Etherscan (LQTYStaking → unstake with 0)" : APP[kind],
              ),
            );
    }),
  );
  return { findings, completed: 0 };
}
