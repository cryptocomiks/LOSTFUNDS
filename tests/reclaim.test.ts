import assert from "node:assert/strict";
import { before, beforeEach, describe, test } from "node:test";
import { base58 } from "@scure/base";
import { checkSource } from "../src/lib/checker.ts";
import {
  checkInactiveStake,
  checkMarinadeTickets,
  checkTokenRent,
  closableBy,
  coolingDown,
  parseStakeAccount,
  parseStakeHistory,
  parseTicket,
  type ClusterStake,
  type TokenAccountInfo,
} from "../src/lib/checks/reclaim.ts";
import { formatAmount } from "../src/lib/format.ts";
import { sourceById } from "../src/lib/sources.ts";
import { MockChain } from "./mockchain.ts";
import { hexBytes } from "../src/lib/solana.ts";
import {
  CLOCK_DATA,
  MARINADE_TICKET,
  MARINADE_TICKET_BENEFICIARY,
  MARINADE_TICKET_DATA,
  MARINADE_TICKET_LAMPORTS,
  STAKE_ACCOUNT,
  STAKE_ACCOUNT_DATA,
  STAKE_ACCOUNT_LAMPORTS,
  STAKE_WITHDRAWER,
} from "./real-data.ts";

const world = new MockChain();
before(() => {
  globalThis.fetch = world.fetch as typeof fetch;
});
beforeEach(() => {
  world.solanaErrors = {};
  world.solanaCalls = [];
});

const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const T22 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const STAKE_PROGRAM = "Stake11111111111111111111111111111111111111";
const CLOCK = "SysvarC1ock11111111111111111111111111111111";
const STAKE_HISTORY = "SysvarStakeHistory1111111111111111111111111";
const OWNER = "WHap92SebrYjz8bqv9rGhQcSdc8APCZFfxvb6sLVzch";
const OTHER = "5Lfc9EVo1CAWmK286cBLSbFex7XzyvN1orPdDEQSS7R2";
const NOT_DEACTIVATED = 2n ** 64n - 1n;
/** Rent-exempt deposits: Token account (165 bytes), Token-2022 with ImmutableOwner (170), + TransferFeeAmount (182). */
const RENT = 2_039_280;
const RENT_T22 = 2_074_080;
const RENT_T22_FEE = 2_157_600;

let seq = 1;
const key = () => base58.encode(new Uint8Array(32).fill(seq++));
const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const ciphertext = (zero: boolean) => btoa(String.fromCharCode(...new Uint8Array(64).fill(zero ? 0 : 7)));

function tokenAccount(p: {
  owner?: string;
  program?: string;
  lamports?: number;
  amount?: string;
  state?: string;
  isNative?: boolean;
  closeAuthority?: string;
  delegate?: string;
  extensions?: { extension: string; state?: Record<string, unknown> }[];
}) {
  return {
    pubkey: key(),
    programId: p.program ?? TOKEN,
    lamports: p.lamports ?? RENT,
    info: {
      isNative: p.isNative ?? false,
      mint: p.isNative ? "So11111111111111111111111111111111111111112" : key(),
      owner: p.owner ?? OWNER,
      state: p.state ?? "initialized",
      tokenAmount: { amount: p.amount ?? "0", decimals: 6, uiAmount: 0, uiAmountString: p.amount ?? "0" },
      ...(p.closeAuthority && { closeAuthority: p.closeAuthority }),
      ...(p.delegate && { delegate: p.delegate, delegatedAmount: { amount: "0", decimals: 6, uiAmount: 0, uiAmountString: "0" } }),
      ...(p.extensions && { extensions: p.extensions }),
    },
  };
}

