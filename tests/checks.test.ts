import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { parseEther, parseUnits } from "viem";
import { checkNetwork, InputError, resolveInput } from "../src/lib/checker.ts";
import { networkById } from "../src/lib/networks.ts";
import { buildWorld, USER } from "./fixtures.ts";

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
    const { address } = await resolveInput("  0xd8da6bf26964af9d7eed9e03e53415d37aa96045 ");
    assert.equal(address, "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045");
  });
  test("rejects Solana addresses with a clear message", async () => {
    await assert.rejects(resolveInput("9VpXTJ3YuA4Rvt1seDY4BaYiNpf5LZrxRKopGjgytgCG"), InputError);
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
