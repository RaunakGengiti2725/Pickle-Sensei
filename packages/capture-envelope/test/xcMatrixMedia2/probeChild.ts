import { performance } from "node:perf_hooks";
import { evaluateCaptureEnvelope } from "../../src/envelope.js";
import { measureClip, probeClipStream, probeFrameIntervalCv } from "../../src/clipProbe.js";
import type { CaptureEnvelopeMeasurements } from "../../src/envelope.js";
import type { ClipStreamInfo } from "../../src/clipProbe.js";
import type { EnvelopeVerdict } from "@pickle/shared-types";

/**
 * xc-matrix-media-2 child process: runs the FULL capture-envelope probe
 * pipeline on ONE clip and prints a single JSON line. It is executed in its
 * own process (with a heap cap + wall-clock timeout owned by the parent) so a
 * hang, OOM, or native crash inside ffmpeg/ffprobe is observed as a typed
 * outcome instead of taking the test runner down.
 *
 * Usage: tsx probeChild.ts <clipPath>
 */

export interface StageResult<T> {
  ok: boolean;
  ms: number;
  value?: T;
  error?: string;
}

export interface ProbeChildReport {
  clipPath: string;
  stream: StageResult<ClipStreamInfo>;
  timing: StageResult<number | null>;
  measure: StageResult<CaptureEnvelopeMeasurements>;
  envelope: EnvelopeVerdict | null;
  heap: { rssMb: number; heapUsedMb: number; heapTotalMb: number; externalMb: number };
  totalMs: number;
}

function stage<T>(fn: () => T): StageResult<T> {
  const t0 = performance.now();
  try {
    const value = fn();
    return { ok: true, ms: Math.round(performance.now() - t0), value };
  } catch (error) {
    return {
      ok: false,
      ms: Math.round(performance.now() - t0),
      error: String((error as Error).message ?? error).slice(0, 600),
    };
  }
}

const mb = (n: number) => Math.round((n / 1024 / 1024) * 10) / 10;

const clipPath = process.argv[2];
if (!clipPath) {
  process.stderr.write("usage: probeChild <clipPath>\n");
  process.exit(2);
}

const t0 = performance.now();
const stream = stage(() => probeClipStream(clipPath));
const timing = stage(() => probeFrameIntervalCv(clipPath));
const measure = stage(() => measureClip(clipPath));
const envelope = measure.ok && measure.value ? evaluateCaptureEnvelope(measure.value) : null;
const mem = process.memoryUsage();
const report: ProbeChildReport = {
  clipPath,
  stream,
  timing,
  measure,
  envelope,
  heap: {
    rssMb: mb(mem.rss),
    heapUsedMb: mb(mem.heapUsed),
    heapTotalMb: mb(mem.heapTotal),
    externalMb: mb(mem.external),
  },
  totalMs: Math.round(performance.now() - t0),
};
process.stdout.write(JSON.stringify(report) + "\n");
