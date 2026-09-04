import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, statSync } from "node:fs";
import { evaluateFrameAnalyzability } from "@pickle/vision-geometry";
import { extractFrameStats } from "../../../packages/swing-lab/src/frameStats.js";
const dir = "/home/ubuntu/adj/mkv";
const full = `${dir}/full.mkv`;
execFileSync("ffmpeg", ["-y","-v","error","-f","lavfi","-i","testsrc2=size=320x180:rate=30","-t","3","-c:v","libx264","-g","30","-pix_fmt","yuv420p",full]);
const size = statSync(full).size;
for (const frac of [0.5, 0.05]) {
  const cut = `${dir}/cut-${frac}.mkv`;
  writeFileSync(cut, readFileSync(full).subarray(0, Math.floor(size*frac)));
  const stderr = spawnSync("ffmpeg", ["-v","error","-i",cut,"-f","null","-"]).stderr.toString();
  const stats = extractFrameStats(cut);
  const report = evaluateFrameAnalyzability(stats);
  console.log(JSON.stringify({ frac, frameCount: stats.frameCount, durationMs: stats.durationMs, decode: stats.decode, analyzable: report.analyzable, reasons: report.reasons, ffmpegStderr: stderr.trim().split("\n") }, null, 1));
}
