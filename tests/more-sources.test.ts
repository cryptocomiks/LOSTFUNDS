import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { getAddress, keccak256, parseAbi, parseAbiItem, toHex, type Address } from "viem";
import { checkSource } from "../src/lib/checker.ts";
import { checkCryptoPunks, checkFomo3d } from "../src/lib/checks/oldcontracts.ts";
import { checkSablier } from "../src/lib/checks/sablier.ts";
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

describe("Wiring", () => {
  test("each new source has a group, a color and runs for Ethereum addresses", () => {
    for (const [id, group] of [
      ["cryptopunks-market", "legacy"],
      ["fomo3d", "legacy"],
      ["zora-rewards", "rewards"],
      ["sablier-streams", "rewards"],
    ] as const) {
      const s = sourceById(id);
      assert.ok(s, id);
      assert.equal(s.group, group);
      assert.deepEqual(s.accepts, ["evm"]);
      assert.ok(NETWORK_COLORS[id], id);
    }
  });
});
