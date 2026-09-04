/**
 * Media-worker lifecycle soak: N consecutive `runOnce` cycles in ONE process,
 * each carrying one `media.process` job, across a matrix of injected
 * transcoders. Records per cycle: wall time, gc'd heap, the number of files
 * left under the harness scratch root, object-store deletes, queue depth, and
 * the outcome the worker logged.
 *
 * HONESTY NOTE. The checked-in worker has NO transcoder implementation:
 * `services/media-worker/src/main.ts` wires `transcoder: null` and the
 * Dockerfile installs no ffmpeg. Every transcoder below is a harness fake that
 * exercises the `WorkerDeps.transcoder` seam (`worker.ts` handleJob
 * media.process). Temp-file numbers therefore describe (a) what the worker
 * itself leaves behind (nothing — it never touches the filesystem) and (b) what
 * the seam lets an implementation leave behind on each outcome path. They say
 * nothing about a production ffmpeg pipeline, which is not in this repository.
 */
import { mkdtempSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type pg from "pg";
import type { AnalyticsEvent, IAnalyticsSink } from "@pickle/analytics";
import { InMemoryJobQueue } from "@pickle/queue";
import { QueueSloMonitor, DEFAULT_QUEUE_SLO_CONFIG } from "@pickle/slo";
import { runOnce, type ObjectDeleter, type WorkerDeps } from "../../src/worker.js";
import {
  collectHeapUsed,
  gcAvailable,
  heapVerdict,
  linearFit,
  percentile,
  type HeapVerdict,
} from "./soakStats.js";

export const TRANSCODER_VARIANTS = [
  /** Production configuration in main.ts: no transcoder at all. */
  "none",
  /** Well-behaved implementation: scratch files created, derived keys under the master prefix, scratch removed. */
  "clean",
  /** Implementation that fails after creating scratch (unsupported codec) and does not clean up itself. */
  "throw_after_scratch",
  /** Implementation that emits derived keys outside the master prefix (worker must delete them). */
  "bad_prefix",
  /** Asset deleted while transcoding: the ready UPDATE matches 0 rows (worker must delete derived). */
  "deleted_mid_transcode",
] as const;
export type TranscoderVariant = (typeof TRANSCODER_VARIANTS)[number];

interface AssetRow {
  object_key: string | null;
  owner_user_id: string;
  deleted_at: Date | null;
}

/** Minimal SQL-shape fake of the media_asset table for the media.process path.
 * Unrelated queries (deletion tasks, retention, sweeps, backlog) return empty
 * result sets — the same shape `test/slo-stall.test.ts` uses. */
export class FakeMediaPool {
  public queries = 0;
  public readyUpdates = 0;
  public failedUpdates = 0;
  private current: { id: string; row: AssetRow } | null = null;
  constructor(private readonly readyUpdateMatches: () => number) {}

  setAsset(id: string, row: AssetRow): void {
    this.current = { id, row };
  }

  private query(sql: string, params?: unknown[]): { rows: unknown[]; rowCount: number } {
    this.queries++;
    const id = params?.[0];
    if (sql.startsWith("SELECT object_key, owner_user_id, deleted_at FROM media_asset")) {
      const rows = this.current && this.current.id === id ? [this.current.row] : [];
      return { rows, rowCount: rows.length };
    }
    if (sql.startsWith("UPDATE media_asset SET status = 'ready'")) {
      this.readyUpdates++;
      return { rows: [], rowCount: this.readyUpdateMatches() };
    }
    if (sql.startsWith("UPDATE media_asset SET status = 'failed'")) {
      this.failedUpdates++;
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }

  asPool(): pg.Pool {
    return {
      query: async (sql: string, params?: unknown[]) => this.query(sql, params),
    } as unknown as pg.Pool;
  }
}

/** Counts deletes; keeps only the first few keys so the fake itself holds no
 * per-cycle state that could masquerade as worker heap growth. */
export class CountingObjectStore implements ObjectDeleter {
  public deleted = 0;
  public firstKeys: string[] = [];
  public listed = 0;
  async deleteObject(key: string): Promise<void> {
    this.deleted++;
    if (this.firstKeys.length < 4) this.firstKeys.push(key);
  }
  async listObjects(_prefix: string): Promise<string[]> {
    this.listed++;
    return [];
  }
}

export interface ScratchStats {
  /** Files (not directories) currently under the scratch root. */
  files: number;
  directories: number;
  bytes: number;
}

export function scratchStats(root: string): ScratchStats {
  const stats: ScratchStats = { files: 0, directories: 0, bytes: 0 };
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        stats.directories++;
        walk(path);
      } else {
        stats.files++;
        stats.bytes += statSync(path).size;
      }
    }
  };
  walk(root);
  return stats;
}

