import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { decodeFunctionData, keccak256, pad, parseAbi, parseAbiItem, toHex, zeroAddress, type Address, type Hex } from "viem";
import { checkSource } from "../src/lib/checker.ts";
import { checkEnsDeeds } from "../src/lib/checks/ens-deeds.ts";
import { checkExchange, DEPOSIT_EXCHANGES } from "../src/lib/checks/exchanges.ts";
import { checkPolygonStaking, VALIDATOR_SHARES } from "../src/lib/checks/polygon-staking.ts";
import { checkScd, jamFor } from "../src/lib/checks/scd.ts";
import { L1 } from "../src/lib/networks.ts";
import { sourceById } from "../src/lib/sources.ts";
import { MockChain, revert } from "./mockchain.ts";

const USER: Address = "0x1111111111111111111111111111111111111111";
const EMPTY: Address = "0x2222222222222222222222222222222222222222";
const OTHER: Address = "0x3333333333333333333333333333333333333333";
const LINK: Address = "0x514910771AF9Ca656af840dff83E8264EcF986CA";
const BNB: Address = "0xB8c77482e45F1F44dE1745F52C74426C631bDD52";
const QNT: Address = "0x4a220E6096B25EADb88358cb44068A3248254675";
const POL: Address = "0x455e53CBB86018Ac2B8092FdCd39d8444aFFC3F6";
const e18 = 10n ** 18n;

const world = new MockChain();
before(() => {
  globalThis.fetch = world.fetch as typeof fetch;
  world.prices["coingecko:ethereum"] = 2500;
  world.prices[`ethereum:${LINK.toLowerCase()}`] = 15;
  world.prices[`ethereum:${BNB.toLowerCase()}`] = 600;
  world.prices[`ethereum:${QNT.toLowerCase()}`] = 250;
  world.prices[`ethereum:${POL.toLowerCase()}`] = 0.2;
});

/** Makes every Ethereum RPC node (and Blockscout) answer 503 while `fn` runs. */
async function withNodesDown(fn: () => Promise<unknown>) {
  const down = new Set([...L1.rpcs, ...L1.logsRpcs].map((u) => new URL(u).host).concat(new URL(L1.blockscout).host));
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (down.has(url.host)) return new Response("busy", { status: 503 });
    return world.fetch(input, init);
  }) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = world.fetch as typeof fetch;
  }
}

/* ───────────────────────── Old exchanges ───────────────────────── */

