import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { maxUint256, parseAbi, zeroAddress, type Address, type Hex } from "viem";
import { checkAaveV2, checkAaveV3 } from "../src/lib/checks/aave-incentives.ts";
import { checkMerkl } from "../src/lib/checks/merkl.ts";
import { checkSource } from "../src/lib/checker.ts";
import { evmChain } from "../src/lib/evm.ts";
import { sourceById } from "../src/lib/sources.ts";
import { MockChain, revert } from "./mockchain.ts";

const USER: Address = "0x1111111111111111111111111111111111111111";
const DUST: Address = "0x2222222222222222222222222222222222222222";
const EMPTY: Address = "0x3333333333333333333333333333333333333333";
const e18 = 10n ** 18n;
const lower = (a: unknown) => String(a).toLowerCase();
const same = (a: unknown, b: unknown) => lower(a) === lower(b);

const world = new MockChain();
before(() => {
  globalThis.fetch = world.fetch as typeof fetch;
});

/** Runs `fn` while every RPC node of a chain answers 503. */
async function withChainDown<T>(chainId: number, fn: () => Promise<T>): Promise<T> {
  const down = new Set(evmChain(chainId)!.rpcs.map((u) => u.replace(/\/$/, "")));
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (down.has(href.replace(/\/$/, ""))) return new Response("Service Unavailable", { status: 503 });
    return world.fetch(input, init);
  }) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = world.fetch as typeof fetch;
  }
}

/* ───────────────────────── Aave v2 ───────────────────────── */

describe("Aave v2 incentives", () => {
  const abi = parseAbi([
    "function getRewardsBalance(address[] assets, address user) view returns (uint256)",
    "function claimRewards(address[] assets, uint256 amount, address to) returns (uint256)",
  ]);
  const CONTROLLERS: Record<number, [Address, number]> = {
    1: ["0xd784927Ff2f95ba542BfC824c8a8a98F3495f6b5", 62],
    137: ["0x357D51124f59836DeD84c8a1730D72B749d8BC23", 13],
    43114: ["0x01D83Fe6A10D2f2B7AF17034343746188272cAc9", 14],
  };
  const balances: Record<number, Record<string, bigint>> = {
    1: { [lower(USER)]: 310n * e18, [lower(DUST)]: 2n * 10n ** 14n },
    137: { [lower(USER)]: 494n * e18 },
    43114: { [lower(USER)]: 4n * e18 + 57n * 10n ** 16n, [lower(EMPTY)]: 9n * e18 },
  };
  before(() => {
    for (const [id, [controller, count]] of Object.entries(CONTROLLERS)) {
      const chainId = Number(id);
      world.addContract(chainId, controller, abi, {
        getRewardsBalance: ([assets, user]) => ((assets as Address[]).length === count ? (balances[chainId][lower(user)] ?? 0n) : 0n),
        // Only the exact claim works: every asset, everything, paid to the caller.
        claimRewards: ([assets, amount, to], { from }) => {
          if ((assets as Address[]).length !== count || amount !== maxUint256 || !same(to, from)) revert("bad claim");
          if (chainId === 43114 && same(from, EMPTY)) revert("SafeERC20: low-level call failed"); // vault can't pay
          return balances[chainId][lower(from)] ?? 0n;
        },
      });
    }
  });

  test("finds stkAAVE, WPOL and WAVAX never claimed, after running each claim from the user", async () => {
    const r = await checkAaveV2(USER);
    assert.equal(r.error, undefined);
    const by = Object.fromEntries(r.findings.map((f) => [f.asset.symbol, f]));
    assert.deepEqual(Object.keys(by).sort(), ["WAVAX", "WPOL", "stkAAVE"]);
    assert.equal(by.stkAAVE.asset.amount, 310n * e18);
    assert.equal(by.stkAAVE.networkName, "Aave v2 · Ethereum");
    assert.equal(by.stkAAVE.asset.tokenChain, "ethereum");
    assert.equal(by.stkAAVE.asset.token, "0x4da27a545c0c5B758a6BA100e3a049001de870f5");
    assert.equal(by.stkAAVE.minUsd, 5, "Ethereum dust threshold");
    assert.match(by.stkAAVE.note ?? "", /May 22, 2022/);
    assert.match(by.stkAAVE.claimAt ?? "", /app\.aave\.com, Ethereum V2 market/);
    assert.equal(by.WPOL.networkName, "Aave v2 · Polygon");
    assert.equal(by.WPOL.asset.tokenChain, "polygon");
    assert.equal(by.WPOL.minUsd, 1);
    assert.equal(by.WAVAX.networkName, "Aave v2 · Avalanche");
    assert.equal(by.WAVAX.asset.tokenChain, "avax");
    assert.equal(by.WAVAX.asset.amount, 457n * 10n ** 16n);
    assert.ok(r.findings.every((f) => f.status === "ready" && f.guideId === "aave-merkl" && f.networkId === "aave-v2"));
    assert.equal(by.WAVAX.txUrl, "https://snowtrace.io/address/0x01D83Fe6A10D2f2B7AF17034343746188272cAc9");
  });

  test("hides rewards whose claim would fail", async () => {
    const r = await checkAaveV2(EMPTY);
    assert.deepEqual(r, { findings: [], completed: 0 });
  });

  test("a chain whose RPC nodes fail makes the check incomplete, without hiding the others", async () => {
    const r = await withChainDown(137, () => checkSource(sourceById("aave-v2")!, USER));
    assert.equal(r.state, "error", "shown as failed, with a Retry");
    assert.match(r.error ?? "", /^Polygon: /);
    assert.deepEqual(r.findings.map((f) => f.asset.symbol).sort(), ["WAVAX", "stkAAVE"]);
  });

  test("dust is hidden once priced: $5 on Ethereum", async () => {
    world.prices["ethereum:0x4da27a545c0c5b758a6ba100e3a049001de870f5"] = 164.5;
    const dust = await checkSource(sourceById("aave-v2")!, DUST);
    assert.deepEqual([dust.state, dust.findings.length], ["done", 0], "0.0002 stkAAVE ≈ $0.03");
    const real = await checkSource(sourceById("aave-v2")!, USER);
    assert.equal(real.findings.find((f) => f.asset.symbol === "stkAAVE")?.asset.usd, 310 * 164.5);
  });
});

