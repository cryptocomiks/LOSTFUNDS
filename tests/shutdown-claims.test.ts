import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { base64 } from "@scure/base";
import { before, describe, test } from "node:test";
import { concat, getAddress, keccak256, numberToHex, parseAbi, type Address, type Hex } from "viem";
import { checkSource } from "../src/lib/checker.ts";
import { checkKinto, KINTO_LEFTOVER } from "../src/lib/checks/kinto.ts";
import { checkStargateUsdc, STARGATE_CHAINS, VE_DISTRIBUTOR } from "../src/lib/checks/stargate.ts";
import { checkZkSyncLite, ZKSYNC_LITE_CLAIM, ZKSYNC_LITE_ROOT, type ZkSyncLiteShard } from "../src/lib/checks/zksync-lite.ts";
import { NETWORK_COLORS } from "../src/lib/brand.ts";
import { GUIDES } from "../src/content/guides.ts";
import { GUIDES_FR } from "../src/content/guides.fr.ts";
import { EVM_CHAINS } from "../src/lib/evm.ts";
import { L1 } from "../src/lib/networks.ts";
import { sourceById } from "../src/lib/sources.ts";
import { MockChain, revert } from "./mockchain.ts";

/** Has something everywhere. */
const USER: Address = "0x1111111111111111111111111111111111111111";
/** Has nothing anywhere. */
const STRANGER: Address = "0x7777777777777777777777777777777777777777";
/** Claimed everything already. */
const CLAIMED: Address = "0x4444444444444444444444444444444444444444";
/** Has an amount the contract won't pay (paused, or not enough left). */
const REJECTED: Address = "0x5555555555555555555555555555555555555555";

const e6 = 10n ** 6n;
const e18 = 10n ** 18n;

const world = new MockChain();
before(() => {
  globalThis.fetch = world.fetch as typeof fetch;
  world.prices["coingecko:ethereum"] = 2500;
  for (const c of STARGATE_CHAINS) world.prices[`${c.tokenChain}:${c.token.toLowerCase()}`] = 1;
});

/** Runs `fn` while the RPC nodes of these chains answer HTTP 503. */
async function withChainsDown<T>(chainIds: number[], fn: () => Promise<T>): Promise<T> {
  const down = new Set(
    [...(chainIds.includes(1) ? L1.rpcs : []), ...EVM_CHAINS.filter((c) => chainIds.includes(c.id)).flatMap((c) => c.rpcs)].map((u) => u.replace(/\/$/, "")),
  );
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input).replace(/\/$/, "");
    if (down.has(url)) return new Response("Service Unavailable", { status: 503 });
    return world.fetch(input, init);
  }) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = world.fetch as typeof fetch;
  }
}

/* ───────────────────────── Stargate veSTG USDC ───────────────────────── */

