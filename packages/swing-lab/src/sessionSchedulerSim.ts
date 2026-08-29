import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  SESSION_SCHEDULER_VERSION,
  SessionAnalysisScheduler,
  SessionEventEngine,
  type SessionAnalysisExecutor,
  type SessionAnalysisTask,
  type SessionAnalysisTaskOutcome,
  type SessionSchedulerMetrics,
  type SpeedSample,
} from "@pickle/analysis-pipeline";
import type { AnalysisRecord } from "@pickle/swing-domain";
import { REPO_ROOT } from "./engine/corpus.js";

/**
 * SESSION SCHEDULER SIMULATION — progressive per-event analysis under load.
 *
 *   pnpm lab:session-scheduler-sim [--scale 0.05] [--out <path>]
 *
 * Exercises the REAL SessionEventEngine (canonical stroke-event-2 proposals
 * + D-029 completion over synthetic wrist-speed streams) and the REAL
 * SessionAnalysisScheduler (@pickle/analysis-pipeline/src/sessionScheduler.ts)
 * in wall-clock time: the stream is paced sample-by-sample and analysis
 * executions genuinely occupy their slot for the configured service time.
 * Nothing about scheduling is mocked.
 *
 * HONESTY BOUNDARY (stated in every artifact): the ANALYSIS EXECUTION behind
 * the executor seam is a simulated workload (deterministic seeded delays and
 * outcome mix) — real per-event analysis needs native clip extraction that
 * does not exist on Linux (D-040 Gap 2). All latency numbers are therefore
 * SCHEDULING latencies of the real queue under a modeled service time, in
 * STREAM-time milliseconds (wall-clock measurements divided by --scale;
 * scale 0.05 = 20× compressed playback), not device analysis benchmarks.
 *
 * Streams are clearly synthetic (parameterized gaussian speed bumps — the
 * same shape the engine's unit suites use). No gold labels are read, no
 * held-out case is touched, no cascade number is claimed.
 */

const SIM_VERSION = "session-scheduler-sim-1";

interface CliOptions {
  scale: number;
  outPath: string;
}

function parseArgs(argv: string[]): CliOptions {
  let scale = 0.05;
  let outPath = join(REPO_ROOT, "datasets/experiments/wave-e/e16-session-scheduler-sim.json");
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--scale") scale = Number(argv[++index]);
    else if (argv[index] === "--out") outPath = String(argv[++index]);
  }
  if (!Number.isFinite(scale) || scale <= 0 || scale > 1) {
    throw new Error(`--scale must be in (0, 1], got ${scale}`);
  }
  return { scale, outPath };
}

// ─── Deterministic PRNG (mulberry32) — seeded per scenario ────────────────

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── Synthetic stream construction ─────────────────────────────────────────

function strokeStream(input: {
  strokes: number;
  interStrokeMs: number;
  firstPeakMs: number;
  heightRange: [number, number];
  halfWidthMs: number;
  tailMs: number;
  stepMs: number;
  rng: () => number;
}): { samples: SpeedSample[]; peaksMs: number[] } {
  const peaks: Array<{ peakMs: number; height: number }> = [];
  for (let index = 0; index < input.strokes; index += 1) {
    const jitter = (input.rng() - 0.5) * 0.2 * input.interStrokeMs;
    peaks.push({
      peakMs: input.firstPeakMs + index * input.interStrokeMs + jitter,
      height: input.heightRange[0] + input.rng() * (input.heightRange[1] - input.heightRange[0]),
    });
  }
  const endMs = peaks[peaks.length - 1]!.peakMs + input.tailMs;
  const samples: SpeedSample[] = [];
  for (let t = 0; t <= endMs; t += input.stepMs) {
    let value = 0.08;
    for (const peak of peaks) {
      value += peak.height * Math.exp(-0.5 * ((t - peak.peakMs) / input.halfWidthMs) ** 2);
    }
    samples.push({ timestampMs: t, value });
  }
  return { samples, peaksMs: peaks.map((peak) => peak.peakMs) };
}

// ─── Simulated-workload executor (REAL slot occupancy, modeled outcomes) ──

const syntheticAnalysis = Object.freeze({
  id: "SIMULATED_WORKLOAD_ANALYSIS (scheduler sim — not a real analysis)",
}) as unknown as AnalysisRecord;