describe("Reclaimable SOL: empty token accounts", () => {
  test("counts only the accounts the owner can close, and reports wrapped SOL separately", async () => {
    const closable = [
      tokenAccount({}),
      tokenAccount({ closeAuthority: OWNER }),
      tokenAccount({ delegate: OTHER }),
      // SOL sent to a token account by mistake comes back too: closing returns every lamport.
      tokenAccount({ lamports: RENT + 50_000_000 }),
      tokenAccount({ program: T22, lamports: RENT_T22, extensions: [{ extension: "immutableOwner" }] }),
      tokenAccount({ program: T22, lamports: RENT_T22_FEE, extensions: [{ extension: "immutableOwner" }, { extension: "transferFeeAmount", state: { withheldAmount: 0 } }] }),
      tokenAccount({
        program: T22,
        lamports: 2_853_600,
        extensions: [
          { extension: "immutableOwner" },
          {
            extension: "confidentialTransferAccount",
            state: { pendingBalanceLo: ciphertext(true), pendingBalanceHi: ciphertext(true), availableBalance: ciphertext(true), approved: true },
          },
        ],
      }),
      tokenAccount({ program: T22, lamports: RENT_T22, extensions: [{ extension: "pausableAccount" }, { extension: "transferHookAccount", state: { transferring: false } }] }),
    ];
    const blocked = [
      tokenAccount({ amount: "1000" }), // still holds tokens
      tokenAccount({ state: "frozen" }),
      tokenAccount({ closeAuthority: OTHER }), // someone else's close authority: they get the rent, not you
      tokenAccount({ program: T22, lamports: RENT_T22_FEE, extensions: [{ extension: "transferFeeAmount", state: { withheldAmount: 400000 } }] }),
      tokenAccount({
        program: T22,
        lamports: 2_853_600,
        extensions: [{ extension: "confidentialTransferAccount", state: { pendingBalanceLo: ciphertext(true), pendingBalanceHi: ciphertext(true), availableBalance: ciphertext(false) } }],
      }),
      tokenAccount({ program: T22, extensions: [{ extension: "confidentialTransferFeeAmount", state: { withheldAmount: ciphertext(false) } }] }),
      tokenAccount({ program: T22, extensions: [{ extension: "someFutureExtension" }] }), // unknown: no promise
      tokenAccount({ program: T22, amount: "5", extensions: [{ extension: "immutableOwner" }] }),
    ];
    const wrapped = [tokenAccount({ isNative: true, amount: "1000000000", lamports: 1_000_000_000 + RENT }), tokenAccount({ isNative: true, amount: "0" })];
    world.solanaTokenAccounts[OWNER] = [...closable, ...blocked, ...wrapped];

    const r = await checkTokenRent(OWNER);
    assert.deepEqual(world.solanaCalls, ["getTokenAccountsByOwner", "getTokenAccountsByOwner"], "Token and Token-2022: one request each");
    assert.equal(r.error, undefined);
    assert.equal(r.findings.length, 2);
    const [rent, wsol] = r.findings;
    assert.equal(rent.networkId, "reclaim-rent");
    assert.equal(rent.guideId, "reclaim");
    assert.equal(rent.networkName, "8 empty token accounts");
    assert.equal(rent.asset.symbol, "SOL");
    assert.equal(rent.asset.decimals, 9);
    assert.equal(rent.asset.priceKey, "coingecko:solana");
    assert.equal(rent.asset.amount, BigInt(closable.reduce((n, a) => n + a.lamports, 0)));
    assert.equal(rent.status, "ready");
    assert.equal(rent.timestamp, 0);
    assert.equal(rent.minUsd, 1);
    assert.match(rent.claimAt ?? "", /Solflare/);
    assert.ok(rent.note?.includes(`${formatAmount(rent.asset.amount, 9)} SOL in total`), `note: ${rent.note}`);
    assert.equal(rent.txUrl, `https://solscan.io/account/${OWNER}`);
    assert.equal(wsol.networkName, "Wrapped SOL (2 accounts)");
    assert.equal(wsol.asset.amount, BigInt(1_000_000_000 + 2 * RENT), "closing unwraps the whole balance, deposits included");
    assert.match(wsol.note ?? "", /wrapped SOL/);
    assert.notEqual(rent.id, wsol.id);
  });

  test("a wallet without empty accounts is clean", async () => {
    const owner = key();
    world.solanaTokenAccounts[owner] = [tokenAccount({ owner, amount: "42" }), tokenAccount({ owner, program: T22, amount: "1", extensions: [{ extension: "immutableOwner" }] })];
    assert.deepEqual(await checkTokenRent(owner), { findings: [], completed: 0 });
    assert.deepEqual(await checkTokenRent(key()), { findings: [], completed: 0 }, "no token accounts at all");
  });

  test("closableBy follows CloseAccount's rules", () => {
    const info = (p: Partial<TokenAccountInfo>): TokenAccountInfo => ({ isNative: false, owner: OWNER, state: "initialized", tokenAmount: { amount: "0" }, ...p });
    assert.equal(closableBy(info({}), OWNER), true);
    assert.equal(closableBy(info({}), OTHER), false, "only the owner's own accounts");
    assert.equal(closableBy(info({ state: "uninitialized" }), OWNER), false);
    assert.equal(closableBy(info({ isNative: true, tokenAmount: { amount: "5" } }), OWNER), true, "wrapped SOL closes with its balance");
    assert.equal(closableBy(info({ extensions: [{ extension: "transferFeeAmount", state: { withheldAmount: "0" } }] }), OWNER), true);
    assert.equal(closableBy(info({ extensions: [{ extension: "confidentialTransferFeeAmount", state: { withheldAmount: ciphertext(true) } }] }), OWNER), true);
    assert.equal(closableBy(info({ extensions: [{ extension: "confidentialTransferAccount", state: {} }] }), OWNER), false, "missing balances: no promise");
    assert.equal(closableBy(info({ extensions: [{ extension: "cpiGuard", state: { lockCpi: true } }] }), OWNER), true, "the CPI guard only blocks closing from another program");
  });

  test("dust is hidden once priced, a few dollars are shown", async () => {
    world.prices["coingecko:solana"] = 117;
    const src = sourceById("reclaim-rent")!;
    const one = key();
    world.solanaTokenAccounts[one] = [tokenAccount({ owner: one })];
    const dust = await checkSource(src, one);
    assert.equal(dust.state, "done");
    assert.equal(dust.findings.length, 0, "1 account ≈ $0.24: below the $1 threshold");
    const five = key();
    world.solanaTokenAccounts[five] = Array.from({ length: 5 }, () => tokenAccount({ owner: five }));
    const shown = await checkSource(src, five);
    assert.equal(shown.findings.length, 1);
    assert.equal(shown.findings[0].asset.amount, BigInt(5 * RENT));
    assert.ok(Math.abs(shown.findings[0].asset.usd! - 5 * 0.00203928 * 117) < 1e-9);
  });

  test("an RPC failure fails the check instead of reading as clean", async () => {
    world.solanaErrors.getTokenAccountsByOwner = "Internal error";
    const r = await checkSource(sourceById("reclaim-rent")!, OWNER);
    assert.equal(r.state, "error");
    assert.deepEqual(r.findings, []);
    assert.match(r.error ?? "", /Internal error/);
  });

  test("a node that rate-limits is retried even when the fallback node refuses", async () => {
    const owner = key();
    world.solanaTokenAccounts[owner] = Array.from({ length: 3 }, () => tokenAccount({ owner }));
    let limited = 0;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("solanavibestation") && limited++ < 1)
        return new Response('{"jsonrpc":"2.0","error":{"code":-32005,"message":"Too Many Requests"},"id":null}', { status: 429 });
      if (url.includes("api.mainnet-beta")) return new Response('{"jsonrpc":"2.0","error":{"code":403,"message":"Access forbidden"},"id":1}', { status: 403 });
      return world.fetch(input, init);
    }) as typeof fetch;
    try {
      const r = await checkTokenRent(owner);
      assert.equal(r.findings[0].asset.amount, BigInt(3 * RENT));
      assert.equal(limited, 3, "one 429, then the retry and the other program's request");
    } finally {
      globalThis.fetch = world.fetch as typeof fetch;
    }
  });
});

