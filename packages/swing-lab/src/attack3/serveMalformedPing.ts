/**
 * Attack pass 3 / S6 — detect_paddle.py --serve --no-warmup, driven from Node.
 *
 * Phase A (raw pipe, same shape the coordinator asked for): send
 * `{"type":"detect"}` (no id, no op, no video), then a ping, then a valid
 * detect. Expect one error object per bad line and a live worker.
 *
 * Phase B (through PaddleServeWorker, the production client): a detect whose
 * `video` is undefined is serialised without the key → the worker answers
 * ok=false → the client rejects with PaddleWorkerError and stays usable for the
 * next request. Also checks the client's documented blind spot: a reply whose
 * id is not a string is dropped (paddleWorker.ts:133) — here the raw
 * `{"type":"detect"}` line yields `"id": null`, which the client would ignore.
 *
 *   pnpm --filter @pickle/swing-lab exec tsx src/attack3/serveMalformedPing.ts [--out DIR]
 *
 * Exit 0 = HELD; non-zero = a listed expectation failed (see the JSON report).
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PaddleServeWorker, PaddleWorkerError, type PaddleDetectRequest } from "../paddleWorker.js";

const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../..");
const PYTHON = join(REPO_ROOT, "tools/paddle-lab/.venv/bin/python");
const DETECT_SCRIPT = join(REPO_ROOT, "tools/paddle-lab/detect_paddle.py");
const CLIP = join(REPO_ROOT, "datasets/paddle-bench/bundles/wm-volley-02/clip.mp4");

function argStr(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  if (index === -1 || index + 1 >= process.argv.length) return fallback;
  return process.argv[index + 1]!;
}

interface Check {
  name: string;
  pass: boolean;
  detail: unknown;
}

const checks: Check[] = [];
function check(name: string, pass: boolean, detail: unknown): void {
  checks.push({ name, pass, detail });
  process.stderr.write(`${pass ? "PASS" : "FAIL"} ${name}\n`);
}

function isAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function phaseRaw(outDir: string): Promise<void> {
  const child = spawn(PYTHON, [DETECT_SCRIPT, "--serve", "--no-warmup"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stderr: string[] = [];
  child.stderr!.on("data", (chunk: Buffer) => stderr.push(chunk.toString("utf8")));
  const lines: Record<string, unknown>[] = [];
  const waiters: ((line: Record<string, unknown>) => void)[] = [];
  createInterface({ input: child.stdout! }).on("line", (line) => {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    const waiter = waiters.shift();
    if (waiter) waiter(parsed);
    else lines.push(parsed);
  });
  const next = (timeoutMs: number): Promise<Record<string, unknown>> =>
    new Promise((resolveLine, reject) => {
      const queued = lines.shift();
      if (queued) return resolveLine(queued);
      const timer = setTimeout(
        () => reject(new Error(`no reply within ${timeoutMs}ms`)),
        timeoutMs,
      );
      waiters.push((line) => {
        clearTimeout(timer);
        resolveLine(line);
      });
    });
  const send = (line: string) => child.stdin!.write(`${line}\n`);

  const ready = await next(300_000);
  check("raw: ready event", ready["event"] === "ready", ready);

  send(JSON.stringify({ type: "detect" }));
  const err = await next(30_000);
  check(
    "raw: {type:detect} → error object with id=null, ok=false, KeyError 'video'",
    err["id"] === null && err["ok"] === false && err["error"] === "KeyError: 'video'",
    err,
  );
  check("raw: worker alive after malformed detect", isAlive(child.pid), child.pid);

  send(JSON.stringify({ id: "p1", op: "ping" }));
  const pong = await next(30_000);
  check("raw: ping → pong with echoed id", pong["event"] === "pong" && pong["id"] === "p1", pong);

  const out = join(outDir, "raw-valid.json");
  send(JSON.stringify({ id: "v1", op: "detect", video: CLIP, startMs: 5300, endMs: 5400, out }));
  const ok = await next(300_000);
  check(
    "raw: valid detect after the malformed one → ok=true and artifact written",
    ok["ok"] === true && ok["id"] === "v1" && existsSync(out),
    ok,
  );

  // interleave: 5 malformed + 5 pings sent without awaiting; replies must be in order
  const expected: string[] = [];
  for (let i = 0; i < 5; i += 1) {
    send(JSON.stringify({ id: `m${i}`, op: "detect" }));
    send(JSON.stringify({ id: `q${i}`, op: "ping" }));
    expected.push(`m${i}`, `q${i}`);
  }
  const got: string[] = [];
  for (let i = 0; i < 10; i += 1) got.push(String((await next(30_000))["id"]));
  check(
    "raw: 10 un-awaited mixed bad/ping replies in send order",
    JSON.stringify(got) === JSON.stringify(expected),
    {
      expected,
      got,
    },
  );

  send(JSON.stringify({ id: "bye", op: "shutdown" }));
  const bye = await next(30_000);
  const exitCode = await new Promise<number | null>((r) => child.on("exit", (code) => r(code)));
  check("raw: shutdown → event + exit 0", bye["event"] === "shutdown" && exitCode === 0, {
    bye,
    exitCode,
  });
  writeFileSync(join(outDir, "raw-worker-stderr.txt"), stderr.join(""));
}

async function phaseClient(outDir: string): Promise<void> {
  const worker = new PaddleServeWorker(PYTHON, [DETECT_SCRIPT, "--serve", "--no-warmup"], {
    log: () => {},
  });
  await worker.ready();
  const bad = {
    out: join(outDir, "client-bad.json"),
    startMs: 5300,
    endMs: 5400,
  } as unknown as PaddleDetectRequest;
  let rejection: unknown = null;
  try {
    await worker.detect(bad);
  } catch (error) {
    rejection = error;
  }
  check(
    "client: detect without video rejects with PaddleWorkerError carrying the worker's error",
    rejection instanceof PaddleWorkerError && rejection.message.includes("KeyError: 'video'"),
    rejection instanceof Error ? rejection.message : rejection,
  );
  check(
    "client: worker alive after rejected request",
    worker.alive && isAlive(worker.pid),
    worker.pid,
  );

  const good: PaddleDetectRequest = {
    video: CLIP,
    out: join(outDir, "client-good.json"),
    startMs: 5300,
    endMs: 5400,
  };
  const response = await worker.detect(good);
  check(
    "client: next request succeeds on the same worker",
    response.ok === true && existsSync(good.out),
    response,
  );

  // three in flight at once (client assigns r2,r3,r4) — all resolve, none cross-wired
  const trio = await Promise.all([
    worker.detect({ ...good, out: join(outDir, "c1.json"), startMs: 5300, endMs: 5400 }),
    worker.detect({ ...good, out: join(outDir, "c2.json"), startMs: 5400, endMs: 5500 }),
    worker.detect({ ...good, out: join(outDir, "c3.json"), startMs: 5500, endMs: 5600 }),
  ]);
  check(
    "client: 3 concurrent detects resolve to their own out paths",
    trio.every((r, i) => r.ok && r.out === join(outDir, `c${i + 1}.json`)),
    trio.map((r) => [r.id, r.out]),
  );
  worker.dispose();
}

async function main(): Promise<void> {
  const outDir = argStr("--out", join(REPO_ROOT, "artifacts/attack3/s6-node"));
  mkdirSync(outDir, { recursive: true });
  if (!existsSync(PYTHON)) {
    process.stderr.write(`venv python missing at ${PYTHON}; refusing to report a pass\n`);
    process.exitCode = 2;
    return;
  }
  await phaseRaw(outDir);
  await phaseClient(outDir);
  const report = { commit: process.env["ATTACK3_COMMIT"] ?? null, checks };
  writeFileSync(join(outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (checks.some((c) => !c.pass)) process.exitCode = 1;
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
