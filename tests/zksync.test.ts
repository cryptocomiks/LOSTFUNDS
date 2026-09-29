import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import {
  concat,
  encodeAbiParameters,
  encodePacked,
  keccak256,
  numberToHex,
  pad,
  parseAbi,
  parseAbiItem,
  parseEther,
  parseUnits,
  type Address,
  type Hex,
} from "viem";
import { checkNetwork } from "../src/lib/checker.ts";
import { decodeMessage } from "../src/lib/checks/zksync.ts";
import { networkById } from "../src/lib/networks.ts";
import { MockChain, MockRevertData } from "./mockchain.ts";

const USER: Address = "0x1111111111111111111111111111111111111111";
const OTHER: Address = "0x2222222222222222222222222222222222222222";
const DAY = 86_400;
const now = Math.floor(Date.now() / 1000);
const h = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;

// L2 system contracts
const BASE_TOKEN: Address = "0x000000000000000000000000000000000000800A";
const ASSET_ROUTER: Address = "0x0000000000000000000000000000000000010003";
const MESSENGER: Address = "0x0000000000000000000000000000000000008008";
const ERA_LEGACY_BRIDGE: Address = "0x11f943b2c77b743AB90f4A0Ae7d5A4e7FCA3E102";
// Ethereum
const NULLIFIER: Address = "0xD7f9f54194C633F36CCD5F3da84ad4a1c38cB2cB";
const NTV: Address = "0xbeD1EB542f9a5aA6419Ff3deb921A372681111f6";
const ERA_DIAMOND: Address = "0x32400084C286CF3E17e7B677ea9583e60a000324";
const ERA_L1_ERC20_BRIDGE: Address = "0x57891966931Eb4Bb6FB81430E6cE0A03AAbDe063";
const SOPHON_DIAMOND: Address = "0x05eDE6aD1f39B7A16C949d5C33a0658c9C7241e3";
const USDC_L1: Address = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const TRALA_L1: Address = "0xD5e0eda0214f1d05af466E483d9376a77A67448b";
const SOPH_L1: Address = "0x6B7774CB12ed7573a7586E7D0e62a2A563dDd3f0";
const USDC_ASSET_ID = h(0x05dc);

const ALREADY_FINALIZED: Hex = "0xae899454";
const INVALID_PROOF: Hex = "0x09bde339";

const ev = {
  withdrawal: parseAbiItem("event Withdrawal(address indexed _l2Sender, address indexed _l1Receiver, uint256 _amount)"),
  initiated: parseAbiItem(
    "event WithdrawalInitiated(address indexed l2Sender, address indexed l1Receiver, address indexed l2Token, uint256 amount)",
  ),
  initiatedAssetRouter: parseAbiItem(
    "event WithdrawalInitiatedAssetRouter(uint256 chainId, address indexed l2Sender, bytes32 indexed assetId, bytes assetData)",
  ),
  l1MessageSent: parseAbiItem("event L1MessageSent(address indexed _sender, bytes32 indexed _hash, bytes _message)"),
};

const msg = {
  base: (to: Address, amount: bigint) => encodePacked(["bytes4", "address", "uint256"], ["0x6c0960f9", to, amount]),
  legacy: (to: Address, l1Token: Address, amount: bigint) =>
    encodePacked(["bytes4", "address", "address", "uint256"], ["0x11a2ccc1", to, l1Token, amount]),
  router: (chainId: number, assetId: Hex, caller: Address, to: Address, originToken: Address, amount: bigint) =>
    concat([
      "0x9c884fd1",
      numberToHex(chainId, { size: 32 }),
      assetId,
      encodeAbiParameters(
        [{ type: "address" }, { type: "address" }, { type: "address" }, { type: "uint256" }, { type: "bytes" }],
        [caller, to, originToken, amount, "0x"],
      ),
    ]),
};

/** What the L1 contracts know. Keys: `${chainId}:${batch}:${index}`. */
const l1 = {
  finalized: new Set<string>(), // L1Nullifier
  eraLegacyEth: new Set<string>(), // Era diamond, pre-2024
  eraLegacyTokens: new Set<string>(), // L1ERC20Bridge, pre-2024
  badProof: new Set<string>(),
  /** finalizeDeposit dry runs, by chain id. */
  simulations: new Map<bigint, number>(),
  /** Which L2 contract sent each message: the proof only verifies with the right sender. */
  sender: new Map<string, string>(),
};