const SCRATCH_PAYLOAD = Buffer.alloc(64 * 1024, 0x50);

/** Builds the injected transcoder for a variant. Scratch files model an
 * ffmpeg-style implementation's intermediate outputs (input copy, normalized
 * mp4, thumbnail). */
export function makeTranscoder(
  variant: TranscoderVariant,
  scratchRoot: string,
  cycleRef: { cycle: number },
): WorkerDeps["transcoder"] {
  if (variant === "none") return null;
  return async ({ objectKey }) => {
    const dir = join(scratchRoot, `job-${cycleRef.cycle}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "input.mov"), SCRATCH_PAYLOAD);
    writeFileSync(join(dir, "normalized.mp4"), SCRATCH_PAYLOAD);
    writeFileSync(join(dir, "thumb.jpg"), SCRATCH_PAYLOAD.subarray(0, 4096));
    if (variant === "throw_after_scratch") {
      // Models an implementation that relies on its caller for cleanup: the
      // worker seam offers none, so these files stay.
      throw new Error("ffmpeg exited 1: unsupported codec");
    }
    rmSync(dir, { recursive: true, force: true });
    if (variant === "bad_prefix") {
      return {
        normalizedKey: `derived/${cycleRef.cycle}/normalized.mp4`,
        thumbnailKey: `derived/${cycleRef.cycle}/thumb.jpg`,
      };
    }
    return {
      normalizedKey: `${objectKey}/normalized.mp4`,
      thumbnailKey: `${objectKey}/thumb.jpg`,
    };
  };
}

export interface CycleRecord {
  cycle: number;
  durationMs: number;
  heapUsed: number;
  rss: number;
  jobsHandled: number;
  queueDepthAfter: number;
  oldestJobAgeMsAfter: number | null;
  objectDeletesCumulative: number;
  scratch: ScratchStats;
  analyticsEventsThisCycle: number;
  /** The worker's log line for the media.process job (outcome note). */
  note: string | null;
  threw: string | null;
}

export interface VariantReport {
  variant: TranscoderVariant;
  /** Control run: identical loop and record retention, but `runOnce` is not
   * called (the job is enqueued and drained directly). Its heap slope is the
   * harness's own retention. */
  control: boolean;
  cycles: number;
  records: CycleRecord[];
  latency: {
    meanMs: number;
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
    maxMs: number;
    cyclesPerSec: number;
    slopeMsPerCycle: number;
  };
  heap: HeapVerdict;
  jobsHandled: number;
  jobsLeftOnQueue: number;
  objectDeletes: number;
  readyUpdates: number;
  failedUpdates: number;
  poolQueries: number;
  /** Scratch files left under the root after the last cycle (before harness cleanup). */
  residualScratch: ScratchStats;
  /** Residual files per cycle — >0 means each cycle leaks scratch through the seam. */
  residualFilesPerCycle: number;
  /** Distinct outcome notes with counts (object keys stripped to a stable form). */
  outcomes: Record<string, number>;
  exceptions: number;
  analyticsEventsTotal: number;
  analyticsBufferedAtEnd: number;
}

function normalizeNote(note: string): string {
  return note.replace(/\d+/g, "#").replace(/[a-f0-9]{8}-[a-f0-9-]{27}/g, "<uuid>");
}

export async function runVariant(options: {
  variant: TranscoderVariant;
  cycles: number;
  warmupCycles: number;
  windowCycles: number;
  thresholdPer100CyclesPct: number;
  scratchRoot: string;
  control?: boolean;
  onCycle?: (record: CycleRecord) => void;
}): Promise<VariantReport> {
  const cycleRef = { cycle: 0 };
  const pool = new FakeMediaPool(() => (options.variant === "deleted_mid_transcode" ? 0 : 1));
  const queue = new InMemoryJobQueue();
  const objectStore = new CountingObjectStore();
  const tracked: AnalyticsEvent[] = [];
  let analyticsBuffered = 0;
  const analytics: IAnalyticsSink = {
    track: (event) => {
      tracked.push(event);
      analyticsBuffered++;
    },
    flush: async () => {
      analyticsBuffered = 0;
    },
  };
  let lastNote: string | null = null;
  const deps: WorkerDeps = {
    pool: pool.asPool(),
    queue,
    objectStore,
    transcoder: makeTranscoder(options.variant, options.scratchRoot, cycleRef),
    log: (line) => {
      if (line.startsWith("media.process:")) lastNote = line.slice("media.process:".length).trim();
    },
    analytics,
    sloMonitor: new QueueSloMonitor(DEFAULT_QUEUE_SLO_CONFIG),
  };

  const records: CycleRecord[] = [];
  let jobsHandled = 0;
  let exceptions = 0;
  const outcomes: Record<string, number> = {};
  for (let cycle = 0; cycle < options.cycles; cycle++) {
    cycleRef.cycle = cycle;
    lastNote = null;
    const assetId = `asset-${cycle}`;
    pool.setAsset(assetId, {
      object_key: `masters/user-1/${assetId}.mov`,
      owner_user_id: "user-1",
      deleted_at: null,
    });
    await queue.enqueue("media.process", { mediaAssetId: assetId });
    const trackedBefore = tracked.length;
    const started = performance.now();
    let threw: string | null = null;
    let handled = 0;
    try {
      if (options.control) {
        for (const { ack } of await queue.receive(10)) await ack();
      } else {
        handled = (await runOnce(deps)).jobs;
      }
    } catch (error) {
      exceptions++;
      threw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    }
    const durationMs = performance.now() - started;
    jobsHandled += handled;
    const heapUsed = collectHeapUsed();
    const note: string | null = lastNote;
    if (note !== null) {
      const key = normalizeNote(note);
      outcomes[key] = (outcomes[key] ?? 0) + 1;
    }
    const record: CycleRecord = {
      cycle,
      durationMs,
      heapUsed,
      rss: process.memoryUsage().rss,
      jobsHandled: handled,
      queueDepthAfter: await queue.size(),
      oldestJobAgeMsAfter: await queue.oldestJobAgeMs(),
      objectDeletesCumulative: objectStore.deleted,
      scratch: scratchStats(options.scratchRoot),
      analyticsEventsThisCycle: tracked.length - trackedBefore,
      note,
      threw,
    };
    records.push(record);
    options.onCycle?.(record);
    // Keep the fake sink from confounding the heap slope: it is a harness
    // array, not worker state.
    tracked.length = 0;
  }
  const durations = records.map((r) => r.durationMs);
  const total = durations.reduce((a, b) => a + b, 0);
  const residual = scratchStats(options.scratchRoot);
  return {
    variant: options.variant,
    control: options.control === true,
    cycles: options.cycles,
    records,
    latency: {
      meanMs: durations.length > 0 ? total / durations.length : 0,
      p50Ms: percentile(durations, 50),
      p95Ms: percentile(durations, 95),
      p99Ms: percentile(durations, 99),
      maxMs: durations.length > 0 ? Math.max(...durations) : 0,
      cyclesPerSec: total > 0 ? (durations.length / total) * 1000 : 0,
      slopeMsPerCycle: linearFit(durations.map((y, x) => ({ x, y }))).slope,
    },
    heap: heapVerdict(
      records.map((r) => r.heapUsed),
      {
        warmupCycles: options.warmupCycles,
        windowCycles: options.windowCycles,
        thresholdPer100CyclesPct: options.thresholdPer100CyclesPct,
        gc: gcAvailable(),
      },
    ),
    jobsHandled,
    jobsLeftOnQueue: await queue.size(),
    objectDeletes: objectStore.deleted,
    readyUpdates: pool.readyUpdates,
    failedUpdates: pool.failedUpdates,
    poolQueries: pool.queries,
    residualScratch: residual,
    residualFilesPerCycle: options.cycles > 0 ? residual.files / options.cycles : 0,
    outcomes,
    exceptions,
    analyticsEventsTotal: records.reduce((sum, r) => sum + r.analyticsEventsThisCycle, 0),
    analyticsBufferedAtEnd: analyticsBuffered,
  };
}

export interface WorkerSoakReport {
  harness: "media-worker-soak-1";
  environment: {
    node: string;
    platform: string;
    gcExposed: boolean;
    execArgv: string[];
    startedAtIso: string;
    gitCommit: string | null;
  };
  productionTranscoder: {
    /** What main.ts wires today. */
    configured: "null";
    note: string;
  };
  control: VariantReport | null;
  variants: VariantReport[];
  /** Per variant: workload heap slope minus the control slope. */
  controlAdjusted: Array<{
    variant: TranscoderVariant;
    controlSlopeBytesPerCycle: number;
    workloadSlopeBytesPerCycle: number;
    adjustedSlopeBytesPerCycle: number;
    adjustedSlopePer100CyclesPct: number;
  }>;
  findings: Array<{ variant: string; criterion: string; detail: string; replay: string }>;
  finishedAtIso: string;
}

export function controlAdjust(
  variants: readonly VariantReport[],
  control: VariantReport | null,
): WorkerSoakReport["controlAdjusted"] {
  const controlSlope = control?.heap.slopeBytesPerCycle ?? 0;
  return variants.map((v) => {
    const adjusted = v.heap.slopeBytesPerCycle - controlSlope;
    return {
      variant: v.variant,
      controlSlopeBytesPerCycle: controlSlope,
      workloadSlopeBytesPerCycle: v.heap.slopeBytesPerCycle,
      adjustedSlopeBytesPerCycle: adjusted,
      adjustedSlopePer100CyclesPct:
        v.heap.baselineHeapUsed > 0 ? ((adjusted * 100) / v.heap.baselineHeapUsed) * 100 : 0,
    };
  });
}

export function createScratchRoot(): string {
  return mkdtempSync(join(tmpdir(), "pickle-media-worker-soak-"));
}

export function removeScratchRoot(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

export function deriveWorkerFindings(
  variants: readonly VariantReport[],
  control: VariantReport | null,
): WorkerSoakReport["findings"] {
  const findings: WorkerSoakReport["findings"] = [];
  const adjustedByVariant = new Map(controlAdjust(variants, control).map((a) => [a.variant, a]));
  for (const v of variants) {
    const replay = `variant=${v.variant} cycles=${v.cycles} (deterministic; no seed)`;
    const adjusted = adjustedByVariant.get(v.variant);
    const slopePct = adjusted ? adjusted.adjustedSlopePer100CyclesPct : v.heap.slopePer100CyclesPct;
    if (v.exceptions > 0) {
      findings.push({
        variant: v.variant,
        criterion: "runOnce threw (poison job must never escape the cycle)",
        detail: `${v.exceptions} cycle(s) threw`,
        replay,
      });
    }
    const leak =
      v.heap.gcAvailable &&
      v.heap.monotoneAcrossWindows &&
      (slopePct > v.heap.thresholdPer100CyclesPct ||
        v.heap.maxWindowGrowthPct > v.heap.thresholdPer100CyclesPct);
    if (leak) {
      findings.push({
        variant: v.variant,
        criterion: `monotone gc'd heap growth > ${v.heap.thresholdPer100CyclesPct}% per 100 cycles`,
        detail:
          `raw slope ${v.heap.slopeBytesPerCycle.toFixed(0)} B/cycle = ${v.heap.slopePer100CyclesPct.toFixed(2)}%/100 cycles` +
          (adjusted
            ? `; control-adjusted ${adjusted.adjustedSlopeBytesPerCycle.toFixed(0)} B/cycle = ${adjusted.adjustedSlopePer100CyclesPct.toFixed(2)}%/100 cycles`
            : "") +
          `; max window step ${v.heap.maxWindowGrowthPct.toFixed(2)}%`,
        replay,
      });
    }
    if (v.jobsLeftOnQueue > 0 && v.variant !== "none") {
      findings.push({
        variant: v.variant,
        criterion: "media.process jobs left unacked on the queue",
        detail: `${v.jobsLeftOnQueue} of ${v.cycles} still queued`,
        replay,
      });
    }
    if (v.residualScratch.files > 0) {
      findings.push({
        variant: v.variant,
        criterion:
          "scratch files survive the cycle (harness-injected transcoder; the worker seam has no cleanup hook)",
        detail: `${v.residualScratch.files} files / ${(v.residualScratch.bytes / 1024 / 1024).toFixed(1)}MB after ${v.cycles} cycles = ${v.residualFilesPerCycle.toFixed(2)} files/cycle`,
        replay,
      });
    }
  }
  return findings;
}
