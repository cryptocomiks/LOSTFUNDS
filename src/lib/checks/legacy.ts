import { encodeFunctionData, erc20Abi, getAddress, multicall3Abi, parseAbi, type Abi, type Address, type Hex } from "viem";
import { l1Client } from "../clients";
import { formatAmount } from "../format";
import type { Asset, WithdrawalStatus } from "../types";
import type { CheckOutput, FindingSource } from "./common";
import { makeFinding } from "./common";

/**
 * Old tokens that are worth much more redeemed or migrated through their official contract,
 * which is still open (checked on-chain), but have no real market any more. One multicall reads every
 * balance and the state of every contract for all of them; a holder's claim is then dry-run from
 * their own address (eth_simulateV1).
 *
 * Left out on purpose (checked Oct 1, 2026): LEND → AAVE (closed May 9, 2026), REP v1 (Augur's
 * genesis universe forked; the way to today's REP closed Aug 3, 2026), Aragon ANT → ETH (ended
 * Nov 2, 2024), AGIX → FET (migration contract emptied), and tokens that still trade at full value
 * (MATIC, MKR → SKY, OCEAN, TRIBE, RNDR, FEI).
 */

const MULTICALL3: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";
const WETH: Address = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const WAD = 10n ** 18n;
const RAY = 10n ** 27n;
const wmul = (x: bigint, y: bigint) => (x * y + WAD / 2n) / WAD;
const rmul = (x: bigint, y: bigint) => (x * y + RAY / 2n) / RAY;

const DAO: Address = "0xBB9bc244D798123fDe783fCc1C72d3Bb8C189413";
const WITHDRAW_DAO: Address = "0xBf4eD7b27F1d666546E30D74d50d173d20bca754";
const EXTRA_BALANCE: Address = "0x5c40eF6f527f4FbA68368774E6130cE6515123f2";
const EXTRA_BALANCE_REFUND: Address = "0x755cdba6AE4F479f7164792B318b2a06c759833B";
const SAI: Address = "0x89d24A6b4CcB1B6fAA2625fE562bDD9a23260359";
const SAI_TAP: Address = "0xBda109309f9FafA6Dd6A9CB9f1Df4085B27Ee8eF";
const PETH: Address = "0xf53AD2c6851052A81B42133467480961B2321C09";
const SAI_TUB: Address = "0x448a5065aeBB8E423F0896E6c5D525C040f59af3";
const MKR_2016: Address = "0xC66eA802717bFb9833400264Dd12c2bCeAa34a6d";
const MKR_REDEEMER: Address = "0x642AE78FAfBB8032Da552D619aD43F1D81E4DD7C";
const MKR: Address = "0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2";
const DGD: Address = "0xE0B7927c4aF23765Cb51314A0E0521A9645F0E2A";
const DGD_ACID: Address = "0x23Ea10CC1e6EBdB499D24E45369A35f43627062f";
const GNT: Address = "0xa74476443119A942dE498590Fe1f2454d7D4aC0d";
const GNT_AGENT: Address = "0xBFAd98d76598961827bA832108c21445aa4FEE9A";
const GLM: Address = "0x7DD9c5Cba05E151C895FDe1CF355C9A1D5DA6429";
const KNCL: Address = "0xdd974D5C2e2928deA5F71b9825b8b646686BD200";
const KNC: Address = "0xdeFA4e8a7bcBA345F687a2f1456F5Edd9CE97202";
const W_ETH_2016: Address = "0xECF8F87f810EcF450940c9f60066b4a7a501d6A7";
const WETH_0X_2017: Address = "0x2956356cD2a2bf3202F771F50D3D14A367b48070";
const ETH_BANCOR_2017: Address = "0xD76b5c2A23ef78368d8E34288B5b65D616B746aE";

