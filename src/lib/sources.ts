import type { Address } from "viem";
import { checkAaveV2, checkAaveV3 } from "./checks/aave-incentives";
import { neverActive } from "./checks/activity";
import { AIRDROP_LIST, checkAirdrops } from "./checks/airdrops";
import { checkArbitrum } from "./checks/arbitrum";
import { checkCctp, checkCctpFromSolana } from "./checks/cctp";
import { checkCeler } from "./checks/celer";
import type { CheckOutput } from "./checks/common";
import { checkDebridge } from "./checks/debridge";
import { checkEnsDeeds, ENS_DEEDS } from "./checks/ens-deeds";
import { checkExchange, DEPOSIT_EXCHANGES } from "./checks/exchanges";
import { checkGnosisBridge } from "./checks/gnosis";
import { checkLegacy, LEGACY_LIST } from "./checks/legacy";
import { checkLinea } from "./checks/linea";
import { checkMerkl } from "./checks/merkl";
import { checkOpStack } from "./checks/opstack";
import { checkPolygon, POLYGON } from "./checks/polygon";
import { ETH_REWARD_SOURCES } from "./checks/rewards-eth";
import { checkInactiveStake, checkMarinadeTickets, checkTokenRent, MARINADE, RENT, STAKE } from "./checks/reclaim";
import { checkPolygonStaking, POLYGON_STAKING } from "./checks/polygon-staking";
import { checkScd, SCD } from "./checks/scd";
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
  ...ETH_REWARD_SOURCES,
  { id: RENT.id, name: RENT.name, group: "reclaim", bridgeUrl: "Solflare (Close Account), or sol-incinerator.com", accepts: ["solana"], run: checkTokenRent },
  { id: STAKE.id, name: STAKE.name, group: "reclaim", bridgeUrl: "your wallet's staking tab", accepts: ["solana"], run: checkInactiveStake },
  { id: MARINADE.id, name: MARINADE.name, group: "reclaim", bridgeUrl: "app.marinade.finance", accepts: ["solana"], run: checkMarinadeTickets },
  ...LEGACY_LIST.map((e) => ({
    id: `legacy-${e.id}`,
    name: e.name,
    group: "legacy" as const,
    bridgeUrl: e.redemptions[0].claimAt,
    accepts: ["evm" as const],
    // Every entry shares one multicall per address (see checks/legacy.ts).
    run: (user: string) => checkLegacy(user, [e]),
  })),
];

/**
 * Old contracts still holding deposits their users can withdraw themselves.
 * Kept apart from the list above so other additions to the group merge cleanly.
 */
SOURCES.push(
  ...DEPOSIT_EXCHANGES.map((ex) => ({
    id: ex.id,
    name: ex.name,
    group: "legacy" as const,
    bridgeUrl: ex.contracts.find((c) => c.app)?.app ?? "Etherscan (Write Contract)",
    accepts: ["evm" as const],
    run: (user: string) => checkExchange(ex, user as Address),
  })),
  { id: ENS_DEEDS.id, name: ENS_DEEDS.name, group: "legacy", bridgeUrl: "Etherscan (old .eth registrar)", accepts: ["evm"], run: (user) => checkEnsDeeds(user as Address) },
  {
    id: POLYGON_STAKING.id,
    name: POLYGON_STAKING.name,
    group: "legacy",
    bridgeUrl: "staking.polygon.technology",
    accepts: ["evm"],
    run: (user) => checkPolygonStaking(user as Address),
  },
  { id: SCD.id, name: SCD.name, group: "legacy", bridgeUrl: "Etherscan (SCD Tub, or your DSProxy)", accepts: ["evm"], run: (user) => checkScd(user as Address) },
);

export const sourceById = (id: string) => SOURCES.find((s) => s.id === id);
