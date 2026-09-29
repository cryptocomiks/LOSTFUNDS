import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { encodeErrorResult, parseAbi, parseAbiItem, parseEther, zeroAddress, zeroHash, type Address, type Hex } from "viem";
import { checkNetwork } from "../src/lib/checker.ts";
import { networkById } from "../src/lib/networks.ts";
import { MockChain } from "./mockchain.ts";

/**
 * OP Stack chains that differ from the standard: Mantle (MNT native, ETH bridged, its own
 * MessagePassed event), custom gas tokens (Celo), Boba's ETH token, retired dispute games,
 * zero-value withdrawals, legacy proofs made stale by an output oracle change.
 */

const USER: Address = "0x1111111111111111111111111111111111111111";
const DAY = 86_400;
const now = Math.floor(Date.now() / 1000);
const h = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;

const PASSER: Address = "0x4200000000000000000000000000000000000016";
const BRIDGE: Address = "0x4200000000000000000000000000000000000010";
const MESSENGER: Address = "0x4200000000000000000000000000000000000007";

const ev = {
  mantlePassed: parseAbiItem(
    "event MessagePassed(uint256 indexed nonce, address indexed sender, address indexed target, uint256 mntValue, uint256 ethValue, uint256 gasLimit, bytes data, bytes32 withdrawalHash)",
  ),
  passed: parseAbiItem(
    "event MessagePassed(uint256 indexed nonce, address indexed sender, address indexed target, uint256 value, uint256 gasLimit, bytes data, bytes32 withdrawalHash)",
  ),
  withdrawalInitiated: parseAbiItem(
    "event WithdrawalInitiated(address indexed l1Token, address indexed l2Token, address indexed from, address to, uint256 amount, bytes extraData)",
  ),
  ethBridgeInitiated: parseAbiItem("event ETHBridgeInitiated(address indexed from, address indexed to, uint256 amount, bytes extraData)"),
  erc20BridgeInitiated: parseAbiItem(
    "event ERC20BridgeInitiated(address indexed localToken, address indexed remoteToken, address indexed from, address to, uint256 amount, bytes extraData)",
  ),
};

const erc20Meta = parseAbi(["function decimals() view returns (uint8)", "function symbol() view returns (string)"]);
const legacyPortal = parseAbi([
  "function version() view returns (string)",
  "function provenWithdrawals(bytes32) view returns (bytes32 outputRoot, uint128 timestamp, uint128 l2OutputIndex)",
  "function finalizedWithdrawals(bytes32) view returns (bool)",
]);
const outputOracle = parseAbi([
  "function getL2OutputIndexAfter(uint256) view returns (uint256)",
  "function getL2Output(uint256) view returns ((bytes32 outputRoot, uint128 timestamp, uint128 l2BlockNumber))",
  "function FINALIZATION_PERIOD_SECONDS() view returns (uint256)",
]);
const portal2 = parseAbi([
  "function version() view returns (string)",
  "function finalizedWithdrawals(bytes32) view returns (bool)",
  "function numProofSubmitters(bytes32) view returns (uint256)",
  "function proofSubmitters(bytes32, uint256) view returns (address)",
  "function provenWithdrawals(bytes32, address) view returns (address disputeGameProxy, uint64 timestamp)",
  "function checkWithdrawal(bytes32, address) view",
  "function anchorStateRegistry() view returns (address)",
]);
const revert = (error: string) => {
  throw { data: encodeErrorResult({ abi: parseAbi([`error ${error}()`]), errorName: error }) };
};

type Log = { address: Address; event: (typeof ev)[keyof typeof ev]; args: Record<string, unknown> };

const world = new MockChain();
world.prices = {
  "coingecko:ethereum": 3000,
  "coingecko:celo": 0.5,
  "ethereum:0x3c3a81e81dc49a522a592e7622a7e711c06bf354": 0.8, // MNT
};

let n = 0;
/** A withdrawal transaction sent by USER; returns its withdrawal hash. */
function withdrawal(chainId: number, o: { daysAgo: number; to: Address; logs: (withdrawalHash: Hex) => Log[] }): Hex {
  n++;
  const withdrawalHash = h(0xa0000 + n);
  world.addTx({
    chainId,
    hash: h(0xb0000 + n),
    from: USER,
    to: o.to,
    blockNumber: BigInt(90_000_000 + n * 1000),
    timestamp: now - o.daysAgo * DAY,
    logs: o.logs(withdrawalHash),
  });
  return withdrawalHash;
}

/* ───────────── Mantle: legacy portal + output oracle, MNT native, ETH bridged ───────────── */