const legacyAbi = parseAbi([
  "function approve(address, uint256) returns (bool)",
  "function withdraw()",
  "function withdraw(uint256)",
  "function off() view returns (bool)",
  "function out() view returns (bool)",
  "function fix() view returns (uint256)",
  "function per() view returns (uint256)",
  "function gap() view returns (uint256)",
  "function cash(uint256)",
  "function exit(uint256)",
  "function stopped() view returns (bool)",
  "function redeem()",
  "function isInitialized() view returns (bool)",
  "function weiPerNanoDGD() view returns (uint256)",
  "function burn() returns (bool)",
  "function migrationAgent() view returns (address)",
  "function target() view returns (address)",
  "function migrate(uint256)",
  "function oldKNC() view returns (address)",
  "function mintWithOldKnc(uint256)",
]);

interface Read {
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
}
const view = (address: Address, functionName: string): Read => ({ address, abi: legacyAbi, functionName });
const balanceOf = (token: Address, who: Address): Read => ({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [who] });
const ethBalance = (who: Address): Read => ({ address: MULTICALL3, abi: multicall3Abi, functionName: "getEthBalance", args: [who] });

/** State of the official contracts, read in the same multicall as the balances. */
const STATE = {
  withdrawDaoEth: ethBalance(WITHDRAW_DAO),
  extraBalanceEth: ethBalance(EXTRA_BALANCE_REFUND),
  tapOff: view(SAI_TAP, "off"),
  tapFix: view(SAI_TAP, "fix"),
  tapWeth: balanceOf(WETH, SAI_TAP),
  tubOut: view(SAI_TUB, "out"),
  tubPer: view(SAI_TUB, "per"),
  tubGap: view(SAI_TUB, "gap"),
  tubWeth: balanceOf(WETH, SAI_TUB),
  redeemerStopped: view(MKR_REDEEMER, "stopped"),
  redeemerMkr: balanceOf(MKR, MKR_REDEEMER),
  acidReady: view(DGD_ACID, "isInitialized"),
  acidRate: view(DGD_ACID, "weiPerNanoDGD"),
  acidEth: ethBalance(DGD_ACID),
  gntAgent: view(GNT, "migrationAgent"),
  gntTarget: view(GNT_AGENT, "target"),
  kncOld: view(KNC, "oldKNC"),
  wEth2016Eth: ethBalance(W_ETH_2016),
  weth0xEth: ethBalance(WETH_0X_2017),
  ethBancorEth: ethBalance(ETH_BANCOR_2017),
} satisfies Record<string, Read>;
type StateKey = keyof typeof STATE;
type State = { [K in StateKey]: unknown };

/** What a claim of `balance` old tokens pays right now. */
interface Quote {
  amount: bigint;
  /** "closed": the official contract no longer converts this token (nothing to show). "manual": it can't pay all of it right now. */
  status: "ready" | "manual" | "closed";
  note?: string;
}

interface Redemption {
  key: string;
  /** Shown as the finding's title. */
  label: string;
  token: Address;
  symbol: string;
  decimals: number;
  /** The contract state `quote` reads. */
  needs: StateKey[];
  quote: (balance: bigint, s: State) => Quote;
  /** What the claim pays, in its own units. */
  asset: (amount: bigint) => Asset;
  claimAt: string;
  /** Link shown as "View contract": the contract to call. */
  txUrl: string;
  /** `had` and `get` are formatted amounts ("1,000 DAO", "10 ETH"). */
  note: (had: string, get: string) => string;
  /** The claim, as sent from the holder's wallet (an approval first when the contract pulls the tokens). */
  calls: (balance: bigint) => { to: Address; data: Hex }[];
}

export interface LegacyEntry {
  id: string;
  /** Name in the checker grid. */
  name: string;
  redemptions: Redemption[];
}

const eth = (amount: bigint): Asset => ({ symbol: "ETH", decimals: 18, amount });
const weth = (amount: bigint): Asset => ({ symbol: "WETH", decimals: 18, amount, token: WETH, tokenChain: "ethereum" });
const etherscan = (a: Address, write = true) => `https://etherscan.io/address/${a}${write ? "#writeContract" : ""}`;
const tx = (to: Address, functionName: string, args: readonly unknown[] = []) =>
  ({ to, data: encodeFunctionData({ abi: legacyAbi, functionName, args } as never) }) as { to: Address; data: Hex };
