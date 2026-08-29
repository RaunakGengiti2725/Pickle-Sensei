import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";

/**
 * Warm paddle-detector worker client — speaks `paddle-serve-v1` (JSON Lines
 * over stdio) to `tools/paddle-lab/detect_paddle.py --serve`. The model loads
 * ONCE at worker startup instead of once per detect invocation; each detect
 * request writes the same paddle-dets.json artifact as the one-shot path
 * (verified bit-equal on the frames payload; see W2-worker-integration.md).
 *
 * Ops semantics (per the W2 sketch): serial requests, the parent owns the
 * lifecycle — worker lifetime is tied to this process (stdin EOF or a
 * `shutdown` op ends it; dispose() force-kills as a last resort so no orphan
 * process outlives the run). Any failure (spawn error, crash, timeout,
 * non-ok response) surfaces as a rejected promise so the caller can fall
 * back to the legacy one-shot path.
 */

interface PaddleDetectRequest {
  video: string;
  out: string;
  startMs: number;
  endMs: number;
  stride?: number;
  floor?: number;
  /** Normalized x0,y0,x1,y1 crop for this window (detect_paddle.py --roi). */
  roi?: [number, number, number, number] | null;
}

interface PaddleReadyEvent {
  event: "ready";
  protocol: string;
  modelLoadSec: number;
  warmupSec: number;
  device: string;
}

interface PaddleDetectResponse {
  id: string;
  ok: true;
  out: string;
  framesProcessed: number;
  paddleDetections: number;
  extras: number;
  timing: Record<string, unknown>;
  requestWallSec: number;
}

export class PaddleWorkerError extends Error {}

interface Pending {
  resolve: (response: PaddleDetectResponse) => void;
  reject: (error: PaddleWorkerError) => void;
  timer: NodeJS.Timeout | null;
}

interface PaddleServeWorkerOptions {
  readyTimeoutMs?: number;
  requestTimeoutMs?: number;
  log?: (message: string) => void;
}

const DEFAULT_READY_TIMEOUT_MS = 180_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 1_800_000;

export class PaddleServeWorker {
  private readonly child: ChildProcess;
  private readonly pending = new Map<string, Pending>();
  private readonly readyPromise: Promise<PaddleReadyEvent>;
  private readonly requestTimeoutMs: number;
  private readonly log: (message: string) => void;
  private exitError: PaddleWorkerError | null = null;
  private exited = false;
  private disposed = false;
  private nextId = 0;

  constructor(command: string, args: string[], options: PaddleServeWorkerOptions = {}) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.log = options.log ?? ((message) => console.error(message));
    this.child = spawn(command, args, { stdio: ["pipe", "pipe", "inherit"] });
    // A request written while the worker is dying can surface EPIPE on the
    // stdin stream; without a listener that is an uncaught exception that
    // takes down the whole analyze run. A worker whose stdin is broken can
    // never serve again, so it is killed — the exit handler then rejects
    // every pending request (fallback path).
    this.child.stdin!.on("error", (error) => {
      this.log(`paddle worker stdin error: ${error.message}`);
      this.kill();
    });

    let readyResolve: (event: PaddleReadyEvent) => void = () => {};
    let readyReject: (error: PaddleWorkerError) => void = () => {};
    let readySettled = false;
    this.readyPromise = new Promise<PaddleReadyEvent>((resolve, reject) => {
      readyResolve = (event) => {
        readySettled = true;
        resolve(event);
      };
      readyReject = (error) => {
        readySettled = true;
        reject(error);
      };
    });
    // The rejection is delivered to awaiting callers in detect(); an
    // unobserved readyPromise must not crash the process.
    this.readyPromise.catch(() => {});
    const readyTimer = setTimeout(() => {
      if (!readySettled) {
        readyReject(new PaddleWorkerError("worker did not report ready in time"));
        this.kill();
      }
    }, options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS);
    readyTimer.unref();