describe("Old exchanges (EtherDelta, IDEX v1, Token.Store, SingularX)", () => {
  const etherdelta = DEPOSIT_EXCHANGES.find((x) => x.id === "etherdelta")!;
  const idex = DEPOSIT_EXCHANGES.find((x) => x.id === "idex")!;
  const tokenstore = DEPOSIT_EXCHANGES.find((x) => x.id === "tokenstore")!;
  const [MAIN, OLD] = etherdelta.contracts.map((c) => c.address);
  const IDEX = idex.contracts[0].address;
  const balances: Record<string, bigint> = {};
  const key = (contract: Address, token: unknown, user: unknown) => `${contract}:${String(token)}:${String(user)}`.toLowerCase();
  const set = (contract: Address, token: Address, user: Address, amount: bigint) => (balances[key(contract, token, user)] = amount);
  /** Tokens whose transfer fails (paused), and IDEX accounts active in the last 240 blocks. */
  const paused = new Set([BNB.toLowerCase()]);
  const active = new Set([OTHER.toLowerCase()]);

  before(() => {
    const deltaAbi = parseAbi([
      "function balanceOf(address token, address user) view returns (uint256)",
      "function withdraw(uint256 amount)",
      "function withdrawToken(address token, uint256 amount)",
    ]);
    const idexAbi = parseAbi(["function balanceOf(address token, address user) view returns (uint256)", "function withdraw(address token, uint256 amount) returns (bool)"]);
    const take = (contract: Address, token: unknown, amount: unknown, from?: Address) => {
      if (!from || (balances[key(contract, token, from)] ?? 0n) < (amount as bigint)) revert("insufficient balance");
      if (paused.has(String(token).toLowerCase())) revert("token transfers are paused");
    };
    for (const ex of DEPOSIT_EXCHANGES)
      for (const { address } of ex.contracts)
        if (ex.kind === "idex")
          world.addContract(1, address, idexAbi, {
            balanceOf: ([t, u]) => balances[key(address, t, u)] ?? 0n,
            withdraw: ([t, a], { from }) => {
              if (active.has(String(from).toLowerCase())) revert("inactivity period not over");
              take(address, t, a, from);
              return true;
            },
          });
        else
          world.addContract(1, address, deltaAbi, {
            balanceOf: ([t, u]) => balances[key(address, t, u)] ?? 0n,
            withdraw: ([a], { from }) => take(address, zeroAddress, a, from),
            withdrawToken: ([t, a], { from }) => take(address, t, a, from),
          });
    set(MAIN, zeroAddress, USER, 2n * e18);
    set(MAIN, LINK, USER, 100n * e18);
    set(MAIN, BNB, USER, 50n * e18); // paused token: can't be withdrawn
    set(OLD, zeroAddress, USER, 3n * e18 / 2n);
    set(IDEX, zeroAddress, USER, 3n * e18);
    set(IDEX, QNT, USER, 10n * e18);
    set(IDEX, zeroAddress, OTHER, 5n * e18); // traded recently: withdrawal not allowed yet
    set(tokenstore.contracts[0].address, zeroAddress, USER, 10n ** 14n); // $0.25 of ETH: dust
  });

  test("finds ETH and tokens left on EtherDelta, across its contracts, each withdrawal simulated", async () => {
    const r = await checkExchange(etherdelta, USER);
    const by = Object.fromEntries(r.findings.map((f) => [`${f.txHash}:${f.asset.symbol}`, f]));
    assert.deepEqual(Object.keys(by).sort(), [`${MAIN}:ETH`, `${MAIN}:LINK`, `${OLD}:ETH`].sort(), "BNB is paused: hidden");
    assert.equal(by[`${MAIN}:ETH`].asset.amount, 2n * e18);
    assert.equal(by[`${OLD}:ETH`].asset.amount, 3n * e18 / 2n);
    const link = by[`${MAIN}:LINK`];
    assert.equal(link.asset.amount, 100n * e18);
    assert.equal(link.asset.token, LINK);
    assert.equal(link.status, "ready");
    assert.equal(link.timestamp, 0, "deposit date unknown: hidden in the UI");
    assert.match(link.note ?? "", new RegExp(`withdrawToken with token ${LINK} and amount ${100n * e18}`));
    assert.match(link.claimAt ?? "", /^forkdelta\.app\/shutdown\/withdraw, or Etherscan → Write Contract → withdrawToken, on 0x8d12A197cB00D4747a1fe03395095ce2A5CC6819$/);
    assert.equal(link.txUrl, `https://etherscan.io/address/${MAIN}#writeContract`);
    assert.doesNotMatch(by[`${OLD}:ETH`].claimAt ?? "", /forkdelta/, "ForkDelta's tool only serves the main contract");
    assert.equal(r.error, undefined);
  });

  test("IDEX v1: withdrawable once inactive, and nothing while the contract refuses it", async () => {
    const r = await checkExchange(idex, USER);
    assert.deepEqual(r.findings.map((f) => [f.asset.symbol, f.asset.amount]).sort(), [["ETH", 3n * e18], ["QNT", 10n * e18]]);
    const eth = r.findings.find((f) => f.asset.symbol === "ETH")!;
    assert.match(eth.note ?? "", /withdraw with token 0x0000000000000000000000000000000000000000 \(ETH\) and amount 3000000000000000000/);
    assert.deepEqual(await checkExchange(idex, OTHER), { findings: [], completed: 0 }, "simulation reverts: hidden");
  });

  test("an address that withdrew everything sees nothing", async () => {
    for (const ex of DEPOSIT_EXCHANGES) assert.deepEqual(await checkExchange(ex, EMPTY), { findings: [], completed: 0 });
  });

  test("dust is hidden", async () => {
    const r = await checkSource(sourceById("tokenstore")!, USER);
    assert.equal(r.state, "done");
    assert.deepEqual(r.findings, []);
  });

  test("an RPC failure fails the check instead of reporting it clean", async () => {
    await withNodesDown(async () => {
      await assert.rejects(checkExchange(etherdelta, USER));
      const r = await checkSource(sourceById("etherdelta")!, USER);
      assert.equal(r.state, "error");
    });
  });
});

