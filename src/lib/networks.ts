import { defineChain, type Address, type Chain } from "viem";
import {
  abstract,
  arbitrum,
  arbitrumNova,
  base,
  blast,
  boba,
  bob,
  celo,
  codex,
  cronoszkEVM,
  cyber,
  dbkchain,
  fraxtal,
  funkiMainnet,
  gravity,
  hashkey,
  hemi,
  ink,
  lens,
  linea,
  lisk,
  lyra,
  mainnet,
  manta,
  mantle,
  megaeth,
  metalL2,
  mode,
  optimism,
  orderly,
  plumeMainnet,
  rise,
  robinhood,
  scroll,
  shape,
  soneium,
  sophon,
  superseed,
  unichain,
  worldchain,
  zksync,
  zora,
} from "viem/chains";
import { chainConfig } from "viem/op-stack";

export type Family = "opstack" | "arbitrum" | "scroll" | "linea" | "zksync";

export interface Network {
  id: string;
  name: string;
  family: Family;
  chain: Chain;
  /** Public JSON-RPC endpoints, tried in order. */
  rpcs: string[];
  /** Blockscout API base (no key needed). Absent when the chain's explorer isn't Blockscout. */
  blockscout?: string;
  /** Another Etherscan-compatible API (e.g. Routescan), for chains without a Blockscout explorer. */
  api?: string;
  /** RPC nodes that accept eth_getLogs over the whole history (checked live), tried in order. */
  logsRpcs?: string[];
  /** Largest block span `logsRpcs` accept per eth_getLogs call: longer histories are searched in chunks. */
  logsRange?: number;
  /** Chain slug on DefiLlama's price API. */
  llama: string;
  explorer: string;
  /** Guide section (see content/guides.ts). */
  guideId: string;
  /** Official bridge UI. Shown as text: users should type it themselves. */
  bridgeUrl: string;
  /**
   * Family-specific L1 / L2 contract addresses. Arbitrum chains with their own gas token also set
   * `nativeToken`: that token's address on Ethereum (withdrawals of the gas token are paid out in it).
   */
  contracts: Record<string, Address | Address[]>;
  /** L2s whose native currency isn't ETH: the Ethereum token it is bridged from (+ price key if DefiLlama lacks it). */
  nativeToken?: { l1Token: Address; priceKey?: string };
}

export const L1 = {
  name: "Ethereum",
  chain: mainnet as Chain,
  blockscout: "https://eth.blockscout.com",
  logsRpcs: ["https://rpc.mevblocker.io", "https://gateway.tenderly.co/public/mainnet"],
  // On Ethereum these RPC nodes answer full-history event searches in ~1s; Blockscout can take >40s.
  preferRpc: true,
  rpcs: [
    "https://ethereum-rpc.publicnode.com",
    "https://eth.llamarpc.com",
    "https://eth.drpc.org",
    "https://1rpc.io/eth",
  ],
};

/**
 * viem's OP Stack actions read a chain's Ethereum contracts from its definition. Adds the ones it lacks:
 * the OptimismPortal, and the DisputeGameFactory or L2OutputOracle that portal uses today (read on-chain).
 * Several chains also moved to fault proofs after viem's definitions were written.
 */
function withL1(chain: Chain, contracts: { portal?: Address; disputeGameFactory?: Address; l2OutputOracle?: Address }): Chain {
  const l1 = Object.fromEntries(Object.entries(contracts).map(([name, address]) => [name, { [mainnet.id]: { address } }]));
  return { ...chain, contracts: { ...chain.contracts, ...l1 } };
}

/** OP Stack chains viem doesn't define (ETH as native currency). */
function opChain(id: number, name: string, rpc: string, explorer: string): Chain {
  return defineChain({
    ...chainConfig,
    id,
    name,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
    blockExplorers: { default: { name, url: explorer } },
  });
}

