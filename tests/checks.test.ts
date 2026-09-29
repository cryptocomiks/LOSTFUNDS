import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { parseAbi, parseAbiItem, parseEther, parseUnits, type Address, type Hex } from "viem";
import { checkNetwork, InputError, resolveInput } from "../src/lib/checker.ts";
import { networkById } from "../src/lib/networks.ts";
import { buildWorld, USDC_L1, USER } from "./fixtures.ts";

const world = buildWorld();
before(() => {
  globalThis.fetch = world.fetch as typeof fetch;
});

const run = (id: string) => checkNetwork(networkById(id)!, USER);

describe("Arbitrum", () => {
  test("finds unclaimed ETH and token withdrawals, skips spent ones", async () => {
    const r = await run("arbitrum");
    assert.equal(r.state, "done", r.error ?? "");
    assert.equal(r.completed, 1);
    assert.equal(r.findings.length, 2);

    const eth = r.findings.find((f) => f.asset.symbol === "ETH")!;
    assert.equal(eth.asset.amount, parseEther("1.5"));
    assert.equal(eth.status, "ready");
    assert.equal(eth.asset.usd, 4500);

    const usdc = r.findings.find((f) => f.asset.symbol === "USDC")!;
    assert.equal(usdc.asset.amount, parseUnits("2500", 6));
    assert.equal(usdc.asset.decimals, 6);
    assert.equal(usdc.asset.usd, 2500);
    assert.match(usdc.txUrl, /^https:\/\/arbiscan\.io\/tx\/0x/);
  });
});