/* ───────────────────────── Aave v3 ───────────────────────── */

describe("Aave v3 incentives", () => {
  const rcAbi = parseAbi([
    "function getAllUserRewards(address[] assets, address user) view returns (address[] rewardsList, uint256[] unclaimedAmounts)",
    "function claimRewards(address[] assets, uint256 amount, address to, address reward) returns (uint256)",
    "function getRewardsByAsset(address asset) view returns (address[])",
  ]);
  const poolAbi = parseAbi([
    "function getReservesList() view returns (address[])",
    "function getReserveData(address asset) view returns (((uint256 data) configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt))",
  ]);
  const erc20 = parseAbi(["function decimals() view returns (uint8)", "function symbol() view returns (string)"]);
  const SHARED = "0x929EC64c34a17401F460460D4B9390518E5B473e";
  const SD: Address = "0x30D20208d987713f46DFD34EF128Bb16C404D10f";
  const USDS_REWARD: Address = "0x32a6268f9Ba3642Dda7892aDd74f1D34469A4259";
  const ETH_REWARDS: Address[] = [SD, "0xfA1fDbBD71B0aA16162D76914d69cD8CB3Ef92da", "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0", USDS_REWARD, "0xC035a7cf15375cE2706766804551791aD035E0C2"];
  const ARB: Address = "0x912CE59144191C1204E64559FE8253a0e49E6548";
  const WAVAX: Address = "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7";
  const SAVAX: Address = "0x2b2C81e08f1Af8835a78Bb2A90AE924ACE0eA4bE";
  // Base: the snapshot knows aBasUSDC only; NEW is a program added later, on a reserve listed later.
  const BASE_RC: Address = "0xf9cc4F0D883F1a1eb2c253bdb46c254Ca51E1F44";
  const BASE_POOL: Address = "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5";
  const A_BAS_USDC: Address = "0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB";
  const NEW: Address = "0x4444444444444444444444444444444444444444";
  const NEW_RESERVE: Address = "0x5555555555555555555555555555555555555555";
  const NEW_ATOKEN: Address = "0x6666666666666666666666666666666666666666";
  const NEW_VDEBT: Address = "0x7777777777777777777777777777777777777777";

  /** What USER earned: chain → reward → amount, and which rewards' vaults are empty. */
  const earned: Record<number, Record<string, bigint>> = {
    1: { [lower(SD)]: 846n * e18, [lower(USDS_REWARD)]: 120n * e18 },
    42161: { [lower(ARB)]: 336n * e18 },
    43114: { [lower(WAVAX)]: 8n * e18, [lower(SAVAX)]: 14n * e18 },
  };
  const emptyVault = new Set([lower(SD)]);
  const lists: Record<number, Address[]> = { 1: ETH_REWARDS, 42161: [ARB], 43114: [WAVAX, SAVAX], 10: ["0x4200000000000000000000000000000000000042"] };

  function controller(chainId: number, address: Address, assetCount: number) {
    world.addContract(chainId, address, rcAbi, {
      getAllUserRewards: ([assets, user]) => {
        assert.equal((assets as Address[]).length, assetCount, "only the assets that carry rewards");
        const mine = same(user, USER) ? (earned[chainId] ?? {}) : {};
        return [lists[chainId], lists[chainId].map((r) => mine[lower(r)] ?? 0n)];
      },
      claimRewards: ([assets, amount, to, reward], { from }) => {
        if ((assets as Address[]).length !== assetCount || amount !== maxUint256 || !same(to, from)) revert("bad claim");
        if (emptyVault.has(lower(reward))) revert("ERC20: transfer amount exceeds balance");
        return (same(from, USER) ? earned[chainId]?.[lower(reward)] : 0n) ?? 0n;
      },
    });
  }

  before(() => {
    controller(1, "0x8164Cc65827dcFe994AB23944CBC90e0aa80bFcb", 5);
    controller(42161, SHARED, 3);
    controller(43114, SHARED, 19);
    controller(10, SHARED, 14);
    world.addContract(56, "0xC206C2764A9dBF27d599613b8F9A63ACd1160ab4", rcAbi, {
      getAllUserRewards: () => [["0xc5f0f7b66764F6ec8C8Dff7BA683102295E16409"], [0n]],
    });
    world.addContract(137, SHARED, rcAbi, {
      getAllUserRewards: () => [
        ["0x1d734A02eF1e1f5886e66b0673b71Af5B53ffA94", "0xC3C7d422809852031b44ab29EEC9F1EfF2A58756", "0x3A58a54C066FdC0f2D55FC9C89F0415C92eBf3C4", "0xfa68FB4628DFF1028CFEc22b4162FCcd0d45efb6"],
        [0n, 0n, 0n, 0n],
      ],
    });
    world.addContract(1088, "0x30C1b8F0490fa0908863d6Cbd2E36400b4310A6B", rcAbi, {
      getAllUserRewards: () => [["0xDeadDeAddeAddEAddeadDEaDDEAdDeaDDeAD0000"], [0n]],
    });
    // Base: a reward token the snapshot doesn't know → the assets are read from the pool.
    world.addContract(8453, BASE_RC, rcAbi, {
      getAllUserRewards: ([assets, user]) => {
        const all = assets as Address[];
        const onNew = all.some((a) => same(a, NEW_ATOKEN)) && same(user, USER);
        return [[A_BAS_USDC, NEW], [0n, onNew ? 7n * e18 : 0n]];
      },
      getRewardsByAsset: ([asset]) => (same(asset, NEW_ATOKEN) ? [NEW] : same(asset, A_BAS_USDC) ? [A_BAS_USDC] : []),
      claimRewards: ([assets, , to, reward], { from }) => {
        if (!same(to, from) || !(assets as Address[]).some((a) => same(a, NEW_ATOKEN)) || !same(reward, NEW)) revert("nothing");
        return 7n * e18;
      },
    });
    world.addContract(8453, BASE_POOL, poolAbi, {
      getReservesList: () => ["0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", NEW_RESERVE],
      getReserveData: ([asset]) => ({
        configuration: { data: 0n },
        liquidityIndex: 0n,
        currentLiquidityRate: 0n,
        variableBorrowIndex: 0n,
        currentVariableBorrowRate: 0n,
        currentStableBorrowRate: 0n,
        lastUpdateTimestamp: 0,
        id: 0,
        aTokenAddress: same(asset, NEW_RESERVE) ? NEW_ATOKEN : A_BAS_USDC,
        stableDebtTokenAddress: zeroAddress,
        variableDebtTokenAddress: same(asset, NEW_RESERVE) ? NEW_VDEBT : "0x59dca05b6c26dbd64b5381374aAaC5CD05644C28",
        interestRateStrategyAddress: zeroAddress,
        accruedToTreasury: 0n,
        unbacked: 0n,
        isolationModeTotalDebt: 0n,
      }),
    });
    world.addContract(8453, NEW, erc20, { decimals: () => 18, symbol: () => "NEWR" });
  });

  test("claims each reward on its own: an unfunded program (SD) is hidden, the others are shown", async () => {
    const r = await checkAaveV3(USER);
    assert.equal(r.error, undefined);
    const by = Object.fromEntries(r.findings.map((f) => [`${f.networkName} ${f.asset.symbol}`, f]));
    assert.deepEqual(Object.keys(by).sort(), [
      "Aave v3 · Arbitrum ARB",
      "Aave v3 · Avalanche WAVAX",
      "Aave v3 · Avalanche sAVAX",
      "Aave v3 · Base NEWR",
      "Aave v3 · Ethereum aEthUSDS",
    ]);
    assert.ok(!r.findings.some((f) => f.asset.symbol === "SD"), "846 SD show in the view, but the claim reverts");
    assert.equal(by["Aave v3 · Arbitrum ARB"].asset.amount, 336n * e18);
    assert.equal(by["Aave v3 · Arbitrum ARB"].asset.tokenChain, "arbitrum");
    assert.equal(by["Aave v3 · Arbitrum ARB"].minUsd, 1);
    assert.equal(by["Aave v3 · Avalanche sAVAX"].asset.amount, 14n * e18);
    assert.equal(by["Aave v3 · Ethereum aEthUSDS"].minUsd, 5);
    assert.match(by["Aave v3 · Ethereum aEthUSDS"].note ?? "", /paid as aEthUSDS, an Aave deposit/);
    assert.match(by["Aave v3 · Arbitrum ARB"].claimAt ?? "", /app\.aave\.com, Arbitrum market/);
    assert.equal(by["Aave v3 · Arbitrum ARB"].txUrl, "https://arbiscan.io/address/0x929EC64c34a17401F460460D4B9390518E5B473e");
  });

  test("a reward token missing from the snapshot (new program) is found on the pool's reserves", async () => {
    const r = await checkAaveV3(USER);
    const f = r.findings.find((x) => x.asset.symbol === "NEWR")!;
    assert.equal(f.asset.amount, 7n * e18);
    assert.equal(f.asset.decimals, 18);
    assert.equal(f.asset.token, NEW);
    assert.equal(f.asset.tokenChain, "base");
  });

  test("nothing earned: nothing shown, no error", async () => {
    assert.deepEqual(await checkAaveV3(EMPTY), { findings: [], completed: 0 });
  });

  test("a chain whose RPC nodes fail makes the check incomplete, without hiding the others", async () => {
    const r = await withChainDown(42161, () => checkAaveV3(USER));
    assert.match(r.error ?? "", /^Arbitrum: /);
    assert.ok(!r.findings.some((f) => f.networkName === "Aave v3 · Arbitrum"));
    assert.ok(r.findings.some((f) => f.networkName === "Aave v3 · Avalanche"));
  });
});

