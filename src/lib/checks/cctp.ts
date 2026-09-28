import { decodeEventLog, parseAbiItem, toEventSelector, type Address, type Hex } from "viem";
import { addressTopic, getLogs } from "../explorer";
import { L1 } from "../networks";
import { accountsData, accountsExist, findProgramAddress, hexBytes } from "../solana";
import type { Asset } from "../types";
import { DAY, makeFinding, now, type CheckOutput, type FindingSource } from "./common";

/**
 * Circle CCTP: USDC burned on Ethereum for Solana but never minted there.
 *
 * Burns are found on Ethereum (DepositForBurn, depositor = the user). Whether the
 * USDC was minted is read from Solana's MessageTransmitter, which records every
 * nonce it has processed:
 *   - CCTP v1: a bitmap account per 6,400 nonces ("used_nonces")
 *   - CCTP v2: one account per message nonce ("used_nonce"), nonce from Circle's API
 */

export const CCTP: FindingSource = { id: "cctp", name: "Circle CCTP", guideId: "cctp" };

const SOLANA_DOMAIN = 5;
const USDC: Address = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const V1 = {
  tokenMessenger: "0xBd3fa81B58Ba92a82136038B25aDec7066af3155" as Address,
  solanaTransmitter: "CCTPmbSD7gX1bxKPAmg77w8oFzNFpaQiQUWD43TKaecd",
  event: parseAbiItem(
    "event DepositForBurn(uint64 indexed nonce, address indexed burnToken, uint256 amount, address indexed depositor, bytes32 mintRecipient, uint32 destinationDomain, bytes32 destinationTokenMessenger, bytes32 destinationCaller)",
  ),
};
const V2 = {
  tokenMessenger: "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d" as Address,
  solanaTransmitter: "CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC",
  event: parseAbiItem(
    "event DepositForBurn(address indexed burnToken, uint256 amount, address indexed depositor, bytes32 mintRecipient, uint32 destinationDomain, bytes32 destinationTokenMessenger, bytes32 destinationCaller, uint256 maxFee, uint32 indexed minFinalityThreshold, bytes hookData)",
  ),
};

const enc = (s: string) => new TextEncoder().encode(s);
const usdc = (amount: bigint): Asset => ({ symbol: "USDC", decimals: 6, amount, token: USDC, tokenChain: "ethereum" });
const ZERO32 = `0x${"0".repeat(64)}`;

interface Burn {
  tx: Hex;
  timestamp: number;
  amount: bigint;
  destinationCaller: Hex;
  nonce?: bigint; // v1
}

async function burnsToSolana(ev: typeof V1.event | typeof V2.event, messenger: Address, topics: (Hex | null)[]): Promise<Burn[]> {
  const logs = await getLogs(L1, messenger, [toEventSelector(ev), ...topics] as never);
  const out: Burn[] = [];
  for (const l of logs) {
    const d = decodeEventLog({ abi: [ev], data: l.data, topics: l.topics as [Hex, ...Hex[]] }) as unknown as {
      args: { amount: bigint; destinationDomain: number; destinationCaller: Hex; nonce?: bigint };
    };
    if (d.args.destinationDomain !== SOLANA_DOMAIN) continue;
    out.push({ tx: l.transactionHash, timestamp: l.timestamp, amount: d.args.amount, destinationCaller: d.args.destinationCaller, nonce: d.args.nonce });
  }
  return out;
}

/** v1: has Solana processed this nonce from Ethereum (domain 0)? */
async function v1Minted(nonces: bigint[]): Promise<boolean[]> {
  const firstOf = (n: bigint) => ((n - 1n) / 6400n) * 6400n + 1n;
  const firsts = [...new Set(nonces.map(firstOf))];
  const pdas = firsts.map((f) => findProgramAddress([enc("used_nonces"), enc("0"), enc(f.toString())], V1.solanaTransmitter));
  const data = new Map((await accountsData(pdas)).map((d, i) => [firsts[i], d]));
  return nonces.map((n) => {
    const d = data.get(firstOf(n));
    if (!d) return false;
    const idx = Number(n - firstOf(n));
    // layout: discriminator(8) remote_domain(4) first_nonce(8) used_nonces[u64; 100], little-endian
    const off = 20 + Math.floor(idx / 64) * 8;
    let word = 0n;
    for (let i = 7; i >= 0; i--) word = (word << 8n) | BigInt(d[off + i]);
    return ((word >> BigInt(idx % 64)) & 1n) === 1n;
  });
}

/** v2: the message nonce is assigned off-chain; read it from Circle's API. */
async function v2Nonces(tx: Hex): Promise<{ nonce: Hex; attested: boolean }[]> {
  const res = await fetch(`https://iris-api.circle.com/v2/messages/0?transactionHash=${tx}`, { signal: AbortSignal.timeout(20_000) });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`Circle API: HTTP ${res.status}`);
  const { messages = [] } = (await res.json()) as {
    messages?: { eventNonce: Hex; status: string; decodedMessage?: { destinationDomain?: string } }[];
  };
  return messages
    .filter((m) => m.decodedMessage?.destinationDomain === String(SOLANA_DOMAIN))
    .map((m) => ({ nonce: m.eventNonce, attested: m.status === "complete" }));
}

export async function checkCctp(user: Address): Promise<CheckOutput> {
  const u = addressTopic(user);
  const [v1, v2] = await Promise.all([
    burnsToSolana(V1.event, V1.tokenMessenger, [null, null, u]), // depositor is the 3rd indexed arg
    burnsToSolana(V2.event, V2.tokenMessenger, [null, u]), // depositor is the 2nd indexed arg
  ]);

  const out: CheckOutput = { findings: [], completed: 0 };
  const report = (b: Burn, key: string) => {
    const restricted = b.destinationCaller !== ZERO32;
    out.findings.push(
      makeFinding(CCTP, {
        key,
        label: "Circle CCTP · Ethereum → Solana",
        status: now() - b.timestamp < DAY ? "recent" : "ready",
        asset: usdc(b.amount),
        txHash: b.tx,
        txUrl: `https://etherscan.io/tx/${b.tx}`,
        timestamp: b.timestamp,
        note:
          "USDC was burned on Ethereum and attested by Circle, but never minted on Solana." +
          (restricted
            ? " Only the app you used can complete it (it set itself as the destination caller): reopen that app."
            : " Anyone can complete it with the attestation: use a CCTP tool or the app you used."),
      }),
    );
  };

  const minted1 = await v1Minted(v1.map((b) => b.nonce!));
  v1.forEach((b, i) => (minted1[i] ? out.completed++ : report(b, `v1-${b.nonce}`)));

  for (const b of v2) {
    const msgs = await v2Nonces(b.tx);
    const done = await accountsExist(msgs.map((m) => findProgramAddress([enc("used_nonce"), hexBytes(m.nonce)], V2.solanaTransmitter)));
    msgs.forEach((m, i) => (done[i] ? out.completed++ : report(b, `v2-${m.nonce}`)));
  }
  return out;
}