describe("Arbitrum Orbit chains", () => {
  const ARBSYS: Address = "0x0000000000000000000000000000000000000064";
  const l2ToL1Tx = parseAbiItem(
    "event L2ToL1Tx(address caller, address indexed destination, uint256 indexed hash, uint256 indexed position, uint256 arbBlockNum, uint256 ethBlockNum, uint256 timestamp, uint256 callvalue, bytes data)",
  );
  const gatewayEvent = parseAbiItem(
    "event WithdrawalInitiated(address l1Token, address indexed _from, address indexed _to, uint256 indexed _l2ToL1Id, uint256 _exitNum, uint256 _amount)",
  );
  const DAY = 86_400;
  const t0 = Math.floor(Date.now() / 1000);
  const h = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
  const msg = (position: bigint, destination: Address, callvalue: bigint) => ({
    address: ARBSYS,
    event: l2ToL1Tx,
    args: { caller: USER, destination, hash: position, position, arbBlockNum: 1n, ethBlockNum: 1n, timestamp: 1n, callvalue, data: "0x" },
  });
  const withdrawal = (chainId: number, hash: Hex, block: bigint, ageDays: number, logs: ReturnType<typeof msg>[]) =>
    world.addTx({ chainId, hash, from: USER, to: ARBSYS, blockNumber: block, timestamp: t0 - ageDays * DAY, logs });
  const outbox = (address: Address, spent: bigint[]) =>
    world.addContract(1, address, parseAbi(["function isSpent(uint256) view returns (bool)"]), { isSpent: ([i]) => spent.includes(i as bigint) });
  const PLUME_L1: Address = "0x4C1746A800D224393fE2470C70A35717eD4eA5F1";
  const G_L1: Address = "0x9C7BEBa8F6eF6643aBd725e45a4E8387eF260649";

  before(() => {
    // Plume (PLUME gas token, Blockscout): 29.86 PLUME unclaimed, 49,000 PLUME claimed, 0.2 USDC through the gateway.
    withdrawal(98866, h(0x91), 20_000_000n, 143, [msg(49129n, USER, parseEther("29.859909"))]);
    withdrawal(98866, h(0x92), 20_000_001n, 150, [msg(100n, USER, parseEther("49000"))]);
    world.addTx({
      chainId: 98866,
      hash: h(0x93),
      from: USER,
      to: "0xEFE6F45507C24Bb85Fa25d417fe7d43763b9dE3d",
      blockNumber: 20_000_002n,
      timestamp: t0 - 200 * DAY,
      logs: [
        msg(5n, "0xE2C902BC61296531e556962ffC81A082b82f5F28", 0n),
        {
          address: "0x3955A911411cfae01c8B6Fd0D57c08DfE4428e38",
          event: gatewayEvent,
          args: { l1Token: USDC_L1, _from: USER, _to: USER, _l2ToL1Id: 5n, _exitNum: 0n, _amount: 200_000n },
        } as never,
      ],
    });
    outbox("0x7e4627bC114Fcd12ba912103279FD2858E644E71", [100n]);
    world.prices[`ethereum:${PLUME_L1.toLowerCase()}`] = 0.02;
    // Gravity (G gas token, no explorer API: found through the RPC node's event search).
    withdrawal(1625, h(0x81), 9_000_000n, 493, [msg(1352n, USER, parseEther("293.38"))]);
    outbox("0x1153a1e4B1523DFf36f77d696bd6eBF2B0e7DAbF", []);
    world.prices[`ethereum:${G_L1.toLowerCase()}`] = 0.005;
    // Robinhood Chain (ETH, RPC only, 10M blocks per eth_getLogs): withdrawals in different chunks.
    world.logsRangeLimit[4663] = 10_000_000;
    withdrawal(4663, h(0x71), 3_000_000n, 87, [msg(49n, USER, parseEther("0.042209"))]);
    withdrawal(4663, h(0x72), 25_000_000n, 60, [msg(64n, USER, parseEther("0.41"))]);
    withdrawal(4663, h(0x73), 29_999_999n, 1, [msg(2700n, USER, parseEther("1"))]);
    outbox("0xf0ce991ea4A0d2400A4AB49b20ae333f6Dce3DE9", [64n]);
  });

  test("Plume: gas-token withdrawals are paid out in PLUME, not ETH", async () => {
    const r = await run("plume");
    assert.equal(r.state, "done", r.error ?? "");
    assert.equal(r.completed, 1);
    const plume = r.findings.find((f) => f.asset.symbol === "PLUME")!;
    assert.equal(plume.status, "ready");
    assert.equal(plume.asset.amount, parseEther("29.859909"));
    assert.equal(plume.asset.decimals, 18);
    assert.equal(plume.asset.token, PLUME_L1, "priced as PLUME on Ethereum");
    assert.ok(Math.abs(plume.asset.usd! - 0.597) < 0.001, String(plume.asset.usd));
    assert.equal(plume.txUrl, `https://explorer.plume.org/tx/${h(0x91)}`);
    const usdc = r.findings.find((f) => f.asset.symbol === "USDC")!;
    assert.equal(usdc.asset.amount, 200_000n);
    assert.equal(r.findings.length, 2);
  });

  test("Gravity: G withdrawals found through the RPC node", async () => {
    const r = await run("gravity");
    assert.equal(r.state, "done", r.error ?? "");
    assert.equal(r.findings.length, 1);
    assert.equal(r.findings[0].asset.symbol, "G");
    assert.equal(r.findings[0].asset.amount, parseEther("293.38"));
    assert.equal(r.findings[0].asset.token, G_L1);
    assert.ok(Math.abs(r.findings[0].asset.usd! - 1.4669) < 0.001);
  });

  test("Robinhood Chain: searches its history in 10M-block chunks", async () => {
    const r = await run("robinhood");
    assert.equal(r.state, "done", r.error ?? "");
    assert.equal(r.completed, 1, "position 64 (third chunk) was claimed");
    const got = r.findings.map((f) => `${f.status} ${f.asset.amount} ${f.asset.symbol}`).sort();
    assert.deepEqual(got, [`ready ${parseEther("0.042209")} ETH`, `recent ${parseEther("1")} ETH`]);
  });

  test("Robinhood Chain: one failed chunk fails the check (never a silent miss)", async () => {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? init.body : "";
      if (String(input).includes("robinhood") && body.includes('"fromBlock":"0x1312d00"'))
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "internal error" } }));
      return world.fetch(input, init);
    }) as typeof fetch;
    try {
      const r = await run("robinhood");
      assert.equal(r.state, "error");
      assert.match(r.error ?? "", /internal error/);
    } finally {
      globalThis.fetch = world.fetch as typeof fetch;
    }
  });
});

describe("Scroll", () => {
  test("computes the L1 message hash and reports the unexecuted withdrawal", async () => {
    const r = await run("scroll");
    assert.equal(r.state, "done", r.error ?? "");
    assert.equal(r.findings.length, 1);
    assert.equal(r.findings[0].asset.amount, parseEther("0.5"));
    assert.equal(r.findings[0].status, "ready");
  });
});

describe("Linea", () => {
  test("uses the bitmap and the L1 MessageClaimed event", async () => {
    const r = await run("linea");
    assert.equal(r.state, "done", r.error ?? "");
    assert.equal(r.completed, 1, "old message claimed via V1 must count as completed");
    assert.equal(r.findings.length, 1);
    assert.equal(r.findings[0].asset.amount, parseEther("2"));
  });
});

