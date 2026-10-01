import { encodeFunctionData, pad, parseAbi, toHex, zeroAddress, type Address, type Hex } from "viem";
import { l1BulkClient, l1Client } from "../clients";
import { ethAsset } from "../tokens";
import { bulkRead } from "./bulk";
import { makeFinding, type CheckOutput, type FindingSource } from "./common";
import { LEGACY_GUIDE } from "./exchanges";
import { wouldSucceed } from "./simulate";

/**
 * Collateral left in Single-Collateral Dai (SCD) vaults, the "CDPs" of Maker's first system. SCD was
 * shut down (caged) in May 2020: since then each CDP's debt can be settled by anyone with bite(cup),
 * which takes only its value in collateral, and the CDP's owner (lad) withdraws the rest with
 * free(cup, ink), then turns the PETH into WETH with exit(ink). Most CDPs were opened through a
 * DSProxy (Maker's CDP Portal): its owner withdraws through it, with SaiProxy's free(tub, cup, jam),
 * which also unwraps the WETH and sends ETH.
 *
 * CDPs can't be opened anymore, so the list of those still holding collateral is fixed: the ones worth
 * at least 0.01 PETH are published with the site (public/legacy/scd-cups, 5,021 CDPs as of Oct 1, 2026),
 * by owner (the wallet, or the DSProxy's owner). Each is checked on-chain, and the withdrawal simulated.
 */

export const SCD: FindingSource = { id: "scd", name: "Maker SCD (Sai) vaults", guideId: LEGACY_GUIDE, explorer: "https://etherscan.io" };

const TUB: Address = "0x448a5065aeBB8E423F0896E6c5D525C040f59af3";
const PETH: Address = "0xf53AD2c6851052A81B42133467480961B2321C09";
/** Maker's SaiProxy library, the target of the DSProxy calls the CDP Portal made. */
const SAI_PROXY: Address = "0x526af336D614adE5cc252A407062B8861aF998F5";
const MIN_USD = 5;
const RAY = 10n ** 27n;

const tubAbi = parseAbi([
  "function cups(bytes32) view returns (address lad, uint256 ink, uint256 art, uint256 ire)",
  "function off() view returns (bool)",
  "function out() view returns (bool)",
  "function per() view returns (uint256)",
  "function tag() view returns (uint256)",
  "function axe() view returns (uint256)",
  "function chi() returns (uint256)",
  "function vox() view returns (address)",
  "function bite(bytes32 cup)",
  "function free(bytes32 cup, uint256 wad)",
]);
const voxAbi = parseAbi(["function par() returns (uint256)"]);
const proxyAbi = parseAbi(["function owner() view returns (address)", "function execute(address _target, bytes _data) payable returns (bytes32)"]);
const saiProxyAbi = parseAbi(["function free(address tub_, bytes32 cup, uint256 jam)"]);

// DSMath, as the Tub and SaiProxy round.
const rmul = (x: bigint, y: bigint) => (x * y + RAY / 2n) / RAY;
const rdiv = (x: bigint, y: bigint) => (x * RAY + y / 2n) / y;

/**
 * The `jam` (WETH) for which SaiProxy.free frees exactly `ink` (PETH). Freeing a hair less would leave
 * dust in the CDP, which the Tub refuses (below 0.005 PETH), so it must be exact.
 */
export function jamFor(ink: bigint, per: bigint): bigint | null {
  const freed = (jam: bigint) => {
    const i = rdiv(jam, per);
    return rmul(i, per) <= jam ? i : i - 1n;
  };
  const guess = rmul(ink, per);
  for (let d = -3n; d <= 3n; d++) if (freed(guess + d) === ink) return guess + d;
  return null;
}

/** Files published with the site, from anywhere the checks run (LOSTFUNDS_SITE overrides it outside a browser). */
const siteFile = (path: string) =>
  `${typeof window === "undefined" ? (typeof process !== "undefined" && process.env.LOSTFUNDS_SITE) || "https://lostfunds.vercel.app" : ""}${path}`;