const OP_STACK: Network[] = [
  {
    id: "base",
    name: "Base",
    chain: base,
    rpcs: ["https://mainnet.base.org", "https://base-rpc.publicnode.com", "https://base.drpc.org", "https://1rpc.io/base"],
    blockscout: "https://base.blockscout.com",
    llama: "base",
    explorer: "https://basescan.org",
    bridgeUrl: "superbridge.app/base",
  },
  {
    id: "optimism",
    name: "OP Mainnet",
    chain: optimism,
    rpcs: ["https://mainnet.optimism.io", "https://optimism-rpc.publicnode.com", "https://optimism.drpc.org", "https://1rpc.io/op"],
    blockscout: "https://explorer.optimism.io", // optimism.blockscout.com redirects here
    llama: "optimism",
    explorer: "https://optimistic.etherscan.io",
    bridgeUrl: "superbridge.app/optimism",
  },
  {
    id: "mantle",
    name: "Mantle",
    chain: withL1(mantle, { portal: "0xc54cb22944F2bE476E02dECfCD7e3E7d3e15A8Fb", l2OutputOracle: "0x31d543e7BE1dA6eFDc2206Ef7822879045B9f481" }),
    // Not mantle-rpc.publicnode.com: it answers null for old receipts.
    rpcs: ["https://rpc.mantle.xyz", "https://mantle.gateway.tenderly.co", "https://mantle.drpc.org"],
    api: "https://api.routescan.io/v2/network/mainnet/evm/5000/etherscan", // Mantle's own Blockscout is down
    logsRpcs: ["https://mantle.gateway.tenderly.co"],
    llama: "mantle",
    explorer: "https://mantlescan.xyz",
    bridgeUrl: "app.mantle.xyz/bridge",
    nativeToken: { l1Token: "0x3c3a81e81dc49A522A592e7622A7E711c06bf354" as Address }, // MNT
  },
  {
    id: "zora",
    name: "Zora",
    chain: zora,
    rpcs: ["https://rpc.zora.energy", "https://zora.drpc.org"],
    logsRpcs: ["https://rpc.zora.energy"], // Zora's explorer is no longer Blockscout
    llama: "zora",
    explorer: "https://explorer.zora.energy",
    bridgeUrl: "superbridge.app/zora",
  },
  {
    id: "mode",
    name: "Mode",
    chain: mode,
    rpcs: ["https://mainnet.mode.network", "https://mode.drpc.org"],
    blockscout: "https://explorer.mode.network",
    logsRpcs: ["https://mainnet.mode.network"],
    llama: "mode",
    explorer: "https://explorer.mode.network",
    bridgeUrl: "superbridge.app/mode",
  },
  {
    id: "unichain",
    name: "Unichain",
    chain: unichain,
    rpcs: ["https://mainnet.unichain.org", "https://unichain-rpc.publicnode.com", "https://unichain.drpc.org"],
    blockscout: "https://unichain.blockscout.com",
    llama: "unichain",
    explorer: "https://uniscan.xyz",
    bridgeUrl: "superbridge.app/unichain",
  },
  {
    id: "ink",
    name: "Ink",
    chain: ink,
    rpcs: ["https://rpc-gel.inkonchain.com", "https://rpc-qnd.inkonchain.com", "https://ink.drpc.org"],
    blockscout: "https://explorer.inkonchain.com",
    llama: "ink",
    explorer: "https://explorer.inkonchain.com",
    bridgeUrl: "superbridge.app/ink",
  },
  {
    id: "soneium",
    name: "Soneium",
    chain: soneium,
    rpcs: ["https://rpc.soneium.org", "https://soneium.drpc.org"],
    blockscout: "https://soneium.blockscout.com",
    llama: "soneium",
    explorer: "https://soneium.blockscout.com",
    bridgeUrl: "superbridge.app/soneium",
  },
  {
    id: "worldchain",
    name: "World Chain",
    chain: worldchain,
    rpcs: ["https://worldchain-mainnet.g.alchemy.com/public", "https://worldchain.drpc.org", "https://480.rpc.thirdweb.com"],
    blockscout: "https://worldchain-mainnet.explorer.alchemy.com",
    llama: "wc",
    explorer: "https://worldscan.org",
    bridgeUrl: "the official World Chain bridge",
  },
  {
    id: "blast",
    name: "Blast",
    chain: blast,
    rpcs: ["https://rpc.blast.io", "https://blast-rpc.publicnode.com", "https://blast.drpc.org"],
    api: "https://api.routescan.io/v2/network/mainnet/evm/81457/etherscan", // Blast has no Blockscout explorer
    llama: "blast",
    explorer: "https://blastscan.io",
    bridgeUrl: "blast.io",
    extraBridges: ["0x4300000000000000000000000000000000000005" as Address], // L2BlastBridge
  },
  {
    id: "celo",
    name: "Celo",
    chain: withL1(celo, { portal: "0xc5c5D157928BDBD2ACf6d0777626b6C75a9EAEDC", disputeGameFactory: "0xFbAC162162f4009Bb007C6DeBC36B1dAC10aF683" }),
    // Not forno.celo.org: it answers null for many receipts since Celo became an L2 (March 2025).
    rpcs: ["https://celo.gateway.tenderly.co", "https://rpc.ankr.com/celo"],
    blockscout: "https://celo.blockscout.com",
    logsRpcs: ["https://celo.gateway.tenderly.co"],
    llama: "celo",
    explorer: "https://celo.blockscout.com",
    bridgeUrl: "the official Celo bridge",
    nativeToken: { l1Token: "0x057898f3C43F129a17517B9056D23851F124b19f" as Address, priceKey: "coingecko:celo" }, // CELO
  },
  {
    id: "manta-pacific",
    name: "Manta Pacific",
    chain: withL1(manta, { portal: "0x9168765EE952de7C6f8fC6FaD5Ec209B960b7622", l2OutputOracle: "0x30c789674ad3B458886BBC9abf42EEe19EA05C1D" }),
    rpcs: ["https://pacific-rpc.manta.network/http", "https://manta-pacific.drpc.org"],
    blockscout: "https://pacific-explorer.manta.network",
    llama: "manta",
    explorer: "https://pacific-explorer.manta.network",
    bridgeUrl: "pacific-bridge.manta.network",
  },
  {
    id: "lisk",
    name: "Lisk",
    chain: lisk,
    rpcs: ["https://rpc.api.lisk.com", "https://lisk.drpc.org"],
    blockscout: "https://blockscout.lisk.com",
    llama: "lisk",
    explorer: "https://blockscout.lisk.com",
    bridgeUrl: "superbridge.app/lisk",
  },
  {
    id: "fraxtal",
    name: "Fraxtal",
    chain: fraxtal,
    rpcs: ["https://rpc.frax.com", "https://fraxtal.drpc.org"],
    logsRpcs: ["https://rpc.frax.com"],
    llama: "fraxtal",
    explorer: "https://fraxscan.com",
    bridgeUrl: "frax.com",
  },
  {
    id: "bob",
    name: "BOB",
    chain: withL1(bob, { disputeGameFactory: "0x96123dbFC3253185B594c6a7472EE5A21E9B1079" }),
    rpcs: ["https://rpc.gobob.xyz", "https://bob.drpc.org"],
    logsRpcs: ["https://rpc.gobob.xyz"],
    llama: "bob",
    explorer: "https://explorer.gobob.xyz",
    bridgeUrl: "app.gobob.xyz",
  },
  {
    id: "megaeth",
    name: "MegaETH",
    chain: megaeth,
    rpcs: ["https://mainnet.megaeth.com/rpc"],
    blockscout: "https://megaeth.blockscout.com",
    logsRpcs: ["https://mainnet.megaeth.com/rpc"],
    llama: "megaeth",
    explorer: "https://mega.etherscan.io",
    bridgeUrl: "the official MegaETH bridge",
  },
  {
    id: "shape",
    name: "Shape",
    chain: withL1(shape, { disputeGameFactory: "0x2c03e8BF8b16Af89079852BE87f0e9eC674a5952" }),
    rpcs: ["https://mainnet.shape.network", "https://shape.drpc.org"],
    blockscout: "https://shapescan.xyz",
    llama: "shape",
    explorer: "https://shapescan.xyz",
    bridgeUrl: "the official Shape bridge",
  },
  {
    id: "boba",
    name: "Boba Network",
    chain: withL1(boba, { portal: "0x7B02D13904D8e6E0f0Efaf756aB14Cb0FF21eE7e", disputeGameFactory: "0xF45a5f1e36fCeA3Cc830A98c6c3C5ceA7d6af852" }),
    rpcs: ["https://mainnet.boba.network", "https://boba-ethereum.gateway.tenderly.co", "https://boba-eth.drpc.org"],
    api: "https://api.routescan.io/v2/network/mainnet/evm/288/etherscan", // Boba has no Blockscout explorer
    logsRpcs: ["https://boba-ethereum.gateway.tenderly.co"],
    llama: "boba",
    explorer: "https://bobascan.com",
    bridgeUrl: "hub.boba.network",
  },
  {
    id: "hashkey",
    name: "HashKey Chain",
    chain: withL1(hashkey, { portal: "0xe7Aa79B59CAc06F9706D896a047fEb9d3BDA8bD3", disputeGameFactory: "0x04Ec030f362CE5A0b5Fe2d4B4219f287C2EBDE50" }),
    rpcs: ["https://mainnet.hsk.xyz"], // not hashkey.drpc.org: it answers null for old receipts
    blockscout: "https://hsk.blockscout.com",
    llama: "hsk",
    explorer: "https://hsk.blockscout.com",
    bridgeUrl: "the official HashKey Chain bridge",
    nativeToken: { l1Token: "0xE7C6BF469e97eEB0bFB74C8dbFF5BD47D4C1C98a" as Address }, // HSK
  },
  {
    id: "hemi",
    name: "Hemi",
    chain: withL1(hemi, { portal: "0x39a0005415256B9863aFE2d55Edcf75ECc3A4D7e", l2OutputOracle: "0x6daF3a3497D8abdFE12915aDD9829f83A79C0d51" }),
    rpcs: ["https://rpc.hemi.network/rpc", "https://hemi.drpc.org"],
    blockscout: "https://explorer.hemi.xyz",
    api: "https://api.routescan.io/v2/network/mainnet/evm/43111/etherscan",
    llama: "hemi",
    explorer: "https://explorer.hemi.xyz",
    bridgeUrl: "app.hemi.xyz",
  },
  {
    id: "metal",
    name: "Metal L2",
    chain: withL1(metalL2, { disputeGameFactory: "0x7BFfF391A2dbbDc68A259792AC9748F50FcDE93E" }),
    rpcs: ["https://rpc.metall2.com", "https://metall2.drpc.org"],
    blockscout: "https://explorer.metall2.com",
    logsRpcs: ["https://rpc.metall2.com"],
    llama: "metal",
    explorer: "https://explorer.metall2.com",
    bridgeUrl: "superbridge.app/metal",
  },
  {
    id: "superseed",
    name: "Superseed",
    chain: withL1(superseed, { disputeGameFactory: "0x657c1b0e31FFc69A02B207Be20699bDFF938c7E7" }),
    rpcs: ["https://mainnet.superseed.xyz", "https://superseed.drpc.org"],
    logsRpcs: ["https://mainnet.superseed.xyz"],
    llama: "superseed",
    explorer: "https://explorer.superseed.xyz",
    bridgeUrl: "superbridge.app/superseed",
  },
  {
    id: "codex",
    name: "Codex",
    chain: codex,
    rpcs: ["https://rpc.codex.xyz"],
    logsRpcs: ["https://rpc.codex.xyz"],
    llama: "codex",
    explorer: "https://explorer.codex.xyz",
    bridgeUrl: "the official Codex bridge",
  },
  {
    id: "dbk",
    name: "DBK Chain",
    chain: withL1(dbkchain, { portal: "0x63CA00232F471bE2A3Bf3C4e95Bc1d2B3EA5DB92", l2OutputOracle: "0x0341bb689CB8a4c16c61307F4BdA254E1bFD525e" }),
    rpcs: ["https://rpc.mainnet.dbkchain.io"],
    api: "https://scan.dbkchain.io", // Etherscan-style API only (its Blockscout v2 API is disabled)
    llama: "dbk",
    explorer: "https://scan.dbkchain.io",
    bridgeUrl: "the official DBK Chain bridge",
  },
  {
    id: "cyber",
    name: "Cyber",
    chain: withL1(cyber, { portal: "0x1d59bc9fcE6B8E2B1bf86D4777289FFd83D24C99", disputeGameFactory: "0xaCc66304d26a01A9bd60d0584dCEdbaCeC8e10e0" }),
    rpcs: ["https://rpc.cyber.co", "https://cyber.alt.technology"],
    blockscout: "https://cyberscan.co",
    llama: "cyber",
    explorer: "https://cyberscan.co",
    bridgeUrl: "the official Cyber bridge",
  },
  {
    id: "orderly",
    name: "Orderly",
    chain: withL1(orderly, { portal: "0x91493a61ab83b62943E6dCAa5475Dd330704Cc84", disputeGameFactory: "0xC8BF04A73704051E5E274F1B43B1F2F153Db2136" }),
    rpcs: ["https://rpc.orderly.network"],
    logsRpcs: ["https://rpc.orderly.network"], // no explorer API
    llama: "orderly",
    explorer: "https://explorer.orderly.network",
    bridgeUrl: "the official Orderly bridge",
  },
  {
    id: "rise",
    name: "RISE",
    chain: withL1(rise, { portal: "0xad92Fa18EB74E46Db844240623124BF46589db4C", disputeGameFactory: "0x6A4139810986CF13408330e14C4ac9Daf0511aA3" }),
    rpcs: ["https://rpc.risechain.com"],
    blockscout: "https://explorer.risechain.com",
    llama: "rise",
    explorer: "https://explorer.risechain.com",
    bridgeUrl: "the official RISE bridge",
  },
  {
    id: "derive",
    name: "Derive",
    chain: withL1(lyra, { portal: "0x85eA9c11cf3D4786027F7FD08F4406b15777e5f8", disputeGameFactory: "0x87DAFf495b5F6c4f79CEeAAF85f1Ef3df3B30d21" }),
    rpcs: ["https://rpc.derive.xyz", "https://rpc.lyra.finance"],
    blockscout: "https://explorer.derive.xyz",
    logsRpcs: ["https://rpc.derive.xyz"],
    llama: "derive",
    explorer: "https://explorer.derive.xyz",
    bridgeUrl: "the official Derive bridge",
  },
  {
    id: "funki",
    name: "Funki",
    chain: withL1(funkiMainnet, { portal: "0x5C9C7f98eD153a2deAA981eB5C97B31744AccF22", disputeGameFactory: "0xc371fD8C4AB7F585BDCA7aA19c2A680a70920c98" }),
    rpcs: ["https://rpc-mainnet.funkichain.com"],
    blockscout: "https://explorer.funkichain.com",
    llama: "funki",
    explorer: "https://explorer.funkichain.com",
    bridgeUrl: "the official Funki bridge",
  },
  {
    id: "nillion",
    name: "Nillion",
    chain: withL1(opChain(98875, "Nillion", "https://rpc.nillion.network", "https://explorer.nillion.network"), {
      portal: "0x7b96e2c80696D5D2d673f0EA62b67352E18747C0",
      disputeGameFactory: "0x5931f05809932a43C2A6c86f3F9BC2788f840b1C",
    }),
    rpcs: ["https://rpc.nillion.network"],
    logsRpcs: ["https://rpc.nillion.network"], // no explorer API
    llama: "nillion",
    explorer: "https://explorer.nillion.network",
    bridgeUrl: "the official Nillion bridge",
  },
  {
    id: "towns",
    name: "Towns",
    chain: withL1(opChain(550, "Towns", "https://mainnet.rpc.river.build", "https://explorer.river.build"), {
      portal: "0x9fDEEa19836A413C04e9672d3d09f482278e863c",
      l2OutputOracle: "0x29E7177837652ca00f05fbD2e8aA867d207B2EF8",
    }),
    rpcs: ["https://mainnet.rpc.river.build"],
    api: "https://explorer.river.build", // a Blockscout, but its v2 API takes 20-40 s: use the Etherscan-style one
    llama: "towns",
    explorer: "https://explorer.river.build",
    bridgeUrl: "the official Towns bridge",
  },
  {
    id: "phala",
    name: "Phala",
    chain: withL1(opChain(2035, "Phala", "https://rpc.phala.network", "https://explorer.phala.network"), {
      portal: "0x96B124841Eff4Ab1b3C1F654D60402a1405fF51A",
      disputeGameFactory: "0x2157F4d5934c4b12193C4983E99b9D6418798a2E",
    }),
    rpcs: ["https://rpc.phala.network"],
    logsRpcs: ["https://rpc.phala.network"], // no explorer API
    llama: "phala",
    explorer: "https://explorer.phala.network",
    bridgeUrl: "the official Phala bridge",
  },
].map(({ extraBridges, ...n }: Omit<Network, "family" | "guideId" | "contracts"> & { extraBridges?: Address[] }): Network => ({
  ...n,
  family: "opstack" as const,
  guideId: "opstack",
  contracts: {
    ...(extraBridges && { extraBridges }),
    // Same predeploy addresses on every OP Stack chain.
    l2StandardBridge: "0x4200000000000000000000000000000000000010",
    l2ToL1MessagePasser: "0x4200000000000000000000000000000000000016",
    l2CrossDomainMessenger: "0x4200000000000000000000000000000000000007",
  } as Network["contracts"],
}));

