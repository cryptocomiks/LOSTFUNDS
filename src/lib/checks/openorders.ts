import { base58 } from "@scure/base";
import { formatAmount } from "../format";
import { accountsData, rpc, SOLANA_INDEX_RPCS } from "../solana";
import type { Asset, Finding } from "../types";
import { makeFinding, type CheckOutput, type FindingSource } from "./common";

/**
 * Serum and OpenBook (v1) "open orders" accounts. Trading on a Serum-based order book (Serum's own
 * DEX, Raydium's and Jupiter's early routes, Step, Bonfida…) opened one account per market, paid
 * for by the trader: about 0.023 SOL of rent each, never given back unless the account is closed.
 * Tokens from filled orders also wait there until they are "settled": 3,400 accounts on Serum's
 * SOL/USDC market alone still held some in November 2026.
 *
 * One getProgramAccounts per program (filtered on the owner, first 125 bytes only), then, for
 * accounts holding tokens, their markets (mints) and the mints (decimals) in two requests.
 * Everything is read from the accounts' own state: only the owner can settle and close them.
 * Step Finance's dashboard, which did it for everyone, closed in February 2026: the guide gives
 * the instructions to send with a script.
 */

export const OPEN_ORDERS: FindingSource = { id: "reclaim-openorders", name: "Serum / OpenBook accounts", guideId: "reclaim" };

