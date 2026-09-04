import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { evaluateFrameAnalyzability, type FrameStats } from "@pickle/vision-geometry";
import { FrameStatsError, extractFrameStats, extractFrameStatsAsync } from "../src/frameStats.js";

/**
 * Adversarial pass #2, scenarios S6 + S7 (attack branch devin/attack-pkg-swing-lab-2).
 *
 * Every clip is SYNTHETIC (ffmpeg mandelbrot source, 3 s @ 30 fps = 90 frames,
 * libx264, GOP 30 → 3 GOPs, x264 single-threaded so bytes are reproducible)
 * and is cut with the literal `head -c <bytes>` the scenario asks for, at a
 * byte offset ffprobe places INSIDE the middle GOP (packet #45 of 90).
 *
 * S6 — raw Annex-B .h264 has no container duration: ffprobe prints `N/A`.
 * S7 — faststart .mp4 / .mov / .mkv / .h264 truncated mid-GOP.
 *
 * Findings pinned here (KNOWN OPEN GAP convention — the assertion states the
 * MEASURED behaviour so a fix flips it deliberately):
 *  - decoded_frame_deficit is gated on `decode.errorCount > 0`, i.e. on ffmpeg
 *    stderr TEXT, not on the deficit. A demuxer that salvages a truncated
 *    Matroska file without a matching stderr line (ffmpeg 4.4 fftools swallow
 *    the av_read_frame error; ≥6.1 log "Error during demuxing") yields
 *    frameCount=5/expected=90 → analyzable=true.
 *  - an unknown expectedFrameCount / durationMs=0 is silently accepted: the
 *    report's `notEvaluated` does not say the frame-count integrity check was
 *    skipped, and a truncated elementary stream WITH decode errors passes.
 */

const FPS = 30;
const SECONDS = 3;
const TOTAL_FRAMES = FPS * SECONDS;
const MID_GOP_PACKET = 45;

const ffmpegAvailable =
  spawnSync("ffmpeg", ["-version"]).status === 0 && spawnSync("ffprobe", ["-version"]).status === 0;
const ffmpegVersionLine = ffmpegAvailable
  ? (spawnSync("ffmpeg", ["-version"], { encoding: "utf8" }).stdout.split("\n")[0] ?? "")
  : "";
/** ffmpeg ≥ 6.1 fftools log "Error during demuxing" (matches the stderr regex). */
const ffmpegMajor = Number(/ffmpeg version n?(\d+)/.exec(ffmpegVersionLine)?.[1] ?? "0");

const dir = mkdtempSync(join(tmpdir(), "attack2-trunc-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function ffmpeg(args: string[]): void {
  execFileSync("ffmpeg", ["-v", "error", "-y", ...args], { stdio: ["ignore", "ignore", "pipe"] });
}

const SOURCE = `mandelbrot=size=320x240:rate=${FPS}`;
const X264 = [
  "-c:v",
  "libx264",
  "-preset",
  "ultrafast",
  "-g",
  String(FPS),
  "-keyint_min",
  String(FPS),
  "-sc_threshold",
  "0",
  "-bf",
  "0",
  "-x264-params",
  "threads=1:sliced-threads=0",
  "-pix_fmt",
  "yuv420p",
];

interface Packet {
  pos: number;
  size: number;
  flags: string;
}

function packets(path: string): Packet[] {
  const json = execFileSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "packet=pos,size,flags",
      "-of",
      "json",
      path,
    ],
    { encoding: "utf8" },
  );
  const parsed = JSON.parse(json) as {
    packets: Array<{ pos: string; size: string; flags: string }>;
  };
  return parsed.packets.map((p) => ({ pos: Number(p.pos), size: Number(p.size), flags: p.flags }));
}

