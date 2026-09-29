import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { parseAbi, parseAbiItem, zeroAddress, type Address, type Hex } from "viem";
import { checkAirdrops } from "../src/lib/checks/airdrops.ts";
import { checkCctp } from "../src/lib/checks/cctp.ts";
import { checkDebridge } from "../src/lib/checks/debridge.ts";
import { checkPolygon } from "../src/lib/checks/polygon.ts";
import { checkWormhole, decodeTransferVaa } from "../src/lib/checks/wormhole.ts";
import { associatedTokenAddress, findProgramAddress, hexBytes, u16be, u64be } from "../src/lib/solana.ts";
import { base58 } from "@scure/base";
import { sourcesFor } from "../src/lib/checker.ts";
import { MockChain } from "./mockchain.ts";
import {
  CCTP_V1_USED_NONCES_499201,
  CLAIM_PDA_ETH_691205,
  SOL_WALLET,
  SOL_WALLET_USDC_ATA,
  WORMHOLE_VAA_242189,
  WORMHOLE_VAA_242189_RECIPIENT,
} from "./real-data.ts";

const USER: Address = "0x1111111111111111111111111111111111111111";
const STRANGER: Address = "0x9999999999999999999999999999999999999999";
const SOL_EMITTER = "ec7372995d5cc8732397fb0ad35c0121e0eaa90d26f828a534cab54391b3a4f5";
const TOKEN_BRIDGE: Address = "0x3ee18B2214AFF97000D974cf647E7C347E8fa585";
const WRAPPED_USDC: Address = "0x41f7B8b9b897276b7AAE926a9016935280b44E97";
const enc = (s: string) => new TextEncoder().encode(s);

const world = new MockChain();
let redeemed = false;
before(() => {
  globalThis.fetch = world.fetch as typeof fetch;
});