/** Some 2016-era tokens refuse to change an allowance that isn't 0: reset it first, as a wallet would. */
const approve = (token: Address, spender: Address, amount: bigint) => [tx(token, "approve", [spender, 0n]), tx(token, "approve", [spender, amount])];
/** Paid from a reserve the contract holds: all of it, or a manual check when the reserve is short. */
const fromReserve = (amount: bigint, reserve: unknown, what: string, then = "Check it before sending anything."): Quote =>
  (reserve as bigint) >= amount
    ? { amount, status: "ready" }
    : { amount, status: "manual", note: `${what} holds less than this right now, so the claim would fail. ${then}` };

/** Old ETH wrappers from before today's WETH (Dec 2017): their contracts still hold the ETH, 1:1. */
const wrapper = (key: string, label: string, token: Address, reserve: StateKey, about: string, verified: boolean): Redemption => ({
  key,
  label,
  token,
  symbol: "ETH token",
  decimals: 18,
  needs: [reserve],
  quote: (balance, s) => fromReserve(balance, s[reserve], "The contract"),
  asset: eth,
  claimAt: "the token contract (withdraw, with your full balance in wei)",
  txUrl: etherscan(token, verified),
  note: (_had, get) => `This wallet holds ${get} wrapped in ${about}, not today's WETH. Its contract still holds the ETH and gives it back 1:1: call withdraw with your balance.`,
  calls: (balance) => [tx(token, "withdraw", [balance])],
});