const PROGRAMS = [
  { id: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", name: "Serum" },
  { id: "srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX", name: "OpenBook" },
];
/** OpenOrders account (Serum v3 / OpenBook v1): "serum" padding, then the fields read below. */
const OPEN_ORDERS_SIZE = 3228;
const OWNER_OFFSET = 45;
/** Account flags: Initialized | OpenOrders, and Closed. */
const INITIALIZED_OPEN_ORDERS = 5n;
const CLOSED = 256n;

/** Mints often traded on Serum; any other is shown by its address. */
const KNOWN_MINTS: Record<string, string> = {
  So11111111111111111111111111111111111111112: "SOL",
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC",
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: "USDT",
  SRMuApVNdxXokk5GT7XD5cUUgXMBCoAz2LHeuAoKWRt: "SRM",
  "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R": "RAY",
  "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs": "ETH (Wormhole)",
  "2FPyTwcZLUg1MDrwsyoP4D6s1tM7hAkHYRjkNb5w6Pxk": "ETH (Sollet)",
  "9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E": "BTC (Sollet)",
  "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh": "WBTC (Wormhole)",
  mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So: "mSOL",
  DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263: "BONK",
  orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE: "ORCA",
  MangoCzJ36AjZyKwVj3VnYU4GTonjfVEnJmvvWaxLac: "MNGO",
  StepAscQoEioFxxWGnh2sLBDFp9d8rvKz2Yp39iDpyT: "STEP",
  kinXdEcpDQeHPEuQnqmUgtYykqKGVFq6CeVX5iAHJq6: "KIN",
  EchesyfXePKdLtoiZSL8pBe8Myagyy8ZRqsACNCFGnvp: "FIDA",
};

const sol = (lamports: bigint): Asset => ({ symbol: "SOL", decimals: 9, amount: lamports, priceKey: "coingecko:solana" });
const solscan = (account: string) => `https://solscan.io/account/${account}`;
const plural = (n: number, word: string) => `${n.toLocaleString("en-US")} ${word}${n > 1 ? "s" : ""}`;
const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export interface OpenOrders {
  pubkey: string;
  program: string;
  lamports: bigint;
  market: string;
  /** Tokens waiting in the account (settled or locked in orders still open), in base and quote lots of the market's mints. */
  baseTotal: bigint;
  quoteTotal: bigint;
  /** Orders still on the book (a bit cleared in freeSlotBits). */
  hasOrders: boolean;
}

/** The first 125 bytes of an OpenOrders account: flags, market, owner, the four balances, freeSlotBits. */
export function parseOpenOrders(pubkey: string, program: string, lamports: number, d: Uint8Array, owner: string): OpenOrders | null {
  if (d.length < 125) return null;
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const flags = v.getBigUint64(5, true);
  if ((flags & INITIALIZED_OPEN_ORDERS) !== INITIALIZED_OPEN_ORDERS || flags & CLOSED) return null;
  if (base58.encode(d.subarray(OWNER_OFFSET, OWNER_OFFSET + 32)) !== owner) return null;
  const freeSlots = v.getBigUint64(109, true) | (v.getBigUint64(117, true) << 64n);
  return {
    pubkey,
    program,
    lamports: BigInt(lamports),
    market: base58.encode(d.subarray(13, 45)),
    baseTotal: v.getBigUint64(85, true),
    quoteTotal: v.getBigUint64(101, true),
    hasOrders: freeSlots !== 2n ** 128n - 1n,
  };
}

export async function checkOpenOrders(owner: string): Promise<CheckOutput> {
  const out: CheckOutput = { findings: [], completed: 0 };
  const accounts: OpenOrders[] = [];
  // One program after the other: the index node allows a burst of about 3 requests.
  for (const p of PROGRAMS) {
    const list = await rpc<{ pubkey: string; account: { lamports: number; data: [string, string] } }[]>(
      "getProgramAccounts",
      [p.id, { encoding: "base64", dataSlice: { offset: 0, length: 125 }, filters: [{ dataSize: OPEN_ORDERS_SIZE }, { memcmp: { offset: OWNER_OFFSET, bytes: owner } }] }],
      SOLANA_INDEX_RPCS,
    );
    for (const a of list) {
      const oo = parseOpenOrders(a.pubkey, p.name, a.account.lamports, b64(a.account.data[0]), owner);
      if (oo) accounts.push(oo);
    }
  }
  if (!accounts.length) return out;

  const rent = accounts.reduce((n, a) => n + a.lamports, 0n);
  const withTokens = accounts.filter((a) => a.baseTotal > 0n || a.quoteTotal > 0n);
  const withOrders = accounts.filter((a) => a.hasOrders).length;
  const programs = [...new Set(accounts.map((a) => a.program))].join(" and ");
  const one = accounts.length === 1;
  out.findings.push(
    makeFinding(OPEN_ORDERS, {
      key: "rent",
      label: plural(accounts.length, `${programs} open orders account`),
      status: "ready",
      asset: sol(rent),
      txHash: owner,
      txUrl: solscan(one ? accounts[0].pubkey : owner),
      linkLabel: one ? "View account" : "View wallet",
      timestamp: 0,
      note:
        `Trading on ${programs}'s order book${one ? "" : "s"} opened ${one ? "an account" : `${plural(accounts.length, "account")}, one per market,`} ` +
        `paid for by this wallet. ${one ? "It still holds its" : "They still hold their"} rent deposit${one ? "" : "s"} (about 0.023 SOL each): ` +
        `${formatAmount(rent, 9)} SOL in total, sent back to your wallet when ${one ? "the account is" : "they are"} closed.` +
        (withTokens.length ? ` ${one ? "It" : `${withTokens.length.toLocaleString("en-US")} of them`} still hold${withTokens.length > 1 ? "" : "s"} tokens (listed separately): settle them first, closing comes after.` : "") +
        (withOrders ? ` ${plural(withOrders, "account")} still ${withOrders > 1 ? "have" : "has"} orders on the book, to cancel first.` : ""),
      claimAt: "a script (see the guide: no app does it since Step Finance closed)",
      minUsd: 1,
    }),
  );
  if (!withTokens.length) return out;

  // Tokens: the markets give the mints (base at 53, quote at 85), the mints give the decimals (byte 44).
  const markets = [...new Set(withTokens.map((a) => a.market))];
  const marketData = await accountsData(markets);
  const mintsOf = new Map<string, [string, string]>();
  markets.forEach((m, i) => {
    const d = marketData[i];
    if (d && d.length >= 117) mintsOf.set(m, [base58.encode(d.subarray(53, 85)), base58.encode(d.subarray(85, 117))]);
  });
  const mints = [...new Set([...mintsOf.values()].flat())];
  const mintData = await accountsData(mints);
  const decimalsOf = new Map(mints.map((m, i) => [m, mintData[i] && mintData[i]!.length >= 45 ? mintData[i]![44] : undefined]));

  const byMint = new Map<string, { amount: bigint; accounts: Set<string> }>();
  let unknown = 0;
  for (const a of withTokens) {
    const pair = mintsOf.get(a.market);
    if (!pair) {
      unknown++;
      continue;
    }
    for (const [mint, amount] of [
      [pair[0], a.baseTotal],
      [pair[1], a.quoteTotal],
    ] as const) {
      if (amount === 0n) continue;
      const e = byMint.get(mint) ?? { amount: 0n, accounts: new Set<string>() };
      e.amount += amount;
      e.accounts.add(a.pubkey);
      byMint.set(mint, e);
    }
  }
  for (const [mint, { amount, accounts: held }] of byMint) {
    const decimals = decimalsOf.get(mint);
    if (decimals === undefined) {
      unknown++;
      continue;
    }
    const symbol = KNOWN_MINTS[mint] ?? `SPL token ${mint.slice(0, 4)}…${mint.slice(-4)}`;
    const first = [...held][0];
    const finding: Finding = makeFinding(OPEN_ORDERS, {
      key: `tokens:${mint}`,
      label: `Unsettled ${KNOWN_MINTS[mint] ?? "tokens"} on ${programs}`,
      status: "ready",
      asset: { symbol, decimals, amount, priceKey: mint === "So11111111111111111111111111111111111111112" ? "coingecko:solana" : `solana:${mint}` },
      txHash: first,
      txUrl: solscan(first),
      linkLabel: "View account",
      timestamp: 0,
      note:
        `${formatAmount(amount, decimals)} ${symbol} from orders on ${programs} ${held.size > 1 ? `wait in ${held.size} of your open orders accounts` : "wait in one of your open orders accounts"}` +
        ` (mint ${mint}). They were never settled: settling sends them to your wallet, then the account can be closed for its rent.`,
      claimAt: "a script: settle, then close (see the guide)",
      minUsd: 1,
    });
    out.findings.push(finding);
  }
  if (unknown) out.error = "Some markets or mints could not be read: unsettled tokens may be missing.";
  return out;
}