describe("OP Mainnet", () => {
  test("flags unrelayed pre-Bedrock withdrawals for manual claim", async () => {
    const r = await run("optimism");
    assert.equal(r.state, "done", r.error ?? "");
    assert.equal(r.findings.length, 1);
    assert.equal(r.findings[0].status, "manual");
    assert.equal(r.findings[0].asset.symbol, "ETH");
    assert.equal(r.findings[0].asset.amount, parseEther("3"));
  });
});

describe("Networks with nothing to report", () => {
  test("Base comes back clean", async () => {
    const r = await run("base");
    assert.equal(r.state, "done", r.error ?? "");
    assert.equal(r.findings.length, 0);
  });
});

describe("Input", () => {
  test("accepts lowercase addresses and checksums them", async () => {
    const { address, kind } = await resolveInput("  0xd8da6bf26964af9d7eed9e03e53415d37aa96045 ");
    assert.equal(address, "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045");
    assert.equal(kind, "evm");
  });
  test("accepts Solana addresses", async () => {
    const t = await resolveInput("9VpXTJ3YuA4Rvt1seDY4BaYiNpf5LZrxRKopGjgytgCG");
    assert.deepEqual(t, { kind: "solana", address: "9VpXTJ3YuA4Rvt1seDY4BaYiNpf5LZrxRKopGjgytgCG" });
  });
  test("rejects transaction hashes with a clear message", async () => {
    await assert.rejects(resolveInput(`0x${"ab".repeat(32)}`), /transaction hash/);
  });
  test("rejects garbage", async () => {
    await assert.rejects(resolveInput("hello"), InputError);
  });
});

describe("Rate limits", () => {
  test("retries a busy explorer (HTTP 429) and still gets the result", async () => {
    let busy = 2;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("rpc.scroll.io") && busy > 0) {
        busy--;
        return new Response("Too Many Requests", { status: 429 });
      }
      return world.fetch(input, init);
    }) as typeof fetch;
    const r = await run("scroll");
    globalThis.fetch = world.fetch as typeof fetch;
    assert.equal(r.state, "done", r.error ?? "");
    assert.equal(r.findings.length, 1);
    assert.equal(busy, 0);
  });

  test("reports every source's error when all of them fail", async () => {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("mode")) return new Response("nope", { status: 403 });
      return world.fetch(input, init);
    }) as typeof fetch;
    const r = await run("mode");
    globalThis.fetch = world.fetch as typeof fetch;
    assert.equal(r.state, "error");
    assert.match(r.error ?? "", /explorer\.mode\.network v2: HTTP 403/);
    assert.match(r.error ?? "", /rpc mainnet\.mode\.network: HTTP 403/);
  });
});

describe("Fallbacks", () => {
  const withFetch = async (block: (url: string) => boolean, fn: () => Promise<void>) => {
    const seen: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      seen.push(url);
      if (block(url)) return new Response("down", { status: 403 });
      return world.fetch(input, init);
    }) as typeof fetch;
    try {
      await fn();
    } finally {
      globalThis.fetch = world.fetch as typeof fetch;
    }
    return seen;
  };

  test("uses the wallet's own sent transactions first (no event scans)", async () => {
    const seen = await withFetch(() => false, async () => {
      const r = await run("arbitrum");
      assert.equal(r.findings.length, 2);
    });
    const explorer = seen.filter((u) => u.includes("arbitrum.blockscout.com"));
    assert.equal(explorer.length, 1, explorer.join("\n"));
    assert.match(explorer[0], /\/api\/v2\/addresses\/0x[0-9a-fA-F]{40}\/transactions\?filter=from/);
  });

  test("falls back to the older API when the v2 API is down", async () => {
    const seen = await withFetch((u) => u.includes("/api/v2/"), async () => {
      const r = await run("arbitrum");
      assert.equal(r.state, "done", r.error ?? "");
      assert.equal(r.findings.length, 2);
    });
    assert.ok(seen.some((u) => u.includes("action=txlist")));
  });

  test("searches events on the RPC node when the explorer is down (Zora has no Blockscout)", async () => {
    // Zora: no explorer at all, the RPC node is the only history source
    const seen = await withFetch(() => false, async () => {
      const r = await run("zora");
      assert.equal(r.state, "done", r.error ?? "");
    });
    assert.ok(seen.some((u) => u.startsWith("https://rpc.zora.energy")));
  });

  test("falls back to event-log search when no source supports the transaction list", async () => {
    await withFetch((u) => u.includes("action=txlist"), async () => {
      const r = await run("scroll");
      assert.equal(r.state, "done", r.error ?? "");
      assert.equal(r.findings.length, 1);
    });
  });
});
