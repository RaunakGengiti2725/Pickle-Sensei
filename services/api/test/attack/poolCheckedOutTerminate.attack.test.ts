import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * ADJ-04 attack: the fix in src/app.ts installs `pool.on("error")`, which
 * pg-pool only emits for IDLE clients. A pooled client that is checked out
 * (a request in flight inside withTransaction / pool.connect) emits 'error'
 * on the pg.Client itself when PostgreSQL terminates the backend — still an
 * unhandled 'error' event, still exit 1. A server restart / failover /
 * `pg_terminate_backend` therefore kills the API whenever any request is in
 * flight, which under load is always.
 *
 * Expected (ADJ-04 acceptance text): "the process survives and the next
 * request is served (possibly 503 briefly)". The in-flight request may fail
 * with a 5xx.
 *
 * Runs the API in a child process (test/attack/support/poolCheckedOutTerminate.child.ts)
 * so the crash is observable as a non-zero exit instead of taking vitest down.
 * Skipped (visibly) without DATABASE_URL_TEST.
 */
const testUrl = process.env["DATABASE_URL_TEST"];
const describeIf = testUrl ? describe : describe.skip;

const childPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "support",
  "poolCheckedOutTerminate.child.ts",
);

interface ChildRun {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function runChild(variant: "active-locked" | "idle-in-tx"): ChildRun {
  const result = spawnSync(process.execPath, ["--import", "tsx", childPath], {
    cwd: join(dirname(childPath), "..", "..", ".."),
    env: { ...process.env, DATABASE_URL_TEST: testUrl, ATTACK_VARIANT: variant },
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

function assertSurvived(run: ChildRun, backendStatePattern: RegExp): void {
  const lines = run.stdout.split("\n").filter((l) => l.trim().length > 0);
  const verdictLine = lines.find((l) => l.startsWith('{"survived":'));
  const failureContext = `exit=${run.exitCode} signal=${run.signal}\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`;

  // Precondition: the child really found a CHECKED-OUT backend and terminated it.
  expect(run.stderr, failureContext).toMatch(backendStatePattern);
  expect(run.stderr, failureContext).toMatch(/"terminated"/);

  // The process is alive 2s after the termination and the next request is served.
  expect(run.stderr, failureContext).not.toMatch(/Unhandled 'error' event/);
  expect(run.exitCode, failureContext).toBe(0);
  expect(verdictLine, failureContext).toBeDefined();
  const verdict = JSON.parse(verdictLine!) as {
    survived: boolean;
    healthStatus: number;
    nextStatus: number;
  };
  expect(verdict.survived).toBe(true);
  expect([200, 503]).toContain(verdict.healthStatus);
  // The next authenticated request is served by the live process: any
  // non-5xx (401 when the failed bootstrap left no account) or a brief 503.
  expect(
    verdict.nextStatus === 503 || verdict.nextStatus < 500,
    `next request status ${verdict.nextStatus}`,
  ).toBe(true);
}

describeIf("pg.Pool checked-out client termination (ADJ-04 neighbourhood)", () => {
  it("survives pg_terminate_backend of a pooled client blocked mid-query inside a real route", () => {
    assertSurvived(runChild("active-locked"), /state\\?":\\?"active/);
  }, 30_000);

  it("survives pg_terminate_backend of a checked-out client that is idle in transaction", () => {
    assertSurvived(runChild("idle-in-tx"), /state\\?":\\?"idle in transaction/);
  }, 30_000);
});
