import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
const ff = createRequire(import.meta.url)("ffmpeg-static");
const FPS = 60, DUR = 15, FRAMES = FPS * DUR;
const out = process.argv[2] ?? "reel.mp4";
const enc = spawn(ff, ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(FPS), "-c:v", "png", "-i", "-", "-i", "reel.wav",
  "-c:v", "libx264", "-preset", "slow", "-crf", "20", "-pix_fmt", "yuv420p", "-profile:v", "high", "-c:a", "aac", "-b:a", "160k",
  "-shortest", "-movflags", "+faststart", out], { stdio: ["pipe", "inherit", "inherit"] });
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
await p.goto("file://" + process.cwd() + "/reel.html");
await p.evaluate(() => window.ready);
const canvas = p.locator("canvas");
const t0 = Date.now();
for (let f = 0; f < FRAMES; f++) {
  await p.evaluate((t) => window.render(t), f / FPS);
  const png = await canvas.screenshot({ type: "png" });
  if (!enc.stdin.write(png)) await new Promise((r) => enc.stdin.once("drain", r));
  if (f % 150 === 0) console.log(`frame ${f}/${FRAMES} ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}
enc.stdin.end();
await new Promise((r) => enc.on("close", r));
await b.close();
console.log("done in", ((Date.now() - t0) / 1000).toFixed(0), "s");
