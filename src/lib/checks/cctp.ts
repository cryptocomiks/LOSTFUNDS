import { base58 } from "@scure/base";
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  decodeEventLog,
  defineChain,
  encodePacked,
  fallback,
  http,
  keccak256,
  pad,
  parseAbi,
  parseAbiItem,
  toEventSelector,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
} from "viem";
import {
  arbitrum,
  arc,
  avalanche,
  base,
  bsc,
  codex,
  cronos,
  hyperEvm,
  injective,
  ink,
  linea,
  mainnet,
  monad,
  morph,
  optimism,
  plasma,
  plumeMainnet,
  polygon,
  robinhood,
  sei,
  sonic,
  unichain,
  worldchain,
  xdc,
  xLayer,
} from "viem/chains";
import { addressTopic, getLogs, getTokenTransfersFrom, type ExplorerTarget } from "../explorer";
import { L1, networkById } from "../networks";
import { accountsData, accountsExist, associatedTokenAddress, findProgramAddress, hexBytes, rpc as solanaRpc, SOLANA_INDEX_RPCS } from "../solana";
import { mapLimit } from "../tokens";
import type { Asset, Finding, WithdrawalStatus } from "../types";
import { DAY, makeFinding, now, type CheckOutput, type FindingSource } from "./common";

/**
 * Circle CCTP (v1 and v2): USDC burned on one chain and never minted on the other.
 *
 * Burns are found on every source chain that has a keyless history source, with the user as
 * the depositor (EVM) or as the signer / rent payer (Solana). Each burn's message is then
 * looked up where it was headed: the destination's MessageTransmitter records every nonce
 * it has processed, so "never minted" is read on-chain, not guessed:
 *   - EVM, v1: usedNonces(keccak256(abi.encodePacked(uint32 sourceDomain, uint64 nonce)))
 *   - EVM, v2: usedNonces(bytes32 nonce), the nonce being assigned by Circle's API
 *   - Solana: a used-nonces bitmap (v1) or one account per nonce (v2)
 * Circle's API (Iris) gives v2 nonces and tells whether the attestation needed to mint is
 * ready; on EVM destinations the mint is also simulated, which confirms it can be done.
 */

export const CCTP: FindingSource = { id: "cctp", name: "Circle CCTP", guideId: "cctp" };

/* ───────────── Contracts and chains ───────────── */

const V1_EVENT = parseAbiItem(
  "event DepositForBurn(uint64 indexed nonce, address indexed burnToken, uint256 amount, address indexed depositor, bytes32 mintRecipient, uint32 destinationDomain, bytes32 destinationTokenMessenger, bytes32 destinationCaller)",
);
const V2_EVENT = parseAbiItem(
  "event DepositForBurn(address indexed burnToken, uint256 amount, address indexed depositor, bytes32 mintRecipient, uint32 destinationDomain, bytes32 destinationTokenMessenger, bytes32 destinationCaller, uint256 maxFee, uint32 indexed minFinalityThreshold, bytes hookData)",
);
const T1 = toEventSelector(V1_EVENT);
const T2 = toEventSelector(V2_EVENT);

/** CCTP v2 lives at the same addresses on every EVM chain (checked on each: localDomain(), localMessageTransmitter()). */
const V2_MESSENGER: Address = "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d";
const V2_TRANSMITTER: Address = "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64";
/** Where TokenMessengerV2 pulls the burned USDC from the depositor (TokenMessengerV2.localMinter()). */
const V2_MINTER: Address = "0xfd78EE919681417d192449715b2594ab58f5D002";

const SOLANA = 5;
const SOLANA_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOLANA_V1 = { transmitter: "CCTPmbSD7gX1bxKPAmg77w8oFzNFpaQiQUWD43TKaecd", messenger: "CCTPiPYPc6AsJuwueEnWgSgucamXDZwBd53dQ11YiKX3" };
const SOLANA_V2 = { transmitter: "CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC", messenger: "CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe" };

/** Circle pauses the CCTP v1 contracts on Dec 1, 2026 (and lowers v1 burn limits from Oct 31). */
const V1_PAUSE = Date.UTC(2026, 11, 1) / 1000;

