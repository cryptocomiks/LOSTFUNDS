import { getAddress, isAddress, type Address } from "viem";
import { normalize } from "viem/ens";
import { checkArbitrum } from "./checks/arbitrum";
import type { CheckOutput } from "./checks/common";
import { checkLinea } from "./checks/linea";
import { checkOpStack } from "./checks/opstack";
import { checkScroll } from "./checks/scroll";
import { l1Client } from "./clients";
import { NETWORKS, type Family, type Network } from "./networks";
import { addPrices } from "./tokens";
import type { NetworkResult } from "./types";

const CHECKS: Record<Family, (net: Network, user: Address) => Promise<CheckOutput>> = {
  opstack: checkOpStack,
  arbitrum: checkArbitrum,
  scroll: checkScroll,
  linea: checkLinea,
};

export class InputError extends Error {}

/** Accepts a 0x address or an ENS name. Returns a checksummed address. */
export async function resolveInput(raw: string): Promise<{ address: Address; ens?: string }> {
  const input = raw.trim();
  if (!input) throw new InputError("Paste a wallet address or ENS name.");
  if (isAddress(input, { strict: false })) return { address: getAddress(input) };
  if (/^[^\s]+\.[a-z]{2,}$/i.test(input)) {
    let name: string;
    try {
      name = normalize(input);
    } catch {
      throw new InputError("That ENS name isn't valid.");
    }
    const address = await l1Client().getEnsAddress({ name });
    if (!address) throw new InputError(`${input} doesn't resolve to an address.`);
    return { address, ens: name };
  }
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(input) || /^0x[0-9a-f]{64}$/i.test(input))
    throw new InputError("Only EVM addresses (0x…) and ENS names are supported for now.");
  throw new InputError("That doesn't look like a wallet address.");
}

function describeError(e: unknown): string {
  const err = e as { shortMessage?: string; message?: string; name?: string };
  const msg = err?.shortMessage ?? err?.message ?? String(e);
  return msg.split("\n")[0].slice(0, 160);
}

/** Checks one network. Never throws: failures come back as an "error" result. */
export async function checkNetwork(net: Network, user: Address): Promise<NetworkResult> {
  try {
    const out = await CHECKS[net.family](net, user);
    await addPrices(out.findings.map((f) => f.asset));
    return { networkId: net.id, state: "done", ...out };
  } catch (e) {
    console.error(`[${net.id}]`, e);
    return {
      networkId: net.id,
      state: "error",
      findings: [],
      completed: 0,
      error: describeError(e),
    };
  }
}

/** Runs every network check in parallel, reporting each result as soon as it lands. */
export async function runChecks(user: Address, onUpdate: (r: NetworkResult) => void, signal?: AbortSignal) {
  await Promise.all(
    NETWORKS.map(async (net) => {
      onUpdate({ networkId: net.id, state: "running", findings: [], completed: 0 });
      const result = await checkNetwork(net, user);
      if (!signal?.aborted) onUpdate(result);
    }),
  );
}
