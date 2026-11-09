import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { getAddress, keccak256, parseAbi, parseAbiItem, toHex, zeroAddress, type Address, type Hex } from "viem";
import { checkSource } from "../src/lib/checker.ts";
import { checkCryptoPunks, checkFomo3d } from "../src/lib/checks/oldcontracts.ts";
import { checkSablier } from "../src/lib/checks/sablier.ts";
import { checkLiquityV2 } from "../src/lib/checks/liquity-v2.ts";
import { checkVeDex } from "../src/lib/checks/aerodrome.ts";
import { checkStarknet, LOG_MESSAGE_TO_L1, messageHash } from "../src/lib/checks/starknet.ts";
import { checkZoraRewards } from "../src/lib/checks/zora-rewards.ts";
import { NETWORK_COLORS } from "../src/lib/brand.ts";
import { sourceById } from "../src/lib/sources.ts";
import { MOCK_HEAD, MockChain, revert } from "./mockchain.ts";

const USER: Address = "0x1111111111111111111111111111111111111111";
const NOBODY: Address = "0x7777777777777777777777777777777777777777";
const REJECTED: Address = "0x5555555555555555555555555555555555555555";
const OTHER: Address = "0x3333333333333333333333333333333333333333";
const e18 = 10n ** 18n;

const world = new MockChain();
before(() => {
  globalThis.fetch = world.fetch as typeof fetch;
  world.prices["coingecko:ethereum"] = 2500;
});

/* ───────────────────────── CryptoPunks market ───────────────────────── */

describe("CryptoPunks market", () => {
  const PUNKS: Address = "0xb47e3cd837dDF8e4c57F05d70Ab865de6e193BBB";
  const BID = parseAbiItem("event PunkBidEntered(uint256 indexed punkIndex, uint256 value, address indexed fromAddress)");
  const pending: Record<string, bigint> = { [USER]: 3n * e18, [REJECTED]: e18 };
  // punk → [bidder, value]
  const bids: Record<string, [Address, bigint]> = { "17": [USER, 2n * e18], "18": [OTHER, 9n * e18], "19": [USER, 4n * e18] };
  const bid = (punk: number, from: Address, block: bigint) =>
    world.addTx({
      chainId: 1,
      hash: keccak256(toHex(`bid${punk}${from}${block}`)),
      from,
      to: PUNKS,
      blockNumber: block,
      timestamp: 1_500_000_000,
      logs: [{ address: PUNKS, event: BID, args: { punkIndex: BigInt(punk), value: e18, fromAddress: from } }],
    });
  before(() => {
    world.addContract(
      1,
      PUNKS,
      parseAbi([
        "function pendingWithdrawals(address) view returns (uint256)",
        "function punkBids(uint256) view returns (bool hasBid, uint256 punkIndex, address bidder, uint256 value)",
        "function withdraw()",
        "function withdrawBidForPunk(uint256)",
      ]),
      {
        pendingWithdrawals: ([a]) => pending[a as string] ?? 0n,
        punkBids: ([i]) => {
          const b = bids[String(i)];
          return b ? [true, i, b[0], b[1]] : [false, i, "0x0000000000000000000000000000000000000000", 0n];
        },
        withdraw: (_, { from }) => {
          if (from === REJECTED) revert("rejected");
        },
        withdrawBidForPunk: () => {},
      },
    );
    bid(17, USER, 4_000_000n); // 2017: forgotten
    bid(18, USER, 4_000_000n); // outbid since: someone else's bid now
    bid(19, USER, MOCK_HEAD - 1000n); // entered days ago: a live offer
  });

  test("ETH waiting in pendingWithdrawals, and bids left open for more than a year", async () => {
    const r = await checkCryptoPunks(USER);
    assert.deepEqual(r.findings.map((f) => [f.networkName, f.asset.amount]).sort(), [
      ["CryptoPunks: ETH never withdrawn", 3n * e18],
      ["CryptoPunks: open bid on punk #17", 2n * e18],
    ]);
  });

  test("nothing without balance; hidden when the withdrawal would be rejected", async () => {
    assert.deepEqual(await checkCryptoPunks(NOBODY), { findings: [], completed: 0 });
    assert.deepEqual((await checkCryptoPunks(REJECTED)).findings, []);
  });
});

/* ───────────────────────── FoMo3D ───────────────────────── */