/* ───────────────────────── ENS auction deposits ───────────────────────── */

describe("ENS auction deposits (old .eth registrar)", () => {
  const REGISTRAR: Address = "0x6090A6e47849629b7245Dfa1Ca21D94cd15878Ef";
  const MULTICALL3: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";
  const SAFE: Address = "0x5afe5afe5afe5afe5afe5afe5afe5afe5afe5afe";
  const HOARDER: Address = "0x4444444444444444444444444444444444444444";
  const BID_REVEALED = parseAbiItem("event BidRevealed(bytes32 indexed hash, address indexed owner, uint256 value, uint8 status)");
  const label = (name: string) => keccak256(toHex(name));
  const deedAddress = (i: number) => `0x${"de".repeat(18)}${i.toString(16).padStart(4, "0")}` as Address;
  interface Name {
    deed: Address;
    owner: Address;
    balance: bigint;
    registered: number;
    mode?: number;
  }
  const names: Record<Hex, Name> = {};
  const refused = new Set<Hex>();
  const REGISTERED = 1_500_000_000; // Jul 2017
  let deeds = 0;
  const add = (name: string, owner: Address, balance: bigint, mode = 2) => {
    const deed = deedAddress(++deeds);
    names[label(name)] = { deed, owner, balance, registered: REGISTERED, mode };
    world.addContract(1, deed, parseAbi(["function owner() view returns (address)"]), { owner: () => names[label(name)].owner });
    return label(name);
  };
  const won = (hash: Hex, owner: Address, status = 2) =>
    world.addTx({
      chainId: 1,
      hash: keccak256(toHex(`${hash}${owner}${status}`)),
      from: owner,
      to: REGISTRAR,
      blockNumber: 4_000_000n,
      timestamp: REGISTERED - 3 * 86400,
      logs: [{ address: REGISTRAR, event: BID_REVEALED, args: { hash, owner, value: e18, status } }],
    });
  const moved: Record<string, Record<string, Hex[]>> = {};
  const movedTo = (owner: Address, hash: Hex) => ((moved[owner.toLowerCase()[2]] ??= {})[owner.toLowerCase()] ??= []).push(hash);

  let ALPHA: Hex, BRAVO: Hex;
  before(() => {
    world.addContract(
      1,
      REGISTRAR,
      parseAbi(["function entries(bytes32) view returns (uint8, address, uint256, uint256, uint256)", "function releaseDeed(bytes32 hash)"]),
      {
        entries: ([h]) => {
          const n = names[h as Hex];
          return n ? [n.mode ?? 2, n.deed, BigInt(n.registered), e18, e18] : [0, zeroAddress, 0n, 0n, 0n];
        },
        releaseDeed: ([h], { from }) => {
          const n = names[h as Hex];
          if (!n || n.mode !== 2 || n.owner.toLowerCase() !== String(from).toLowerCase() || refused.has(h as Hex)) revert("");
        },
      },
    );
    const balanceOf = (a: unknown) => Object.values(names).find((n) => n.deed.toLowerCase() === String(a).toLowerCase())?.balance ?? 0n;
    world.addContract(1, MULTICALL3, parseAbi(["function getEthBalance(address) view returns (uint256)"]), { getEthBalance: ([a]) => balanceOf(a) });
    world.addContract(1, SAFE, parseAbi(["function nonce() view returns (uint256)"]), { nonce: () => 0n }); // a contract wallet

    ALPHA = add("alpha", USER, e18); // won and finalized
    won(ALPHA, USER);
    BRAVO = add("bravo", USER, e18 / 2n); // bought from someone else: only in the published list
    won(BRAVO, OTHER);
    movedTo(USER, BRAVO);
    won(add("charlie", OTHER, 2n * e18), USER); // won, then given away
    won(label("delta"), USER); // released since: the registrar has no deed for it anymore
    won(add("echo", OTHER, 3n * e18), USER, 3); // outbid (status 3)
    won(add("safe", SAFE, e18 / 10n), SAFE);
    for (let i = 0; i < 12; i++) movedTo(HOARDER, add(`name${i}`, HOARDER, (BigInt(i) + 1n) * 10n ** 16n));
    for (const k of "0123456789abcdef") world.static[`https://lostfunds.vercel.app/legacy/ens-deeds/${k}.json`] = moved[k] ?? {};
  });

  test("finds the deposits locked in deeds the address won or received", async () => {
    const r = await checkEnsDeeds(USER);
    const amounts = r.findings.map((f) => f.asset.amount).sort((a, b) => (a < b ? -1 : 1));
    assert.deepEqual(amounts, [e18 / 2n, e18], "not the deed given away, the released name or the lost auction");
    const alpha = r.findings.find((f) => f.asset.amount === e18)!;
    assert.equal(alpha.status, "ready");
    assert.equal(alpha.asset.symbol, "ETH");
    assert.equal(alpha.timestamp, REGISTERED);
    assert.equal(alpha.dateLabel, "Registered");
    assert.match(alpha.note ?? "", new RegExp(`releaseDeed on the old registrar with hash ${ALPHA}`));
    assert.equal(alpha.claimAt, `Etherscan → Write Contract → releaseDeed, on ${REGISTRAR}`);
    assert.equal(r.error, undefined);
  });

  test("a release the registrar refuses is hidden", async () => {
    refused.add(ALPHA);
    try {
      const r = await checkEnsDeeds(USER);
      assert.deepEqual(r.findings.map((f) => f.asset.amount), [e18 / 2n]);
    } finally {
      refused.delete(ALPHA);
    }
  });

  test("an address without deeds sees nothing", async () => {
    assert.deepEqual(await checkEnsDeeds(EMPTY), { findings: [], completed: 0 });
  });

  test("a contract wallet's deposit is flagged for a manual check", async () => {
    const r = await checkEnsDeeds(SAFE);
    assert.equal(r.findings.length, 1);
    assert.equal(r.findings[0].status, "manual");
    assert.match(r.findings[0].note ?? "", /smart-contract code/);
  });

  test("past nine names, the rest are summed up in one finding", async () => {
    const r = await checkEnsDeeds(HOARDER);
    assert.equal(r.findings.length, 10);
    const rest = r.findings.find((f) => f.networkName.includes("more names"))!;
    assert.match(rest.networkName, /\(3 more names\)/);
    assert.equal(rest.asset.amount, (1n + 2n + 3n) * 10n ** 16n, "the three smallest deeds");
    assert.equal(r.findings.reduce((s, f) => s + f.asset.amount, 0n), 78n * 10n ** 16n);
  });

  test("a failed event search or a missing list fails the check instead of reporting it clean", async () => {
    await withNodesDown(() => assert.rejects(checkEnsDeeds(USER)));
    const url = `https://lostfunds.vercel.app/legacy/ens-deeds/1.json`;
    const saved = world.static[url];
    delete world.static[url];
    try {
      await assert.rejects(checkEnsDeeds(USER), /ENS deeds list: HTTP 404/);
    } finally {
      world.static[url] = saved;
    }
  });
});