export const LEGACY_LIST: LegacyEntry[] = [
  {
    id: "thedao",
    name: "The DAO",
    redemptions: [
      {
        key: "dao",
        label: "The DAO refund",
        token: DAO,
        symbol: "DAO",
        decimals: 16,
        needs: ["withdrawDaoEth"],
        // 1 DAO (10^16 units) = 0.01 ETH (10^16 wei): withdraw() pays the balance in wei.
        quote: (balance, s) => fromReserve(balance, s.withdrawDaoEth, "The WithdrawDAO contract"),
        asset: eth,
        claimAt: "the WithdrawDAO contract on Etherscan (approve your DAO tokens to it, then withdraw)",
        txUrl: etherscan(WITHDRAW_DAO),
        note: (had, get) =>
          `${had} tokens from 2016 are still redeemable for ${get} (100 DAO = 1 ETH) through the WithdrawDAO contract created by the hard fork. It holds the ETH for every DAO token left, has no deadline, and TheDAO Security Fund can't touch it.`,
        calls: (balance) => [...approve(DAO, WITHDRAW_DAO, balance), tx(WITHDRAW_DAO, "withdraw")],
      },
      {
        key: "extrabalance",
        label: "TheDAO ExtraBalance refund",
        token: EXTRA_BALANCE,
        symbol: "ExtraBalance tokens",
        decimals: 18,
        needs: ["extraBalanceEth"],
        quote: (balance, s) =>
          fromReserve(balance, s.extraBalanceEth, "The ExtraBalance withdrawal contract", "TheDAO Security Fund tops it up: ask them through thedao.fund before sending anything."),
        asset: eth,
        claimAt: "the ExtraBalance withdrawal contract (approve your ExtraBalance tokens to it, then withdraw)",
        txUrl: etherscan(EXTRA_BALANCE_REFUND, false),
        note: (had, get) =>
          `${had} are refunds of what was paid above 1 ETH per 100 DAO in 2016's sale: ${get}, 1 ETH per token, from the ExtraBalance withdrawal contract. TheDAO Security Fund keeps it funded for claims.`,
        calls: (balance) => [...approve(EXTRA_BALANCE, EXTRA_BALANCE_REFUND, balance), tx(EXTRA_BALANCE_REFUND, "withdraw")],
      },
    ],
  },
  {
    id: "sai",
    name: "Maker SAI/PETH",
    redemptions: [
      {
        key: "sai",
        label: "Maker SAI redemption",
        token: SAI,
        symbol: "SAI",
        decimals: 18,
        needs: ["tapOff", "tapFix", "tapWeth"],
        quote: (balance, s) => {
          if (s.tapOff !== true) return { amount: 0n, status: "closed" };
          return fromReserve(rmul(balance, s.tapFix as bigint), s.tapWeth, "The SaiTap contract");
        },
        asset: weth,
        claimAt: "the SaiTap contract on Etherscan (approve your SAI to it, then cash)",
        txUrl: etherscan(SAI_TAP),
        note: (had, get) =>
          `Single-Collateral Dai was shut down in May 2020 and SAI has no real market left, but the SaiTap contract still pays a fixed share of ETH for every SAI: ${had} → ${get}, which unwraps 1:1 to ETH. There is no deadline.`,
        calls: (balance) => [...approve(SAI, SAI_TAP, balance), tx(SAI_TAP, "cash", [balance])],
      },
      {
        key: "peth",
        label: "Maker PETH redemption",
        token: PETH,
        symbol: "PETH",
        decimals: 18,
        needs: ["tubOut", "tubPer", "tubGap", "tubWeth"],
        quote: (balance, s) => {
          if (s.tubOut !== true) return { amount: 0n, status: "closed" };
          const amount = rmul(balance, wmul(s.tubPer as bigint, 2n * WAD - (s.tubGap as bigint)));
          return fromReserve(amount, s.tubWeth, "The SaiTub contract");
        },
        asset: weth,
        claimAt: "the SaiTub contract on Etherscan (approve your PETH to it, then exit)",
        txUrl: etherscan(SAI_TUB),
        note: (had, get) =>
          `PETH is the pooled ETH of Maker's first system (Single-Collateral Dai), shut down in May 2020. The SaiTub contract still turns ${had} back into ${get}, which unwraps 1:1 to ETH. There is no deadline.`,
        calls: (balance) => [...approve(PETH, SAI_TUB, balance), tx(SAI_TUB, "exit", [balance])],
      },
    ],
  },
  {
    id: "mkr-2016",
    name: "MKR (2016)",
    redemptions: [
      {
        key: "mkr-2016",
        label: "Old MKR (2016) redemption",
        token: MKR_2016,
        symbol: "old MKR",
        decimals: 18,
        needs: ["redeemerStopped", "redeemerMkr"],
        quote: (balance, s) => {
          if (s.redeemerStopped !== false) return { amount: 0n, status: "closed" };
          return fromReserve(balance, s.redeemerMkr, "The MKR Redeemer");
        },
        asset: (amount) => ({ symbol: "MKR", decimals: 18, amount, token: MKR, tokenChain: "ethereum" }),
        claimAt: "the MKR Redeemer contract on Etherscan (approve your old MKR to it, then redeem)",
        txUrl: etherscan(MKR_REDEEMER),
        note: (had, get) =>
          `Maker replaced its original 2016 MKR token in December 2017, and the old one no longer trades. Its Redeemer contract still swaps ${had} for ${get}, 1:1, with no deadline (you can then keep the MKR, sell it, or upgrade it to SKY).`,
        calls: (balance) => [...approve(MKR_2016, MKR_REDEEMER, balance), tx(MKR_REDEEMER, "redeem")],
      },
    ],
  },
  {
    id: "dgd",
    name: "DigixDAO (DGD)",
    redemptions: [
      {
        key: "dgd",
        label: "DigixDAO DGD refund",
        token: DGD,
        symbol: "DGD",
        decimals: 9,
        needs: ["acidReady", "acidRate", "acidEth"],
        quote: (balance, s) => {
          if (s.acidReady !== true) return { amount: 0n, status: "closed" };
          return fromReserve(balance * (s.acidRate as bigint), s.acidEth, "DigixDAO's Acid contract");
        },
        asset: eth,
        claimAt: "the Acid contract on Etherscan (approve your DGD to it, then burn)",
        txUrl: etherscan(DGD_ACID),
        note: (had, get) =>
          `DigixDAO dissolved in 2020 and DGD no longer trades, but its Acid refund contract still pays 0.193 ETH per DGD: ${had} → ${get}. burn() takes the whole DGD balance and sends the ETH back in the same transaction.`,
        calls: (balance) => [...approve(DGD, DGD_ACID, balance), tx(DGD_ACID, "burn")],
      },
    ],
  },
  {
    id: "gnt",
    name: "Golem (GNT)",
    redemptions: [
      {
        key: "gnt",
        label: "Golem GNT → GLM migration",
        token: GNT,
        symbol: "GNT",
        decimals: 18,
        needs: ["gntAgent", "gntTarget"],
        quote: (balance, s) =>
          getAddress(s.gntAgent as Address) === GNT_AGENT && getAddress(s.gntTarget as Address) === GLM
            ? { amount: balance, status: "ready" }
            : { amount: 0n, status: "closed" },
        asset: (amount) => ({ symbol: "GLM", decimals: 18, amount, token: GLM, tokenChain: "ethereum" }),
        claimAt: "migrate.golem.network, or migrate on the GNT contract on Etherscan",
        txUrl: etherscan(GNT),
        note: (had, get) =>
          `Golem replaced GNT with GLM in November 2020, and GNT no longer trades. The migration is still open, 1:1 with no deadline: ${had} → ${get}, in one transaction, without an approval.`,
        calls: (balance) => [tx(GNT, "migrate", [balance])],
      },
    ],
  },
  {
    id: "kncl",
    name: "Kyber (KNCL)",
    redemptions: [
      {
        key: "kncl",
        label: "Kyber KNCL → KNC migration",
        token: KNCL,
        symbol: "KNCL",
        decimals: 18,
        needs: ["kncOld"],
        quote: (balance, s) =>
          getAddress(s.kncOld as Address) === KNCL ? { amount: balance, status: "ready" } : { amount: 0n, status: "closed" },
        asset: (amount) => ({ symbol: "KNC", decimals: 18, amount, token: KNC, tokenChain: "ethereum" }),
        claimAt: "kyberswap.com/kyberdao/stake-knc (Migrate), or mintWithOldKnc on the KNC contract on Etherscan",
        txUrl: etherscan(KNC),
        note: (had, get) =>
          `Kyber replaced KNC Legacy (KNCL) with today's KNC in 2021, and KNCL has no market left. The migration is still open, 1:1 with no deadline: ${had} → ${get}.`,
        calls: (balance) => [...approve(KNCL, KNC, balance), tx(KNC, "mintWithOldKnc", [balance])],
      },
    ],
  },
  {
    id: "weth-old",
    name: "Old wrapped ETH",
    redemptions: [
      wrapper("w-eth-2016", "Old wrapped ETH (W-ETH, 2016)", W_ETH_2016, "wEth2016Eth", "W-ETH, the 2016 ETH wrapper of Maker's first exchange (OasisDEX)", false),
      wrapper("weth-0x-2017", "Old wrapped ETH (0x WETH, 2017)", WETH_0X_2017, "weth0xEth", "the 2017 WETH of 0x's first exchange contracts", true),
      wrapper("eth-bancor-2017", "Old wrapped ETH (Bancor, 2017)", ETH_BANCOR_2017, "ethBancorEth", "Bancor's 2017 ETH token", true),
    ],
  },
];

