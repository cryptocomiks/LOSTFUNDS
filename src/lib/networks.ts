import type { Address, Chain } from "viem";
import {
  arbitrum,
  arbitrumNova,
  base,
  ink,
  linea,
  mainnet,
  mode,
  optimism,
  scroll,
  soneium,
  unichain,
  zora,
} from "viem/chains";

export type Family = "opstack" | "arbitrum" | "scroll" | "linea";

export interface Network {
  id: string;
  name: string;
  family: Family;
  chain: Chain;
  /** Public JSON-RPC endpoints, tried in order. */
  rpcs: string[];
  /** Blockscout instance used to search logs by address (no API key needed). */
  blockscout: string;
  /** Chain slug on DefiLlama's price API. */
  llama: string;
  explorer: string;
  /** Guide section (see content/guides.ts). */
  guideId: string;
  /** Official bridge UI. Shown as text: users should type it themselves. */
  bridgeUrl: string;
  /** Family-specific L1 / L2 contract addresses. */
  contracts: Record<string, Address | Address[]>;
}

export const L1 = {
  name: "Ethereum",
  chain: mainnet as Chain,
  blockscout: "https://eth.blockscout.com",
  rpcs: [
    "https://ethereum-rpc.publicnode.com",
    "https://eth.llamarpc.com",
    "https://eth.drpc.org",
    "https://1rpc.io/eth",
  ],
};

const OP_STACK: Network[] = [
  {
    id: "base",
    name: "Base",
    chain: base,
    rpcs: ["https://mainnet.base.org", "https://base-rpc.publicnode.com"],
    blockscout: "https://base.blockscout.com",
    llama: "base",
    explorer: "https://basescan.org",
    bridgeUrl: "superbridge.app/base",
  },
  {
    id: "optimism",
    name: "OP Mainnet",
    chain: optimism,
    rpcs: ["https://mainnet.optimism.io", "https://optimism-rpc.publicnode.com"],
    blockscout: "https://optimism.blockscout.com",
    llama: "optimism",
    explorer: "https://optimistic.etherscan.io",
    bridgeUrl: "superbridge.app/optimism",
  },
  {
    id: "zora",
    name: "Zora",
    chain: zora,
    rpcs: ["https://rpc.zora.energy"],
    blockscout: "https://explorer.zora.energy",
    llama: "zora",
    explorer: "https://explorer.zora.energy",
    bridgeUrl: "superbridge.app/zora",
  },
  {
    id: "mode",
    name: "Mode",
    chain: mode,
    rpcs: ["https://mainnet.mode.network"],
    blockscout: "https://explorer.mode.network",
    llama: "mode",
    explorer: "https://explorer.mode.network",
    bridgeUrl: "superbridge.app/mode",
  },
  {
    id: "unichain",
    name: "Unichain",
    chain: unichain,
    rpcs: ["https://mainnet.unichain.org", "https://unichain-rpc.publicnode.com"],
    blockscout: "https://unichain.blockscout.com",
    llama: "unichain",
    explorer: "https://uniscan.xyz",
    bridgeUrl: "superbridge.app/unichain",
  },
  {
    id: "ink",
    name: "Ink",
    chain: ink,
    rpcs: ["https://rpc-gel.inkonchain.com", "https://rpc-qnd.inkonchain.com"],
    blockscout: "https://explorer.inkonchain.com",
    llama: "ink",
    explorer: "https://explorer.inkonchain.com",
    bridgeUrl: "superbridge.app/ink",
  },
  {
    id: "soneium",
    name: "Soneium",
    chain: soneium,
    rpcs: ["https://rpc.soneium.org"],
    blockscout: "https://soneium.blockscout.com",
    llama: "soneium",
    explorer: "https://soneium.blockscout.com",
    bridgeUrl: "superbridge.app/soneium",
  },
].map((n) => ({
  ...n,
  family: "opstack" as const,
  guideId: "opstack",
  contracts: {
    // Same predeploy addresses on every OP Stack chain.
    l2StandardBridge: "0x4200000000000000000000000000000000000010",
    l2ToL1MessagePasser: "0x4200000000000000000000000000000000000016",
    l2CrossDomainMessenger: "0x4200000000000000000000000000000000000007",
  } as Record<string, Address>,
}));

export const NETWORKS: Network[] = [
  ...OP_STACK,
  {
    id: "arbitrum",
    name: "Arbitrum One",
    family: "arbitrum",
    chain: arbitrum,
    rpcs: ["https://arb1.arbitrum.io/rpc", "https://arbitrum-one-rpc.publicnode.com"],
    blockscout: "https://arbitrum.blockscout.com",
    llama: "arbitrum",
    explorer: "https://arbiscan.io",
    guideId: "arbitrum",
    bridgeUrl: "portal.arbitrum.io/bridge",
    contracts: {
      outbox: "0x0B9857ae2D4A3DBe74ffE1d7DF045bb7F96E4840",
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
    rpcs: ["https://nova.arbitrum.io/rpc", "https://arbitrum-nova-rpc.publicnode.com"],
    blockscout: "https://arbitrum-nova.blockscout.com",
    llama: "arbitrum_nova",
    explorer: "https://nova.arbiscan.io",
    guideId: "arbitrum",
    bridgeUrl: "portal.arbitrum.io/bridge",
    contracts: {
      outbox: "0xD4B80C3D7240325D18E645B49e6535A3Bf95cc58",
      gateways: [
        "0xcF9bAb7e53DDe48A6DC4f286CB14e05298799257", // L2 ERC20 gateway
        "0xbf544970E6BD77b21C6492C281AB60d0770451F4", // L2 custom gateway
        "0x7626841cB6113412F9c88D3ADC720C9FAC88D9eD", // L2 WETH gateway
      ],
    },
  },
  {
    id: "scroll",
    name: "Scroll",
    family: "scroll",
    chain: scroll,
    rpcs: ["https://rpc.scroll.io", "https://scroll-rpc.publicnode.com"],
    blockscout: "https://scroll.blockscout.com",
    llama: "scroll",
    explorer: "https://scrollscan.com",
    guideId: "scroll",
    bridgeUrl: "portal.scroll.io/bridge",
    contracts: {
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
    rpcs: ["https://rpc.linea.build", "https://linea-rpc.publicnode.com"],
    blockscout: "https://explorer.linea.build",
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
];

export const networkById = (id: string) => NETWORKS.find((n) => n.id === id);