/* ───────────────────────── Polygon staking ───────────────────────── */

describe("Polygon staking (Ethereum)", () => {
  const STAKE_MANAGER: Address = "0x5e3Ef299fDDf15eAa0432E6e66473ace8c13D908";
  const NEW_SHARE: Address = "0x7777777777777777777777777777777777777777";
  const EPOCH = 1000n;
  const share = (id: number) => (id > VALIDATOR_SHARES.length ? NEW_SHARE : VALIDATOR_SHARES[id - 1]);
  interface Delegation {
    shares?: bigint;
    rewards?: bigint;
    stake?: bigint;
    unbonds?: [bigint, bigint][];
    legacy?: [bigint, bigint];
  }
  /** validator id → user → delegation */
  const state: Record<number, Record<string, Delegation>> = {};
  const rates: Record<number, bigint> = {};
  const deactivated = new Set<number>();
  const failingClaims = new Set<number>();
  /** A validator added after the published list (found by probing the next ids). */
  let newValidator = true;
  const of = (id: number, user: unknown) => state[id]?.[String(user).toLowerCase()] ?? {};
  const delegate = (id: number, user: Address, d: Delegation) => ((state[id] ??= {})[user.toLowerCase()] = d);

  before(() => {
    const smAbi = parseAbi([
      "function epoch() view returns (uint256)",
      "function withdrawalDelay() view returns (uint256)",
      "function getValidatorContract(uint256) view returns (address)",
      "function validators(uint256) view returns (uint256 amount, uint256 reward, uint256 activationEpoch, uint256 deactivationEpoch, uint256 jailTime, address signer, address contractAddress, uint8 status, uint256 commissionRate, uint256 lastCommissionUpdate, uint256 delegatorsReward, uint256 delegatedAmount, uint256 initialRewardPerStake)",
    ]);
    world.addContract(1, STAKE_MANAGER, smAbi, {
      epoch: () => EPOCH,
      withdrawalDelay: () => 80n,
      getValidatorContract: ([id]) =>
        Number(id) <= VALIDATOR_SHARES.length ? share(Number(id)) : Number(id) === VALIDATOR_SHARES.length + 1 && newValidator ? NEW_SHARE : zeroAddress,
      validators: ([id]) => [0n, 0n, 1n, deactivated.has(Number(id)) ? 500n : 0n, 0n, zeroAddress, share(Number(id)), deactivated.has(Number(id)) ? 3 : 1, 0n, 0n, 0n, 0n, 0n],
    });
    const shareAbi = parseAbi([
      "function balanceOf(address) view returns (uint256)",
      "function unbondNonces(address) view returns (uint256)",
      "function unbonds(address) view returns (uint256 shares, uint256 withdrawEpoch)",
      "function unbonds_new(address, uint256) view returns (uint256 shares, uint256 withdrawEpoch)",
      "function getLiquidRewards(address) view returns (uint256)",
      "function getTotalStake(address) view returns (uint256, uint256)",
      "function withdrawExchangeRate() view returns (uint256)",
      "function minAmount() view returns (uint256)",
      "function withdrawRewardsPOL()",
      "function unstakeClaimTokensPOL()",
      "function unstakeClaimTokens_newPOL(uint256 unbondNonce)",
      "function sellVoucher_newPOL(uint256 claimAmount, uint256 maximumSharesToBurn)",
    ]);
    for (let id = 1; id <= VALIDATOR_SHARES.length + 1; id++)
      world.addContract(1, share(id), shareAbi, {
        balanceOf: ([u]) => of(id, u).shares ?? 0n,
        unbondNonces: ([u]) => BigInt(of(id, u).unbonds?.length ?? 0),
        unbonds: ([u]) => of(id, u).legacy ?? [0n, 0n],
        unbonds_new: ([u, n]) => of(id, u).unbonds?.[Number(n) - 1] ?? [0n, 0n],
        getLiquidRewards: ([u]) => of(id, u).rewards ?? 0n,
        getTotalStake: ([u]) => [of(id, u).stake ?? 0n, 0n],
        withdrawExchangeRate: () => rates[id] ?? (id < 8 ? 100n : 10n ** 29n),
        minAmount: () => e18,
        withdrawRewardsPOL: (_, { from }) => {
          if ((of(id, from).rewards ?? 0n) < e18) revert("Too small rewards amount");
        },
        unstakeClaimTokensPOL: (_, { from }) => {
          const [s, w] = of(id, from).legacy ?? [0n, 0n];
          if (!(s > 0n && w + 80n <= EPOCH)) revert("Incomplete withdrawal period");
        },
        unstakeClaimTokens_newPOL: ([n], { from }) => {
          const [s, w] = of(id, from).unbonds?.[Number(n) - 1] ?? [0n, 0n];
          if (failingClaims.has(id)) revert("Insufficent rewards");
          if (!(s > 0n && w + 80n <= EPOCH)) revert("Incomplete withdrawal period");
        },
        sellVoucher_newPOL: ([amount], { from }) => {
          if ((of(id, from).stake ?? 0n) < (amount as bigint)) revert("Too much requested");
        },
      });

    delegate(10, USER, { shares: 100n * e18, rewards: 50n * e18, stake: 100n * e18 }); // rewards to withdraw
    delegate(20, USER, { unbonds: [[300n * e18, 900n], [40n * e18, 990n]] }); // one unstake matured, one still waiting
    delegate(30, USER, { shares: 10n * e18, rewards: e18 / 2n, stake: 200n * e18 }); // validator left; rewards too small
    deactivated.add(30);
    delegate(5, USER, { legacy: [70n * e18, 100n] }); // foundation validator, old single unstake slot
    delegate(VALIDATOR_SHARES.length + 1, USER, { unbonds: [[5n * e18, 100n]] }); // validator added after the list
    rates[VALIDATOR_SHARES.length + 1] = 2n * 10n ** 29n;
    delegate(40, USER, { unbonds: [[9n * e18, 100n]] }); // matured, but the claim reverts
    failingClaims.add(40);
    delegate(50, OTHER, { shares: 5n * e18, rewards: e18 / 10n, stake: 5n * e18 }); // active, nothing to claim
  });

  test("finds rewards, matured unstakes and stake left with a validator that stopped, each claim simulated", async () => {
    const r = await checkPolygonStaking(USER);
    const by = Object.fromEntries(r.findings.map((f) => [`${f.txHash}:${f.id.split(":").slice(2).join(":")}`, f.asset.amount]));
    assert.deepEqual(by, {
      [`${share(10)}:rewards`]: 50n * e18,
      [`${share(20)}:unbond:1`]: 300n * e18,
      [`${share(30)}:stake`]: 200n * e18,
      [`${share(5)}:unbond`]: 70n * e18,
      [`${share(VALIDATOR_SHARES.length + 1)}:unbond:1`]: 10n * e18,
    });
    const f = r.findings.find((x) => x.txHash === share(20))!;
    assert.equal(f.asset.symbol, "POL");
    assert.equal(f.asset.token, POL);
    assert.equal(f.claimAt, "staking.polygon.technology");
    assert.match(f.note ?? "", /unstakeClaimTokens_newPOL\(1\)/);
    assert.match(r.findings.find((x) => x.txHash === share(30))!.note ?? "", /stopped validating/);
    assert.equal(r.error, undefined);
  });

  test("a wallet that never staked costs a single eth_call (two once a validator joined after the list)", async () => {
    let before = world.requests.length;
    assert.deepEqual(await checkPolygonStaking(EMPTY), { findings: [], completed: 0 });
    assert.equal(world.requests.length - before, 2);
    newValidator = false;
    try {
      before = world.requests.length;
      assert.deepEqual(await checkPolygonStaking(EMPTY), { findings: [], completed: 0 });
      assert.equal(world.requests.length - before, 1);
    } finally {
      newValidator = true;
    }
  });

  test("an active delegation with small rewards shows nothing", async () => {
    assert.deepEqual(await checkPolygonStaking(OTHER), { findings: [], completed: 0 });
  });

  test("an RPC failure fails the check instead of reporting it clean", async () => {
    await withNodesDown(() => assert.rejects(checkPolygonStaking(USER)));
  });
});