/* ───────────────────────── Stake ───────────────────────── */

const EPOCH = 1047n;
const NOW = 1_790_866_623n;

function clock(epoch = EPOCH, unix = NOW, intoEpoch = 15_000n): Uint8Array {
  const d = new Uint8Array(40);
  const v = new DataView(d.buffer);
  v.setBigUint64(0, 452_325_698n, true);
  v.setBigInt64(8, unix - intoEpoch, true);
  v.setBigUint64(16, epoch, true);
  v.setBigUint64(24, epoch + 1n, true);
  v.setBigInt64(32, unix, true);
  return d;
}

/** 512 epochs of history (newest first, like the sysvar), with `override` replacing some epochs. */
function stakeHistory(override: Record<number, Partial<ClusterStake>> = {}): Uint8Array {
  const n = 512;
  const d = new Uint8Array(8 + n * 32);
  const v = new DataView(d.buffer);
  v.setBigUint64(0, BigInt(n), true);
  for (let i = 0; i < n; i++) {
    const epoch = Number(EPOCH) - 1 - i;
    const e = { effective: 440_550_702_962_881_690n, activating: 2_158_781_879_458_901n, deactivating: 1_955_488_293_168_632n, ...override[epoch] };
    const o = 8 + i * 32;
    v.setBigUint64(o, BigInt(epoch), true);
    v.setBigUint64(o + 8, e.effective, true);
    v.setBigUint64(o + 16, e.activating, true);
    v.setBigUint64(o + 24, e.deactivating, true);
  }
  return d;
}

