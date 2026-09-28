import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { parseAbi, parseAbiItem, type Address, type Hex } from "viem";
import { checkCctp } from "../src/lib/checks/cctp.ts";
import { checkDebridge } from "../src/lib/checks/debridge.ts";
import { checkPolygon } from "../src/lib/checks/polygon.ts";
import { checkWormhole, decodeTransferVaa } from "../src/lib/checks/wormhole.ts";
import { findProgramAddress, hexBytes, u16be, u64be } from "../src/lib/solana.ts";
import { MockChain } from "./mockchain.ts";
import {
  CCTP_V1_USED_NONCES_499201,
  CLAIM_PDA_ETH_691205,
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