describe("Stargate veSTG USDC", () => {
  // What each address can still claim, and has claimed, per chain.
  const left: Record<number, Record<string, bigint>> = {
    1: { [USER]: 438_880_819n, [REJECTED]: 9n * e6 },
    42161: { [USER]: 12n * e6 },
    56: { [USER]: 3n * e18 }, // USDT, 18 decimals
  };
  const claimed: Record<number, Record<string, bigint>> = { 1: { [CLAIMED]: 50n * e6 }, 10: { [CLAIMED]: 2n * e6, [USER]: 1n * e6 } };
  before(() => {
    const abi = parseAbi([
      "function getUsdcClaimable(address _user) view returns (uint256 usdcClaimable)",
      "function userClaimedAmounts(address user) view returns (uint256 claimedAmount)",
      "function claimUsdc() returns (uint256 usdcClaimed)",
    ]);
    for (const { chainId } of STARGATE_CHAINS)
      world.addContract(chainId, VE_DISTRIBUTOR, abi, {
        getUsdcClaimable: ([a]) => left[chainId]?.[a as string] ?? 0n,
        userClaimedAmounts: ([a]) => claimed[chainId]?.[a as string] ?? 0n,
        claimUsdc: (_, { from }) => {
          const amount = left[chainId]?.[from as string] ?? 0n;
          if (!amount) revert("NothingToClaim()");
          if (from === REJECTED) revert("EnforcedPause()");
          return amount;
        },
      });
  });

  test("finds the share never claimed on each chain, as the claim pays it", async () => {
    const r = await checkStargateUsdc(USER);
    assert.equal(r.error, undefined);
    assert.equal(r.completed, 1, "OP Mainnet: claimed, nothing left");
    const by = Object.fromEntries(r.findings.map((f) => [f.networkName, f]));
    assert.deepEqual(Object.keys(by).sort(), [
      "Stargate veSTG revenue share (Arbitrum)",
      "Stargate veSTG revenue share (BNB Chain)",
      "Stargate veSTG revenue share (Ethereum)",
    ]);
    const eth = by["Stargate veSTG revenue share (Ethereum)"];
    assert.equal(eth.asset.amount, 438_880_819n);
    assert.equal(eth.asset.symbol, "USDC");
    assert.equal(eth.asset.token, "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
    assert.equal(eth.guideId, "rewards");
    assert.equal(eth.txUrl, `https://etherscan.io/address/${VE_DISTRIBUTOR}#writeContract`);
    const bsc = by["Stargate veSTG revenue share (BNB Chain)"];
    assert.deepEqual([bsc.asset.symbol, bsc.asset.decimals, bsc.asset.amount], ["USDT", 18, 3n * e18]);
  });

  test("nothing for a stranger; a fully claimed share counts as claimed; a claim the contract refuses is hidden", async () => {
    assert.deepEqual(await checkStargateUsdc(STRANGER), { findings: [], completed: 0 });
    assert.deepEqual(await checkStargateUsdc(CLAIMED), { findings: [], completed: 2 });
    assert.deepEqual(await checkStargateUsdc(REJECTED), { findings: [], completed: 0 });
  });

  test("priced and shown through its source, in the rewards group", async () => {
    const src = sourceById("stargate-vestg")!;
    assert.equal(src.group, "rewards");
    assert.deepEqual(src.accepts, ["evm"]);
    assert.ok(NETWORK_COLORS["stargate-vestg"]);
    const r = await checkSource(src, USER);
    assert.equal(r.state, "done");
    assert.equal(Math.round(r.findings.find((f) => f.asset.tokenChain === "ethereum")!.asset.usd!), 439);
  });

  test("one chain down keeps the others' results but reads as failed; all down throws", async () => {
    const r = await withChainsDown([42161], () => checkStargateUsdc(USER));
    assert.equal(r.findings.length, 2);
    assert.match(r.error ?? "", /^Arbitrum: /);
    await withChainsDown(
      STARGATE_CHAINS.map((c) => c.chainId),
      () => assert.rejects(checkStargateUsdc(USER)),
    );
    const shown = await withChainsDown([1], () => checkSource(sourceById("stargate-vestg")!, USER));
    assert.equal(shown.state, "error");
  });
});

/* ───────────────────────── Kinto ───────────────────────── */

describe("Kinto leftover balances", () => {
  const infos: Record<string, [bigint, boolean]> = {
    [USER]: [9_471_564_141n, false],
    [CLAIMED]: [120n * e6, true],
    [REJECTED]: [80n * e6, false],
  };
  before(() => {
    world.addContract(1, KINTO_LEFTOVER, parseAbi(["function userInfos(address) view returns (uint256 amount, bool claimed)", "function acceptAndClaim()"]), {
      userInfos: ([a]) => infos[a as string] ?? [0n, false],
      acceptAndClaim: (_, { from }) => {
        const [amount, done] = infos[from as string] ?? [0n, false];
        if (done) revert("Already claimed");
        if (!amount) revert("Nothing to claim");
        if (from === REJECTED) revert("ERC20: transfer amount exceeds balance");
      },
    });
  });

  test("finds the USDC waiting for the address, once the claim simulates", async () => {
    const r = await checkKinto(USER);
    assert.equal(r.findings.length, 1);
    const [f] = r.findings;
    assert.deepEqual([f.asset.symbol, f.asset.decimals, f.asset.amount, f.asset.token], ["USDC", 6, 9_471_564_141n, "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"]);
    assert.equal(f.status, "ready");
    assert.equal(f.guideId, "legacy-deposits");
    assert.match(f.note ?? "", /acceptAndClaim\(\)/);
  });

  test("nothing for a stranger; claimed counts as claimed; an amount the contract can't pay is hidden", async () => {
    assert.deepEqual(await checkKinto(STRANGER), { findings: [], completed: 0 });
    assert.deepEqual(await checkKinto(CLAIMED), { findings: [], completed: 1 });
    assert.deepEqual(await checkKinto(REJECTED), { findings: [], completed: 0 });
  });

  test("an RPC failure fails the check instead of reporting it clean", async () => {
    await withChainsDown([1], () => assert.rejects(checkKinto(USER)));
    const shown = await withChainsDown([1], () => checkSource(sourceById("kinto")!, USER));
    assert.equal(shown.state, "error");
  });

  test("in the legacy group, with a color and a guide step in both languages", () => {
    const src = sourceById("kinto")!;
    assert.equal(src.group, "legacy");
    assert.ok(NETWORK_COLORS.kinto);
    const en = GUIDES.find((g) => g.id === "legacy-deposits")!;
    assert.ok(en.steps.some((s) => s.includes(KINTO_LEFTOVER)));
    assert.ok(GUIDES_FR["legacy-deposits"].steps!.some((s) => s.includes(KINTO_LEFTOVER)));
  });
});

/* ───────────────────────── zkSync Lite ───────────────────────── */

describe("zkSync Lite", () => {
  // A real address from the published list, with four balances (and its real proofs, which the mock contract verifies).
  const HOLDER = getAddress("0xb57b8bbfe2b3d3874c9300a95c7587dc341111e7");
  /** In the same file, but not listed. */
  const NOT_LISTED: Address = "0xb500000000000000000000000000000000000001";
  const FILE = "https://lostfunds.vercel.app/legacy/zksync-lite/b5.json";
  const shard = JSON.parse(readFileSync(new URL("../public/legacy/zksync-lite/b5.json", import.meta.url), "utf8")) as ZkSyncLiteShard;
  const claimed = new Set<bigint>();
  let root: Hex = ZKSYNC_LITE_ROOT;
  /** Tokens the contract would fail to pay. */
  const unpaid = new Set<string>();
  before(() => {
    world.static[FILE] = shard;
    world.addContract(
      1,
      ZKSYNC_LITE_CLAIM,
      parseAbi([
        "function MERKLE_ROOT() view returns (bytes32)",
        "function isClaimed(uint256 index) view returns (bool)",
        "function claim(uint256 index, address token, uint256 amount, bytes32[] merkleProof)",
      ]),
      {
        MERKLE_ROOT: () => root,
        isClaimed: ([i]) => claimed.has(i as bigint),
        // As the contract does: the leaf, from the sender, must lead to the root through the proof.
        claim: ([index, token, amount, proof], { from }) => {
          if (claimed.has(index as bigint)) revert("ZkSyncLiteSunsetClaimDistributor__AlreadyClaimed()");
          let h = keccak256(concat([numberToHex(index as bigint, { size: 32 }), from!, token as Address, numberToHex(amount as bigint, { size: 32 })]));
          for (const p of proof as Hex[]) h = keccak256(h <= p ? concat([h, p]) : concat([p, h]));
          if (h !== root) revert("ZkSyncLiteSunsetClaimDistributor__InvalidProof()");
          if (unpaid.has(String(token).toLowerCase())) revert("SafeERC20: low-level call failed");
        },
      },
    );
    world.prices[`ethereum:${"0x6B175474E89094C44Da98b954EedeAC495271d0F".toLowerCase()}`] = 1;
  });

  test("finds every balance left in the account, each with a proof the contract accepts", async () => {
    const r = await checkZkSyncLite(HOLDER);
    assert.equal(r.completed, 0);
    assert.deepEqual(
      r.findings.map((f) => [f.asset.symbol, f.asset.amount]),
      [
        ["ETH", 376120400009300000n],
        ["DAI", 845858010000000000000n],
        ["USDC", 385620000n],
        ["USDT", 282570000n],
      ],
    );
    const eth = r.findings[0];
    assert.equal(eth.asset.token, undefined, "ETH is the native coin");
    assert.equal(r.findings[1].asset.token, "0x6B175474E89094C44Da98b954EedeAC495271d0F");
    assert.ok(r.findings.every((f) => f.status === "ready" && f.guideId === "zksync-lite" && f.claimAt === "lite.zksync.io"));
    assert.match(eth.note ?? "", /claim #8649353/);
  });

  test("an address that isn't listed costs one file and no RPC call", async () => {
    const calls = world.rpcLog.length;
    assert.deepEqual(await checkZkSyncLite(NOT_LISTED), { findings: [], completed: 0 });
    assert.equal(world.rpcLog.length, calls);
  });

  test("a claimed balance counts as claimed; one the contract can't pay is hidden", async () => {
    claimed.add(8649353n);
    unpaid.add("0xdac17f958d2ee523a2206206994597c13d831ec7");
    try {
      const r = await checkZkSyncLite(HOLDER);
      assert.equal(r.completed, 1);
      assert.deepEqual(r.findings.map((f) => f.asset.symbol), ["DAI", "USDC"]);
    } finally {
      claimed.clear();
      unpaid.clear();
    }
  });

  test("a new root, a damaged file, a missing file or an RPC failure fails the check", async () => {
    root = `0x${"ab".repeat(32)}`;
    try {
      await assert.rejects(checkZkSyncLite(HOLDER), /new Merkle root/);
    } finally {
      root = ZKSYNC_LITE_ROOT;
    }
    world.static[FILE] = { ...shard, nodes: base64.encode(base64.decode(shard.nodes!).subarray(0, -32)) };
    await assert.rejects(checkZkSyncLite(HOLDER), /damaged/);
    // The last node is the highest one, in every proof of the file: replace it with zeros.
    const raw = base64.decode(shard.nodes!);
    raw.fill(0, raw.length - 32);
    world.static[FILE] = { ...shard, nodes: base64.encode(raw) };
    await assert.rejects(checkZkSyncLite(HOLDER), /doesn't lead to the claim contract's root/);
    delete world.static[FILE];
    await assert.rejects(checkZkSyncLite(HOLDER), /zkSync Lite list: HTTP 404/);
    world.static[FILE] = shard;
    await withChainsDown([1], () => assert.rejects(checkZkSyncLite(HOLDER)));
  });

  test("in the L2 group, with a color and a live guide in both languages", () => {
    const src = sourceById("zksync-lite")!;
    assert.equal(src.group, "l2");
    assert.deepEqual(src.accepts, ["evm"]);
    assert.ok(NETWORK_COLORS["zksync-lite"]);
    const en = GUIDES.find((g) => g.id === "zksync-lite")!;
    assert.ok(en.live);
    assert.ok(en.steps.some((s) => s.includes(ZKSYNC_LITE_CLAIM)));
    assert.ok(GUIDES_FR["zksync-lite"].steps!.some((s) => s.includes(ZKSYNC_LITE_CLAIM)));
  });
});
