import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { checkSource, runChecks } from "../src/lib/checker.ts";
import type { CheckOutput } from "../src/lib/checks/common.ts";
import { readCache, writeCache } from "../src/lib/resultCache.ts";
import type { CheckSource } from "../src/lib/sources.ts";
import { addPrices } from "../src/lib/tokens.ts";
import type { Asset, Finding, NetworkResult } from "../src/lib/types.ts";

/** A fake price API that records every request. */
function priceApi(prices: Record<string, number>) {
  const requests: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    requests.push(url);
    const keys = url.split("/").pop()!.split(",");
    return Response.json({ coins: Object.fromEntries(keys.filter((k) => prices[k]).map((k) => [k, { price: prices[k] }])) });
  }) as typeof fetch;
  return requests;
}

const asset = (token: string, amount = 10n ** 18n): Asset => ({ symbol: "T", decimals: 18, amount, token: token as `0x${string}`, tokenChain: "ethereum" });
const finding = (id: string, a: Asset, minUsd?: number): Finding => ({
  id,
  networkId: "x",
  networkName: "X",
  guideId: "x",
  status: "ready",
  asset: a,
  txHash: "0x",
  txUrl: "",
  timestamp: 0,
  minUsd,
});
const source = (id: string, run: () => Promise<CheckOutput>): CheckSource => ({ id, name: id, group: "rewards", bridgeUrl: "", accepts: ["evm"], run });

describe("Prices", () => {
  test("lookups made together go out as one request, and each key is fetched once per session", async () => {
    const requests = priceApi({ "ethereum:0x01": 2, "ethereum:0x02": 3 });
    const a = [asset("0x01"), asset("0x02")];
    const b = [asset("0x01"), asset("0x03")];
    await Promise.all([addPrices(a), addPrices(b)]);
    assert.equal(requests.length, 1, "one batched request");
    assert.deepEqual([a[0].usd, a[1].usd, b[0].usd, b[1].usd], [2, 3, 2, undefined]);
    await addPrices([asset("0x02")]);
    assert.equal(requests.length, 1, "cached");
  });

  test("a failed lookup is retried later, never fatal", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response("no", { status: 400 });
    }) as typeof fetch;
    const x = [asset("0x0a")];
    await addPrices(x);
    assert.equal(x[0].usd, undefined);
    priceApi({ "ethereum:0x0a": 5 });
    const y = [asset("0x0a")];
    await addPrices(y);
    assert.equal(y[0].usd, 5, "not stuck on the failure");
    assert.equal(calls, 1, "a 4xx isn't retried in a loop");
  });
});

describe("Running checks", () => {
  test("dust findings are hidden once priced; unpriced ones are kept", async () => {
    priceApi({ "ethereum:0xd1": 1 });
    const r = await checkSource(
      source("dust", async () => ({
        findings: [finding("small", asset("0xd1", 3n * 10n ** 18n), 5), finding("big", asset("0xd1", 9n * 10n ** 18n), 5), finding("unpriced", asset("0xd9"), 5)],
        completed: 0,
      })),
      "0x1111111111111111111111111111111111111111",
    );
    assert.deepEqual(r.findings.map((f) => f.id), ["big", "unpriced"]);
  });

  test("at most a few checks run at once; every one reports queued → running → result", async () => {
    let running = 0;
    let peak = 0;
    const order: string[] = [];
    const fake = Array.from({ length: 40 }, (_, i) =>
      source(`s${i}`, async () => {
        peak = Math.max(peak, ++running);
        await new Promise((r) => setTimeout(r, 5));
        running--;
        return { findings: [], completed: 0 };
      }),
    );
    const { SOURCES } = await import("../src/lib/sources.ts");
    const saved = SOURCES.splice(0, SOURCES.length, ...fake);
    try {
      const states = new Map<string, string[]>();
      await runChecks({ kind: "evm", address: "0x1111111111111111111111111111111111111111" }, (r) => {
        states.set(r.networkId, [...(states.get(r.networkId) ?? []), r.state]);
        order.push(r.networkId);
      });
      assert.ok(peak <= 14 && peak > 1, `peak ${peak}`);
      assert.equal(states.size, 40);
      for (const s of states.values()) assert.deepEqual(s, ["queued", "running", "done"]);
      const only: string[] = [];
      await runChecks({ kind: "evm", address: "0x1111111111111111111111111111111111111111" }, (r) => only.push(r.networkId), undefined, ["s3", "s7"]);
      assert.deepEqual([...new Set(only)].sort(), ["s3", "s7"]);
    } finally {
      SOURCES.splice(0, SOURCES.length, ...saved);
    }
  });
});

