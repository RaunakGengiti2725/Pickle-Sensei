/**
 * Warm paddle-worker soak harness (Wave E / e18-warm-worker-soak).
 *
 * Stress-tests the PaddleServeWorker / PaddleWorkerSupervisor lifecycle at
 * scale: hundreds of sequential and concurrent requests, crash/restart
 * recovery, memory growth (worker + client RSS over time), fallback
 * correctness, and cleanup (no orphan processes after dispose).
 *
 * Two backends:
 *   --mode fake   protocol-level soak against a stub worker speaking
 *                 paddle-serve-v1 (no python/model) — exercises the TS
 *                 client lifecycle at high request counts cheaply.
 *   --mode real   the actual tools/paddle-lab/detect_paddle.py --serve
 *                 worker over committed dev bundle clips (wm-volley-02,
 *                 afn-sasebo-rally1 ONLY — held-out clips are never used).
 *   --mode both   (default) fake first, then real if the venv exists.
 *
 * Usage:
 *   pnpm --filter @pickle/swing-lab worker:soak -- [--mode both]
 *     [--seq N] [--conc-batch N] [--conc-rounds N] [--real-seq N]
 *     [--out datasets/experiments/wave-e/e18-soak-artifacts]
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PaddleServeWorker,
  PaddleWorkerError,
  PaddleWorkerSupervisor,
  detectPaddleWindow,
  type PaddleDetectRequest,
} from "./paddleWorker.js";

const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
const PYTHON = join(REPO_ROOT, "tools/paddle-lab/.venv/bin/python");
const DETECT_SCRIPT = join(REPO_ROOT, "tools/paddle-lab/detect_paddle.py");
// Committed dev bundles only. wm-dink-01 and afn-vic-rally1 are held out and
// MUST NOT appear here.
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

interface RssSample {
  request: number;
  atMs: number;
  workerRssKb: number | null;
  clientRssKb: number;
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

function clientRssKb(): number {
  return Math.round(process.memoryUsage.rss() / 1024);
}

function listServeProcesses(marker: string): number[] {
  try {
    const out = execFileSync("pgrep", ["-f", marker], { encoding: "utf8" });
    return out
      .split("\n")
      .filter(Boolean)
      .map(Number)
      .filter((pid) => pid !== process.pid);
  } catch {
    return []; // pgrep exits 1 when nothing matches
  }
}

/** Least-squares slope of RSS (kB) per request — the leak-curve headline. */
function slopeKbPerRequest(
  samples: RssSample[],
  key: "workerRssKb" | "clientRssKb",
): number | null {
  const points = samples
    .map((sample) => ({ x: sample.request, y: sample[key] }))
    .filter((point): point is { x: number; y: number } => typeof point.y === "number");
  if (points.length < 2) return null;
  const n = points.length;
  const meanX = points.reduce((acc, point) => acc + point.x, 0) / n;
  const meanY = points.reduce((acc, point) => acc + point.y, 0) / n;
  let num = 0;
  let den = 0;
  for (const point of points) {
    num += (point.x - meanX) * (point.y - meanY);
    den += (point.x - meanX) * (point.x - meanX);
  }
  return den === 0 ? null : num / den;
}

function summarizeRss(samples: RssSample[], key: "workerRssKb" | "clientRssKb") {
  const values = samples
    .map((sample) => sample[key])
    .filter((value): value is number => typeof value === "number");
  if (values.length === 0) return null;
  return {
    samples: values.length,
    firstKb: values[0],
    lastKb: values[values.length - 1],
    minKb: Math.min(...values),
    maxKb: Math.max(...values),
    slopeKbPerRequest: slopeKbPerRequest(samples, key),
  };
}

const FAKE_MARKER = "paddle-soak-fake-worker";

function writeFakeWorker(dir: string, mode: string): string {
  const path = join(dir, `${FAKE_MARKER}-${mode}.mjs`);
  writeFileSync(
    path,
    `
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
const mode = ${JSON.stringify(mode)};
const say = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
say({ event: "ready", protocol: "paddle-serve-v1", modelLoadSec: 0, warmupSec: 0, device: "soak-fake" });
let requests = 0;
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const req = JSON.parse(line);
  requests += 1;
  if (mode === "crash-every-50" && requests % 50 === 0) process.exit(3);
  if (mode === "error-every-25" && requests % 25 === 0) {
    say({ id: req.id, ok: false, error: "soak-injected error" });
    return;
  }
  writeFileSync(req.out, JSON.stringify({ frames: [], echo: { id: req.id, startMs: req.startMs } }));
  say({ id: req.id, ok: true, out: req.out, framesProcessed: 0, paddleDetections: 0, extras: 0, timing: {}, requestWallSec: 0 });
});
lines.on("close", () => process.exit(0));
`,
  );
  return path;
}

