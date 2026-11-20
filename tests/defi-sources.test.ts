import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { getAddress, parseAbi, type Address } from "viem";
import { checkLivepeer } from "../src/lib/checks/livepeer.ts";
import { checkSafes } from "../src/lib/checks/safes.ts";
import { checkUniswapV3 } from "../src/lib/checks/uniswap-v3.ts";
import { NETWORK_COLORS } from "../src/lib/brand.ts";
import { sourceById } from "../src/lib/sources.ts";
import { MockChain, revert } from "./mockchain.ts";

const USER: Address = "0x1111111111111111111111111111111111111111";
const NOBODY: Address = "0x7777777777777777777777777777777777777777";
const REJECTED: Address = "0x5555555555555555555555555555555555555555";
const e18 = 10n ** 18n;
const NOW = Math.floor(Date.now() / 1000);

const world = new MockChain();
before(() => {
  globalThis.fetch = world.fetch as typeof fetch;
  world.prices["coingecko:ethereum"] = 2000;
});
const erc20 = parseAbi(["function symbol() view returns (string)", "function decimals() view returns (uint8)"]);
const token = (chainId: number, address: Address, symbol: string, decimals: number) =>
  world.addContract(chainId, address, erc20, { symbol: () => symbol, decimals: () => decimals });

/* ───────────────────────── Uniswap v3 ───────────────────────── */

