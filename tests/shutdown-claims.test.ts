import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { parseAbi, type Address } from "viem";
import { checkSource } from "../src/lib/checker.ts";
import { checkKinto, KINTO_LEFTOVER } from "../src/lib/checks/kinto.ts";
import { checkStargateUsdc, STARGATE_CHAINS, VE_DISTRIBUTOR } from "../src/lib/checks/stargate.ts";
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