const pharos = defineChain({
  id: 1672,
  name: "Pharos",
  nativeCurrency: { name: "Pharos", symbol: "PROS", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.pharos.xyz"] } },
});

type History = ExplorerTarget & {
  /**
   * logs:      the TokenMessengers' DepositForBurn events, filtered by depositor (needs a source
   *            that answers such searches quickly: full-history RPC nodes).
   * transfers: the user's USDC transfers to the TokenMinters (explorer index, fast), whose
   *            receipts give the events; event search is the fallback.
   */
  via: "logs" | "transfers";
};

export interface CctpDomain {
  domain: number;
  name: string;
  chain: Chain;
  /** Public JSON-RPC endpoints (CORS-enabled, checked against the chain id), tried in order. */
  rpcs: string[];
  /** CCTP v1 contracts, on the chains that have them (TokenMessenger, MessageTransmitter, TokenMinter). */
  v1?: { messenger: Address; transmitter: Address; minter: Address };
  /** Source chains: where the user's burns are found, native USDC (TokenMinter.getLocalToken) and the tx explorer. */
  history?: History;
  usdc?: Address;
  explorer?: string;
}

const pn = (sub: string) => `https://${sub}.publicnode.com`;
const drpc = (sub: string) => `https://${sub}.drpc.org`;
const routescan = (id: number) => `https://api.routescan.io/v2/network/mainnet/evm/${id}/etherscan`;
const net = (id: string): ExplorerTarget => {
  const n = networkById(id)!;
  return { name: n.name, chain: n.chain, blockscout: n.blockscout, api: n.api, logsRpcs: n.logsRpcs };
};

/**
 * EVM chains with CCTP. Every address was read on-chain (MessageTransmitter.localDomain(),
 * TokenMessenger.localMessageTransmitter() and .localMinter(), TokenMinter.getLocalToken()).
 * RPC lists start with nodes that still serve old receipts (publicnode doesn't on several chains).
 */
export const CCTP_DOMAINS: CctpDomain[] = [
  {
    domain: 0,
    name: "Ethereum",
    chain: mainnet,
    rpcs: [pn("ethereum-rpc"), "https://eth.drpc.org", "https://rpc.mevblocker.io"],
    v1: {
      messenger: "0xBd3fa81B58Ba92a82136038B25aDec7066af3155",
      transmitter: "0x0a992d191DEeC32aFe36203Ad87D7d289a738F81",
      minter: "0xc4922d64a24675E16e1586e3e3Aa56C06fABe907",
    },
    usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    history: { ...L1, via: "logs" }, // full-history event search on Ethereum RPC nodes takes ~1s
    explorer: "https://etherscan.io",
  },
  {
    domain: 1,
    name: "Avalanche",
    chain: avalanche,
    rpcs: ["https://api.avax.network/ext/bc/C/rpc", pn("avalanche-c-chain-rpc")],
    v1: {
      messenger: "0x6B25532e1060CE10cc3B0A99e5683b91BFDe6982",
      transmitter: "0x8186359aF5F57FbB40c6b14A588d2A59C0C29880",
      minter: "0x420F5035fd5dC62a167E7e7f08B604335aE272b8",
    },
    usdc: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
    history: { name: "Avalanche", chain: avalanche, api: routescan(43114), via: "transfers" },
    explorer: "https://snowtrace.io",
  },
  {
    domain: 2,
    name: "Optimism",
    chain: optimism,
    rpcs: ["https://mainnet.optimism.io", pn("optimism-rpc"), drpc("optimism")],
    v1: {
      messenger: "0x2B4069517957735bE00ceE0fadAE88a26365528f",
      transmitter: "0x4D41f22c5a0e5c74090899E5a8Fb597a8842b3e8",
      minter: "0x33E76C5C31cb928dc6FE6487AB3b2C0769B1A1e3",
    },
    usdc: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
    history: { ...net("optimism"), via: "transfers" },
    explorer: "https://optimistic.etherscan.io",
  },
  {
    domain: 3,
    name: "Arbitrum",
    chain: arbitrum,
    rpcs: ["https://arb1.arbitrum.io/rpc", pn("arbitrum-one-rpc")],
    v1: {
      messenger: "0x19330d10D9Cc8751218eaf51E8885D058642E08A",
      transmitter: "0xC30362313FBBA5cf9163F0bb16a0e01f01A896ca",
      minter: "0xE7Ed1fa7f45D05C508232aa32649D89b73b8bA48",
    },
    usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    history: { ...net("arbitrum"), via: "transfers" },
    explorer: "https://arbiscan.io",
  },
  {
    domain: 6,
    name: "Base",
    chain: base,
    rpcs: ["https://mainnet.base.org", pn("base-rpc"), drpc("base")],
    v1: {
      messenger: "0x1682Ae6375C4E4A97e4B583BC394c861A46D8962",
      transmitter: "0xAD09780d193884d503182aD4588450C416D6F9D4",
      minter: "0xe45B133ddc64bE80252b0e9c75A8E74EF280eEd6",
    },
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    history: { ...net("base"), via: "transfers" },
    explorer: "https://basescan.org",
  },
  {
    domain: 7,
    name: "Polygon",
    chain: polygon,
    rpcs: [pn("polygon-bor-rpc"), drpc("polygon")],
    v1: {
      messenger: "0x9daF8c91AEFAE50b9c0E69629D3F6Ca40cA3B3FE",
      transmitter: "0xF3be9355363857F3e001be68856A2f96b4C39Ba9",
      minter: "0x10f7835F827D6Cf035115E10c50A853d7FB2D2EC",
    },
    usdc: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
    history: { name: "Polygon", chain: polygon, blockscout: "https://polygon.blockscout.com", via: "transfers" },
    explorer: "https://polygonscan.com",
  },
  {
    domain: 10,
    name: "Unichain",
    chain: unichain,
    rpcs: ["https://mainnet.unichain.org", pn("unichain-rpc")],
    v1: {
      messenger: "0x4e744b28E787c3aD0e810eD65A24461D4ac5a762",
      transmitter: "0x353bE9E2E38AB1D19104534e4edC21c643Df86f4",
      minter: "0x726bFEF3cBb3f8AF7d8CB141E78F86Ae43C34163",
    },
    usdc: "0x078D782b760474a361dDA0AF3839290b0EF57AD6",
    history: { ...net("unichain"), via: "transfers" },
    explorer: "https://uniscan.xyz",
  },
  {
    domain: 11,
    name: "Linea",
    chain: linea,
    rpcs: ["https://rpc.linea.build", pn("linea-rpc")],
    usdc: "0x176211869cA2b568f2A7D4EE941E073a821EE1ff",
    history: { ...net("linea"), via: "transfers" },
    explorer: "https://lineascan.build",
  },
  {
    domain: 12,
    name: "Codex",
    chain: codex,
    rpcs: ["https://rpc.codex.xyz"],
    usdc: "0xd996633a415985DBd7D6D12f4A4343E31f5037cf",
    history: { ...net("codex"), via: "logs" },
    explorer: "https://explorer.codex.xyz",
  },
  {
    domain: 13,
    name: "Sonic",
    chain: sonic,
    rpcs: ["https://rpc.soniclabs.com", pn("sonic-rpc")],
    usdc: "0x29219dd400f2Bf60E5a23d13Be72B486D4038894",
    history: { name: "Sonic", chain: sonic, logsRpcs: ["https://rpc.soniclabs.com"], via: "logs" },
    explorer: "https://sonicscan.org",
  },
  {
    domain: 14,
    name: "World Chain",
    chain: worldchain,
    rpcs: ["https://worldchain-mainnet.g.alchemy.com/public", drpc("worldchain")],
    usdc: "0x79A02482A880bCE3F13e09Da970dC34db4CD24d1",
    history: { ...net("worldchain"), via: "transfers" },
    explorer: "https://worldscan.org",
  },
  // Destination only: CCTP v2 is deployed, but there is no keyless, CORS-enabled source for a user's history
  // (RPC event searches capped at 100 to 10,000 blocks, no public Blockscout or Routescan index).
  { domain: 15, name: "Monad", chain: monad, rpcs: ["https://rpc.monad.xyz", drpc("monad-mainnet")] },
  { domain: 16, name: "Sei", chain: sei, rpcs: ["https://evm-rpc.sei-apis.com", drpc("sei")] },
  { domain: 17, name: "BNB Chain", chain: bsc, rpcs: [pn("bsc-rpc"), drpc("bsc")] },
  { domain: 18, name: "XDC", chain: xdc, rpcs: ["https://erpc.xdcrpc.com", "https://rpc.xdcrpc.com"] },
  { domain: 19, name: "HyperEVM", chain: hyperEvm, rpcs: ["https://rpc.hyperliquid.xyz/evm", drpc("hyperliquid")] },
  {
    domain: 21,
    name: "Ink",
    chain: ink,
    rpcs: ["https://rpc-gel.inkonchain.com", pn("ink-rpc")],
    usdc: "0x2D270e6886d130D724215A266106e6832161EAEd",
    history: { ...net("ink"), via: "transfers" },
    explorer: "https://explorer.inkonchain.com",
  },
  {
    domain: 22,
    name: "Plume",
    chain: plumeMainnet,
    rpcs: ["https://rpc.plume.org"],
    usdc: "0x222365EF19F7947e5484218551B56bb3965Aa7aF",
    // Plume's node answers full-history event searches in ~1s; its Blockscout is the fallback.
    history: { name: "Plume", chain: plumeMainnet, blockscout: "https://explorer.plume.org", logsRpcs: ["https://rpc.plume.org"], preferRpc: true, via: "logs" },
    explorer: "https://explorer.plume.org",
  },
  { domain: 26, name: "Arc", chain: arc, rpcs: ["https://rpc.mainnet.arc.io"] },
  {
    domain: 29,
    name: "Injective",
    chain: injective,
    rpcs: ["https://sentry.evm-rpc.injective.network"],
    usdc: "0xa00C59fF5a080D2b954d0c75e46E22a0c371235a",
    history: { name: "Injective", chain: injective, blockscout: "https://blockscout.injective.network", via: "transfers" },
    explorer: "https://blockscout.injective.network",
  },
  {
    domain: 30,
    name: "Morph",
    chain: morph,
    rpcs: ["https://rpc.morphl2.io", drpc("morph")],
    usdc: "0xCfb1186F4e93D60E60a8bDd997427D1F33bc372B",
    history: { name: "Morph", chain: morph, blockscout: "https://explorer-api.morphl2.io", via: "transfers" },
    explorer: "https://explorer.morphl2.io",
  },
  { domain: 31, name: "Pharos", chain: pharos, rpcs: ["https://rpc.pharos.xyz"] },
  { domain: 32, name: "Cronos", chain: cronos, rpcs: ["https://evm.cronos.org", pn("cronos-evm-rpc")] },
  {
    domain: 33,
    name: "Plasma",
    chain: plasma,
    rpcs: ["https://rpc.plasma.to"],
    usdc: "0x2d661C89D812261039AF9764eceaAee884f5F67F",
    history: { name: "Plasma", chain: plasma, api: routescan(9745), via: "transfers" },
    explorer: "https://plasmascan.to",
  },
  // Robinhood Chain: its node allows 10M-block event searches, but no v2 burn had ever started there (Sep 2026).
  { domain: 35, name: "Robinhood Chain", chain: robinhood, rpcs: ["https://rpc.mainnet.chain.robinhood.com"] },
  { domain: 37, name: "X Layer", chain: xLayer, rpcs: ["https://rpc.xlayer.tech", "https://xlayerrpc.okx.com"] },
];

const domainOf = (d: number) => CCTP_DOMAINS.find((c) => c.domain === d);
const nameOf = (d: number) => (d === SOLANA ? "Solana" : (domainOf(d)?.name ?? `domain ${d}`));

/** Can we tell whether a message to this domain was received? (Noble, Sui, Aptos… can't be read from here.) */
function checkable(dst: number, version: 1 | 2) {
  if (dst === SOLANA) return true;
  const d = domainOf(dst);
  return !!d && (version === 2 || !!d.v1);
}

const clients = new Map<number, PublicClient>();
function client(d: CctpDomain): PublicClient {
  let c = clients.get(d.domain);
  if (!c) {
    c = createPublicClient({
      chain: d.chain,
      transport: fallback(
        d.rpcs.map((url) => http(url, { timeout: 15_000, retryCount: 1, batch: { wait: 16 } })),
        { rank: false },
      ),
      batch: d.chain.contracts?.multicall3 ? { multicall: { wait: 16 } } : undefined,
    }) as PublicClient;
    clients.set(d.domain, c);
  }
  return c;
}

const transmitterAbi = parseAbi([
  "function usedNonces(bytes32) view returns (uint256)",
  "function receiveMessage(bytes message, bytes attestation) returns (bool)",
]);

/* ───────────── Burns and messages ───────────── */

const ZERO32: Hex = `0x${"0".repeat(64)}`;
const MAX_CANDIDATES = 1000;
const MAX_V2_LOOKUPS = 300;
const MAX_SOLANA_ACCOUNTS = 1000;
/** Newest USDC transactions of a Solana wallet looked up in Circle's API (burns whose account was already closed). */
const RECENT_SOLANA_TXS = 100;

interface Burn {
  version: 1 | 2;
  src: number;
  dst: number;
  /** Source transaction (hash or Solana signature), when known. */
  tx?: string;
  /** Unix seconds; 0 when unknown. */
  timestamp: number;
  amount: bigint;
  mintRecipient: Hex;
  caller: Hex;
  /** Who burned, as a 32-byte message sender (the depositor, or the Solana token owner). */
  sender: Hex;
  /** v1: the nonce is assigned on-chain. */
  nonce?: bigint;
  /** The message, when it can be built without Circle's API (v1 events, Solana accounts). */
  message?: Hex;
  /** Solana: the account holding the message. */
  account?: string;
  /** Circle's record of the message (v2 nonce, status, attestation). undefined: not asked yet; null: unknown to Circle. */
  iris?: IrisMessage | null;
  /** Couldn't be looked up (the failure is reported separately). */
  skip?: boolean;
}

interface IrisMessage {
  cctpVersion: number;
  eventNonce: string;
  status: string;
  message?: string | null;
  attestation?: string | null;
  delayReason?: string | null;
  decodedMessage?: {
    destinationDomain?: string;
    decodedMessageBody?: { mintRecipient?: string; amount?: string; messageSender?: string } | null;
  } | null;
}

const lower = (s: string) => s.toLowerCase();
const same32 = (a: string, b: string) => lower(a) === lower(b);
const hexOf = (b: Uint8Array) => `0x${Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")}` as Hex;
const errMsg = (e: unknown) => ((e as { shortMessage?: string }).shortMessage ?? (e as Error).message ?? String(e)).split("\n")[0].slice(0, 140);
const isAttestation = (a: unknown): a is Hex => typeof a === "string" && /^0x[0-9a-fA-F]{130,}$/.test(a);

/** Fields of a CCTP message (v1 or v2), from its bytes. */
function parseMessage(message: string) {
  if (!/^0x[0-9a-fA-F]*$/.test(message)) return null;
  const bytes = (message.length - 2) / 2;
  const at = (off: number, len: number) => `0x${message.slice(2 + off * 2, 2 + (off + len) * 2)}` as Hex;
  const version = Number(at(0, 4));
  // v1: version(4) src(4) dst(4) nonce(8) sender(32) recipient(32) caller(32) | body: version(4) token(32) mintRecipient(32) amount(32) messageSender(32)
  if (version === 0 && bytes >= 248)
    return { version: 1, src: Number(at(4, 4)), dst: Number(at(8, 4)), nonce: at(12, 8), messenger: at(20, 32), caller: at(84, 32), mintRecipient: at(152, 32), amount: BigInt(at(184, 32)), sender: at(216, 32) };
  // v2: version(4) src(4) dst(4) nonce(32) sender(32) recipient(32) caller(32) minFinality(4) finalityExecuted(4) | body: version(4) token(32) mintRecipient(32) amount(32) messageSender(32)…
  if (version === 1 && bytes >= 376)
    return { version: 2, src: Number(at(4, 4)), dst: Number(at(8, 4)), nonce: at(12, 32), messenger: at(44, 32), caller: at(108, 32), mintRecipient: at(184, 32), amount: BigInt(at(216, 32)), sender: at(248, 32) };
  return null;
}

/** An address or Solana key from Circle's decoded message, as 32 bytes. */
function to32(v: string | undefined): Hex | undefined {
  if (!v) return undefined;
  if (/^0x[0-9a-fA-F]{1,64}$/.test(v)) return pad(v as Hex, { size: 32 }).toLowerCase() as Hex;
  try {
    const b = base58.decode(v);
    return b.length === 32 ? hexOf(b) : undefined;
  } catch {
    return undefined;
  }
}

/** Does Circle's message `m` describe this burn? */
function describes(m: IrisMessage, b: Burn): boolean {
  const p = m.message ? parseMessage(m.message) : null;
  if (p) return p.version === b.version && p.src === b.src && p.dst === b.dst && p.amount === b.amount && same32(p.mintRecipient, b.mintRecipient) && same32(p.sender, b.sender);
  // Messages still waiting for confirmations may come without their bytes.
  const d = m.decodedMessage;
  const body = d?.decodedMessageBody;
  return (
    m.cctpVersion === b.version &&
    d?.destinationDomain === String(b.dst) &&
    body?.amount === b.amount.toString() &&
    to32(body.mintRecipient) === lower(b.mintRecipient) &&
    to32(body.messageSender) === lower(b.sender)
  );
}

/** The v1 message a DepositForBurn event stands for (as attested by Circle), for when Circle's API no longer returns it. */
function v1Message(src: CctpDomain, a: { nonce: bigint; burnToken: Address; depositor: Address; mintRecipient: Hex; destinationDomain: number; destinationTokenMessenger: Hex; destinationCaller: Hex; amount: bigint }): Hex {
  return encodePacked(
    ["uint32", "uint32", "uint32", "uint64", "bytes32", "bytes32", "bytes32", "uint32", "bytes32", "bytes32", "uint256", "bytes32"],
    [0, src.domain, a.destinationDomain, a.nonce, pad(src.v1!.messenger), a.destinationTokenMessenger, a.destinationCaller, 0, pad(a.burnToken), a.mintRecipient, a.amount, pad(a.depositor)],
  );
}

/** A DepositForBurn event of `user` on chain `d`, or null for any other log. */
function burnFromLog(d: CctpDomain, log: { address: string; topics: readonly Hex[]; data: Hex }, user: Address, tx: Hex, timestamp: number): Burn | null {
  const u = addressTopic(user);
  const t = log.topics;
  if (d.v1 && same32(log.address, d.v1.messenger) && t[0] === T1 && t[3] && same32(t[3], u)) {
    const { args } = decodeEventLog({ abi: [V1_EVENT], data: log.data, topics: t as [Hex, ...Hex[]] });
    return {
      version: 1,
      src: d.domain,
      dst: args.destinationDomain,
      tx,
      timestamp,
      amount: args.amount,
      mintRecipient: args.mintRecipient,
      caller: args.destinationCaller,
      sender: u,
      nonce: args.nonce,
      message: v1Message(d, args),
    };
  }
  if (same32(log.address, V2_MESSENGER) && t[0] === T2 && t[2] && same32(t[2], u)) {
    const { args } = decodeEventLog({ abi: [V2_EVENT], data: log.data, topics: t as [Hex, ...Hex[]] });
    return { version: 2, src: d.domain, dst: args.destinationDomain, tx, timestamp, amount: args.amount, mintRecipient: args.mintRecipient, caller: args.destinationCaller, sender: u };
  }
  return null;
}

/* ───────────── Circle's API (Iris) ───────────── */

const IRIS = "https://iris-api.circle.com";
// Iris allows 35 requests per second and locks callers out for 5 minutes past that: stay far below.
const IRIS_IN_FLIGHT = 4;
const IRIS_SPACING_MS = 150;
const iris = { active: 0, last: 0, waiting: [] as (() => void)[] };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Circle's messages for a source transaction or nonce; null when Circle doesn't know it. */
async function irisMessages(src: number, query: string): Promise<{ messages: IrisMessage[]; sourceTxHash?: string } | null> {
  while (iris.active >= IRIS_IN_FLIGHT) await new Promise<void>((r) => iris.waiting.push(r));
  iris.active++;
  try {
    for (let attempt = 0; ; attempt++) {
      const wait = iris.last + IRIS_SPACING_MS - Date.now();
      iris.last = Math.max(Date.now(), iris.last + IRIS_SPACING_MS);
      if (wait > 0) await sleep(wait);
      let res: Response | null = null;
      try {
        res = await fetch(`${IRIS}/v2/messages/${src}?${query}`, { signal: AbortSignal.timeout(20_000) });
      } catch {
        /* network error: retried below */
      }
      if (res?.status === 404) return null;
      if (res?.ok) {
        const json = (await res.json()) as { messages?: IrisMessage[]; sourceTxHash?: string };
        return { messages: json.messages ?? [], sourceTxHash: json.sourceTxHash };
      }
      if (res?.status === 429) throw new Error("Circle's API is rate-limiting requests: try again in 5 minutes");
      if (attempt >= 2 || (res && res.status < 500)) throw new Error(`Circle's API: ${res ? `HTTP ${res.status}` : "unreachable"}`);
      await sleep(1000 * 2 ** attempt);
    }
  } finally {
    iris.active--;
    iris.waiting.shift()?.();
  }
}

/* ───────────── Finding burns on EVM chains ───────────── */

interface RpcLog {
  address: string;
  topics: Hex[];
  data: Hex;
}

/** Receipt logs of these transactions. Nodes that return null (pruned history) are skipped for the next one. */
async function receiptLogs(rpcs: string[], hashes: Hex[]): Promise<Map<Hex, RpcLog[]>> {
  const out = new Map<Hex, RpcLog[]>();
  let todo = hashes;
  const errors: string[] = [];
  for (const url of rpcs) {
    if (!todo.length) break;
    const missing: Hex[] = [];
    for (let i = 0; i < todo.length; i += 10) {
      const chunk = todo.slice(i, i + 10);
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(chunk.map((h, id) => ({ jsonrpc: "2.0", id, method: "eth_getTransactionReceipt", params: [h] }))),
          signal: AbortSignal.timeout(20_000),
        });
        const replies = (await res.json()) as { id: number; result?: { logs: RpcLog[] } | null }[];
        if (!Array.isArray(replies)) throw new Error(`HTTP ${res.status}`);
        const byId = new Map(replies.map((r) => [r.id, r.result]));
        chunk.forEach((h, id) => {
          const r = byId.get(id);
          if (r && Array.isArray(r.logs)) out.set(h, r.logs);
          else missing.push(h);
        });
      } catch (e) {
        errors.push(`${new URL(url).host}: ${errMsg(e)}`);
        missing.push(...chunk);
      }
    }
    todo = missing;
  }
  if (todo.length) throw new Error(`no receipt for ${todo[0].slice(0, 12)}…${errors.length ? ` (${errors[0]})` : ""}`);
  return out;
}