const KEYS = Object.keys(STATE) as StateKey[];
const REDEMPTIONS = LEGACY_LIST.flatMap((e) => e.redemptions);

interface Snapshot {
  state: State;
  failed: Set<StateKey>;
  balances: Map<string, bigint | undefined>;
}

/**
 * One multicall per address for every entry (they run as separate checks, at the same time):
 * the balances of every old token plus the state of every official contract.
 */
const snapshots = new Map<string, { at: number; p: Promise<Snapshot> }>();

async function readSnapshot(user: Address): Promise<Snapshot> {
  const reads: Read[] = [...KEYS.map((k) => STATE[k]), ...REDEMPTIONS.map((r) => balanceOf(r.token, user))];
  const res = await l1Client().multicall({ contracts: reads as never, allowFailure: true, batchSize: 0 });
  const state = {} as State;
  const failed = new Set<StateKey>();
  KEYS.forEach((k, i) => {
    const r = res[i] as { status: string; result?: unknown };
    if (r.status === "success") state[k] = r.result;
    else failed.add(k);
  });
  const balances = new Map<string, bigint | undefined>();
  REDEMPTIONS.forEach((r, i) => {
    const b = res[KEYS.length + i] as { status: string; result?: unknown };
    balances.set(r.key, b.status === "success" ? (b.result as bigint) : undefined);
  });
  return { state, failed, balances };
}

