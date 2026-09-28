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
      if (url.includes("scroll.blockscout.com") && busy > 0) {
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

  test("reports the real cause when a source keeps failing", async () => {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("explorer.zora.energy")) return new Response("nope", { status: 403 });
      return world.fetch(input, init);
    }) as typeof fetch;
    const r = await run("zora");
    globalThis.fetch = world.fetch as typeof fetch;
    assert.equal(r.state, "error");
    assert.match(r.error ?? "", /explorer\.zora\.energy: HTTP 403/);
  });
});
