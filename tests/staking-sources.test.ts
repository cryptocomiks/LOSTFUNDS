import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { getAddress, keccak256, parseAbi, parseAbiItem, toHex, zeroAddress, type Address } from "viem";
import { NETWORK_COLORS } from "../src/lib/brand.ts";
import { checkEthena } from "../src/lib/checks/ethena.ts";
import { checkNftMarkets } from "../src/lib/checks/nft-markets.ts";
import { checkUniFarms, UNI_FARM_LIST } from "../src/lib/checks/old-farms.ts";
import { checkFrax, checkKelp, checkMeth, checkStader, checkSwell } from "../src/lib/checks/staking-withdrawals.ts";
import { MAX_WALLETS, splitInputs } from "../src/lib/inputs.ts";
import { SOURCE_FR } from "../src/lib/sourceFr.ts";
import { sourceById } from "../src/lib/sources.ts";
import { MockChain, revert } from "./mockchain.ts";

const USER: Address = "0x1111111111111111111111111111111111111111";
const OTHER: Address = "0x2222222222222222222222222222222222222222";
const NOBODY: Address = "0x7777777777777777777777777777777777777777";
const e18 = 10n ** 18n;
const NOW = Math.floor(Date.now() / 1000);

const world = new MockChain();
before(() => {
  globalThis.fetch = world.fetch as typeof fetch;
  world.prices["coingecko:ethereum"] = 2000;
});
const shown = (r: { findings: { status: string; asset: { symbol: string; amount: bigint } }[] }) => r.findings.map((f) => [f.status, f.asset.symbol, f.asset.amount]).sort();

/* ───────────────────────── Stader ───────────────────────── */