const MANTLE = 5000;
const MNT_L1: Address = "0x3c3a81e81dc49A522A592e7622A7E711c06bf354";
const BVM_ETH: Address = "0xdEAddEaDdeadDEadDEADDEAddEADDEAddead1111";
const outputRoot = (index: bigint) => h(0xf0000 + Number(index));
const mantleProofs: Record<Hex, readonly [Hex, bigint, bigint]> = {};
const mantleFinalized = new Set<Hex>();

function mantle(o: { daysAgo: number; mnt?: bigint; eth?: bigint; bridge?: [l1Token: Address, l2Token: Address] }) {
  return withdrawal(MANTLE, {
    daysAgo: o.daysAgo,
    to: o.bridge ? BRIDGE : PASSER,
    logs: (withdrawalHash) => [
      ...(o.bridge
        ? [{ address: BRIDGE, event: ev.withdrawalInitiated, args: { l1Token: o.bridge[0], l2Token: o.bridge[1], from: USER, to: USER, amount: (o.mnt ?? 0n) + (o.eth ?? 0n), extraData: "0x" } }]
        : []),
      {
        address: PASSER,
        event: ev.mantlePassed,
        args: { nonce: BigInt(n), sender: o.bridge ? MESSENGER : USER, target: USER, mntValue: o.mnt ?? 0n, ethValue: o.eth ?? 0n, gasLimit: 0n, data: "0x", withdrawalHash },
      },
    ],
  });
}
/** Proves a Mantle withdrawal against the output covering its block (or a root the oracle no longer has). */
const proveMantle = (hash: Hex, daysAgo: number, staleRoot = false) => {
  const index = BigInt(90_000 + n); // the output right after the withdrawal's block
  mantleProofs[hash] = [staleRoot ? h(0xdead) : outputRoot(index), BigInt(now - daysAgo * DAY), index];
};

const mntDirect = mantle({ daysAgo: 30, mnt: parseEther("10") });
const ethReady = mantle({ daysAgo: 10, eth: parseEther("0.3"), bridge: [zeroAddress, BVM_ETH] });
proveMantle(ethReady, 2);
const mntDone = mantle({ daysAgo: 40, mnt: parseEther("5"), bridge: [MNT_L1, zeroAddress] });
proveMantle(mntDone, 39);
mantleFinalized.add(mntDone);
const ethStale = mantle({ daysAgo: 50, eth: parseEther("0.7"), bridge: [zeroAddress, BVM_ETH] });
proveMantle(ethStale, 45, true);
mantle({ daysAgo: 20 }); // nothing in it
const mntWaiting = mantle({ daysAgo: 20, mnt: parseEther("2"), bridge: [MNT_L1, zeroAddress] });
proveMantle(mntWaiting, 1 / 24);

world.addContract(1, "0xc54cb22944F2bE476E02dECfCD7e3E7d3e15A8Fb", legacyPortal, {
  version: () => "1.7.0",
  provenWithdrawals: ([hash]) => mantleProofs[hash as Hex] ?? [zeroHash, 0n, 0n],
  finalizedWithdrawals: ([hash]) => mantleFinalized.has(hash as Hex),
});
world.addContract(1, "0x31d543e7BE1dA6eFDc2206Ef7822879045B9f481", outputOracle, {
  getL2OutputIndexAfter: ([block]) => (block as bigint) / 1000n,
  getL2Output: ([index]) => ({ outputRoot: outputRoot(index as bigint), timestamp: BigInt(now - 30 * DAY), l2BlockNumber: (index as bigint) * 1000n }),
  FINALIZATION_PERIOD_SECONDS: () => 43_200n,
});

/* ───────────── Celo: fault proofs, CELO as custom gas token ───────────── */

const CELO = 42220;
const CELO_L1: Address = "0x057898f3C43F129a17517B9056D23851F124b19f";
const WETH_L1: Address = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const CELO_WETH: Address = "0xD221812de1BD094f35587EE8E174B07B6167D9Af";
const ASR: Address = "0x00000000000000000000000000000000000a5a5a";
const RETIRED_GAME: Address = "0x0000000000000000000000000000000000006a3e";
const passed = (sender: Address, value: bigint) => (withdrawalHash: Hex): Log => ({
  address: PASSER,
  event: ev.passed,
  args: { nonce: BigInt(n), sender, target: USER, value, gasLimit: 0n, data: "0x", withdrawalHash },
});

