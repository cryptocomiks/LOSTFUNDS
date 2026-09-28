import { getAddress, isAddress, type Address } from "viem";
import { normalize } from "viem/ens";
import { l1Client } from "./clients";
import { isSolanaAddress } from "./solana";
import type { Network } from "./networks";
import { SOURCES, sourceById, type CheckSource } from "./sources";
import { addPrices } from "./tokens";
import type { NetworkResult } from "./types";

export class InputError extends Error {}

/** Accepts a 0x address or an ENS name. Returns a checksummed address. */
export type WalletKind = "evm" | "solana";
export interface Target {
  kind: WalletKind;
  address: string;
  ens?: string;
}

/** Accepts an Ethereum address, an ENS name or a Solana address. */
export async function resolveInput(raw: string): Promise<Target> {
  const input = raw.trim();
  if (!input) throw new InputError("Paste a wallet address or ENS name.");
  if (isAddress(input, { strict: false })) return { kind: "evm", address: getAddress(input) };
  if (isSolanaAddress(input)) return { kind: "solana", address: input };
  if (/^[^\s]+\.[a-z]{2,}$/i.test(input)) {
    let name: string;
    try {
      name = normalize(input);
    } catch {
      throw new InputError("That ENS name isn't valid.");
    }
    const address = await l1Client().getEnsAddress({ name });
    if (!address) throw new InputError(`${input} doesn't resolve to an address.`);
    return { kind: "evm", address, ens: name };
  }
  if (/^0x[0-9a-f]{64}$/i.test(input)) throw new InputError("That's a transaction hash, not a wallet address.");
  throw new InputError("That doesn't look like a wallet address.");
}

function describeError(e: unknown): string {
  const err = e as { shortMessage?: string; message?: string; name?: string };
  const msg = err?.shortMessage ?? err?.message ?? String(e);
  return msg.split("\n")[0].slice(0, 160);
}

/** Runs one check. Never throws: failures come back as an "error" result. */
export async function checkSource(src: CheckSource, user: string): Promise<NetworkResult> {
  try {
    const out = await src.run(user);
    await addPrices(out.findings.map((f) => f.asset));
    return { networkId: src.id, state: "done", ...out };
  } catch (e) {
    console.error(`[${src.id}]`, e);
    return { networkId: src.id, state: "error", findings: [], completed: 0, error: describeError(e) };
  }
}

/** Checks one L2 network's withdrawals. */
export const checkNetwork = (net: Network, user: Address) => checkSource(sourceById(net.id)!, user);

/** The checks that apply to this kind of wallet. */
export const sourcesFor = (kind: WalletKind) => SOURCES.filter((s) => s.accepts.includes(kind));

/** Runs every applicable check in parallel, reporting each result as soon as it lands. */
export async function runChecks(target: Target, onUpdate: (r: NetworkResult) => void, signal?: AbortSignal) {
  const user = target.address;
  await Promise.all(
    sourcesFor(target.kind).map(async (src) => {
      onUpdate({ networkId: src.id, state: "running", findings: [], completed: 0 });
      const result = await checkSource(src, user);
      if (!signal?.aborted) onUpdate(result);
    }),
  );
}
