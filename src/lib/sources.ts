import type { Address } from "viem";
import { checkArbitrum } from "./checks/arbitrum";
import { checkCctp } from "./checks/cctp";
import type { CheckOutput } from "./checks/common";
import { checkDebridge } from "./checks/debridge";
import { checkLinea } from "./checks/linea";
import { checkOpStack } from "./checks/opstack";
import { checkPolygon } from "./checks/polygon";
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
  run: (user: Address) => Promise<CheckOutput>;
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
    run: (user: Address) => FAMILY[n.family](n, user),
  })),
  { id: "polygon", name: "Polygon PoS", group: "l2", bridgeUrl: "portal.polygon.technology", run: checkPolygon },
  { id: "wormhole", name: "Wormhole", group: "solana", bridgeUrl: "portalbridge.com", run: checkWormhole },
  { id: "debridge", name: "deBridge", group: "solana", bridgeUrl: "app.debridge.finance", run: checkDebridge },
  { id: "cctp", name: "Circle CCTP", group: "solana", bridgeUrl: "the app you used, or a CCTP relayer", run: checkCctp },
];

export const sourceById = (id: string) => SOURCES.find((s) => s.id === id);
