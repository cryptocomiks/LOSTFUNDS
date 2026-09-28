import { createPublicClient, fallback, http, type Chain, type PublicClient } from "viem";
import {
  abstract,
  arbitrum,
  arc,
  avalanche,
  base,
  berachain,
  bitrock,
  bob,
  bsc,
  cronos,
  cronoszkEVM,
  crossfi,
  fantom,
  flowMainnet,
  gnosis,
  hyperEvm,
  injective,
  lightlinkPhoenix,
  linea,
  mainnet,
  mantle,
  megaeth,
  metis,
  monad,
  neonMainnet,
  optimism,
  plasma,
  plumeMainnet,
  polygon,
  robinhood,
  sei,
  sonic,
  sophon,
  story,
  zilliqa,
} from "viem/chains";

/**
 * EVM chains that cross-chain bridges (deBridge, CCTP, Wormhole…) can start or end on.
 * Used to name routes, price tokens and double-check bridge contracts on-chain.
 */
export interface EvmChain {
  id: number;
  name: string;
  chain: Chain;
  /** Public JSON-RPC endpoints (CORS-enabled), tried in order. */
  rpcs: string[];
  /** Chain slug on DefiLlama's price API. */
  llama: string;
  /** DefiLlama key for the native coin. */
  nativePrice: string;
}

const pn = (sub: string) => `https://${sub}.publicnode.com`;
const drpc = (sub: string) => `https://${sub}.drpc.org`;

const def = (chain: Chain, name: string, llama: string, nativePrice: string, rpcs: string[]): EvmChain => ({
  id: chain.id,
  name,
  chain,
  rpcs: [...rpcs, ...chain.rpcUrls.default.http.filter((u) => !rpcs.includes(u))],
  llama,
  nativePrice,
});