/** Byte offset half-way through packet #index — strictly inside a GOP. */
function midGopCut(path: string, index = MID_GOP_PACKET): number {
  const list = packets(path);
  expect(list.length).toBe(TOTAL_FRAMES);
  const target = list[index]!;
  expect(target.flags.startsWith("K")).toBe(false);
  return target.pos + Math.floor(target.size / 2);
}

/** The literal attack: `head -c <bytes> src > dst`. */
function headC(src: string, bytes: number, dst: string): void {
  const out = execFileSync("head", ["-c", String(bytes), src], { maxBuffer: 64 * 1024 * 1024 });
  writeFileSync(dst, out);
  expect(statSync(dst).size).toBe(bytes);
}

function ffprobeDuration(path: string): string {
  return execFileSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      path,
    ],
    { encoding: "utf8" },
  ).trim();
}

const media = {
  mp4Fast: join(dir, "mb-fast.mp4"),
  mp4Tail: join(dir, "mb-tail.mp4"),
  mov: join(dir, "mb.mov"),
  mkv: join(dir, "mb.mkv"),
  h264: join(dir, "mb.h264"),
};

const measured: Record<string, unknown>[] = [];
afterAll(() => {
  const out = process.env["ATTACK2_MEASURE_OUT"];
  if (out) writeFileSync(out, JSON.stringify({ ffmpegVersionLine, measured }, null, 2));
});

function record(label: string, stats: FrameStats): ReturnType<typeof evaluateFrameAnalyzability> {
  const report = evaluateFrameAnalyzability(stats);
  measured.push({
    label,
    frameCount: stats.frameCount,
    durationMs: stats.durationMs,
    errorCount: stats.decode?.errorCount ?? null,
    expectedFrameCount: stats.decode?.expectedFrameCount ?? null,
    analyzable: report.analyzable,
    reasons: report.reasons,
    notEvaluated: report.notEvaluated,
  });
  return report;
}

beforeAll(() => {
  if (!ffmpegAvailable) return;
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    SOURCE,
    "-t",
    String(SECONDS),
    ...X264,
    "-movflags",
    "+faststart",
    media.mp4Fast,
  ]);
  ffmpeg(["-f", "lavfi", "-i", SOURCE, "-t", String(SECONDS), ...X264, media.mp4Tail]);
  ffmpeg(["-f", "lavfi", "-i", SOURCE, "-t", String(SECONDS), ...X264, media.mov]);
  ffmpeg(["-f", "lavfi", "-i", SOURCE, "-t", String(SECONDS), ...X264, media.mkv]);
  ffmpeg(["-f", "lavfi", "-i", SOURCE, "-t", String(SECONDS), ...X264, "-f", "h264", media.h264]);
}, 60_000);

