import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CorpusManifest, GeneratedCase } from "./corpus.js";
import type { ProbeChildReport } from "./probeChild.js";
import type { EnvelopeVerdict } from "@pickle/shared-types";

/**
 * xc-matrix-media-2 parent runner: executes probeChild.ts once per corpus
 * case in an isolated node process with a heap cap and wall-clock timeout,
 * and writes a JSON result table + raw stderr log.
 */

export type ProbeOutcome =
  /** All stages completed (probe + measure) and produced a verdict. */
  | "ok"
  /** probeClipStream / measureClip threw a typed Error (expected for junk). */
  | "typed_error"
  /** Child exceeded the wall-clock budget and was killed. */
  | "timeout"
  /** Child died (OOM, signal, uncaught exception) without a JSON report. */
  | "crash";

export interface ProbeRow {
  id: string;
  category: GeneratedCase["category"];
  expected: GeneratedCase["expected"];
  fileName: string;
  bytes: number;
  sha256: string;
  recipe: string;
  outcome: ProbeOutcome;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  wallMs: number;
  report: ProbeChildReport | null;
  stderrTail: string;
  /** Envelope summary lifted out of the report for the matrix table. */
  overall: string | null;
  overallWithCoverage: string | null;
  unsupported: string[];
  notMeasured: string[];
  streamError: string | null;
  measureError: string | null;
}

export interface ProbeMatrix {
  generatedAt: string;
  ffmpegVersion: string;
  seed: number;
  node: string;
  heapCapMb: number;
  timeoutMs: number;
  rows: ProbeRow[];
}

const here = dirname(fileURLToPath(import.meta.url));
const CHILD = join(here, "probeChild.ts");

export interface RunOptions {
  heapCapMb?: number;
  timeoutMs?: number;
}

export function runProbeChild(
  clipPath: string,
  opts: RunOptions = {},
): {
  report: ProbeChildReport | null;
  status: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  wallMs: number;
  timedOut: boolean;
} {
  const heapCapMb = opts.heapCapMb ?? 512;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const t0 = Date.now();
  const res = spawnSync(
    process.execPath,
    [`--max-old-space-size=${heapCapMb}`, "--import", "tsx", CHILD, clipPath],
    {
      cwd: join(here, "..", ".."),
      encoding: "utf8",
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  const wallMs = Date.now() - t0;
  const timedOut =
    res.error !== undefined && (res.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
  let report: ProbeChildReport | null = null;
  const lastLine = (res.stdout ?? "").trim().split("\n").filter(Boolean).pop();
  if (lastLine) {
    try {
      report = JSON.parse(lastLine) as ProbeChildReport;
    } catch {
      report = null;
    }
  }
  return {
    report,
    status: res.status,
    signal: res.signal,
    stderr: res.stderr ?? "",
    wallMs,
    timedOut,
  };
}

export function runProbeMatrix(
  manifest: CorpusManifest,
  outDir: string,
  opts: RunOptions = {},
): ProbeMatrix {
  mkdirSync(outDir, { recursive: true });
  const heapCapMb = opts.heapCapMb ?? 512;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const rows: ProbeRow[] = [];
  const logLines: string[] = [];
  for (const c of manifest.cases) {
    const r = runProbeChild(c.path, { heapCapMb, timeoutMs });
    let outcome: ProbeOutcome;
    if (r.timedOut) outcome = "timeout";
    else if (r.report === null) outcome = "crash";
    else if (r.report.stream.ok && r.report.measure.ok) outcome = "ok";
    else outcome = "typed_error";
    const env: EnvelopeVerdict | null = r.report?.envelope ?? null;
    const row: ProbeRow = {
      id: c.id,
      category: c.category,
      expected: c.expected,
      fileName: c.fileName,
      bytes: c.bytes,
      sha256: c.sha256,
      recipe: c.recipe,
      outcome,
      exitCode: r.status,
      signal: r.signal,
      wallMs: r.wallMs,
      report: r.report,
      stderrTail: r.stderr.slice(-1500),
      overall: env?.overall ?? null,
      overallWithCoverage: env?.overallWithCoverage ?? null,
      unsupported: env
        ? env.dimensions.filter((d) => d.status === "UNSUPPORTED").map((d) => d.dimension)
        : [],
      notMeasured: env
        ? env.dimensions.filter((d) => d.status === "NOT_MEASURED").map((d) => d.dimension)
        : [],
      streamError: r.report?.stream.error ?? null,
      measureError: r.report?.measure.error ?? null,
    };
    rows.push(row);
    logLines.push(
      `[${c.id}] outcome=${outcome} exit=${r.status} signal=${r.signal} wall=${r.wallMs}ms overall=${row.overall} cov=${row.overallWithCoverage} unsupported=${row.unsupported.join("|")} notMeasured=${row.notMeasured.join("|")} heap=${JSON.stringify(r.report?.heap ?? null)}`,
    );
    if (row.streamError) logLines.push(`    stream.error: ${row.streamError}`);
    if (row.measureError) logLines.push(`    measure.error: ${row.measureError}`);
    if (r.stderr.trim())
      logLines.push(`    stderr: ${r.stderr.trim().slice(-800).replace(/\n/g, "\n            ")}`);
  }
  const matrix: ProbeMatrix = {
    generatedAt: new Date().toISOString(),
    ffmpegVersion: manifest.ffmpegVersion,
    seed: manifest.seed,
    node: process.version,
    heapCapMb,
    timeoutMs,
    rows,
  };
  writeFileSync(join(outDir, "clipprobe-matrix.json"), JSON.stringify(matrix, null, 2));
  writeFileSync(join(outDir, "clipprobe-matrix.log"), logLines.join("\n") + "\n");
  writeFileSync(join(outDir, "corpus-manifest.json"), JSON.stringify(manifest, null, 2));
  return matrix;
}