/* ───────────────────────── Merkl ───────────────────────── */

describe("Merkl", () => {
  const abi = parseAbi([
    "function claimed(address user, address token) view returns (uint208 amount, uint48 timestamp, bytes32 merkleRoot)",
    "function claim(address[] users, address[] tokens, uint256[] amounts, bytes32[][] proofs)",
  ]);
  const erc20 = parseAbi(["function decimals() view returns (uint8)", "function symbol() view returns (string)"]);
  const DISTRIBUTOR: Address = "0x3Ef3D8bA38EBe18DB133cEc108f4D14CE00Dd9Ae";
  const ZK_DISTRIBUTOR: Address = "0xe117ed7Ef16d3c28fCBA7eC49AFAD77f451a6a21";
  const MORPHO: Address = "0x58D97B57BB95320F9a05dC918Aef65434969c2B2";
  const MORPHO_BASE: Address = "0xBAa5CC21fd487B8Fcc2F632f3F4E8D37262a0842";
  const ZK: Address = "0x5A7d6b2F92C77FAD6CCaBd7EE0624E64907Eaf3E";
  const POINTS: Address = "0x3419966bC74fa8f951108d15b053bEd233974d3D";
  const STALE: Address = "0x8888888888888888888888888888888888888888";
  const BAD_PROOF: Address = "0x9999999999999999999999999999999999999999";
  const proof = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;
  const API = (user: Address) => `https://api.merkl.xyz/v4/users/${user}/rewards/summary`;
  const token = (address: Address, symbol: string, price: number | null, type = "TOKEN", decimals = 18) => ({ address, symbol, decimals, price, type, verified: true });

  /** On-chain state: what the distributor already paid, and the tree (user, token) → [amount, proof]. */
  const paid: Record<string, bigint> = {};
  const tree: Record<string, [bigint, Hex]> = {};
  const key = (chainId: number, user: unknown, t: unknown) => `${chainId}:${lower(user)}:${lower(t)}`;

  function distributor(chainId: number, address: Address) {
    world.addContract(chainId, address, abi, {
      claimed: ([user, t]) => [paid[key(chainId, user, t)] ?? 0n, 0, proof(0)],
      claim: ([users, tokens, amounts, proofs], { from }) => {
        const [user, t, amount, p] = [(users as Address[])[0], (tokens as Address[])[0], (amounts as bigint[])[0], (proofs as Hex[][])[0]];
        if (!same(user, from)) revert("NotWhitelisted");
        const leaf = tree[key(chainId, user, t)];
        if (!leaf || leaf[0] !== amount || p.length !== 1 || p[0] !== leaf[1]) revert("InvalidProof");
      },
    });
  }

  before(() => {
    distributor(1, DISTRIBUTOR);
    distributor(8453, DISTRIBUTOR);
    distributor(57073, DISTRIBUTOR);
    distributor(324, ZK_DISTRIBUTOR);
    world.addContract(1, MORPHO, erc20, { decimals: () => 18, symbol: () => "MORPHO" });
    world.addContract(8453, MORPHO_BASE, erc20, { decimals: () => 18, symbol: () => "MORPHO" });
    world.addContract(324, ZK, erc20, { decimals: () => 18, symbol: () => "ZK" });

    // USER: MORPHO on Ethereum and Base, ZK on ZKsync, points on Ink, a token on a chain without an RPC, dust.
    tree[key(1, USER, MORPHO)] = [15_739n * e18, proof(1)];
    paid[key(1, USER, MORPHO)] = 15_131n * e18;
    tree[key(8453, USER, MORPHO_BASE)] = [12_470n * e18, proof(2)];
    tree[key(324, USER, ZK)] = [5_000n * e18, proof(3)];
    tree[key(57073, USER, POINTS)] = [257_000_000n * e18, proof(4)];
    world.static[API(USER)] = [
      {
        chain: { id: 1, name: "Ethereum" },
        rewards: [
          { token: token(MORPHO, "MORPHO", 2.5), amount: String(15_739n * e18), claimed: String(15_131n * e18), pending: "0", proofs: [proof(1)] },
          { token: token("0xb755506531786C8aC63B756BaB1ac387bACB0C04", "ZARP", 0.06), amount: "1930798206241", claimed: "0", pending: "0", proofs: [proof(9)] },
        ],
      },
      {
        chain: { id: 8453, name: "Base" },
        rewards: [
          { token: token(MORPHO_BASE, "MORPHO", 2.5), amount: String(12_470n * e18), claimed: "0", pending: "0", proofs: [proof(2)] },
          { token: token("0xA88594D404727625A9437C3f886C7643872296AE", "WELL", null), amount: String(1_000n * e18), claimed: "0", pending: "0", proofs: [proof(8)] },
        ],
      },
      { chain: { id: 324, name: "ZKsync Era" }, rewards: [{ token: token(ZK, "ZK", 0.04), amount: String(5_000n * e18), claimed: "0", pending: "0", proofs: [proof(3)] }] },
      { chain: { id: 57073, name: "Ink" }, rewards: [{ token: token(POINTS, "makina-points", 0, "POINT"), amount: String(257_000_000n * e18), claimed: "0", pending: "0", proofs: [proof(4)] }] },
      { chain: { id: 4, name: "Stellar" }, rewards: [{ token: token("0x0000000000000000000000000000000000000004", "XLM", 0.3), amount: String(1_000n * e18), claimed: "0", pending: "0", proofs: [] }] },
    ];

    // STALE: the API says 100 MORPHO are left, but they were claimed on-chain since.
    tree[key(1, STALE, MORPHO)] = [100n * e18, proof(5)];
    paid[key(1, STALE, MORPHO)] = 100n * e18;
    world.static[API(STALE)] = [
      { chain: { id: 1, name: "Ethereum" }, rewards: [{ token: token(MORPHO, "MORPHO", 2.5), amount: String(100n * e18), claimed: "0", pending: "0", proofs: [proof(5)] }] },
    ];
    // BAD_PROOF: the API's proof doesn't match the tree on-chain (e.g. a new root still in its dispute period).
    tree[key(8453, BAD_PROOF, MORPHO_BASE)] = [50n * e18, proof(6)];
    world.static[API(BAD_PROOF)] = [
      { chain: { id: 8453, name: "Base" }, rewards: [{ token: token(MORPHO_BASE, "MORPHO", 2.5), amount: String(60n * e18), claimed: "0", pending: "0", proofs: [proof(7)] }] },
    ];
    world.static[API(EMPTY)] = [];
  });

  test("finds unclaimed tokens on every chain it can verify, after simulating each claim", async () => {
    const r = await checkMerkl(USER);
    assert.equal(r.error, undefined);
    const by = Object.fromEntries(r.findings.map((f) => [f.networkName, f]));
    assert.deepEqual(Object.keys(by).sort(), ["Merkl · Base", "Merkl · Ethereum", "Merkl · ZKsync Era"]);
    assert.equal(by["Merkl · Ethereum"].asset.amount, 608n * e18, "tree amount minus what the distributor already paid");
    assert.equal(by["Merkl · Ethereum"].asset.symbol, "MORPHO");
    assert.equal(by["Merkl · Ethereum"].asset.usd, 608 * 2.5, "Merkl's price until DefiLlama's");
    assert.equal(by["Merkl · Ethereum"].minUsd, 5);
    assert.equal(by["Merkl · Base"].asset.amount, 12_470n * e18);
    assert.equal(by["Merkl · Base"].asset.tokenChain, "base");
    assert.equal(by["Merkl · Base"].minUsd, 1);
    assert.equal(by["Merkl · ZKsync Era"].asset.amount, 5_000n * e18, "ZKsync's distributor lives elsewhere");
    assert.equal(by["Merkl · ZKsync Era"].txUrl, `https://explorer.zksync.io/address/${ZK_DISTRIBUTOR}`);
    assert.equal(by["Merkl · Base"].claimAt, `app.merkl.xyz/users/${USER}`);
    assert.ok(r.findings.every((f) => f.status === "ready" && f.guideId === "aave-merkl" && f.networkId === "merkl"));
  });

  test("ignores points, unpriced tokens, dust and chains it can't verify", async () => {
    const r = await checkMerkl(USER);
    assert.ok(!r.findings.some((f) => ["makina-points", "WELL", "ZARP", "XLM"].includes(f.asset.symbol)));
  });

  test("already claimed on-chain (the API lags): nothing shown", async () => {
    assert.deepEqual(await checkMerkl(STALE), { findings: [], completed: 0 });
  });

  test("a claim that would be rejected hides the reward", async () => {
    assert.deepEqual(await checkMerkl(BAD_PROOF), { findings: [], completed: 0 });
  });

  test("no rewards: clean", async () => {
    assert.deepEqual(await checkMerkl(EMPTY), { findings: [], completed: 0 });
  });

  test("a chain whose RPC nodes fail makes the check incomplete, without hiding the others", async () => {
    const r = await withChainDown(8453, () => checkMerkl(USER));
    assert.match(r.error ?? "", /^Base: /);
    assert.deepEqual(r.findings.map((f) => f.networkName).sort(), ["Merkl · Ethereum", "Merkl · ZKsync Era"]);
  });

  test("Merkl's API failing fails the check instead of reporting it clean", async () => {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).startsWith("https://api.merkl.xyz/")) return new Response("Too Many Requests", { status: 429 });
      return world.fetch(input, init);
    }) as typeof fetch;
    try {
      await assert.rejects(checkMerkl(USER), /Merkl API: HTTP 429/);
      const r = await checkSource(sourceById("merkl")!, USER);
      assert.equal(r.state, "error");
    } finally {
      globalThis.fetch = world.fetch as typeof fetch;
    }
  });
});