describe.skipIf(!ffmpegAvailable)("attack2 S6: ffprobe duration N/A (raw Annex-B .h264)", () => {
  it("precondition: intact stream decodes 90 frames and ffprobe prints N/A for format duration", () => {
    expect(ffprobeDuration(media.h264)).toBe("N/A");
    const stats = extractFrameStats(media.h264);
    expect(stats.frameCount).toBe(TOTAL_FRAMES);
    expect(stats.decode?.errorCount).toBe(0);
  });

  it("HELD: durationMs=0 → expectedFrameCount=null, no duration_* / decoded_frame_deficit claim (sync and async agree)", async () => {
    const sync = extractFrameStats(media.h264);
    const async = await extractFrameStatsAsync(media.h264);
    expect(async).toEqual(sync);
    expect(sync.durationMs).toBe(0);
    expect(sync.decode).toEqual({ errorCount: 0, expectedFrameCount: null });
    expect(sync.source).toEqual({ width: 320, height: 240 });
    const report = record("h264-intact", sync);
    expect(report.reasons).not.toContain("duration_too_short");
    expect(report.reasons).not.toContain("decoded_frame_deficit");
    expect(report.analyzable).toBe(true);
  });

  it("BROKEN(P3): the abstention is silent — notEvaluated does not mention duration or frame-count integrity", () => {
    const report = record("h264-intact-notEvaluated", extractFrameStats(media.h264));
    // decode block is present, so the gate reports decode_integrity as EVALUATED even
    // though expectedFrameCount was unknowable and durationMs=0 disabled the duration rules.
    expect(report.notEvaluated).not.toContain("decode_integrity");
    expect(report.notEvaluated.some((item) => /duration|frame_count|expected/i.test(item))).toBe(
      false,
    );
    expect(report.stats.durationMs).toBe(0);
  });

  it("BROKEN(P3): raw .h264 truncated mid-GOP has decode errors + 50% of the frames but PASSES (expected unknown → deficit rule cannot fire)", async () => {
    const cut = midGopCut(media.h264);
    const path = join(dir, "h264-midgop.h264");
    headC(media.h264, cut, path);
    const stats = await extractFrameStatsAsync(path);
    const report = record("h264-midgop", stats);
    expect(stats.durationMs).toBe(0);
    expect(stats.decode?.expectedFrameCount).toBeNull();
    expect(stats.frameCount).toBeGreaterThanOrEqual(2);
    expect(stats.frameCount).toBeLessThan(0.6 * TOTAL_FRAMES);
    expect(stats.decode!.errorCount).toBeGreaterThan(0);
    // measured on 4d812e1a: analyzable=true, reasons=[] despite errorCount>0 and half the frames
    expect(report.reasons).toEqual([]);
    expect(report.analyzable).toBe(true);
  });
});