async function burnsFromLogs(d: CctpDomain, user: Address): Promise<Burn[]> {
  const u = addressTopic(user);
  const h = d.history!;
  const [v1, v2] = await Promise.all([
    d.v1 ? getLogs(h, d.v1.messenger, [T1, null, null, u]) : [],
    getLogs(h, V2_MESSENGER, [T2, null, u]),
  ]);
  return [...v1, ...v2].flatMap((l) => burnFromLog(d, l, user, l.transactionHash, l.timestamp) ?? []);
}

/** The user's burns on one chain (as depositor). */
async function findBurns(d: CctpDomain, user: Address): Promise<Burn[]> {
  if (d.history!.via === "logs") return burnsFromLogs(d, user);
  // Every burn moves the depositor's USDC to a TokenMinter: the explorer's token-transfer index
  // finds those transactions quickly, for smart wallets and EIP-7702 accounts too.
  let transfers;
  try {
    transfers = await getTokenTransfersFrom(d.history!, user, d.usdc!);
  } catch (e) {
    try {
      return await burnsFromLogs(d, user);
    } catch (logErr) {
      throw new Error(`${errMsg(e)} | events: ${errMsg(logErr)}`);
    }
  }
  const minters = new Set([V2_MINTER, d.v1?.minter].filter(Boolean).map((a) => lower(a!)));
  const txs = new Map<Hex, number>();
  for (const t of transfers) if (minters.has(lower(t.to))) txs.set(t.hash, t.timestamp);
  if (!txs.size) return [];
  if (txs.size > MAX_CANDIDATES) throw new Error(`${txs.size} CCTP transfers: too many to check automatically`);
  const receipts = await receiptLogs(d.rpcs, [...txs.keys()]);
  const burns: Burn[] = [];
  for (const [tx, logs] of receipts)
    for (const l of logs) {
      const b = burnFromLog(d, l, user, tx, txs.get(tx)!);
      if (b) burns.push(b);
    }
  return burns;
}

