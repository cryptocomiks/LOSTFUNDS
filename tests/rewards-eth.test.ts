import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { base64 } from "@scure/base";
import { hexToBytes, parseAbi, type Address, type Hex } from "viem";
import { checkSource, sourcesFor } from "../src/lib/checker.ts";
import { checkConvex } from "../src/lib/checks/convex.ts";
import { checkEigenRewards, checkEigenWithdrawals } from "../src/lib/checks/eigenlayer.ts";
import { checkBalancerFees, checkCurveFees } from "../src/lib/checks/feedistributors.ts";
import { checkLido } from "../src/lib/checks/lido.ts";
import { checkLocks } from "../src/lib/checks/locks.ts";
import { checkSafetyModule } from "../src/lib/checks/safetymodule.ts";
import { checkSynthetixEscrow } from "../src/lib/checks/synthetix.ts";
import { NETWORK_COLORS } from "../src/lib/brand.ts";
import { GUIDES } from "../src/content/guides.ts";
import { EVM_CHAINS } from "../src/lib/evm.ts";
import { L1 } from "../src/lib/networks.ts";
import { sourceById } from "../src/lib/sources.ts";
import { MOCK_HEAD, MockChain, revert } from "./mockchain.ts";

/** Has something in every protocol. */
const USER: Address = "0x1111111111111111111111111111111111111111";
/** Has nothing anywhere. */
const NOBODY: Address = "0x7777777777777777777777777777777777777777";
/** Has positions whose claim or withdrawal the contracts reject. */
const REJECTED: Address = "0x5555555555555555555555555555555555555555";
/** Claimed everything already. */
const CLAIMED: Address = "0x4444444444444444444444444444444444444444";
/** A second wallet with something (more Lido requests, a claimer address…). */
const SECOND: Address = "0x3333333333333333333333333333333333333333";

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86_400;
const e18 = 10n ** 18n;
const lower = (a: string) => a.toLowerCase();

const world = new MockChain();
before(() => {
  globalThis.fetch = world.fetch as typeof fetch;
});

/** Runs `fn` with `fail(url, body)` deciding which requests get an HTTP 503 (the RPC node is down). */
async function withOutage<T>(fail: (url: string, body: string) => boolean, fn: () => Promise<T>): Promise<T> {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (fail(url.replace(/\/$/, ""), String(init?.body ?? ""))) return new Response("Service Unavailable", { status: 503 });
    return world.fetch(input, init);
  }) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = world.fetch as typeof fetch;
  }
}
const rpcsOf = (chainId: number) =>
  new Set([...(chainId === 1 ? L1.rpcs : []), ...EVM_CHAINS.filter((c) => c.id === chainId).flatMap((c) => c.rpcs)].map((u) => u.replace(/\/$/, "")));
const ethereumDown = <T>(fn: () => Promise<T>) => withOutage((url) => rpcsOf(1).has(url), fn);
/** Every dry run fails at the node (not a revert): eth_call with a sender, or eth_simulateV1. */
const dryRunsDown = <T>(fn: () => Promise<T>) =>
  withOutage((url, body) => rpcsOf(1).has(url) && (body.includes('"from"') || body.includes("eth_simulateV1")), fn);

const erc20 = parseAbi(["function decimals() view returns (uint8)", "function symbol() view returns (string)"]);
const token = (address: Address, symbol: string, decimals = 18) =>
  world.addContract(1, address, erc20, { decimals: () => decimals, symbol: () => symbol });

/* ───────────────────────── Lido ───────────────────────── */