describe.skipIf(!ffmpegAvailable)("attack2 S7: clip truncated mid-GOP with head -c", () => {
  it("HELD: faststart .mp4 → errorCount>0, expectedFrameCount(90)>frameCount, decoded_frame_deficit", async () => {
    const cut = midGopCut(media.mp4Fast);
    const path = join(dir, "mp4fast-midgop.mp4");
    headC(media.mp4Fast, cut, path);
    const stats = extractFrameStats(path);
    expect(await extractFrameStatsAsync(path)).toEqual(stats);
    const report = record("mp4fast-midgop", stats);
    expect(stats.decode!.errorCount).toBeGreaterThan(0);
    expect(stats.decode!.expectedFrameCount).toBe(TOTAL_FRAMES);
    expect(stats.frameCount).toBeGreaterThan(0);
    expect(stats.frameCount).toBeLessThan(stats.decode!.expectedFrameCount!);
    expect(report.analyzable).toBe(false);
    expect(report.reasons).toContain("decoded_frame_deficit");
  });

  it("HELD: .mov (QuickTime, moov at tail) truncated mid-GOP loses its index → fails closed (undecodable_media)", () => {
    // moov is written at the end without faststart: probing packet offsets needs the intact
    // file; the cut lands mid-GOP in mdat but the truncated file has no moov at all.
    const cut = midGopCut(media.mov);
    const path = join(dir, "mov-midgop.mov");
    headC(media.mov, cut, path);
    const stats = extractFrameStats(path);
    const report = record("mov-midgop", stats);
    expect(stats.decode!.errorCount).toBeGreaterThan(0);
    expect(stats.frameCount).toBe(0);
    expect(report.analyzable).toBe(false);
    expect(report.reasons).toContain("undecodable_media");
  });

  it("HELD: non-faststart .mp4 truncated mid-GOP → undecodable_media, never analyzable", () => {
    const cut = midGopCut(media.mp4Tail);
    const path = join(dir, "mp4tail-midgop.mp4");
    headC(media.mp4Tail, cut, path);
    const report = record("mp4tail-midgop", extractFrameStats(path));
    expect(report.analyzable).toBe(false);
    expect(
      report.reasons.some((r) => r === "undecodable_media" || r === "decoded_frame_deficit"),
    ).toBe(true);
  });

  it("HELD: faststart .mp4 cut at every 5% from 10%..85% never passes the gate; a 90% cut (82/90 frames, still errorCount>0) passes by the 0.9 design tolerance", () => {
    const size = statSync(media.mp4Fast).size;
    for (let percent = 10; percent <= 90; percent += 5) {
      const path = join(dir, `mp4fast-${percent}.mp4`);
      headC(media.mp4Fast, Math.floor((size * percent) / 100), path);
      const stats = extractFrameStats(path);
      const report = record(`mp4fast-${percent}%`, stats);
      expect(stats.frameCount, `${percent}%`).toBeLessThan(TOTAL_FRAMES);
      expect(stats.decode!.errorCount, `${percent}%`).toBeGreaterThan(0);
      if (stats.frameCount < 0.9 * TOTAL_FRAMES) {
        expect(report.analyzable, `${percent}% frames=${stats.frameCount}`).toBe(false);
        expect(report.reasons).toContain("decoded_frame_deficit");
      } else {
        // Observation (not a finding): decode errors alone never reject; only the deficit does.
        expect(percent).toBeGreaterThanOrEqual(90);
        expect(report.analyzable, `${percent}% frames=${stats.frameCount}`).toBe(true);
      }
    }
  });

  it("Matroska truncated mid-GOP: declared duration survives (expected=90) while ~half the frames decode", async () => {
    const cut = midGopCut(media.mkv);
    const path = join(dir, "mkv-midgop.mkv");
    headC(media.mkv, cut, path);
    const stats = extractFrameStats(path);
    expect(await extractFrameStatsAsync(path)).toEqual(stats);
    const report = record("mkv-midgop", stats);
    expect(stats.durationMs).toBe(SECONDS * 1000);
    expect(stats.decode!.expectedFrameCount).toBe(TOTAL_FRAMES);
    expect(stats.frameCount).toBeGreaterThanOrEqual(2);
    expect(stats.frameCount).toBeLessThan(0.9 * TOTAL_FRAMES);
    // The verdict is a pure function of whether ffmpeg's stderr matched the regex —
    // NOT of the 50% frame deficit that is right there in the stats.
    expect(report.analyzable).toBe(stats.decode!.errorCount === 0);
    if (ffmpegMajor > 0 && ffmpegMajor < 6) {
      // ffmpeg 4.x/5.x fftools swallow the demuxer EIO: "File ended prematurely" is the only
      // stderr line, it matches nothing in countDecodeErrors → errorCount=0 → analyzable=true.
      expect(stats.decode!.errorCount).toBe(0);
      expect(report.analyzable).toBe(true);
    }
  });

  it("BROKEN(P2): with the demuxer silent, 5 of 90 frames pass as analyzable — the deficit rule is keyed on stderr text, not the deficit", () => {
    // Early cut (inside GOP 1, ~5% of the file): what a 4.4-era ffmpeg measures on this file.
    const size = statSync(media.mkv).size;
    const path = join(dir, "mkv-5pct.mkv");
    headC(media.mkv, Math.floor(size * 0.05), path);
    const real = extractFrameStats(path);
    record("mkv-5%", real);
    expect(real.decode!.expectedFrameCount).toBe(TOTAL_FRAMES);
    expect(real.frameCount).toBeGreaterThanOrEqual(2);
    expect(real.frameCount).toBeLessThan(0.2 * TOTAL_FRAMES);

    // Same real stats, decode.errorCount pinned to 0 = the ffmpeg<6 stderr shape measured above.
    const silent: FrameStats = { ...real, decode: { ...real.decode!, errorCount: 0 } };
    const silentReport = evaluateFrameAnalyzability(silent);
    expect(silentReport.reasons).not.toContain("decoded_frame_deficit");
    expect(silentReport.analyzable).toBe(true);

    // Flip only errorCount to 1: identical frames, identical deficit → now rejected.
    const noisy: FrameStats = { ...real, decode: { ...real.decode!, errorCount: 1 } };
    const noisyReport = evaluateFrameAnalyzability(noisy);
    expect(noisyReport.reasons).toContain("decoded_frame_deficit");
    expect(noisyReport.analyzable).toBe(false);
  });

  it("HELD: 8 concurrent async extractions of a truncated clip agree byte-for-byte with the sync path", async () => {
    const cut = midGopCut(media.mp4Fast);
    const path = join(dir, "mp4fast-concurrent.mp4");
    headC(media.mp4Fast, cut, path);
    const sync = extractFrameStats(path);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => extractFrameStatsAsync(path)),
    );
    for (const result of results) expect(result).toEqual(sync);
  });
});