describe("FoMo3D", () => {
  const LONG: Address = "0xA62142888ABa8370742bE823c1782D17A0389Da1";
  const QUICK: Address = "0x4e8ecF79AdE5e2C49B9e30D795517A81e0Bf00B8";
  const game = (address: Address, players: Record<string, [bigint, bigint, bigint, bigint]>) =>
    world.addContract(
      1,
      address,
      parseAbi(["function pIDxAddr_(address) view returns (uint256)", "function getPlayerVaults(uint256) view returns (uint256, uint256, uint256)", "function withdraw()"]),
      {
        pIDxAddr_: ([a]) => players[a as string]?.[0] ?? 0n,
        getPlayerVaults: ([id]) => Object.values(players).find((p) => p[0] === id)?.slice(1) ?? [0n, 0n, 0n],
        withdraw: (_, { from }) => {
          if (from === REJECTED) revert("rejected");
        },
      },
    );
  before(() => {
    game(LONG, { [USER]: [5n, 10n * e18, 3n * e18, e18 / 2n], [REJECTED]: [6n, e18, 0n, 0n], [OTHER]: [7n, 0n, 0n, 0n] });
    game(QUICK, { [USER]: [9n, 0n, e18 / 5n, 0n] });
  });

  test("winnings, dividends and referral rewards left in each game's vault", async () => {
    const r = await checkFomo3d(USER);
    assert.deepEqual(r.findings.map((f) => [f.networkName, f.asset.amount]).sort(), [
      ["FoMo3D Quick: player vault", e18 / 5n],
      ["FoMo3D: player vault", 13n * e18 + e18 / 2n],
    ]);
    assert.match(r.findings.find((f) => f.networkName === "FoMo3D: player vault")!.note ?? "", /10 ETH of winnings, 3 ETH of key dividends, 0\.5 ETH of referral rewards/);
  });

  test("a player with an empty vault, a stranger, a rejected withdrawal: nothing", async () => {
    assert.deepEqual((await checkFomo3d(OTHER)).findings, []);
    assert.deepEqual((await checkFomo3d(NOBODY)).findings, []);
    assert.deepEqual((await checkFomo3d(REJECTED)).findings, []);
  });
});

/* ───────────────────────── Zora protocol rewards ───────────────────────── */

describe("Zora protocol rewards", () => {
  const REWARDS: Address = "0x7777777F279eba3d3Ad8F4E708545291A6fDBA8B";
  const balances: Record<number, Record<string, bigint>> = { 7777777: { [USER]: 3n * e18 }, 8453: { [USER]: e18 / 20n, [REJECTED]: e18 }, 10: {}, 42161: {}, 1: {} };
  before(() => {
    for (const [chain, b] of Object.entries(balances))
      world.addContract(Number(chain), REWARDS, parseAbi(["function balanceOf(address) view returns (uint256)", "function withdraw(address to, uint256 amount)"]), {
        balanceOf: ([a]) => b[a as string] ?? 0n,
        withdraw: (_, { from }) => {
          if (from === REJECTED) revert("Invalid withdraw");
        },
      });
  });

  test("ETH credited on each chain", async () => {
    const r = await checkZoraRewards(USER);
    assert.equal(r.error, undefined);
    assert.deepEqual(r.findings.map((f) => [f.networkName, f.asset.amount]).sort(), [
      ["Zora rewards · Base", e18 / 20n],
      ["Zora rewards · Zora", 3n * e18],
    ]);
  });

  test("nothing without rewards; hidden when the withdrawal would be rejected", async () => {
    assert.deepEqual(await checkZoraRewards(NOBODY), { findings: [], completed: 0 });
    assert.deepEqual((await checkZoraRewards(REJECTED)).findings, []);
  });
});

/* ───────────────────────── Sablier ───────────────────────── */