    const lines = createInterface({ input: this.child.stdout! });
    lines.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        this.log(`paddle worker: ignoring non-protocol stdout line: ${trimmed.slice(0, 200)}`);
        return;
      }
      if (message["event"] === "ready") {
        clearTimeout(readyTimer);
        readyResolve(message as unknown as PaddleReadyEvent);
        return;
      }
      const id = message["id"];
      if (typeof id !== "string") return;
      const waiter = this.pending.get(id);
      if (!waiter) return;
      this.pending.delete(id);
      if (waiter.timer) clearTimeout(waiter.timer);
      if (message["ok"] === true) {
        waiter.resolve(message as unknown as PaddleDetectResponse);
      } else {
        waiter.reject(
          new PaddleWorkerError(`worker responded ok=false: ${String(message["error"])}`),
        );
      }
    });

    const fail = (reason: string) => {
      this.exited = true;
      this.exitError = new PaddleWorkerError(reason);
      if (!readySettled) {
        clearTimeout(readyTimer);
        readyReject(this.exitError);
      }
      for (const [id, waiter] of this.pending) {
        this.pending.delete(id);
        if (waiter.timer) clearTimeout(waiter.timer);
        waiter.reject(this.exitError);
      }
    };
    this.child.on("error", (error) => fail(`worker spawn failed: ${error.message}`));
    this.child.on("exit", (code, signal) =>
      fail(`worker exited (code=${String(code)}, signal=${String(signal)})`),
    );
  }

  get alive(): boolean {
    return !this.exited;
  }

  /** Resolves once the worker has loaded the model and reported ready. */
  ready(): Promise<PaddleReadyEvent> {
    return this.readyPromise;
  }

  async detect(request: PaddleDetectRequest): Promise<PaddleDetectResponse> {
    if (this.exited) {
      throw this.exitError ?? new PaddleWorkerError("worker is not running");
    }
    await this.readyPromise;
    if (this.exited) {
      throw this.exitError ?? new PaddleWorkerError("worker is not running");
    }
    const id = `r${++this.nextId}`;
    const response = new Promise<PaddleDetectResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new PaddleWorkerError(`detect request timed out after ${this.requestTimeoutMs}ms`));
        this.kill();
      }, this.requestTimeoutMs);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
    });
    try {
      if (this.child.stdin!.destroyed || !this.child.stdin!.writable) {
        throw new PaddleWorkerError("worker stdin is not writable");
      }
      this.child.stdin!.write(`${JSON.stringify({ id, ...request })}\n`);
    } catch (error) {
      const waiter = this.pending.get(id);
      if (waiter) {
        this.pending.delete(id);
        if (waiter.timer) clearTimeout(waiter.timer);
        waiter.reject(
          error instanceof PaddleWorkerError
            ? error
            : new PaddleWorkerError(
                `worker stdin write failed: ${error instanceof Error ? error.message : String(error)}`,
              ),
        );
      }
    }
    return response;
  }

  /** Graceful shutdown: close stdin (worker exits on EOF), then force-kill
   * if it lingers. Safe to call multiple times. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.exited) return;
    try {
      this.child.stdin!.end();
    } catch {
      // stdin already gone — force-kill below covers it.
    }
    const killer = setTimeout(() => this.kill(), 3_000);
    killer.unref();
    this.child.once("exit", () => clearTimeout(killer));
  }

  private kill(): void {
    if (!this.exited) this.child.kill("SIGKILL");
  }
}

interface PaddleWorkerSupervisorOptions extends PaddleServeWorkerOptions {
  /** Crash-restart budget for the whole run. A worker that keeps dying is an
   * environment problem; after this many respawns every remaining window
   * uses the one-shot fallback. */
  maxRestarts?: number;
}

const DEFAULT_MAX_RESTARTS = 2;

/**
 * Restart supervision over PaddleServeWorker. A crashed worker previously
 * degraded EVERY subsequent detect window to the one-shot path (each paying
 * the full python import + model load again — N times under two-pass); the
 * supervisor respawns a fresh worker on the next request instead, within a
 * bounded restart budget. The failed request itself still rejects (its
 * window falls back to one-shot — never a partial worker artifact); only
 * SUBSEQUENT requests ride the restarted worker.
 */
export class PaddleWorkerSupervisor {
  private worker: PaddleServeWorker;
  private restartsUsed = 0;
  private readonly maxRestarts: number;
  private disposed = false;

  constructor(
    private readonly spawnWorker: () => PaddleServeWorker,
    options: { maxRestarts?: number } = {},
  ) {
    this.maxRestarts = options.maxRestarts ?? DEFAULT_MAX_RESTARTS;
    this.worker = spawnWorker();
  }

  get alive(): boolean {
    return this.worker.alive;
  }

  get restarts(): number {
    return this.restartsUsed;
  }

  ready(): Promise<PaddleReadyEvent> {
    return this.worker.ready();
  }

  async detect(request: PaddleDetectRequest): Promise<PaddleDetectResponse> {
    if (this.disposed) throw new PaddleWorkerError("worker supervisor is disposed");
    if (!this.worker.alive) {
      if (this.restartsUsed >= this.maxRestarts) {
        throw new PaddleWorkerError(
          `worker crashed and restart budget (${this.maxRestarts}) is exhausted`,
        );
      }
      this.restartsUsed += 1;
      this.worker = this.spawnWorker();
    }
    return this.worker.detect(request);
  }

  dispose(): void {
    this.disposed = true;
    this.worker.dispose();
  }
}

/** Spawn the warm detector worker (with crash-restart supervision) if the
 * paddle-lab environment exists; returns null (caller uses the one-shot
 * path) when it does not. */
export function startPaddleWorker(
  python: string,
  script: string,
  options: PaddleWorkerSupervisorOptions = {},
): PaddleWorkerSupervisor | null {
  if (!existsSync(python) || !existsSync(script)) return null;
  const { maxRestarts, ...workerOptions } = options;
  return new PaddleWorkerSupervisor(
    () => new PaddleServeWorker(python, [script, "--serve"], workerOptions),
    maxRestarts === undefined ? {} : { maxRestarts },
  );
}

/** The detect surface detectPaddleWindow needs — a raw worker or the
 * restart-supervised handle. */
interface PaddleDetectHandle {
  detect(request: PaddleDetectRequest): Promise<PaddleDetectResponse>;
}

/** One detect window: try the warm worker, fall back to the legacy one-shot
 * path on ANY worker failure. Returns which path produced the artifact. */
export async function detectPaddleWindow(input: {
  worker: PaddleDetectHandle | null;
  request: PaddleDetectRequest;
  oneShot: () => void;
  log?: (message: string) => void;
}): Promise<"worker" | "one_shot"> {
  // eslint-disable-next-line no-console
  const log = input.log ?? ((message) => console.log(message));
  if (input.worker) {
    try {
      await input.worker.detect(input.request);
      return "worker";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`paddle worker failed (${message}); falling back to one-shot detector`);
    }
  }
  input.oneShot();
  return "one_shot";
}