export const EVM_CHAINS: EvmChain[] = [
  def(mainnet, "Ethereum", "ethereum", "coingecko:ethereum", [pn("ethereum-rpc"), drpc("eth"), "https://1rpc.io/eth"]),
  def(optimism, "Optimism", "optimism", "coingecko:ethereum", [pn("optimism-rpc"), "https://mainnet.optimism.io", drpc("optimism")]),
  def(bsc, "BNB Chain", "bsc", "coingecko:binancecoin", [pn("bsc-rpc"), drpc("bsc"), "https://1rpc.io/bnb"]),
  def(polygon, "Polygon", "polygon", "coingecko:polygon-ecosystem-token", [pn("polygon-bor-rpc"), drpc("polygon"), "https://1rpc.io/matic"]),
  def(base, "Base", "base", "coingecko:ethereum", [pn("base-rpc"), "https://mainnet.base.org", drpc("base")]),
  def(arbitrum, "Arbitrum", "arbitrum", "coingecko:ethereum", [pn("arbitrum-one-rpc"), "https://arb1.arbitrum.io/rpc", drpc("arbitrum")]),
  def(avalanche, "Avalanche", "avax", "coingecko:avalanche-2", [pn("avalanche-c-chain-rpc"), "https://api.avax.network/ext/bc/C/rpc", drpc("avalanche")]),
  def(linea, "Linea", "linea", "coingecko:ethereum", [pn("linea-rpc"), "https://rpc.linea.build", drpc("linea")]),
  def(sonic, "Sonic", "sonic", "coingecko:sonic-3", [pn("sonic-rpc"), "https://rpc.soniclabs.com", drpc("sonic")]),
  def(gnosis, "Gnosis", "xdai", "coingecko:xdai", [pn("gnosis-rpc"), "https://rpc.gnosischain.com", drpc("gnosis")]),
  def(cronos, "Cronos", "cronos", "coingecko:crypto-com-chain", [pn("cronos-evm-rpc"), "https://evm.cronos.org", drpc("cronos")]),
  def(hyperEvm, "HyperEVM", "hyperliquid", "coingecko:hyperliquid", ["https://rpc.hyperliquid.xyz/evm", drpc("hyperliquid")]),
  def(megaeth, "MegaETH", "megaeth", "coingecko:ethereum", ["https://mainnet.megaeth.com/rpc"]),
  def(monad, "Monad", "monad", "coingecko:monad", ["https://rpc.monad.xyz", drpc("monad-mainnet")]),
  def(story, "Story", "story", "coingecko:story-2", ["https://mainnet.storyrpc.io", drpc("story")]),
  def(metis, "Metis", "metis", "coingecko:metis-token", ["https://andromeda.metis.io/?owner=1088", drpc("metis")]),
  def(abstract, "Abstract", "abstract", "coingecko:ethereum", ["https://api.mainnet.abs.xyz"]),
  def(berachain, "Berachain", "berachain", "coingecko:berachain-bera", [pn("berachain-rpc"), "https://rpc.berachain.com", drpc("berachain")]),
  def(sei, "Sei", "sei", "coingecko:sei-network", ["https://evm-rpc.sei-apis.com", drpc("sei")]),
  def(injective, "Injective", "injective", "coingecko:injective-protocol", ["https://sentry.evm-rpc.injective.network"]),
  def(robinhood, "Robinhood Chain", "robinhood", "coingecko:ethereum", ["https://rpc.mainnet.chain.robinhood.com"]),
  def(arc, "Arc", "arc", "coingecko:usd-coin", ["https://rpc.mainnet.arc.io"]),
  def(fantom, "Fantom", "fantom", "coingecko:fantom", [pn("fantom-rpc"), drpc("fantom"), "https://rpcapi.fantom.network"]),
  def(mantle, "Mantle", "mantle", "coingecko:mantle", [pn("mantle-rpc"), "https://rpc.mantle.xyz", drpc("mantle")]),
  def(bob, "BOB", "bob", "coingecko:ethereum", ["https://rpc.gobob.xyz", drpc("bob")]),
  def(plasma, "Plasma", "plasma", "coingecko:plasma", ["https://rpc.plasma.to"]),
  def(plumeMainnet, "Plume", "plume_mainnet", "coingecko:plume", ["https://rpc.plume.org"]),
  def(sophon, "Sophon", "sophon", "coingecko:sophon", ["https://rpc.sophon.xyz"]),
  def(flowMainnet, "Flow", "flow", "coingecko:flow", ["https://mainnet.evm.nodes.onflow.org"]),
  def(cronoszkEVM, "Cronos zkEVM", "cronos_zkevm", "coingecko:crypto-com-chain", ["https://mainnet.zkevm.cronos.org"]),
  def(neonMainnet, "Neon", "neon", "coingecko:neon", ["https://neon-proxy-mainnet.solana.p2p.org"]),
  def(lightlinkPhoenix, "LightLink", "lightlink_phoenix", "coingecko:lightlink", ["https://replicator.phoenix.lightlink.io/rpc/v1"]),
  def(crossfi, "CrossFi", "crossfi", "coingecko:crossfi-2", ["https://rpc.mainnet.ms"]),
  def(zilliqa, "Zilliqa", "zilliqa", "coingecko:zilliqa", ["https://api.zilliqa.com"]),
  def(bitrock, "Bitrock", "bitrock", "coingecko:bitrock", ["https://brockrpc.io"]),
];

export const evmChain = (id: number) => EVM_CHAINS.find((c) => c.id === id);

const clients = new Map<number, PublicClient>();

/** A read-only client for an EVM chain in the registry (multicall batching, RPC fallbacks). */
export function evmClient(id: number): PublicClient | undefined {
  const c = evmChain(id);
  if (!c) return undefined;
  let client = clients.get(id);
  if (!client) {
    client = createPublicClient({
      chain: c.chain,
      transport: fallback(
        c.rpcs.map((url) => http(url, { timeout: 15_000, retryCount: 1, batch: { wait: 16 } })),
        { rank: false },
      ),
      batch: c.chain.contracts?.multicall3 ? { multicall: { wait: 16 } } : undefined,
    }) as PublicClient;
    clients.set(id, client);
  }
  return client;
}