const SNAPSHOT_TTL = 30_000;

function snapshot(user: Address): Promise<Snapshot> {
  const hit = snapshots.get(user);
  if (hit && Date.now() - hit.at < SNAPSHOT_TTL) return hit.p;
  for (const [k, v] of snapshots) if (Date.now() - v.at >= SNAPSHOT_TTL) snapshots.delete(k);
  const p = readSnapshot(user).then(
    (s) => {
      // A contract that didn't answer is retried by the next check, not served from here.
      if (s.failed.size || [...s.balances.values()].includes(undefined)) snapshots.delete(user);
      return s;
    },
    (e) => {
      snapshots.delete(user);
      throw e;
    },
  );
  snapshots.set(user, { at: Date.now(), p });
  return p;
}

/**
 * Dry-runs the claim from the holder's own address. False if the contract would reject it (for
 * example a smart-contract wallet that can't receive ETH this way), true if it goes through, and
 * null when the node can't simulate (the on-chain state checks above still hold).
 */
async function dryRun(user: Address, calls: { to: Address; data: Hex }[]): Promise<boolean | null> {
  try {
    const [block] = await l1Client().simulateBlocks({ blocks: [{ calls: calls.map((c) => ({ ...c, from: user })) }] });
    return block.calls.every((c) => c.status === "success");
  } catch {
    return null;
  }
}

/** Checks one entry (or all of them) for an Ethereum address. */
export async function checkLegacy(user: string, list: LegacyEntry[] = LEGACY_LIST): Promise<CheckOutput> {
  const me = getAddress(user);
  const snap = await snapshot(me);
  const out: CheckOutput = { findings: [], completed: 0 };
  const errors: string[] = [];
  for (const entry of list) {
    const source: FindingSource = { id: `legacy-${entry.id}`, name: entry.name, guideId: "legacy" };
    await Promise.all(
      entry.redemptions.map(async (r) => {
        const balance = snap.balances.get(r.key);
        const missing = r.needs.filter((k) => snap.failed.has(k));
        if (balance === undefined || (balance > 0n && missing.length)) {
          errors.push(`${r.label}: couldn't read ${balance === undefined ? `the ${r.symbol} balance` : missing.join(", ")}`);
          return;
        }
        if (balance === 0n) return;
        const q = r.quote(balance, snap.state);
        if (q.status === "closed" || q.amount === 0n) return;
        let status: WithdrawalStatus = q.status;
        const asset = r.asset(q.amount);
        let note = r.note(`${formatAmount(balance, r.decimals)} ${r.symbol}`, `${formatAmount(q.amount, asset.decimals)} ${asset.symbol}`);
        if (q.note) note += ` ${q.note}`;
        if (status === "ready" && (await dryRun(me, r.calls(balance))) === false) {
          status = "manual";
          note += " A dry run of the claim from this address fails right now (for example, a smart-contract wallet that can't receive ETH this way): check it before sending anything.";
        }
        out.findings.push(
          makeFinding(source, {
            key: r.key,
            label: r.label,
            status,
            asset,
            txHash: r.token,
            txUrl: r.txUrl,
            timestamp: 0, // no date: the tokens have been in the wallet for years
            note,
            claimAt: r.claimAt,
            minUsd: 5,
          }),
        );
      }),
    );
  }
  if (errors.length) out.error = errors.join("; ");
  return out;
}