describe("Sablier streams", () => {
  const INDEXER = "https://indexer.hyperindex.xyz/53b7e25/v1/graphql";
  const LOCKUP = getAddress("0x00000000000000000000000000000000000ab1e5");
  const OP = "0x4200000000000000000000000000000000000042";
  const SPAM = getAddress("0x22c060a0f0a77531399cac400873f93039140d17");
  const stream = (id: number, asset: string, symbol: string) => ({
    alias: `LL2-10-${id}`,
    chainId: "10",
    tokenId: String(id),
    contract: LOCKUP,
    version: "v1.1",
    endTime: "1700000000",
    asset: { address: asset, symbol, decimals: "18" },
  });
  const withdrawable: Record<string, bigint> = { "200": 1256n * e18, "201": 5885n * e18, "202": 0n, "203": 40n * e18 };
  const owners: Record<string, Address> = { "203": OTHER };
  before(() => {
    world.prices[`optimism:${OP}`] = 0.1;
    world.static[INDEXER] = { data: { LockupStream: [stream(200, OP, "OP"), stream(201, SPAM, "OP"), stream(202, OP, "OP"), stream(203, OP, "OP"), { ...stream(5, OP, "OP"), chainId: "11155111" }] } };
    world.addContract(10, LOCKUP, parseAbi(["function withdrawableAmountOf(uint256) view returns (uint128)", "function ownerOf(uint256) view returns (address)"]), {
      withdrawableAmountOf: ([id]) => withdrawable[String(id)] ?? 0n,
      ownerOf: ([id]) => owners[String(id)] ?? USER,
    });
  });

  test("vested tokens never withdrawn, priced tokens only, from streams the address still owns", async () => {
    const r = await checkSablier(USER);
    assert.equal(r.error, undefined);
    assert.equal(r.findings.length, 1, "spam token, empty stream, transferred stream and testnet are left out");
    const f = r.findings[0];
    assert.equal(f.networkName, "Sablier stream #200 · Optimism");
    assert.equal(f.asset.amount, 1256n * e18);
    assert.equal(f.txUrl, "https://app.sablier.com/vesting/stream/LL2-10-200");
    assert.match(f.note ?? "", /has ended/);
  });

  test("the indexer down fails the check", async () => {
    const saved = world.static[INDEXER];
    world.static[INDEXER] = { errors: [{ message: "boom" }] };
    try {
      assert.equal((await checkSource(sourceById("sablier-streams")!, USER)).state, "error");
    } finally {
      world.static[INDEXER] = saved;
    }
  });
});

/* ───────────────────────── Liquity v2 ───────────────────────── */

describe("Liquity v2", () => {
  // Current wstETH branch and first deployment's WETH branch.
  const SURPLUS_WSTETH: Address = "0x36e6cbdf68f64cf00fc3a6c634a25be32dd0a235";
  const BO_WSTETH: Address = "0xa741a32f9dcfe6adba088fd0f97e90742d7d5da3";
  const SURPLUS_FIRST_WETH: Address = "0x46720b3d63e38583d8f6d77d52c52df32604ef4b";
  const BO_FIRST_WETH: Address = "0x0b995602b5a797823f92027e8b40c0f2d97aff1c";
  const balances: Record<string, Record<string, bigint>> = {
    [SURPLUS_WSTETH]: { [USER]: 2n * e18, [REJECTED]: e18 },
    [SURPLUS_FIRST_WETH]: { [USER]: e18 / 2n },
  };
  before(() => {
    world.addContract(1, "0x4678f0a6958e4D2Bc4F1BAF7Bc52E8F3564f3fE4", parseAbi(["function proxies(address) view returns (address)"]), { proxies: () => zeroAddress });
    world.addContract(1, "0x4c8a1BEb8a87765788946D6B19C6C6355194AbEb", parseAbi(["function userLink(address) view returns (uint64, uint64, uint64)"]), { userLink: () => [0n, 0n, 0n] });
    for (const pool of [
      "0xedbe2509e502c0320d2e7f8b6746a49b4b50e2bf", SURPLUS_WSTETH, "0xba4a2bd8b76df84cac98eba3f4b967d8423192bf",
      SURPLUS_FIRST_WETH, "0xc8e5bda2efc25f04d5feb56eee80e3d8af74cb7f", "0xc6f43d9eea6f9955038959a34ea5002f346e2cad",
    ] as Address[])
      world.addContract(1, pool, parseAbi(["function getCollateral(address) view returns (uint256)"]), { getCollateral: ([a]) => balances[pool]?.[a as string] ?? 0n });
    for (const bo of [BO_WSTETH, BO_FIRST_WETH])
      world.addContract(1, bo, parseAbi(["function claimCollateral()"]), {
        claimCollateral: (_, { from }) => {
          if (from === REJECTED) revert("CollSurplusPool: No collateral available to claim");
        },
      });
  });

  test("collateral left after liquidation, on both deployments", async () => {
    const r = await checkLiquityV2(USER);
    assert.deepEqual(r.findings.map((f) => [f.networkName, f.asset.symbol, f.asset.amount]).sort(), [
      ["Liquity v2 (first deployment): collateral left after liquidation", "WETH", e18 / 2n],
      ["Liquity v2: collateral left after liquidation", "wstETH", 2n * e18],
    ]);
  });

  test("nothing without surplus; hidden when the claim would be rejected", async () => {
    assert.deepEqual(await checkLiquityV2(NOBODY), { findings: [], completed: 0 });
    assert.deepEqual((await checkLiquityV2(REJECTED)).findings, []);
  });
});

