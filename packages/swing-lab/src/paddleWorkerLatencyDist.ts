/**
 * Warm paddle-worker latency DISTRIBUTION harness (Wave G / g23-latency-dist).
 *
 * E18 soaked the worker for correctness (ok-counts, leak slope, restart
 * contracts) but recorded only aggregate wall time per phase. This harness
 * records EVERY request's latency so P50/P90/P95 tails, crash-recovery
 * timing, fallback-path timing, and per-batch concurrency behavior are
 * measured as distributions, not single runs.
 *
 * Phases (all real worker: tools/paddle-lab/detect_paddle.py --serve over
 * committed dev bundle clips ONLY — wm-dink-01 / afn-vic-rally1 are held out
 * and never referenced):
 *   startup      N cold spawn -> ready timings (process-lifetime cost)
 *   seq-dist     N sequential requests over the 4 E18 shapes (500 ms windows,
 *                stride 3, 2 clips x 2 windows); per-request client wall ms +
 *                worker-reported requestWallSec; RSS sampled every request
 *   conc-dist    batches of 2 and 4 concurrent requests; per-request latency
 *                and per-batch wall
 *   crash        N cycles of mid-flight SIGKILL: fallback-window duration
 *                (real one-shot invocation) and first-post-restart request
 *                duration vs steady state
 *   oneshot      N one-shot detect_paddle.py invocations of a fixed shape
 *                (the fallback path's true cost including python+model load)
 *
 * Usage:
 *   pnpm --filter @pickle/swing-lab worker:latency-dist -- [--seq 100]
 *     [--startups 3] [--crashes 5] [--oneshots 8]
 *     [--detect-script /abs/path/detect_paddle.py] [--label head]
 *     [--out /abs/output-dir]
 */
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  PaddleServeWorker,
  PaddleWorkerError,
  PaddleWorkerSupervisor,
  detectPaddleWindow,
  type PaddleDetectRequest,
} from "./paddleWorker.js";

const execFileAsync = promisify(execFile);

const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
const PYTHON = join(REPO_ROOT, "tools/paddle-lab/.venv/bin/python");
const DEFAULT_DETECT_SCRIPT = join(REPO_ROOT, "tools/paddle-lab/detect_paddle.py");

// Committed dev bundles only. wm-dink-01 and afn-vic-rally1 are held out and
// MUST NOT appear here. Shapes match e18-warm-worker-soak so distributions
// are comparable to that baseline's aggregate numbers.
const CLIPS = [
  {
    name: "wm-volley-02",
    video: join(REPO_ROOT, "datasets/paddle-bench/bundles/wm-volley-02/clip.mp4"),
    windows: [
      { startMs: 5300, endMs: 5800 },
      { startMs: 6200, endMs: 6700 },
    ],
  },
  {
    name: "afn-sasebo-rally1",
    video: join(REPO_ROOT, "datasets/paddle-bench/bundles/afn-sasebo-rally1/clip.mp4"),
    windows: [
      { startMs: 2100, endMs: 2600 },
      { startMs: 3100, endMs: 3600 },
    ],
  },
];

interface DistSummary {
  n: number;
  p50: number;
  p90: number;
  p95: number;
  min: number;
  max: number;
  mean: number;
}

/** Nearest-rank percentile over a copy of the values (same method as e17). */
function percentile(sorted: number[], p: number): number {
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1]!;
}

function summarize(values: number[]): DistSummary | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mean = sorted.reduce((acc, v) => acc + v, 0) / sorted.length;
  return {
    n: sorted.length,
    p50: percentile(sorted, 50),
    p90: percentile(sorted, 90),
    p95: percentile(sorted, 95),
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
    mean: Math.round(mean * 10) / 10,
  };
}