describe("Result cache", () => {
  const store = new Map<string, string>();
  globalThis.localStorage = {
    get length() {
      return store.size;
    },
    key: (i: number) => [...store.keys()][i] ?? null,
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  } as Storage;

  const result = (id: string, state: NetworkResult["state"]): NetworkResult => ({
    networkId: id,
    state,
    findings: state === "done" ? [finding(`${id}:f`, asset("0x01", 123456789012345678901234567890n))] : [],
    completed: 1,
  });

  test("keeps completed checks for a few minutes, amounts intact", () => {
    writeCache("evm", "0xAbC0000000000000000000000000000000000001", [result("a", "done"), result("b", "error")]);
    const hit = readCache("evm", "0xabc0000000000000000000000000000000000001");
    assert.ok(hit);
    assert.deepEqual(hit!.results.map((r) => r.networkId), ["a"], "failed checks aren't cached");
    assert.equal(hit!.results[0].findings[0].asset.amount, 123456789012345678901234567890n);
  });

  test("expires, and Solana addresses stay case-sensitive", () => {
    writeCache("evm", "0x00000000000000000000000000000000000000aa", [result("a", "done")], Date.now() - 11 * 60_000);
    assert.equal(readCache("evm", "0x00000000000000000000000000000000000000aa"), null);
    writeCache("solana", "AbcSoLanaAddr", [result("a", "done")]);
    assert.ok(readCache("solana", "AbcSoLanaAddr"));
    assert.equal(readCache("solana", "abcsolanaaddr"), null);
  });
});

describe("Networks the address never used", () => {
  test("one batched RPC call instead of an explorer search; contracts and RPC errors still get the full check", async () => {
    const { buildWorld, USER } = await import("./fixtures.ts");
    const { checkNetwork } = await import("../src/lib/checker.ts");
    const { networkById } = await import("../src/lib/networks.ts");
    const { parseAbi } = await import("viem");
    const world = buildWorld();
    globalThis.fetch = world.fetch as typeof fetch;
    const base = networkById("base")!;

    // Never active on Base: no explorer request at all.
    const STRANGER = "0x3333333333333333333333333333333333333333";
    world.requests.length = 0;
    const idle = await checkNetwork(base, STRANGER);
    assert.equal(idle.state, "done");
    assert.ok(world.requests.length > 0 && world.requests.every((u) => !u.includes("blockscout")), world.requests.join("\n"));

    // A smart-contract wallet (code, nonce 0) always gets the full search.
    world.addContract(base.chain.id, STRANGER, parseAbi(["function x() view returns (uint256)"]), { x: () => 1n });
    world.requests.length = 0;
    await checkNetwork(base, STRANGER);
    assert.ok(world.requests.some((u) => u.includes("base.blockscout.com")), "contract wallets are searched");

    // The RPC can't answer: never skip on doubt.
    const real = world.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const body = String(init?.body ?? "");
      if (body.includes("eth_getTransactionCount")) return new Response("busy", { status: 503 });
      return real(input, init);
    }) as typeof fetch;
    world.requests.length = 0;
    const r = await checkNetwork(base, "0x4444444444444444444444444444444444444444");
    assert.equal(r.state, "done");
    assert.ok(world.requests.some((u) => u.includes("base.blockscout.com")), "full check when activity is unknown");

    // An active user is checked as before.
    globalThis.fetch = real as typeof fetch;
    const arb = await checkNetwork(networkById("arbitrum")!, USER);
    assert.ok(arb.findings.length > 0, "existing withdrawals still found");
  });
});
