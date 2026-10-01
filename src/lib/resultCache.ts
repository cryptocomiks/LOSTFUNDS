import type { WalletKind } from "./checker";
import type { NetworkResult } from "./types";

/**
 * Recent results, kept in the visitor's own browser (localStorage) for a few minutes:
 * reloading the page or reopening a shared link shows them at once instead of running
 * every check again. Nothing leaves the browser. Every read/write is best-effort.
 */

const TTL_MS = 10 * 60_000;
const PREFIX = "lostfunds:results:v1:";

const keyOf = (kind: WalletKind, address: string) =>
  `${PREFIX}${kind}:${kind === "evm" ? address.toLowerCase() : address}`; // Solana addresses are case-sensitive

interface Entry {
  at: number;
  results: NetworkResult[];
}

// Amounts are bigints, which JSON can't hold as such.
const replacer = (_: string, v: unknown) => (typeof v === "bigint" ? { $big: v.toString() } : v);
const reviver = (_: string, v: unknown) =>
  v && typeof v === "object" && "$big" in v && typeof (v as { $big: unknown }).$big === "string"
    ? BigInt((v as { $big: string }).$big)
    : v;

/** Fresh results for this wallet, if any (only checks that completed). */
export function readCache(kind: WalletKind, address: string): Entry | null {
  try {
    const raw = localStorage.getItem(keyOf(kind, address));
    if (!raw) return null;
    const entry = JSON.parse(raw, reviver) as Entry;
    if (!entry?.at || Date.now() - entry.at > TTL_MS || !Array.isArray(entry.results)) return null;
    return entry;
  } catch {
    return null;
  }
}

/** Stores the completed checks of a run (failed ones are run again next time). */
export function writeCache(kind: WalletKind, address: string, results: NetworkResult[], at = Date.now()) {
  try {
    const done = results.filter((r) => r.state === "done");
    if (!done.length) return;
    // Drop stale entries so the storage never grows.
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (!k?.startsWith(PREFIX)) continue;
      try {
        if (Date.now() - (JSON.parse(localStorage.getItem(k) ?? "{}") as Entry).at > TTL_MS) localStorage.removeItem(k);
      } catch {
        localStorage.removeItem(k);
      }
    }
    localStorage.setItem(keyOf(kind, address), JSON.stringify({ at, results: done }, replacer));
  } catch {
    /* storage full, private mode, disabled… caching is optional */
  }
}
