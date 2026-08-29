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

export interface PaddleDetectRequest {
  video: string;
  out: string;
  startMs: number;
  endMs: number;
  stride?: number;
  floor?: number;
}

export interface PaddleReadyEvent {
  event: "ready";
  protocol: string;
  modelLoadSec: number;
  warmupSec: number;
  device: string;
}

export interface PaddleDetectResponse {
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

export interface PaddleServeWorkerOptions {
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
        waiter.reject(new PaddleWorkerError(`worker responded ok=false: ${String(message["error"])}`));
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
    this.child.stdin!.write(`${JSON.stringify({ id, ...request })}\n`);
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

/** Spawn the warm detector worker if the paddle-lab environment exists;
 * returns null (caller uses the one-shot path) when it does not. */
export function startPaddleWorker(
  python: string,
  script: string,
  options: PaddleServeWorkerOptions = {},
): PaddleServeWorker | null {
  if (!existsSync(python) || !existsSync(script)) return null;
  return new PaddleServeWorker(python, [script, "--serve"], options);
}

/** One detect window: try the warm worker, fall back to the legacy one-shot
 * path on ANY worker failure. Returns which path produced the artifact. */
export async function detectPaddleWindow(input: {
  worker: PaddleServeWorker | null;
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