describe("Uniswap v3 fees", () => {
  const MANAGER = getAddress("0xC36442b4a4522E871399CD717aBDD847Ab11FE88");
  const BASE_MANAGER = getAddress("0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1");
  const USDC = getAddress("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
  const WETH = getAddress("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2");
  const SPAM = getAddress("0x000000000000000000000000000000000000dEaD");
  // id → [token0, token1, liquidity, fees0, fees1]
  const positions: Record<string, [Address, Address, bigint, bigint, bigint]> = {
    "10": [USDC, WETH, 5_000n, 40_000_000n, e18 / 100n], // active, fees in both tokens
    "11": [USDC, WETH, 0n, 0n, e18 / 2n], // liquidity removed, WETH never collected
    "12": [USDC, SPAM, 9n, 0n, 7n * e18], // fees in a token with no price
    "13": [USDC, WETH, 9n, 0n, 0n], // nothing to collect
  };
  const owned: Record<string, bigint[]> = { [USER]: [10n, 11n, 12n, 13n] };
  const abi = parseAbi([
    "function balanceOf(address) view returns (uint256)",
    "function tokenOfOwnerByIndex(address, uint256) view returns (uint256)",
    "function positions(uint256) view returns (uint96, address, address, address, uint24, int24, int24, uint128, uint256, uint256, uint128, uint128)",
    "function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max)) returns (uint256 amount0, uint256 amount1)",
  ]);
  const manager = (chainId: number, address: Address, live: boolean) =>
    world.addContract(chainId, address, abi, {
      balanceOf: ([a]) => BigInt(live ? (owned[a as string]?.length ?? 0) : 0),
      tokenOfOwnerByIndex: ([a, i]) => owned[a as string][Number(i)],
      positions: ([id]) => {
        const p = positions[String(id)];
        return [0n, "0x0000000000000000000000000000000000000000", p[0], p[1], 3000, -100, 100, p[2], 0n, 0n, 0n, 0n];
      },
      collect: ([params], { from }) => {
        const { tokenId, recipient } = params as { tokenId: bigint; recipient: Address };
        if (!owned[from as string]?.includes(tokenId) || recipient !== from) revert("Not approved");
        return [positions[String(tokenId)][3], positions[String(tokenId)][4]];
      },
    });
  before(() => {
    manager(1, MANAGER, true);
    manager(8453, BASE_MANAGER, false);
    for (const chain of [42161, 10, 137]) manager(chain, MANAGER, false);
    token(1, USDC, "USDC", 6);
    token(1, WETH, "WETH", 18);
    token(1, SPAM, "FREE", 18);
    world.prices[`ethereum:${USDC.toLowerCase()}`] = 1;
    world.prices[`ethereum:${WETH.toLowerCase()}`] = 2000;
  });

  test("what collect() would pay, per position and token, priced tokens only", async () => {
    const r = await checkUniswapV3(USER);
    assert.equal(r.error, undefined);
    assert.deepEqual(r.findings.map((f) => [f.networkName, f.asset.symbol, f.asset.amount]).sort(), [
      ["Uniswap v3 · USDC/WETH #10 · Ethereum", "USDC", 40_000_000n],
      ["Uniswap v3 · USDC/WETH #10 · Ethereum", "WETH", e18 / 100n],
      ["Uniswap v3 · USDC/WETH #11 · Ethereum", "WETH", e18 / 2n],
    ]);
    const closed = r.findings.find((f) => f.networkName.includes("#11"))!;
    assert.match(closed.note ?? "", /no liquidity left/);
    assert.match(r.findings.find((f) => f.networkName.includes("#10"))!.note ?? "", /trading fees/);
    assert.equal(closed.txUrl, "https://app.uniswap.org/positions/v3/ethereum/11");
  });

  test("no position: nothing, and one request per chain", async () => {
    assert.deepEqual(await checkUniswapV3(NOBODY), { findings: [], completed: 0 });
  });
});

/* ───────────────────────── Forgotten Safes ───────────────────────── */

describe("Forgotten Safes", () => {
  const API = "https://api.safe.global/tx-service";
  const SLUGS = ["eth", "base", "arb1", "oeth", "pol", "gno", "bnb"];
  const SOLO = getAddress("0x00000000000000000000000000000000005afe01"); // threshold 1, idle for years
  const SHARED = getAddress("0x00000000000000000000000000000000005afe02"); // 2 signatures
  const ACTIVE = getAddress("0x00000000000000000000000000000000005afe03"); // threshold 1, used last month
  const NEVER = getAddress("0x00000000000000000000000000000000005afe04"); // threshold 1, never sent anything
  const USDC = getAddress("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
  const thresholds: Record<string, bigint> = { [SOLO]: 1n, [SHARED]: 2n, [ACTIVE]: 1n, [NEVER]: 1n };
  const iso = (ago: number) => new Date((NOW - ago) * 1000).toISOString();
  before(() => {
    for (const s of SLUGS) for (const who of [USER, NOBODY]) world.static[`${API}/${s}/api/v1/owners/${who}/safes/`] = { safes: s === "eth" && who === USER ? [SOLO, SHARED, ACTIVE, NEVER] : [] };
    for (const safe of [SOLO, SHARED, ACTIVE, NEVER]) {
      world.addContract(1, safe, parseAbi(["function getThreshold() view returns (uint256)"]), { getThreshold: () => thresholds[safe] });
      world.static[`${API}/eth/api/v1/safes/${safe}/balances/?trusted=true&exclude_spam=true`] = [
        { tokenAddress: null, token: null, balance: String(e18 / 2n) },
        { tokenAddress: USDC, token: { symbol: "USDC", decimals: 6 }, balance: "250000000" },
        { tokenAddress: "0x000000000000000000000000000000000000dEaD", token: { symbol: "DUST", decimals: 18 }, balance: "5" },
      ];
    }
    const lastTx = (safe: Address, results: object[]) => (world.static[`${API}/eth/api/v1/safes/${safe}/multisig-transactions/?executed=true&limit=1&ordering=-executionDate`] = { results });
    lastTx(SOLO, [{ executionDate: iso(3 * 365 * 86400) }]);
    lastTx(ACTIVE, [{ executionDate: iso(30 * 86400) }]);
    lastTx(NEVER, []);
    world.prices[`ethereum:${USDC.toLowerCase()}`] = 1;
  });

  test("Safes the address controls alone, idle for a year or never used, with what they hold", async () => {
    const r = await checkSafes(USER);
    assert.equal(r.error, undefined);
    const got = r.findings.map((f) => [f.txHash, f.asset.symbol, f.asset.amount]).sort();
    assert.deepEqual(got, [
      [SOLO, "ETH", e18 / 2n],
      [SOLO, "USDC", 250_000_000n],
      [NEVER, "ETH", e18 / 2n],
      [NEVER, "USDC", 250_000_000n],
    ].sort());
    assert.match(r.findings.find((f) => f.txHash === NEVER)!.note ?? "", /has never sent a transaction/);
    assert.match(r.findings.find((f) => f.txHash === SOLO)!.note ?? "", /sent nothing for over a year/);
  });

  test("no Safe: nothing", async () => {
    assert.deepEqual(await checkSafes(NOBODY), { findings: [], completed: 0 });
  });
});

/* ───────────────────────── Livepeer ───────────────────────── */

describe("Livepeer", () => {
  const BONDING = getAddress("0x35Bcf3c30594191d53231E4FF333E8A770453e40");
  const ROUNDS = getAddress("0xdd6f56DcC28D3F5f27084381fE8Df634985cc39f");
  const ROUND = 4412n;
  // lock id → [amount, withdrawRound]
  const locks: Record<string, Record<string, [bigint, bigint]>> = {
    [USER]: { "0": [0n, 4000n], "1": [500n * e18, 4257n], "2": [30n * e18, ROUND + 3n] }, // withdrawn, due, still waiting
    [REJECTED]: { "0": [10n * e18, 4000n] },
  };
  const fees: Record<string, bigint> = { [USER]: e18 / 4n };
  before(() => {
    world.addContract(42161, ROUNDS, parseAbi(["function currentRound() view returns (uint256)"]), { currentRound: () => ROUND });
    world.addContract(
      42161,
      BONDING,
      parseAbi([
        "function getDelegator(address) view returns (uint256, uint256, address, uint256, uint256, uint256, uint256)",
        "function getDelegatorUnbondingLock(address, uint256) view returns (uint256, uint256)",
        "function pendingFees(address, uint256) view returns (uint256)",
        "function withdrawStake(uint256)",
        "function withdrawFees(address, uint256)",
      ]),
      {
        getDelegator: ([a]) => [0n, 0n, "0x0000000000000000000000000000000000000000", 0n, locks[a as string] ? 4000n : 0n, 0n, BigInt(Object.keys(locks[a as string] ?? {}).length)],
        getDelegatorUnbondingLock: ([a, id]) => locks[a as string]?.[String(id)] ?? [0n, 0n],
        pendingFees: ([a]) => fees[a as string] ?? 0n,
        withdrawStake: (_, { from }) => {
          if (from === REJECTED) revert("system is paused");
        },
        withdrawFees: () => {},
      },
    );
  });

  test("unstaked LPT past its waiting period, and ETH fees", async () => {
    const r = await checkLivepeer(USER);
    assert.deepEqual(r.findings.map((f) => [f.networkName, f.asset.symbol, f.asset.amount]).sort(), [
      ["Livepeer: ETH fees never withdrawn", "ETH", e18 / 4n],
      ["Livepeer: unstaked LPT never withdrawn", "LPT", 500n * e18],
    ]);
  });

  test("never staked, or a withdrawal the contract rejects: nothing", async () => {
    assert.deepEqual(await checkLivepeer(NOBODY), { findings: [], completed: 0 });
    assert.deepEqual((await checkLivepeer(REJECTED)).findings, []);
  });
});

describe("Wiring", () => {
  test("each source has a group, a color and runs for Ethereum addresses", () => {
    for (const [id, group] of [
      ["uniswap-v3-fees", "rewards"],
      ["livepeer", "rewards"],
      ["safes", "legacy"],
      ["legacy-rpl-v1", "legacy"],
    ] as const) {
      const s = sourceById(id);
      assert.ok(s, id);
      assert.equal(s.group, group);
      assert.deepEqual(s.accepts, ["evm"]);
      if (!id.startsWith("legacy-")) assert.ok(NETWORK_COLORS[id], id);
    }
  });
});
