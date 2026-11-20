/**
 * French names of the checks whose name is a description and not a brand, and French versions of
 * the "where to claim" texts that are sentences (used when a finding doesn't bring its own).
 * A check missing here keeps its name: tests/i18n.test.ts lists the ones that must be translated.
 */
export const SOURCE_FR: Record<string, { name?: string; bridgeUrl?: string }> = {
  blast: { name: "Blast (fermé)" },
  "zksync-lite": { name: "zkSync Lite (fermé)" },
  cctp: { bridgeUrl: "l'app que vous avez utilisée, ou un relayeur CCTP" },
  "airdrop-lido-early-2021": { name: "Premiers stakers Lido (LDO)" },
  "airdrop-lido-1inch-2021": { name: "LP Lido × 1inch (LDO)" },
  "airdrop-cow-lgno-2022": { name: "COW pour GNO verrouillés" },
  "airdrop-cow-lgno-gnosis-2022": { name: "COW pour GNO verrouillés · Gnosis" },
  "hedgey-claims": { name: "Claims Hedgey" },
  "lido-withdrawals": { name: "Retraits Lido" },
  "expired-locks": { name: "Verrous expirés", bridgeUrl: "l'app du protocole" },
  "curve-fees": { name: "Frais Curve", bridgeUrl: "curve.finance (page DAO)" },
  "eigenlayer-withdrawals": { name: "Retraits EigenLayer" },
  "eigenlayer-rewards": { name: "Récompenses EigenLayer" },
  "aave-safety-module": { name: "Safety Module d'Aave" },
  "synthetix-escrow": { name: "Escrow Synthetix" },
  "convex-staking": { name: "Staking Convex" },
  "balancer-fees": { name: "Frais Balancer" },
  liquity: { bridgeUrl: "un frontend Liquity, ou Etherscan" },
  "apecoin-staking": { name: "Staking ApeCoin" },
  "zora-rewards": { name: "Récompenses Zora" },
  "sablier-streams": { name: "Streams Sablier" },
  "uniswap-v3-fees": { name: "Frais Uniswap v3" },
  "ethena-unstake": { name: "Déstaking Ethena" },
  "nft-marketplaces": { name: "Soldes sur les marketplaces NFT" },
  "stader-withdrawals": { name: "Retraits Stader" },
  "swell-withdrawals": { name: "Retraits Swell" },
  "frax-redemptions": { name: "Remboursements Frax" },
  "meth-withdrawals": { name: "Retraits Mantle mETH" },
  "kelp-withdrawals": { name: "Retraits Kelp" },
  "uniswap-2020-farms": { name: "Fermes Uniswap 2020" },
  "reclaim-rent": { name: "Comptes de tokens vides", bridgeUrl: "Solflare (Close Account), ou sol-incinerator.com" },
  "reclaim-stake": { name: "Stake inactif", bridgeUrl: "l'onglet staking de votre wallet" },
  "reclaim-marinade": { name: "Tickets Marinade" },
  "reclaim-openorders": { name: "Comptes Serum / OpenBook", bridgeUrl: "un script (voir le guide)" },
  "pumpfun-creator-fees": { name: "Frais de créateur pump.fun", bridgeUrl: "pump.fun (profil → creator rewards)" },
  "reclaim-buffers": { name: "Buffers de programmes" },
  "legacy-weth-old": { name: "Ancien ETH wrappé" },
  "ens-deeds": { name: "Dépôts d'enchères ENS" },
  "polygon-staking": { name: "Staking Polygon" },
  scd: { name: "Coffres Maker SCD" },
  kinto: { name: "Kinto (fermé)" },
  "cryptopunks-market": { name: "Marché CryptoPunks" },
  safes: { name: "Safes oubliés" },
};

/** A check's name in the page's language. */
export const sourceName = (s: { id: string; name: string }, lang: "en" | "fr") => (lang === "fr" ? (SOURCE_FR[s.id]?.name ?? s.name) : s.name);

/** French for the generic "where to claim" sentences of the L2 networks. */
export function bridgeFr(bridgeUrl: string): string {
  const official = bridgeUrl.match(/^the official (.+) bridge$/);
  return official ? `le bridge officiel de ${official[1]}` : bridgeUrl;
}