const celoDirect = withdrawal(CELO, { daysAgo: 60, to: PASSER, logs: (w) => [passed(USER, parseEther("0.1"))(w)] });
const wethOnRetiredGame = withdrawal(CELO, {
  daysAgo: 30,
  to: BRIDGE,
  logs: (w) => [
    { address: BRIDGE, event: ev.withdrawalInitiated, args: { l1Token: WETH_L1, l2Token: CELO_WETH, from: USER, to: USER, amount: parseEther("1"), extraData: "0x" } },
    { address: BRIDGE, event: ev.erc20BridgeInitiated, args: { localToken: CELO_WETH, remoteToken: WETH_L1, from: USER, to: USER, amount: parseEther("1"), extraData: "0x" } },
    passed(MESSENGER, 0n)(w),
  ],
});
const celoViaEthPath = withdrawal(CELO, {
  daysAgo: 30,
  to: BRIDGE,
  logs: (w) => [
    { address: BRIDGE, event: ev.ethBridgeInitiated, args: { from: USER, to: USER, amount: parseEther("2"), extraData: "0x" } },
    passed(MESSENGER, parseEther("2"))(w),
  ],
});
const celoDone = withdrawal(CELO, { daysAgo: 90, to: PASSER, logs: (w) => [passed(USER, parseEther("1"))(w)] });
withdrawal(CELO, { daysAgo: 90, to: PASSER, logs: (w) => [passed(USER, 0n)(w)] }); // test transaction, nothing to claim

world.addContract(1, "0xc5c5D157928BDBD2ACf6d0777626b6C75a9EAEDC", portal2, {
  version: () => "5.1.1",
  finalizedWithdrawals: ([hash]) => hash === celoDone,
  numProofSubmitters: ([hash]) => (hash === wethOnRetiredGame ? 1n : 0n),
  proofSubmitters: () => USER,
  provenWithdrawals: ([hash]) => (hash === wethOnRetiredGame ? [RETIRED_GAME, BigInt(now - 20 * DAY)] : [zeroAddress, 0n]),
  checkWithdrawal: ([hash]) => revert(hash === wethOnRetiredGame ? "OptimismPortal_InvalidRootClaim" : "OptimismPortal_Unproven"),
  anchorStateRegistry: () => ASR,
});
world.addContract(1, ASR, parseAbi([
  "function isGameProper(address) view returns (bool)",
  "function isGameRespected(address) view returns (bool)",
  "function isGameFinalized(address) view returns (bool)",
]), {
  isGameProper: () => true,
  isGameRespected: () => revert("GameRetired"), // games from before an upgrade can make this revert
  isGameFinalized: () => true,
});
world.addContract(1, WETH_L1, erc20Meta, { decimals: () => 18, symbol: () => "WETH" });

/* ───────────── Boba: ETH bridged under L2 token 0x4200…0006 ───────────── */

const BOBA = 288;
withdrawal(BOBA, {
  daysAgo: 300,
  to: BRIDGE,
  logs: (w) => [
    {
      address: BRIDGE,
      event: ev.withdrawalInitiated,
      args: { l1Token: zeroAddress, l2Token: "0x4200000000000000000000000000000000000006", from: USER, to: USER, amount: parseEther("0.012"), extraData: "0x" },
    },
    passed(MESSENGER, parseEther("0.012"))(w),
  ],
});
world.addContract(1, "0x7B02D13904D8e6E0f0Efaf756aB14Cb0FF21eE7e", portal2, {
  version: () => "5.2.0",
  finalizedWithdrawals: () => false,
  numProofSubmitters: () => 0n,
  proofSubmitters: () => USER,
  provenWithdrawals: () => [zeroAddress, 0n],
  checkWithdrawal: () => revert("OptimismPortal_Unproven"),
});

/* ───────────── Orderly: RPC node as the only history source ───────────── */

const ORDERLY = 291;
for (let i = 0; i < 12; i++) withdrawal(ORDERLY, { daysAgo: 100 + i, to: PASSER, logs: (w) => [passed(USER, parseEther("0.01"))(w)] });
world.addContract(1, "0x91493a61ab83b62943E6dCAa5475Dd330704Cc84", portal2, {
  version: () => "5.6.1",
  finalizedWithdrawals: () => true,
});

before(() => {
  globalThis.fetch = world.fetch as typeof fetch;
});

const run = (id: string) => checkNetwork(networkById(id)!, USER);
const byKey = (r: Awaited<ReturnType<typeof run>>) => Object.fromEntries(r.findings.map((f) => [f.id.split(":").pop()!, f]));

