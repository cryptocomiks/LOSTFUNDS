import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { secp256k1 } from "@noble/curves/secp256k1";
import { base64 } from "@scure/base";
import {
  concat,
  decodeFunctionData,
  encodeFunctionData,
  encodePacked,
  hashMessage,
  hexToBytes,
  hexToNumber,
  keccak256,
  pad,
  parseAbi,
  parseAbiItem,
  recoverAddress,
  size,
  slice,
  toEventSelector,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount, publicKeyToAddress } from "viem/accounts";
import { checkCeler, decodeWithdrawMsg, withdrawId } from "../src/lib/checks/celer.ts";
import { checkGnosisBridge, packSignatures, parseAmbMessage } from "../src/lib/checks/gnosis.ts";
import { MockChain } from "./mockchain.ts";
import {
  CELER_REFUND_RECEIVER,
  CELER_REFUND_TRANSFER,
  CELER_REFUND_WDID,
  CELER_WD_ONCHAIN,
  GNOSIS_AMB_MESSAGE,
  GNOSIS_AMB_SIGNATURES,
  XDAI_WITHDRAWAL,
} from "./real-data.ts";

const USER: Address = "0x1111111111111111111111111111111111111111";
const STRANGER: Address = "0x9999999999999999999999999999999999999999";
const NOBODY: Address = "0x7777777777777777777777777777777777777777";
const FRIEND: Address = "0x5555555555555555555555555555555555555555";
const NOW = Math.floor(Date.now() / 1000);
const DAY = 86_400;

const world = new MockChain();
before(() => {
  globalThis.fetch = world.fetch as typeof fetch;
});

/* ───────────────────────── Celer cBridge ───────────────────────── */

const POOL_ETH: Address = "0x5427FEFA711Eff984124bFBB1AB6fbf5E3DA1820";
const WETH: Address = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";

/** Protobuf WithdrawMsg, as cBridge's API returns it (base64). */
function wdOnchain(m: { chainId: bigint; seqnum: bigint; receiver: Address; token: Address; amount: bigint; refId: Hex }): string {
  const out: number[] = [];
  const varint = (x: bigint) => {
    do {
      let b = Number(x & 0x7fn);
      x >>= 7n;
      if (x) b |= 0x80;
      out.push(b);
    } while (x);
  };
  const bytes = (field: number, hex: Hex) => {
    const b = hexToBytes(hex);
    varint(BigInt((field << 3) | 2));
    varint(BigInt(b.length));
    out.push(...b);
  };
  varint(8n); // field 1, varint
  varint(m.chainId);
  varint(16n); // field 2, varint
  varint(m.seqnum);
  bytes(3, m.receiver);
  bytes(4, m.token);
  bytes(5, toHex(m.amount));
  bytes(6, m.refId);
  return base64.encode(Uint8Array.from(out));
}