// A second run (e.g. "Retry" after one chain failed) only asks the chains that failed.
const burnCache = new Map<string, { at: number; burns: Promise<Burn[]> }>();
function cachedBurns(d: CctpDomain, user: Address): Promise<Burn[]> {
  const key = `${d.domain}:${lower(user)}`;
  const hit = burnCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.burns;
  const burns = findBurns(d, user);
  burnCache.set(key, { at: Date.now(), burns });
  burns.catch(() => burnCache.delete(key));
  return burns;
}

/* ───────────── Was it minted? ───────────── */

const enc = (s: string) => new TextEncoder().encode(s);

/** Solana v1: one bitmap account per 6,400 nonces and source domain. */
const bitmapCache = new Map<string, Promise<Uint8Array | null>>();
async function solanaV1Used(src: number, nonce: bigint): Promise<boolean> {
  const first = ((nonce - 1n) / 6400n) * 6400n + 1n;
  const pda = findProgramAddress([enc("used_nonces"), enc(String(src)), enc(first.toString())], SOLANA_V1.transmitter);
  let p = bitmapCache.get(pda);
  if (!p) {
    p = accountsData([pda]).then(([d]) => d);
    bitmapCache.set(pda, p);
    p.catch(() => bitmapCache.delete(pda));
  }
  const d = await p;
  if (!d) return false; // no nonce of this range was ever received
  // layout: discriminator(8) remote_domain(u32) first_nonce(u64) used_nonces[u64; 100], little-endian
  const view = new DataView(d.buffer, d.byteOffset, d.byteLength);
  if (d.length < 820 || view.getUint32(8, true) !== src || view.getBigUint64(12, true) !== first) throw new Error(`unexpected Solana nonce account ${pda}`);
  const idx = Number(nonce - first);
  const word = view.getBigUint64(20 + Math.floor(idx / 64) * 8, true);
  return ((word >> BigInt(idx % 64)) & 1n) === 1n;
}