const VOTER = "MENFRmT2VDJKY9vGPUHVhrX2EKdmMSEzkwMf3iUbZWm";
function stakeAccount(p: {
  withdrawer?: string;
  staker?: string;
  state?: 1 | 2;
  lamports: number;
  stake?: bigint;
  deactivation?: bigint;
  lockupTimestamp?: bigint;
  lockupEpoch?: bigint;
  custodian?: string;
}) {
  const d = new Uint8Array(200);
  const v = new DataView(d.buffer);
  const withdrawer = p.withdrawer ?? OWNER;
  v.setUint32(0, p.state ?? 2, true);
  v.setBigUint64(4, 2_282_880n, true);
  d.set(base58.decode(p.staker ?? withdrawer), 12);
  d.set(base58.decode(withdrawer), 44);
  v.setBigInt64(76, p.lockupTimestamp ?? 0n, true);
  v.setBigUint64(84, p.lockupEpoch ?? 0n, true);
  d.set(base58.decode(p.custodian ?? "11111111111111111111111111111111"), 92);
  if ((p.state ?? 2) === 2) {
    d.set(base58.decode(VOTER), 124);
    v.setBigUint64(156, p.stake ?? BigInt(p.lamports - 2_282_880), true);
    v.setBigUint64(164, 414n, true);
    v.setBigUint64(172, p.deactivation ?? NOT_DEACTIVATED, true);
  }
  return { pubkey: key(), data: d, lamports: p.lamports };
}

