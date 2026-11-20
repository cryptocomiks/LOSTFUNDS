// Still frames of the film, to check a change before rendering all 900 frames.
//   node sheet.mjs [en|fr] [t1,t2,…]   → sheet-<lang>.png (one frame per second), or frame-<lang>-<t>.png for the times given
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const lang = process.argv[2] === "fr" ? "fr" : "en";
const times = process.argv[3]?.split(",").map(Number);
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
await p.goto(`file://${process.cwd()}/reel.html?lang=${lang}`);
await p.evaluate(() => window.ready);
const shot = async (t, path) => {
  await p.evaluate((t) => window.render(t), t);
  await p.locator("canvas").screenshot({ path });
};
if (times) {
  for (const t of times) await shot(t, `frame-${lang}-${t}.png`);
} else {
  const dir = mkdtempSync(join(tmpdir(), "reel-"));
  for (let i = 0; i < 16; i++) await shot(Math.min(14.6, i + 0.6), join(dir, `${String(i).padStart(2, "0")}.png`));
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", "1", "-i", join(dir, "%02d.png"), "-vf", "scale=640:-1,tile=4x4", "-frames:v", "1", `sheet-${lang}.png`]);
  rmSync(dir, { recursive: true });
}
await b.close();