describe("Celer cBridge", () => {
  test("decodes a real refund message and derives the id the pool records", () => {
    const m = decodeWithdrawMsg(base64.decode(CELER_WD_ONCHAIN))!;
    assert.equal(m.chainId, 1n);
    assert.equal(m.seqnum, 1687823698n);
    assert.equal(m.receiver, CELER_REFUND_RECEIVER);
    assert.equal(m.token, WETH.toLowerCase());
    assert.equal(m.amount, 20_000_000_000_000_000n);
    assert.equal(m.refId, CELER_REFUND_TRANSFER);
    assert.equal(withdrawId(m), CELER_REFUND_WDID);
  });

  test("rejects garbage", () => {
    assert.equal(decodeWithdrawMsg(new Uint8Array([0xff, 0xff])), null);
    assert.equal(decodeWithdrawMsg(new Uint8Array([8, 1])), null, "missing fields");
  });

  const id = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
  const paid = new Set<string>();
  /** Receivers that can't take native ETH (contracts): the pool's payout reverts. */
  const rejectsEth = new Set<string>();

  before(() => {
    const row = (n: number, status: number, o: { src?: number; dst?: number; bridgeType?: number; amount?: bigint; ts?: number } = {}) => ({
      transfer_id: id(n),
      status,
      bridge_type: o.bridgeType ?? 1,
      ts: String((o.ts ?? NOW - 400 * DAY + n) * 1000),
      src_send_info: {
        chain: { id: o.src ?? 1 },
        token: { symbol: "WETH", address: WETH, decimal: 18 },
        amount: String(o.amount ?? 20_000_000_000_000_000n),
      },
      dst_received_info: { chain: { id: o.dst ?? 42161 } },
      src_block_tx_link: `https://etherscan.io/tx/0x${n.toString(16).padStart(2, "0").repeat(32)}`,
    });
    const refund = (n: number, receiver: Address, o: { chainId?: bigint; bridgeType?: number; amount?: bigint } = {}) => {
      world.celer.status[id(n)] = {
        err: null,
        status: 8,
        bridge_type: o.bridgeType ?? 1,
        wd_onchain: wdOnchain({ chainId: o.chainId ?? 1n, seqnum: BigInt(1000 + n), receiver, token: WETH, amount: o.amount ?? 20_000_000_000_000_000n, refId: id(n) }),
        sorted_sigs: [base64.encode(new Uint8Array(65).fill(1))],
        signers: [base64.encode(new Uint8Array(20).fill(2))],
        powers: [base64.encode(new Uint8Array([1, 0]))],
      };
    };
    world.celer.history[USER.toLowerCase()] = [
      row(1, 7), // history still says "requesting", the status endpoint says the refund is ready
      row(2, 8), // refund already paid on-chain (the API is stale)
      row(3, 5), // completed
      row(4, 10), // refunded
      row(5, 8), // refund paid to someone else
      row(6, 8), // refund the pool can't pay out (receiver rejects ETH)
      row(7, 11), // delayed: executed long ago in practice, nothing to do
      row(8, 8, { src: 288, dst: 1 }), // Boba: pool not checked, skipped
      row(9, 8, { bridgeType: 2 }), // pegged-token bridge: not double-checked, skipped
      // 60 older completed transfers, to go through several pages
      ...Array.from({ length: 60 }, (_, i) => row(100 + i, 5, { ts: NOW - 900 * DAY + i })),
    ];
    refund(1, USER);
    refund(2, USER);
    refund(5, STRANGER);
    refund(6, USER, { amount: 7n });
    refund(8, USER, { chainId: 288n });
    refund(9, USER, { bridgeType: 2 });
    const statusOf = (n: number) => world.celer.status[id(n)] as { wd_onchain: string };
    paid.add(withdrawId(decodeWithdrawMsg(base64.decode(statusOf(2).wd_onchain))!));
    rejectsEth.add(withdrawId(decodeWithdrawMsg(base64.decode(statusOf(6).wd_onchain))!));

    world.addContract(
      1,
      POOL_ETH,
      parseAbi(["function withdraws(bytes32) view returns (bool)", "function withdraw(bytes _wdmsg, bytes[] _sigs, address[] _signers, uint256[] _powers)"]),
      {
        withdraws: ([wd]) => paid.has(wd as string),
        withdraw: ([msg]) => {
          const wd = withdrawId(decodeWithdrawMsg(hexToBytes(msg as Hex))!);
          if (paid.has(wd)) throw new Error("withdraw already succeeded");
          if (rejectsEth.has(wd)) throw new Error("failed to send native token");
        },
      },
    );
  });

  test("finds a refund never collected, double-checked on the source chain", async () => {
    const r = await checkCeler(USER);
    assert.equal(r.findings.length, 1);
    const f = r.findings[0];
    assert.equal(f.status, "ready");
    assert.equal(f.networkName, "cBridge · Ethereum → Arbitrum");
    assert.equal(f.asset.symbol, "WETH");
    assert.equal(f.asset.amount, 20_000_000_000_000_000n);
    assert.equal(f.asset.priceKey, `ethereum:${WETH.toLowerCase()}`);
    assert.equal(f.txUrl, `https://etherscan.io/tx/0x${"01".repeat(32)}`);
    assert.match(f.note ?? "", /never collected/);
  });

  test("counts completed transfers and refunds paid on-chain, on every page", async () => {
    const r = await checkCeler(USER);
    // #2 (paid on-chain), #3, #4 and the 60 older ones
    assert.equal(r.completed, 63);
  });

  test("another address sees nothing", async () => {
    assert.deepEqual(await checkCeler(STRANGER), { findings: [], completed: 0 });
  });
});

/* ───────────────────────── Gnosis Bridge ───────────────────────── */

const HOME_MEDIATOR: Address = "0xf6A78083ca3e2a662D6dd1703c939c8aCE2e268d";
const FOREIGN_MEDIATOR: Address = "0x88ad09518695c6c3712AC10a214bE5109a655671";
const HOME_AMB: Address = "0x75Df5AF045d91108662D8080fD1FEFAd6aA0bb59";
const FOREIGN_AMB: Address = "0x4C36d2919e407f0Cc2Ee3c993ccF8ac26d9CE64e";
const XDAI_HOME: Address = "0x7301CFA0e1756B71869E93d4e4Dca5c7d0eb0AA6";
const XDAI_FOREIGN: Address = "0x4aa42145Aa6Ebf72e164C9bBC74fbD3788045016";
const VALIDATORS: Address = "0xed84a648b3c51432ad0fD1C2cD2C45677E9d4064";
const GNOSIS_USDC: Address = "0xDDAfbb505ad214D7b80b1f830fcCc89B60fb7A83";
const ETH_USDC: Address = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const DAI: Address = "0x6B175474E89094C44Da98b954EedeAC495271d0F";