describe("Reclaimable SOL: inactive stake", () => {
  before(() => {
    world.solana[CLOCK] = clock();
    world.solana[STAKE_HISTORY] = stakeHistory();
  });

  test("reports what the withdraw authority can withdraw now, nothing that is still staked", async () => {
    const ready = [
      stakeAccount({ lamports: 224_351_130_313, deactivation: 900n }), // unstaked long ago (older than the history)
      stakeAccount({ lamports: 3_025_580_546, deactivation: 1046n }), // unstaked last epoch
      stakeAccount({ state: 1, lamports: 5_002_282_880 }), // created, never delegated
      stakeAccount({ lamports: 1_500_000_000, deactivation: 1000n, lockupEpoch: 5000n, custodian: OWNER }), // locked, but the owner is the custodian
    ];
    const notReady = [
      stakeAccount({ lamports: 23_835_218_377 }), // active
      stakeAccount({ lamports: 9_000_000_000, deactivation: EPOCH }), // deactivating this epoch
      stakeAccount({ lamports: 7_000_000_000, deactivation: 1000n, lockupEpoch: 5000n, custodian: OTHER }), // lockup in force
      stakeAccount({ lamports: 6_000_000_000, deactivation: 1000n, lockupTimestamp: NOW + 86_400n, custodian: OTHER }),
      stakeAccount({ withdrawer: OTHER, staker: OWNER, lamports: 8_000_000_000, deactivation: 900n }), // someone else withdraws it
    ];
    world.solanaPrograms[STAKE_PROGRAM] = [...ready, ...notReady, { pubkey: key(), data: new Uint8Array(3228).fill(1), lamports: 1 }];

    const r = await checkInactiveStake(OWNER);
    assert.deepEqual(world.solanaCalls, ["getProgramAccounts", "getMultipleAccounts"]);
    assert.equal(r.findings.length, 1);
    const f = r.findings[0];
    assert.equal(f.networkId, "reclaim-stake");
    assert.equal(f.networkName, "4 inactive stake accounts");
    assert.equal(f.asset.amount, BigInt(ready.reduce((n, a) => n + a.lamports, 0)));
    assert.equal(f.asset.priceKey, "coingecko:solana");
    assert.equal(f.txUrl, `https://solscan.io/account/${OWNER}`);
    assert.equal(f.minUsd, 1);
    assert.match(f.claimAt ?? "", /Withdraw/);
  });

  test("only active stake: clean, without reading the sysvars", async () => {
    const owner = key();
    world.solanaPrograms[STAKE_PROGRAM] = [stakeAccount({ withdrawer: owner, lamports: 28_332_982_987 })];
    assert.deepEqual(await checkInactiveStake(owner), { findings: [], completed: 0 });
    assert.deepEqual(world.solanaCalls, ["getProgramAccounts"]);
    assert.deepEqual(await checkInactiveStake(key()), { findings: [], completed: 0 }, "no stake accounts at all");
  });

  test("a real stake account unstaked at epoch 900 (mainnet data)", async () => {
    const a = parseStakeAccount(STAKE_ACCOUNT, STAKE_ACCOUNT_LAMPORTS, b64(STAKE_ACCOUNT_DATA))!;
    assert.equal(a.state, 2);
    assert.equal(a.withdrawer, STAKE_WITHDRAWER);
    assert.equal(a.stake, 223_026_567_969n);
    assert.equal(a.deactivationEpoch, 900n);
    assert.equal(a.lockupEpoch, 0n);
    world.solanaPrograms[STAKE_PROGRAM] = [{ pubkey: STAKE_ACCOUNT, data: b64(STAKE_ACCOUNT_DATA), lamports: STAKE_ACCOUNT_LAMPORTS }];
    world.solana[CLOCK] = b64(CLOCK_DATA);
    try {
      const r = await checkInactiveStake(STAKE_WITHDRAWER);
      assert.equal(r.findings.length, 1);
      assert.equal(r.findings[0].asset.amount, BigInt(STAKE_ACCOUNT_LAMPORTS), "the whole balance, rewards and rent included");
      assert.equal(r.findings[0].networkName, "1 inactive stake account");
      assert.equal(r.findings[0].txUrl, `https://solscan.io/account/${STAKE_ACCOUNT}`, "one account: link to it");
    } finally {
      world.solana[CLOCK] = clock();
    }
  });

  test("stake still cooling down when the cluster's cooldown is saturated is not reported", async () => {
    const owner = key();
    world.solanaPrograms[STAKE_PROGRAM] = [stakeAccount({ withdrawer: owner, lamports: 50_000_000_000, deactivation: 1045n })];
    world.solana[STAKE_HISTORY] = stakeHistory({ 1045: { effective: 10n ** 17n, deactivating: 10n ** 17n }, 1046: { effective: 10n ** 17n, deactivating: 10n ** 17n } });
    try {
      assert.deepEqual(await checkInactiveStake(owner), { findings: [], completed: 0 });
    } finally {
      world.solana[STAKE_HISTORY] = stakeHistory();
    }
  });

  test("coolingDown mirrors the stake program's deactivation", () => {
    const history = parseStakeHistory(stakeHistory({ 1040: { deactivating: 0n }, 1045: { effective: 10n ** 17n, deactivating: 10n ** 17n }, 1046: { effective: 10n ** 17n, deactivating: 10n ** 17n } }));
    assert.equal(history.size, 512);
    const stake = 10_000_000_000n;
    assert.equal(coolingDown(stake, EPOCH, EPOCH, history), stake, "deactivating this epoch");
    assert.equal(coolingDown(stake, 1046n, EPOCH, parseStakeHistory(stakeHistory())), 0n, "one epoch is enough when the cluster isn't saturated");
    assert.equal(coolingDown(stake, 100n, EPOCH, history), 0n, "older than the history");
    assert.equal(coolingDown(stake, 1040n, EPOCH, history), 0n, "nothing deactivating that epoch");
    // Saturated: 9% of the remaining stake per epoch.
    const left = coolingDown(stake, 1045n, EPOCH, history);
    assert.equal(left, 8_281_000_000n);
  });

  test("an RPC failure fails the check instead of reading as clean", async () => {
    world.solanaErrors.getProgramAccounts = "Internal error";
    const r = await checkSource(sourceById("reclaim-stake")!, OWNER);
    assert.equal(r.state, "error");
    assert.deepEqual(r.findings, []);
    delete world.solanaErrors.getProgramAccounts;

    const owner = key();
    world.solanaPrograms[STAKE_PROGRAM] = [stakeAccount({ withdrawer: owner, lamports: 3_000_000_000, deactivation: 1000n })];
    world.solanaErrors.getMultipleAccounts = "Internal error";
    const r2 = await checkSource(sourceById("reclaim-stake")!, owner);
    assert.equal(r2.state, "error", "the sysvars are needed to tell withdrawable from still cooling down");
  });
});