/* ───────────────────────── Maker SCD vaults ───────────────────────── */

describe("Maker Single-Collateral Dai vaults", () => {
  const TUB: Address = "0x448a5065aeBB8E423F0896E6c5D525C040f59af3";
  const VOX: Address = "0x9B0F70Df76165442ca6092939132bBAEA77f2d7A";
  const SAI_PROXY: Address = "0x526af336D614adE5cc252A407062B8861aF998F5";
  const PROXY: Address = "0x6666666666666666666666666666666666666666";
  const RAY = 10n ** 27n;
  const PER = (105n * RAY) / 100n; // 1 PETH = 1.05 WETH
  const TAG = 199n * RAY; // shutdown price, USD per PETH
  const rmul = (x: bigint, y: bigint) => (x * y + RAY / 2n) / RAY;
  const rdiv = (x: bigint, y: bigint) => (x * RAY + y / 2n) / y;
  const id = (n: number) => pad(toHex(n), { size: 32 });
  const cups: Record<string, { lad: Address; ink: bigint; art: bigint }> = {
    [id(1)]: { lad: USER, ink: 10n * e18, art: 0n }, // the wallet's own CDP, no debt
    [id(2)]: { lad: PROXY, ink: 3n * e18, art: 0n }, // opened through the user's DSProxy
    [id(3)]: { lad: USER, ink: 5n * e18, art: 199n * e18 }, // still owes 199 SAI = 1 PETH at the shutdown price
    [id(4)]: { lad: OTHER, ink: 7n * e18, art: 0n }, // given to someone else since the snapshot
    [id(5)]: { lad: USER, ink: 2n * e18, art: 0n }, // the Tub refuses to free it
  };
  const refused = new Set<string>([id(5)]);

  before(() => {
    const tubAbi = parseAbi([
      "function cups(bytes32) view returns (address lad, uint256 ink, uint256 art, uint256 ire)",
      "function off() view returns (bool)",
      "function out() view returns (bool)",
      "function per() view returns (uint256)",
      "function tag() view returns (uint256)",
      "function axe() view returns (uint256)",
      "function chi() returns (uint256)",
      "function vox() view returns (address)",
      "function bite(bytes32 cup)",
      "function free(bytes32 cup, uint256 wad)",
    ]);
    const cupOf = (c: unknown) => cups[String(c)] ?? { lad: zeroAddress, ink: 0n, art: 0n };
    world.addContract(1, TUB, tubAbi, {
      cups: ([c]) => [cupOf(c).lad, cupOf(c).ink, cupOf(c).art, 0n],
      off: () => true,
      out: () => true,
      per: () => PER,
      tag: () => TAG,
      axe: () => RAY,
      chi: () => RAY,
      vox: () => VOX,
      bite: () => undefined, // anyone, once SCD is shut down
      free: ([c, wad], { from }) => {
        const cup = cupOf(c);
        if (cup.lad.toLowerCase() !== String(from).toLowerCase() || refused.has(String(c))) revert("not allowed");
        if (cup.art > 0n) revert("unsafe");
        const left = cup.ink - (wad as bigint);
        if (left < 0n || (left > 0n && left <= 5n * 10n ** 15n)) revert("dust");
      },
    });
    world.addContract(1, VOX, parseAbi(["function par() returns (uint256)"]), { par: () => RAY });
    // The user's DSProxy: execute(SaiProxy, free(tub, cup, jam)) frees `ink` computed the way SaiProxy does.
    const saiAbi = parseAbi(["function free(address tub_, bytes32 cup, uint256 jam)"]);
    world.addContract(1, PROXY, parseAbi(["function owner() view returns (address)", "function execute(address _target, bytes _data) payable returns (bytes32)"]), {
      owner: () => USER,
      execute: ([target, data], { from }) => {
        if (String(from).toLowerCase() !== USER.toLowerCase() || String(target).toLowerCase() !== SAI_PROXY.toLowerCase()) revert("ds-auth-unauthorized");
        const { args } = decodeFunctionData({ abi: saiAbi, data: data as Hex });
        const [, cup, jam] = args as readonly [Address, Hex, bigint];
        let ink = rdiv(jam, PER);
        ink = rmul(ink, PER) <= jam ? ink : ink - 1n;
        const left = cupOf(cup).ink - ink;
        if (left < 0n || (left > 0n && left <= 5n * 10n ** 15n)) revert("dust");
        return `0x${"0".repeat(64)}`;
      },
    });
    for (const k of "0123456789abcdef") world.static[`https://lostfunds.vercel.app/legacy/scd-cups/${k}.json`] = {};
    world.static["https://lostfunds.vercel.app/legacy/scd-cups/1.json"] = { [USER.toLowerCase()]: [1, 2, 3, 4, 5] };
  });

  test("jamFor: SaiProxy's rounding frees exactly the CDP's collateral", () => {
    for (const ink of [1n, 999n, 5n * 10n ** 15n + 1n, 3n * e18, 450437394003594558300n, 123456789012345678901n])
      for (const per of [RAY, PER, 1051432093602071663044652213n]) {
        const jam = jamFor(ink, per)!;
        let back = rdiv(jam, per);
        back = rmul(back, per) <= jam ? back : back - 1n;
        assert.equal(back, ink, `ink ${ink} per ${per}`);
      }
  });

  test("finds collateral left in the user's CDPs, own or through a DSProxy, after any debt", async () => {
    const r = await checkScd(USER);
    const by = Object.fromEntries(r.findings.map((f) => [f.networkName, f]));
    assert.deepEqual(Object.keys(by).sort(), ["Maker SCD vault #1", "Maker SCD vault #2", "Maker SCD vault #3"], "not the CDP given away, nor the one the Tub refuses");
    assert.equal(by["Maker SCD vault #1"].asset.amount, rmul(10n * e18, PER));
    assert.equal(by["Maker SCD vault #1"].asset.symbol, "ETH");
    assert.match(by["Maker SCD vault #1"].note ?? "", new RegExp(`free\\(${id(1)}, ${10n * e18}\\)`));
    assert.equal(by["Maker SCD vault #2"].asset.amount, rmul(3n * e18, PER));
    assert.match(by["Maker SCD vault #2"].note ?? "", new RegExp(`on your DSProxy \\(${PROXY}\\), Write Contract → execute\\(address, bytes\\) with target ${SAI_PROXY}`));
    assert.equal(by["Maker SCD vault #2"].claimAt, `Etherscan → your DSProxy ${PROXY} → Write Contract → execute`);
    assert.equal(by["Maker SCD vault #3"].asset.amount, rmul(4n * e18, PER), "1 PETH goes to settle the debt");
    assert.match(by["Maker SCD vault #3"].note ?? "", /first settle its debt with bite/);
    assert.equal(r.error, undefined);
  });

  test("an address with no CDP sees nothing, without a single RPC call", async () => {
    const before = world.requests.length;
    assert.deepEqual(await checkScd(EMPTY), { findings: [], completed: 0 });
    assert.deepEqual(world.requests.slice(before), ["https://lostfunds.vercel.app/legacy/scd-cups/2.json"]);
  });

  test("an RPC failure or a missing list fails the check instead of reporting it clean", async () => {
    await withNodesDown(() => assert.rejects(checkScd(USER)));
    const url = "https://lostfunds.vercel.app/legacy/scd-cups/1.json";
    const saved = world.static[url];
    delete world.static[url];
    try {
      await assert.rejects(checkScd(USER), /SCD vaults list: HTTP 404/);
    } finally {
      world.static[url] = saved;
    }
  });
});