const TOKENS_BRIDGING_INITIATED = parseAbiItem(
  "event TokensBridgingInitiated(address indexed token, address indexed sender, uint256 value, bytes32 indexed messageId)",
);
const AMB_REQUEST = parseAbiItem("event UserRequestForSignature(bytes32 indexed messageId, bytes encodedData)");
const XDAI_REQUEST = parseAbiItem("event UserRequestForSignature(address recipient, uint256 value, bytes32 nonce, address token)");
const mediatorAbi = parseAbi(["function handleNativeTokens(address token, address receiver, uint256 value)"]);

/** Signers recovered the way the bridge contracts do it: only the first `required` signatures count. */
function signersOf(message: Hex, packed: Hex, required: number): Address[] {
  const n = hexToNumber(slice(packed, 0, 1));
  const digest = hashMessage({ raw: message });
  return Array.from({ length: Math.min(required, n) }, (_, i) => {
    const v = hexToNumber(slice(packed, 1 + i, 2 + i));
    // Layout: [count][v × count][r × count][s × count]
    const r = slice(packed, 1 + n + 32 * i, 1 + n + 32 * (i + 1));
    const s = slice(packed, 1 + n + 32 * n + 32 * i, 1 + n + 32 * n + 32 * (i + 1));
    const sig = secp256k1.Signature.fromCompact(concat([r, s]).slice(2)).addRecoveryBit(v - 27);
    return publicKeyToAddress(`0x${sig.recoverPublicKey(digest.slice(2)).toHex(false)}`);
  });
}

