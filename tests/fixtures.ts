import { encodeFunctionData, keccak256, parseAbi, parseAbiItem, parseEther, parseUnits, type Address, type Hex } from "viem";
import { MockChain } from "./mockchain.ts";

export const USER: Address = "0x1111111111111111111111111111111111111111";
export const OTHER: Address = "0x2222222222222222222222222222222222222222";
export const USDC_L1: Address = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

const DAY = 86_400;
const now = Math.floor(Date.now() / 1000);
const h = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;

const ev = {
  l2ToL1Tx: parseAbiItem(
    "event L2ToL1Tx(address caller, address indexed destination, uint256 indexed hash, uint256 indexed position, uint256 arbBlockNum, uint256 ethBlockNum, uint256 timestamp, uint256 callvalue, bytes data)",
  ),
  arbWithdrawalInitiated: parseAbiItem(
    "event WithdrawalInitiated(address l1Token, address indexed _from, address indexed _to, uint256 indexed _l2ToL1Id, uint256 _exitNum, uint256 _amount)",
  ),
  scrollSentMessage: parseAbiItem(
    "event SentMessage(address indexed sender, address indexed target, uint256 value, uint256 messageNonce, uint256 gasLimit, bytes message)",
  ),
  withdrawEth: parseAbiItem("event WithdrawETH(address indexed from, address indexed to, uint256 amount, bytes data)"),
  lineaMessageSent: parseAbiItem(
    "event MessageSent(address indexed _from, address indexed _to, uint256 _fee, uint256 _value, uint256 _nonce, bytes _calldata, bytes32 indexed _messageHash)",
  ),
  lineaMessageClaimed: parseAbiItem("event MessageClaimed(bytes32 indexed _messageHash)"),
  opWithdrawalInitiated: parseAbiItem(
    "event WithdrawalInitiated(address indexed l1Token, address indexed l2Token, address indexed from, address to, uint256 amount, bytes extraData)",
  ),
  opLegacySentMessage: parseAbiItem(
    "event SentMessage(address indexed target, address sender, bytes message, uint256 messageNonce, uint256 gasLimit)",
  ),
};

/**
 * A world where USER has:
 *  - Arbitrum One: an unclaimed 1.5 ETH withdrawal, an unclaimed 2,500 USDC withdrawal, one already claimed.
 *  - Scroll: an unclaimed 0.5 ETH withdrawal.
 *  - Linea: one unclaimed 2 ETH withdrawal, one claimed (old format, found via MessageClaimed).
 *  - OP Mainnet: one pre-Bedrock 3 ETH withdrawal never relayed.
 */
