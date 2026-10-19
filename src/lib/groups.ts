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