/**
 * ZKsync Era and the ZK Stack chains that settle on Ethereum. They share the L1 bridge contracts
 * (see checks/zksync.ts); per chain: its diamond on Ethereum (Bridgehub.getZKChain), its legacy
 * L2 bridge (zks_getBridgeContracts) and, for custom gas tokens, the base token's L1 address
 * (Bridgehub.baseToken). Only the chains' own RPC nodes serve zks_getL2ToL1LogProof (and full
 * receipts); history comes from their full-history event search, plus Blockscout for Era. The
 * chains' own explorer APIs ignore topic filters in event searches, so they aren't used.
 */
const ZK_STACK_CHAINS: Omit<Network, "family" | "guideId">[] = [
  {
    id: "zksync",
    name: "ZKsync Era",
    chain: zksync,
    rpcs: ["https://mainnet.era.zksync.io"],
    blockscout: "https://zksync.blockscout.com",
    logsRpcs: ["https://mainnet.era.zksync.io"],
    llama: "era",
    explorer: "https://explorer.zksync.io",
    bridgeUrl: "portal.zksync.io",
    contracts: {
      diamond: "0x32400084C286CF3E17e7B677ea9583e60a000324",
      l2LegacyBridge: "0x11f943b2c77b743AB90f4A0Ae7d5A4e7FCA3E102",
    },
  },
  {
    id: "abstract",
    name: "Abstract",
    chain: abstract,
    rpcs: ["https://api.mainnet.abs.xyz"],
    logsRpcs: ["https://api.mainnet.abs.xyz"],
    llama: "abstract",
    explorer: "https://abscan.org",
    bridgeUrl: "the official Abstract bridge",
    contracts: {
      diamond: "0x2EDc71E9991A962c7FE172212d1aA9E50480fBb9",
      l2LegacyBridge: "0x954ba8223a6bfec1cc3867139243a02ba0bc66e4",
    },
  },
  {
    id: "sophon",
    name: "Sophon",
    chain: sophon,
    rpcs: ["https://rpc.sophon.xyz"],
    logsRpcs: ["https://rpc.sophon.xyz"],
    llama: "sophon",
    explorer: "https://explorer.sophon.xyz",
    bridgeUrl: "portal.sophon.xyz",
    contracts: {
      diamond: "0x05eDE6aD1f39B7A16C949d5C33a0658c9C7241e3",
      l2LegacyBridge: "0x954ba8223a6bfec1cc3867139243a02ba0bc66e4",
      baseToken: "0x6B7774CB12ed7573a7586E7D0e62a2A563dDd3f0", // SOPH
    },
  },
  {
    id: "lens",
    name: "Lens",
    chain: lens,
    rpcs: ["https://rpc.lens.xyz", "https://api.lens.matterhosted.dev"],
    logsRpcs: ["https://rpc.lens.xyz", "https://api.lens.matterhosted.dev"],
    llama: "lens",
    explorer: "https://explorer.lens.xyz",
    bridgeUrl: "lens.xyz/bridge",
    contracts: {
      diamond: "0xc29d04A93F893700015138E3E334eB828dAC3cef",
      l2LegacyBridge: "0x8116a750e2091b2ba0d94223e7b20a6a65a279f4",
      baseToken: "0x1ff1dC3cB9eeDbC6Eb2d99C03b30A05cA625fB5a", // LGHO (Lens wrapped GHO)
    },
  },
  {
    id: "cronos-zkevm",
    name: "Cronos zkEVM",
    chain: cronoszkEVM,
    rpcs: ["https://mainnet.zkevm.cronos.org"],
    logsRpcs: ["https://mainnet.zkevm.cronos.org"],
    llama: "cronos_zkevm",
    explorer: "https://explorer.zkevm.cronos.org",
    bridgeUrl: "zkevm.cronos.org/bridge",
    contracts: {
      diamond: "0x7b2DA4e77BAE0e0d23c53C3BE6650497d0576CFc",
      l2LegacyBridge: "0x309429de3621992cb0ab8982a448c9cc5c38405b",
      baseToken: "0x28Ff2E4dD1B58efEB0fC138602A28D5aE81e44e2", // zkCRO
    },
  },
];
const ZK_STACK: Network[] = ZK_STACK_CHAINS.map((n) => ({ ...n, family: "zksync", guideId: "zksync" }));