describe("Mantle", () => {
  test("reads Mantle's own MessagePassed event: MNT is native, ETH is a bridged token", async () => {
    const r = await run("mantle");
    assert.equal(r.state, "done", r.error ?? "");
    assert.equal(r.completed, 1, "the finalized MNT withdrawal");
    const f = byKey(r);
    assert.deepEqual(Object.keys(f).sort(), [ethReady, ethStale, mntDirect, mntWaiting].sort(), "the empty withdrawal is skipped");

    assert.equal(f[mntDirect].status, "prove");
    assert.equal(f[mntDirect].asset.symbol, "MNT");
    assert.equal(f[mntDirect].asset.amount, parseEther("10"));
    assert.equal(f[mntDirect].asset.token, MNT_L1);
    assert.equal(f[mntDirect].asset.usd, 8);

    assert.equal(f[ethReady].status, "ready");
    assert.equal(f[ethReady].asset.symbol, "ETH");
    assert.equal(f[ethReady].asset.amount, parseEther("0.3"));
    assert.equal(f[ethReady].asset.usd, 900);
    assert.match(f[ethReady].txUrl, /^https:\/\/mantlescan\.xyz\/tx\/0x/);

    assert.equal(f[mntWaiting].status, "waiting");
    assert.equal(f[mntWaiting].asset.symbol, "MNT", "MNT sent through the bridge");
    assert.equal(f[mntWaiting].asset.amount, parseEther("2"));
    assert.ok(Math.abs(f[mntWaiting].readyAt! - (now + 11 * 3600)) < 120, "12 hours after the proof");
  });

  test("a proof against an output the oracle no longer has must be redone", async () => {
    const r = await run("mantle");
    const f = byKey(r)[ethStale];
    assert.equal(f.status, "prove");
    assert.equal(f.asset.amount, parseEther("0.7"));
  });

  test("asks Routescan for 1000 logs per page (it returns 100 by default)", async () => {
    world.requests = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("action=txlist")) return new Response("down", { status: 403 });
      return world.fetch(input, init);
    }) as typeof fetch;
    try {
      const r = await run("mantle");
      assert.equal(r.state, "done", r.error ?? "");
      assert.equal(r.findings.length, 4);
    } finally {
      globalThis.fetch = world.fetch as typeof fetch;
    }
    const logQueries = world.requests.filter((u) => u.includes("api.routescan.io") && u.includes("action=getLogs"));
    assert.ok(logQueries.length > 0);
    for (const u of logQueries) assert.match(u, /[?&]page=1&offset=1000/);
  });
});

describe("Custom gas token (Celo)", () => {
  test("native withdrawals are CELO, priced as CELO; tokens keep their own symbol", async () => {
    const r = await run("celo");
    assert.equal(r.state, "done", r.error ?? "");
    assert.equal(r.completed, 1);
    const f = byKey(r);
    assert.deepEqual(Object.keys(f).sort(), [celoDirect, celoViaEthPath, wethOnRetiredGame].sort(), "the zero-value withdrawal is skipped");

    assert.equal(f[celoDirect].status, "prove");
    assert.deepEqual(
      { ...f[celoDirect].asset },
      { symbol: "CELO", decimals: 18, amount: parseEther("0.1"), token: CELO_L1, tokenChain: "ethereum", priceKey: "coingecko:celo", usd: 0.05 },
    );
    assert.equal(f[celoViaEthPath].asset.symbol, "CELO", "the bridge's ETH path moves the native currency");
    assert.equal(f[celoViaEthPath].asset.amount, parseEther("2"));
  });

  test("a proof on a retired dispute game means proving again, not an error", async () => {
    const r = await run("celo");
    assert.equal(r.state, "done", r.error ?? "");
    const f = byKey(r)[wethOnRetiredGame];
    assert.equal(f.status, "prove");
    assert.equal(f.asset.symbol, "WETH");
    assert.equal(f.asset.amount, parseEther("1"));
  });
});

describe("Boba", () => {
  test("ETH bridged under L2 token 0x4200…0006 shows as ETH", async () => {
    const r = await run("boba");
    assert.equal(r.state, "done", r.error ?? "");
    assert.equal(r.findings.length, 1);
    assert.equal(r.findings[0].status, "prove");
    assert.equal(r.findings[0].asset.symbol, "ETH");
    assert.equal(r.findings[0].asset.amount, parseEther("0.012"));
    assert.equal(r.findings[0].asset.usd, 36);
  });
});

describe("RPC history source", () => {
  test("fills in block timestamps a busy node left out of a batch", async () => {
    let dropped = 0;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const res = await world.fetch(input, init);
      if (!url.startsWith("https://rpc.orderly.network") || !String(init?.body).startsWith("[")) return res;
      // Rate-limited batch: every other entry comes back as an error.
      const replies = (await res.json()) as { id: number }[];
      return Response.json(
        replies.map((r) => (r.id % 2 ? (dropped++, { jsonrpc: "2.0", id: r.id, error: { code: -32005, message: "Rate Limit Exceeded" } }) : r)),
      );
    }) as typeof fetch;
    try {
      const r = await run("orderly");
      assert.equal(r.state, "done", r.error ?? "");
      assert.equal(r.completed, 12);
      assert.ok(dropped >= 6);
    } finally {
      globalThis.fetch = world.fetch as typeof fetch;
    }
  });
});
