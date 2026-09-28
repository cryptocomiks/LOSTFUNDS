/**
 * Renders the built site (out/) in Chromium with all blockchain traffic served by the mock world,
 * and saves screenshots. Usage: npm run build && npx tsx tests/screenshots.ts <outDir>
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import * as pw from "playwright";
import { buildWorld, USER } from "./fixtures.ts";

const OUT = process.argv[2] ?? "screenshots";
const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".txt": "text/plain" };

const server = createServer(async (req, res) => {
  let p = decodeURIComponent(new URL(req.url!, "http://x").pathname);
  if (p.endsWith("/")) p += "index.html";
  try {
    const body = await readFile(join("out", p));
    res.writeHead(200, { "content-type": TYPES[extname(p)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
}).listen(4321);

const world = buildWorld();
const browser = await pw.chromium.launch();

async function shoot(name: string, opts: { width: number; height: number; dark?: boolean; path?: string; full?: boolean; failHost?: string[]; action?: (page: import("playwright").Page) => Promise<void> }) {
  const ctx = await browser.newContext({
    viewport: { width: opts.width, height: opts.height },
    deviceScaleFactor: 2,
    colorScheme: opts.dark ? "dark" : "light",
  });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.route(/^https?:\/\/(?!localhost)/, async (route) => {
    const r = route.request();
    if (opts.failHost?.some((h) => r.url().includes(h))) return route.fulfill({ status: 403, body: "blocked" });
    const res = await world.fetch(r.url(), { method: r.method(), body: r.postData() ?? undefined });
    await route.fulfill({ status: res.status, headers: { "content-type": "application/json", "access-control-allow-origin": "*" }, body: await res.text() });
  });
  await page.goto(`http://localhost:4321${opts.path ?? "/"}`);
  await page.waitForTimeout(400);
  if (opts.action) await opts.action(page);
  // Reveal everything for full-page shots.
  await page.evaluate(() => document.querySelectorAll(".reveal").forEach((e) => e.classList.add("is-visible")));
  await page.waitForTimeout(1000);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: opts.full ?? false });
  if (await page.locator("section[aria-live]").count())
    await page.locator("section[aria-live]").screenshot({ path: `${OUT}/${name}-section.png` });
  if (errors.length) console.log(`[${name}] errors:`, errors);
  await ctx.close();
}

const waitResults = async (page: import("playwright").Page) => {
  await page.waitForFunction(() => /(\d+)\/\1 checks done/.test(document.body.innerText), null, { timeout: 30000 });
};

await shoot("desktop-hero", { width: 1280, height: 860 });
await shoot("desktop-full", { width: 1280, height: 900, full: true });
await shoot("desktop-dark-full", { width: 1280, height: 900, full: true, dark: true });
await shoot("mobile-full", { width: 390, height: 844, full: true });
await shoot("results", { width: 1280, height: 900, path: `/?address=${USER}`, full: true, action: waitResults });
await shoot("results-dark-mobile", { width: 390, height: 844, dark: true, path: `/?address=${USER}`, full: true, action: waitResults });
await shoot("results-clean", {
  width: 1280,
  height: 900,
  path: `/?address=0x3333333333333333333333333333333333333333`,
  action: async (p) => {
    await waitResults(p);
    await p.locator("section[aria-live]").scrollIntoViewIfNeeded();
  },
});
await shoot("results-incomplete", {
  width: 1280,
  height: 900,
  path: `/?address=0x3333333333333333333333333333333333333333`,
  failHost: ["rpc.scroll.io"],
  action: async (p) => {
    await waitResults(p);
    await p.getByText("Check incomplete").waitFor({ timeout: 60000 });
    await p.getByText("Why did some checks fail?").click();
  },
});
await shoot("guide-open", {
  width: 1280,
  height: 900,
  path: "/#guide-opstack",
  action: async (p) => {
    await p.waitForTimeout(600);
    await p.locator("#guide-opstack").scrollIntoViewIfNeeded();
  },
});

await browser.close();
server.close();
console.log("done");