/** Has the destination processed this message? undefined: can't be minted yet (no nonce: not attested). */
async function minted(b: Burn): Promise<boolean | undefined> {
  let key: Hex;
  if (b.version === 1) key = keccak256(encodePacked(["uint32", "uint64"], [b.src, b.nonce!]));
  else {
    const n = b.iris?.eventNonce;
    if (!n || !/^0x[0-9a-fA-F]{64}$/.test(n) || n === ZERO32) return undefined;
    key = n as Hex;
  }
  if (b.dst === SOLANA) {
    if (b.version === 1) return solanaV1Used(b.src, b.nonce!);
    return (await accountsExist([findProgramAddress([enc("used_nonce"), hexBytes(key)], SOLANA_V2.transmitter)]))[0];
  }
  const d = domainOf(b.dst)!;
  const used = await client(d).readContract({
    address: b.version === 1 ? d.v1!.transmitter : V2_TRANSMITTER,
    abi: transmitterAbi,
    functionName: "usedNonces",
    args: [key],
  });
  return used !== 0n;
}

type Simulation = "ok" | "used" | "expired" | "paused" | "unavailable" | { revert: string };

/** Tries the mint on the destination (eth_call), from the only account allowed to do it. */
async function simulateMint(b: Burn, message: Hex, attestation: Hex): Promise<Simulation> {
  const d = domainOf(b.dst)!;
  const from = b.caller !== ZERO32 ? b.caller : b.mintRecipient;
  if (!/^0x0{24}[0-9a-fA-F]{40}$/.test(from)) return "unavailable";
  try {
    await client(d).simulateContract({
      address: b.version === 1 ? d.v1!.transmitter : V2_TRANSMITTER,
      abi: transmitterAbi,
      functionName: "receiveMessage",
      args: [message, attestation],
      account: `0x${from.slice(26)}` as Address,
    });
    return "ok";
  } catch (e) {
    const revert = e instanceof BaseError ? e.walk((x) => x instanceof ContractFunctionRevertedError) : null;
    if (!(revert instanceof ContractFunctionRevertedError)) return "unavailable";
    const reason = revert.reason ?? revert.shortMessage;
    if (/nonce already used/i.test(reason)) return "used";
    if (/expired/i.test(reason)) return "expired";
    if (/paused/i.test(reason)) return "paused";
    return { revert: reason.slice(0, 80) };
  }
}