async function listedCups(user: Address): Promise<number[]> {
  const me = user.toLowerCase();
  const res = await fetch(siteFile(`/legacy/scd-cups/${me[2]}.json`), { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`SCD vaults list: HTTP ${res.status}`);
  return ((await res.json()) as Record<string, number[]>)[me] ?? [];
}

export async function checkScd(user: Address): Promise<CheckOutput> {
  const ids = (await listedCups(user)).map((n) => ({ n, cup: pad(toHex(n), { size: 32 }) as Hex }));
  if (!ids.length) return { findings: [], completed: 0 };

  const r = await bulkRead([
    { address: TUB, abi: tubAbi, functionName: "off" },
    { address: TUB, abi: tubAbi, functionName: "out" },
    { address: TUB, abi: tubAbi, functionName: "per" },
    { address: TUB, abi: tubAbi, functionName: "tag" },
    { address: TUB, abi: tubAbi, functionName: "axe" },
    { address: TUB, abi: tubAbi, functionName: "chi" },
    { address: TUB, abi: tubAbi, functionName: "vox" },
    ...ids.map(({ cup }) => ({ address: TUB, abi: tubAbi, functionName: "cups", args: [cup] })),
  ]);
  const [off, out, per, tag, axe, chi, vox] = r as [boolean, boolean, bigint, bigint, bigint, bigint, Address];
  if (!off || !out) throw new Error("SCD isn't in its shutdown state");
  const vaults = ids.map((v, i) => {
    const [lad, ink, art] = r[7 + i] as readonly [Address, bigint, bigint, bigint];
    return { ...v, lad, ink, art };
  });
  // Owners of the DSProxies that are lads (a wallet that is the lad itself needs no lookup), and `par`.
  const proxies = [...new Set(vaults.filter((v) => v.lad.toLowerCase() !== user.toLowerCase() && v.lad !== zeroAddress).map((v) => v.lad))];
  // allowFailure: owner() fails on a lad that isn't a DSProxy (e.g. a wallet the CDP was given to since).
  const [parRes, ...owners] = (await l1BulkClient().multicall({
    contracts: [{ address: vox, abi: voxAbi, functionName: "par" }, ...proxies.map((p) => ({ address: p, abi: proxyAbi, functionName: "owner" }))] as never,
    allowFailure: true,
    batchSize: 0,
  })) as { status: "success" | "failure"; result?: unknown; error?: Error }[];
  if (parRes.status !== "success") throw parRes.error ?? new Error("couldn't read SCD's target price");
  const par = parRes.result as bigint;
  const ownerOf = new Map(proxies.map((p, i) => [p.toLowerCase(), owners[i].status === "success" ? String(owners[i].result).toLowerCase() : ""]));

  const mine = vaults
    .map((v) => {
      // bite takes the debt's value in collateral (at the shutdown price), the rest is the owner's.
      const owe = rdiv(rmul(rmul(rmul(v.art, chi), axe), par), tag);
      const ink = v.ink > owe ? v.ink - owe : 0n;
      const via = v.lad.toLowerCase() === user.toLowerCase() ? null : v.lad;
      return { ...v, free: ink, via };
    })
    .filter((v) => v.free > 0n && (v.via === null || ownerOf.get(v.via.toLowerCase()) === user.toLowerCase()));
  if (!mine.length) return { findings: [], completed: 0 };

  const result: CheckOutput = { findings: [], completed: 0 };
  const errors: string[] = [];
  await Promise.all(
    mine.map(async (v) => {
      const jam = jamFor(v.free, per);
      // What can be simulated now: free (or, through the proxy, SaiProxy's free) when the CDP has no debt;
      // otherwise bite, which anyone can send and after which the owner's free can't be refused.
      const proxyFree = v.via && jam !== null ? encodeFunctionData({ abi: saiProxyAbi, functionName: "free", args: [TUB, v.cup, jam] }) : null;
      const tx =
        v.art > 0n
          ? { to: TUB, data: encodeFunctionData({ abi: tubAbi, functionName: "bite", args: [v.cup] }) }
          : v.via
            ? proxyFree && { to: v.via, data: encodeFunctionData({ abi: proxyAbi, functionName: "execute", args: [SAI_PROXY, proxyFree] }) }
            : { to: TUB, data: encodeFunctionData({ abi: tubAbi, functionName: "free", args: [v.cup, v.free] }) };
      if (!tx) return;
      let ok: boolean;
      try {
        ok = await wouldSucceed(l1Client(), { from: user, ...tx });
      } catch (e) {
        errors.push(`CDP ${v.n}: ${(e as Error).message.split("\n")[0]}`);
        return;
      }
      if (!ok) return;
      const bite = v.art > 0n ? `first settle its debt with bite(${v.cup}) on the Tub (${TUB}), from any wallet; then ` : "";
      const how = v.via
        ? `${bite}on your DSProxy (${v.via}), Write Contract → execute(address, bytes) with target ${SAI_PROXY} (Maker's SaiProxy) and data ${proxyFree}: the ETH is sent to this wallet.`
        : `${bite}on the Tub, free(${v.cup}, ${v.free}); then approve the Tub to spend that PETH on the PETH token (${PETH}) and call exit(${v.free}) on the Tub, which pays WETH (unwrap it with withdraw on the WETH contract).`;
      result.findings.push(
        makeFinding(SCD, {
          key: v.cup,
          label: `Maker SCD vault #${v.n}`,
          status: "ready",
          asset: ethAsset(rmul(v.free, per)),
          txHash: v.cup,
          txUrl: v.via ? `https://etherscan.io/address/${v.via}#writeContract` : `https://etherscan.io/address/${TUB}#writeContract`,
          linkLabel: v.via ? "Open your DSProxy" : "Open the Tub",
          timestamp: 0,
          note: `Collateral left in this Single-Collateral Dai vault (CDP) when Maker shut SCD down in 2020. It's yours to withdraw, on Etherscan: ${how}`,
          claimAt: v.via ? `Etherscan → your DSProxy ${v.via} → Write Contract → execute` : `Etherscan → Write Contract → free / exit, on ${TUB}`,
          minUsd: MIN_USD,
        }),
      );
    }),
  );
  if (errors.length) result.error = `withdrawal check failed: ${errors.join(" · ")}`;
  return result;
}
