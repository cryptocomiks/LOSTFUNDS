import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { parseAbi, parseEther, parseUnits, type Address } from "viem";
import { checkSource, sourcesFor } from "../src/lib/checker.ts";
import { checkLegacy, LEGACY_LIST } from "../src/lib/checks/legacy.ts";
import { sourceById } from "../src/lib/sources.ts";
import type { Finding } from "../src/lib/types.ts";
import { MockChain, revert } from "./mockchain.ts";

const world = new MockChain();
before(() => {
  globalThis.fetch = world.fetch as typeof fetch;
});

const DAO: Address = "0xBB9bc244D798123fDe783fCc1C72d3Bb8C189413";
const WITHDRAW_DAO: Address = "0xBf4eD7b27F1d666546E30D74d50d173d20bca754";
const EXTRA_BALANCE: Address = "0x5c40eF6f527f4FbA68368774E6130cE6515123f2";
const EXTRA_BALANCE_REFUND: Address = "0x755cdba6AE4F479f7164792B318b2a06c759833B";
const SAI: Address = "0x89d24A6b4CcB1B6fAA2625fE562bDD9a23260359";
const SAI_TAP: Address = "0xBda109309f9FafA6Dd6A9CB9f1Df4085B27Ee8eF";
const PETH: Address = "0xf53AD2c6851052A81B42133467480961B2321C09";
const SAI_TUB: Address = "0x448a5065aeBB8E423F0896E6c5D525C040f59af3";
const WETH: Address = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
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
const ELSEWHERE: Address = "0x000000000000000000000000000000000000bEEF";

/** Holds a bit of everything (the amounts of real holders found on mainnet on Oct 1, 2026). */
const HOLDER: Address = "0x1111111111111111111111111111111111111111";
const CLEAN: Address = "0x2222222222222222222222222222222222222222";
/** A smart-contract wallet that can't receive ETH through WithdrawDAO's send(). */
const SAFE: Address = "0x3333333333333333333333333333333333333333";
const BIG_EXTRA: Address = "0x4444444444444444444444444444444444444444";
const DUST: Address = "0x5555555555555555555555555555555555555555";
const CLOSED: Address = "0x6666666666666666666666666666666666666666";
const BROKEN: Address = "0x7777777777777777777777777777777777777777";
const NO_SIM: Address = "0x8888888888888888888888888888888888888888";

// Real values read on mainnet at block 26,098,375, with what a simulated claim paid there.
const SAI_FIX = 5285551943761727318375221n; // SaiTap.fix (ray): ETH per SAI
const TUB_PER = 1051432093602071663044652213n; // SaiTub.per (ray): WETH per PETH
const ACID_RATE = 193054178n; // Acid.weiPerNanoDGD
const SAI_BALANCE = 236554082920240000000000n;
const SAI_PAID = 1250318892783847353260n;
const PETH_BALANCE = 316749300468216884082n;
const PETH_PAID = 333040380138288936509n;
const DGD_BALANCE = 9992152664310n; // 9 decimals
const DGD_PAID = 1929026819058876987180n;

const flags = { redeemerStopped: false, kncOld: KNCL, gntAgent: GNT_AGENT, acidBroken: false };
const approvals = new Set<string>();
const approved = (token: Address, owner: Address | undefined, spender: Address) => approvals.has(`${token}:${owner}:${spender}`.toLowerCase());

type Fn = Parameters<MockChain["addContract"]>[3][string];

/** A token: balances by holder, approve() remembered for the claims' dry runs, plus its own functions if any. */
function token(address: Address, balances: Partial<Record<Address, bigint>>, more: { sigs: string[]; fns: Record<string, Fn> } = { sigs: [], fns: {} }) {
  const abi = parseAbi(["function balanceOf(address) view returns (uint256)", "function approve(address, uint256) returns (bool)", ...more.sigs] as never) as never;
  world.addContract(1, address, abi, {
    balanceOf: ([a]) => balances[a as Address] ?? 0n,
    approve: ([spender], { from }) => {
      approvals.add(`${address}:${from}:${spender}`.toLowerCase());
      return true;
    },
    ...more.fns,
  });
}
/** A claim function that pulls `pulled` from the caller: it needs an approval first. */
const pulls = (pulled: Address, spender: Address) => (_: readonly unknown[], { from }: { from?: Address }) => {
  if (!approved(pulled, from, spender)) revert("not approved");
};

