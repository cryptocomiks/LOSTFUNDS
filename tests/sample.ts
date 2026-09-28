/**
 * Finds real withdrawals made N days ago on each bridge and runs our check on their senders.
 * Usage: NODE_USE_ENV_PROXY=1 npx tsx tests/sample.ts
 */
import { createPublicClient, http, parseAbiItem, type Address } from "viem";
import { checkNetwork } from "../src/lib/checker.ts";
import { networkById } from "../src/lib/networks.ts";

const cases: { net: string; rpc: string; address: Address; event: string; blockTime: number; window: bigint }[] = [
  { net: "base", rpc: "https://mainnet.base.org", address: "0x4200000000000000000000000000000000000010", event: "event WithdrawalInitiated(address indexed l1Token, address indexed l2Token, address indexed from, address to, uint256 amount, bytes extraData)", blockTime: 2, window: 1999n },
  { net: "arbitrum", rpc: "https://arb1.arbitrum.io/rpc", address: "0x0000000000000000000000000000000000000064", event: "event L2ToL1Tx(address caller, address indexed destination, uint256 indexed hash, uint256 indexed position, uint256 arbBlockNum, uint256 ethBlockNum, uint256 timestamp, uint256 callvalue, bytes data)", blockTime: 0.25, window: 20000n },
  { net: "scroll", rpc: "https://rpc.scroll.io", address: "0x6EA73e05AdC79974B931123675ea8F78FfdacDF0", event: "event WithdrawETH(address indexed from, address indexed to, uint256 amount, bytes data)", blockTime: 1, window: 9999n },
  { net: "linea", rpc: "https://rpc.linea.build", address: "0x508Ca82Df566dCD1B0DE8296e70a96332cD644ec", event: "event MessageSent(address indexed _from, address indexed _to, uint256 _fee, uint256 _value, uint256 _nonce, bytes _calldata, bytes32 indexed _messageHash)", blockTime: 2, window: 9999n },
];

for (const c of cases) {
  const client = createPublicClient({ transport: http(c.rpc) });
  const head = await client.getBlockNumber();
  for (const days of [2, 30]) {
    const to = head - BigInt(Math.floor((days * 86400) / c.blockTime));
    const logs: { transactionHash: `0x${string}` | null }[] = await client.getLogs({ address: c.address, event: parseAbiItem(c.event) as never, fromBlock: to - c.window, toBlock: to }).catch((e) => {
      console.log(c.net, days, "getLogs failed", (e as Error).message.split("\n")[0]);
      return [];
    });
    const senders = new Set<Address>();
    for (const l of logs.slice(0, 40)) {
      const tx = await client.getTransaction({ hash: l.transactionHash! });
      senders.add(tx.from);
      if (senders.size >= 2) break;
    }
    for (const who of senders) {
      const r = await checkNetwork(networkById(c.net)!, who);
      console.log(
        `${c.net.padEnd(9)} ~${String(days).padStart(2)}d ${who}  ${r.state} completed=${r.completed} found=${r.findings.length}` +
          (r.error ? ` ERROR ${r.error}` : "") +
          r.findings.map((f) => `\n      ${f.status.padEnd(7)} ${Number(f.asset.amount) / 10 ** f.asset.decimals} ${f.asset.symbol}  sent ${new Date(f.timestamp * 1000).toISOString().slice(0, 10)}  ${f.txUrl}`).join(""),
      );
    }
  }
}