/* ───────────────────────── Marinade ───────────────────────── */

const MARINADE_PROGRAM = "MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD";
const MARINADE_STATE = "8szGkuLTAux9XMgZ2vtY39jVSowEcpBfFfD8hXSEqdGC";
const MARINADE_RESERVE = "Du3Ysj1wKbxPKkuPPnvzQLQh8oMSVifs3jGZjJWXFmHN";
const TICKET_RENT = 1_503_360;

/** Marinade's State account (2,616 bytes): rent_exempt_for_token_acc at 138, paused at 608. */
function marinadeState(paused = false): Uint8Array {
  const d = new Uint8Array(2616);
  new DataView(d.buffer).setBigUint64(138, 2_039_280n, true);
  d[608] = paused ? 1 : 0;
  return d;
}

function ticket(p: { amount: bigint; created: bigint; beneficiary?: string; state?: string; discriminator?: string }) {
  const d = new Uint8Array(88);
  const v = new DataView(d.buffer);
  d.set(hexBytes(p.discriminator ?? "854d1262d301e703"), 0);
  d.set(base58.decode(p.state ?? MARINADE_STATE), 8);
  d.set(base58.decode(p.beneficiary ?? OWNER), 40);
  v.setBigUint64(72, p.amount, true);
  v.setBigUint64(80, p.created, true);
  return { pubkey: key(), data: d, lamports: TICKET_RENT };
}

