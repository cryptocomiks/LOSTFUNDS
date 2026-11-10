import totals from "./unclaimed-totals.json";

/**
 * What was waiting to be claimed, measured on-chain by scripts/measure-unclaimed.ts (the date is
 * in the file). Only sources whose total can be read exactly are in it, so the sum is a floor.
 */
export interface UnclaimedSource {
  id: string;
  usd: number;
  /** Number of positions (deeds, withdrawals, locks, buffers), when the source has one. */
  count?: number;
  parts: { symbol: string; amount: number; usd: number }[];
}
export const UNCLAIMED = totals as { measuredAt: number; totalUsd: number; sources: UnclaimedSource[] };

/** What each measured source is, in both languages. `{n}` is the source's count. */
export const UNCLAIMED_LABELS: Record<string, { name: string; en: string; fr: string }> = {
  "the-dao": { name: "The DAO (2016)", en: "ETH that DAO token holders never took back", fr: "ETH que les détenteurs de tokens DAO n'ont jamais repris" },
  "old-exchanges": { name: "EtherDelta, IDEX v1 & co.", en: "ETH deposits left in old exchange contracts", fr: "Dépôts d'ETH restés dans les contrats d'anciens exchanges" },
  digixdao: { name: "DigixDAO", en: "ETH refund that DGD holders never collected", fr: "Remboursement en ETH jamais récupéré par les détenteurs de DGD" },
  apecoin: { name: "ApeCoin staking", en: "APE still staked where rewards have ended", fr: "APE toujours stakés là où les récompenses sont terminées" },
  "zksync-lite": { name: "zkSync Lite", en: "Balances left when the network shut down", fr: "Soldes laissés à l'arrêt du réseau" },
  liquity: { name: "Liquity", en: "Collateral set aside for closed loans", fr: "Collatéral mis de côté pour des prêts fermés" },
  stargate: { name: "Stargate", en: "STG left in locks that are all unlocked", fr: "STG restés dans des verrous tous débloqués" },
  uniswap: { name: "Uniswap airdrop (2020)", en: "UNI left in the claim contract", fr: "UNI restés dans le contrat de réclamation" },
  aerodrome: { name: "Aerodrome", en: "{n} expired locks never withdrawn", fr: "{n} verrous expirés jamais retirés" },
  velodrome: { name: "Velodrome", en: "{n} expired locks never withdrawn", fr: "{n} verrous expirés jamais retirés" },
  "solana-buffers": { name: "Solana program buffers", en: "SOL left by {n} unfinished deploys", fr: "SOL laissés par {n} déploiements inachevés" },
  "ens-deeds": { name: "ENS auctions (2017–2019)", en: "ETH locked in {n} auction deeds", fr: "ETH bloqués dans {n} actes d'enchères" },
  starknet: { name: "Starknet", en: "{n} withdrawals never finalized on Ethereum", fr: "{n} retraits jamais finalisés sur Ethereum" },
  "zora-rewards": { name: "Zora", en: "Creator and referral rewards never withdrawn", fr: "Récompenses de créateurs et de parrainage jamais retirées" },
  kinto: { name: "Kinto", en: "USDC left for the users of the closed network", fr: "USDC laissés aux utilisateurs du réseau fermé" },
};