export function buildWorld(): MockChain {
  const m = new MockChain();
  m.prices = { "coingecko:ethereum": 3000, [`ethereum:${USDC_L1.toLowerCase()}`]: 1 };

  // ───── Arbitrum One ─────
  const ARB = 42161;
  const ARBSYS: Address = "0x0000000000000000000000000000000000000064";
  const ERC20_GW: Address = "0x09e9222E96E7B4AE2a407B98d48e330053351EEe";
  const OUTBOX: Address = "0x0B9857ae2D4A3DBe74ffE1d7DF045bb7F96E4840";
  const arbMsg = (position: bigint, destination: Address, callvalue: bigint) => ({
    address: ARBSYS,
    event: ev.l2ToL1Tx,
    args: {
      caller: USER,
      destination,
      hash: position * 7n,
      position,
      arbBlockNum: 1n,
      ethBlockNum: 1n,
      timestamp: BigInt(now - 60 * DAY),
      callvalue,
      data: "0x",
    },
  });
  m.addTx({ chainId: ARB, hash: h(0xa1), from: USER, blockNumber: 200_000_000n, timestamp: now - 60 * DAY, logs: [arbMsg(1234n, USER, parseEther("1.5"))] });
  m.addTx({ chainId: ARB, hash: h(0xa2), from: USER, blockNumber: 200_000_001n, timestamp: now - 90 * DAY, logs: [arbMsg(99n, USER, parseEther("4"))] });
  m.addTx({
    chainId: ARB,
    hash: h(0xa3),
    from: USER,
    blockNumber: 200_000_002n,
    timestamp: now - 40 * DAY,
    logs: [
      arbMsg(1500n, "0xa3A7B6F88361F48403514059F1F16C8E78d60EeC", 0n), // to the L1 gateway
      {
        address: ERC20_GW,
        event: ev.arbWithdrawalInitiated,
        args: { l1Token: USDC_L1, _from: USER, _to: USER, _l2ToL1Id: 1500n, _exitNum: 0n, _amount: parseUnits("2500", 6) },
      },
    ],
  });
  m.addContract(1, OUTBOX, parseAbi(["function isSpent(uint256) view returns (bool)"]), {
    isSpent: ([i]) => i === 99n,
  });
  m.addContract(
    1,
    USDC_L1,
    parseAbi(["function decimals() view returns (uint8)", "function symbol() view returns (string)"]),
    { decimals: () => 6, symbol: () => "USDC" },
  );

  // ───── Scroll ─────
  const SCROLL = 534352;
  const ETH_GW: Address = "0x6EA73e05AdC79974B931123675ea8F78FfdacDF0";
  const L2_MESSENGER: Address = "0x781e90f1c8Fc4611c9b7497C3B47F99Ef6969CbC";
  const L1_ETH_GW: Address = "0x7F2b8C31F88B6006c382775eea88297Ec1e3E905";
  const scrollMessage = "0x8eaac8a3" as Hex;
  m.addTx({
    chainId: SCROLL,
    hash: h(0x51),
    from: USER,
    blockNumber: 5_000_000n,
    timestamp: now - 20 * DAY,
    logs: [
      {
        address: L2_MESSENGER,
        event: ev.scrollSentMessage,
        args: { sender: ETH_GW, target: L1_ETH_GW, value: parseEther("0.5"), messageNonce: 7n, gasLimit: 0n, message: scrollMessage },
      },
      { address: ETH_GW, event: ev.withdrawEth, args: { from: USER, to: USER, amount: parseEther("0.5"), data: "0x" } },
    ],
  });
  const scrollHash = keccak256(
    encodeFunctionData({
      abi: parseAbi(["function relayMessage(address,address,uint256,uint256,bytes)"]),
      functionName: "relayMessage",
      args: [ETH_GW, L1_ETH_GW, parseEther("0.5"), 7n, scrollMessage],
    }),
  );
  m.addContract(1, "0x6774Bcbd5ceCeF1336b5300fb5186a12DDD8b367", parseAbi(["function isL2MessageExecuted(bytes32) view returns (bool)"]), {
    isL2MessageExecuted: ([x]) => x !== scrollHash, // only OUR message is unexecuted
  });

  // ───── Linea ─────
  const LINEA = 59144;
  const MSG_SERVICE: Address = "0x508Ca82Df566dCD1B0DE8296e70a96332cD644ec";
  const ROLLUP: Address = "0xd19d4B5d358258f05D7B411E21A1460D11B0876F";
  const lineaMsg = (nonce: bigint, value: bigint, hash: Hex) => ({
    address: MSG_SERVICE,
    event: ev.lineaMessageSent,
    args: { _from: USER, _to: USER, _fee: 0n, _value: value, _nonce: nonce, _calldata: "0x", _messageHash: hash },
  });
  m.addTx({ chainId: LINEA, hash: h(0x11), from: USER, blockNumber: 9_000_000n, timestamp: now - 30 * DAY, logs: [lineaMsg(5n, parseEther("2"), h(0xbeef))] });
  m.addTx({ chainId: LINEA, hash: h(0x12), from: USER, blockNumber: 1_000_000n, timestamp: now - 700 * DAY, logs: [lineaMsg(1n, parseEther("9"), h(0xcafe))] });
  // The old message was claimed through the V1 path: no bitmap entry, but a MessageClaimed event on L1.
  m.addTx({ chainId: 1, hash: h(0xe1), from: OTHER, blockNumber: 19_000_000n, timestamp: now - 690 * DAY, logs: [{ address: ROLLUP, event: ev.lineaMessageClaimed, args: { _messageHash: h(0xcafe) } }] });
  m.addContract(1, ROLLUP, parseAbi(["function isMessageClaimed(uint256) view returns (bool)"]), { isMessageClaimed: () => false });

  // ───── OP Mainnet, pre-Bedrock ─────
  const OP = 10;
  const L2_BRIDGE: Address = "0x4200000000000000000000000000000000000010";
  const OP_L2_MESSENGER: Address = "0x4200000000000000000000000000000000000007";
  m.addTx({
    chainId: OP,
    hash: h(0x0b),
    from: USER,
    blockNumber: 50_000_000n,
    timestamp: now - 1300 * DAY,
    logs: [
      {
        address: L2_BRIDGE,
        event: ev.opWithdrawalInitiated,
        args: {
          l1Token: "0x0000000000000000000000000000000000000000",
          l2Token: "0xDeadDeAddeAddEAddeadDEaDDEAdDeaDDeAD0000",
          from: USER,
          to: USER,
          amount: parseEther("3"),
          extraData: "0x",
        },
      },
      {
        address: OP_L2_MESSENGER,
        event: ev.opLegacySentMessage,
        args: { target: "0x99C9fc46f92E8a1c0deC1b1747d010903E884bE1", sender: L2_BRIDGE, message: "0x1532ec34", messageNonce: 42n, gasLimit: 0n },
      },
    ],
  });
  m.addContract(1, "0x25ace71c97B33Cc4729CF772ae268934F7ab5fA1", parseAbi(["function successfulMessages(bytes32) view returns (bool)"]), {
    successfulMessages: () => false,
  });

  return m;
}
