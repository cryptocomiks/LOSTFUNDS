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
  m.addTx({ chainId: ARB, hash: h(0xa1), from: USER, to: ARBSYS, blockNumber: 200_000_000n, timestamp: now - 60 * DAY, logs: [arbMsg(1234n, USER, parseEther("1.5"))] });
  m.addTx({ chainId: ARB, hash: h(0xa2), from: USER, to: ARBSYS, blockNumber: 200_000_001n, timestamp: now - 90 * DAY, logs: [arbMsg(99n, USER, parseEther("4"))] });
  m.addTx({
    chainId: ARB,
    hash: h(0xa3),
    from: USER,
    to: "0x5288c571Fd7aD117beA99bF60FE0846C4E84F933",
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
    to: "0x4C0926FF5252A435FD19e10ED15e5a249Ba19d79",
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
  m.addTx({ chainId: LINEA, hash: h(0x11), from: USER, to: MSG_SERVICE, blockNumber: 9_000_000n, timestamp: now - 30 * DAY, logs: [lineaMsg(5n, parseEther("2"), h(0xbeef))] });
  m.addTx({ chainId: LINEA, hash: h(0x12), from: USER, to: MSG_SERVICE, blockNumber: 1_000_000n, timestamp: now - 700 * DAY, logs: [lineaMsg(1n, parseEther("9"), h(0xcafe))] });
  // The old message was claimed through the V1 path: no bitmap entry, but a MessageClaimed event on L1.
  m.addTx({ chainId: 1, hash: h(0xe1), from: OTHER, to: ROLLUP, blockNumber: 19_000_000n, timestamp: now - 690 * DAY, logs: [{ address: ROLLUP, event: ev.lineaMessageClaimed, args: { _messageHash: h(0xcafe) } }] });
  m.addContract(1, ROLLUP, parseAbi(["function isMessageClaimed(uint256) view returns (bool)"]), { isMessageClaimed: () => false });

  // ───── OP Mainnet, pre-Bedrock ─────
  const OP = 10;
  const L2_BRIDGE: Address = "0x4200000000000000000000000000000000000010";
  const OP_L2_MESSENGER: Address = "0x4200000000000000000000000000000000000007";
  m.addTx({
    chainId: OP,
    hash: h(0x0b),
    from: USER,
    to: L2_BRIDGE,
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

  // Uniswap 2020 airdrop: USER was eligible and never claimed.
  const uni = "https://raw.githubusercontent.com/Uniswap/mrkl-drop-data-chunks/final/chunks";
  m.static[`${uni}/mapping.json`] = { "0x1100000000000000000000000000000000000000": "0x1200000000000000000000000000000000000000" };
  m.static[`${uni}/0x1100000000000000000000000000000000000000.json`] = {
    [USER]: { index: 3, amount: "0x15af1d78b58c400000", proof: [] },
  };
  m.addContract(1, "0x090D4613473dEE047c3f2706764f49E0821D256e", parseAbi(["function isClaimed(uint256) view returns (bool)"]), {
    isClaimed: () => false,
  });
  m.prices["ethereum:0x1f9840a85d5af5bf1d1762f925bdaddc4201f984"] = 7.5;

  // Old tokens (checks/legacy.ts): USER still holds 1,000 DAO tokens (10 ETH) and 50,000 GNT (50,000 GLM).
  const held: Record<string, Partial<Record<Address, bigint>>> = {
    "0xBB9bc244D798123fDe783fCc1C72d3Bb8C189413": { [USER]: 1000n * 10n ** 16n }, // DAO, 16 decimals
    "0xa74476443119A942dE498590Fe1f2454d7D4aC0d": { [USER]: parseEther("50000") }, // GNT
  };
  const oldTokens = [
    "0xBB9bc244D798123fDe783fCc1C72d3Bb8C189413", // DAO
    "0x5c40eF6f527f4FbA68368774E6130cE6515123f2", // ExtraBalance
    "0x89d24A6b4CcB1B6fAA2625fE562bDD9a23260359", // SAI
    "0xf53AD2c6851052A81B42133467480961B2321C09", // PETH
    "0xC66eA802717bFb9833400264Dd12c2bCeAa34a6d", // MKR (2016)
    "0xE0B7927c4aF23765Cb51314A0E0521A9645F0E2A", // DGD
    "0xdd974D5C2e2928deA5F71b9825b8b646686BD200", // KNCL
    "0xECF8F87f810EcF450940c9f60066b4a7a501d6A7", // W-ETH (2016)
    "0x2956356cD2a2bf3202F771F50D3D14A367b48070", // 0x WETH (2017)
    "0xD76b5c2A23ef78368d8E34288B5b65D616B746aE", // Bancor ETH (2017)
    "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", // WETH (SAI / PETH reserves)
    "0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2", // MKR (Redeemer reserve)
  ] as const;
  const tokenAbi = parseAbi(["function balanceOf(address) view returns (uint256)", "function approve(address, uint256) returns (bool)", "function withdraw(uint256)"]);
  for (const t of oldTokens) m.addContract(1, t, tokenAbi, { balanceOf: ([a]) => held[t]?.[a as Address] ?? 0n, approve: () => true, withdraw: () => undefined });
  m.addContract(1, "0xa74476443119A942dE498590Fe1f2454d7D4aC0d", parseAbi(["function balanceOf(address) view returns (uint256)", "function migrationAgent() view returns (address)", "function migrate(uint256)"]), {
    balanceOf: ([a]) => held["0xa74476443119A942dE498590Fe1f2454d7D4aC0d"][a as Address] ?? 0n,
    migrationAgent: () => "0xBFAd98d76598961827bA832108c21445aa4FEE9A",
    migrate: () => undefined,
  });
  m.addContract(1, "0xBFAd98d76598961827bA832108c21445aa4FEE9A", parseAbi(["function target() view returns (address)"]), { target: () => "0x7DD9c5Cba05E151C895FDe1CF355C9A1D5DA6429" });
  m.addContract(1, "0xBf4eD7b27F1d666546E30D74d50d173d20bca754", parseAbi(["function withdraw()"]), { withdraw: () => undefined });
  m.setEthBalance(1, "0xBf4eD7b27F1d666546E30D74d50d173d20bca754", parseEther("81399.81"));
  m.addContract(1, "0xBda109309f9FafA6Dd6A9CB9f1Df4085B27Ee8eF", parseAbi(["function off() view returns (bool)", "function fix() view returns (uint256)"]), { off: () => true, fix: () => 5285551943761727318375221n });
  m.addContract(1, "0x448a5065aeBB8E423F0896E6c5D525C040f59af3", parseAbi(["function out() view returns (bool)", "function per() view returns (uint256)", "function gap() view returns (uint256)"]), {
    out: () => true,
    per: () => 1051432093602071663044652213n,
    gap: () => 10n ** 18n,
  });
  m.addContract(1, "0x642AE78FAfBB8032Da552D619aD43F1D81E4DD7C", parseAbi(["function stopped() view returns (bool)"]), { stopped: () => false });
  m.addContract(1, "0x23Ea10CC1e6EBdB499D24E45369A35f43627062f", parseAbi(["function isInitialized() view returns (bool)", "function weiPerNanoDGD() view returns (uint256)"]), {
    isInitialized: () => true,
    weiPerNanoDGD: () => 193054178n,
  });
  m.addContract(1, "0xdeFA4e8a7bcBA345F687a2f1456F5Edd9CE97202", parseAbi(["function oldKNC() view returns (address)"]), { oldKNC: () => "0xdd974D5C2e2928deA5F71b9825b8b646686BD200" });
  m.prices["ethereum:0x7dd9c5cba05e151c895fde1cf355c9a1d5da6429"] = 0.1247; // GLM

  return m;
}