export const NETWORKS: Network[] = [
  ...OP_STACK,
  {
    id: "arbitrum",
    name: "Arbitrum One",
    family: "arbitrum",
    chain: arbitrum,
    rpcs: ["https://arb1.arbitrum.io/rpc", "https://arbitrum-one-rpc.publicnode.com", "https://arbitrum.drpc.org", "https://1rpc.io/arb"],
    blockscout: "https://arbitrum.blockscout.com",
    logsRpcs: ["https://arb1.arbitrum.io/rpc"],
    llama: "arbitrum",
    explorer: "https://arbiscan.io",
    guideId: "arbitrum",
    bridgeUrl: "portal.arbitrum.io/bridge",
    contracts: {
      outbox: "0x0B9857ae2D4A3DBe74ffE1d7DF045bb7F96E4840",
      gatewayRouter: "0x5288c571Fd7aD117beA99bF60FE0846C4E84F933",
      gateways: [
        "0x09e9222E96E7B4AE2a407B98d48e330053351EEe", // L2 ERC20 gateway
        "0x096760F208390250649E3e8763348E783AEF5562", // L2 custom gateway
        "0x6c411aD3E74De3E7Bd422b94A27770f5B86C623B", // L2 WETH gateway
      ],
    },
  },
  {
    id: "arbitrum-nova",
    name: "Arbitrum Nova",
    family: "arbitrum",
    chain: arbitrumNova,
    rpcs: ["https://nova.arbitrum.io/rpc", "https://arbitrum-nova-rpc.publicnode.com", "https://arbitrum-nova.drpc.org"],
    blockscout: "https://arbitrum-nova.blockscout.com",
    llama: "arbitrum_nova",
    explorer: "https://nova.arbiscan.io",
    guideId: "arbitrum",
    bridgeUrl: "portal.arbitrum.io/bridge",
    contracts: {
      outbox: "0xD4B80C3D7240325D18E645B49e6535A3Bf95cc58",
      gatewayRouter: "0x21903d3F8176b1a0c17E953Cd896610Be9fFDFa8",
      gateways: [
        "0xcF9bAb7e53DDe48A6DC4f286CB14e05298799257", // L2 ERC20 gateway
        "0xbf544970E6BD77b21C6492C281AB60d0770451F4", // L2 custom gateway
        "0x7626841cB6113412F9c88D3ADC720C9FAC88D9eD", // L2 WETH gateway
      ],
    },
  },
  // Arbitrum Orbit chains that settle directly on Ethereum. Outbox = rollup.outbox() on Ethereum (its
  // Bridge's only allowed outbox); gateways = the L2 counterparts of the L1 router's gateways (checked on-chain).
  {
    id: "robinhood",
    name: "Robinhood Chain",
    family: "arbitrum",
    chain: robinhood,
    rpcs: ["https://rpc.mainnet.chain.robinhood.com"],
    // Its Blockscout sits behind a bot challenge: the RPC node is the only history source,
    // and it answers eth_getLogs over at most 10M blocks per call.
    logsRpcs: ["https://rpc.mainnet.chain.robinhood.com"],
    logsRange: 10_000_000,
    llama: "robinhood",
    explorer: "https://robinhoodchain.blockscout.com",
    guideId: "arbitrum",
    bridgeUrl: "the official Robinhood Chain bridge",
    contracts: {
      outbox: "0xf0ce991ea4A0d2400A4AB49b20ae333f6Dce3DE9",
      gatewayRouter: "0x1E324B9316138CA9a73F960213621AD1aaf01B89",
      gateways: [
        "0xfd9b17206278C16DdaacF6AC8f05dBf97EdCb31e", // L2 ERC20 gateway
        "0x1D187C3E2dA52D72BC9C41e3AbA0fdFa6a7bF055", // L2 WETH gateway
      ],
    },
  },
  {
    id: "plume",
    name: "Plume",
    family: "arbitrum",
    chain: plumeMainnet,
    rpcs: ["https://rpc.plume.org"],
    blockscout: "https://explorer.plume.org",
    logsRpcs: ["https://rpc.plume.org"],
    llama: "plume_mainnet",
    explorer: "https://explorer.plume.org",
    guideId: "arbitrum",
    bridgeUrl: "the official Plume bridge",
    contracts: {
      outbox: "0x7e4627bC114Fcd12ba912103279FD2858E644E71",
      gatewayRouter: "0xEFE6F45507C24Bb85Fa25d417fe7d43763b9dE3d",
      gateways: ["0x3955A911411cfae01c8B6Fd0D57c08DfE4428e38"], // L2 ERC20 gateway
      nativeToken: "0x4C1746A800D224393fE2470C70A35717eD4eA5F1", // PLUME on Ethereum
    },
  },
  {
    id: "gravity",
    name: "Gravity",
    family: "arbitrum",
    chain: gravity,
    rpcs: ["https://rpc.gravity.xyz"],
    logsRpcs: ["https://rpc.gravity.xyz"], // its explorer has no Blockscout-compatible API
    llama: "gravity",
    explorer: "https://explorer.gravity.xyz",
    guideId: "arbitrum",
    bridgeUrl: "the official Gravity bridge",
    contracts: {
      outbox: "0x1153a1e4B1523DFf36f77d696bd6eBF2B0e7DAbF",
      gatewayRouter: "0xf1cA401FB474520EbaBb285670891dEbd7C505Bc",
      gateways: ["0xD330E617270F375Bd476896f3A8AE9041264E13d"], // L2 ERC20 gateway
      nativeToken: "0x9C7BEBa8F6eF6643aBd725e45a4E8387eF260649", // G on Ethereum
    },
  },
  {
    id: "scroll",
    name: "Scroll",
    family: "scroll",
    chain: scroll,
    rpcs: ["https://rpc.scroll.io", "https://scroll-rpc.publicnode.com", "https://scroll.drpc.org", "https://1rpc.io/scroll"],
    logsRpcs: ["https://rpc.scroll.io"], // Scroll's Blockscout now redirects to Scrollscan (key required)
    llama: "scroll",
    explorer: "https://scrollscan.com",
    guideId: "scroll",
    bridgeUrl: "portal.scroll.io/bridge",
    contracts: {
      gatewayRouter: "0x4C0926FF5252A435FD19e10ED15e5a249Ba19d79",
      l2Messenger: "0x781e90f1c8Fc4611c9b7497C3B47F99Ef6969CbC",
      l1Messenger: "0x6774Bcbd5ceCeF1336b5300fb5186a12DDD8b367",
      ethGateway: "0x6EA73e05AdC79974B931123675ea8F78FfdacDF0",
      erc20Gateways: [
        "0xE2b4795039517653c5Ae8C2A9BFdd783b48f447A", // standard ERC20
        "0x64CCBE37c9A82D85A1F2E74649b7A42923067988", // custom ERC20
        "0x7003E7B7186f0E6601203b99F7B8DECBfA391cf9", // WETH
        "0x33B60d5Dd260d453cAC3782b0bDC01ce84672142", // USDC
      ],
    },
  },
  {
    id: "linea",
    name: "Linea",
    family: "linea",
    chain: linea,
    rpcs: ["https://rpc.linea.build", "https://linea-rpc.publicnode.com", "https://linea.drpc.org", "https://1rpc.io/linea"],
    blockscout: "https://api-explorer.linea.build", // API host behind explorer.linea.build
    llama: "linea",
    explorer: "https://lineascan.build",
    guideId: "linea",
    bridgeUrl: "linea.build/hub/bridge",
    contracts: {
      l2MessageService: "0x508Ca82Df566dCD1B0DE8296e70a96332cD644ec",
      l2TokenBridge: "0x353012dc4a9A6cF55c941bADC267f82004A8ceB9",
      l1Rollup: "0xd19d4B5d358258f05D7B411E21A1460D11B0876F",
    },
  },
  ...ZK_STACK,
];

export const networkById = (id: string) => NETWORKS.find((n) => n.id === id);