describe("Stader withdrawals", () => {
  const MANAGER = getAddress("0x9F0491B32DBce587c50c4C43AB303b06478193A7");
  // id → [owner, ETHx, ETH expected, ETH finalized]
  const requests: Record<string, [Address, bigint, bigint, bigint]> = {
    "5": [USER, 3n * e18, 3n * e18 + 5n, 3n * e18], // finalized, never claimed
    "9": [USER, e18, e18 + 7n, 0n], // still in the queue
    "6": [OTHER, e18, e18, e18],
  };
  before(() =>
    world.addContract(
      1,
      MANAGER,
      parseAbi([
        "function getRequestIdsByUser(address) view returns (uint256[])",
        "function userWithdrawRequests(uint256) view returns (address owner, uint256 ethXAmount, uint256 ethExpected, uint256 ethFinalized, uint256 requestBlock)",
        "function nextRequestIdToFinalize() view returns (uint256)",
        "function claim(uint256 requestId)",
      ]),
      {
        getRequestIdsByUser: ([a]) => Object.keys(requests).filter((id) => requests[id][0] === a).map(BigInt),
        userWithdrawRequests: ([id]) => [...requests[String(id)], 100n],
        nextRequestIdToFinalize: () => 8n,
        claim: ([id], { from }) => {
          if (requests[String(id)]?.[0] !== from) revert("CallerNotAuthorizedToRedeem");
          if ((id as bigint) >= 8n) revert("requestIdNotFinalized");
        },
      },
    ),
  );

  test("a finalized request is ready with what claim pays, a queued one is waiting", async () => {
    const r = await checkStader(USER);
    assert.deepEqual(shown(r), [
      ["ready", "ETH", 3n * e18],
      ["waiting", "ETH", e18 + 7n],
    ]);
    const ready = r.findings.find((f) => f.status === "ready")!;
    assert.equal(ready.networkName, "Stader: withdrawal never claimed");
    assert.equal(ready.fr?.label, "Stader : retrait jamais réclamé");
    assert.match(ready.note ?? "", /not sent automatically/);
    assert.match(ready.fr?.note ?? "", /c'est à vous de les réclamer/);
    assert.match(ready.claimAt ?? "", /UserWithdrawalManager → claim/);
  });

  test("no request: nothing", async () => {
    assert.deepEqual(await checkStader(NOBODY), { findings: [], completed: 0 });
  });
});

/* ───────────────────────── Swell ───────────────────────── */

describe("Swell withdrawals", () => {
  const SWEXIT = getAddress("0x48C11b86807627AF70a34662D4865cF854251663");
  // id → [owner, swETH, rate when created, processed?, processed rate]
  const nfts: Record<string, [Address, bigint, bigint, boolean, bigint]> = {
    "40": [USER, 10n * e18, (11n * e18) / 10n, true, (105n * e18) / 100n], // processed at a lower rate
    "41": [USER, 2n * e18, (11n * e18) / 10n, true, (12n * e18) / 10n], // processed at a higher rate: the request's rate applies
    "42": [USER, 4n * e18, (11n * e18) / 10n, false, 0n], // not processed yet
  };
  before(() =>
    world.addContract(
      1,
      SWEXIT,
      parseAbi([
        "function balanceOf(address) view returns (uint256)",
        "function tokenOfOwnerByIndex(address, uint256) view returns (uint256)",
        "function withdrawalRequests(uint256) view returns (uint256 amount, uint256 lastTokenIdProcessed, uint256 rateWhenCreated)",
        "function getProcessedRateForTokenId(uint256) view returns (bool isProcessed, uint256 processedRate)",
        "function finalizeWithdrawal(uint256 tokenId)",
      ]),
      {
        balanceOf: ([a]) => BigInt(Object.values(nfts).filter((n) => n[0] === a).length),
        tokenOfOwnerByIndex: ([a, i]) => BigInt(Object.keys(nfts).filter((id) => nfts[id][0] === a)[Number(i)]),
        withdrawalRequests: ([id]) => [nfts[String(id)][1], 0n, nfts[String(id)][2]],
        getProcessedRateForTokenId: ([id]) => [nfts[String(id)][3], nfts[String(id)][4]],
        finalizeWithdrawal: ([id], { from }) => {
          if (nfts[String(id)][0] !== from) revert("WithdrawalRequestFinalizationOnlyAllowedForNFTOwner");
          if (!nfts[String(id)][3]) revert("WithdrawalNotProcessed");
        },
      },
    ),
  );

  test("the ETH paid is the swETH at the lower of the two rates", async () => {
    const r = await checkSwell(USER);
    assert.deepEqual(shown(r), [
      ["ready", "ETH", (105n * e18) / 10n],
      ["ready", "ETH", (22n * e18) / 10n],
      ["waiting", "ETH", (44n * e18) / 10n],
    ]);
    assert.equal(r.findings.find((f) => f.status === "waiting")!.fr?.label, "Swell : retrait dans la file d'attente");
  });

  test("no exit NFT: nothing, in one read", async () => {
    assert.deepEqual(await checkSwell(NOBODY), { findings: [], completed: 0 });
  });
});

/* ───────────────────────── Frax ───────────────────────── */

describe("Frax redemptions", () => {
  const QUEUE = getAddress("0x82bA8da44Cd5261762e629dd5c605b17715727bd");
  const LATER = NOW + 5 * 86400;
  // id → [owner, redeemed?, maturity, amount]
  const tickets: [Address, boolean, number, bigint][] = [
    [USER, true, NOW - 900_000, 9n * e18], // redeemed long ago (the NFT is burned)
    [USER, false, NOW - 86400, 5n * e18], // matured, never redeemed
    [OTHER, false, NOW - 86400, 7n * e18],
    [USER, false, LATER, 2n * e18], // still maturing
  ];
  before(() =>
    world.addContract(
      1,
      QUEUE,
      parseAbi([
        "function redemptionQueueState() view returns (uint64 nextNftId, uint64 queueLengthSecs, uint64 redemptionFee, uint64 earlyExitFee)",
        "function nftInformation(uint256) view returns (bool hasBeenRedeemed, uint64 maturity, uint120 amount, uint64 earlyExitFee)",
        "function ownerOf(uint256) view returns (address)",
        "function burnRedemptionTicketNft(uint256 nftId, address recipient)",
      ]),
      {
        redemptionQueueState: () => [BigInt(tickets.length), 0n, 0n, 0n],
        nftInformation: ([id]) => [tickets[Number(id)][1], BigInt(tickets[Number(id)][2]), tickets[Number(id)][3], 0n],
        ownerOf: ([id]) => (tickets[Number(id)][1] ? revert("ERC721: invalid token ID") : tickets[Number(id)][0]),
        burnRedemptionTicketNft: ([id], { from }) => {
          const t = tickets[Number(id)];
          if (t[0] !== from) revert("Erc721CallerNotOwnerOrApproved");
          if (t[2] > NOW) revert("NotMatureYet");
        },
      },
    ),
  );

  test("the address's tickets: a matured one is ready, a maturing one waits with its date, redeemed ones are ignored", async () => {
    const r = await checkFrax(USER);
    assert.deepEqual(shown(r), [
      ["ready", "ETH", 5n * e18],
      ["waiting", "ETH", 2n * e18],
    ]);
    assert.equal(r.findings.find((f) => f.status === "waiting")!.readyAt, LATER);
    assert.equal(r.findings.find((f) => f.status === "ready")!.readyAt, undefined);
  });

  test("someone with no ticket: nothing", async () => {
    assert.deepEqual(await checkFrax(NOBODY), { findings: [], completed: 0 });
  });
});

/* ───────────────────────── Mantle mETH ───────────────────────── */

describe("Mantle mETH withdrawals", () => {
  const STAKING = getAddress("0xe3cBd06D7dadB3F4e6557bAb7EdD924CD1489E8f");
  const MANAGER = getAddress("0x38fDF7b489316e03eD8754ad339cb5c4483FDcf9");
  const CREATED = parseAbiItem(
    "event UnstakeRequestCreated(uint256 indexed id, address indexed requester, uint256 mETHLocked, uint256 ethRequested, uint256 cumulativeETHRequested, uint256 blockNumber)",
  );
  // id → [requester, ETH requested, finalized?, claimed?]
  const requests: Record<string, [Address, bigint, boolean, boolean]> = {
    "3": [USER, 4n * e18, true, true], // claimed: the request is deleted
    "4": [USER, 6n * e18, true, false], // finalized, never claimed
    "5": [USER, e18, false, false], // not finalized yet
    "6": [OTHER, 8n * e18, true, false],
  };
  before(() => {
    for (const [id, [requester, eth]] of Object.entries(requests))
      world.addTx({
        chainId: 1,
        hash: keccak256(toHex(`meth${id}`)),
        from: requester,
        to: STAKING,
        blockNumber: 19_000_000n + BigInt(id),
        timestamp: 1_720_000_000,
        logs: [{ address: MANAGER, event: CREATED, args: { id: BigInt(id), requester, mETHLocked: eth, ethRequested: eth, cumulativeETHRequested: eth, blockNumber: 19_000_000n } }],
      });
    world.addContract(
      1,
      MANAGER,
      parseAbi([
        "function requestByID(uint256) view returns ((uint64 blockNumber, address requester, uint128 id, uint128 mETHLocked, uint128 ethRequested, uint128 cumulativeETHRequested))",
        "function requestInfo(uint256) view returns (bool isFinalized, uint256 claimableAmount)",
      ]),
      {
        requestByID: ([id]) => {
          const q = requests[String(id)];
          return q[3]
            ? { blockNumber: 0n, requester: zeroAddress, id: 0n, mETHLocked: 0n, ethRequested: 0n, cumulativeETHRequested: 0n }
            : { blockNumber: 19_000_000n, requester: q[0], id, mETHLocked: q[1], ethRequested: q[1], cumulativeETHRequested: q[1] };
        },
        requestInfo: ([id]) => [requests[String(id)][2], requests[String(id)][2] && !requests[String(id)][3] ? requests[String(id)][1] : 0n],
      },
    );
    world.addContract(1, STAKING, parseAbi(["function claimUnstakeRequest(uint256 unstakeRequestID)"]), {
      claimUnstakeRequest: ([id], { from }) => {
        const q = requests[String(id)];
        if (q[0] !== from) revert("NotRequester");
        if (!q[2]) revert("NotFinalized");
      },
    });
  });

  test("the address's own requests, found from their creation events: claimed ones count as completed", async () => {
    const r = await checkMeth(USER);
    assert.deepEqual(shown(r), [
      ["ready", "ETH", 6n * e18],
      ["waiting", "ETH", e18],
    ]);
    assert.equal(r.completed, 1);
    assert.match(r.findings[0].claimAt ?? "", /claimUnstakeRequest/);
  });

  test("no request event: nothing", async () => {
    assert.deepEqual(await checkMeth(NOBODY), { findings: [], completed: 0 });
  });
});

/* ───────────────────────── Kelp ───────────────────────── */

describe("Kelp withdrawals", () => {
  const MANAGER = getAddress("0x62De59c08eB5dAE4b7E6F7a8cAd3006d6965ec16");
  const ETH = getAddress("0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE");
  const STETH = getAddress("0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84");
  // asset → the user's queue: [rsETH, expected, nonce]
  const queues: Record<string, [bigint, bigint, bigint][]> = {
    [`${ETH}:${USER}`]: [
      [e18, (108n * e18) / 100n, 10n], // unlocked
      [2n * e18, (216n * e18) / 100n, 30n], // still locked
    ],
    [`${STETH}:${USER}`]: [[e18, (107n * e18) / 100n, 4n]], // unlocked, paid in stETH
  };
  before(() => {
    world.prices[`ethereum:${STETH.toLowerCase()}`] = 1990;
    world.addContract(
      1,
      MANAGER,
      parseAbi([
        "function userAssociatedNonces(address asset, address user) view returns (uint128 begin, uint128 end)",
        "function getUserWithdrawalRequest(address asset, address user, uint256 index) view returns (uint256 rsETHAmount, uint256 expectedAssetAmount, uint256 withdrawalStartBlock, uint256 userWithdrawalRequestNonce)",
        "function nextLockedNonce(address asset) view returns (uint256)",
        "function completeWithdrawal(address asset, string referralId)",
      ]),
      {
        userAssociatedNonces: ([asset, user]) => [0n, BigInt(queues[`${asset}:${user}`]?.length ?? 0)],
        getUserWithdrawalRequest: ([asset, user, i]) => {
          const q = queues[`${asset}:${user}`][Number(i)];
          return [q[0], q[1], 100n, q[2]];
        },
        nextLockedNonce: () => 20n,
        completeWithdrawal: ([asset], { from }) => {
          const q = queues[`${asset}:${from}`];
          if (!q?.length) revert("NoPendingWithdrawals");
          if (q[0][2] >= 20n) revert("WithdrawalLocked");
        },
      },
    );
  });

  test("per asset: unlocked requests are ready, locked ones wait", async () => {
    const r = await checkKelp(USER);
    assert.deepEqual(shown(r), [
      ["ready", "ETH", (108n * e18) / 100n],
      ["ready", "stETH", (107n * e18) / 100n],
      ["waiting", "ETH", (216n * e18) / 100n],
    ]);
    assert.match(r.findings[0].note ?? "", /rsETH/);
  });

  test("no request in any asset: nothing", async () => {
    assert.deepEqual(await checkKelp(NOBODY), { findings: [], completed: 0 });
  });
});

/* ───────────────────────── Ethena ───────────────────────── */

describe("Ethena unstaking", () => {
  const SUSDE = getAddress("0x9D39A5DE30e57443BfF2A8307A4256c8797A3497");
  const USDE = getAddress("0x4c9EDD5852cd905f086C759E8383e09bff1E68B3");
  const cooldowns: Record<string, [number, bigint]> = { [USER]: [NOW - 3600, 500n * e18], [OTHER]: [NOW + 86400, 40n * e18] };
  before(() => {
    world.prices[`ethereum:${USDE.toLowerCase()}`] = 1;
    world.addContract(1, SUSDE, parseAbi(["function cooldowns(address) view returns (uint104 cooldownEnd, uint152 underlyingAmount)", "function unstake(address receiver)"]), {
      cooldowns: ([a]) => [BigInt(cooldowns[a as string]?.[0] ?? 0), cooldowns[a as string]?.[1] ?? 0n],
      unstake: (_, { from }) => {
        if ((cooldowns[from as string]?.[0] ?? Infinity) > NOW) revert("InvalidCooldown");
      },
    });
  });

  test("a cooldown that ended is ready; one still running waits until its end", async () => {
    assert.deepEqual(shown(await checkEthena(USER)), [["ready", "USDe", 500n * e18]]);
    const waiting = await checkEthena(OTHER);
    assert.deepEqual(shown(waiting), [["waiting", "USDe", 40n * e18]]);
    assert.equal(waiting.findings[0].readyAt, NOW + 86400);
    assert.equal(waiting.findings[0].fr?.dateLabel, "Fin du cooldown le");
  });

  test("nothing unstaked: nothing", async () => {
    assert.deepEqual(await checkEthena(NOBODY), { findings: [], completed: 0 });
  });
});

/* ───────────────────────── NFT marketplaces ───────────────────────── */

describe("NFT marketplace balances", () => {
  const BLUR = getAddress("0x0000000000A39bb272e79075ade125fd351887Ac");
  const FETH = getAddress("0x49128CF8ABE9071ee24540a296b5DED3F9D50443");
  const abi = parseAbi(["function balanceOf(address) view returns (uint256)", "function withdraw(uint256 amount)", "function withdrawAvailableBalance()"]);
  const blur: Record<string, bigint> = { [USER]: 3n * e18, [OTHER]: e18 };
  const feth: Record<string, bigint> = { [USER]: e18 / 2n };
  before(() => {
    world.addContract(1, BLUR, abi, {
      balanceOf: ([a]) => blur[a as string] ?? 0n,
      // OTHER's ETH backs a live bid being matched: the pool refuses the withdrawal.
      withdraw: ([amount], { from }) => ((blur[from as string] ?? 0n) < (amount as bigint) || from === OTHER ? revert("Insufficient balance") : undefined),
    });
    world.addContract(1, FETH, abi, {
      balanceOf: ([a]) => feth[a as string] ?? 0n,
      withdrawAvailableBalance: (_, { from }) => (feth[from as string] ? undefined : revert("FETH_No_Funds_To_Withdraw")),
    });
  });

  test("ETH in Blur's pool and in the Foundation balance, when the withdrawal simulates", async () => {
    const r = await checkNftMarkets(USER);
    assert.deepEqual(r.findings.map((f) => [f.networkName, f.asset.amount]).sort(), [
      ["Blur: ETH in the bidding pool", 3n * e18],
      ["Foundation: ETH in your marketplace balance", e18 / 2n],
    ]);
    assert.equal(r.findings[0].fr?.label, "Blur : ETH dans le pool d'enchères");
  });

  test("a withdrawal the contract refuses is not reported; no balance, nothing", async () => {
    assert.deepEqual(await checkNftMarkets(OTHER), { findings: [], completed: 0 });
    assert.deepEqual(await checkNftMarkets(NOBODY), { findings: [], completed: 0 });
  });
});

/* ───────────────────────── Uniswap 2020 farms ───────────────────────── */

describe("Uniswap 2020 farms", () => {
  const UNI = getAddress("0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984");
  const abi = parseAbi(["function balanceOf(address) view returns (uint256)", "function earned(address) view returns (uint256)", "function exit()"]);
  // farm → user → [staked, earned]
  const farms: Record<string, Record<string, [bigint, bigint]>> = {
    [UNI_FARM_LIST[0].farm]: { [USER]: [12n * e18, 30n * e18] },
    [UNI_FARM_LIST[1].farm]: { [USER]: [0n, 4n * e18], [OTHER]: [e18, 0n] },
  };
  before(() => {
    world.prices[`ethereum:${UNI.toLowerCase()}`] = 8;
    world.prices[`ethereum:${UNI_FARM_LIST[0].lp.toLowerCase()}`] = 180;
    for (const f of UNI_FARM_LIST)
      world.addContract(1, f.farm, abi, {
        balanceOf: ([a]) => farms[f.farm]?.[a as string]?.[0] ?? 0n,
        earned: ([a]) => farms[f.farm]?.[a as string]?.[1] ?? 0n,
        // OTHER's exit fails (as it would if the farm could no longer pay).
        exit: (_, { from }) => (from === OTHER ? revert("SafeMath: subtraction overflow") : undefined),
      });
  });

  test("pool tokens still staked and UNI never claimed, per farm, when exit() simulates", async () => {
    const r = await checkUniFarms(USER);
    assert.deepEqual(r.findings.map((f) => [f.asset.symbol, f.asset.amount]).sort(), [
      ["ETH/DAI UNI-V2", 12n * e18],
      ["UNI", 30n * e18],
      ["UNI", 4n * e18],
    ]);
    const lp = r.findings.find((f) => f.asset.symbol === "ETH/DAI UNI-V2")!;
    assert.equal(lp.asset.token, UNI_FARM_LIST[0].lp);
    assert.match(lp.note ?? "", /ended on November 17, 2020/);
    assert.match(lp.fr?.note ?? "", /terminée le 17 novembre 2020/);
  });

  test("an exit the farm rejects is not reported; nothing staked, nothing", async () => {
    assert.deepEqual(await checkUniFarms(OTHER), { findings: [], completed: 0 });
    assert.deepEqual(await checkUniFarms(NOBODY), { findings: [], completed: 0 });
  });
});

/* ───────────────────────── Wiring ───────────────────────── */

describe("The new checks are listed like the others", () => {
  const REWARDS = ["stader-withdrawals", "swell-withdrawals", "frax-redemptions", "meth-withdrawals", "kelp-withdrawals", "ethena-unstake", "nft-marketplaces"];

  test("in their group, for Ethereum addresses, with a color and a French name", () => {
    for (const id of REWARDS) {
      const s = sourceById(id);
      assert.ok(s, id);
      assert.equal(s.group, "rewards", id);
      assert.deepEqual(s.accepts, ["evm"], id);
      assert.ok(NETWORK_COLORS[id], `${id} has no color`);
      assert.ok(SOURCE_FR[id]?.name, `${id} has no French name`);
    }
    assert.equal(sourceById("uniswap-2020-farms")?.group, "legacy");
    assert.ok(NETWORK_COLORS["uniswap-2020-farms"]);
  });
});

/* ───────────────────────── Several addresses at once ───────────────────────── */

describe("Several addresses in one input", () => {
  test("split on spaces, commas, semicolons and new lines", () => {
    assert.deepEqual(splitInputs(` ${USER}, vitalik.eth;\n${OTHER}\r\n\tB8tZrAXiEW8u6ibE8whwgbML1wzMzHXnQtJZd4BQezyK `), [USER, "vitalik.eth", OTHER, "B8tZrAXiEW8u6ibE8whwgbML1wzMzHXnQtJZd4BQezyK"]);
    assert.deepEqual(splitInputs("vitalik.eth"), ["vitalik.eth"]);
    assert.deepEqual(splitInputs("  \n "), []);
  });

  test("the same address or name twice is kept once, whatever its case (Solana addresses keep theirs)", () => {
    const mixed = "0xAbCdEf0000000000000000000000000000000001";
    assert.deepEqual(splitInputs(`${mixed} ${mixed.toLowerCase()} Vitalik.eth vitalik.eth`), [mixed, "Vitalik.eth"]);
    assert.deepEqual(splitInputs("AbcDef1 abcdef1"), ["AbcDef1", "abcdef1"]);
    assert.ok(MAX_WALLETS >= 5);
  });
});