describe("Reclaimable SOL: Marinade tickets", () => {
  before(() => {
    world.solana[MARINADE_STATE] = marinadeState();
    world.solanaLamports[MARINADE_RESERVE] = 36_830_236_590_139;
  });
  beforeEach(() => {
    world.solana[CLOCK] = clock();
  });

  test("a real ticket from epoch 399 that was never claimed (mainnet data)", async () => {
    const t = parseTicket(MARINADE_TICKET, MARINADE_TICKET_LAMPORTS, b64(MARINADE_TICKET_DATA), MARINADE_TICKET_BENEFICIARY)!;
    assert.equal(t.amount, 15_476_243_842_733n);
    assert.equal(t.createdEpoch, 399n);
    assert.equal(parseTicket(MARINADE_TICKET, MARINADE_TICKET_LAMPORTS, b64(MARINADE_TICKET_DATA), OWNER), null, "someone else's ticket");
    world.solanaPrograms[MARINADE_PROGRAM] = [{ pubkey: MARINADE_TICKET, data: b64(MARINADE_TICKET_DATA), lamports: MARINADE_TICKET_LAMPORTS }];
    const r = await checkMarinadeTickets(MARINADE_TICKET_BENEFICIARY);
    assert.deepEqual(world.solanaCalls, ["getProgramAccounts", "getMultipleAccounts"]);
    assert.equal(r.findings.length, 1);
    const f = r.findings[0];
    assert.equal(f.networkId, "reclaim-marinade");
    assert.equal(f.status, "ready");
    assert.equal(f.networkName, "Marinade unstake ticket");
    assert.equal(f.asset.amount, 15_476_243_842_733n + BigInt(MARINADE_TICKET_LAMPORTS), "the ticket's rent goes to the beneficiary too");
    assert.equal(f.txUrl, `https://solscan.io/account/${MARINADE_TICKET}`);
    assert.match(f.note ?? "", /epoch 399/);
    assert.match(f.claimAt ?? "", /app\.marinade\.finance/);
  });

  test("only due tickets of this wallet count", async () => {
    world.solanaPrograms[MARINADE_PROGRAM] = [
      ticket({ amount: 2_000_000_000n, created: 900n }),
      ticket({ amount: 3_000_000_000n, created: 1046n }), // due: 4 hours into the next epoch
      ticket({ amount: 5_000_000_000n, created: EPOCH }), // ordered this epoch
      ticket({ amount: 0n, created: 900n }), // emptied
      ticket({ amount: 7_000_000_000n, created: 900n, state: OTHER }), // another Marinade instance
      ticket({ amount: 8_000_000_000n, created: 900n, discriminator: "0000000000000000" }), // not a ticket
      ticket({ amount: 9_000_000_000n, created: 900n, beneficiary: OTHER }),
    ];
    const r = await checkMarinadeTickets(OWNER);
    assert.equal(r.findings.length, 1);
    assert.equal(r.findings[0].networkName, "2 Marinade unstake tickets");
    assert.equal(r.findings[0].asset.amount, 5_000_000_000n + 2n * BigInt(TICKET_RENT));
    assert.equal(r.findings[0].txUrl, `https://solscan.io/account/${OWNER}`);
  });

  test("a ticket is due 30 minutes into the epoch after it was ordered", async () => {
    world.solanaPrograms[MARINADE_PROGRAM] = [ticket({ amount: 3_000_000_000n, created: 1046n })];
    world.solana[CLOCK] = clock(EPOCH, NOW, 600n);
    assert.deepEqual(await checkMarinadeTickets(OWNER), { findings: [], completed: 0 });
    world.solana[CLOCK] = clock(EPOCH, NOW, 1800n);
    assert.equal((await checkMarinadeTickets(OWNER)).findings.length, 1);
  });

  test("paused, or a reserve that can't pay yet: shown as waiting", async () => {
    world.solanaPrograms[MARINADE_PROGRAM] = [ticket({ amount: 3_000_000_000n, created: 900n })];
    world.solana[MARINADE_STATE] = marinadeState(true);
    try {
      const r = await checkMarinadeTickets(OWNER);
      assert.equal(r.findings[0].status, "waiting");
      assert.match(r.findings[0].note ?? "", /try again/);
    } finally {
      world.solana[MARINADE_STATE] = marinadeState();
    }
    world.solanaLamports[MARINADE_RESERVE] = 3_000_000_000;
    try {
      assert.equal((await checkMarinadeTickets(OWNER)).findings[0].status, "waiting", "the reserve keeps a token account's rent");
    } finally {
      world.solanaLamports[MARINADE_RESERVE] = 36_830_236_590_139;
    }
  });

  test("no tickets: clean, in one request", async () => {
    world.solanaPrograms[MARINADE_PROGRAM] = [];
    assert.deepEqual(await checkMarinadeTickets(OWNER), { findings: [], completed: 0 });
    assert.deepEqual(world.solanaCalls, ["getProgramAccounts"]);
  });

  test("an RPC failure fails the check instead of reading as clean", async () => {
    world.solanaErrors.getProgramAccounts = "Internal error";
    assert.equal((await checkSource(sourceById("reclaim-marinade")!, OWNER)).state, "error");
    delete world.solanaErrors.getProgramAccounts;
    world.solanaPrograms[MARINADE_PROGRAM] = [ticket({ amount: 3_000_000_000n, created: 900n })];
    world.solanaErrors.getMultipleAccounts = "Internal error";
    assert.equal((await checkSource(sourceById("reclaim-marinade")!, OWNER)).state, "error");
  });
});
