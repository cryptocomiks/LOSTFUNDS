import { createPublicClient, encodeFunctionData, encodePacked, fallback, http, keccak256, parseAbi, parseAbiItem, type Address, type Hex } from "viem";
import { mainnet } from "viem/chains";
import { l1Client } from "../clients";
import { formatAmount } from "../format";
import { L1 } from "../networks";
import { tokenMeta } from "../tokens";
import type { Asset, Finding } from "../types";
import { makeFinding, siteFile, type CheckOutput, type FindingSource } from "./common";
import { DUST_ETHEREUM, dryRun, ETHERSCAN } from "./claims";

/**
 * Starknet → Ethereum withdrawals never finalized. A StarkGate withdrawal sends a message to
 * Ethereum; the tokens only arrive once someone calls withdraw on the L1 bridge, which consumes
 * it. Nothing does it automatically for most bridges, and messages wait forever.
 *
 * L1 messages don't index their recipient, so the messages still waiting at the last snapshot
 * ship with the site by recipient (public/legacy/starknet, built by
 * scripts/starknet-withdrawals.ts), and the blocks after it are searched live. Every message is
 * then checked on-chain: StarknetCore.l2ToL1Messages(hash) > 0 (still unconsumed), and the
 * bridge's withdraw dry-run from the user.
 */

export const STARKNET: FindingSource = { id: "starknet", name: "Starknet", guideId: "starknet", explorer: ETHERSCAN };

export const STARKNET_CORE: Address = "0xc662c410c0ecf747543f5ba90660f6abebd9c8c4";
export const LOG_MESSAGE_TO_L1 = parseAbiItem("event LogMessageToL1(uint256 indexed fromAddress, address indexed toAddress, uint256[] payload)");