/* ───────────────────────── Aerodrome & Velodrome ───────────────────────── */

describe("Aerodrome & Velodrome", () => {
  const ESCROW = getAddress("0xeBf418Fe2512e7E6bd9b87a8F0f294aCDC67e6B4");
  const DIST = getAddress("0x227f65131A261548b057215bB1D5Ab2997964C7d");
  const VOTER = getAddress("0x16613524e02ad97eDfeF371bC883F2F5d6C480A5");
  const NOW = BigInt(Math.floor(Date.now() / 1000));
  // id → [owner, amount, end, permanent, voted, rebase]
  const nfts: Record<string, [Address, bigint, bigint, boolean, boolean, bigint]> = {
    "1": [USER, 1000n * e18, NOW - 86400n, false, false, 0n], // expired
    "2": [USER, 500n * e18, NOW - 86400n, false, true, 7n * e18], // expired, still voting, rebase waiting
    "3": [USER, 900n * e18, NOW + 86400n * 365n, false, true, 0n], // still locked
    "4": [USER, 800n * e18, 0n, true, false, 0n], // permanent lock
  };
  const reset = new Set<bigint>();
  before(() => {
    world.addContract(
      8453,
      ESCROW,
      parseAbi([
        "function balanceOf(address) view returns (uint256)",
        "function ownerToNFTokenIdList(address, uint256) view returns (uint256)",
        "function locked(uint256) view returns ((int128 amount, uint256 end, bool isPermanent))",
        "function voted(uint256) view returns (bool)",
        "function withdraw(uint256)",
      ]),
      {
        balanceOf: ([a]) => BigInt(Object.values(nfts).filter((n) => n[0] === a).length),
        ownerToNFTokenIdList: ([a, i]) => BigInt(Object.entries(nfts).filter(([, n]) => n[0] === a)[Number(i)][0]),
        locked: ([id]) => {
          const n = nfts[String(id)];
          return { amount: n[1], end: n[2], isPermanent: n[3] };
        },
        voted: ([id]) => nfts[String(id)][4] && !reset.has(id as bigint),
        withdraw: ([id]) => {
          if (nfts[String(id)][4] && !reset.has(id as bigint)) revert("AlreadyVoted");
          reset.delete(id as bigint);
        },
      },
    );
    world.addContract(8453, DIST, parseAbi(["function claimable(uint256) view returns (uint256)", "function claim(uint256) returns (uint256)"]), {
      claimable: ([id]) => nfts[String(id)]?.[5] ?? 0n,
      claim: ([id]) => nfts[String(id)]?.[5] ?? 0n,
    });
    world.addContract(8453, VOTER, parseAbi(["function reset(uint256)"]), {
      reset: ([id]) => {
        reset.add(id as bigint);
      },
    });
    world.addContract(10, getAddress("0xFAf8FD17D9840595845582fCB047DF13f006787d"), parseAbi(["function balanceOf(address) view returns (uint256)"]), { balanceOf: () => 0n });
  });

  test("expired locks (votes reset first when needed) and unclaimed rebases", async () => {
    const r = await checkVeDex(USER);
    assert.equal(r.error, undefined);
    assert.deepEqual(r.findings.map((f) => [f.networkName, f.asset.amount]).sort(), [
      ["Aerodrome: expired lock #1", 1000n * e18],
      ["Aerodrome: expired lock #2", 500n * e18],
      ["Aerodrome: rebases of veNFT #2", 7n * e18],
    ]);
    assert.match(r.findings.find((f) => f.networkName === "Aerodrome: expired lock #2")!.note ?? "", /reset them first/);
    assert.ok(r.findings.every((f) => f.asset.symbol === "AERO"));
  });

  test("no veNFT: nothing", async () => {
    assert.deepEqual(await checkVeDex(NOBODY), { findings: [], completed: 0 });
  });
});

/* ───────────────────────── Starknet ───────────────────────── */