const world = new MockChain();

/** A withdrawal tx: the bridge's event, the L1Messenger's message and the receipt's L2→L1 log. */
function addWithdrawal(p: {
  chainId: number;
  n: number;
  from: Address;
  daysAgo: number;
  bridge: Address;
  event: { address: Address; event: (typeof ev)[keyof typeof ev]; args: Record<string, unknown> };
  message: Hex;
  /** null: batch not sealed yet */
  batch: bigint | null;
  /** index in the batch's L2→L1 log tree; null: no proof yet */
  id?: number | null;
  /** L2→L1 log key, when it's not the bridge itself (a contract that isn't a bridge) */
  key?: Address;
}) {
  const hash = h(p.chainId * 1000 + p.n);
  const id = p.id === undefined ? p.n : p.id;
  world.addTx({
    chainId: p.chainId,
    hash,
    from: p.from,
    to: p.bridge,
    blockNumber: BigInt(1_000_000 + p.n),
    timestamp: now - p.daysAgo * DAY,
    logs: [
      p.event,
      { address: MESSENGER, event: ev.l1MessageSent, args: { _sender: p.key ?? p.bridge, _hash: keccak256(p.message), _message: p.message } },
    ],
    zk: {
      l1BatchNumber: p.batch,
      l1BatchTxIndex: 7,
      l2ToL1Logs: [{ sender: MESSENGER, key: pad(p.key ?? p.bridge), value: keccak256(p.message) }],
      proofs: [id === null ? null : { id, proof: [h(id), h(id + 1)] }],
    },
  });
  if (p.batch !== null && id !== null) l1.sender.set(`${p.chainId}:${p.batch}:${id}`, (p.key ?? p.bridge).toLowerCase());
  return { hash, key: `${p.chainId}:${p.batch}:${id}` };
}

const ERA = 324;
const SOPHON = 50104;