describe("Solana derivations (checked against mainnet)", () => {
  test("Token Bridge claim account", () => {
    const pda = findProgramAddress(
      [hexBytes("0000000000000000000000003ee18b2214aff97000d974cf647e7c347e8fa585"), u16be(2), u64be(691205n)],
      "wormDTUJ6AWPNvk59vGQbDvGJmqbDTdgWgAqcLBCgUb",
    );
    assert.equal(pda, CLAIM_PDA_ETH_691205);
  });
  test("USDC associated token account", () => {
    assert.equal(associatedTokenAddress(SOL_WALLET, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"), SOL_WALLET_USDC_ATA);
  });
  test("CCTP v1 used-nonces account", () => {
    const pda = findProgramAddress([enc("used_nonces"), enc("0"), enc("499201")], "CCTPmbSD7gX1bxKPAmg77w8oFzNFpaQiQUWD43TKaecd");
    assert.equal(pda, CCTP_V1_USED_NONCES_499201);
  });
});

describe("Wormhole", () => {
  test("decodes a real Token Bridge VAA", () => {
    const t = decodeTransferVaa(WORMHOLE_VAA_242189)!;
    assert.equal(t.emitterChain, 1);
    assert.equal(t.emitterAddress, SOL_EMITTER);
    assert.equal(t.sequence, 242189n);
    assert.equal(t.toChain, 2);
    assert.equal(`0x${t.to.slice(26)}`, WORMHOLE_VAA_242189_RECIPIENT.toLowerCase());
    assert.equal(t.amount, 1147420562n);
    assert.equal(t.tokenChain, 1);
  });

  test("rejects garbage and non-transfer payloads", () => {
    assert.equal(decodeTransferVaa("not base64!"), null);
    assert.equal(decodeTransferVaa(btoa("\x01short")), null);
  });

  const setup = () => {
    const id = `1/${SOL_EMITTER}/242189`;
    world.wormhole.transactions[WORMHOLE_VAA_242189_RECIPIENT.toLowerCase()] = [
      { id, timestamp: "2022-11-09T15:56:16Z", emitterChain: 1, emitterAddress: SOL_EMITTER },
      // not an official Token Bridge emitter: must be ignored
      { id: "1/abcdef/1", timestamp: "2022-11-09T15:56:16Z", emitterChain: 1, emitterAddress: "abcdef" },
    ];
    world.wormhole.vaas[id] = { vaa: WORMHOLE_VAA_242189, txHash: "5xSolanaTx" };
    world.addContract(
      1,
      TOKEN_BRIDGE,
      parseAbi([
        "function isTransferCompleted(bytes32) view returns (bool)",
        "function wrappedAsset(uint16, bytes32) view returns (address)",
      ]),
      { isTransferCompleted: () => redeemed, wrappedAsset: () => WRAPPED_USDC },
    );
    world.addContract(1, WRAPPED_USDC, parseAbi(["function decimals() view returns (uint8)", "function symbol() view returns (string)"]), {
      decimals: () => 6,
      symbol: () => "USDC",
    });
  };

  test("finds a Solana → Ethereum transfer never redeemed, verified on Ethereum", async () => {
    setup();
    redeemed = false;
    const r = await checkWormhole(WORMHOLE_VAA_242189_RECIPIENT as Address);
    assert.equal(r.findings.length, 1);
    const f = r.findings[0];
    assert.equal(f.networkName, "Wormhole · Solana → Ethereum");
    assert.equal(f.status, "ready");
    assert.equal(f.asset.symbol, "USDC");
    assert.equal(f.asset.amount, 1147420562n);
    assert.equal(f.asset.decimals, 6);
    assert.equal(f.asset.priceKey, "solana:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    assert.equal(f.txUrl, "https://solscan.io/tx/5xSolanaTx");
  });

  test("counts it as completed once redeemed", async () => {
    setup();
    redeemed = true;
    const r = await checkWormhole(WORMHOLE_VAA_242189_RECIPIENT as Address);
    assert.equal(r.findings.length, 0);
    assert.equal(r.completed, 1);
  });

  test("another address sees nothing", async () => {
    const r = await checkWormhole(STRANGER);
    assert.deepEqual(r, { findings: [], completed: 0 });
  });
});

describe("deBridge", () => {
  const order = (id: string, give: string, take: string, state: string) => ({
    orderId: { stringValue: id },
    creationTimestamp: Math.floor(Date.now() / 1000) - 30 * 86400,
    giveOfferWithMetadata: {
      chainId: { stringValue: give },
      tokenAddress: { stringValue: give === "1" ? "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" : "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" },
      amount: { stringValue: "1670621484" },
      symbol: "USDC",
      decimals: 6,
    },
    takeOfferWithMetadata: { chainId: { stringValue: take }, tokenAddress: { stringValue: "0x0" }, amount: { stringValue: "1" } },
    state,
    createEventTransactionHash: { stringValue: "0xabc" },
  });
  const ID1 = `0x${"1".repeat(64)}`; // Solana → Ethereum, never filled, user can cancel
  const ID2 = `0x${"2".repeat(64)}`; // Ethereum → Solana, API says Created but refunded on-chain
  const ID3 = `0x${"3".repeat(64)}`; // someone else's order
  const ID4 = `0x${"4".repeat(64)}`; // Solana → Ethereum with a fake "USⅮΤ" token

  before(() => {
    world.debridge.orders = [order(ID1, "7565164", "1", "Created"), order(ID2, "1", "7565164", "Created"), order(ID3, "7565164", "1", "Created")];
    const fake = order(ID4, "7565164", "1", "Created");
    fake.giveOfferWithMetadata.symbol = "USⅮΤ";
    world.debridge.orders.push(fake);
    world.debridge.details = {
      [ID1]: { makerSrc: { stringValue: "SoLanaMaker" }, orderAuthorityAddressDst: { stringValue: USER } },
      [ID2]: { makerSrc: { stringValue: USER }, orderAuthorityAddressDst: { stringValue: "SoLanaAuth" } },
      [ID3]: { makerSrc: { stringValue: "SoLanaMaker" }, orderAuthorityAddressDst: { stringValue: STRANGER } },
      [ID4]: { makerSrc: { stringValue: "SoLanaMaker" }, orderAuthorityAddressDst: { stringValue: USER } },
    };
    const dln = parseAbi([
      "function giveOrders(bytes32) view returns (uint8 status, uint160 giveTokenAddress, uint256 giveAmount)",
      "function takeOrders(bytes32) view returns (uint8 status, address takerAddress, uint256 giveChainId)",
    ]);
    world.addContract(1, "0xeF4fB24aD0916217251F553c0596F8Edc630EB66", dln, { giveOrders: () => [3, 0n, 0n] }); // refunded
    world.addContract(1, "0xE7351Fd770A37282b91D153Ee690B63579D6dd7f", dln, { takeOrders: () => [0, USER, 7565164n] }); // not filled
  });

  test("finds unfilled orders the user can act on, double-checked on Ethereum", async () => {
    const r = await checkDebridge(USER);
    assert.equal(r.completed, 1, "the refunded order counts as completed");
    assert.equal(r.findings.length, 2);
    const real = r.findings.find((f) => f.asset.symbol === "USDC")!;
    assert.equal(real.networkName, "deBridge · Solana → Ethereum");
    assert.equal(real.asset.amount, 1670621484n);
    assert.match(real.note ?? "", /never filled/);
    const fake = r.findings.find((f) => f.asset.symbol === "USⅮΤ")!;
    assert.match(fake.note ?? "", /scam/);
    assert.equal(fake.asset.priceKey, "none:none", "fake tokens are never priced");
  });

  test("covers every route, double-checked on each EVM chain", async () => {
    const saved = { ...world.debridge, orders: [...world.debridge.orders] };
    const P1 = `0x${"5".repeat(64)}`; // Polygon → Base, never filled
    const P2 = `0x${"6".repeat(64)}`; // Polygon → Base, API says open but filled on Base
    const P3 = `0x${"7".repeat(64)}`; // Berachain (deBridge id 100000020) → Solana, cancelled, refund unclaimed
    const poly = (id: string, give: string, take: string, state: string, token: string) => {
      const o = order(id, give, take, state);
      o.giveOfferWithMetadata.tokenAddress.stringValue = token;
      return o;
    };
    world.debridge.orders = [
      poly(P1, "137", "8453", "Created", "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359"),
      poly(P2, "137", "8453", "Created", "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359"),
      poly(P3, "100000020", "7565164", "OrderCancelled", "0x0000000000000000000000000000000000000000"),
    ];
    world.debridge.details = Object.fromEntries([P1, P2, P3].map((id) => [id, { makerSrc: { stringValue: USER } }]));
    const dln = parseAbi([
      "function giveOrders(bytes32) view returns (uint8 status, uint160 giveTokenAddress, uint256 giveAmount)",
      "function takeOrders(bytes32) view returns (uint8 status, address takerAddress, uint256 giveChainId)",
    ]);
    world.addContract(137, "0xeF4fB24aD0916217251F553c0596F8Edc630EB66", dln, { giveOrders: () => [1, 0n, 0n] });
    world.addContract(8453, "0xE7351Fd770A37282b91D153Ee690B63579D6dd7f", dln, {
      takeOrders: ([id]) => (id === P2 ? [1, USER, 137n] : [0, zeroAddress, 0n]),
    });
    world.addContract(80094, "0xeF4fB24aD0916217251F553c0596F8Edc630EB66", dln, { giveOrders: () => [1, 0n, 0n] });
    try {
      const r = await checkDebridge(USER);
      assert.equal(r.completed, 1, "the order filled on Base counts as completed");
      assert.deepEqual(r.findings.map((f) => f.networkName).sort(), ["deBridge · Berachain → Solana", "deBridge · Polygon → Base"]);
      const polygon = r.findings.find((f) => f.networkName.includes("Polygon"))!;
      assert.equal(polygon.asset.priceKey, "polygon:0x3c499c542cef5e3811e1192ce70d8cc03d5c3359");
      const bera = r.findings.find((f) => f.networkName.includes("Berachain"))!;
      assert.equal(bera.asset.priceKey, "coingecko:berachain-bera");
      assert.match(bera.note ?? "", /cancelled/);
    } finally {
      Object.assign(world.debridge, saved);
    }
  });
});

describe("Circle CCTP", () => {
  const MESSENGER: Address = "0xBd3fa81B58Ba92a82136038B25aDec7066af3155";
  const ev = parseAbiItem(
    "event DepositForBurn(uint64 indexed nonce, address indexed burnToken, uint256 amount, address indexed depositor, bytes32 mintRecipient, uint32 destinationDomain, bytes32 destinationTokenMessenger, bytes32 destinationCaller)",
  );
  const burn = (hash: Hex, nonce: bigint, domain: number) => ({
    chainId: 1,
    hash,
    from: USER,
    to: MESSENGER,
    blockNumber: 20_000_000n + nonce,
    timestamp: Math.floor(Date.now() / 1000) - 90 * 86400,
    logs: [
      {
        address: MESSENGER,
        event: ev,
        args: {
          nonce,
          burnToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
          amount: 115_000_000n,
          depositor: USER,
          mintRecipient: `0x${"ab".repeat(32)}`,
          destinationDomain: domain,
          destinationTokenMessenger: `0x${"cd".repeat(32)}`,
          destinationCaller: `0x${"00".repeat(32)}`,
        },
      },
    ],
  });

  before(() => {
    world.addTx(burn(`0x${"a1".repeat(32)}`, 500977n, 5)); // to Solana, never minted
    world.addTx(burn(`0x${"a2".repeat(32)}`, 500981n, 5)); // to Solana, minted
    world.addTx(burn(`0x${"a3".repeat(32)}`, 500990n, 6)); // to Base: not our route
    // Solana's used-nonces bitmap for nonces 499201–505600: only 500981 is set.
    const data = new Uint8Array(820);
    const idx = 500981 - 499201;
    data[20 + Math.floor(idx / 64) * 8 + Math.floor((idx % 64) / 8)] |= 1 << (idx % 8);
    world.solana[CCTP_V1_USED_NONCES_499201] = data;
  });

  test("finds USDC burned for Solana and never minted there", async () => {
    const r = await checkCctp(USER);
    assert.equal(r.completed, 1);
    assert.equal(r.findings.length, 1);
    const f = r.findings[0];
    assert.equal(f.networkName, "Circle CCTP · Ethereum → Solana");
    assert.equal(f.asset.amount, 115_000_000n);
    assert.equal(f.asset.symbol, "USDC");
    assert.match(f.note ?? "", /Anyone can complete it/);
  });
});

describe("Polygon PoS", () => {
  test("comes back clean when the wallet never burned bridged tokens", async () => {
    const r = await checkPolygon(STRANGER);
    assert.deepEqual(r, { findings: [], completed: 0 });
  });
});

describe("Wallet kinds", () => {
  test("a Solana address runs only the checks that apply to Solana", () => {
    assert.deepEqual(
      sourcesFor("solana").map((s) => s.id),
      ["wormhole", "debridge", "cctp", "airdrop-kamino-s3"],
    );
  });
  test("an Ethereum address runs everything", () => {
    assert.equal(sourcesFor("evm").length, 50);
  });
});

describe("Airdrops", () => {
  const ELIGIBLE: Address = "0x32b7C9B07ed7885d398ef5A65206E77f1b5B92F9";
  const CLAIMED: Address = "0x32b73C3C101f74e24A815a8291Eb60F25d96cdcc";
  before(() => {
    const base = "https://raw.githubusercontent.com/Uniswap/mrkl-drop-data-chunks/final/chunks";
    world.static[`${base}/mapping.json`] = {
      "0x0000000000000000000000000000000000000000": "0x0003092ffbaaaa22d8d9c9715b357e01db1915b7",
      "0x32b0000000000000000000000000000000000000": "0x32b8000000000000000000000000000000000000",
    };
    world.static[`${base}/0x32b0000000000000000000000000000000000000.json`] = {
      [ELIGIBLE]: { index: 7, amount: "0x15af1d78b58c400000", proof: [] },
      [CLAIMED]: { index: 8, amount: "0x15af1d78b58c400000", proof: [] },
    };
    world.addContract(1, "0x090D4613473dEE047c3f2706764f49E0821D256e", parseAbi(["function isClaimed(uint256) view returns (bool)"]), {
      isClaimed: ([i]) => i === 8n,
    });
    const e18 = 10n ** 18n;
    const lower = (a: string) => a.toLowerCase();
    // Curve: ELIGIBLE still has 1,000 vested CRV, CLAIMED took everything.
    world.addContract(1, "0x575CCD8e2D300e2377B43478339E364000318E2c", parseAbi(["function balanceOf(address) view returns (uint256)", "function initial_locked(address) view returns (uint256)"]), {
      balanceOf: ([a]) => (a === ELIGIBLE ? 1000n * e18 : 0n),
      initial_locked: ([a]) => (a === ELIGIBLE || a === CLAIMED ? 1000n * e18 : 0n),
    });
    // 1inch: API rows, then isClaimed(index).
    world.static[`https://governance.1inch.io/v1.0/distribution/${ELIGIBLE}`] = { index: 1, amount: "0x" + (50n * e18).toString(16), proof: [] };
    world.static[`https://governance.1inch.io/v1.0/distribution/${CLAIMED}`] = { index: 2, amount: "0x1", proof: [] };
    world.addContract(1, "0xE295aD71242373C37C5FdA7B57F26f9eA1088AFe", parseAbi(["function isClaimed(uint256) view returns (bool)"]), { isClaimed: ([i]) => i === 2n });
    // Lido: CSV lists (the header spans two lines), then isClaimed(index).
    const csv = (rows: string) => `index (uint256),account (address),amount (uint256),merkleProof (bytes32[]),"LDO airdrop amount\n(don't paste on Etherscan)"\n${rows}`;
    world.static["https://raw.githubusercontent.com/lidofinance/airdrop-data/main/early_stakers_airdrop.csv"] = csv(`0,${ELIGIBLE},0x${(7n * e18).toString(16)},"[0x01]",7\n1,${CLAIMED},0x1,"[0x02]",0\n`);
    world.static["https://raw.githubusercontent.com/lidofinance/airdrop-data/main/oneinch_lido_airdrop.csv"] = csv("");
    world.addContract(1, "0x4b3EDb22952Fb4A70140E39FB1adD05A6B49622B", parseAbi(["function isClaimed(uint256) view returns (bool)"]), { isClaimed: ([i]) => i === 1n });
    // Convex: compact list published with the site, then hasClaimed(address).
    world.static["https://lostfunds.vercel.app/airdrops/convex-cvx.json"] = { [lower(ELIGIBLE)]: String(3n * e18), [lower(CLAIMED)]: "1" };
    world.addContract(1, "0x2E088A0A19dda628B4304301d1EA70b114e4AcCd", parseAbi(["function hasClaimed(address) view returns (bool)"]), { hasClaimed: ([a]) => a === CLAIMED });
    // Safe: ELIGIBLE redeemed a vesting with 40 SAFE vested but unclaimed; CLAIMED took all of it.
    const VEST = "0xA0b937D5c8E32a80E3a8ed4227CD020221544ee6";
    const vid = (n: number) => `0x${String(n).repeat(64)}`;
    world.static[`https://safe-claiming-app-data.safe.global/allocations/1/${ELIGIBLE}.json`] = [{ vestingId: vid(1), contract: VEST }];
    world.static[`https://safe-claiming-app-data.safe.global/allocations/1/${CLAIMED}.json`] = [{ vestingId: vid(2), contract: VEST }];
    world.addContract(1, VEST, parseAbi([
      "function vestings(bytes32) view returns (address account, uint8 curveType, bool managed, uint16 durationWeeks, uint64 startDate, uint128 amount, uint128 amountClaimed, uint64 pausingDate, bool cancelled)",
      "function calculateVestedAmount(bytes32) view returns (uint128 vestedAmount, uint128 claimedAmount)",
    ]), {
      vestings: ([id]) => [id === vid(1) ? ELIGIBLE : CLAIMED, 0, false, 208, 0n, 100n * e18, 0n, 0n, false],
      calculateVestedAmount: ([id]) => (id === vid(1) ? [100n * e18, 60n * e18] : [100n * e18, 100n * e18]),
    });
    // Zora: ELIGIBLE never claimed 20,000 ZORA, CLAIMED did.
    world.addContract(8453, "0x0000000002ba96c69b95e32caab8fc38bab8b3f8", parseAbi(["function accountClaim(address) view returns ((uint96 allocation, bool claimed))"]), {
      accountClaim: ([a]) =>
        a === ELIGIBLE ? { allocation: 20_000n * 10n ** 18n, claimed: false } : a === CLAIMED ? { allocation: 5n * 10n ** 18n, claimed: true } : { allocation: 0n, claimed: false },
    });
    // Sonic: ELIGIBLE still holds season 2 NFTs; one season's burn deadline has passed.
    const soon = BigInt(Math.floor(Date.now() / 1000) + 10 * 86400);
    world.addContract(146, "0xE1401171219FD2fD37c8C04a8A753B07706F3567", parseAbi([
      "function getSeasonData(uint8) view returns (uint256 startTime, uint256 maturationTime, uint256 claimsBurnTime, uint256 lockedBurnTime, uint256 instantClaimAvailableBps, bytes32 merkleRoot)",
      "function getSeasonBalances(uint8 season, address user) view returns (uint128 balance, uint128 vested, uint128 penalty)",
    ]), {
      getSeasonData: ([season]) => [0n, 0n, 0n, season === 1 ? 1n : soon, 0n, `0x${"0".repeat(64)}`],
      getSeasonBalances: ([, user]) => (user === ELIGIBLE ? [1000n * 10n ** 18n, 0n, 0n] : [0n, 0n, 0n]),
    });
  });

  test("finds every airdrop never claimed: UNI 2020, Zora, and Sonic before its burn date", async () => {
    const r = await checkAirdrops(ELIGIBLE);
    const by = Object.fromEntries(r.findings.map((f) => [f.asset.symbol, f]));
    assert.deepEqual(Object.keys(by).sort(), ["1INCH", "CRV", "CVX", "LDO", "S", "SAFE", "UNI", "ZORA"]);
    assert.equal(by.CRV.asset.amount, 1000n * 10n ** 18n);
    assert.equal(by.SAFE.asset.amount, 40n * 10n ** 18n, "vested minus already claimed");
    assert.equal(by.LDO.asset.amount, 7n * 10n ** 18n);
    assert.equal(by.CVX.asset.amount, 3n * 10n ** 18n);
    assert.equal(by["1INCH"].asset.amount, 50n * 10n ** 18n);
    assert.equal(by.UNI.asset.amount, 400n * 10n ** 18n);
    assert.equal(by.ZORA.asset.amount, 20_000n * 10n ** 18n);
    assert.equal(by.S.asset.amount, 1000n * 10n ** 18n, "the season past its burn date is left out");
    assert.match(by.S.note ?? "", /burned/);
  });
  test("counts a claimed airdrop as completed", async () => {
    const r = await checkAirdrops(CLAIMED);
    assert.deepEqual([r.findings.length, r.completed], [0, 7]);
  });
  test("Kamino (Solana): unclaimed, claimed, clawed back and not eligible", async () => {
    const PROGRAM = "KdisqEcXbXKaTrBFqeDLhMmBvymLTwj9GmhDcdJyGat";
    const TREE = "D3GQ7qRYHeDN7Ci7afLuwaRBqb4EAgxXFKtYGLy9L3Hw";
    const CLAWED = "WLNqXyuW2aWR6B6USyYSoMBDBkMtrKKVMy2ZbH28dM3";
    const [unclaimed, claimed, clawed] = [
      "WHap92SebrYjz8bqv9rGhQcSdc8APCZFfxvb6sLVzch",
      "2pEgewFKcLdHNeFDiWM4EQhSPJvgTxmcCHDUK56jj91U",
      "XG1TdMjXdU699exrdGevCFC5QT5h215J7uZjzTJcedZ",
    ];
    const api = "https://api.kamino.finance/distributor/user";
    world.static[`${api}/${unclaimed}`] = { merkle_tree: TREE, amount: 555214547, proof: [] };
    world.static[`${api}/${claimed}`] = { merkle_tree: TREE, amount: 15076657, proof: [] };
    world.static[`${api}/${clawed}`] = { merkle_tree: CLAWED, amount: 1, proof: [] };
    world.solana[TREE] = new Uint8Array(376);
    world.solana[CLAWED] = new Uint8Array(376).fill(1, 265, 266);
    const status = (who: string) =>
      findProgramAddress([new TextEncoder().encode("ClaimStatus"), base58.decode(who), base58.decode(TREE)], PROGRAM);
    world.solana[status(claimed)] = new Uint8Array(104);

    const a = await checkAirdrops(unclaimed);
    assert.equal(a.findings.length, 1);
    assert.equal(a.findings[0].asset.amount, 555214547n);
    assert.equal(a.findings[0].asset.symbol, "KMNO");
    assert.deepEqual(await checkAirdrops(claimed), { findings: [], completed: 1 });
    assert.deepEqual(await checkAirdrops(clawed), { findings: [], completed: 0 }, "clawed back: no longer claimable");
    assert.deepEqual(await checkAirdrops("5WN3T8AXQ3JnyUE5Zu5LDh8wS5Mdpx43E2KnDeRvZjC3"), { findings: [], completed: 0 });
  });
  test("ignores addresses that weren't eligible", async () => {
    const r = await checkAirdrops("0x32b5555555555555555555555555555555555555");
    assert.deepEqual(r, { findings: [], completed: 0 });
  });
});