/* ───────────── From burns to findings ───────────── */

const usdc = (amount: bigint): Asset => ({ symbol: "USDC", decimals: 6, amount, priceKey: "coingecko:usd-coin" });

function txLink(b: Burn): { txHash: string; txUrl: string } {
  if (b.src === SOLANA) {
    if (b.tx) return { txHash: b.tx, txUrl: `https://solscan.io/tx/${b.tx}` };
    return { txHash: b.account!, txUrl: `https://solscan.io/account/${b.account}` };
  }
  return { txHash: b.tx!, txUrl: `${domainOf(b.src)!.explorer}/tx/${b.tx}` };
}

/** Looks up Circle's record of v2 burns (one request per source transaction). */
async function attachV2Nonces(burns: Burn[], errors: string[]) {
  const byTx = new Map<string, Burn[]>();
  for (const b of burns) {
    if (b.version !== 2 || b.iris !== undefined || b.skip || !b.tx || !checkable(b.dst, 2)) continue;
    const k = `${b.src}:${b.tx}`;
    byTx.set(k, [...(byTx.get(k) ?? []), b]);
  }
  const groups = [...byTx.values()].sort((a, b) => b[0].timestamp - a[0].timestamp);
  if (groups.length > MAX_V2_LOOKUPS) {
    errors.push(`${groups.length} CCTP v2 transfers: only the newest ${MAX_V2_LOOKUPS} were checked`);
    for (const g of groups.slice(MAX_V2_LOOKUPS)) for (const b of g) b.skip = true;
  }
  const failed = new Map<string, string>();
  await mapLimit(groups.slice(0, MAX_V2_LOOKUPS), IRIS_IN_FLIGHT, async (group) => {
    const { src, tx } = group[0];
    try {
      const pool = [...((await irisMessages(src, `transactionHash=${tx}`))?.messages ?? [])];
      for (const b of group) {
        const i = pool.findIndex((m) => describes(m, b));
        b.iris = i >= 0 ? pool.splice(i, 1)[0] : null;
      }
    } catch (e) {
      failed.set(nameOf(src), errMsg(e));
      for (const b of group) b.skip = true;
    }
  });
  for (const [chain, msg] of failed) errors.push(`${chain}: ${msg}`);
}

/** Checks each burn on its destination and turns the unminted ones into findings. Failures go to `errors`. */
async function settle(burns: Burn[], out: CheckOutput, errors: string[]) {
  await attachV2Nonces(burns, errors);
  const failed = new Map<string, string>();
  await mapLimit(burns, 8, async (b) => {
    if (b.skip || !checkable(b.dst, b.version)) return; // Noble, Sui, Aptos…: can't be verified from here
    try {
      const f = await settleOne(b);
      if (f === "minted") out.completed++;
      else out.findings.push(f);
    } catch (e) {
      failed.set(`${nameOf(b.src)} → ${nameOf(b.dst)}`, errMsg(e));
    }
  });
  for (const [route, msg] of failed) errors.push(`${route}: ${msg}`);
}