function buildWorld() {
  world.prices = {
    "coingecko:ethereum": 3000,
    [`ethereum:${USDC_L1.toLowerCase()}`]: 1,
    [`ethereum:${SOPH_L1.toLowerCase()}`]: 0.004,
  };
  const eth = (from: Address, to: Address, amount: bigint) => ({
    address: BASE_TOKEN,
    event: ev.withdrawal,
    args: { _l2Sender: from, _l1Receiver: to, _amount: amount },
  });

  // ───── ZKsync Era ─────
  // 2023, finalized through the Era diamond before the shared bridge: only its own mapping knows.
  const legacyEth = addWithdrawal({ chainId: ERA, n: 1, from: USER, daysAgo: 800, bridge: BASE_TOKEN, event: eth(USER, USER, parseEther("1")), message: msg.base(USER, parseEther("1")), batch: 300_000n });
  l1.eraLegacyEth.add(legacyEth.key);
  // 2025, finalized: the L1Nullifier knows.
  const finalized = addWithdrawal({ chainId: ERA, n: 2, from: USER, daysAgo: 300, bridge: BASE_TOKEN, event: eth(USER, USER, parseEther("2")), message: msg.base(USER, parseEther("2")), batch: 500_000n });
  l1.finalized.add(finalized.key);
  // 60 days ago, never finalized: ready.
  addWithdrawal({ chainId: ERA, n: 3, from: USER, daysAgo: 60, bridge: BASE_TOKEN, event: eth(USER, USER, parseEther("0.75")), message: msg.base(USER, parseEther("0.75")), batch: 505_000n });
  // A few hours ago, batch not sealed yet: recent.
  addWithdrawal({ chainId: ERA, n: 4, from: USER, daysAgo: 0.1, bridge: BASE_TOKEN, event: eth(USER, USER, parseEther("0.3")), message: msg.base(USER, parseEther("0.3")), batch: null });
  // 2 days ago, batch committed but not executed on Ethereum yet: recent.
  addWithdrawal({ chainId: ERA, n: 5, from: USER, daysAgo: 2, bridge: BASE_TOKEN, event: eth(USER, USER, parseEther("0.2")), message: msg.base(USER, parseEther("0.2")), batch: 510_500n });
  // 2,500 USDC through the asset router, 30 days ago, never finalized: ready.
  addWithdrawal({
    chainId: ERA,
    n: 6,
    from: USER,
    daysAgo: 30,
    bridge: ASSET_ROUTER,
    event: { address: ASSET_ROUTER, event: ev.initiatedAssetRouter, args: { chainId: 1n, l2Sender: USER, assetId: USDC_ASSET_ID, assetData: "0x" } },
    message: msg.router(ERA, USDC_ASSET_ID, USER, USER, USDC_L1, parseUnits("2500", 6)),
    batch: 506_000n,
  });
  // 2023 token withdrawal finalized through the old L1ERC20Bridge.
  const legacyToken = addWithdrawal({
    chainId: ERA,
    n: 7,
    from: USER,
    daysAgo: 700,
    bridge: ERA_LEGACY_BRIDGE,
    event: { address: ERA_LEGACY_BRIDGE, event: ev.initiated, args: { l2Sender: USER, l1Receiver: USER, l2Token: OTHER, amount: 300n } },
    message: msg.legacy(USER, TRALA_L1, parseEther("300")),
    batch: 200_000n,
  });
  l1.eraLegacyTokens.add(legacyToken.key);
  // Mentions the user, but its L2→L1 message wasn't sent by a bridge: not a withdrawal.
  addWithdrawal({ chainId: ERA, n: 8, from: OTHER, daysAgo: 40, bridge: BASE_TOKEN, key: OTHER, event: eth(OTHER, USER, parseEther("9")), message: msg.base(USER, parseEther("9")), batch: 505_100n });
  // Sent by the user to another address, never finalized: ready, with a note.
  addWithdrawal({ chainId: ERA, n: 9, from: USER, daysAgo: 20, bridge: BASE_TOKEN, event: eth(USER, OTHER, parseEther("0.5")), message: msg.base(OTHER, parseEther("0.5")), batch: 507_000n });
  // A claim the bridge rejects: manual.
  const bad = addWithdrawal({ chainId: ERA, n: 10, from: USER, daysAgo: 90, bridge: BASE_TOKEN, event: eth(USER, USER, parseEther("0.1")), message: msg.base(USER, parseEther("0.1")), batch: 504_000n });
  l1.badProof.add(bad.key);
  // Someone else's withdrawal: never looked at.
  addWithdrawal({ chainId: ERA, n: 11, from: OTHER, daysAgo: 50, bridge: BASE_TOKEN, event: eth(OTHER, OTHER, parseEther("5")), message: msg.base(OTHER, parseEther("5")), batch: 505_200n });

  // ───── Sophon (base token SOPH) ─────
  addWithdrawal({ chainId: SOPHON, n: 1, from: USER, daysAgo: 45, bridge: BASE_TOKEN, event: eth(USER, USER, parseEther("4000")), message: msg.base(USER, parseEther("4000")), batch: 30_000n });
  // Batch committed 10 days ago and still not executed on Ethereum: waiting.
  addWithdrawal({ chainId: SOPHON, n: 2, from: USER, daysAgo: 10, bridge: BASE_TOKEN, event: eth(USER, USER, parseEther("50")), message: msg.base(USER, parseEther("50")), batch: 45_000n });

  // ───── Ethereum ─────
  const key = (chainId: bigint, batch: bigint, id: bigint) => `${chainId}:${batch}:${id}`;
  world.addContract(
    1,
    NULLIFIER,
    parseAbi([
      "function isWithdrawalFinalized(uint256 chainId, uint256 l2BatchNumber, uint256 l2ToL1MessageNumber) view returns (bool)",
      "struct FinalizeL1DepositParams { uint256 chainId; uint256 l2BatchNumber; uint256 l2MessageIndex; address l2Sender; uint16 l2TxNumberInBatch; bytes message; bytes32[] merkleProof; }",
      "function finalizeDeposit(FinalizeL1DepositParams params)",
    ]),
    {
      isWithdrawalFinalized: ([c, b, i]) => l1.finalized.has(key(c as bigint, b as bigint, i as bigint)),
      finalizeDeposit: ([p]) => {
        const { chainId, l2BatchNumber, l2MessageIndex, l2Sender, l2TxNumberInBatch } = p as {
          chainId: bigint;
          l2BatchNumber: bigint;
          l2MessageIndex: bigint;
          l2Sender: Address;
          l2TxNumberInBatch: number;
        };
        l1.simulations.set(chainId, (l1.simulations.get(chainId) ?? 0) + 1);
        const k = key(chainId, l2BatchNumber, l2MessageIndex);
        const eraK = `${l2BatchNumber}:${l2MessageIndex}`;
        if (l1.finalized.has(k) || l1.eraLegacyEth.has(eraK) || l1.eraLegacyTokens.has(eraK)) throw new MockRevertData(ALREADY_FINALIZED);
        if (l1.badProof.has(k) || l1.sender.get(k) !== l2Sender.toLowerCase() || l2TxNumberInBatch !== 7) throw new MockRevertData(INVALID_PROOF);
      },
    },
  );
  world.addContract(
    1,
    ERA_DIAMOND,
    parseAbi([
      "function isEthWithdrawalFinalized(uint256 l2BatchNumber, uint256 l2MessageIndex) view returns (bool)",
      "function getTotalBatchesExecuted() view returns (uint256)",
    ]),
    {
      isEthWithdrawalFinalized: ([b, i]) => l1.eraLegacyEth.has(key(BigInt(ERA), b as bigint, i as bigint)),
      getTotalBatchesExecuted: () => 510_000n,
    },
  );
  world.addContract(1, ERA_L1_ERC20_BRIDGE, parseAbi(["function isWithdrawalFinalized(uint256, uint256) view returns (bool)"]), {
    isWithdrawalFinalized: ([b, i]) => l1.eraLegacyTokens.has(key(BigInt(ERA), b as bigint, i as bigint)),
  });
  world.addContract(1, SOPHON_DIAMOND, parseAbi(["function getTotalBatchesExecuted() view returns (uint256)"]), {
    getTotalBatchesExecuted: () => 40_000n,
  });
  world.addContract(1, NTV, parseAbi(["function tokenAddress(bytes32) view returns (address)"]), {
    tokenAddress: ([id]) => (id === USDC_ASSET_ID ? USDC_L1 : "0x0000000000000000000000000000000000000000"),
  });
  const erc20 = parseAbi(["function decimals() view returns (uint8)", "function symbol() view returns (string)"]);
  world.addContract(1, USDC_L1, erc20, { decimals: () => 6, symbol: () => "USDC" });
  world.addContract(1, TRALA_L1, erc20, { decimals: () => 18, symbol: () => "TRALA" });
  world.addContract(1, SOPH_L1, erc20, { decimals: () => 18, symbol: () => "SOPH" });
}

