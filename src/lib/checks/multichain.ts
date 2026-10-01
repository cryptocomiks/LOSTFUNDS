import type { Address } from "viem";
import { evmChain } from "../evm";
import type { Finding } from "../types";
import type { CheckOutput } from "./common";

/** Dust, in dollars: claiming on Ethereum costs more gas, so smaller amounts aren't worth showing there. */
export const dustUsd = (chainId: number) => (chainId === 1 ? 5 : 1);

/** A contract's page on the chain's block explorer. */
export function contractUrl(chainId: number, address: Address): string {
  const explorer = evmChain(chainId)?.chain.blockExplorers?.default.url.replace(/\/$/, "");
  return explorer ? `${explorer}/address/${address}` : `https://blockscan.com/address/${address}`;
}

export const errMsg = (e: unknown) =>
  ((e as { shortMessage?: string })?.shortMessage ?? (e as Error)?.message ?? String(e)).split("\n")[0].slice(0, 140);

/**
 * Runs one lookup per chain, in parallel. A chain that fails doesn't hide what the others found:
 * its error comes back next to their findings, and the check reads as incomplete.
 */
export async function perChain<T>(items: T[], name: (item: T) => string, run: (item: T) => Promise<Finding[]>): Promise<CheckOutput> {
  const out: CheckOutput = { findings: [], completed: 0 };
  const errors: string[] = [];
  await Promise.all(
    items.map(async (item) => {
      try {
        out.findings.push(...(await run(item)));
      } catch (e) {
        errors.push(`${name(item)}: ${errMsg(e)}`);
      }
    }),
  );
  if (errors.length) out.error = errors.join(" · ");
  return out;
}