interface PhaseResult {
  phase: string;
  requests: number;
  okCount: number;
  workerFailures: number;
  fallbacks: number;
  restarts?: number;
  wallMs: number;
  rss: {
    worker: ReturnType<typeof summarizeRss>;
    client: ReturnType<typeof summarizeRss>;
  };
  failures: { request: number; error: string }[];
  notes?: string[];
}

function fakeRequest(dir: string, i: number): PaddleDetectRequest {
  return {
    video: "soak.mp4",
    out: join(dir, `soak-${i}.json`),
    startMs: i * 10,
    endMs: i * 10 + 100,
  };
}

async function runFakeSequential(
  dir: string,
  total: number,
  sampleEvery: number,
): Promise<PhaseResult> {
  const worker = new PaddleServeWorker(process.execPath, [writeFakeWorker(dir, "steady")], {
    log: () => {},
  });
  const samples: RssSample[] = [];
  const failures: { request: number; error: string }[] = [];
  const started = Date.now();
  let okCount = 0;
  await worker.ready();
  for (let i = 1; i <= total; i += 1) {
    try {
      const response = await worker.detect(fakeRequest(dir, i));
      if (response.ok) okCount += 1;
    } catch (error) {
      failures.push({ request: i, error: error instanceof Error ? error.message : String(error) });
    }
    if (i % sampleEvery === 0 || i === total) {
      samples.push({
        request: i,
        atMs: Date.now() - started,
        workerRssKb: readRssKb(worker.pid),
        clientRssKb: clientRssKb(),
      });
    }
  }
  worker.dispose();
  return {
    phase: "fake-sequential",
    requests: total,
    okCount,
    workerFailures: failures.length,
    fallbacks: 0,
    wallMs: Date.now() - started,
    rss: {
      worker: summarizeRss(samples, "workerRssKb"),
      client: summarizeRss(samples, "clientRssKb"),
    },
    failures: failures.slice(0, 10),
  };
}