async function settleOne(b: Burn): Promise<Finding | "minted"> {
  const from = nameOf(b.src);
  const to = nameOf(b.dst);
  const age = () => (b.timestamp ? now() - b.timestamp : Infinity);
  if (b.version === 2 && b.iris === null) {
    // Circle hasn't indexed it yet, or never will: without its nonce we can't tell whether it was minted.
    if (age() < DAY) return finding(b, "recent", `Burned on ${from}; Circle hasn't processed it yet.`);
    throw new Error(`Circle's API has no record of transfer ${b.tx?.slice(0, 12)}…`);
  }

  if (await minted(b)) return "minted";

  // Not minted: is Circle's attestation ready?
  if (b.iris === undefined) b.iris = b.version === 1 ? await irisFor(b) : null;
  if (!b.timestamp && b.src === SOLANA && b.tx) b.timestamp = await solanaTxTime(b.tx);
  const m = b.iris;
  const v1Note = b.version === 1 ? " Circle is retiring CCTP V1: mint it before Dec 1, 2026, when its contracts are paused." : "";
  const how =
    b.caller !== ZERO32
      ? " Only the app you used can complete it (it set itself as the destination caller): reopen that app."
      : " Anyone can complete it with the attestation: use a CCTP tool or the app you used.";

  if (!m) {
    if (age() < DAY) return finding(b, "recent", `Burned on ${from}; Circle hasn't processed it yet.`);
    return finding(b, "manual", `USDC was burned on ${from} but never minted on ${to}, and Circle's API has no attestation for it. Contact the app you used or Circle's support.${v1Note}`);
  }
  if (m.status !== "complete" || !isAttestation(m.attestation)) {
    if (age() < DAY) return finding(b, "recent", `Burned on ${from}; Circle's attestation isn't ready yet.`);
    const why = m.delayReason ? ` (${m.delayReason.replace(/_/g, " ")})` : "";
    return finding(b, "manual", `USDC was burned on ${from}, but Circle hasn't attested it yet${why}, so it can't be minted on ${to}. Check it with the app you used.`);
  }

  const status: WithdrawalStatus = age() < DAY ? "recent" : "ready";
  const attested = `USDC was burned on ${from} and attested by Circle, but never minted on ${to}.`;
  if (b.dst === SOLANA) {
    if (b.version === 1 && now() >= V1_PAUSE) return finding(b, "manual", `${attested} Circle paused CCTP V1 on Dec 1, 2026: ask the app you used or Circle's support.`);
    return finding(b, status, attested + how + v1Note);
  }
  const message = (m.message && parseMessage(m.message) ? m.message : b.message) as Hex | undefined;
  const sim = message ? await simulateMint(b, message, m.attestation) : "unavailable";
  if (sim === "used") return "minted"; // minted since the check above
  if (sim === "ok" || sim === "unavailable") return finding(b, status, attested + how + v1Note);
  if (sim === "expired")
    return finding(b, "manual", `${attested} Its attestation expired: ask Circle for a new one (re-attest the message), then mint it with the app you used.`);
  if (sim === "paused") return finding(b, "manual", `${attested} The ${to} contract is paused (Circle retired CCTP V1): ask the app you used or Circle's support.`);
  return finding(b, "manual", `${attested} A test mint on ${to} failed (${sim.revert}): check it with the app you used.${v1Note}`);
}

/** Circle's record of a v1 burn (asked only when it wasn't minted). */
async function irisFor(b: Burn): Promise<IrisMessage | null> {
  const res = b.tx ? await irisMessages(b.src, `transactionHash=${b.tx}`) : await irisMessages(b.src, `nonce=${b.nonce}`);
  if (!b.tx && res?.sourceTxHash) b.tx = res.sourceTxHash;
  // Old v1 messages come back without their bytes: the nonce identifies them.
  return res?.messages.find((m) => m.cctpVersion === 1 && m.eventNonce === String(b.nonce) && (!m.message || describes(m, b))) ?? null;
}

async function solanaTxTime(sig: string): Promise<number> {
  const tx = await solanaRpc<{ blockTime?: number } | null>("getTransaction", [sig, { encoding: "json", maxSupportedTransactionVersion: 0 }], SOLANA_INDEX_RPCS).catch(() => null);
  return tx?.blockTime ?? 0;
}

function finding(b: Burn, status: WithdrawalStatus, note: string): Finding {
  const { txHash, txUrl } = txLink(b);
  const id = b.version === 1 ? `${b.src}-${b.nonce}` : (b.iris?.eventNonce ?? `${b.dst}-${b.amount}`);
  return makeFinding(CCTP, {
    key: `v${b.version}-${id}`,
    label: `Circle CCTP · ${nameOf(b.src)} → ${nameOf(b.dst)}`,
    status,
    asset: usdc(b.amount),
    txHash,
    txUrl,
    timestamp: b.timestamp,
    note,
  });
}

/* ───────────── Entry points ───────────── */

/** USDC the user burned on any EVM chain with CCTP and never received on the destination. */
export async function checkCctp(user: Address): Promise<CheckOutput> {
  const out: CheckOutput = { findings: [], completed: 0 };
  const errors: string[] = [];
  const found = await Promise.all(
    CCTP_DOMAINS.filter((d) => d.history).map(async (d) => {
      try {
        return (await cachedBurns(d, user)).map((b) => ({ ...b })); // settle() annotates its own copies
      } catch (e) {
        errors.push(`${d.name}: ${errMsg(e)}`);
        return [];
      }
    }),
  );
  await settle(found.flat(), out, errors);
  if (errors.length) out.error = errors.join(" · ");
  return out;
}

const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const u32le = (d: Uint8Array, o: number) => new DataView(d.buffer, d.byteOffset, d.byteLength).getUint32(o, true);

/**
 * CCTP messages sent from Solana whose account still exists: the rent payer can only close it
 * with Circle's attestation, which apps usually do after the mint. v1 accounts carry the
 * nonce; v2 ones don't, so their transaction is looked up to ask Circle.
 */
