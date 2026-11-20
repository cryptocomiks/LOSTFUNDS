import type { Group } from "./groups";
import data from "./source-meta.json";

/** A check as the page shows it: everything but its code (see scripts/gen-source-meta.ts). */
export interface SourceMeta {
  id: string;
  name: string;
  group: Group;
  bridgeUrl: string;
  accepts: ("evm" | "solana")[];
  /** Unix seconds after which the check is no longer listed (an airdrop's deadline). */
  ends?: number;
}

/** Checks past their end date are dropped when the page is built, and again in the browser. */
export const SOURCE_META = (data as SourceMeta[]).filter((s) => !s.ends || s.ends > Date.now() / 1000);
export const sourceMetaById = (id: string) => SOURCE_META.find((s) => s.id === id);
export const sourcesMetaFor = (kind: "evm" | "solana") => SOURCE_META.filter((s) => s.accepts.includes(kind));
