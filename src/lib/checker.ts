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

/** A check that hasn't answered after this long is reported as failed (with a Retry), never left spinning. */
const CHECK_TIMEOUT_MS = 120_000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("took too long to answer — try again in a moment")), ms);
    }),
  ]);
}

/** Runs one check. Never throws: failures come back as an "error" result. */
export async function checkSource(src: CheckSource, user: string): Promise<NetworkResult> {
  try {
    const { error, ...out } = await withTimeout(src.run(user), CHECK_TIMEOUT_MS);
    await addPrices(out.findings.map((f) => f.asset));
    // Dust: drop findings worth less than their threshold (only once the price is known).
    out.findings = out.findings.filter((f) => f.minUsd === undefined || f.asset.usd === undefined || f.asset.usd >= f.minUsd);
    // A partial failure keeps what was found, but the check still reads as failed (with a Retry).
    if (error) return { networkId: src.id, state: "error", ...out, error: error.slice(0, 300) };
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

/**
 * How many checks run at once. Each check fans out to its own sources, so this caps a visitor's
 * burst of requests (kind to shared public endpoints when many people check at the same time)
 * while keeping a full check fast.
 */
const MAX_PARALLEL_CHECKS = 14;

/** Runs every applicable check (or just `only`), reporting each result as soon as it lands. */
export async function runChecks(
  target: Target,
  onUpdate: (r: NetworkResult) => void,
  signal?: AbortSignal,
  only?: string[],
) {
  const user = target.address;
  const queue = sourcesFor(target.kind).filter((s) => !only || only.includes(s.id));
  for (const src of queue) onUpdate({ networkId: src.id, state: "queued", findings: [], completed: 0 });
  const worker = async () => {
    for (let src = queue.shift(); src && !signal?.aborted; src = queue.shift()) {
      onUpdate({ networkId: src.id, state: "running", findings: [], completed: 0 });
      const result = await checkSource(src, user);
      if (!signal?.aborted) onUpdate(result);
    }
  };
  await Promise.all(Array.from({ length: MAX_PARALLEL_CHECKS }, worker));
}