async function unreclaimedBurns(owner: string, errors: string[]): Promise<Burn[]> {
  const query = (program: string) =>
    solanaRpc<{ pubkey: string; account: { data: [string, string] } }[]>(
      "getProgramAccounts",
      [program, { encoding: "base64", filters: [{ memcmp: { offset: 8, bytes: owner } }] }],
      SOLANA_INDEX_RPCS,
    );
  const [a1, a2] = await Promise.all([query(SOLANA_V1.transmitter), query(SOLANA_V2.transmitter)]);
  if (a1.length + a2.length > MAX_SOLANA_ACCOUNTS) throw new Error(`${a1.length + a2.length} CCTP messages: too many to check automatically`);
  const v1Messenger = hexOf(base58.decode(SOLANA_V1.messenger));
  const v2Messenger = hexOf(base58.decode(SOLANA_V2.messenger));
  const burns: Burn[] = [];

  // v1 account: discriminator(8) rent_payer(32) message: vec<u8> (u32 length, then the bytes)
  for (const a of a1) {
    const d = b64(a.account.data[0]);
    if (d.length < 44) continue;
    const message = hexOf(d.subarray(44, 44 + u32le(d, 40)));
    const p = parseMessage(message);
    if (p?.version !== 1 || p.src !== SOLANA || !same32(p.messenger, v1Messenger)) continue; // not a USDC burn
    burns.push({ version: 1, src: SOLANA, dst: p.dst, timestamp: 0, amount: p.amount, mintRecipient: p.mintRecipient, caller: p.caller, sender: p.sender, nonce: BigInt(p.nonce), message, account: a.pubkey });
  }

  // v2 account: discriminator(8) rent_payer(32) created_at(i64) message: vec<u8>. Its nonce is zero (Circle assigns it).
  const v2: Burn[] = [];
  for (const a of a2) {
    const d = b64(a.account.data[0]);
    if (d.length < 52) continue;
    const message = hexOf(d.subarray(52, 52 + u32le(d, 48)));
    const p = parseMessage(message);
    if (p?.version !== 2 || p.src !== SOLANA || !same32(p.messenger, v2Messenger)) continue;
    const createdAt = Number(new DataView(d.buffer, d.byteOffset, d.byteLength).getBigInt64(40, true));
    v2.push({ version: 2, src: SOLANA, dst: p.dst, timestamp: createdAt, amount: p.amount, mintRecipient: p.mintRecipient, caller: p.caller, sender: p.sender, account: a.pubkey });
  }
  // The burn is the account's first (and, until the account is closed, only) transaction.
  await mapLimit(
    v2.filter((b) => checkable(b.dst, 2)),
    3,
    async (b) => {
      try {
        b.tx = await firstSignature(b.account!);
      } catch (e) {
        b.skip = true;
        errors.push(`Solana message ${b.account!.slice(0, 8)}…: ${errMsg(e)}`);
      }
    },
  );
  return [...burns, ...v2];
}

async function firstSignature(account: string): Promise<string> {
  // An empty history means the node doesn't keep it that far back: ask the next one.
  for (const url of SOLANA_INDEX_RPCS) {
    const sigs = await solanaRpc<{ signature: string; err: unknown }[]>("getSignaturesForAddress", [account, { limit: 50 }], [url]).catch(() => []);
    const ok = sigs.filter((s) => !s.err);
    if (ok.length) return ok[ok.length - 1].signature;
  }
  throw new Error("its transaction wasn't found");
}

/** Burns among the wallet's newest USDC transactions (including those whose message account was closed). */
async function recentBurns(owner: string, sender: Hex): Promise<Burn[]> {
  const ata = associatedTokenAddress(owner, SOLANA_USDC);
  const sigs = await solanaRpc<{ signature: string; err: unknown; blockTime?: number }[]>(
    "getSignaturesForAddress",
    [ata, { limit: RECENT_SOLANA_TXS }],
    SOLANA_INDEX_RPCS,
  );
  const burns: Burn[] = [];
  // Circle's API answers 404 for anything that isn't a CCTP burn.
  await mapLimit(
    sigs.filter((s) => !s.err),
    IRIS_IN_FLIGHT,
    async (s) => {
      const res = await irisMessages(SOLANA, `transactionHash=${s.signature}`);
      for (const m of res?.messages ?? []) {
        const p = m.message ? parseMessage(m.message) : null;
        if (!p || p.src !== SOLANA || !same32(p.sender, sender)) continue;
        const version = p.version as 1 | 2;
        burns.push({
          version,
          src: SOLANA,
          dst: p.dst,
          tx: s.signature,
          timestamp: s.blockTime ?? 0,
          amount: p.amount,
          mintRecipient: p.mintRecipient,
          caller: p.caller,
          sender: p.sender,
          nonce: version === 1 ? BigInt(p.nonce) : undefined,
          message: m.message as Hex,
          iris: m,
        });
      }
    },
  );
  return burns;
}

/**
 * USDC the user burned on Solana (v1 and v2, to any EVM chain) and never received.
 * Found from the wallet's CCTP message accounts (every burn whose account wasn't closed),
 * and from its newest USDC transactions.
 */
export async function checkCctpFromSolana(owner: string): Promise<CheckOutput> {
  const out: CheckOutput = { findings: [], completed: 0 };
  const errors: string[] = [];
  const sender = hexOf(base58.decode(owner));
  const [unreclaimed, recent] = await Promise.all([
    unreclaimedBurns(owner, errors).catch((e) => (errors.push(`Solana message accounts: ${errMsg(e)}`), [] as Burn[])),
    recentBurns(owner, sender).catch((e) => (errors.push(`Solana history: ${errMsg(e)}`), [] as Burn[])),
  ]);
  // The same burn can come from both: v1 by nonce, v2 by transaction.
  const seen = new Set<string>();
  const burns: Burn[] = [];
  for (const b of [...recent, ...unreclaimed]) {
    const k = b.version === 1 ? `1:${b.nonce}` : `2:${b.tx ?? b.account}`;
    if (seen.has(k)) continue;
    seen.add(k);
    burns.push(b);
  }
  await settle(burns, out, errors);
  if (errors.length) out.error = errors.join(" · ");
  return out;
}
