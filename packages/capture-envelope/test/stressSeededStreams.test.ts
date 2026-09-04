import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  evaluateCaptureEnvelope,
  measureClip,
  probeClipStream,
  type CaptureEnvelopeMeasurements,
  type MeasureWindow,
} from "../src/index.js";
import { checkVerdict } from "./stress/envelopeModel.js";
import { Rng, fnv1a, stableJson } from "./stress/prng.js";

/**
 * Seeded SYNTHETIC STREAM campaign for the ffmpeg-backed half of the public
 * API (`probeClipStream` → `measureClip` → `evaluateCaptureEnvelope`).
 *
 * Every clip is generated at test time by ffmpeg from parameters drawn from a
 * seeded RNG (size, orientation, fps, duration, source pattern, brightness /
 * contrast / noise filters, rotation metadata, optional measurement window).
 * No committed corpus clip is read and nothing is written under datasets/.
 *
 * Invariants checked per clip:
 *  - determinism: measuring the same file twice gives byte-identical
 *    measurements and an identical verdict trace hash;
 *  - numeric safety: every measurement is `null` or a finite number and no
 *    NaN/±Infinity reaches the verdict;
 *  - honest abstention: `null` measurements are exactly the NOT_MEASURED
 *    dimensions (checked through the independent envelope model);
 *  - probe/measure agreement: display dimensions and fps reported by
 *    `probeClipStream` are the ones the verdict was computed from.
 *
 * Scale: STRESS_STREAM_CLIPS (default 3 — ~1s of ffmpeg per clip). Run the
 * campaign with e.g.
 *   STRESS_STREAM_CLIPS=40 STRESS_OUT=/tmp/ce-streams \
 *     pnpm --filter @pickle/capture-envelope exec vitest run test/stressSeededStreams.test.ts
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLIPS = Number(process.env.STRESS_STREAM_CLIPS ?? "3");
const SEED_FROM = Number(process.env.STRESS_SEED_FROM ?? "1");
const OUT_DIR = resolve(
  process.env.STRESS_OUT ??
    resolve(__dirname, "../../../artifacts/stress/capture-envelope-randomized-seeded"),
);

const hasFfmpeg =
  spawnSync("ffmpeg", ["-version"]).status === 0 && spawnSync("ffprobe", ["-version"]).status === 0;

const SIZES = ["64x36", "160x90", "320x180", "426x240", "640x360", "854x480", "1280x720"] as const;
const RATES = [5, 12, 24, 30, 60] as const;
const SOURCES = ["testsrc2", "color", "mandelbrot", "smptebars", "noise"] as const;
const ROTATIONS = [0, 0, 0, 90, 180, 270] as const;

interface ClipSpec {
  seed: number;
  size: string;
  portrait: boolean;
  rate: number;
  durationSec: number;
  source: string;
  brightness: number;
  contrast: number;
  noise: number;
  rotation: number;
  window: MeasureWindow | null;
}

export function specFor(seed: number): ClipSpec {
  const rng = new Rng(seed);
  const size = SIZES[rng.int(0, SIZES.length - 1)]!;
  const rate = RATES[rng.int(0, RATES.length - 1)]!;
  const durationSec = Math.round(rng.float(0.4, 4.5) * 10) / 10;
  const window: MeasureWindow | null = rng.chance(0.25)
    ? {
        startMs: Math.round(rng.float(0, durationSec * 400)),
        durationMs: Math.round(rng.float(200, durationSec * 600)),
      }
    : null;
  return {
    seed,
    size,
    portrait: rng.chance(0.5),
    rate,
    durationSec,
    source: SOURCES[rng.int(0, SOURCES.length - 1)]!,
    brightness: Math.round(rng.float(-0.9, 0.9) * 100) / 100,
    contrast: Math.round(rng.float(0.05, 2.5) * 100) / 100,
    noise: rng.chance(0.4) ? rng.int(0, 60) : 0,
    rotation: ROTATIONS[rng.int(0, ROTATIONS.length - 1)]!,
    window,
  };
}

function ffmpeg(args: string[]): void {
  execFileSync("ffmpeg", ["-v", "error", "-y", ...args], { stdio: ["ignore", "ignore", "pipe"] });
}

function renderClip(spec: ClipSpec, dir: string): string {
  const [w, h] = spec.size.split("x");
  const size = spec.portrait ? `${h}x${w}` : spec.size;
  const source =
    spec.source === "color"
      ? `color=c=0x${((spec.seed * 2654435761) % 0xffffff).toString(16).padStart(6, "0")}:size=${size}:rate=${spec.rate}`
      : spec.source === "noise"
        ? `nullsrc=size=${size}:rate=${spec.rate},geq=random(${spec.seed})*255:128:128`
        : `${spec.source}=size=${size}:rate=${spec.rate}`;
  const filters = [`eq=brightness=${spec.brightness}:contrast=${spec.contrast}`];
  if (spec.noise > 0) filters.push(`noise=alls=${spec.noise}:allf=t:all_seed=${spec.seed}`);
  const raw = join(dir, `clip-${spec.seed}-raw.mp4`);
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    source,
    "-t",
    String(spec.durationSec),
    "-vf",
    filters.join(","),
    "-pix_fmt",
    "yuv420p",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    raw,
  ]);
  if (spec.rotation === 0) return raw;
  const rotated = join(dir, `clip-${spec.seed}-rot${spec.rotation}.mp4`);
  ffmpeg(["-i", raw, "-c", "copy", "-metadata:s:v:0", `rotate=${spec.rotation}`, rotated]);
  if (probeClipStream(rotated).rotationDegrees === 0) {
    ffmpeg(["-display_rotation", String(spec.rotation), "-i", raw, "-c", "copy", rotated]);
  }
  return rotated;
}

function nonFinite(m: CaptureEnvelopeMeasurements): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(m)) {
    if (value !== null && !(typeof value === "number" && Number.isFinite(value))) {
      out.push(`${key}=${String(value)}`);
    }
  }
  return out;
}

interface StreamOutcome {
  seed: number;
  spec: ClipSpec;
  outcome: "HELD" | "BROKEN";
  deterministic: boolean;
  traceHash: string;
  probe: { displayWidth: number; displayHeight: number; fps: number; durationMs: number };
  overall: string;
  overallWithCoverage: string;
  notMeasured: string[];
  violations: string[];
}

describe.skipIf(!hasFfmpeg)("capture-envelope seeded synthetic streams", () => {
  let dir: string;
  const table: StreamOutcome[] = [];

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "envelope-stress-streams-"));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(
      join(OUT_DIR, "stream-table.json"),
      stableJson({
        harness: "capture-envelope seeded synthetic streams",
        plane: "linux_node_ffmpeg",
        seeds: { from: SEED_FROM, to: SEED_FROM + CLIPS - 1 },
        clips: table.length,
        held: table.filter((t) => t.outcome === "HELD").length,
        broken: table.filter((t) => t.outcome === "BROKEN").map((t) => t.seed),
        table,
      }),
    );
  });

  it(`renders ${CLIPS} seeded clips and holds determinism, numeric safety and abstention on each`, () => {
    expect(CLIPS).toBeGreaterThan(0);
    for (let seed = SEED_FROM; seed < SEED_FROM + CLIPS; seed += 1) {
      const spec = specFor(seed);
      expect(stableJson(specFor(seed))).toBe(stableJson(spec));
      const clip = renderClip(spec, dir);
      const window = spec.window ?? undefined;
      const violations: string[] = [];

      const info = probeClipStream(clip);
      const first = measureClip(clip, window);
      const second = measureClip(clip, window);
      const verdict = evaluateCaptureEnvelope(first);
      const verdict2 = evaluateCaptureEnvelope(second);
      const traceHash = fnv1a(stableJson(verdict));
      const deterministic =
        stableJson(first) === stableJson(second) && traceHash === fnv1a(stableJson(verdict2));
      if (!deterministic) violations.push("stream.nondeterministic");

      for (const bad of nonFinite(first)) violations.push(`stream.nonfinite_measurement:${bad}`);
      for (const msg of checkVerdict(first, verdict)) violations.push(`stream.verdict:${msg}`);

      if (first.frameWidthPx !== info.displayWidth || first.frameHeightPx !== info.displayHeight) {
        violations.push(
          `stream.probe_mismatch:size ${first.frameWidthPx}x${first.frameHeightPx} vs probe ${info.displayWidth}x${info.displayHeight}`,
        );
      }
      if (first.avgFrameRateFps !== info.avgFrameRateFps) {
        violations.push(
          `stream.probe_mismatch:fps ${first.avgFrameRateFps} vs ${info.avgFrameRateFps}`,
        );
      }
      if (window && first.clipDurationMs !== Math.round(window.durationMs)) {
        violations.push(
          `stream.window_duration:${first.clipDurationMs} vs ${Math.round(window.durationMs)}`,
        );
      }
      if (spec.rotation === 90 || spec.rotation === 270) {
        const swapped = info.displayWidth < info.displayHeight !== spec.portrait;
        if (!swapped) violations.push("stream.rotation_ignored");
      }

      table.push({
        seed,
        spec,
        outcome: violations.length === 0 ? "HELD" : "BROKEN",
        deterministic,
        traceHash,
        probe: {
          displayWidth: info.displayWidth,
          displayHeight: info.displayHeight,
          fps: info.avgFrameRateFps,
          durationMs: info.durationMs,
        },
        overall: verdict.overall,
        overallWithCoverage: verdict.overallWithCoverage,
        notMeasured: [...verdict.notMeasured],
        violations,
      });
    }
    const broken = table.filter((t) => t.outcome === "BROKEN");
    expect(
      broken.map((t) => `seed ${t.seed}: ${t.violations.join("; ")}`),
      "seeded synthetic stream invariants",
    ).toEqual([]);
  }, 600_000);
});