describe.skipIf(!ffmpegAvailable)("attack2 extras: hostile paths and unreadable inputs", () => {
  it("HELD: missing file → typed input_missing failure (sync and async agree), not a media verdict", async () => {
    const missing = join(dir, "does-not-exist.mp4");
    expect(existsSync(missing)).toBe(false);
    const expected = {
      name: "FrameStatsError",
      kind: "input_missing",
      tool: null,
      videoPath: missing,
    };
    expect(() => extractFrameStats(missing)).toThrow(FrameStatsError);
    expect(() => extractFrameStats(missing)).toThrow(expect.objectContaining(expected));
    await expect(extractFrameStatsAsync(missing)).rejects.toBeInstanceOf(FrameStatsError);
    await expect(extractFrameStatsAsync(missing)).rejects.toMatchObject(expected);
  });

  it("HELD: empty file / 4 KiB of zeros → undecodable_media, never analyzable", async () => {
    for (const path of [join(dir, "empty.mp4"), join(dir, "zeros.mp4")]) {
      if (path.endsWith("empty.mp4")) writeFileSync(path, "");
      if (path.endsWith("zeros.mp4")) writeFileSync(path, Buffer.alloc(4096));
      const stats = await extractFrameStatsAsync(path);
      const report = record(`hostile:${path.split("/").pop()}`, stats);
      expect(stats.frameCount).toBe(0);
      expect(stats.decode!.errorCount).toBeGreaterThan(0);
      expect(stats.decode!.expectedFrameCount).toBeNull();
      expect(report.analyzable).toBe(false);
      expect(report.reasons).toContain("undecodable_media");
    }
  });

  it.skipIf(process.getuid?.() === 0)(
    "HELD: permission-denied clip (chmod 000) → undecodable_media",
    () => {
      const path = join(dir, "locked.mp4");
      writeFileSync(path, execFileSync("cat", [media.mp4Fast], { maxBuffer: 64 * 1024 * 1024 }));
      chmodSync(path, 0o000);
      try {
        const report = record("chmod000", extractFrameStats(path));
        expect(report.analyzable).toBe(false);
        expect(report.reasons).toContain("undecodable_media");
      } finally {
        chmodSync(path, 0o600);
      }
    },
  );

  it("HELD: unicode + whitespace + leading-dash-looking path is passed as a single argv, decodes fully", async () => {
    const path = join(dir, "🏓 clip é — v1 (copy).mp4");
    writeFileSync(path, execFileSync("cat", [media.mp4Fast], { maxBuffer: 64 * 1024 * 1024 }));
    const stats = await extractFrameStatsAsync(path);
    expect(stats.frameCount).toBe(TOTAL_FRAMES);
    expect(stats.decode).toEqual({ errorCount: 0, expectedFrameCount: TOTAL_FRAMES });
    expect(record("unicode-path", stats).analyzable).toBe(true);
  });

  it("HELD: a path that starts with '-' is treated as a filename, never as an ffmpeg option", () => {
    // The existence check runs on the literal path, so "-v" (no such file in
    // cwd) is an input_missing failure rather than a parsed ffmpeg flag.
    expect(existsSync("-v")).toBe(false);
    expect(() => extractFrameStats("-v")).toThrow(
      expect.objectContaining({ name: "FrameStatsError", kind: "input_missing", videoPath: "-v" }),
    );
  });
});
