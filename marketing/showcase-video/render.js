function loadPlaywright() {
  for (const c of [process.env.PLAYWRIGHT_CORE, "playwright-core", "playwright"].filter(Boolean)) {
    try {
      return require(c);
    } catch (e) {
      /* try next */
    }
  }
  throw new Error(
    "playwright-core not found. Run: npm i --no-save playwright-core && npx playwright install chromium (or set PLAYWRIGHT_CORE=/path/to/playwright-core)",
  );
}
const { chromium } = loadPlaywright();
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  }),
);
const fps = +(args.fps || 30),
  start = +(args.start || 0),
  end = +(args.end || 41),
  every = +(args.every || 1);
const mode = args.mode || "png";
const out = args.out || "frames";
const W = +(args.w || 1080);
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: W, height: 1920 },
    deviceScaleFactor: 1,
  });
  await page.goto(
    "file://" + path.resolve(__dirname, "timeline.html") + (W !== 1080 ? "?w=" + W : ""),
  );
  await page.evaluate(() => window.__ready);
  const times = args.times ? String(args.times).split(",").map(Number) : null;
  const n = times ? times.length : Math.round((end - start) * fps);
  let ff = null;
  if (mode === "pipe") {
    ff = spawn(
      "ffmpeg",
      [
        "-y",
        "-loglevel",
        "error",
        "-f",
        "image2pipe",
        "-framerate",
        String(fps),
        "-i",
        "-",
        "-c:v",
        "libx264",
        "-preset",
        "slow",
        "-crf",
        "16",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        out,
      ],
      { stdio: ["pipe", "inherit", "inherit"] },
    );
  } else fs.mkdirSync(out, { recursive: true });
  const t0 = Date.now();
  for (let i = 0; i < n; i += every) {
    const t = times ? times[i] : start + i / fps;
    await page.evaluate((t) => window.__setTime(t), t);
    const buf = await page.screenshot({ type: "png" });
    if (ff) {
      if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once("drain", r));
    } else
      fs.writeFileSync(
        path.join(out, times ? `t_${t.toFixed(2)}.png` : `f_${String(i).padStart(5, "0")}.png`),
        buf,
      );
    if (i % 150 === 0) console.log("frame", i, "/", n, "ms", Date.now() - t0);
  }
  if (ff) {
    ff.stdin.end();
    await new Promise((r) => ff.on("close", r));
  }
  await browser.close();
  console.log("done", n, "frames in", Date.now() - t0, "ms");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