before(() => {
  token(DAO, { [HOLDER]: 112_229n * 10n ** 16n, [SAFE]: 100n * 10n ** 16n, [NO_SIM]: 300n * 10n ** 16n });
  token(EXTRA_BALANCE, { [HOLDER]: 114973846153846153847n, [BIG_EXTRA]: parseEther("2000") });
  token(SAI, { [HOLDER]: SAI_BALANCE });
  token(PETH, { [HOLDER]: PETH_BALANCE });
  token(MKR_2016, { [HOLDER]: parseEther("1563.619176"), [CLOSED]: parseEther("10") });
  token(DGD, { [HOLDER]: DGD_BALANCE, [BROKEN]: parseUnits("50", 9) });
  token(GNT, { [HOLDER]: parseEther("25358009.11637327"), [CLOSED]: parseEther("1000000") }, {
    sigs: ["function migrationAgent() view returns (address)", "function migrate(uint256)"],
    fns: { migrationAgent: () => flags.gntAgent, migrate: () => undefined }, // migrate burns the caller's own GNT: no approval
  });
  token(KNCL, { [HOLDER]: parseEther("500000"), [DUST]: parseEther("10"), [CLOSED]: parseEther("1000") });
  const unwraps = { sigs: ["function withdraw(uint256)"], fns: { withdraw: () => undefined } };
  token(W_ETH_2016, { [HOLDER]: parseEther("328.017") }, unwraps);
  token(WETH_0X_2017, { [HOLDER]: parseEther("19.7511") }, unwraps);
  token(ETH_BANCOR_2017, { [HOLDER]: parseEther("9.97670383984015") }, unwraps);
  token(WETH, { [SAI_TAP]: parseEther("14024.19"), [SAI_TUB]: parseEther("6552.59") });
  token(MKR, { [MKR_REDEEMER]: parseEther("8909.97757") });

  world.setEthBalance(1, WITHDRAW_DAO, parseEther("81399.81"));
  world.setEthBalance(1, EXTRA_BALANCE_REFUND, parseEther("852.6"));
  world.setEthBalance(1, DGD_ACID, parseEther("11685.05"));
  world.setEthBalance(1, W_ETH_2016, parseEther("1511.35"));
  world.setEthBalance(1, WETH_0X_2017, parseEther("169.06"));
  world.setEthBalance(1, ETH_BANCOR_2017, parseEther("94.42"));

  const abi = (sigs: string[]) => parseAbi(sigs as never) as never;
  world.addContract(1, WITHDRAW_DAO, abi(["function withdraw()"]), {
    withdraw: (_, { from }) => {
      if (from === SAFE) revert("send failed");
      pulls(DAO, WITHDRAW_DAO)([], { from });
    },
  });
  world.addContract(1, EXTRA_BALANCE_REFUND, abi(["function withdraw()"]), { withdraw: pulls(EXTRA_BALANCE, EXTRA_BALANCE_REFUND) });
  world.addContract(1, SAI_TAP, abi(["function off() view returns (bool)", "function fix() view returns (uint256)", "function cash(uint256)"]), {
    off: () => true,
    fix: () => SAI_FIX,
    cash: pulls(SAI, SAI_TAP),
  });
  world.addContract(1, SAI_TUB, abi(["function out() view returns (bool)", "function per() view returns (uint256)", "function gap() view returns (uint256)", "function exit(uint256)"]), {
    out: () => true,
    per: () => TUB_PER,
    gap: () => 10n ** 18n,
    exit: pulls(PETH, SAI_TUB),
  });
  world.addContract(1, MKR_REDEEMER, abi(["function stopped() view returns (bool)", "function redeem()"]), {
    stopped: () => flags.redeemerStopped,
    redeem: pulls(MKR_2016, MKR_REDEEMER),
  });
  world.addContract(1, DGD_ACID, abi(["function isInitialized() view returns (bool)", "function weiPerNanoDGD() view returns (uint256)", "function burn() returns (bool)"]), {
    isInitialized: () => true,
    weiPerNanoDGD: () => (flags.acidBroken ? revert("node error") : ACID_RATE),
    burn: (args, ctx) => {
      pulls(DGD, DGD_ACID)(args, ctx);
      return true;
    },
  });
  world.addContract(1, GNT_AGENT, abi(["function target() view returns (address)"]), { target: () => GLM });
  world.addContract(1, KNC, abi(["function oldKNC() view returns (address)", "function mintWithOldKnc(uint256)"]), {
    oldKNC: () => flags.kncOld,
    mintWithOldKnc: pulls(KNCL, KNC),
  });

  world.prices["coingecko:ethereum"] = 2684.56;
  world.prices[`ethereum:${WETH.toLowerCase()}`] = 2684.56;
  world.prices[`ethereum:${MKR.toLowerCase()}`] = 1816.67;
  world.prices[`ethereum:${GLM.toLowerCase()}`] = 0.1247;
  world.prices[`ethereum:${KNC.toLowerCase()}`] = 0.1355;
});