interface WorkloadSpec {
  /** Stream-time service duration range [min,max] ms per attempt. */
  serviceMsRange: [number, number];
  /** P(retryable extraction failure) per attempt. */
  pRetryableFailure: number;
  /** P(non-retryable failure) per attempt. */
  pFatalFailure: number;
  /** P(honest analysis abstain) per successful attempt. */
  pAbstain: number;
  /** Attempts that always fail retryably for these eventIds (targeted stress). */
  alwaysFailEventIds?: string[];
}

function workloadExecutor(
  spec: WorkloadSpec,
  scale: number,
  rng: () => number,
): SessionAnalysisExecutor {
  return {
    executorId: `sim-workload (service ${spec.serviceMsRange[0]}–${spec.serviceMsRange[1]}ms stream-time · pRetryFail ${spec.pRetryableFailure} · pFatal ${spec.pFatalFailure} · pAbstain ${spec.pAbstain})`,
    async execute(task: SessionAnalysisTask): Promise<SessionAnalysisTaskOutcome> {
      const serviceMs =
        spec.serviceMsRange[0] + rng() * (spec.serviceMsRange[1] - spec.serviceMsRange[0]);
      await sleep(serviceMs * scale);
      if (spec.alwaysFailEventIds?.includes(task.eventId)) {
        return {
          status: "failed",
          reason: `SIM_CLIP_EXTRACTION_FAILED: persistent (attempt ${task.attempt})`,
          retryable: true,
        };
      }
      const roll = rng();
      if (roll < spec.pRetryableFailure) {
        return {
          status: "failed",
          reason: `SIM_CLIP_EXTRACTION_FAILED: transient (attempt ${task.attempt})`,
          retryable: true,
        };
      }
      if (roll < spec.pRetryableFailure + spec.pFatalFailure) {
        return { status: "failed", reason: "SIM_POSE_SIDECAR_CORRUPT", retryable: false };
      }
      if (roll < spec.pRetryableFailure + spec.pFatalFailure + spec.pAbstain) {
        return {
          status: "abstained",
          abstainReason: "SIM_ANALYSIS_ABSTAINED: modeled honest abstention",
        };
      }
      return { status: "ready", analysis: syntheticAnalysis };
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

// ─── Scenario runner ───────────────────────────────────────────────────────

interface ScenarioSpec {
  id: string;
  title: string;
  seed: number;
  concurrency: number;
  maxAttempts: number;
  stream: Omit<Parameters<typeof strokeStream>[0], "rng">;
  workload: WorkloadSpec;
  /** Suspend [atStreamMs, forStreamMs] — interruption/recovery stress. */
  suspendWindow?: [number, number];
  /** After drain, run the restart-path recovery over the same engine. */
  restartRecovery?: boolean;
}

interface LatencyStats {
  n: number;
  p50: number;
  p95: number;
  max: number;
  mean: number;
}

function latencyStats(values: number[]): LatencyStats | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
  return {
    n: sorted.length,
    p50: round1(at(0.5)),
    p95: round1(at(0.95)),
    max: round1(sorted[sorted.length - 1]!),
    mean: round1(sorted.reduce((total, value) => total + value, 0) / sorted.length),
  };
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

interface CorrectnessReport {
  closedEvents: number;
  strokesInStream: number;
  everyClosedEventTracked: boolean;
  terminalOrHonestPending: boolean;
  readyIffAnalysisPresent: boolean;
  firstAttemptsFifo: boolean;
  attemptsWithinBudget: boolean;
  engineSchedulerStateAgreement: boolean;
  violations: string[];
}

interface ScenarioResult {
  id: string;
  title: string;
  seed: number;
  concurrency: number;
  maxAttempts: number;
  streamDurationMs: number;
  wallDurationMs: number;
  scheduler: Omit<SessionSchedulerMetrics, "tasks">;
  latenciesStreamMs: {
    queueWait: LatencyStats | null;
    service: LatencyStats | null;
    closeToTerminal: LatencyStats | null;
  };
  progressiveOverlap: {
    /** Events whose analysis STARTED before the stream ended (the
     * analyze-while-recording property, measured). */
    startedBeforeStreamEnd: number;
    finishedBeforeStreamEnd: number;
  };
  outcomes: Record<string, number>;
  recovery?: {
    readmitted: number;
    readyAfterRecovery: number;
    pendingAfterRecovery: number;
  };
  correctness: CorrectnessReport;
}

async function runScenario(spec: ScenarioSpec, scale: number): Promise<ScenarioResult> {
  const rng = mulberry32(spec.seed);
  const { samples } = strokeStream({ ...spec.stream, rng });
  const streamDurationMs = samples[samples.length - 1]!.timestampMs;
  const engine = new SessionEventEngine({
    sessionId: `sim-${spec.id}`,
    captureMeta: { source: "replay", fps: Math.round(1000 / spec.stream.stepMs) },
  });
  const executorRng = mulberry32(spec.seed ^ 0x9e3779b9);
  const executor = workloadExecutor(spec.workload, scale, executorRng);
  const scheduler = new SessionAnalysisScheduler({
    engine,
    executor,
    concurrency: spec.concurrency,
    maxAttempts: spec.maxAttempts,
  });

  const wallStart = performance.now();
  const dispatchOrder: string[] = [];
  const startedBeforeEnd = new Set<string>();
  const finishedBeforeEnd = new Set<string>();
  const closedAtWall = new Map<string, number>();

  // Paced playback: samples arrive at stream cadence × scale. Recording
  // NEVER pauses for analysis — that is the property under test.
  let suspended = false;
  for (const sample of samples) {
    const closed = scheduler.pushSamples({ wrist: [sample] });
    for (const event of closed) closedAtWall.set(event.eventId, performance.now());
    if (spec.suspendWindow) {
      const [atMs, forMs] = spec.suspendWindow;
      if (!suspended && sample.timestampMs >= atMs) {
        scheduler.suspend();
        suspended = true;
      }
      if (suspended && sample.timestampMs >= atMs + forMs) {
        scheduler.resume();
        suspended = false;
      }
    }
    trackProgress(scheduler, dispatchOrder, startedBeforeEnd, finishedBeforeEnd);
    await sleep(spec.stream.stepMs * scale);
  }
  const flushClosed = scheduler.endOfStream();
  for (const event of flushClosed) closedAtWall.set(event.eventId, performance.now());
  if (suspended) scheduler.resume();
  await scheduler.drained();

  // Correctness is judged on the FIRST scheduler's completed run — the
  // restart-path recovery below deliberately supersedes exhausted verdicts,
  // so it is scored separately (recovery block).
  const correctness = checkCorrectness(engine, scheduler.metrics(), spec, dispatchOrder);

  let recovery: ScenarioResult["recovery"];
  if (spec.restartRecovery) {
    // Restart path: a NEW scheduler over the SAME engine (queue state lost),
    // with a clean workload (the transient fault cleared after restart).
    const recoveryExecutor = workloadExecutor(
      { ...spec.workload, pRetryableFailure: 0, pFatalFailure: 0, alwaysFailEventIds: [] },
      scale,
      mulberry32(spec.seed ^ 0x51ed2701),
    );
    const second = new SessionAnalysisScheduler({
      engine,
      executor: recoveryExecutor,
      concurrency: spec.concurrency,
      maxAttempts: spec.maxAttempts,
    });
    const readmitted = second.recoverPending({ readmitExhausted: true });
    await second.drained();
    const states = engine.snapshot().events;
    recovery = {
      readmitted: readmitted.length,
      readyAfterRecovery: states.filter((event) => event.state === "ready").length,
      pendingAfterRecovery: states.filter((event) => event.state === "pending").length,
    };
  }

  const wallDurationMs = performance.now() - wallStart;
  const metrics = scheduler.metrics();
  const { tasks, ...schedulerCounters } = metrics;

  const toStream = (wallMs: number) => wallMs / scale;
  const queueWaits = tasks
    .filter((task) => task.queueWaitMs !== null)
    .map((task) => toStream(task.queueWaitMs!));
  const services = tasks
    .filter((task) => task.serviceMs > 0)
    .map((task) => toStream(task.serviceMs));
  const totals = tasks
    .filter((task) => task.totalLatencyMs !== null)
    .map((task) => toStream(task.totalLatencyMs!));

  const outcomes: Record<string, number> = {};
  for (const task of tasks) {
    const key = task.outcome ?? "unfinished";
    outcomes[key] = (outcomes[key] ?? 0) + 1;
  }

  return {
    id: spec.id,
    title: spec.title,
    seed: spec.seed,
    concurrency: spec.concurrency,
    maxAttempts: spec.maxAttempts,
    streamDurationMs,
    wallDurationMs: round1(wallDurationMs),
    scheduler: schedulerCounters,
    latenciesStreamMs: {
      queueWait: latencyStats(queueWaits),
      service: latencyStats(services),
      closeToTerminal: latencyStats(totals),
    },
    progressiveOverlap: {
      startedBeforeStreamEnd: startedBeforeEnd.size,
      finishedBeforeStreamEnd: finishedBeforeEnd.size,
    },
    outcomes,
    ...(recovery ? { recovery } : {}),
    correctness,
  };
}

function trackProgress(
  scheduler: SessionAnalysisScheduler,
  dispatchOrder: string[],
  startedBeforeEnd: Set<string>,
  finishedBeforeEnd: Set<string>,
): void {
  for (const task of scheduler.metrics().tasks) {
    if (task.startedAt !== null && !dispatchOrder.includes(task.eventId)) {
      dispatchOrder.push(task.eventId);
    }
    if (task.startedAt !== null) startedBeforeEnd.add(task.eventId);
    if (task.finishedAt !== null) finishedBeforeEnd.add(task.eventId);
  }
}

function checkCorrectness(
  engine: SessionEventEngine,
  metrics: SessionSchedulerMetrics,
  spec: ScenarioSpec,
  firstDispatchOrder: string[],
): CorrectnessReport {
  const violations: string[] = [];
  const events = engine.snapshot().events;
  const recordById = new Map(metrics.tasks.map((task) => [task.eventId, task]));

  const everyClosedEventTracked = events.every((event) => recordById.has(event.eventId));
  if (!everyClosedEventTracked) violations.push("closed event missing from scheduler records");

  let terminalOrHonestPending = true;
  let readyIffAnalysisPresent = true;
  let engineSchedulerStateAgreement = true;
  for (const event of events) {
    const record = recordById.get(event.eventId);
    if (event.state === "processing") {
      terminalOrHonestPending = false;
      violations.push(`${event.eventId} left 'processing' after drain`);
    }
    if (event.state === "pending" && record && record.failures.length === 0) {
      terminalOrHonestPending = false;
      violations.push(`${event.eventId} pending with no recorded failure reason`);
    }
    if ((event.state === "ready") !== (event.analysis !== null)) {
      readyIffAnalysisPresent = false;
      violations.push(`${event.eventId} ready/analysis mismatch`);
    }
    if (record) {
      const agree =
        (event.state === "ready" && record.outcome === "ready") ||
        (event.state === "abstained" && record.outcome === "abstained") ||
        (event.state === "pending" &&
          (record.outcome === "failed_final" || record.outcome === "retry_exhausted"));
      if (!agree) {
        engineSchedulerStateAgreement = false;
        violations.push(
          `${event.eventId}: engine '${event.state}' vs scheduler '${record.outcome}'`,
        );
      }
    }
  }

  const emissionOrder = events.map((event) => event.eventId);
  const firstAttemptsFifo = firstDispatchOrder.every(
    (eventId, index) => emissionOrder[index] === eventId,
  );
  if (!firstAttemptsFifo) {
    violations.push(
      `first-dispatch order ${firstDispatchOrder.join(",")} != emission order ${emissionOrder.join(",")}`,
    );
  }

  const attemptsWithinBudget = metrics.tasks.every((task) => task.attempts <= spec.maxAttempts);
  if (!attemptsWithinBudget) violations.push("a task exceeded maxAttempts");

  if (metrics.maxInFlight > spec.concurrency) {
    violations.push(`maxInFlight ${metrics.maxInFlight} exceeded concurrency ${spec.concurrency}`);
  }

  return {
    closedEvents: events.length,
    strokesInStream: spec.stream.strokes,
    everyClosedEventTracked,
    terminalOrHonestPending,
    readyIffAnalysisPresent,
    firstAttemptsFifo,
    attemptsWithinBudget,
    engineSchedulerStateAgreement,
    violations,
  };
}

// ─── Scenario suite ────────────────────────────────────────────────────────

function scenarios(): ScenarioSpec[] {
  const baseStream = {
    firstPeakMs: 1500,
    heightRange: [1.6, 2.6] as [number, number],
    halfWidthMs: 120,
    tailMs: 4000,
    stepMs: 40,
  };
  return [
    {
      id: "steady-rally",
      title: "Steady rally: 20 strokes / 2.4s apart, analysis faster than arrivals",
      seed: 101,
      concurrency: 1,
      maxAttempts: 2,
      stream: { ...baseStream, strokes: 20, interStrokeMs: 2400 },
      workload: {
        serviceMsRange: [800, 1400],
        pRetryableFailure: 0,
        pFatalFailure: 0,
        pAbstain: 0,
      },
    },
    {
      id: "rapid-rally-backlog",
      title: "Rapid rally backlog: 30 strokes / 1.3s apart, 3–4s analyses (overloaded slot)",
      seed: 202,
      concurrency: 1,
      maxAttempts: 2,
      stream: { ...baseStream, strokes: 30, interStrokeMs: 1300 },
      workload: {
        serviceMsRange: [3000, 4000],
        pRetryableFailure: 0,
        pFatalFailure: 0,
        pAbstain: 0,
      },
    },
    {
      id: "rapid-rally-2slots",
      title: "Same rapid rally with concurrency 2 (backlog relief measured)",
      seed: 202,
      concurrency: 2,
      maxAttempts: 2,
      stream: { ...baseStream, strokes: 30, interStrokeMs: 1300 },
      workload: {
        serviceMsRange: [3000, 4000],
        pRetryableFailure: 0,
        pFatalFailure: 0,
        pAbstain: 0,
      },
    },
    {
      id: "flaky-extraction",
      title: "Failed extraction: 25% transient + 5% fatal failures, maxAttempts 3",
      seed: 303,
      concurrency: 1,
      maxAttempts: 3,
      stream: { ...baseStream, strokes: 24, interStrokeMs: 2000 },
      workload: {
        serviceMsRange: [900, 1500],
        pRetryableFailure: 0.25,
        pFatalFailure: 0.05,
        pAbstain: 0,
      },
    },
    {
      id: "abstain-mix",
      title: "Abstained events: 20% modeled honest abstentions in the mix",
      seed: 404,
      concurrency: 1,
      maxAttempts: 2,
      stream: { ...baseStream, strokes: 20, interStrokeMs: 2200 },
      workload: {
        serviceMsRange: [900, 1500],
        pRetryableFailure: 0.1,
        pFatalFailure: 0,
        pAbstain: 0.2,
      },
    },
    {
      id: "interruption-recovery",
      title:
        "Interruption mid-rally (suspend 6s) then restart-path recovery of exhausted/pending events",
      seed: 505,
      concurrency: 1,
      maxAttempts: 2,
      stream: { ...baseStream, strokes: 18, interStrokeMs: 1800 },
      workload: {
        serviceMsRange: [1200, 1800],
        pRetryableFailure: 0.15,
        pFatalFailure: 0.1,
        pAbstain: 0,
        alwaysFailEventIds: ["E3", "E7"],
      },
      suspendWindow: [12000, 6000],
      restartRecovery: true,
    },
    {
      id: "long-session-backlog",
      title:
        "Long session with sustained backlog: 120 strokes / 1.5s apart, 2.5–3.5s analyses (overloaded slot for the whole session)",
      seed: 606,
      concurrency: 1,
      maxAttempts: 2,
      stream: { ...baseStream, strokes: 120, interStrokeMs: 1500 },
      workload: {
        serviceMsRange: [2500, 3500],
        pRetryableFailure: 0.05,
        pFatalFailure: 0,
        pAbstain: 0.1,
      },
    },
  ];
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const results: ScenarioResult[] = [];
  for (const spec of scenarios()) {
    process.stdout.write(`▶ ${spec.id} … `);
    const result = await runScenario(spec, options.scale);
    const verdictOk = result.correctness.violations.length === 0;
    process.stdout.write(
      `${verdictOk ? "OK" : "VIOLATIONS"} — ${result.correctness.closedEvents} events, ` +
        `maxQueueDepth ${result.scheduler.maxQueueDepth}, ` +
        `wait p95 ${result.latenciesStreamMs.queueWait?.p95 ?? "–"}ms (stream)\n`,
    );
    results.push(result);
  }
  const artifact = {
    version: SIM_VERSION,
    schedulerVersion: SESSION_SCHEDULER_VERSION,
    generatedAtIso: new Date().toISOString(),
    timeScale: options.scale,
    honesty:
      "Real SessionEventEngine + real SessionAnalysisScheduler under paced wall-clock playback. " +
      "Analysis execution is a simulated workload behind the executor seam (deterministic seeded " +
      "delays/outcomes) — native clip extraction does not exist on Linux (D-040 Gap 2). Latencies " +
      "are stream-time ms (wall / scale) and describe SCHEDULING under a modeled service time, " +
      "never device analysis performance. Streams are synthetic; no gold labels or held-out cases touched.",
    scenarios: results,
    allCorrect: results.every((result) => result.correctness.violations.length === 0),
  };
  mkdirSync(join(options.outPath, ".."), { recursive: true });
  writeFileSync(options.outPath, `${JSON.stringify(artifact, null, 2)}\n`);
  process.stdout.write(`\nartifact → ${options.outPath}\nallCorrect: ${artifact.allCorrect}\n`);
  if (!artifact.allCorrect) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
