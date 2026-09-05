import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * An idle pooled Postgres connection terminated by the server
 * (`pg_terminate_backend`, restart, failover, idle timeout) emits 'error' on
 * pg.Pool. Without a listener that is an unhandled 'error' event and the API
 * process dies. The process must survive, log the pg error through the
 * Fastify logger, and keep serving requests.
 *
 * Runs the API in a child process (test/support/poolIdleTerminate.child.ts)
 * so a crash is observable as a non-zero exit instead of taking vitest down.
 * Skipped (visibly) without DATABASE_URL_TEST; CI always runs it.
 */
const testUrl = process.env["DATABASE_URL_TEST"];
const describeIf = testUrl ? describe : describe.skip;

const childPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "support",
  "poolIdleTerminate.child.ts",
);

interface ChildRun {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function runChild(): ChildRun {
  const result = spawnSync(process.execPath, ["--import", "tsx", childPath], {
    cwd: join(dirname(childPath), "..", ".."),
    env: { ...process.env, DATABASE_URL_TEST: testUrl },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 25_000,
  });
  if (result.error) throw result.error;
  return {
    exitCode: result.status,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

describeIf("pg.Pool idle-client termination", () => {
  it("survives pg_terminate_backend of an idle pooled connection, logs it, and keeps serving", () => {
    const run = runChild();
    const lines = run.stdout.split("\n").filter((l) => l.trim().length > 0);
    const verdictLine = lines.find((l) => l.startsWith('{"survived":'));
    const failureContext = `exit=${run.exitCode} signal=${run.signal}\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`;

    // Precondition: the child really had one idle backend that got terminated.
    expect(run.stderr, failureContext).toMatch(/state\\?":\\?"idle/);

    // 1. The process is alive 2s after the termination and health still answers.
    expect(run.exitCode, failureContext).toBe(0);
    expect(verdictLine, failureContext).toBeDefined();
    const verdict = JSON.parse(verdictLine!) as {
      survived: boolean;
      healthStatus: number;
      dbRecovered: boolean;
      sloPoolAfterTerminate: {
        totalCount: number;
        idleCount: number;
        waitingCount: number;
        maxSize: number | null;
      } | null;
    };
    expect(verdict.survived).toBe(true);
    expect([200, 503]).toContain(verdict.healthStatus);

    // 2. The pool error went through the Fastify (pino) logger, not to stderr
    //    as an uncaught exception.
    const pgErrorLogLine = lines.find(
      (l) =>
        l.startsWith("{") &&
        l.includes('"level"') &&
        l.includes("terminating connection due to administrator command"),
    );
    expect(pgErrorLogLine, failureContext).toBeDefined();
    expect(run.stderr).not.toMatch(/Unhandled 'error' event/);

    // 3. admin_shutdown (57P01) is a recognised datastore-unavailable class:
    //    logged as a warning carrying the pg code and the post-purge pool
    //    sample — without the purged pg.Client (socket + connection
    //    parameters) pg-pool tags onto the error.
    const logged = JSON.parse(pgErrorLogLine!) as {
      level: number;
      pgCode: string | null;
      pool: { totalCount: number; idleCount: number };
      err: { code?: string; client?: unknown };
    };
    expect(logged.level).toBe(40);
    expect(logged.pgCode).toBe("57P01");
    expect(logged.pool).toMatchObject({ totalCount: 0, idleCount: 0 });
    expect(logged.err.client).toBeUndefined();
    expect(pgErrorLogLine).not.toContain("connectionParameters");

    // 4. The purge is visible on the SLO surface before any request probes the
    //    pool again, and the next checkout reconnects instead of reusing the
    //    dead client.
    expect(verdict.sloPoolAfterTerminate).toMatchObject({
      totalCount: 0,
      idleCount: 0,
      waitingCount: 0,
    });
    expect(verdict.dbRecovered).toBe(true);
    expect(run.stderr, failureContext).toMatch(/reconnect pool=1\/1/);

    // 5. A pool failure outside the recognised outage classes is survived too,
    //    reported at error level.
    const syntheticLogLine = lines.find(
      (l) => l.startsWith("{") && l.includes("synthetic idle client fault"),
    );
    expect(syntheticLogLine, failureContext).toBeDefined();
    const synthetic = JSON.parse(syntheticLogLine!) as { level: number; pgCode: string | null };
    expect(synthetic.level).toBe(50);
    expect(synthetic.pgCode).toBe("XX000");
  }, 30_000);
});
