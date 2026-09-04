import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  generateCorpus,
  hasFfmpeg,
  streamHash,
  type CorpusManifest,
} from "./xcMatrixMedia2/corpus.js";
import { runProbeMatrix, type ProbeMatrix, type ProbeRow } from "./xcMatrixMedia2/runner.js";

/**
 * xc-matrix-media-2 — capture-envelope CPU prober under adversarial media.
 *
 * Every corpus case is generated at test time (ffmpeg lavfi + byte surgery
 * in tmpdir; nothing committed, nothing read from datasets/) and probed in
 * an ISOLATED child process with a 512 MiB heap cap and a 60 s wall clock,
 * so hangs/OOMs/crashes are observed as outcomes rather than taking vitest
 * down. Raw JSON table + log land in artifacts/xc-matrix-media-2/<run>/.
 *
 * Contract asserted:
 *  - junk / truncated-moov / audio-only / text / wav / raw input → typed Error
 *    from probeClipStream or measureClip (outcome "typed_error"), never a
 *    crash or a verdict.
 *  - decodable input (any extension, any audio state, any container ffmpeg
 *    reads) → a verdict, in < 60 s, in < 512 MiB heap.
 *  - stills / single frame → UNSUPPORTED on clip_duration (not a false pass).
 *  - regeneration is deterministic (sha256 stable across two generations;
 *    stream hash for matroska/webm whose muxer writes a random SegmentUID).
 *
 * KNOWN FINDING pinned (documented, not silently accepted): clips whose
 * sampled short side rounds to 0 px (aspect > 320:1) OOM-abort the process
 * in extractSampledGrayFrames (frameBytes = 0 → Infinity frames).
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const runStamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir =
  process.env["XC_MEDIA2_OUT"] ?? join(repoRoot, "artifacts", "xc-matrix-media-2", runStamp);

const OOM_CASES = ["extreme_aspect_1000x2", "extreme_aspect_2x1000"];

const enabled = hasFfmpeg();
let dir: string;
let manifest: CorpusManifest;
let matrix: ProbeMatrix;

function row(id: string): ProbeRow {
  const r = matrix.rows.find((x) => x.id === id);
  if (!r) throw new Error(`missing corpus row ${id}`);
  return r;
}

beforeAll(() => {
  if (!enabled) return;
  dir = mkdtempSync(join(tmpdir(), "xc-media2-probe-"));
  mkdirSync(outDir, { recursive: true });
  manifest = generateCorpus(join(dir, "corpus"));
  matrix = runProbeMatrix(manifest, outDir, { heapCapMb: 512, timeoutMs: 60_000 });
}, 600_000);

afterAll(() => {
  if (!enabled) return;
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!enabled)("xc-matrix-media-2: clipProbe matrix", () => {
  it("corpus regeneration is deterministic (file sha256; stream hash for matroska/webm whose SegmentUID is random)", () => {
    const again = generateCorpus(join(dir, "corpus-again"));
    const first = new Map(manifest.cases.map((c) => [c.id, c]));
    const diffs: string[] = [];
    for (const c of again.cases) {
      const prev = first.get(c.id)!;
      if (c.containerBytesRandom) {
        if (streamHash(prev.path) !== streamHash(c.path)) diffs.push(`${c.id} (streamhash)`);
      } else if (prev.sha256 !== c.sha256) {
        diffs.push(c.id);
      }
    }
    expect(diffs).toEqual([]);
  }, 180_000);

  it("no case hangs: every child finished inside the 60 s budget", () => {
    expect(matrix.rows.filter((r) => r.outcome === "timeout").map((r) => r.id)).toEqual([]);
  });

  it("typed_reject inputs fail with a typed Error (never a crash, never a verdict)", () => {
    const rows = matrix.rows.filter((r) => r.expected === "typed_reject");
    expect(rows.length).toBeGreaterThanOrEqual(10);
    for (const r of rows) {
      expect(r.outcome, `${r.id}: ${r.streamError ?? r.measureError ?? r.stderrTail}`).toBe(
        "typed_error",
      );
      expect(r.overall, r.id).toBeNull();
      expect((r.streamError ?? r.measureError ?? "").length, r.id).toBeGreaterThan(0);
    }
  });

  it("no-video-stream inputs (audio-only mp4/m4a, wav) are rejected by probeClipStream with the no-video-stream error", () => {
    for (const id of ["audio_only_mp4", "audio_only_m4a_as_mp4", "wav_as_mp4"]) {
      expect(row(id).streamError, id).toContain("no video stream");
    }
  });

  it("intact-index/undecodable-samples inputs (zeroed mdat, unknown fourcc) fail at decode, not falsely SUPPORTED", () => {
    for (const id of ["mdat_zeroed_moov_intact", "avc1_fourcc_patched"]) {
      const r = row(id);
      expect(r.report?.stream.ok, id).toBe(true);
      expect(r.outcome, id).toBe("typed_error");
      expect(r.measureError, id).toMatch(/ffmpeg failed/);
    }
  });

  it("decodable inputs of any extension/container/audio state produce a verdict under budget", () => {
    const rows = matrix.rows.filter((r) => r.expected === "decodable");
    expect(rows.length).toBeGreaterThanOrEqual(20);
    for (const r of rows) {
      expect(r.outcome, `${r.id}: ${r.streamError ?? r.measureError}`).toBe("ok");
      expect(r.overall, r.id).not.toBeNull();
      expect(r.wallMs, r.id).toBeLessThan(60_000);
      expect(r.report!.heap.heapUsedMb, r.id).toBeLessThan(512);
    }
  });

  it("stills and a single frame are UNSUPPORTED on clip_duration — never a silent pass", () => {
    for (const id of ["png_as_mp4", "jpeg_as_mp4", "single_frame"]) {
      const r = row(id);
      expect(r.outcome, id).toBe("ok");
      expect(r.overall, id).toBe("UNSUPPORTED");
      expect(r.unsupported, id).toContain("clip_duration");
    }
  });

  it("wrong extension never changes the verdict of a good clip (mp4 as .txt / .mov == base)", () => {
    const base = row("base_720p30_aac");
    for (const id of ["mp4_as_txt", "mp4_as_mov"]) {
      const r = row(id);
      expect(r.sha256, id).toBe(base.sha256);
      expect(r.overall, id).toBe(base.overall);
      expect(r.report!.measure.value!.brightnessMeanLuma, id).toBe(
        base.report!.measure.value!.brightnessMeanLuma,
      );
    }
  });

  it("missing/short/silent audio never affects the video verdict", () => {
    const base = row("base_720p30_aac");
    for (const id of ["video_only_no_audio", "audio_stream_truncated", "silent_audio_track"]) {
      const r = row(id);
      expect(r.overall, id).toBe(base.overall);
      expect(r.report!.stream.value!.durationMs, id).toBe(3000);
    }
  });

  it("rotation tags are normalized: 450→90 (swapped), -90→270 (swapped), 45 kept, garbage→0", () => {
    expect(row("rotate_450").report!.stream.value).toMatchObject({
      rotationDegrees: 90,
      displayWidth: 720,
      displayHeight: 1280,
    });
    expect(row("rotate_minus90").report!.stream.value).toMatchObject({
      rotationDegrees: 270,
      displayWidth: 720,
      displayHeight: 1280,
    });
    expect(row("rotate_45").report!.stream.value).toMatchObject({
      rotationDegrees: 45,
      displayWidth: 1280,
      displayHeight: 720,
    });
    expect(row("rotate_garbage").report!.stream.value).toMatchObject({ rotationDegrees: 0 });
  });

  it("junk after the last box and a doubled file are read as the first valid stream", () => {
    for (const id of ["junk_tail_1mib", "double_concat_mp4"]) {
      expect(row(id).outcome, id).toBe("ok");
      expect(row(id).report!.stream.value!.durationMs, id).toBe(3000);
    }
  });

  it("OBSERVED: half-truncated faststart mp4 still measures SUPPORTED with the moov-declared 3.0 s duration", () => {
    const r = row("trunc_faststart_50pct");
    expect(r.outcome).toBe("ok");
    expect(r.report!.stream.value!.durationMs).toBe(3000);
    expect(r.report!.measure.value!.clipDurationMs).toBe(3000);
    expect(r.overall).toBe("SUPPORTED");
  });

  it("two video streams: metadata (ffprobe v:0) and pixels (ffmpeg default selection) come from the SAME stream", () => {
    const r = row("two_video_streams_luma");
    expect(r.outcome).toBe("ok");
    // v:0 is the 64x64 black stream; v:1 is 1280x720 white. If ffmpeg had
    // picked v:1 for pixels the luma would be ~235 while dims say 64x64.
    expect(r.report!.stream.value).toMatchObject({ width: 64, height: 64, avgFrameRateFps: 5 });
    expect(r.report!.measure.value!.brightnessMeanLuma).toBeLessThan(30);
    expect(r.overall).toBe("UNSUPPORTED");
    expect(r.unsupported).toContain("resolution");
  });

  it("KNOWN FINDING: extreme aspect ratios OOM-abort the prober (frameBytes=0 → Infinity frames) instead of a typed reject", () => {
    for (const id of OOM_CASES) {
      const r = row(id);
      expect(r.outcome, `${id}: ${r.stderrTail}`).toBe("crash");
      expect(r.signal, id).toBe("SIGABRT");
      expect(r.stderrTail, id).toMatch(/heap out of memory|FatalProcessOutOfMemory/);
    }
  });

  it("matrix artifacts were written", () => {
    expect(matrix.rows.length).toBe(manifest.cases.length);
    expect(matrix.rows.length).toBeGreaterThanOrEqual(45);
  });
});
