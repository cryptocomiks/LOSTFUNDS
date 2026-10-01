import type { Address } from "viem";
import { checkAaveV2, checkAaveV3 } from "./checks/aave-incentives";
import { neverActive } from "./checks/activity";
import { AIRDROP_LIST, checkAirdrops } from "./checks/airdrops";
import { checkArbitrum } from "./checks/arbitrum";
import { checkCctp, checkCctpFromSolana } from "./checks/cctp";
import { checkCeler } from "./checks/celer";
import type { CheckOutput } from "./checks/common";
import { checkDebridge } from "./checks/debridge";
import { checkGnosisBridge } from "./checks/gnosis";
import { checkLinea } from "./checks/linea";
import { checkMerkl } from "./checks/merkl";
import { checkOpStack } from "./checks/opstack";
import { checkPolygon, POLYGON } from "./checks/polygon";
import { checkScroll } from "./checks/scroll";
import { checkWormhole } from "./checks/wormhole";
import { checkZkSync } from "./checks/zksync";
import { NETWORKS, type Family, type Network } from "./networks";

export type Group = "l2" | "solana" | "airdrops" | "rewards" | "legacy" | "reclaim";

/** Display order of the checker's groups. ("solana" is the historical key of the cross-chain bridges.) */
export const GROUPS: Record<Group, string> = {
  l2: "L2 → Ethereum",
  solana: "Cross-chain bridges",
  airdrops: "Unclaimed airdrops",
  rewards: "Unclaimed rewards & withdrawals",
  legacy: "Old contracts & token migrations",
  reclaim: "Reclaimable SOL",
};

/** One line of the checker: a network's withdrawals, or a bridge route. */
export interface CheckSource {
  id: string;
  name: string;
  group: Group;
  /** Official app, shown as text (users should type it themselves). */
  bridgeUrl: string;
  /** Wallet kinds this check works with. */
  accepts: ("evm" | "solana")[];
  /** `user` is a checksummed EVM address or a base58 Solana address, per `accepts`. */
  run: (user: string) => Promise<CheckOutput>;
}

/** Families whose checks start from transactions the user sent (zkSync also searches withdrawals *to* the user). */
const SENDER_ONLY = new Set<Family>(["opstack", "arbitrum", "scroll", "linea"]);

const FAMILY: Record<Family, (net: Network, user: Address) => Promise<CheckOutput>> = {
  opstack: checkOpStack,
  arbitrum: checkArbitrum,
  scroll: checkScroll,
  linea: checkLinea,
  zksync: checkZkSync,
};

export const SOURCES: CheckSource[] = [
  ...NETWORKS.map((n) => ({
    id: n.id,
    name: n.name,
    group: "l2" as const,
    bridgeUrl: n.bridgeUrl,
    accepts: ["evm" as const],
    run: async (user: string) =>
      SENDER_ONLY.has(n.family) && (await neverActive(n, user as Address))
        ? { findings: [], completed: 0 }
        : FAMILY[n.family](n, user as Address),
  })),
  { id: POLYGON.id, name: POLYGON.name, group: "l2", bridgeUrl: "portal.polygon.technology", accepts: ["evm"], run: (user) => checkPolygon(user as Address) },
  { id: "wormhole", name: "Wormhole", group: "solana", bridgeUrl: "portalbridge.com", accepts: ["evm", "solana"], run: checkWormhole },
  { id: "debridge", name: "deBridge", group: "solana", bridgeUrl: "app.debridge.finance", accepts: ["evm", "solana"], run: checkDebridge },
  {
    id: "cctp",
    name: "Circle CCTP",
    group: "solana",
    bridgeUrl: "the app you used, or a CCTP relayer",
    accepts: ["evm", "solana"],
    run: (user) => (user.startsWith("0x") ? checkCctp(user as Address) : checkCctpFromSolana(user)),
  },
  {
    id: "gnosis",
    name: "Gnosis Bridge",
    group: "solana",
    bridgeUrl: "bridge.gnosischain.com",
    accepts: ["evm"],
    run: (user) => checkGnosisBridge(user as Address),
  },
  { id: "celer", name: "Celer cBridge", group: "solana", bridgeUrl: "cbridge.celer.network", accepts: ["evm"], run: (user) => checkCeler(user as Address) },
  ...AIRDROP_LIST.map((a) => ({
    id: `airdrop-${a.id}`,
    name: a.name,
    group: "airdrops" as const,
    bridgeUrl: a.claimAt,
    accepts: a.accepts,
    run: (user: string) => checkAirdrops(user, [a]),
  })),
  // Protocol rewards earned and never claimed, on many EVM chains.
  { id: "aave-v2", name: "Aave v2", group: "rewards", bridgeUrl: "app.aave.com", accepts: ["evm"], run: (user) => checkAaveV2(user as Address) },
  { id: "aave-v3", name: "Aave v3", group: "rewards", bridgeUrl: "app.aave.com", accepts: ["evm"], run: (user) => checkAaveV3(user as Address) },
  { id: "merkl", name: "Merkl", group: "rewards", bridgeUrl: "app.merkl.xyz", accepts: ["evm"], run: (user) => checkMerkl(user as Address) },
];

export const sourceById = (id: string) => SOURCES.find((s) => s.id === id);
