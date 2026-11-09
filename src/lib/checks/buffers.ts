import { base58 } from "@scure/base";
import { formatAmount } from "../format";
import { rpc, SOLANA_INDEX_RPCS } from "../solana";
import { makeFinding, type CheckOutput, type FindingSource } from "./common";

/**
 * Program buffers. Deploying a Solana program first writes it into a buffer account, paid for by
 * the deployer (about 7 SOL per MB of program). When a deploy fails or is interrupted, the buffer
 * stays, with its SOL, until its authority closes it: 7,300 SOL in 3,300 buffers in November 2026.
 * One getProgramAccounts on the upgradeable loader, filtered on Buffer accounts whose authority
 * is the wallet (lamports only, no data).
 */

export const BUFFERS: FindingSource = { id: "reclaim-buffers", name: "Program buffers", guideId: "reclaim" };

const LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
/** UpgradeableLoaderState::Buffer (u32 = 1), then Some(authority): tag 1 and the 32-byte key. */
export const bufferFilter = (authority: string) => base58.encode(Uint8Array.of(1, 0, 0, 0, 1, ...base58.decode(authority)));

export async function checkBuffers(authority: string): Promise<CheckOutput> {
  const out: CheckOutput = { findings: [], completed: 0 };
  const list = await rpc<{ pubkey: string; account: { lamports: number } }[]>(
    "getProgramAccounts",
    [LOADER, { encoding: "base64", dataSlice: { offset: 0, length: 0 }, filters: [{ memcmp: { offset: 0, bytes: bufferFilter(authority) } }] }],
    SOLANA_INDEX_RPCS,
  );
  if (!list.length) return out;
  const total = list.reduce((n, a) => n + BigInt(a.account.lamports), 0n);
  const one = list.length === 1;
  out.findings.push(
    makeFinding(BUFFERS, {
      key: "buffers",
      label: one ? "1 program buffer" : `${list.length.toLocaleString("en-US")} program buffers`,
      status: "ready",
      asset: { symbol: "SOL", decimals: 9, amount: total, priceKey: "coingecko:solana" },
      txHash: one ? list[0].pubkey : authority,
      txUrl: `https://solscan.io/account/${one ? list[0].pubkey : authority}`,
      linkLabel: one ? "View buffer" : "View wallet",
      timestamp: 0,
      claimAt: "Solana CLI: solana program close --buffers",
      minUsd: 1,
      note:
        `${one ? "A program buffer" : `${list.length} program buffers`} left by ${one ? "a " : ""}Solana program deploy${one ? "" : "s"} that never finished ` +
        `${one ? "holds" : "hold"} ${formatAmount(total, 9)} SOL. This wallet is ${one ? "its" : "their"} authority: closing ${one ? "it" : "them"} sends all of it back. ` +
        `Deployed programs are not affected.`,
    }),
  );
  return out;
}