/** Tokens of the bridges whose messages don't name it (legacy payload: 0, recipient, low, high). */
export const LEGACY_BRIDGE_TOKENS: Record<string, { token?: Address; symbol: string; decimals: number }> = {
  "0xae0ee0a63a2ce6baeeffe56e7714fb4efe48d419": { symbol: "ETH", decimals: 18 },
  "0xf6080d9fbeebcd44d89affbfd42f098cbff92816": { token: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", symbol: "USDC", decimals: 6 },
  "0xbb3400f107804dfb482565ff1ec8d8ae66747605": { token: "0xdac17f958d2ee523a2206206994597c13d831ec7", symbol: "USDT", decimals: 6 },
  "0x9f96fe0633ee838d0298e8b8980e6716be81388d": { token: "0x6b175474e89094c44da98b954eedeac495271d0f", symbol: "DAI", decimals: 18 },
  "0x283751a21eafbfcd52297820d27c1f1963d9b5b4": { token: "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599", symbol: "WBTC", decimals: 8 },
};
/** StarkGate's marker for ETH in token-naming payloads (the bytes of "ETH"). */
const ETH_MARKER = 0x455448n;

/** A message as stored in the snapshot: L2 sender, L1 bridge, payload (hex words). */
export type StoredMessage = [from: string, to: string, payload: string[]];

export const messageHash = (from: bigint, to: string, payload: readonly bigint[]) =>
  keccak256(encodePacked(["uint256", "uint256", "uint256", "uint256[]"], [from, BigInt(to), BigInt(payload.length), [...payload]]));

/** A withdrawal-shaped payload: type 0, an address as recipient, 4 words (legacy) or 5 (token named). */
export const isWithdrawal = (payload: readonly bigint[]) => payload[0] === 0n && (payload.length === 4 || payload.length === 5) && payload[1] < 2n ** 160n;

const abi = parseAbi([
  "function l2ToL1Messages(bytes32) view returns (uint256)",
  "function withdraw(uint256 amount, address recipient)",
  "function withdraw(address token, uint256 amount, address recipient)",
]);
const word = (x: bigint) => `0x${x.toString(16).padStart(40, "0")}` as Address;

/** Blocks after the snapshot, searched live in chunks (the RPC nodes cap ranges and results). */
async function messagesSince(fromBlock: bigint, user: Address): Promise<StoredMessage[]> {
  const client = createPublicClient({ chain: mainnet, transport: fallback((L1.logsRpcs ?? L1.rpcs).map((u) => http(u, { timeout: 20_000, retryCount: 1 }))) });
  const head = await client.getBlockNumber();
  const out: StoredMessage[] = [];
  const me = BigInt(user);
  const range = async (from: bigint, to: bigint): Promise<void> => {
    try {
      const logs = await client.getLogs({ address: STARKNET_CORE, event: LOG_MESSAGE_TO_L1, fromBlock: from, toBlock: to });
      for (const l of logs)
        if (isWithdrawal(l.args.payload!) && l.args.payload![1] === me)
          out.push([`0x${l.args.fromAddress!.toString(16)}`, l.args.toAddress!.toLowerCase(), l.args.payload!.map((x) => `0x${x.toString(16)}`)]);
    } catch (e) {
      if (to - from < 1000n) throw e;
      const mid = (from + to) / 2n;
      await range(from, mid);
      await range(mid + 1n, to);
    }
  };
  for (let start = fromBlock; start <= head; start += 100_000n) await range(start, start + 99_999n > head ? head : start + 99_999n);
  return out;
}

async function snapshot(user: Address): Promise<{ block: bigint; messages: StoredMessage[] }> {
  const me = user.toLowerCase();
  const [meta, list] = await Promise.all(
    [`/legacy/starknet/meta.json`, `/legacy/starknet/${me[2]}.json`].map(async (path) => {
      const res = await fetch(siteFile(path), { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`Starknet snapshot: HTTP ${res.status}`);
      return res.json();
    }),
  );
  return { block: BigInt((meta as { snapshotBlock: number }).snapshotBlock), messages: (list as Record<string, StoredMessage[]>)[me] ?? [] };
}

export async function checkStarknet(user: Address): Promise<CheckOutput> {
  const snap = await snapshot(user);
  const recent = await messagesSince(snap.block + 1n, user);
  const seen = new Set<Hex>();
  const messages = [...snap.messages, ...recent]
    .map(([from, to, words]) => {
      const payload = words.map(BigInt);
      return { from: BigInt(from), to: to.toLowerCase() as Address, payload, hash: messageHash(BigInt(from), to, payload) };
    })
    .filter((m) => !seen.has(m.hash) && seen.add(m.hash));
  if (!messages.length) return { findings: [], completed: 0 };

  const c = l1Client();
  const pending = await Promise.all(messages.map((m) => c.readContract({ address: STARKNET_CORE, abi, functionName: "l2ToL1Messages", args: [m.hash] })));
  const open = messages.filter((_, i) => pending[i] > 0n);
  const completed = messages.length - open.length;

  const findings = await Promise.all(
    open.map(async (m): Promise<Finding | null> => {
      const amount = m.payload[m.payload.length - 2] + (m.payload[m.payload.length - 1] << 128n);
      if (amount === 0n) return null;
      const named = m.payload.length === 5 ? m.payload[2] : undefined;
      const data =
        named === undefined
          ? encodeFunctionData({ abi, functionName: "withdraw", args: [amount, user] })
          : encodeFunctionData({ abi, functionName: "withdraw", args: [word(named), amount, user] });
      if ((await dryRun(c, { from: user, to: m.to, data })) === null) return null;
      let asset: Asset;
      if (named === undefined || named === ETH_MARKER) {
        const known = named === ETH_MARKER ? { symbol: "ETH", decimals: 18 } : LEGACY_BRIDGE_TOKENS[m.to];
        if (!known) return null;
        asset = { symbol: known.symbol, decimals: known.decimals, amount, ...("token" in known && known.token && { token: known.token, tokenChain: "ethereum" }) };
      } else {
        const meta = await tokenMeta([c], word(named));
        if (!meta) return null;
        asset = { symbol: meta.symbol, decimals: meta.decimals, amount, token: word(named), tokenChain: "ethereum" };
      }
      return makeFinding(STARKNET, {
        key: m.hash,
        label: "Starknet → Ethereum",
        status: "ready",
        asset,
        txHash: m.to,
        txUrl: `${ETHERSCAN}/address/${m.to}#writeProxyContract`,
        linkLabel: "View bridge",
        timestamp: 0,
        claimAt: "starkgate.starknet.io, or Etherscan (the bridge → withdraw)",
        minUsd: DUST_ETHEREUM,
        note:
          `A withdrawal of ${formatAmount(amount, asset.decimals)} ${asset.symbol} from Starknet to this address reached Ethereum but was never finalized: ` +
          `the tokens stay in the StarkGate bridge (${m.to}) until withdraw(${named === undefined ? "" : "token, "}amount, recipient) is called on it.`,
      });
    }),
  );
  return { findings: findings.filter((f) => f !== null), completed };
}
