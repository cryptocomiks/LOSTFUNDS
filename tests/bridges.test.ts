import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { concat, pad, parseAbi, parseAbiItem, size, toHex, zeroAddress, type Address, type Hex } from "viem";
import { checkAirdrops } from "../src/lib/checks/airdrops.ts";
import { checkCctp } from "../src/lib/checks/cctp.ts";
import { checkDebridge } from "../src/lib/checks/debridge.ts";
import { checkPolygon } from "../src/lib/checks/polygon.ts";
import { checkWormhole, decodeNttVaa, decodeTransferVaa } from "../src/lib/checks/wormhole.ts";
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
const erc20 = parseAbi(["function decimals() view returns (uint8)", "function symbol() view returns (string)"]);
const tokenBridgeAbi = parseAbi([
  "function isTransferCompleted(bytes32) view returns (bool)",
  "function wrappedAsset(uint16, bytes32) view returns (address)",
  "function completeTransfer(bytes)",
]);
const nttManagerAbi = parseAbi([
  "function isMessageExecuted(bytes32) view returns (bool)",
  "function getInboundQueuedTransfer(bytes32) view returns ((uint72 amount, uint64 txTimestamp, address recipient))",
  "function rateLimitDuration() view returns (uint64)",
  "function getTransceivers() view returns (address[])",
  "function getThreshold() view returns (uint8)",
  "function token() view returns (address)",
  "function getMode() view returns (uint8)",
]);
const transceiverAbi = parseAbi(["function getWormholePeer(uint16) view returns (bytes32)", "function receiveMessage(bytes)"]);

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
    assert.equal(t.guardianSet, 2);
    assert.equal(t.payloadType, 1);
    assert.equal(t.toChain, 2);
    assert.equal(`0x${t.to.slice(26)}`, WORMHOLE_VAA_242189_RECIPIENT.toLowerCase());
    assert.equal(t.amount, 1147420562n);
    assert.equal(t.tokenChain, 1);
  });

  test("rejects garbage and non-transfer payloads", () => {
    assert.equal(decodeTransferVaa("not base64!"), null);
    assert.equal(decodeTransferVaa(btoa("\x01short")), null);
    assert.equal(decodeNttVaa(WORMHOLE_VAA_242189), null);
  });

  let expired = false;
  const setup = () => {
    const id = `1/${SOL_EMITTER}/242189`;
    world.wormhole.transactions[WORMHOLE_VAA_242189_RECIPIENT.toLowerCase()] = [
      { id, timestamp: "2022-11-09T15:56:16Z", emitterChain: 1, emitterAddress: SOL_EMITTER },
      // not an official Token Bridge emitter: must be ignored
      { id: "1/abcdef/1", timestamp: "2022-11-09T15:56:16Z", emitterChain: 1, emitterAddress: "abcdef" },
    ];
    world.wormhole.vaas[id] = { vaa: WORMHOLE_VAA_242189, txHash: "5xSolanaTx" };
    world.addContract(1, TOKEN_BRIDGE, tokenBridgeAbi, {
      isTransferCompleted: () => redeemed,
      wrappedAsset: () => WRAPPED_USDC,
      completeTransfer: () => {
        if (expired) throw new Error("guardian set has expired");
      },
    });
    world.addContract(1, WRAPPED_USDC, erc20, { decimals: () => 6, symbol: () => "USDC" });
  };

  test("finds a Solana → Ethereum transfer never redeemed, verified on Ethereum", async () => {
    setup();
    redeemed = false;
    expired = false;
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

  test("an unredeemed VAA signed by an expired guardian set can't be redeemed as it is", async () => {
    setup();
    redeemed = false;
    expired = true;
    const r = await checkWormhole(WORMHOLE_VAA_242189_RECIPIENT as Address);
    assert.equal(r.findings.length, 1);
    assert.equal(r.findings[0].status, "manual");
    assert.match(r.findings[0].note ?? "", /guardian set 2/);
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

describe("Wormhole on every route", () => {
  const BASE_TB: Address = "0x8d2de8d2f73F1F4cAB472AC9A881C9b123C79627";
  const POLYGON_TB: Address = "0x5a58505a96D1dbf8dF91cB21B54419FC36e93fdE";
  const emitter = (tb: Address) => pad(tb.toLowerCase() as Hex, { size: 32 }).slice(2);
  const ARB_EMITTER = emitter("0x0b2402144Bb366A632D14B83F244D2e0e21bD39c");
  const ETH_EMITTER = emitter(TOKEN_BRIDGE);
  const BSC_EMITTER = emitter("0xB6F6D86a8f9879A9c87f643768d9efc38c1Da6E7");
  const USDC: Address = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
  const WETH: Address = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
  const BASE_USDC: Address = "0x00000000000000000000000000000000000b0b0b"; // Wormhole-wrapped USDC on Base
  const CAKE: Address = "0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82";
  const month = Math.floor(Date.now() / 1000) - 30 * 86400;
  const iso = (t: number) => new Date(t * 1000).toISOString();

  /** A signed VAA (no signatures: the mock chains don't verify them). */
  const vaa = (p: { gs?: number; chain: number; emitter: string; seq: bigint; payload: Hex }) =>
    Buffer.from(
      concat([
        "0x01",
        toHex(p.gs ?? 7, { size: 4 }),
        "0x00",
        toHex(month, { size: 4 }),
        toHex(0, { size: 4 }),
        toHex(p.chain, { size: 2 }),
        `0x${p.emitter}`,
        toHex(p.seq, { size: 8 }),
        "0x01",
        p.payload,
      ]).slice(2),
      "hex",
    ).toString("base64");
  const transfer = (p: { amount: bigint; token: Address; tokenChain: number; to: Address; toChain: number; type?: number }) =>
    concat([
      toHex(p.type ?? 1, { size: 1 }),
      toHex(p.amount, { size: 32 }),
      pad(p.token, { size: 32 }),
      toHex(p.tokenChain, { size: 2 }),
      pad(p.to, { size: 32 }),
      toHex(p.toChain, { size: 2 }),
      toHex(0, { size: 32 }),
    ]);

  // Every VAA below is listed by Wormholescan for USER; `from` is the source transaction's sender.
  const list = (address: string, entries: { chain: number; emitter: string; seq: bigint; vaa: string; from?: string; ntt?: boolean }[]) => {
    world.wormhole.transactions[address.toLowerCase()] = entries.map((e) => ({
      id: `${e.chain}/${e.emitter}/${e.seq}`,
      timestamp: iso(month),
      emitterChain: e.chain,
      emitterAddress: e.emitter,
      standardizedProperties: { appIds: [e.ntt ? "NATIVE_TOKEN_TRANSFER" : "PORTAL_TOKEN_BRIDGE"] },
      globalTx: { originTx: { from: e.from ?? STRANGER.toLowerCase(), txHash: `0x${e.seq.toString(16).padStart(64, "0")}` } },
    }));
    for (const e of entries) world.wormhole.vaas[`${e.chain}/${e.emitter}/${e.seq}`] = { vaa: e.vaa };
  };

  // Arbitrum → Base, to USER: #1 never redeemed, #2 redeemed, #3 signed by an expired guardian set.
  const toBase = (seq: bigint, gs = 7) =>
    vaa({ gs, chain: 23, emitter: ARB_EMITTER, seq, payload: transfer({ amount: 250_000_000n, token: USDC, tokenChain: 2, to: USER, toChain: 30 }) });
  const ARB_1 = toBase(1n);
  const ARB_2 = toBase(2n);
  const ARB_3 = toBase(3n, 3);
  // BSC → Polygon, sent by USER to STRANGER: CAKE was never registered on Polygon.
  const BSC_4 = vaa({ chain: 4, emitter: BSC_EMITTER, seq: 4n, payload: transfer({ amount: 5n * 10n ** 8n, token: CAKE, tokenChain: 4, to: STRANGER, toChain: 5 }) });
  // Not USER's (someone else's transfer), to a chain we can't check (Sui), and an empty transfer.
  const OTHER = vaa({ chain: 23, emitter: ARB_EMITTER, seq: 5n, payload: transfer({ amount: 1n, token: USDC, tokenChain: 2, to: STRANGER, toChain: 30 }) });
  const SUI = vaa({ chain: 23, emitter: ARB_EMITTER, seq: 6n, payload: transfer({ amount: 1n, token: USDC, tokenChain: 2, to: USER, toChain: 21 }) });
  const EMPTY = vaa({ chain: 23, emitter: ARB_EMITTER, seq: 7n, payload: transfer({ amount: 0n, token: USDC, tokenChain: 2, to: USER, toChain: 30 }) });
  // Ethereum → Solana, sent by USER: #8 redeemable, #9 claimed, #10 signed by expired guardian set 3.
  const toSolana = (seq: bigint, gs = 7) =>
    vaa({ gs, chain: 2, emitter: ETH_EMITTER, seq, payload: transfer({ amount: 1_000_000n, token: WETH, tokenChain: 2, to: `0x${"ab".repeat(20)}`, toChain: 1 }) });
  const ETH_8 = toSolana(8n);
  const ETH_9 = toSolana(9n);
  const ETH_10 = toSolana(10n, 3);

  const hashOf = (v: string) => decodeTransferVaa(v)!.hash;
  before(() => {
    const me = USER.toLowerCase();
    list(USER, [
      { chain: 23, emitter: ARB_EMITTER, seq: 1n, vaa: ARB_1 },
      { chain: 23, emitter: ARB_EMITTER, seq: 2n, vaa: ARB_2 },
      { chain: 23, emitter: ARB_EMITTER, seq: 3n, vaa: ARB_3 },
      { chain: 4, emitter: BSC_EMITTER, seq: 4n, vaa: BSC_4, from: me },
      { chain: 23, emitter: ARB_EMITTER, seq: 5n, vaa: OTHER },
      { chain: 23, emitter: ARB_EMITTER, seq: 6n, vaa: SUI },
      { chain: 23, emitter: ARB_EMITTER, seq: 7n, vaa: EMPTY },
      { chain: 2, emitter: ETH_EMITTER, seq: 8n, vaa: ETH_8, from: me },
      { chain: 2, emitter: ETH_EMITTER, seq: 9n, vaa: ETH_9, from: me },
      { chain: 2, emitter: ETH_EMITTER, seq: 10n, vaa: ETH_10, from: me },
    ]);
    world.addContract(8453, BASE_TB, tokenBridgeAbi, {
      isTransferCompleted: ([h]) => h === hashOf(ARB_2),
      wrappedAsset: ([chain, token]) => (chain === 2 && token === pad(USDC.toLowerCase() as Hex, { size: 32 }) ? BASE_USDC : zeroAddress),
      completeTransfer: ([vm]) => {
        if (vm === toHex(Buffer.from(ARB_3, "base64"))) throw new Error("guardian set has expired");
      },
    });
    world.addContract(8453, BASE_USDC, erc20, { decimals: () => 6, symbol: () => "USDC" });
    world.addContract(137, POLYGON_TB, tokenBridgeAbi, {
      isTransferCompleted: () => false,
      wrappedAsset: () => zeroAddress,
      completeTransfer: () => {
        throw new Error("no wrapper for this token created yet");
      },
    });
    world.addContract(56, CAKE, erc20, { decimals: () => 18, symbol: () => "Cake" });
    world.addContract(1, WETH, erc20, { decimals: () => 18, symbol: () => "WETH" });
    // Solana: #9 was claimed, guardian set 7 is active and set 3 expired, WETH is registered.
    const SOL_TB = "wormDTUJ6AWPNvk59vGQbDvGJmqbDTdgWgAqcLBCgUb";
    const CORE = "worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth";
    world.solana[findProgramAddress([hexBytes(ETH_EMITTER), u16be(2), u64be(9n)], SOL_TB)] = new Uint8Array(1);
    world.solana[findProgramAddress([enc("wrapped"), u16be(2), hexBytes(pad(WETH, { size: 32 }))], SOL_TB)] = new Uint8Array(82);
    const guardianSet = (index: number, expiration: number) => {
      const d = new Uint8Array(16 + 19 * 20);
      const view = new DataView(d.buffer);
      view.setUint32(0, index, true);
      view.setUint32(4, 19, true);
      view.setUint32(12 + 19 * 20, expiration, true);
      const seed = new Uint8Array(4);
      new DataView(seed.buffer).setUint32(0, index);
      world.solana[findProgramAddress([enc("GuardianSet"), seed], CORE)] = d;
    };
    guardianSet(3, 1713367800); // 2024-04-17
    guardianSet(7, 0);
  });

  test("checks EVM ↔ EVM transfers on the destination chain", async () => {
    const r = await checkWormhole(USER);
    const route = (seq: bigint) => r.findings.find((f) => f.id.endsWith(`/${seq}`));
    const arb = route(1n)!;
    assert.equal(arb.networkName, "Wormhole · Arbitrum → Base");
    assert.equal(arb.status, "ready");
    assert.equal(arb.asset.symbol, "USDC");
    assert.equal(arb.asset.amount, 250_000_000n);
    assert.equal(arb.asset.decimals, 6);
    assert.equal(arb.asset.priceKey, `ethereum:${USDC.toLowerCase()}`);
    assert.equal(arb.txUrl, `https://arbiscan.io/tx/0x${"1".padStart(64, "0")}`);
    assert.equal(route(2n), undefined, "redeemed on Base");

    const old = route(3n)!;
    assert.equal(old.status, "manual");
    assert.match(old.note ?? "", /guardian set 3/);

    const sent = route(4n)!;
    assert.equal(sent.networkName, "Wormhole · BNB Chain → Polygon");
    assert.equal(sent.status, "manual");
    assert.match(sent.note ?? "", /no wrapped version/);
    assert.match(sent.note ?? "", /0x9999…9999/);
    assert.equal(sent.asset.symbol, "Cake");
    assert.equal(sent.asset.decimals, 8, "Token Bridge amounts have at most 8 decimals");
    assert.equal(sent.asset.priceKey, `bsc:${CAKE.toLowerCase()}`);

    for (const seq of [5n, 6n, 7n]) assert.equal(route(seq), undefined, `transfer ${seq} is not the user's money`);
  });

  test("checks EVM → Solana transfers on Solana, guardian set included", async () => {
    const r = await checkWormhole(USER);
    const route = (seq: bigint) => r.findings.find((f) => f.id.endsWith(`/${seq}`));
    const ok = route(8n)!;
    assert.equal(ok.networkName, "Wormhole · Ethereum → Solana");
    assert.equal(ok.status, "ready");
    assert.equal(ok.asset.symbol, "WETH");
    assert.equal(ok.asset.decimals, 8);
    assert.equal(ok.asset.amount, 1_000_000n);
    assert.equal(route(9n), undefined, "claimed on Solana");
    assert.equal(route(10n)!.status, "manual");
    assert.equal(r.completed, 2, "one redeemed on Base, one claimed on Solana");
    assert.equal(r.findings.length, 5);
  });

  test("uses the VAAs /operations returns inline", async () => {
    const OPS_USER = "0x2222222222222222222222222222222222222222";
    const v = vaa({ chain: 23, emitter: ARB_EMITTER, seq: 11n, payload: transfer({ amount: 7_000_000n, token: USDC, tokenChain: 2, to: OPS_USER, toChain: 30 }) });
    const id = `23/${ARB_EMITTER}/11`;
    world.wormhole.operations[OPS_USER] = [{ id, vaa: { raw: v }, sourceChain: { timestamp: iso(month), from: STRANGER, transaction: { txHash: "0xabc" } } }];
    world.wormhole.transactions[OPS_USER] = [{ id, timestamp: iso(month), emitterChain: 23, emitterAddress: ARB_EMITTER }];
    const before = world.requests.length;
    const r = await checkWormhole(OPS_USER);
    assert.equal(r.findings.length, 1);
    assert.equal(r.findings[0].asset.amount, 7_000_000n);
    assert.ok(!world.requests.slice(before).some((u) => u.includes("/vaas/")), "no VAA download needed");
  });
});

describe("Wormhole NTT", () => {
  const MANAGER: Address = "0x00000000000000000000000000000000000a11ce";
  const FAKE: Address = "0x00000000000000000000000000000000000fa4e0";
  const TRANSCEIVER: Address = "0x00000000000000000000000000000000000c0de1";
  const TOKEN: Address = "0x00000000000000000000000000000000000b1d00";
  const SRC_TRANSCEIVER = pad("0x65739e922b1879814f2962cbfff01950075397a6", { size: 32 }).slice(2);
  const NTT_USER: Address = "0x3333333333333333333333333333333333333333";
  const month = Math.floor(Date.now() / 1000) - 30 * 86400;

  const nttVaa = (seq: bigint, manager: Address, amount: bigint) => {
    const ntt = concat(["0x994e5454", "0x08", toHex(amount, { size: 8 }), pad(TOKEN, { size: 32 }), pad(NTT_USER, { size: 32 }), toHex(30, { size: 2 })]);
    const message = concat([toHex(seq, { size: 32 }), pad(NTT_USER, { size: 32 }), toHex(size(ntt), { size: 2 }), ntt]);
    const payload = concat(["0x9945ff10", pad(MANAGER, { size: 32 }), pad(manager, { size: 32 }), toHex(size(message), { size: 2 }), message, "0x0000"]);
    const body = concat([toHex(month, { size: 4 }), toHex(0, { size: 4 }), toHex(4, { size: 2 }), `0x${SRC_TRANSCEIVER}`, toHex(seq, { size: 8 }), "0x0f", payload]);
    return Buffer.from(concat(["0x01", toHex(7, { size: 4 }), "0x00", body]).slice(2), "hex").toString("base64");
  };
  const STUCK = nttVaa(1n, MANAGER, 1_325_464_681_533n);
  const DONE = nttVaa(2n, MANAGER, 5n * 10n ** 8n);
  const SPOOF = nttVaa(3n, FAKE, 10n ** 15n); // a manager that claims TOKEN but can't mint it
  const QUEUED = nttVaa(4n, MANAGER, 3n * 10n ** 8n);
  const digest = (v: string) => decodeNttVaa(v)!.digest;

  before(() => {
    const ids = [STUCK, DONE, SPOOF, QUEUED].map((v, i) => ({ id: `4/${SRC_TRANSCEIVER}/${i + 1}`, v }));
    world.wormhole.transactions[NTT_USER.toLowerCase()] = ids.map(({ id }) => ({
      id,
      timestamp: new Date(month * 1000).toISOString(),
      emitterChain: 4,
      emitterAddress: SRC_TRANSCEIVER,
      standardizedProperties: { appIds: ["NATIVE_TOKEN_TRANSFER"] },
    }));
    for (const { id, v } of ids) world.wormhole.vaas[id] = { vaa: v };
    const managerFns = {
      isMessageExecuted: ([d]: readonly unknown[]) => d === digest(DONE) || d === digest(QUEUED),
      getInboundQueuedTransfer: ([d]: readonly unknown[]) => ({
        amount: 0n,
        txTimestamp: d === digest(QUEUED) ? BigInt(month) : 0n,
        recipient: NTT_USER,
      }),
      rateLimitDuration: () => 86_400n,
      getTransceivers: () => [TRANSCEIVER],
      getThreshold: () => 1,
      token: () => TOKEN,
      getMode: () => 1, // burning: the manager mints on delivery
    };
    world.addContract(8453, MANAGER, nttManagerAbi, managerFns);
    world.addContract(8453, FAKE, nttManagerAbi, { ...managerFns, isMessageExecuted: () => false });
    world.addContract(8453, TRANSCEIVER, transceiverAbi, {
      getWormholePeer: ([chain]) => (chain === 4 ? `0x${SRC_TRANSCEIVER}` : `0x${"00".repeat(32)}`),
      receiveMessage: () => undefined,
    });
    world.addContract(8453, TOKEN, [...erc20, ...parseAbi(["function mint(address, uint256)", "function balanceOf(address) view returns (uint256)"])], {
      decimals: () => 18,
      symbol: () => "BID",
      balanceOf: () => 0n,
      mint: (_, { from }) => {
        if (from?.toLowerCase() !== MANAGER.toLowerCase()) throw new Error("caller is not the minter");
      },
    });
    world.static["https://api.wormholescan.io/api/v1/native-token-transfer/token-list"] = [{ symbol: "bid", platforms: { base: TOKEN.toLowerCase() } }];
  });

  test("finds NTT transfers never delivered, and ignores managers that can't release the token", async () => {
    const r = await checkWormhole(NTT_USER);
    assert.equal(r.completed, 1);
    assert.equal(r.findings.length, 2);
    const stuck = r.findings.find((f) => f.id.endsWith("/1"))!;
    assert.equal(stuck.networkName, "Wormhole · BNB Chain → Base");
    assert.equal(stuck.status, "ready");
    assert.equal(stuck.asset.symbol, "BID");
    assert.equal(stuck.asset.amount, 1_325_464_681_533n);
    assert.equal(stuck.asset.decimals, 8);
    assert.equal(stuck.asset.priceKey, `base:${TOKEN.toLowerCase()}`);
    assert.match(stuck.note ?? "", /NTT/);
    const queued = r.findings.find((f) => f.id.endsWith("/4"))!;
    assert.equal(queued.status, "ready", "the rate-limit delay is over");
    assert.match(queued.note ?? "", /rate limit/);
    assert.equal(r.findings.find((f) => f.id.endsWith("/3")), undefined, "spoofed manager");
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
    assert.equal(sourcesFor("evm").length, 33);
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