describe("Lido withdrawals", () => {
  const QUEUE: Address = "0x889edC2eDab5f40e902b864aD4d7AdE8E412F9B1";
  const requests = new Map<bigint, { owner: Address; stETH: bigint; eth: bigint; ts: number; finalized: boolean; claimed?: boolean }>([
    [10n, { owner: USER, stETH: 2n * e18, eth: 2n * e18, ts: NOW - 400 * DAY, finalized: true }],
    [12n, { owner: USER, stETH: 32n * e18, eth: 0n, ts: NOW - DAY, finalized: false }],
    [20n, { owner: SECOND, stETH: 1000n * e18, eth: 1000n * e18, ts: NOW - 30 * DAY, finalized: true }],
    [21n, { owner: SECOND, stETH: 600n * e18, eth: 599n * e18, ts: NOW - 29 * DAY, finalized: true }],
    [22n, { owner: SECOND, stETH: 5n * e18, eth: 0n, ts: NOW - 2 * DAY, finalized: false }],
    [30n, { owner: REJECTED, stETH: 3n * e18, eth: 3n * e18, ts: NOW - 90 * DAY, finalized: true }],
    [40n, { owner: CLAIMED, stETH: 3n * e18, eth: 3n * e18, ts: NOW - 90 * DAY, finalized: true, claimed: true }],
  ]);
  const ascending = (ids: readonly bigint[]) => ids.every((id, i) => i === 0 || ids[i - 1] < id);
  before(() => {
    world.addContract(
      1,
      QUEUE,
      parseAbi([
        "function getWithdrawalRequests(address _owner) view returns (uint256[] requestsIds)",
        "function getWithdrawalStatus(uint256[] _requestIds) view returns ((uint256 amountOfStETH, uint256 amountOfShares, address owner, uint256 timestamp, bool isFinalized, bool isClaimed)[] statuses)",
        "function getLastCheckpointIndex() view returns (uint256)",
        "function findCheckpointHints(uint256[] _requestIds, uint256 _firstIndex, uint256 _lastIndex) view returns (uint256[] hintIds)",
        "function getClaimableEther(uint256[] _requestIds, uint256[] _hints) view returns (uint256[] claimableEthValues)",
        "function claimWithdrawals(uint256[] _requestIds, uint256[] _hints)",
      ]),
      {
        // Unclaimed requests of their holder, newest first (the queue doesn't sort them).
        getWithdrawalRequests: ([owner]) => [...requests].filter(([, r]) => r.owner === owner && !r.claimed).map(([id]) => id).reverse(),
        getWithdrawalStatus: ([ids]) =>
          (ids as bigint[]).map((id) => {
            const r = requests.get(id)!;
            return { amountOfStETH: r.stETH, amountOfShares: r.stETH, owner: r.owner, timestamp: BigInt(r.ts), isFinalized: r.finalized, isClaimed: !!r.claimed };
          }),
        getLastCheckpointIndex: () => 9n,
        findCheckpointHints: ([ids, first, last]) => {
          if (!ascending(ids as bigint[]) || first !== 1n || last !== 9n) revert("RequestIdsNotSorted");
          return (ids as bigint[]).map(() => 7n);
        },
        getClaimableEther: ([ids]) => (ids as bigint[]).map((id) => (requests.get(id)!.finalized ? requests.get(id)!.eth : 0n)),
        claimWithdrawals: ([ids, hints], { from }) => {
          for (const id of ids as bigint[]) {
            const r = requests.get(id);
            if (!r || r.owner !== from) revert("NotOwner");
            if (!r!.finalized) revert("RequestNotFoundOrNotFinalized");
          }
          if ((hints as bigint[]).some((h) => h !== 7n)) revert("InvalidHint");
          if (from === REJECTED) revert("CantSendValueRecipientMayHaveReverted");
        },
      },
    );
    world.static["https://wq-api.lido.fi/v2/request-time?ids=12"] = [
      { requestInfo: { finalizationIn: 3 * DAY * 1000, finalizationAt: new Date((NOW + 3 * DAY) * 1000).toISOString(), type: "buffer" }, status: "calculated" },
    ];
    world.prices["coingecko:ethereum"] = 3000;
  });

  test("a finalized request never claimed is ready, a pending one waits with Lido's estimate", async () => {
    const r = await checkLido(USER);
    assert.equal(r.findings.length, 2);
    const [ready, waiting] = [r.findings.find((f) => f.status === "ready")!, r.findings.find((f) => f.status === "waiting")!];
    assert.equal(ready.asset.amount, 2n * e18);
    assert.equal(ready.asset.symbol, "ETH");
    assert.equal(ready.timestamp, NOW - 400 * DAY);
    assert.equal(ready.dateLabel, "Requested");
    assert.equal(ready.txUrl, `https://etherscan.io/nft/${QUEUE}/10`);
    assert.equal(ready.claimAt, "stake.lido.fi/withdrawals/claim");
    assert.equal(ready.minUsd, 5);
    assert.equal(ready.guideId, "rewards");
    assert.match(ready.note ?? "", /request #10/);
    assert.equal(waiting.asset.amount, 32n * e18);
    assert.equal(waiting.readyAt, NOW + 3 * DAY);
    assert.match(waiting.note ?? "", /hasn't finalized it yet/);
  });

  test("several finalized requests make one finding, with what the queue will actually pay", async () => {
    const r = await checkLido(SECOND);
    const ready = r.findings.filter((f) => f.status === "ready");
    assert.equal(ready.length, 1);
    assert.equal(ready[0].asset.amount, 1599n * e18, "claimable ETH, not the stETH requested");
    assert.equal(ready[0].timestamp, NOW - 30 * DAY, "dated by the oldest request");
    assert.match(ready[0].note ?? "", /2 Lido withdrawal requests \(#20, #21\)/);
    // No estimate from Lido's API (HTTP 404): still waiting, without a date.
    const waiting = r.findings.find((f) => f.status === "waiting")!;
    assert.equal(waiting.readyAt, undefined);
    assert.match(waiting.note ?? "", /usually takes 1 to 5 days/);
  });

  test("nothing when everything was claimed, or no request was ever made", async () => {
    assert.deepEqual(await checkLido(CLAIMED), { findings: [], completed: 0 });
    assert.deepEqual(await checkLido(NOBODY), { findings: [], completed: 0 });
  });

  test("hidden when the claim itself would be rejected", async () => {
    assert.deepEqual((await checkLido(REJECTED)).findings, []);
  });
});

/* ───────────────────────── Expired locks ───────────────────────── */

const VECRV: Address = "0x5f3b5DfEb7B28CDbD7FAba78963EE202a494e2A2";
const VEBAL: Address = "0xC128a9954e6c874eA3d62ce62B468bA073093F25";
const veAbi = parseAbi([
  "function locked(address) view returns (int128 amount, uint256 end)",
  "function withdraw()",
  "function user_point_epoch(address) view returns (uint256)",
  "function user_point_history__ts(address, uint256) view returns (uint256)",
]);
/** veCRV / veBAL: locks, and how many times each address changed its lock (0: never locked). */
const veState: Record<string, Record<string, { amount: bigint; end: number; epochs?: bigint; firstLock?: number }>> = {
  [VECRV]: {
    [USER]: { amount: 1000n * e18, end: NOW - 10 * DAY, epochs: 3n, firstLock: NOW - 900 * DAY },
    [REJECTED]: { amount: 0n, end: 0, epochs: 1n, firstLock: NOW - 500 * DAY },
    [CLAIMED]: { amount: 0n, end: 0, epochs: 2n, firstLock: NOW - 500 * DAY },
  },
  [VEBAL]: {
    [USER]: { amount: 50n * e18, end: NOW + 100 * DAY, epochs: 4n },
    [REJECTED]: { amount: 0n, end: 0, epochs: 1n },
  },
};
const voteEscrow = (address: Address) =>
  world.addContract(1, address, veAbi, {
    locked: ([a]) => {
      const l = veState[address][a as string];
      return [l?.amount ?? 0n, BigInt(l?.end ?? 0)];
    },
    withdraw: (_, { from }) => {
      const l = veState[address][from!];
      if (!l?.amount) revert("Nothing to withdraw");
      if (l.end > NOW) revert("The lock didn't expire");
    },
    user_point_epoch: ([a]) => veState[address][a as string]?.epochs ?? 0n,
    user_point_history__ts: ([a]) => BigInt(veState[address][a as string]?.firstLock ?? 0),
  });

describe("Expired locks", () => {
  const VEFXS: Address = "0xc8418aF6358FFddA74e09Ca9CC3Fe03Ca6aDC5b0";
  const VESDT: Address = "0x0C30476f66034E11782938DF8e4384970B6c9e8a";
  const VEPENDLE: Address = "0x4f30A9D41B80ecC5B94306AB4364951AE3170210";
  const VLCVX: Address = "0x72a19342e8F1838460eBFCCEf09F6585e32db86E";
  before(() => {
    voteEscrow(VECRV);
    voteEscrow(VEBAL);
    veState[VEFXS] = {};
    voteEscrow(VEFXS);
    // veSDT: REJECTED's lock has ended, but the contract refuses the withdrawal.
    veState[VESDT] = { [REJECTED]: { amount: 300n * e18, end: NOW - 5 * DAY } };
    world.addContract(1, VESDT, veAbi, {
      locked: ([a]) => [veState[VESDT][a as string]?.amount ?? 0n, BigInt(veState[VESDT][a as string]?.end ?? 0)],
      withdraw: () => revert("Smart contract depositors not allowed"),
    });
    world.addContract(1, VEPENDLE, parseAbi(["function positionData(address) view returns (uint128 amount, uint128 expiry)", "function withdraw() returns (uint128)"]), {
      positionData: ([a]) => (a === USER ? [77n * e18, BigInt(NOW - DAY)] : [0n, 0n]),
      withdraw: (_, { from }) => (from === USER ? 77n * e18 : revert("VEZeroAmountLocked")),
    });
    world.addContract(
      1,
      VLCVX,
      parseAbi([
        "function lockedBalances(address) view returns (uint256 total, uint256 unlockable, uint256 locked, (uint112 amount, uint112 boosted, uint32 unlockTime)[] lockData)",
        "function balances(address) view returns (uint112 locked, uint112 boosted, uint32 nextUnlockIndex)",
        "function userLocks(address, uint256) view returns (uint112 amount, uint112 boosted, uint32 unlockTime)",
        "function processExpiredLocks(bool _relock)",
      ]),
      {
        lockedBalances: ([a]) =>
          a === USER ? [800n * e18, 500n * e18, 300n * e18, [{ amount: 300n * e18, boosted: 300n * e18, unlockTime: NOW + 50 * DAY }]] : [0n, 0n, 0n, []],
        balances: ([a]) => (a === USER ? [800n * e18, 800n * e18, 2] : [0n, 0n, 0]),
        userLocks: ([a, i]) => (a === USER && i === 2n ? [500n * e18, 500n * e18, NOW - 3 * DAY] : [0n, 0n, 0]),
        processExpiredLocks: ([relock], { from }) => {
          if (relock || from !== USER) revert("no exp locks");
        },
      },
    );
  });

  test("finds every ended lock never withdrawn, dated by its end", async () => {
    const r = await checkLocks(USER);
    const by = Object.fromEntries(r.findings.map((f) => [f.asset.symbol, f]));
    assert.deepEqual(Object.keys(by).sort(), ["CRV", "CVX", "PENDLE"], "veBAL is still locked");
    assert.equal(by.CRV.asset.amount, 1000n * e18);
    assert.equal(by.CRV.timestamp, NOW - 10 * DAY);
    assert.equal(by.CRV.dateLabel, "Lock ended");
    assert.equal(by.CRV.claimAt, "curve.finance (DAO → Lock)");
    assert.equal(by.CRV.asset.token, "0xD533a949740bb3306d119CC777fa900bA034cd52");
    assert.equal(by.PENDLE.asset.amount, 77n * e18);
    assert.equal(by.CVX.asset.amount, 500n * e18, "only the unlockable part of vlCVX");
    assert.equal(by.CVX.timestamp, NOW - 3 * DAY, "the oldest expired vlCVX lock");
    assert.match(by.CVX.note ?? "", /anyone can process it/);
    assert.ok(r.findings.every((f) => f.status === "ready" && f.minUsd === 5));
  });

  test("nothing for an address that never locked", async () => {
    assert.deepEqual(await checkLocks(NOBODY), { findings: [], completed: 0 });
  });

  test("hidden when the withdrawal would be rejected", async () => {
    assert.deepEqual((await checkLocks(REJECTED)).findings, []);
  });
});

/* ───────────────────────── Fee distributors ───────────────────────── */

describe("Curve fees", () => {
  const THREE_CRV: Address = "0xA464e6DCda8AC41e03616F95f4BC98a13b8922Dc";
  const CRVUSD: Address = "0xD16d5eC345Dd86Fb63C6a9C43c517210F1027914";
  const START_3CRV = 1600300800;
  const START_CRVUSD = 1718841600;
  let claims = 0;
  /** A fee distributor paying `amounts` over consecutive claims (50 weeks each) to each address. */
  const distributor = (address: Address, amounts: Record<string, bigint[]>, cursors: Record<string, number>, start: number) =>
    world.addContract(
      1,
      address,
      parseAbi(["function claim(address _addr) returns (uint256)", "function time_cursor_of(address) view returns (uint256)", "function start_time() view returns (uint256)"]),
      {
        claim: ([a], { state }) => {
          claims++;
          if (a === REJECTED) revert("killed");
          const n = (state[address] as number | undefined) ?? 0;
          state[address] = n + 1;
          return amounts[a as string]?.[n] ?? 0n;
        },
        time_cursor_of: ([a]) => BigInt(cursors[a as string] ?? 0),
        start_time: () => BigInt(start),
      },
    );
  before(() => {
    voteEscrow(VECRV);
    distributor(THREE_CRV, { [USER]: [100n * e18, 40n * e18] }, { [USER]: NOW - 300 * DAY }, START_3CRV);
    distributor(CRVUSD, { [USER]: [7n * e18] }, {}, START_CRVUSD);
  });

  test("adds up every claim it takes (one claim covers 50 weeks), dated from the first week not claimed", async () => {
    const r = await checkCurveFees(USER);
    const by = Object.fromEntries(r.findings.map((f) => [f.asset.symbol, f]));
    assert.equal(by["3CRV"].asset.amount, 140n * e18);
    assert.equal(by["3CRV"].timestamp, NOW - 300 * DAY, "the user's own cursor");
    assert.equal(by["3CRV"].dateLabel, "Unclaimed since");
    assert.match(by["3CRV"].note ?? "", /takes 2 claims/);
    assert.equal(by.crvUSD.asset.amount, 7n * e18);
    // Never claimed crvUSD: from its first week, or the first week after the user's first lock if later.
    assert.equal(by.crvUSD.timestamp, Math.max(START_CRVUSD, Math.ceil((NOW - 900 * DAY) / 604800) * 604800));
    assert.doesNotMatch(by.crvUSD.note ?? "", /claims/);
  });

  test("without eth_simulateV1, one claim is shown as a minimum", async () => {
    world.simulateV1 = false;
    try {
      const r = await checkCurveFees(USER);
      const fees = r.findings.find((f) => f.asset.symbol === "3CRV")!;
      assert.equal(fees.asset.amount, 100n * e18);
      assert.match(fees.note ?? "", /at least/);
    } finally {
      world.simulateV1 = true;
    }
  });

  test("nothing for an address that never locked CRV (no claim is even tried), or that claimed it all", async () => {
    const before = claims;
    assert.deepEqual(await checkCurveFees(NOBODY), { findings: [], completed: 0 });
    assert.equal(claims, before);
    assert.deepEqual((await checkCurveFees(CLAIMED)).findings, []);
  });

  test("hidden when the claim would be rejected", async () => {
    assert.deepEqual((await checkCurveFees(REJECTED)).findings, []);
  });
});

describe("Balancer fees", () => {
  const DISTRIBUTOR: Address = "0xD3cf852898b21fc233251427c2DC93d3d604F3BB";
  const BAL: Address = "0xba100000625a3754423978a60c9317c58a424e3D";
  before(() => {
    voteEscrow(VEBAL);
    world.addContract(
      1,
      DISTRIBUTOR,
      parseAbi(["function claimTokens(address user, address[] tokens) returns (uint256[])", "function getUserTokenTimeCursor(address user, address token) view returns (uint256)"]),
      {
        claimTokens: ([user, tokens], { state }) => {
          if (user === REJECTED) revert("BAL#401");
          const n = (state.n as number | undefined) ?? 0;
          state.n = n + 1;
          const paid = user === USER ? [[30n * e18, 0n], [12n * e18, 5_000_000n]][n] : undefined;
          return (tokens as Address[]).map((_, i) => paid?.[i] ?? 0n);
        },
        getUserTokenTimeCursor: ([, t]) => BigInt(t === BAL ? NOW - 200 * DAY : NOW - 100 * DAY),
      },
    );
  });

  test("adds up every claim it takes (20 weeks each), per token", async () => {
    const r = await checkBalancerFees(USER);
    const by = Object.fromEntries(r.findings.map((f) => [f.asset.symbol, f]));
    assert.equal(by.BAL.asset.amount, 42n * e18);
    assert.equal(by.USDC.asset.amount, 5_000_000n);
    assert.equal(by.USDC.asset.decimals, 6);
    assert.equal(by.BAL.timestamp, NOW - 200 * DAY);
    assert.match(by.BAL.note ?? "", /takes 2 claims/);
  });

  test("nothing without a veBAL lock; hidden when the claim would be rejected", async () => {
    assert.deepEqual(await checkBalancerFees(NOBODY), { findings: [], completed: 0 });
    assert.deepEqual((await checkBalancerFees(REJECTED)).findings, []);
  });
});

/* ───────────────────────── EigenLayer ───────────────────────── */

const DELEGATION: Address = "0x39053D51B77DC0d36036Fc1fCc8Cb819df8Ef37A";
const EIGEN: Address = "0xec53bF9167f50cDEB3Ae105f56099aaaB9061F83";
const BEIGEN: Address = "0x83E9115d334D248Ce39a6f36144aEaB5b3456e75";
const EIGEN_STRATEGY: Address = "0xaCB55C530Acdb2849e6d4f36992Cd8c9D50ED8F7";
const STETH_STRATEGY: Address = "0x93c4b944D05dfe6df7645A86cd2206016c51564D";
const STETH: Address = "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84";
const OPERATOR: Address = "0x6666666666666666666666666666666666666666";
const DELAY = 100_800;

interface QueuedWithdrawal {
  staker: Address;
  delegatedTo: Address;
  withdrawer: Address;
  nonce: bigint;
  startBlock: number;
  strategies: Address[];
  scaledShares: bigint[];
}
const queued: Record<string, { w: QueuedWithdrawal; shares: bigint[] }[]> = {};
const withdrawal = (staker: Address, nonce: bigint, startBlock: number, strategy: Address, shares: bigint) => ({
  w: { staker, delegatedTo: OPERATOR, withdrawer: staker, nonce, startBlock, strategies: [strategy], scaledShares: [shares] },
  shares: [shares],
});

describe("EigenLayer withdrawals", () => {
  const READY_BLOCK = 29_000_000;
  const WAITING_BLOCK = 29_950_000;
  before(() => {
    queued[USER] = [withdrawal(USER, 4n, READY_BLOCK, EIGEN_STRATEGY, 361n * e18), withdrawal(USER, 5n, WAITING_BLOCK, STETH_STRATEGY, 5n * e18)];
    queued[REJECTED] = [withdrawal(REJECTED, 1n, READY_BLOCK, EIGEN_STRATEGY, 10n * e18)];
    world.addContract(
      1,
      DELEGATION,
      parseAbi([
        "struct Withdrawal { address staker; address delegatedTo; address withdrawer; uint256 nonce; uint32 startBlock; address[] strategies; uint256[] scaledShares; }",
        "function getQueuedWithdrawals(address staker) view returns (Withdrawal[] withdrawals, uint256[][] shares)",
        "function minWithdrawalDelayBlocks() view returns (uint32)",
        "function completeQueuedWithdrawal(Withdrawal withdrawal, address[] tokens, bool receiveAsTokens)",
        "function delegatedTo(address staker) view returns (address)",
        "function cumulativeWithdrawalsQueued(address staker) view returns (uint256)",
      ]),
      {
        getQueuedWithdrawals: ([a]) => [(queued[a as string] ?? []).map((q) => q.w), (queued[a as string] ?? []).map((q) => q.shares)],
        minWithdrawalDelayBlocks: () => DELAY,
        completeQueuedWithdrawal: ([w, tokens, asTokens], { from }) => {
          const q = w as QueuedWithdrawal;
          if (from !== q.withdrawer) revert("UnauthorizedCaller");
          if (BigInt(q.startBlock + DELAY) >= MOCK_HEAD) revert("WithdrawalDelayNotElapsed");
          if (!asTokens || (tokens as Address[])[0] !== BEIGEN) revert("InputArrayLengthMismatch");
          if (q.staker === REJECTED) revert("WithdrawalNotQueued");
        },
        delegatedTo: ([a]) => (a === USER || a === SECOND || a === CLAIMED ? OPERATOR : "0x0000000000000000000000000000000000000000"),
        cumulativeWithdrawalsQueued: ([a]) => (a === REJECTED ? 1n : 0n),
      },
    );
    const strategyAbi = parseAbi(["function underlyingToken() view returns (address)", "function sharesToUnderlyingView(uint256) view returns (uint256)"]);
    world.addContract(1, EIGEN_STRATEGY, strategyAbi, { underlyingToken: () => BEIGEN, sharesToUnderlyingView: ([s]) => s });
    world.addContract(1, STETH_STRATEGY, strategyAbi, { underlyingToken: () => STETH, sharesToUnderlyingView: ([s]) => ((s as bigint) * 11n) / 10n });
    token(STETH, "stETH");
    // Blocks the withdrawals were queued in.
    world.addTx({ chainId: 1, hash: `0x${"a1".repeat(32)}`, from: USER, to: DELEGATION, blockNumber: BigInt(READY_BLOCK), timestamp: NOW - 150 * DAY, logs: [] });
    world.addTx({ chainId: 1, hash: `0x${"a2".repeat(32)}`, from: USER, to: DELEGATION, blockNumber: BigInt(WAITING_BLOCK), timestamp: NOW - 7 * DAY, logs: [] });
    world.prices[`ethereum:${lower(EIGEN)}`] = 0.25;
  });

  test("a withdrawal past its delay is ready; one still in it waits until the delay is over", async () => {
    const t0 = Math.floor(Date.now() / 1000);
    const r = await checkEigenWithdrawals(USER);
    const t1 = Math.floor(Date.now() / 1000);
    assert.equal(r.findings.length, 2);
    const ready = r.findings.find((f) => f.status === "ready")!;
    assert.equal(ready.asset.symbol, "bEIGEN");
    assert.equal(ready.asset.amount, 361n * e18);
    assert.equal(ready.asset.priceKey, `ethereum:${lower(EIGEN)}`, "bEIGEN is priced as EIGEN");
    assert.equal(ready.timestamp, NOW - 150 * DAY);
    assert.equal(ready.dateLabel, "Queued");
    assert.match(ready.note ?? "", /converts 1:1 into EIGEN/);
    const waiting = r.findings.find((f) => f.status === "waiting")!;
    assert.equal(waiting.asset.symbol, "stETH");
    assert.equal(waiting.asset.amount, 55n * 10n ** 17n, "shares converted to stETH");
    // 12 s per block still to go.
    const wait = (WAITING_BLOCK + DELAY + 1 - Number(MOCK_HEAD)) * 12;
    assert.ok(waiting.readyAt! >= t0 + wait && waiting.readyAt! <= t1 + wait, `${waiting.readyAt} ≈ now + ${wait}`);
  });

  test("priced through checkSource: bEIGEN gets EIGEN's price", async () => {
    const r = await checkSource(sourceById("eigenlayer-withdrawals")!, USER);
    const ready = r.findings.find((f) => f.status === "ready")!;
    assert.equal(ready.asset.usd, 361 * 0.25);
  });

  test("nothing without queued withdrawals; hidden when completing would be rejected", async () => {
    assert.deepEqual(await checkEigenWithdrawals(NOBODY), { findings: [], completed: 0 });
    assert.deepEqual((await checkEigenWithdrawals(REJECTED)).findings, []);
  });
});

describe("EigenLayer rewards", () => {
  const COORDINATOR: Address = "0x7750d328b314EfFa365A0402CcfD489B80B0adda";
  const DUSTY: Address = "0x8888888888888888888888888888888888888888"; // an operator's token with no price
  const WETH: Address = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
  const API = "https://sidecar-rpc.eigenlayer.xyz/mainnet/rewards/v1";
  const b64 = (hex: Hex) => base64.encode(hexToBytes(hex));
  const EARNER_PROOF: Hex = "0x010203";
  const TOKEN_ROOT: Hex = `0x${"ab".repeat(32)}`;
  const cumulative: Record<string, bigint> = { [lower(EIGEN)]: 150n * e18, [lower(DUSTY)]: 9n * e18, [lower(WETH)]: e18 };
  const claimedOnChain: Record<string, bigint> = { [`${USER}:${lower(EIGEN)}`]: 100n * e18, [`${CLAIMED}:${lower(EIGEN)}`]: 150n * e18 };
  const proofFor = (earner: Address, tokens: Address[]) => ({
    proof: {
      root: "AA==",
      rootIndex: 7,
      earnerIndex: 1234,
      earnerTreeProof: b64(EARNER_PROOF),
      earnerLeaf: { earner, earnerTokenRoot: b64(TOKEN_ROOT) },
      tokenIndices: tokens.map((_, i) => i + 1),
      tokenTreeProofs: tokens.map((_, i) => b64(`0x0${i + 1}`)),
      tokenLeaves: tokens.map((t) => ({ token: lower(t), cumulativeEarnings: String(cumulative[lower(t)]) })),
    },
  });
  before(() => {
    world.addContract(
      1,
      COORDINATOR,
      parseAbi([
        "struct EarnerTreeMerkleLeaf { address earner; bytes32 earnerTokenRoot; }",
        "struct TokenTreeMerkleLeaf { address token; uint256 cumulativeEarnings; }",
        "struct RewardsMerkleClaim { uint32 rootIndex; uint32 earnerIndex; bytes earnerTreeProof; EarnerTreeMerkleLeaf earnerLeaf; uint32[] tokenIndices; bytes[] tokenTreeProofs; TokenTreeMerkleLeaf[] tokenLeaves; }",
        "function processClaim(RewardsMerkleClaim claim, address recipient)",
        "function cumulativeClaimed(address earner, address token) view returns (uint256)",
        "function claimerFor(address earner) view returns (address)",
        "function getDistributionRootAtIndex(uint256 index) view returns ((bytes32 root, uint32 rewardsCalculationEndTimestamp, uint32 activatedAt, bool disabled))",
      ]),
      {
        processClaim: ([claim, recipient], { from }) => {
          const c = claim as {
            rootIndex: number;
            earnerTreeProof: Hex;
            earnerLeaf: { earner: Address; earnerTokenRoot: Hex };
            tokenIndices: number[];
            tokenTreeProofs: Hex[];
            tokenLeaves: { token: Address; cumulativeEarnings: bigint }[];
          };
          const earner = c.earnerLeaf.earner;
          const claimer = earner === SECOND ? USER : earner;
          if (from !== claimer) revert("UnauthorizedCaller");
          if (c.rootIndex !== 7 || c.earnerTreeProof !== EARNER_PROOF || c.earnerLeaf.earnerTokenRoot !== TOKEN_ROOT) revert("InvalidClaimProof");
          if (recipient !== earner) revert("wrong recipient");
          c.tokenLeaves.forEach((l, i) => {
            if (c.tokenTreeProofs[i] !== `0x0${c.tokenIndices[i]}`) revert("InvalidClaimProof");
            if (l.cumulativeEarnings <= (claimedOnChain[`${earner}:${lower(l.token)}`] ?? 0n)) revert("EarningsNotGreaterThanClaimed");
            if (lower(l.token) === lower(WETH) && earner === SECOND) revert("transfer failed"); // makes a claim of all tokens fail
          });
        },
        cumulativeClaimed: ([earner, t]) => claimedOnChain[`${earner}:${lower(t as string)}`] ?? 0n,
        claimerFor: ([earner]) => (earner === SECOND ? USER : "0x0000000000000000000000000000000000000000"),
        getDistributionRootAtIndex: ([i]) => ({ root: `0x${"11".repeat(32)}`, rewardsCalculationEndTimestamp: NOW - 10 * DAY, activatedAt: NOW - 3 * DAY, disabled: i !== 7n }),
      },
    );
    token(EIGEN, "EIGEN");
    token(DUSTY, "DUSTY");
    token(WETH, "WETH");
    world.prices[`ethereum:${lower(EIGEN)}`] = 0.25;
    world.prices[`ethereum:${lower(WETH)}`] = 3000;
    for (const who of [USER, SECOND, CLAIMED]) {
      world.static[`${API}/earners/${who}/summarized-rewards`] = {
        rewards: [EIGEN, DUSTY, WETH].map((t) => ({ token: lower(t), earned: "1", active: "1", claimed: "0", claimable: "1" })),
      };
    }
  });

  test("what the proof says is left on-chain, once processClaim simulates; unpriced operator tokens are left out", async () => {
    world.static[`${API}/claim-proof`] = proofFor(USER, [EIGEN, DUSTY, WETH]);
    const r = await checkEigenRewards(USER);
    const by = Object.fromEntries(r.findings.map((f) => [f.asset.symbol, f]));
    assert.deepEqual(Object.keys(by).sort(), ["EIGEN", "WETH"]);
    assert.equal(by.EIGEN.asset.amount, 50n * e18, "cumulative earnings minus what was already claimed");
    assert.equal(by.EIGEN.timestamp, NOW - 10 * DAY);
    assert.equal(by.EIGEN.dateLabel, "Earned through");
    assert.equal(by.WETH.asset.amount, e18);
  });

  test("the dust filter drops tiny rewards once priced", async () => {
    world.prices[`ethereum:${lower(WETH)}`] = 3; // 1 WETH worth $3: dust
    try {
      world.static[`${API}/claim-proof`] = proofFor(USER, [EIGEN, DUSTY, WETH]);
      const r = await checkSource(sourceById("eigenlayer-rewards")!, USER);
      assert.equal(r.state, "done");
      assert.deepEqual(r.findings.map((f) => f.asset.symbol), ["EIGEN"]);
    } finally {
      world.prices[`ethereum:${lower(WETH)}`] = 3000;
    }
  });

  test("a token that makes the claim fail is left out, the others are kept; the claimer address claims", async () => {
    world.static[`${API}/claim-proof`] = proofFor(SECOND, [EIGEN, WETH]);
    const r = await checkEigenRewards(SECOND);
    assert.deepEqual(r.findings.map((f) => f.asset.symbol), ["EIGEN"]);
    assert.equal(r.findings[0].asset.amount, 150n * e18);
    assert.match(r.findings[0].note ?? "", new RegExp(`claimed from ${USER}`));
  });

  test("nothing once claimed on-chain, and no API call for an address that never delegated", async () => {
    world.static[`${API}/claim-proof`] = proofFor(CLAIMED, [EIGEN]);
    assert.deepEqual(await checkEigenRewards(CLAIMED), { findings: [], completed: 0 });
    const seen = world.requests.length;
    assert.deepEqual(await checkEigenRewards(NOBODY), { findings: [], completed: 0 });
    assert.ok(!world.requests.slice(seen).some((u) => u.includes("sidecar")));
  });

  test("an API failure is an error, never a clean result", async () => {
    // REJECTED once queued a withdrawal (so it's asked about), but the API has no answer for it.
    await assert.rejects(checkEigenRewards(REJECTED), /EigenLayer rewards API: HTTP 404/);
    // Left in place for the RPC failure tests below.
    world.static[`${API}/claim-proof`] = proofFor(USER, [EIGEN, DUSTY, WETH]);
  });
});

/* ───────────────────────── Aave Safety Module ───────────────────────── */

describe("Aave Safety Module", () => {
  const STK: Record<string, Address> = {
    stkAAVE: "0x4da27a545c0c5B758a6BA100e3a049001de870f5",
    stkABPT: "0xa1116930326D21fB917d5A27F1E9943A9595fb47",
    stkAAVEwstETHBPTv2: "0x9eDA81C21C273a82BE9Bbc19B6A6182212068101",
    stkGHO: "0x1a88Df1cFe15Af22B3c4c783D4e6F7F9e0C1885d",
  };
  const rewards: Record<string, Record<string, bigint>> = {
    stkAAVE: { [USER]: 10n * e18 },
    stkGHO: { [USER]: 3n * e18, [REJECTED]: 8n * e18 },
  };
  before(() => {
    for (const [name, address] of Object.entries(STK))
      world.addContract(1, address, parseAbi(["function getTotalRewardsBalance(address staker) view returns (uint256)", "function claimRewards(address to, uint256 amount)"]), {
        getTotalRewardsBalance: ([a]) => rewards[name]?.[a as string] ?? 0n,
        claimRewards: ([to], { from }) => {
          // The rewards vault's allowance ran out for stkGHO.
          if (to !== from || (name === "stkGHO" && from === REJECTED)) revert("ERC20: transfer amount exceeds allowance");
        },
      });
  });

  test("finds AAVE rewards never claimed, per staking token", async () => {
    const r = await checkSafetyModule(USER);
    assert.deepEqual(r.findings.map((f) => [f.networkName, f.asset.amount]).sort(), [
      ["Aave staking rewards (stkAAVE)", 10n * e18],
      ["Aave staking rewards (stkGHO)", 3n * e18],
    ]);
    assert.ok(r.findings.every((f) => f.asset.symbol === "AAVE" && f.asset.token === "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9" && f.timestamp === 0));
  });

  test("nothing without rewards; hidden when the claim would be rejected", async () => {
    assert.deepEqual(await checkSafetyModule(NOBODY), { findings: [], completed: 0 });
    assert.deepEqual((await checkSafetyModule(REJECTED)).findings, []);
  });
});

/* ───────────────────────── Synthetix escrow ───────────────────────── */

describe("Synthetix escrow", () => {
  const ESCROW_ETH: Address = "0xFAd53Cc9480634563E8ec71E8e693Ffd07981d38";
  const ESCROW_OP: Address = "0x5Fc9B8d2B7766f061bD84a41255fD1A76Fd1FAa2";
  type Entry = { endTime: bigint; escrowAmount: bigint; entryID: bigint };
  const entry = (id: number, ageDays: number, amount: bigint): Entry => ({ endTime: BigInt(NOW - ageDays * DAY), escrowAmount: amount, entryID: BigInt(id) });
  const escrow = (chainId: number, address: Address, entries: Record<string, Entry[]>) =>
    world.addContract(
      chainId,
      address,
      parseAbi([
        "function numVestingEntries(address account) view returns (uint256)",
        "function getVestingSchedules(address account, uint256 index, uint256 pageSize) view returns ((uint64 endTime, uint256 escrowAmount, uint256 entryID)[])",
        "function getVestingQuantity(address account, uint256[] entryIDs) view returns (uint256)",
        "function vest(uint256[] entryIDs)",
      ]),
      {
        numVestingEntries: ([a]) => BigInt(entries[a as string]?.length ?? 0),
        getVestingSchedules: ([a, index, size]) => (entries[a as string] ?? []).slice(Number(index), Number(index) + Number(size)),
        getVestingQuantity: ([a, ids]) =>
          (entries[a as string] ?? []).filter((e) => (ids as bigint[]).includes(e.entryID) && e.endTime <= BigInt(NOW)).reduce((s, e) => s + e.escrowAmount, 0n),
        vest: ([ids], { from }) => {
          if (from === REJECTED) revert("Cannot transfer staked or escrowed SNX");
          if (!(ids as bigint[]).length) revert("no entries");
        },
      },
    );
  before(() => {
    escrow(1, ESCROW_ETH, {
      // Already vested (empty), vested and waiting, still escrowed.
      [USER]: [entry(1, 400, 0n), entry(2, 30, 100n * e18), entry(3, 20, 15n * e18), entry(4, -30, 50n * e18)],
      [REJECTED]: [entry(9, 30, 4n * e18)],
      [CLAIMED]: [entry(8, 300, 0n)],
    });
    escrow(10, ESCROW_OP, { [USER]: [entry(100, 60, 7n * e18)] });
  });

  test("vested entries never claimed, on Ethereum and OP Mainnet", async () => {
    const r = await checkSynthetixEscrow(USER);
    assert.equal(r.error, undefined);
    const eth = r.findings.find((f) => f.asset.tokenChain === "ethereum")!;
    const op = r.findings.find((f) => f.asset.tokenChain === "optimism")!;
    assert.equal(eth.asset.amount, 115n * e18, "only entries already vested");
    assert.equal(eth.timestamp, NOW - 30 * DAY, "since the oldest vested entry");
    assert.equal(eth.dateLabel, "Vested since");
    assert.match(eth.note ?? "", /\[2,3\]/);
    assert.equal(eth.minUsd, 5);
    assert.equal(op.asset.amount, 7n * e18);
    assert.equal(op.asset.token, "0x8700dAec35aF8Ff88c16BdF0418774CB3D7599B4");
    assert.equal(op.minUsd, 1, "dust threshold off Ethereum");
    assert.match(op.txUrl, /^https:\/\/optimistic\.etherscan\.io\/address\//);
  });

  test("nothing when all was vested or there's no escrow; hidden when vest would be rejected", async () => {
    assert.deepEqual(await checkSynthetixEscrow(CLAIMED), { findings: [], completed: 0 });
    assert.deepEqual(await checkSynthetixEscrow(NOBODY), { findings: [], completed: 0 });
    assert.deepEqual((await checkSynthetixEscrow(REJECTED)).findings, []);
  });

  test("one chain down keeps the other's result but reads as failed; both down is an error", async () => {
    const r = await withOutage((url) => rpcsOf(10).has(url), () => checkSource(sourceById("synthetix-escrow")!, USER));
    assert.equal(r.state, "error");
    assert.match(r.error ?? "", /OP Mainnet/);
    assert.deepEqual(r.findings.map((f) => f.asset.tokenChain), ["ethereum"]);
    await withOutage((url) => rpcsOf(1).has(url) || rpcsOf(10).has(url), () => assert.rejects(checkSynthetixEscrow(USER)));
  });
});

/* ───────────────────────── Convex ───────────────────────── */

describe("Convex staking", () => {
  const CVX_POOL: Address = "0xCF50b810E57Ac33B91dCF525C6ddd9881B139332";
  const CVXCRV_POOL: Address = "0x3Fe65692bfCD0e6CF84cB1E7d24108E434A7587e";
  const EXTRA_3CRV: Address = "0x7091dbb7fcbA54569eF1387Ac89Eb2a5C9F6d2EA";
  const EXTRA_CRVUSD: Address = "0x191F455cc8acdd579f4E6956fC7007c9668C2289";
  const abi = parseAbi([
    "function earned(address) view returns (uint256)",
    "function balanceOf(address) view returns (uint256)",
    "function getReward(address _account, bool _claimExtras, bool _stake)",
    "function getReward(address _account, bool _claimExtras) returns (bool)",
  ]);
  const pool = (address: Address, earned: Record<string, bigint>, staked: Record<string, bigint> = {}) =>
    world.addContract(1, address, abi, {
      earned: ([a]) => earned[a as string] ?? 0n,
      balanceOf: ([a]) => staked[a as string] ?? 0n,
      getReward: ([a], { from }) => {
        if (a === REJECTED || from !== a) revert("!auth");
      },
    });
  before(() => {
    pool(CVX_POOL, { [USER]: 2000n * e18, [REJECTED]: 5n * e18 }, { [USER]: 3000n * e18 });
    pool(CVXCRV_POOL, { [USER]: 600n * e18 });
    pool(EXTRA_3CRV, { [USER]: 50n * e18 });
    pool(EXTRA_CRVUSD, {});
  });

  test("rewards never claimed from both old pools, CVX staking's paid as cvxCRV", async () => {
    const r = await checkConvex(USER);
    const by = Object.fromEntries(r.findings.map((f) => [f.asset.symbol, f]));
    assert.deepEqual(Object.keys(by).sort(), ["3CRV", "CRV", "cvxCRV"]);
    assert.equal(by.cvxCRV.asset.amount, 2000n * e18);
    assert.match(by.cvxCRV.note ?? "", /3,000 CVX staked/);
    assert.equal(by.CRV.asset.amount, 600n * e18);
    assert.equal(by["3CRV"].asset.amount, 50n * e18);
  });

  test("nothing without rewards; hidden when the claim would be rejected", async () => {
    assert.deepEqual(await checkConvex(NOBODY), { findings: [], completed: 0 });
    assert.deepEqual((await checkConvex(REJECTED)).findings, []);
  });
});

/* ───────────────────────── Wiring ───────────────────────── */

const CHECKS: Record<string, (user: Address) => Promise<{ findings: unknown[]; error?: string }>> = {
  "lido-withdrawals": checkLido,
  "expired-locks": checkLocks,
  "curve-fees": checkCurveFees,
  "eigenlayer-withdrawals": checkEigenWithdrawals,
  "eigenlayer-rewards": checkEigenRewards,
  "aave-safety-module": checkSafetyModule,
  "synthetix-escrow": checkSynthetixEscrow,
  "convex-staking": checkConvex,
  "balancer-fees": checkBalancerFees,
};
const IDS = Object.keys(CHECKS);

describe("RPC failures", () => {
  // Every check, at once (the RPC clients retry with back-off: a failing check takes seconds).
  /** Every check failed; Synthetix still has OP Mainnet's answer, and reports Ethereum's failure. */
  const assertAllFailed = (results: PromiseSettledResult<{ error?: string }>[]) =>
    results.forEach((r, i) => {
      if (IDS[i] !== "synthetix-escrow") return assert.equal(r.status, "rejected", IDS[i]);
      assert.equal(r.status, "fulfilled");
      assert.match((r as PromiseFulfilledResult<{ error?: string }>).value.error ?? "", /^Ethereum: /);
    });

  test("Ethereum's RPC nodes down: every check fails, none reads as clean", async () => {
    await ethereumDown(async () => {
      assertAllFailed(await Promise.allSettled(IDS.map((id) => CHECKS[id](USER))));
      const shown = await Promise.all(IDS.map((id) => checkSource(sourceById(id)!, USER)));
      shown.forEach((r) => assert.equal(r.state, "error", r.networkId));
    });
  });

  test("a dry run failing at the node (not a revert) is an error too, not a hidden claim", async () => {
    await dryRunsDown(async () => assertAllFailed(await Promise.allSettled(IDS.map((id) => CHECKS[id](USER)))));
  });
});

describe("Rewards sources", () => {
  test("each runs for Ethereum addresses only, in the rewards group, with a color and the rewards guide", () => {
    for (const id of IDS) {
      const s = sourceById(id);
      assert.ok(s, id);
      assert.equal(s.group, "rewards");
      assert.deepEqual(s.accepts, ["evm"]);
      assert.ok(NETWORK_COLORS[id], `${id} has a brand color`);
    }
    assert.ok(!sourcesFor("solana").some((s) => IDS.includes(s.id)));
    const guide = GUIDES.find((g) => g.id === "rewards");
    assert.ok(guide?.live);
  });

  test("a clean address is clean everywhere, with no error", async () => {
    for (const id of IDS) {
      const r = await checkSource(sourceById(id)!, NOBODY);
      assert.equal(r.state, "done", `${id}: ${r.error}`);
      assert.deepEqual(r.findings, [], id);
    }
  });
});
