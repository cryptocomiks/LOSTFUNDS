import type { Address } from "viem";
import { checkArbitrum } from "./checks/arbitrum";
import { checkCctp, checkCctpFromSolana } from "./checks/cctp";
import type { CheckOutput } from "./checks/common";
import { checkDebridge } from "./checks/debridge";
import { checkLinea } from "./checks/linea";
import { checkOpStack } from "./checks/opstack";
import { checkScroll } from "./checks/scroll";
import { checkWormhole } from "./checks/wormhole";
import { NETWORKS, type Family, type Network } from "./networks";

export type Group = "l2" | "solana";

export const GROUPS: Record<Group, string> = {
  l2: "L2 → Ethereum",
  solana: "Solana ↔ Ethereum",
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

const FAMILY: Record<Family, (net: Network, user: Address) => Promise<CheckOutput>> = {
  opstack: checkOpStack,
  arbitrum: checkArbitrum,
  scroll: checkScroll,
  linea: checkLinea,
};

export const SOURCES: CheckSource[] = [
  ...NETWORKS.map((n) => ({
    id: n.id,
    name: n.name,
    group: "l2" as const,
    bridgeUrl: n.bridgeUrl,
    accepts: ["evm" as const],
    run: (user: string) => FAMILY[n.family](n, user as Address),
  })),
  // Polygon PoS (checks/polygon.ts) is implemented and unit-tested, but not enabled until it has been
  // validated against real withdrawals: its only full-history source (Tenderly) rate-limits heavily.
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
];

export const sourceById = (id: string) => SOURCES.find((s) => s.id === id);