// The legacy mappings are keyed by (batch, index) only; mirror them for the finalizeDeposit mock.
function mirrorLegacyKeys() {
  for (const s of [l1.eraLegacyEth, l1.eraLegacyTokens]) for (const k of [...s]) s.add(k.split(":").slice(1).join(":"));
}

before(() => {
  buildWorld();
  mirrorLegacyKeys();
  globalThis.fetch = world.fetch as typeof fetch;
});

/** Each network is checked once; the tests look at different parts of the result. */
const results = new Map<string, ReturnType<typeof checkNetwork>>();
const run = (id: string) => {
  if (!results.has(id)) results.set(id, checkNetwork(networkById(id)!, USER));
  return results.get(id)!;
};

describe("ZKsync Era", () => {
  test("counts finalized withdrawals as completed, including pre-2024 ones only the old contracts know", async () => {
    const r = await run("zksync");
    assert.equal(r.state, "done", r.error ?? "");
    // 2023 ETH (diamond), 2025 ETH (Nullifier), 2023 token (L1ERC20Bridge)
    assert.equal(r.completed, 3);
    // Recognized from the L1 records, before any dry run: only the 4 executed, unfinalized ones are simulated.
    assert.equal(l1.simulations.get(BigInt(ERA)), 4);
    const amounts = r.findings.map((f) => f.asset.amount);
    for (const done of [parseEther("1"), parseEther("2"), parseEther("300")]) assert.ok(!amounts.includes(done));
  });

  test("reports unfinalized withdrawals with the right status", async () => {
    const r = await run("zksync");
    const by = (amount: bigint) => r.findings.find((f) => f.asset.amount === amount);

    const ready = by(parseEther("0.75"))!;
    assert.equal(ready.status, "ready");
    assert.equal(ready.asset.symbol, "ETH");
    assert.equal(ready.asset.usd, 2250);
    assert.equal(ready.guideId, "zksync");
    assert.match(ready.txUrl, /^https:\/\/explorer\.zksync\.io\/tx\/0x/);

    assert.equal(by(parseEther("0.3"))!.status, "recent", "batch not sealed yet");
    assert.equal(by(parseEther("0.2"))!.status, "recent", "batch not executed on Ethereum yet");

    const manual = by(parseEther("0.1"))!;
    assert.equal(manual.status, "manual");
    assert.match(manual.note ?? "", /dry run/);
  });

  test("asset router token withdrawals show the L1 token and its decimals", async () => {
    const r = await run("zksync");
    const usdc = r.findings.find((f) => f.asset.symbol === "USDC")!;
    assert.equal(usdc.status, "ready", "the claim is simulated with the asset router as the L2 sender");
    assert.equal(usdc.asset.amount, parseUnits("2500", 6));
    assert.equal(usdc.asset.decimals, 6);
    assert.equal(usdc.asset.token, USDC_L1);
    assert.equal(usdc.asset.usd, 2500);
  });

  test("withdrawals the user sent elsewhere say where the funds go", async () => {
    const r = await run("zksync");
    const f = r.findings.find((x) => x.asset.amount === parseEther("0.5"))!;
    assert.equal(f.status, "ready");
    assert.match(f.note ?? "", /0x2222…2222/);
  });

  test("ignores transactions without a bridge withdrawal, and other people's withdrawals", async () => {
    const r = await run("zksync");
    assert.ok(!r.findings.some((f) => f.asset.amount === parseEther("9")));
    assert.ok(!r.findings.some((f) => f.asset.amount === parseEther("5")));
    assert.equal(r.findings.length, 6);
  });

  test("a wallet with no withdrawals comes back clean", async () => {
    const r = await checkNetwork(networkById("zksync")!, "0x3333333333333333333333333333333333333333");
    assert.equal(r.state, "done", r.error ?? "");
    assert.deepEqual([r.findings.length, r.completed], [0, 0]);
  });
});

