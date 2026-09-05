import { spawn, type ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";

/**
 * ADJ-04 neighbourhood: services/api got a `pool.on("error")` listener, but
 * src/main.ts here builds the same `new pg.Pool(...)` with none. Between two
 * poll cycles (WORKER_INTERVAL_MS) every pooled connection is idle, so a
 * PostgreSQL restart / failover / idle timeout / `pg_terminate_backend`
 * surfaces as an unhandled 'error' event and the worker exits 1 — the
 * `try/catch` around runOnce never sees it.
 *
 * Expected: the worker logs the error and keeps polling (its own comment says
 * "A transient failure (DB outage ...) must not crash the worker process").
 *
 * Runs the real src/main.ts in a child process (In-memory queue, no S3) so
 * the crash is a non-zero exit, not a vitest crash. Skipped (visibly) without
 * DATABASE_URL_TEST.
 */
const testUrl = process.env["DATABASE_URL_TEST"];
const describeIf = testUrl ? describe : describe.skip;

const workerRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const mainPath = join(workerRoot, "src", "main.ts");

let child: ChildProcess | null = null;
afterEach(() => {
  if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  child = null;
});

function waitFor(pred: () => boolean, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      if (pred()) return resolve(true);
      if (Date.now() - started > timeoutMs) return resolve(false);
      setTimeout(tick, 50);
    };
    tick();
  });
}

describeIf("media-worker pg.Pool idle-client termination", () => {
  it("survives pg_terminate_backend of its idle pooled connection between polls", async () => {
    const appName = `media-worker-idle-terminate-${process.pid}`;
    const url = new URL(testUrl!);
    url.searchParams.set("application_name", appName);

    let stderr = "";
    let polls = 0;
    child = spawn(process.execPath, ["--import", "tsx", mainPath], {
      cwd: workerRoot,
      env: {
        ...process.env,
        DATABASE_URL: url.toString(),
        DATABASE_URL_WORKER: url.toString(),
        WORKER_INTERVAL_MS: "10000",
        SQS_QUEUE_URL: "",
        S3_MEDIA_BUCKET: "",
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    const proc = child;
    const exit = (): { code: number | null; signal: NodeJS.Signals | null } | null =>
      proc.exitCode === null && proc.signalCode === null
        ? null
        : { code: proc.exitCode, signal: proc.signalCode };
    proc.stderr!.setEncoding("utf8");
    proc.stderr!.on("data", (chunk: string) => {
      stderr += chunk;
      polls = (stderr.match(/"name":"queue_backlog"/g) ?? []).length;
    });

    // Precondition: the first poll cycle completed, leaving the pooled client idle.
    expect(await waitFor(() => polls >= 1 || exit() !== null, 15_000), stderr).toBe(true);
    expect(exit(), stderr).toBeNull();

    const admin = new pg.Client({ connectionString: testUrl });
    await admin.connect();
    try {
      const idle = await (async () => {
        for (let i = 0; i < 100; i++) {
          const { rows } = await admin.query<{ pid: number; state: string }>(
            "SELECT pid, state FROM pg_stat_activity WHERE application_name = $1 AND state = 'idle'",
            [appName],
          );
          if (rows.length > 0) return rows;
          await new Promise((r) => setTimeout(r, 50));
        }
        return [];
      })();
      expect(idle.length, stderr).toBeGreaterThan(0);
      await admin.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1",
        [appName],
      );
    } finally {
      await admin.end();
    }

    // The worker must still be alive 3s later, with no unhandled 'error' event.
    await new Promise((r) => setTimeout(r, 3000));
    const failureContext = `exit=${JSON.stringify(exit())}\nstderr:\n${stderr}`;
    expect(stderr, failureContext).not.toMatch(/Unhandled 'error' event/);
    expect(exit(), failureContext).toBeNull();
  }, 40_000);
});
