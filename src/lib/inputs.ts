/**
 * Several wallets in one go: what the visitor typed or pasted is split into addresses (or ENS
 * names). No dependency here, so the page can use it before the checks themselves are loaded.
 */

/** How many wallets one run accepts: each costs about a hundred live checks on shared public nodes. */
export const MAX_WALLETS = 10;

/** The entries of an input, separated by spaces, commas, semicolons or new lines. Duplicates are dropped. */
export function splitInputs(raw: string): string[] {
  const seen = new Set<string>();
  return raw
    .split(/[\s,;]+/)
    .filter(Boolean)
    .filter((entry) => {
      // Ethereum addresses and ENS names don't depend on case; Solana addresses do.
      const key = /^0x/i.test(entry) || entry.includes(".") ? entry.toLowerCase() : entry;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}