describe("Sophon", () => {
  test("base token withdrawals are in SOPH, priced on Ethereum", async () => {
    const r = await run("sophon");
    assert.equal(r.state, "done", r.error ?? "");
    const soph = r.findings.find((f) => f.asset.amount === parseEther("4000"))!;
    assert.equal(soph.status, "ready");
    assert.equal(soph.asset.symbol, "SOPH");
    assert.equal(soph.asset.token, SOPH_L1);
    assert.equal(soph.asset.usd, 16);
    assert.match(soph.txUrl, /^https:\/\/explorer\.sophon\.xyz\/tx\//);
  });

  test("an old withdrawal whose batch isn't executed yet is waiting", async () => {
    const r = await run("sophon");
    const f = r.findings.find((x) => x.asset.amount === parseEther("50"))!;
    assert.equal(f.status, "waiting");
    assert.match(f.note ?? "", /executed on Ethereum/);
  });
});

describe("ZK Stack messages", () => {
  test("decodes the three withdrawal formats", () => {
    assert.deepEqual(decodeMessage(msg.base(USER, 5n)), { kind: "base", receiver: USER, amount: 5n });
    assert.deepEqual(decodeMessage(msg.legacy(USER, USDC_L1, 7n)), { kind: "legacy", receiver: USER, l1Token: USDC_L1, amount: 7n });
    const r = decodeMessage(msg.router(ERA, USDC_ASSET_ID, OTHER, USER, USDC_L1, 9n))!;
    assert.deepEqual(r, { kind: "router", receiver: USER, amount: 9n, assetId: USDC_ASSET_ID, originToken: USDC_L1, sender: OTHER });
    assert.equal(decodeMessage("0xdeadbeef"), null);
  });
});
