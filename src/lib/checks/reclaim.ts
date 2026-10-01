import { base58 } from "@scure/base";
import { formatAmount } from "../format";
import { accountsData, rpc, SOLANA_INDEX_RPCS, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from "../solana";
import type { Asset } from "../types";
import { makeFinding, type CheckOutput, type FindingSource } from "./common";

/**
 * SOL a Solana wallet can take back by itself, with one transaction from its own wallet:
 *   - the rent deposits of its empty token accounts (Token and Token-2022), and its wrapped SOL;
 *   - stake accounts that were unstaked (or never delegated): their SOL earns nothing until withdrawn;
 *   - Marinade delayed-unstake tickets that are due but were never claimed.
 * Each list comes from an index node (getTokenAccountsByOwner, getProgramAccounts): 2 requests
 * for the token accounts, 1 for the stake accounts, 1 for the tickets, plus 1 to a regular node
 * (sysvars, Marinade's reserve) only when there is something to look at.
 */

export const RENT: FindingSource = { id: "reclaim-rent", name: "Empty token accounts", guideId: "reclaim" };
export const STAKE: FindingSource = { id: "reclaim-stake", name: "Inactive stake", guideId: "reclaim" };
export const MARINADE: FindingSource = { id: "reclaim-marinade", name: "Marinade tickets", guideId: "reclaim" };

const STAKE_PROGRAM = "Stake11111111111111111111111111111111111111";
const CLOCK = "SysvarC1ock11111111111111111111111111111111";
const STAKE_HISTORY = "SysvarStakeHistory1111111111111111111111111";
/** Token accounts owned by these can only be closed into the incinerator: nothing comes back. */
const NO_RECLAIM = new Set(["11111111111111111111111111111111", "1nc1nerator11111111111111111111111111111111"]);

const sol = (lamports: bigint): Asset => ({ symbol: "SOL", decimals: 9, amount: lamports, priceKey: "coingecko:solana" });
const solscan = (account: string) => `https://solscan.io/account/${account}`;
const plural = (n: number, word: string) => `${n.toLocaleString("en-US")} ${word}${n > 1 ? "s" : ""}`;
const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/* ───────────────────────── Token accounts ───────────────────────── */

/** A token account as the RPC parses it (encoding "jsonParsed"). */
export interface TokenAccountInfo {
  isNative: boolean;
  owner: string;
  state: "initialized" | "frozen" | "uninitialized";
  tokenAmount: { amount: string };
  closeAuthority?: string;
  extensions?: { extension: string; state?: Record<string, unknown> }[];
}

interface KeyedTokenAccount {
  pubkey: string;
  /** `parsed` is missing when the node couldn't parse the account (it then sends raw data). */
  account: { lamports: number; data: { parsed?: { type?: string; info?: TokenAccountInfo } } };
}

/** Token-2022 account extensions that never stop an empty account from being closed. */
const HARMLESS = new Set(["uninitialized", "immutableOwner", "memoTransfer", "nonTransferableAccount", "cpiGuard", "transferHookAccount", "pausableAccount"]);

/** An all-zero ElGamal ciphertext (base64), the only "empty" Token-2022 accepts for confidential balances. */
function zeroCiphertext(v: unknown): boolean {
  if (typeof v !== "string" || !v) return false;
  try {
    return b64(v).every((b) => b === 0);
  } catch {
    return false;
  }
}

/**
 * Whether `owner` can close this token account now, per Token / Token-2022 CloseAccount: no tokens
 * left (wrapped SOL excepted), signed by the close authority (the owner when unset), and on
 * Token-2022 no withheld transfer fees and no confidential balance. The programs don't look at the
 * frozen state, but frozen accounts are left out anyway, and so is any extension we don't know.
 */
export function closableBy(info: TokenAccountInfo, owner: string): boolean {
  if (info.owner !== owner || info.state !== "initialized") return false;
  if (!info.isNative && info.tokenAmount.amount !== "0") return false;
  if (info.closeAuthority && info.closeAuthority !== owner) return false;
  return (info.extensions ?? []).every(({ extension, state = {} }) => {
    if (HARMLESS.has(extension)) return true;
    if (extension === "transferFeeAmount") return String(state.withheldAmount) === "0";
    if (extension === "confidentialTransferAccount")
      return zeroCiphertext(state.pendingBalanceLo) && zeroCiphertext(state.pendingBalanceHi) && zeroCiphertext(state.availableBalance);
    if (extension === "confidentialTransferFeeAmount") return zeroCiphertext(state.withheldAmount);
    return false;
  });
}

/** Rent locked in the wallet's empty token accounts, and its wrapped SOL (closing unwraps it). */
export async function checkTokenRent(owner: string): Promise<CheckOutput> {
  const out: CheckOutput = { findings: [], completed: 0 };
  if (NO_RECLAIM.has(owner)) return out;
  const lists = await Promise.all(
    [TOKEN_PROGRAM, TOKEN_2022_PROGRAM].map((programId) =>
      rpc<{ value: KeyedTokenAccount[] }>("getTokenAccountsByOwner", [owner, { programId }, { encoding: "jsonParsed" }], SOLANA_INDEX_RPCS),
    ),
  );
  let empty = 0;
  let rent = 0n;
  let wrapped = 0;
  let wrappedLamports = 0n;
  for (const { account } of lists.flatMap((l) => l.value)) {
    const info = account.data.parsed?.info;
    if (account.data.parsed?.type !== "account" || !info || !closableBy(info, owner)) continue;
    if (info.isNative) {
      wrapped++;
      wrappedLamports += BigInt(account.lamports);
    } else {
      empty++;
      rent += BigInt(account.lamports);
    }
  }
  if (empty)
    out.findings.push(
      makeFinding(RENT, {
        key: "empty",
        label: plural(empty, "empty token account"),
        status: "ready",
        asset: sol(rent),
        txHash: owner,
        txUrl: solscan(owner),
        timestamp: 0,
        note:
          `${empty > 1 ? `These ${plural(empty, "token account")} are` : "This token account is"} empty, but each one still holds the ` +
          `rent deposit paid when it was opened (about 0.002 SOL): ${formatAmount(rent, 9)} SOL in total. Closing an empty account sends ` +
          `its deposit back to your wallet. No tokens are touched, and the account can be opened again later.`,
        claimAt: "Solflare (token → ⋯ → Close Account), or sol-incinerator.com",
        minUsd: 1,
      }),
    );
  if (wrapped)
    out.findings.push(
      makeFinding(RENT, {
        key: "wsol",
        label: wrapped > 1 ? `Wrapped SOL (${wrapped} accounts)` : "Wrapped SOL",
        status: "ready",
        asset: sol(wrappedLamports),
        txHash: owner,
        txUrl: solscan(owner),
        timestamp: 0,
        note:
          `This wallet holds ${formatAmount(wrappedLamports, 9)} SOL as wrapped SOL (wSOL), often left over by a swap. Unwrapping closes the ` +
          `wrapped SOL account: its whole balance, rent deposit included, comes back to your wallet as plain SOL.`,
        claimAt: "your wallet (Wrapped SOL → ⋯ → Unwrap)",
        minUsd: 1,
      }),
    );
  return out;
}

/* ───────────────────────── Stake accounts ───────────────────────── */

const NOT_DEACTIVATED = 2n ** 64n - 1n;
/** Slowest cooldown the stake program has used: 9% of the cluster's stake per epoch (it used to be 25%). */
const COOLDOWN_RATE = 0.09;

export interface StakeAccount {
  pubkey: string;
  lamports: bigint;
  /** 1: initialized (never delegated), 2: delegated. */
  state: 1 | 2;
  withdrawer: string;
  lockupTimestamp: bigint;
  lockupEpoch: bigint;
  custodian: string;
  /** Delegated lamports, and the epoch the delegation was deactivated (2^64 − 1 while it isn't). */
  stake: bigint;
  deactivationEpoch: bigint;
}

/** StakeStateV2 (200 bytes): u32 state, Meta (reserve, staker, withdrawer, lockup), then the delegation. */
export function parseStakeAccount(pubkey: string, lamports: number, d: Uint8Array): StakeAccount | null {
  if (d.length < 200) return null;
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const state = v.getUint32(0, true);
  if (state !== 1 && state !== 2) return null;
  return {
    pubkey,
    lamports: BigInt(lamports),
    state,
    withdrawer: base58.encode(d.subarray(44, 76)),
    lockupTimestamp: v.getBigInt64(76, true),
    lockupEpoch: v.getBigUint64(84, true),
    custodian: base58.encode(d.subarray(92, 124)),
    stake: state === 2 ? v.getBigUint64(156, true) : 0n,
    deactivationEpoch: state === 2 ? v.getBigUint64(172, true) : NOT_DEACTIVATED,
  };
}

export interface ClusterStake {
  effective: bigint;
  activating: bigint;
  deactivating: bigint;
}

/** StakeHistory sysvar: u64 count, then (epoch, effective, activating, deactivating) per epoch. */
export function parseStakeHistory(d: Uint8Array): Map<bigint, ClusterStake> {
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const out = new Map<bigint, ClusterStake>();
  const n = Number(v.getBigUint64(0, true));
  for (let i = 0, o = 8; i < n && o + 32 <= d.length; i++, o += 32)
    out.set(v.getBigUint64(o, true), { effective: v.getBigUint64(o + 8, true), activating: v.getBigUint64(o + 16, true), deactivating: v.getBigUint64(o + 24, true) });
  return out;
}

/**
 * Stake still cooling down at `epoch`, for `stake` lamports deactivated at `deactivationEpoch`: the
 * stake program's own computation (each epoch, the account's share of what the whole cluster may
 * deactivate), started from the full delegation at the slowest rate, so it never underestimates.
 * Zero means fully inactive: the whole balance can be withdrawn.
 */
export function coolingDown(stake: bigint, deactivationEpoch: bigint, epoch: bigint, history: Map<bigint, ClusterStake>): bigint {
  if (epoch <= deactivationEpoch) return stake;
  let cluster = history.get(deactivationEpoch);
  if (!cluster) return 0n; // older than the history (512 epochs): long done
  let left = stake;
  for (let e = deactivationEpoch + 1n; ; e++) {
    if (cluster.deactivating === 0n) return 0n;
    const weight = Number(left) / Number(cluster.deactivating);
    const released = BigInt(Math.max(1, Math.floor(weight * (Number(cluster.effective) * COOLDOWN_RATE))));
    left = left > released ? left - released : 0n;
    if (left === 0n || e >= epoch) return left;
    const next = history.get(e);
    if (!next) return left;
    cluster = next;
  }
}

/**
 * Stake accounts whose SOL the wallet can withdraw now: it's their withdraw authority, nothing is
 * staked any more (unstaked in an earlier epoch and fully cooled down, or never delegated) and no
 * lockup is in force. Active and still-deactivating stake isn't lost, so it isn't reported.
 */
export async function checkInactiveStake(owner: string): Promise<CheckOutput> {
  const out: CheckOutput = { findings: [], completed: 0 };
  const list = await rpc<{ pubkey: string; account: { lamports: number; data: [string, string] } }[]>(
    "getProgramAccounts",
    [STAKE_PROGRAM, { encoding: "base64", filters: [{ dataSize: 200 }, { memcmp: { offset: 44, bytes: owner } }] }],
    SOLANA_INDEX_RPCS,
  );
  const unstaked = list
    .map((a) => parseStakeAccount(a.pubkey, a.account.lamports, b64(a.account.data[0])))
    .filter((a): a is StakeAccount => !!a && a.withdrawer === owner && (a.state === 1 || a.deactivationEpoch !== NOT_DEACTIVATED));
  if (!unstaked.length) return out;

  const [clock, historyData] = await accountsData([CLOCK, STAKE_HISTORY]);
  if (!clock || clock.length < 40 || !historyData) throw new Error("Solana RPC: Clock / StakeHistory sysvars unavailable");
  const c = new DataView(clock.buffer, clock.byteOffset, clock.byteLength);
  const epoch = c.getBigUint64(16, true);
  const unixTimestamp = c.getBigInt64(32, true);
  const history = parseStakeHistory(historyData);
  const ready = unstaked.filter(
    (a) =>
      !((a.lockupTimestamp > unixTimestamp || a.lockupEpoch > epoch) && a.custodian !== owner) &&
      (a.state === 1 || coolingDown(a.stake, a.deactivationEpoch, epoch, history) === 0n),
  );
  if (!ready.length) return out;
  const total = ready.reduce((n, a) => n + a.lamports, 0n);
  const one = ready.length === 1;
  out.findings.push(
    makeFinding(STAKE, {
      key: "withdrawable",
      label: plural(ready.length, "inactive stake account"),
      status: "ready",
      asset: sol(total),
      txHash: owner,
      txUrl: solscan(one ? ready[0].pubkey : owner),
      timestamp: 0,
      note:
        `${one ? "This stake account was" : `These ${ready.length} stake accounts were`} unstaked or never delegated: ` +
        `${formatAmount(total, 9)} SOL that earns nothing and isn't in your spendable balance until you withdraw it. ` +
        `Withdrawing sends the whole balance back to your wallet and closes the stake account.`,
      claimAt: "your wallet's staking tab (Phantom: Withdraw Stake, Solflare: Withdraw)",
      minUsd: 1,
    }),
  );
  return out;
}

/* ───────────────────────── Marinade tickets ───────────────────────── */

const MARINADE_PROGRAM = "MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD";
const MARINADE_STATE = "8szGkuLTAux9XMgZ2vtY39jVSowEcpBfFfD8hXSEqdGC";
/** findProgramAddress([state, "reserve"], program): the account that pays tickets out. */
const MARINADE_RESERVE = "Du3Ysj1wKbxPKkuPPnvzQLQh8oMSVifs3jGZjJWXFmHN";
/** First 8 bytes of sha256("account:TicketAccountData") (Anchor's account discriminator). */
const TICKET_DISCRIMINATOR = "854d1262d301e703";
/** A ticket is due one epoch after it was created, and 30 minutes into that epoch. */
const TICKET_EXTRA_WAIT = 30n * 60n;
/** Offsets in Marinade's State account: rent_exempt_for_token_acc (u64) and paused (bool). */
const STATE_RESERVE_FLOOR = 138;
const STATE_PAUSED = 608;

export interface Ticket {
  pubkey: string;
  /** SOL the ticket pays out, and the ticket account's own rent (also sent to the beneficiary when claimed). */
  amount: bigint;
  rent: bigint;
  createdEpoch: bigint;
}

const hex = (d: Uint8Array) => Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");

/** TicketAccountData (88 bytes): discriminator, state, beneficiary, lamports_amount (u64), created_epoch (u64). */
export function parseTicket(pubkey: string, lamports: number, d: Uint8Array, beneficiary: string): Ticket | null {
  if (d.length !== 88 || hex(d.subarray(0, 8)) !== TICKET_DISCRIMINATOR) return null;
  if (base58.encode(d.subarray(8, 40)) !== MARINADE_STATE || base58.encode(d.subarray(40, 72)) !== beneficiary) return null;
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const amount = v.getBigUint64(72, true);
  return amount ? { pubkey, amount, rent: BigInt(lamports), createdEpoch: v.getBigUint64(80, true) } : null;
}

/**
 * Marinade delayed-unstake tickets of this wallet that are due: Marinade unstaked the SOL an epoch
 * after the ticket was created and keeps it in its reserve until the beneficiary claims it (anyone
 * may send the claim; the SOL can only go to the beneficiary). Marinade has since replaced tickets
 * with stake accounts (MIP-8): on Oct 1, 2026, 1,091 tickets worth 29,021 SOL had never been claimed.
 */
export async function checkMarinadeTickets(owner: string): Promise<CheckOutput> {
  const out: CheckOutput = { findings: [], completed: 0 };
  const list = await rpc<{ pubkey: string; account: { lamports: number; data: [string, string] } }[]>(
    "getProgramAccounts",
    [MARINADE_PROGRAM, { encoding: "base64", filters: [{ dataSize: 88 }, { memcmp: { offset: 40, bytes: owner } }] }],
    SOLANA_INDEX_RPCS,
  );
  const tickets = list.map((a) => parseTicket(a.pubkey, a.account.lamports, b64(a.account.data[0]), owner)).filter((t): t is Ticket => !!t);
  if (!tickets.length) return out;

  // The clock (is it due?), Marinade's state (paused?) and its reserve (can it pay?): one request.
  const { value } = await rpc<{ value: ({ lamports: number; data: [string, string] } | null)[] }>("getMultipleAccounts", [
    [MARINADE_STATE, MARINADE_RESERVE, CLOCK],
    { encoding: "base64" },
  ]);
  const [stateAccount, reserve, clockAccount] = value;
  const state = stateAccount && b64(stateAccount.data[0]);
  const clock = clockAccount && b64(clockAccount.data[0]);
  if (!state || state.length <= STATE_PAUSED || !reserve || !clock || clock.length < 40) throw new Error("Solana RPC: Marinade state unavailable");
  const c = new DataView(clock.buffer, clock.byteOffset, clock.byteLength);
  const epoch = c.getBigUint64(16, true);
  const intoEpoch = c.getBigInt64(32, true) - c.getBigInt64(8, true);
  const due = tickets.filter((t) => epoch > t.createdEpoch + 1n || (epoch === t.createdEpoch + 1n && intoEpoch >= TICKET_EXTRA_WAIT));
  if (!due.length) return out; // ordered this epoch: on its way, not lost

  const s = new DataView(state.buffer, state.byteOffset, state.byteLength);
  const owed = due.reduce((n, t) => n + t.amount, 0n);
  const total = due.reduce((n, t) => n + t.amount + t.rent, 0n);
  // Claim pays from the reserve, which keeps a token account's rent, and fails while Marinade is paused.
  const payable = state[STATE_PAUSED] === 0 && BigInt(reserve.lamports) - s.getBigUint64(STATE_RESERVE_FLOOR, true) >= owed;
  const one = due.length === 1;
  const oldest = due.reduce((m, t) => (t.createdEpoch < m ? t.createdEpoch : m), due[0].createdEpoch);
  out.findings.push(
    makeFinding(MARINADE, {
      key: "tickets",
      label: one ? "Marinade unstake ticket" : `${due.length} Marinade unstake tickets`,
      status: payable ? "ready" : "waiting",
      asset: sol(total),
      txHash: owner,
      txUrl: solscan(one ? due[0].pubkey : owner),
      timestamp: 0,
      note:
        `${one ? "This wallet ordered a delayed unstake" : `This wallet ordered ${due.length} delayed unstakes`} on Marinade ` +
        `(epoch ${oldest}${one ? "" : " onwards"}) and never claimed the SOL: ${formatAmount(total, 9)} SOL is waiting in ` +
        `Marinade's reserve, ticket rent included. Claiming sends it to this wallet.` +
        (payable ? "" : " Marinade can't pay it out at this moment (paused, or its reserve is being refilled): try again in a few hours."),
      claimAt: "app.marinade.finance, or Marinade's CLI (marinade claim <ticket>)",
      minUsd: 1,
    }),
  );
  return out;
}
