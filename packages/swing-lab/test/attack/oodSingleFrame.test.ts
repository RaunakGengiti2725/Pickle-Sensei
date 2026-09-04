import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { evaluateFrameAnalyzability, type FrameStats } from "@pickle/vision-geometry";
import { preAnalysisGate } from "@pickle/analysis-pipeline";
import { extractFrameStats, extractFrameStatsAsync } from "../../src/frameStats.js";

/**
 * Adversarial pass 3 (tester #4) — S6: the OOD/frame gate on a single-frame
 * video (interFrameDiffs = []) must ABSTAIN, never report "analyzable".
 * Real MP4s are built locally with ffmpeg; the resulting FrameStats are
 * written next to the test output as evidence (ATTACK_S6_OUT, default
 * /tmp/attack/s6). Extra attacks: contradictory hand-built stats
 * (frameCount ≥ 2 with no diffs), 0-byte / garbage media, two identical
 * frames, and the gate running with ffmpeg/ffprobe absent from PATH.
 */

const dir = mkdtempSync(join(tmpdir(), "attack-s6-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const OUT = process.env["ATTACK_S6_OUT"] ?? "/tmp/attack/s6";
mkdirSync(OUT, { recursive: true });
const record = (name: string, value: unknown) =>
  writeFileSync(join(OUT, `${name}.json`), JSON.stringify(value, null, 2));

function ffmpeg(args: string[]): void {
  execFileSync("ffmpeg", ["-v", "error", "-y", ...args]);
}

function oneFrameMp4(name: string, extra: string[] = []): string {
  const path = join(dir, name);
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=320x240:rate=30",
    "-frames:v",
    "1",
    "-pix_fmt",
    "yuv420p",
    ...extra,
    path,
  ]);
  return path;
}

function gate(stats: FrameStats) {
  const frame = evaluateFrameAnalyzability(stats);
  const result = preAnalysisGate({ frame, pose: null, poseQuality: null });
  return { frame, gateOk: result.ok, failure: result.ok ? null : result.failure };
}