function readRssKb(pid: number | null | undefined): number | null {
  if (!pid) return null;
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const match = /VmRSS:\s+(\d+)\s+kB/.exec(status);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

function listServeProcesses(): number[] {
  try {
    const out = execFileSync("pgrep", ["-f", "detect_paddle.py --serve"], { encoding: "utf8" });
    return out
      .split("\n")
      .filter(Boolean)
      .map(Number)
      .filter((pid) => pid !== process.pid);
  } catch {
    return []; // pgrep exits 1 when nothing matches
  }
}

function shapeRequest(outDir: string, i: number): PaddleDetectRequest & { shape: string } {
  const clip = CLIPS[i % CLIPS.length]!;
  const window = clip.windows[Math.floor(i / CLIPS.length) % clip.windows.length]!;
  return {
    video: clip.video,
    out: join(outDir, `dist-${i}.json`),
    startMs: window.startMs,
    endMs: window.endMs,
    stride: 3,
    floor: 0.08,
    shape: `${clip.name}:${window.startMs}-${window.endMs}`,
  };
}

function arg(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  if (index === -1 || index + 1 >= process.argv.length) return fallback;
  return Number(process.argv[index + 1]);
}

function argStr(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  if (index === -1 || index + 1 >= process.argv.length) return fallback;
  return process.argv[index + 1]!;
}

interface RssPoint {
  request: number;
  atMs: number;
  workerRssKb: number | null;
  clientRssKb: number;
}

async function main(): Promise<void> {
  const detectScript = argStr("--detect-script", DEFAULT_DETECT_SCRIPT);
  const label = argStr("--label", "head");
  const outRoot = argStr("--out", join(tmpdir(), `paddle-latency-dist-${Date.now()}`));
  const seqN = arg("--seq", 100);
  const startupsN = arg("--startups", 3);
  const crashesN = arg("--crashes", 5);
  const oneshotsN = arg("--oneshots", 8);
  if (!existsSync(PYTHON) || !existsSync(detectScript)) {
    throw new Error(`paddle-lab venv or detect script missing: ${PYTHON} / ${detectScript}`);
  }
  mkdirSync(outRoot, { recursive: true });
  const workDir = join(outRoot, "work");
  mkdirSync(workDir, { recursive: true });

  const progress = (message: string) => console.error(`[latency-dist] ${message}`);
  const report: Record<string, unknown> = {
    label,
    detectScript,
    startedAt: new Date().toISOString(),
    node: process.version,
    commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim(),
    args: { seqN, startupsN, crashesN, oneshotsN },
  };

  // ---- Phase: startup (cold spawn -> ready) --------------------------------
  progress("phase: startup");
  const startupMs: number[] = [];
  const readyMeta: unknown[] = [];
  for (let i = 0; i < startupsN; i += 1) {
    const t0 = Date.now();
    const worker = new PaddleServeWorker(PYTHON, [detectScript, "--serve"], { log: () => {} });
    const ready = await worker.ready();
    startupMs.push(Date.now() - t0);
    readyMeta.push(ready);
    worker.dispose();
    await new Promise((r) => setTimeout(r, 300));
  }
  report["startup"] = { perSpawnMs: startupMs, dist: summarize(startupMs), readyMeta };

  // ---- Phase: sequential distribution --------------------------------------
  progress("phase: sequential");
  const worker = new PaddleServeWorker(PYTHON, [detectScript, "--serve"], { log: () => {} });
  const seqStarted = Date.now();
  await worker.ready();
  const workerPid = worker.pid;
  const perRequest: {
    request: number;
    shape: string;
    clientWallMs: number;
    workerWallMs: number;
  }[] = [];
  const rssCurve: RssPoint[] = [];
  const seqFailures: { request: number; error: string }[] = [];
  for (let i = 1; i <= seqN; i += 1) {
    const request = shapeRequest(workDir, i);
    const t0 = Date.now();
    try {
      const response = await worker.detect(request);
      const clientWallMs = Date.now() - t0;
      perRequest.push({
        request: i,
        shape: request.shape,
        clientWallMs,
        workerWallMs: Math.round(response.requestWallSec * 1000),
      });
      rmSync(request.out, { force: true });
    } catch (error) {
      seqFailures.push({
        request: i,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (i % 10 === 0) progress(`sequential ${i}/${seqN}`);
    rssCurve.push({
      request: i,
      atMs: Date.now() - seqStarted,
      workerRssKb: readRssKb(workerPid),
      clientRssKb: Math.round(process.memoryUsage.rss() / 1024),
    });
  }
  const byShape: Record<string, DistSummary | null> = {};
  for (const clip of CLIPS) {
    for (const window of clip.windows) {
      const shape = `${clip.name}:${window.startMs}-${window.endMs}`;
      byShape[shape] = summarize(
        perRequest.filter((r) => r.shape === shape).map((r) => r.clientWallMs),
      );
    }
  }
  const workerRssValues = rssCurve
    .map((p) => p.workerRssKb)
    .filter((v): v is number => typeof v === "number");
  report["sequential"] = {
    requests: seqN,
    ok: perRequest.length,
    failures: seqFailures,
    pooledClientWallMs: summarize(perRequest.map((r) => r.clientWallMs)),
    pooledWorkerWallMs: summarize(perRequest.map((r) => r.workerWallMs)),
    byShapeClientWallMs: byShape,
    workerRssKb:
      workerRssValues.length > 0
        ? {
            first: workerRssValues[0],
            last: workerRssValues[workerRssValues.length - 1],
            min: Math.min(...workerRssValues),
            max: Math.max(...workerRssValues),
          }
        : null,
    wallMsTotal: Date.now() - seqStarted,
  };
  writeFileSync(
    join(outRoot, `${label}-seq-per-request.json`),
    `${JSON.stringify({ perRequest, rssCurve }, null, 2)}\n`,
  );

  // ---- Phase: concurrency distribution --------------------------------------
  progress("phase: concurrency");
  const concurrency: Record<string, unknown> = {};
  for (const batchSize of [2, 4]) {
    const rounds = Math.max(1, Math.floor(40 / batchSize));
    const perReqMs: number[] = [];
    const perBatchMs: number[] = [];
    const failures: string[] = [];
    let issued = 0;
    for (let round = 0; round < rounds; round += 1) {
      const b0 = Date.now();
      await Promise.all(
        Array.from({ length: batchSize }, () => {
          issued += 1;
          const request = shapeRequest(workDir, 700_000 + issued);
          const t0 = Date.now();
          return worker
            .detect(request)
            .then(() => {
              perReqMs.push(Date.now() - t0);
              rmSync(request.out, { force: true });
            })
            .catch((error: unknown) => {
              failures.push(error instanceof Error ? error.message : String(error));
            });
        }),
      );
      perBatchMs.push(Date.now() - b0);
      if ((round + 1) % 5 === 0)
        progress(`concurrency batch${batchSize} round ${round + 1}/${rounds}`);
    }
    concurrency[`batch${batchSize}`] = {
      rounds,
      requests: issued,
      ok: perReqMs.length,
      failures: failures.slice(0, 5),
      perRequestMs: summarize(perReqMs),
      perBatchMs: summarize(perBatchMs),
    };
  }
  report["concurrency"] = concurrency;
  const lifetimeMs = Date.now() - seqStarted;
  worker.dispose();
  report["workerLifetime"] = {
    lifetimeMs,
    requestsServed: perRequest.length + 80,
    note: "single worker process served the sequential + concurrency phases",
  };

  // ---- Phase: one-shot fallback-path timing ---------------------------------
  progress("phase: one-shot fallback");
  const oneShotShape = shapeRequest(workDir, 0);
  const oneShotMs: number[] = [];
  for (let i = 0; i < oneshotsN; i += 1) {
    const out = join(workDir, `oneshot-${i}.json`);
    const t0 = Date.now();
    await execFileAsync(PYTHON, [
      detectScript,
      "--video",
      oneShotShape.video,
      "--out",
      out,
      "--start-ms",
      String(oneShotShape.startMs),
      "--end-ms",
      String(oneShotShape.endMs),
      "--stride",
      "3",
      "--floor",
      "0.08",
    ]);
    oneShotMs.push(Date.now() - t0);
    rmSync(out, { force: true });
    progress(`one-shot ${i + 1}/${oneshotsN}`);
  }
  report["oneShotFallbackPath"] = {
    shape: oneShotShape.shape,
    perInvocationMs: oneShotMs,
    dist: summarize(oneShotMs),
    note: "each invocation pays python import + model load + inference; this is the cost of every window that falls back",
  };

  // ---- Phase: crash/restart recovery timing ---------------------------------
  progress("phase: crash recovery");
  const crashCycles: {
    cycle: number;
    steadyMs: number;
    fallbackWindowMs: number;
    fallbackPath: string;
    postRestartMs: number;
    postRestartPath: string;
  }[] = [];
  const crashFailures: string[] = [];
  const supervisor = new PaddleWorkerSupervisor(
    () => new PaddleServeWorker(PYTHON, [detectScript, "--serve"], { log: () => {} }),
    { maxRestarts: crashesN + 2 },
  );
  await supervisor.ready();
  for (let cycle = 1; cycle <= crashesN; cycle += 1) {
    const steady = shapeRequest(workDir, 800_000 + cycle);
    const s0 = Date.now();
    await supervisor.detect(steady);
    const steadyMs = Date.now() - s0;
    rmSync(steady.out, { force: true });

    const doomed = shapeRequest(workDir, 810_000 + cycle);
    const d0 = Date.now();
    let fallbackMs = -1;
    const inFlight = detectPaddleWindow({
      worker: supervisor,
      request: doomed,
      oneShot: () => {
        // Real fallback: pay the one-shot invocation like analyzeVideo does.
        execFileSync(PYTHON, [
          detectScript,
          "--video",
          doomed.video,
          "--out",
          doomed.out,
          "--start-ms",
          String(doomed.startMs),
          "--end-ms",
          String(doomed.endMs),
          "--stride",
          "3",
          "--floor",
          "0.08",
        ]);
        fallbackMs = Date.now() - d0;
      },
      log: () => {},
    });
    await new Promise((r) => setTimeout(r, 300));
    if (supervisor.pid) process.kill(supervisor.pid, "SIGKILL");
    const doomedPath = await inFlight;
    rmSync(doomed.out, { force: true });
    await new Promise((r) => setTimeout(r, 100));

    const recovered = shapeRequest(workDir, 820_000 + cycle);
    const r0 = Date.now();
    const recoveredPath = await detectPaddleWindow({
      worker: supervisor,
      request: recovered,
      oneShot: () => {},
      log: () => {},
    });
    const postRestartMs = Date.now() - r0;
    rmSync(recovered.out, { force: true });
    if (doomedPath !== "one_shot") crashFailures.push(`cycle ${cycle}: doomed path=${doomedPath}`);
    if (recoveredPath !== "worker")
      crashFailures.push(`cycle ${cycle}: post-restart path=${recoveredPath}`);
    progress(`crash cycle ${cycle}/${crashesN}`);
    crashCycles.push({
      cycle,
      steadyMs,
      fallbackWindowMs: fallbackMs,
      fallbackPath: doomedPath,
      postRestartMs,
      postRestartPath: recoveredPath,
    });
  }
  const restarts = supervisor.restarts;
  supervisor.dispose();
  report["crashRecovery"] = {
    cycles: crashCycles,
    restarts,
    failures: crashFailures,
    steadyMs: summarize(crashCycles.map((c) => c.steadyMs)),
    fallbackWindowMs: summarize(
      crashCycles.filter((c) => c.fallbackWindowMs >= 0).map((c) => c.fallbackWindowMs),
    ),
    postRestartMs: summarize(crashCycles.map((c) => c.postRestartMs)),
    note: "fallbackWindowMs = kill-tolerant window total incl. real one-shot; postRestartMs = first request after crash (includes supervisor respawn + model load)",
  };

  // ---- Cleanup ---------------------------------------------------------------
  await new Promise((r) => setTimeout(r, 500));
  const orphans = listServeProcesses();
  report["cleanup"] = { orphans, pass: orphans.length === 0 };
  rmSync(workDir, { recursive: true, force: true });

  report["finishedAt"] = new Date().toISOString();
  const reportPath = join(outRoot, `${label}-latency-dist-report.json`);
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  console.error(`latency-dist report written to ${reportPath}`);
  if (seqFailures.length > 0 || crashFailures.length > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof PaddleWorkerError ? error.message : error);
  process.exitCode = 1;
});