describe("Starknet → Ethereum", () => {
  const CORE = getAddress("0xc662c410c0ecf747543f5ba90660f6abebd9c8c4");
  const ETH_BRIDGE = "0xae0ee0a63a2ce6baeeffe56e7714fb4efe48d419";
  const STRK_BRIDGE = "0xce5485cfb26914c5dce00b9baf0580364dafc7a4";
  const STRK = "0xca14007eff0db1f8135f4c25b34de49ab0d42766";
  const L2_BRIDGE = 0x73314940630fd6dcda0d772d4c972c4e0a9946bef9dabf4ef84eda8ef542b82n;
  const hex = (x: bigint) => `0x${x.toString(16)}`;
  const me = BigInt(USER);
  const ethMsg: [string, string, string[]] = [hex(L2_BRIDGE), ETH_BRIDGE, [0n, me, 37n * 10n ** 16n, 0n].map(hex)];
  const doneMsg: [string, string, string[]] = [hex(L2_BRIDGE), ETH_BRIDGE, [0n, me, 5n * e18, 0n].map(hex)];
  const strkPayload = [0n, me, BigInt(STRK), 1000n * e18, 0n];
  const pending = new Set<Hex>([messageHash(L2_BRIDGE, ETH_BRIDGE, ethMsg[2].map(BigInt)), messageHash(L2_BRIDGE, STRK_BRIDGE, strkPayload)]);
  const SITE = "https://www.fundscheckers.com";
  before(() => {
    world.static[`${SITE}/legacy/starknet/meta.json`] = { snapshotBlock: 29_000_000 };
    world.static[`${SITE}/legacy/starknet/1.json`] = { [USER.toLowerCase()]: [ethMsg, doneMsg] };
    world.static[`${SITE}/legacy/starknet/7.json`] = {};
    world.prices[`ethereum:${STRK}`] = 0.04;
    // A withdrawal after the snapshot, found by the live search.
    world.addTx({
      chainId: 1,
      hash: keccak256(toHex("starknet-strk")),
      from: CORE,
      to: CORE,
      blockNumber: 29_500_000n,
      timestamp: 1_790_000_000,
      logs: [{ address: CORE, event: LOG_MESSAGE_TO_L1, args: { fromAddress: L2_BRIDGE, toAddress: getAddress(STRK_BRIDGE), payload: strkPayload } }],
    });
    world.addContract(1, CORE, parseAbi(["function l2ToL1Messages(bytes32) view returns (uint256)"]), { l2ToL1Messages: ([h]) => (pending.has(h as Hex) ? 1n : 0n) });
    world.addContract(1, getAddress(ETH_BRIDGE), parseAbi(["function withdraw(uint256 amount, address recipient)"]), { withdraw: () => {} });
    world.addContract(1, getAddress(STRK_BRIDGE), parseAbi(["function withdraw(address token, uint256 amount, address recipient)"]), { withdraw: () => {} });
    world.addContract(1, getAddress(STRK), parseAbi(["function symbol() view returns (string)", "function decimals() view returns (uint8)"]), { symbol: () => "STRK", decimals: () => 18 });
  });

  test("snapshot messages and newer ones, still unconsumed, once their withdraw simulates", async () => {
    const r = await checkStarknet(USER);
    assert.equal(r.completed, 1, "the consumed one counts as completed");
    assert.deepEqual(r.findings.map((f) => [f.asset.symbol, f.asset.amount]).sort(), [
      ["ETH", 37n * 10n ** 16n],
      ["STRK", 1000n * e18],
    ]);
    assert.ok(r.findings.every((f) => f.networkName === "Starknet → Ethereum" && f.status === "ready"));
  });

  test("an address with nothing waiting", async () => {
    assert.deepEqual(await checkStarknet(NOBODY), { findings: [], completed: 0 });
  });
});

describe("Wiring", () => {
  test("each new source has a group, a color and runs for Ethereum addresses", () => {
    for (const [id, group] of [
      ["cryptopunks-market", "legacy"],
      ["fomo3d", "legacy"],
      ["zora-rewards", "rewards"],
      ["sablier-streams", "rewards"],
      ["liquity-v2", "rewards"],
      ["aerodrome-velodrome", "rewards"],
      ["starknet", "l2"],
    ] as const) {
      const s = sourceById(id);
      assert.ok(s, id);
      assert.equal(s.group, group);
      assert.deepEqual(s.accepts, ["evm"]);
      assert.ok(NETWORK_COLORS[id], id);
    }
  });
});