describe("S6 — single-frame video must abstain", () => {
  it("1-frame MP4: interFrameDiffs=[] → not analyzable, single_frame_clip, gate closed", () => {
    const stats = extractFrameStats(oneFrameMp4("one.mp4"));
    const { frame, gateOk, failure } = gate(stats);
    record("one-frame", { stats, frame, gateOk, failure });
    expect(stats.frameCount).toBe(1);
    expect(stats.interFrameDiffs).toEqual([]);
    expect(frame.analyzable).toBe(false);
    expect(frame.reasons).toContain("single_frame_clip");
    expect(gateOk).toBe(false);
  });

  it("1-frame MP4 via the async extractor agrees", async () => {
    const stats = await extractFrameStatsAsync(oneFrameMp4("one-async.mp4"));
    const { frame, gateOk } = gate(stats);
    record("one-frame-async", { stats, frame, gateOk });
    expect(stats.interFrameDiffs).toEqual([]);
    expect(frame.analyzable).toBe(false);
    expect(gateOk).toBe(false);
  });

  it("1 frame with a long DECLARED duration still abstains", () => {
    // A single frame whose container claims 2s (rate 0.5 fps) — the duration
    // gate alone would pass; frame count must still decide.
    const path = join(dir, "one-long.mp4");
    ffmpeg([
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=320x240:rate=1",
      "-frames:v",
      "1",
      "-r",
      "0.5",
      "-pix_fmt",
      "yuv420p",
      path,
    ]);
    const stats = extractFrameStats(path);
    const { frame, gateOk } = gate(stats);
    record("one-frame-long-duration", { stats, frame, gateOk });
    expect(stats.frameCount).toBeLessThan(2);
    expect(frame.analyzable).toBe(false);
    expect(gateOk).toBe(false);
  });

  it("two IDENTICAL frames (interFrameDiffs=[0]) abstain as still image", () => {
    const path = join(dir, "two-same.mp4");
    ffmpeg([
      "-f",
      "lavfi",
      "-i",
      "color=c=0x336699:s=320x240:r=30",
      "-vf",
      "drawbox=x=40:y=40:w=120:h=90:color=white:t=fill,noise=alls=0",
      "-frames:v",
      "2",
      "-pix_fmt",
      "yuv420p",
      path,
    ]);
    const stats = extractFrameStats(path);
    const { frame, gateOk } = gate(stats);
    record("two-identical-frames", { stats, frame, gateOk });
    expect(stats.frameCount).toBe(2);
    expect(frame.analyzable).toBe(false);
    expect(gateOk).toBe(false);
  });

  it("contradictory stats (frameCount ≥ 2 but interFrameDiffs=[]) never analyzable", () => {
    const base = extractFrameStats(oneFrameMp4("one-base.mp4"));
    for (const frameCount of [2, 3, 30, 1_000_000]) {
      const forged: FrameStats = {
        ...base,
        frameCount,
        durationMs: 3000,
        interFrameDiffs: [],
        spatialLumaStd: Array.from({ length: frameCount > 100 ? 100 : frameCount }, () => 40),
      };
      const { frame, gateOk } = gate(forged);
      record(`forged-frameCount-${frameCount}`, { frame, gateOk });
      expect(frame.analyzable, `frameCount=${frameCount}`).toBe(false);
      expect(gateOk, `frameCount=${frameCount}`).toBe(false);
    }
  });

  it("non-finite / negative frame counts are not analyzable", () => {
    const base = extractFrameStats(oneFrameMp4("one-nf.mp4"));
    for (const frameCount of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
      const forged: FrameStats = { ...base, frameCount, interFrameDiffs: [], durationMs: 3000 };
      const { frame, gateOk } = gate(forged);
      expect(frame.analyzable, `frameCount=${frameCount}`).toBe(false);
      expect(gateOk, `frameCount=${frameCount}`).toBe(false);
    }
  });

  it("0-byte file and random garbage decode to zero frames and abstain", () => {
    const empty = join(dir, "empty.mp4");
    writeFileSync(empty, "");
    const garbage = join(dir, "garbage.mp4");
    writeFileSync(garbage, Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 7919) % 256)));
    for (const path of [empty, garbage]) {
      const stats = extractFrameStats(path);
      const { frame, gateOk } = gate(stats);
      record(`garbage-${path.split("/").pop()}`, { stats, frame, gateOk });
      expect(stats.frameCount).toBe(0);
      expect(frame.analyzable).toBe(false);
      expect(gateOk).toBe(false);
    }
  });

  it("with ffmpeg/ffprobe absent from PATH the gate abstains (never 'analyzable')", () => {
    // Symlink farm mirroring PATH minus ffmpeg/ffprobe.
    const farm = join(dir, "path-without-ffmpeg");
    mkdirSync(farm);
    for (const entry of (process.env["PATH"] ?? "").split(":")) {
      let names: string[] = [];
      try {
        names = readdirSync(entry);
      } catch {
        continue;
      }
      for (const name of names) {
        if (name === "ffmpeg" || name === "ffprobe") continue;
        try {
          symlinkSync(join(entry, name), join(farm, name));
        } catch {
          // duplicate name from an earlier PATH dir — first wins, like PATH.
        }
      }
    }
    const realClip = join(dir, "real-motion.mp4");
    ffmpeg([
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=320x240:rate=30:duration=2",
      "-pix_fmt",
      "yuv420p",
      realClip,
    ]);

    const savedPath = process.env["PATH"];
    process.env["PATH"] = farm;
    try {
      const stats = extractFrameStats(realClip);
      const { frame, gateOk, failure } = gate(stats);
      record("no-ffmpeg-in-path", { stats, frame, gateOk, failure });
      expect(stats.frameCount).toBe(0);
      expect(frame.analyzable).toBe(false);
      expect(gateOk).toBe(false);
      // The abstention must be typed as a media/decode problem, not a
      // "single frame clip" misdiagnosis of a perfectly good 60-frame clip.
      expect(frame.reasons).toContain("undecodable_media");
    } finally {
      process.env["PATH"] = savedPath;
    }
  });
});