async function runFakeConcurrent(dir: string, batch: number, rounds: number): Promise<PhaseResult> {
  const worker = new PaddleServeWorker(process.execPath, [writeFakeWorker(dir, "steady")], {
    log: () => {},
  });
  const samples: RssSample[] = [];
  const failures: { request: number; error: string }[] = [];
  const started = Date.now();
  let okCount = 0;
  let issued = 0;
  await worker.ready();
  for (let round = 1; round <= rounds; round += 1) {
    const requests = Array.from({ length: batch }, () => {
      issued += 1;
      const id = issued;
      return worker
        .detect(fakeRequest(dir, 100_000 + id))
        .then((response) => {
          if (response.ok) okCount += 1;
          const echo = JSON.parse(readFileSync(response.out, "utf8")) as {
            echo: { startMs: number };
          };
          if (echo.echo.startMs !== (100_000 + id) * 10) {
            failures.push({ request: id, error: `response/artifact mismatch for request ${id}` });
          }
        })
        .catch((error: unknown) => {
          failures.push({
            request: id,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    });
    await Promise.all(requests);
    samples.push({
      request: issued,
      atMs: Date.now() - started,
      workerRssKb: readRssKb(worker.pid),
      clientRssKb: clientRssKb(),
    });
  }
  worker.dispose();
  return {
    phase: "fake-concurrent",
    requests: issued,
    okCount,
    workerFailures: failures.length,
    fallbacks: 0,
    wallMs: Date.now() - started,
    rss: {
      worker: summarizeRss(samples, "workerRssKb"),
      client: summarizeRss(samples, "clientRssKb"),
    },
    failures: failures.slice(0, 10),
  };
}

async function runFakeCrashRestart(dir: string, total: number): Promise<PhaseResult> {
  let spawns = 0;
  const supervisor = new PaddleWorkerSupervisor(
    () => {
      spawns += 1;
      return new PaddleServeWorker(process.execPath, [writeFakeWorker(dir, "crash-every-50")], {
        log: () => {},
      });
    },
    { maxRestarts: 1000 },
  );
  const failures: { request: number; error: string }[] = [];
  const started = Date.now();
  let okCount = 0;
  let fallbacks = 0;
  for (let i = 1; i <= total; i += 1) {
    let usedOneShot = false;
    const path = await detectPaddleWindow({
      worker: supervisor,
      request: fakeRequest(dir, 200_000 + i),
      oneShot: () => {
        usedOneShot = true;
      },
      log: () => {},
    });
    if (path === "worker") okCount += 1;
    if (path === "one_shot") {
      fallbacks += 1;
      if (!usedOneShot)
        failures.push({ request: i, error: "one_shot path did not invoke oneShot" });
    }
    if (path === "one_shot" && existsSync(join(dir, `soak-${200_000 + i}.json`))) {
      failures.push({ request: i, error: "fallback window left a partial worker artifact" });
    }
    // Let the exit event propagate before the next detect so the supervisor
    // observes the crash (same wait the unit tests use).
    if (path === "one_shot") await new Promise((r) => setTimeout(r, 30));
  }
  const restarts = supervisor.restarts;
  supervisor.dispose();
  return {
    phase: "fake-crash-restart",
    requests: total,
    okCount,
    workerFailures: fallbacks,
    fallbacks,
    restarts,
    wallMs: Date.now() - started,
    rss: { worker: null as never, client: null as never },
    failures: failures.slice(0, 10),
    notes: [
      `spawns=${spawns}`,
      `every 50th request crashes the worker; each crashed window must fall back exactly once and the next window must ride a restarted worker`,
    ],
  };
}

async function runFakeErrorFallback(dir: string, total: number): Promise<PhaseResult> {
  const worker = new PaddleServeWorker(process.execPath, [writeFakeWorker(dir, "error-every-25")], {
    log: () => {},
  });
  const failures: { request: number; error: string }[] = [];
  const started = Date.now();
  let okCount = 0;
  let fallbacks = 0;
  for (let i = 1; i <= total; i += 1) {
    let oneShotCalls = 0;
    const path = await detectPaddleWindow({
      worker,
      request: fakeRequest(dir, 300_000 + i),
      oneShot: () => {
        oneShotCalls += 1;
      },
      log: () => {},
    });
    if (path === "worker") {
      okCount += 1;
      if (oneShotCalls !== 0)
        failures.push({ request: i, error: "worker path also invoked one-shot" });
    } else {
      fallbacks += 1;
      if (oneShotCalls !== 1)
        failures.push({ request: i, error: `one_shot path invoked oneShot ${oneShotCalls} times` });
      if (i % 25 !== 0)
        failures.push({ request: i, error: "fallback on a request that should have succeeded" });
    }
  }
  worker.dispose();
  return {
    phase: "fake-error-fallback",
    requests: total,
    okCount,
    workerFailures: fallbacks,
    fallbacks,
    wallMs: Date.now() - started,
    rss: { worker: null as never, client: null as never },
    failures: failures.slice(0, 10),
    notes: ["every 25th request answers ok=false; the worker must keep serving after each"],
  };
}

async function verifyCleanup(marker: string): Promise<{ orphans: number[]; pass: boolean }> {
  await new Promise((r) => setTimeout(r, 500));
  const orphans = listServeProcesses(marker);
  return { orphans, pass: orphans.length === 0 };
}

interface RealPhaseOptions {
  seq: number;
  concBatch: number;
  concRounds: number;
  sampleEvery: number;
  outDir: string;
}

function realRequest(outDir: string, i: number): PaddleDetectRequest {
  const clip = CLIPS[i % CLIPS.length]!;
  const window = clip.windows[Math.floor(i / CLIPS.length) % clip.windows.length]!;
  return {
    video: clip.video,
    out: join(outDir, `real-${i}.json`),
    startMs: window.startMs,
    endMs: window.endMs,
    stride: 3,
    floor: 0.08,
  };
}

/** Timing-stripped detection payload — the equality contract from C07/D09. */
function framesPayload(path: string): string {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  delete parsed["timing"];
  return JSON.stringify(parsed);
}

async function runRealSequential(options: RealPhaseOptions): Promise<PhaseResult> {
  const worker = new PaddleServeWorker(PYTHON, [DETECT_SCRIPT, "--serve"], { log: () => {} });
  const samples: RssSample[] = [];
  const failures: { request: number; error: string }[] = [];
  const started = Date.now();
  let okCount = 0;
  const ready = await worker.ready();
  const referenceByShape = new Map<string, string>();
  for (let i = 1; i <= options.seq; i += 1) {
    const request = realRequest(options.outDir, i);
    try {
      const response = await worker.detect(request);
      if (response.ok) okCount += 1;
      const shape = `${request.video}:${request.startMs}-${request.endMs}`;
      const payload = framesPayload(request.out);
      const reference = referenceByShape.get(shape);
      if (reference === undefined) {
        referenceByShape.set(shape, payload);
      } else if (reference !== payload) {
        failures.push({ request: i, error: `detection payload drift on repeat of ${shape}` });
      }
      rmSync(request.out, { force: true });
    } catch (error) {
      failures.push({ request: i, error: error instanceof Error ? error.message : String(error) });
    }
    if (i % options.sampleEvery === 0 || i === options.seq || i === 1) {
      samples.push({
        request: i,
        atMs: Date.now() - started,
        workerRssKb: readRssKb(worker.pid),
        clientRssKb: clientRssKb(),
      });
    }
  }
  worker.dispose();
  return {
    phase: "real-sequential",
    requests: options.seq,
    okCount,
    workerFailures: failures.length,
    fallbacks: 0,
    wallMs: Date.now() - started,
    rss: {
      worker: summarizeRss(samples, "workerRssKb"),
      client: summarizeRss(samples, "clientRssKb"),
    },
    failures: failures.slice(0, 10),
    notes: [
      `ready: modelLoadSec=${ready.modelLoadSec} warmupSec=${ready.warmupSec} device=${ready.device}`,
      "repeat requests of the same shape are byte-compared (timing-stripped) against the first response",
      `rssSamples=${JSON.stringify(samples)}`,
    ],
  };
}

async function runRealConcurrent(options: RealPhaseOptions): Promise<PhaseResult> {
  const worker = new PaddleServeWorker(PYTHON, [DETECT_SCRIPT, "--serve"], { log: () => {} });
  const samples: RssSample[] = [];
  const failures: { request: number; error: string }[] = [];
  const started = Date.now();
  let okCount = 0;
  let issued = 0;
  await worker.ready();
  for (let round = 1; round <= options.concRounds; round += 1) {
    const batch = Array.from({ length: options.concBatch }, () => {
      issued += 1;
      const id = issued;
      const request = realRequest(options.outDir, 500_000 + id);
      return worker
        .detect(request)
        .then(() => {
          okCount += 1;
          rmSync(request.out, { force: true });
        })
        .catch((error: unknown) => {
          failures.push({
            request: id,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    });
    await Promise.all(batch);
    samples.push({
      request: issued,
      atMs: Date.now() - started,
      workerRssKb: readRssKb(worker.pid),
      clientRssKb: clientRssKb(),
    });
  }
  worker.dispose();
  return {
    phase: "real-concurrent",
    requests: issued,
    okCount,
    workerFailures: failures.length,
    fallbacks: 0,
    wallMs: Date.now() - started,
    rss: {
      worker: summarizeRss(samples, "workerRssKb"),
      client: summarizeRss(samples, "clientRssKb"),
    },
    failures: failures.slice(0, 10),
    notes: [`rssSamples=${JSON.stringify(samples)}`],
  };
}

async function runRealCrashRestart(options: RealPhaseOptions): Promise<PhaseResult> {
  let spawns = 0;
  const supervisor = new PaddleWorkerSupervisor(
    () => {
      spawns += 1;
      return new PaddleServeWorker(PYTHON, [DETECT_SCRIPT, "--serve"], { log: () => {} });
    },
    { maxRestarts: 3 },
  );
  const failures: { request: number; error: string }[] = [];
  const notes: string[] = [];
  const started = Date.now();
  await supervisor.ready();
  const firstPid = supervisor.pid;
  // Baseline request.
  const baseline = realRequest(options.outDir, 600_001);
  await supervisor.detect(baseline);
  const reference = framesPayload(baseline.out);
  rmSync(baseline.out, { force: true });
  // Kill the worker mid-flight; the in-flight window must fall back, and the
  // NEXT window must ride a restarted worker with identical output.
  const doomed = realRequest(options.outDir, 600_002);
  doomed.startMs = baseline.startMs;
  doomed.endMs = baseline.endMs;
  doomed.video = baseline.video;
  let fallbacks = 0;
  const inFlight = detectPaddleWindow({
    worker: supervisor,
    request: doomed,
    oneShot: () => {
      fallbacks += 1;
    },
    log: () => {},
  });
  await new Promise((r) => setTimeout(r, 300));
  if (supervisor.pid) process.kill(supervisor.pid, "SIGKILL");
  const doomedPath = await inFlight;
  if (doomedPath !== "one_shot" || fallbacks !== 1) {
    failures.push({
      request: 2,
      error: `killed mid-flight window: path=${doomedPath} fallbacks=${fallbacks}`,
    });
  }
  await new Promise((r) => setTimeout(r, 100));
  const recovered = realRequest(options.outDir, 600_003);
  recovered.startMs = baseline.startMs;
  recovered.endMs = baseline.endMs;
  recovered.video = baseline.video;
  const path = await detectPaddleWindow({
    worker: supervisor,
    request: recovered,
    oneShot: () => {
      failures.push({ request: 3, error: "post-restart window fell back to one-shot" });
    },
    log: () => {},
  });
  const secondPid = supervisor.pid;
  if (path === "worker") {
    const payload = framesPayload(recovered.out);
    if (payload !== reference)
      failures.push({ request: 3, error: "post-restart payload differs from baseline" });
    rmSync(recovered.out, { force: true });
  }
  notes.push(
    `spawns=${spawns} restarts=${supervisor.restarts} firstPid=${String(firstPid)} secondPid=${String(secondPid)}`,
  );
  supervisor.dispose();
  return {
    phase: "real-crash-restart",
    requests: 3,
    okCount: failures.length === 0 ? 2 : 2 - failures.length,
    workerFailures: failures.length,
    fallbacks,
    restarts: 1,
    wallMs: Date.now() - started,
    rss: { worker: null as never, client: null as never },
    failures,
    notes,
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

async function main(): Promise<void> {
  const mode = argStr("--mode", "both");
  const outRoot = argStr("--out", join(tmpdir(), `paddle-soak-${Date.now()}`));
  mkdirSync(outRoot, { recursive: true });
  const report: Record<string, unknown> = {
    startedAt: new Date().toISOString(),
    mode,
    node: process.version,
    commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim(),
  };
  const phases: PhaseResult[] = [];

  if (mode === "fake" || mode === "both") {
    const fakeDir = join(outRoot, "fake");
    mkdirSync(fakeDir, { recursive: true });
    phases.push(await runFakeSequential(fakeDir, arg("--seq", 500), 10));
    phases.push(
      await runFakeConcurrent(fakeDir, arg("--conc-batch", 16), arg("--conc-rounds", 25)),
    );
    phases.push(await runFakeCrashRestart(fakeDir, arg("--crash-seq", 200)));
    phases.push(await runFakeErrorFallback(fakeDir, arg("--error-seq", 200)));
    report["fakeCleanup"] = await verifyCleanup(FAKE_MARKER);
    rmSync(fakeDir, { recursive: true, force: true });
  }

  if (mode === "real" || mode === "both") {
    if (!existsSync(PYTHON) || !existsSync(DETECT_SCRIPT)) {
      report["real"] = "SKIPPED: paddle-lab venv or detect_paddle.py absent";
    } else {
      const realDir = join(outRoot, "real");
      mkdirSync(realDir, { recursive: true });
      const options: RealPhaseOptions = {
        seq: arg("--real-seq", 200),
        concBatch: arg("--real-conc-batch", 4),
        concRounds: arg("--real-conc-rounds", 10),
        sampleEvery: 5,
        outDir: realDir,
      };
      phases.push(await runRealSequential(options));
      phases.push(await runRealConcurrent(options));
      phases.push(await runRealCrashRestart(options));
      report["realCleanup"] = await verifyCleanup("detect_paddle.py --serve");
      rmSync(realDir, { recursive: true, force: true });
    }
  }

  report["phases"] = phases;
  report["finishedAt"] = new Date().toISOString();
  const reportPath = join(outRoot, "soak-report.json");
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  console.error(`soak report written to ${reportPath}`);
  if (phases.some((phase) => phase.failures.length > 0)) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof PaddleWorkerError ? error.message : error);
  process.exitCode = 1;
});
