import type { Group } from "./groups";
import data from "./source-meta.json";

/** A check as the page shows it: everything but its code (see scripts/gen-source-meta.ts). */
export interface SourceMeta {
  id: string;
  name: string;
  group: Group;
  bridgeUrl: string;
  accepts: ("evm" | "solana")[];
}

export const SOURCE_META = data as SourceMeta[];
export const sourceMetaById = (id: string) => SOURCE_META.find((s) => s.id === id);
export const sourcesMetaFor = (kind: "evm" | "solana") => SOURCE_META.filter((s) => s.accepts.includes(kind));