describe("Gnosis Bridge", () => {
  test("event signatures match the deployed contracts", () => {
    assert.equal(toEventSelector(TOKENS_BRIDGING_INITIATED), "0x59a9a8027b9c87b961e254899821c9a276b5efc35d1f7409ea4f291470f1629a");
    assert.equal(toEventSelector(AMB_REQUEST), "0x520d2afde79cbd5db58755ac9480f81bc658e5c517fcae7365a3d832590b0183");
    assert.equal(toEventSelector(XDAI_REQUEST), "0xe1e0bc4a1db39a361e3589cae613d7b4862e1f9114dd3ff12ff45be395046968");
  });

  test("parses a real OmniBridge message and packs its real signatures", async () => {
    const m = parseAmbMessage(GNOSIS_AMB_MESSAGE)!;
    assert.equal(m.messageId, "0x00050000a7823d6f1e31569f51861e345b30c6bebf70ebe7000000000001ed39");
    assert.equal(m.sender, HOME_MEDIATOR.toLowerCase());
    assert.equal(m.executor, FOREIGN_MEDIATOR.toLowerCase());
    assert.equal(m.destinationChain, 1n);
    const call = decodeFunctionData({ abi: mediatorAbi, data: m.data });
    assert.deepEqual(call.args, [ETH_USDC, "0x32248CB2c05ce6EeEB17649b61E6338052b30AFe", 14963524n]);
    const sigs = GNOSIS_AMB_SIGNATURES.map(([s]) => s as Hex);
    for (const [s, signer] of GNOSIS_AMB_SIGNATURES)
      assert.equal(await recoverAddress({ hash: hashMessage({ raw: GNOSIS_AMB_MESSAGE }), signature: s as Hex }), signer);
    // Read back the way the Ethereum contract reads the packed blob.
    assert.deepEqual(signersOf(GNOSIS_AMB_MESSAGE, packSignatures(sigs), 4), GNOSIS_AMB_SIGNATURES.map(([, a]) => a));
  });

  test("rebuilds the message the validators signed for a real xDAI withdrawal", async () => {
    const w = XDAI_WITHDRAWAL;
    const message = encodePacked(["address", "uint256", "bytes32", "address", "address"], [w.recipient, w.value, w.nonce, XDAI_FOREIGN, w.token]);
    assert.equal(size(message), 124);
    assert.equal(await recoverAddress({ hash: hashMessage({ raw: message }), signature: w.signature }), w.signer);
  });

  // Validators: two current ones, one who has been replaced.
  const [v1, v2, old] = ["0x" + "a1".repeat(32), "0x" + "a2".repeat(32), "0x" + "a3".repeat(32)].map((k) => privateKeyToAccount(k as Hex));
  const current = new Set([v1.address, v2.address]);
  const REQUIRED = 2;
  const signatures = new Map<Hex, Hex[]>(); // keccak256(message) → signatures stored on Gnosis
  const finalized = new Set<Hex>();
  const relayed = new Set<Hex>(); // executed on Ethereum (AMB message ids / xDAI nonces)

  const sign = async (message: Hex, by: typeof v1[]) => {
    signatures.set(keccak256(message), await Promise.all(by.map((a) => a.signMessage({ message: { raw: message } }))));
    if (by.length >= REQUIRED) finalized.add(keccak256(message));
  };
  /** executeSignatures as the contracts do it: the first `required` signatures must come from current validators. */
  const execute = (id: (m: Hex) => Hex) => ([message, packed]: readonly unknown[]) => {
    const signers = signersOf(message as Hex, packed as Hex, REQUIRED);
    if (signers.length < REQUIRED || !signers.every((a) => current.has(a))) throw new Error("invalid signatures");
    if (relayed.has(id(message as Hex))) throw new Error("already relayed");
  };

  let block = 48_000_000n;
  const omni = async (p: { hash: Hex; sender: Address; receiver?: Address; value: bigint; age: number; signers: typeof v1[]; claimed?: boolean }) => {
    const messageId = keccak256(p.hash);
    const message = concat([
      messageId,
      HOME_MEDIATOR,
      FOREIGN_MEDIATOR,
      "0x000927c0", // gas limit
      "0x01", // source chain id length
      "0x01", // destination chain id length
      "0x80", // data type
      "0x64", // Gnosis
      "0x01", // Ethereum
      encodeFunctionData({ abi: mediatorAbi, functionName: "handleNativeTokens", args: [ETH_USDC, p.receiver ?? p.sender, p.value] }),
    ]);
    world.addTx({
      chainId: 100,
      hash: p.hash,
      from: p.sender,
      to: HOME_MEDIATOR,
      blockNumber: block++,
      timestamp: NOW - p.age,
      logs: [
        { address: HOME_MEDIATOR, event: TOKENS_BRIDGING_INITIATED, args: { token: GNOSIS_USDC, sender: p.sender, value: p.value, messageId } },
        { address: HOME_AMB, event: AMB_REQUEST, args: { messageId, encodedData: message } },
      ],
    });
    await sign(message, p.signers);
    if (p.claimed) relayed.add(messageId);
  };
  const xdai = async (p: { hash: Hex; recipient: Address; value: bigint; nonce: number; signers: typeof v1[]; claimed?: boolean }) => {
    const nonce = pad(toHex(p.nonce), { size: 32 });
    world.addTx({
      chainId: 100,
      hash: p.hash,
      from: p.recipient,
      to: XDAI_HOME,
      blockNumber: block++,
      timestamp: NOW - 30 * DAY,
      logs: [{ address: XDAI_HOME, event: XDAI_REQUEST, args: { recipient: p.recipient, value: p.value, nonce, token: DAI } }],
    });
    await sign(encodePacked(["address", "uint256", "bytes32", "address", "address"], [p.recipient, p.value, nonce, XDAI_FOREIGN, DAI]), p.signers);
    if (p.claimed) relayed.add(nonce);
  };

  before(async () => {
    const home = parseAbi(["function numMessagesSigned(bytes32) view returns (uint256)", "function signature(bytes32, uint256) view returns (bytes)"]);
    const homeFns = {
      numMessagesSigned: ([h]: readonly unknown[]) => BigInt(signatures.get(h as Hex)?.length ?? 0) | (finalized.has(h as Hex) ? 1n << 255n : 0n),
      signature: ([h, i]: readonly unknown[]) => signatures.get(h as Hex)![Number(i)],
    };
    world.addContract(100, HOME_AMB, home, homeFns);
    world.addContract(100, XDAI_HOME, home, homeFns);
    world.addContract(100, GNOSIS_USDC, parseAbi(["function decimals() view returns (uint8)", "function symbol() view returns (string)"]), {
      decimals: () => 6,
      symbol: () => "USDC",
    });
    const foreign = parseAbi([
      "function relayedMessages(bytes32) view returns (bool)",
      "function executeSignatures(bytes message, bytes signatures)",
      "function validatorContract() view returns (address)",
    ]);
    world.addContract(1, FOREIGN_AMB, foreign, {
      relayedMessages: ([id]) => relayed.has(id as Hex),
      executeSignatures: execute((m) => slice(m, 0, 32)),
      validatorContract: () => VALIDATORS,
    });
    world.addContract(1, XDAI_FOREIGN, foreign, {
      relayedMessages: ([nonce]) => relayed.has(nonce as Hex),
      executeSignatures: execute((m) => slice(m, 52, 84)),
      validatorContract: () => VALIDATORS,
    });
    world.addContract(1, VALIDATORS, parseAbi(["function requiredSignatures() view returns (uint256)", "function isValidator(address) view returns (bool)"]), {
      requiredSignatures: () => BigInt(REQUIRED),
      isValidator: ([a]) => current.has(a as Address),
    });

    const h = (n: number) => `0x${n.toString(16).padStart(2, "0").repeat(32)}` as Hex;
    await omni({ hash: h(1), sender: USER, value: 25_000_000n, age: 5 * DAY, signers: [v1, v2] }); // claimable
    await omni({ hash: h(2), sender: USER, value: 3_000_000n, age: 60 * DAY, signers: [v1, v2], claimed: true });
    await omni({ hash: h(3), sender: USER, value: 2_410_000n, age: 80 * DAY, signers: [v1, old] }); // stranded
    await omni({ hash: h(4), sender: USER, value: 5_000_000n, age: 3600, signers: [v1] }); // still being signed
    await omni({ hash: h(5), sender: USER, receiver: FRIEND, value: 7_000_000n, age: 2 * DAY, signers: [v2, v1] }); // to a friend
    await omni({ hash: h(6), sender: STRANGER, value: 9_000_000n, age: 2 * DAY, signers: [v1, v2] });
    await xdai({ hash: h(7), recipient: USER, value: 1260n * 10n ** 18n, nonce: 1, signers: [v1, v2] }); // claimable
    await xdai({ hash: h(8), recipient: USER, value: 10n ** 19n, nonce: 2, signers: [v1, v2], claimed: true });
    await xdai({ hash: h(9), recipient: STRANGER, value: 17n * 10n ** 18n, nonce: 3, signers: [old, v1] }); // stranded
  });

  test("finds Gnosis → Ethereum transfers never claimed, and whether they can be claimed now", async () => {
    const r = await checkGnosisBridge(USER);
    assert.equal(r.completed, 2, "one OmniBridge transfer and one xDAI withdrawal were claimed");
    const by = Object.fromEntries(r.findings.map((f) => [`${f.networkName} ${f.asset.amount}`, f]));
    assert.deepEqual(Object.keys(by).sort(), [
      "OmniBridge · Gnosis → Ethereum 2410000",
      "OmniBridge · Gnosis → Ethereum 25000000",
      "OmniBridge · Gnosis → Ethereum 5000000",
      "OmniBridge · Gnosis → Ethereum 7000000",
      "xDAI bridge · Gnosis → Ethereum 1260000000000000000000",
    ]);

    const ready = by["OmniBridge · Gnosis → Ethereum 25000000"];
    assert.equal(ready.status, "ready");
    assert.equal(ready.asset.symbol, "USDC");
    assert.equal(ready.asset.decimals, 6);
    assert.equal(ready.asset.priceKey, `xdai:${GNOSIS_USDC.toLowerCase()}`);
    assert.equal(ready.txUrl, `https://gnosisscan.io/tx/0x${"01".repeat(32)}`);
    assert.match(ready.note ?? "", /soon/);

    const stranded = by["OmniBridge · Gnosis → Ethereum 2410000"];
    assert.equal(stranded.status, "manual", "signed by a replaced validator: can't be claimed from the app");
    assert.match(stranded.note ?? "", /replaced/);

    assert.equal(by["OmniBridge · Gnosis → Ethereum 5000000"].status, "recent", "validators still signing");

    const toFriend = by["OmniBridge · Gnosis → Ethereum 7000000"];
    assert.equal(toFriend.status, "ready");
    assert.match(toFriend.note ?? "", new RegExp(FRIEND));

    const xdai = by["xDAI bridge · Gnosis → Ethereum 1260000000000000000000"];
    assert.equal(xdai.status, "ready");
    assert.equal(xdai.asset.symbol, "DAI");
    assert.equal(xdai.asset.priceKey, "coingecko:dai");
  });

  test("only shows the transfers the address sent (OmniBridge) or receives (xDAI bridge)", async () => {
    const r = await checkGnosisBridge(STRANGER);
    assert.deepEqual(r.findings.map((f) => [f.networkName, f.asset.amount, f.status]).sort(), [
      ["OmniBridge · Gnosis → Ethereum", 9_000_000n, "ready"],
      ["xDAI bridge · Gnosis → Ethereum", 17n * 10n ** 18n, "manual"],
    ]);
    assert.deepEqual(await checkGnosisBridge(NOBODY), { findings: [], completed: 0 });
  });
});