const byKey = (findings: Finding[]) => Object.fromEntries(findings.map((f) => [f.id.split(":").pop()!, f]));
const legacySources = () => sourcesFor("evm").filter((s) => s.group === "legacy");

describe("Old tokens & token migrations", () => {
  test("finds every redemption, in what the official contract pays (checked against mainnet)", async () => {
    const r = await checkLegacy(HOLDER);
    assert.equal(r.error, undefined);
    const f = byKey(r.findings);
    assert.deepEqual(Object.keys(f).sort(), ["dao", "dgd", "eth-bancor-2017", "extrabalance", "gnt", "kncl", "mkr-2016", "peth", "sai", "w-eth-2016", "weth-0x-2017"]);

    // 100 DAO = 1 ETH: the balance (16 decimals) is paid in wei.
    assert.deepEqual([f.dao.asset.symbol, f.dao.asset.amount], ["ETH", parseEther("1122.29")]);
    assert.equal(f.extrabalance.asset.amount, 114973846153846153847n);
    // SAI, PETH and DGD: exactly what eth_simulateV1 paid these balances on mainnet.
    assert.deepEqual([f.sai.asset.symbol, f.sai.asset.token, f.sai.asset.amount], ["WETH", WETH, SAI_PAID]);
    assert.deepEqual([f.peth.asset.symbol, f.peth.asset.amount], ["WETH", PETH_PAID]);
    assert.deepEqual([f.dgd.asset.symbol, f.dgd.asset.amount], ["ETH", DGD_PAID]);
    // 1:1 migrations, in the new token.
    assert.deepEqual([f["mkr-2016"].asset.symbol, f["mkr-2016"].asset.token, f["mkr-2016"].asset.amount], ["MKR", MKR, parseEther("1563.619176")]);
    assert.deepEqual([f.gnt.asset.symbol, f.gnt.asset.token, f.gnt.asset.amount], ["GLM", GLM, parseEther("25358009.11637327")]);
    assert.deepEqual([f.kncl.asset.symbol, f.kncl.asset.token, f.kncl.asset.amount], ["KNC", KNC, parseEther("500000")]);
    assert.equal(f["w-eth-2016"].asset.amount, parseEther("328.017"));
    assert.equal(f["weth-0x-2017"].asset.amount, parseEther("19.7511"));
    assert.equal(f["eth-bancor-2017"].asset.amount, parseEther("9.97670383984015"));

    for (const x of r.findings) {
      assert.equal(x.status, "ready", x.networkName);
      assert.equal(x.timestamp, 0, "no misleading date");
      assert.equal(x.guideId, "legacy");
      assert.equal(x.minUsd, 5);
      assert.ok(x.claimAt && x.note, x.networkName);
      assert.match(x.networkId, /^legacy-/);
      assert.ok(sourceById(x.networkId), `${x.networkId} is a source (grid dot, claim fallback)`);
      assert.match(x.txUrl, /^https:\/\/etherscan\.io\/address\/0x/);
    }
    assert.match(f.sai.note!, /236,554 SAI → 1,250 WETH, which unwraps 1:1 to ETH/);
    assert.match(f.dao.note!, /112,229 DAO tokens from 2016 are still redeemable for 1,122 ETH \(100 DAO = 1 ETH\)/);
    assert.match(f.dgd.note!, /9,992 DGD → 1,929 ETH/);
    assert.match(f.peth.note!, /316\.749 PETH back into 333\.04 WETH/);
  });

  test("one multicall reads every entry for an address; a clean wallet is clean, with no dry runs", async () => {
    world.rpcLog = [];
    const results = await Promise.all(legacySources().map((s) => checkSource(s, CLEAN)));
    assert.equal(results.length, LEGACY_LIST.length);
    for (const r of results) assert.deepEqual([r.state, r.findings.length, r.error], ["done", 0, undefined]);
    const methods = world.rpcLog.filter((x) => x.chainId === 1).map((x) => x.method);
    assert.deepEqual(methods, ["eth_call"], "a single eth_call (Multicall3.aggregate3) for all 7 checks");
  });

  test("a holder's claim is dry-run from their own address (approve, then claim)", async () => {
    world.rpcLog = [];
    await checkLegacy(HOLDER, LEGACY_LIST.filter((e) => e.id === "sai"));
    // Served from the snapshot read above: only the two dry runs hit the node.
    assert.deepEqual(world.rpcLog.map((x) => x.method), ["eth_simulateV1", "eth_simulateV1"]);
    assert.ok(approved(SAI, HOLDER, SAI_TAP) && approved(PETH, HOLDER, SAI_TUB), "the dry runs approved the right contracts");
  });

  test("a claim the contract would reject from this wallet is shown as check manually", async () => {
    const r = await checkLegacy(SAFE);
    assert.equal(r.findings.length, 1);
    assert.equal(r.findings[0].status, "manual");
    assert.equal(r.findings[0].asset.amount, parseEther("1"));
    assert.match(r.findings[0].note!, /dry run of the claim from this address fails/);
  });

  test("nodes without eth_simulateV1 still show the claim: the contract's state was checked", async () => {
    world.simulateV1 = false;
    try {
      const r = await checkLegacy(NO_SIM);
      assert.deepEqual([r.findings.length, r.findings[0].status, r.findings[0].asset.amount, r.error], [1, "ready", parseEther("3"), undefined]);
    } finally {
      world.simulateV1 = true;
    }
  });

  test("a reserve too small to pay the whole balance: check manually", async () => {
    const r = await checkLegacy(BIG_EXTRA);
    assert.equal(r.findings.length, 1);
    assert.deepEqual([r.findings[0].status, r.findings[0].asset.amount], ["manual", parseEther("2000")]);
    assert.match(r.findings[0].note!, /holds less than this right now/);
  });

  test("migrations that closed (stopped, or a contract that changed) are not reported", async () => {
    Object.assign(flags, { redeemerStopped: true, kncOld: ELSEWHERE, gntAgent: ELSEWHERE });
    try {
      assert.deepEqual(await checkLegacy(CLOSED), { findings: [], completed: 0 });
    } finally {
      Object.assign(flags, { redeemerStopped: false, kncOld: KNCL, gntAgent: GNT_AGENT });
    }
  });

  test("dust is hidden once priced", async () => {
    const r = await checkSource(sourceById("legacy-kncl")!, DUST); // 10 KNCL ≈ $1.36
    assert.deepEqual([r.state, r.findings.length], ["done", 0]);
    const h = await checkSource(sourceById("legacy-kncl")!, HOLDER);
    assert.equal(h.findings.length, 1);
    assert.equal(Math.round(h.findings[0].asset.usd!), 67750);
  });

  test("a contract read that fails for a holder is an error, never clean", async () => {
    flags.acidBroken = true;
    try {
      const r = await checkSource(sourceById("legacy-dgd")!, BROKEN);
      assert.equal(r.state, "error");
      assert.match(r.error!, /DigixDAO DGD refund: couldn't read acidRate/);
      // Other entries don't need that contract.
      assert.equal((await checkSource(sourceById("legacy-kncl")!, BROKEN)).state, "done");
    } finally {
      flags.acidBroken = false;
    }
  });

  test("nodes that are down: error, never clean", async () => {
    globalThis.fetch = (async () => new Response("bad gateway", { status: 502 })) as typeof fetch;
    try {
      const r = await checkSource(sourceById("legacy-thedao")!, "0x9999999999999999999999999999999999999999");
      assert.equal(r.state, "error");
    } finally {
      globalThis.fetch = world.fetch as typeof fetch;
    }
  });

  test("each entry is its own line in the checker, for Ethereum addresses only", () => {
    assert.deepEqual(
      legacySources().map((s) => s.id),
      ["legacy-thedao", "legacy-sai", "legacy-mkr-2016", "legacy-dgd", "legacy-gnt", "legacy-kncl", "legacy-weth-old"],
    );
    assert.equal(sourcesFor("solana").filter((s) => s.group === "legacy").length, 0);
  });
});
