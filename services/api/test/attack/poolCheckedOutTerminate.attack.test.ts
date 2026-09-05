import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * ADJ-04 attack tests (branch devin/attack-close-c9eaaa77).
 *
 * The candidate fix (`buildPool` → `pool.on("error")`) covers a pooled client
 * that is CHECKED IN. Every route that uses `withTransaction()` (src/lib/db.ts,
 * 16 call sites) holds a client CHECKED OUT via `pool.connect()`; pg-pool
 * detaches its idle 'error' listener at checkout and the caller installs none.
 * The same triggers ADJ-04 names — pg_terminate_backend, restart/failover,
 * server-side session timeouts, a dropped TCP connection — therefore still
 * take the whole API process down whenever they hit a request in flight.
 *
 * Each scenario runs the API in a child process so the crash shows up as
 * exit 1 + `Unhandled 'error' event` instead of killing vitest.
 * Skipped (visibly) without DATABASE_URL_TEST.
 */
const testUrl = process.env["DATABASE_URL_TEST"];
const describeIf = testUrl ? describe : describe.skip;
const here = dirname(fileURLToPath(import.meta.url));
const apiRoot = join(here, "..", "..");

interface ChildRun {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

function runChild(script: string, env: Record<string, string>): ChildRun {
  const result = spawnSync(process.execPath, ["--import", "tsx", join(here, script)], {
    cwd: apiRoot,
    env: { ...process.env, DATABASE_URL_TEST: testUrl, ...env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 40_000,
  });
  if (result.error) throw result.error;
  return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr };
}

function verdictOf(run: ChildRun): Record<string, unknown> | undefined {
  const line = run.stdout.split("\n").find((l) => l.startsWith('{"survived":'));
  return line ? (JSON.parse(line) as Record<string, unknown>) : undefined;
}

function expectSurvived(run: ChildRun): Record<string, unknown> {
  const context = `exit=${run.exitCode}\nstdout:\n${run.stdout.slice(-4000)}\nstderr:\n${run.stderr.slice(-4000)}`;
  expect(run.stderr, context).not.toMatch(/Unhandled 'error' event/);
  expect(run.exitCode, context).toBe(0);
  const verdict = verdictOf(run);
  expect(verdict, context).toBeDefined();
  expect(verdict!["survived"]).toBe(true);
  return verdict!;
}

describeIf("ADJ-04 attack: connection loss on a CHECKED-OUT pooled client", () => {
  it("survives pg_terminate_backend while withTransaction() holds an idle-in-transaction client", () => {
    const run = runChild("poolCheckedOutClient.child.ts", { SCENARIO: "idle_in_tx_fatal" });
    expect(run.stderr).toMatch(/idle in transaction/);
    const verdict = expectSurvived(run);
    expect(verdict["dbRecovered"]).toBe(true);
    expect(String(verdict["workError"])).toContain("57P01");
  }, 45_000);

  it("survives pg_terminate_backend while withTransaction() has a statement in flight", () => {
    const run = runChild("poolCheckedOutClient.child.ts", { SCENARIO: "active_in_tx_fatal" });
    expect(run.stderr).toMatch(/"state\\?":\\?"active/);
    const verdict = expectSurvived(run);
    expect(verdict["dbRecovered"]).toBe(true);
  }, 45_000);

  it("survives an abrupt socket close (crash / network drop) while withTransaction() is idle", () => {
    const run = runChild("poolCheckedOutClient.child.ts", { SCENARIO: "idle_in_tx_abrupt" });
    expect(run.stderr).toMatch(/dropped-proxied-connections:1/);
    expectSurvived(run);
  }, 45_000);

  it("survives an abrupt socket close while withTransaction() has a statement in flight", () => {
    const run = runChild("poolCheckedOutClient.child.ts", { SCENARIO: "active_in_tx_abrupt" });
    expect(run.stderr).toMatch(/dropped-proxied-connections:1/);
    expectSurvived(run);
  }, 45_000);

  it("survives idle_in_transaction_session_timeout (FATAL 25P03) on a held transaction", () => {
    const run = runChild("poolServerTimeouts.child.ts", { MODE: "idle_in_tx" });
    expect(run.stderr).toMatch(/in-tx pool=1\/0/);
    const verdict = expectSurvived(run);
    expect(String(verdict["txError"])).toContain("25P03");
    expect(verdict["dbRecovered"]).toBe(true);
  }, 45_000);

  it("a live POST /v1/account/bootstrap whose backend is terminated fails with 503 and the process keeps serving", () => {
    const run = runChild("poolRequestInTransactionTerminate.child.ts", {});
    expect(run.stderr).toMatch(/route backend pid=\d+ state=active/);
    const verdict = expectSurvived(run);
    expect(verdict["firstStatus"]).toBe(503);
    expect(verdict["secondStatus"]).toBe(200);
  }, 45_000);

  it("a burst of concurrent withTransaction() requests under repeated backend termination never crashes the process", () => {
    const run = runChild("poolConcurrentRequestsTerminate.child.ts", { ROUTE_MODE: "bootstrap" });
    const verdict = expectSurvived(run);
    expect(verdict["non503ServerErrors"]).toEqual([]);
    expect(verdict["afterStatus"]).toBe(200);
  }, 60_000);
});

describeIf("ADJ-04 controls: paths the candidate DOES cover (must stay green)", () => {
  it("abrupt socket close of a checked-in idle client is logged and survived", () => {
    const run = runChild("poolCheckedOutClient.child.ts", { SCENARIO: "idle_in_pool_abrupt" });
    const verdict = expectSurvived(run);
    expect(verdict["dbRecovered"]).toBe(true);
    expect(run.stdout).toMatch(/"level":40.*Connection terminated unexpectedly/);
  }, 45_000);

  it("abrupt socket close during pool.query() rejects the query and survives", () => {
    const run = runChild("poolCheckedOutClient.child.ts", { SCENARIO: "active_pool_query_abrupt" });
    const verdict = expectSurvived(run);
    expect(String(verdict["workError"])).toContain("Connection terminated unexpectedly");
    expect(verdict["dbRecovered"]).toBe(true);
  }, 45_000);

  it("idle_session_timeout (FATAL 57P05) on idle pooled clients is logged at warn and survived", () => {
    const run = runChild("poolServerTimeouts.child.ts", { MODE: "idle_session" });
    const verdict = expectSurvived(run);
    expect(verdict["dbRecovered"]).toBe(true);
    const warns = run.stdout
      .split("\n")
      .filter((l) => l.includes('"level":40') && l.includes('"pgCode":"57P05"'));
    expect(warns).toHaveLength(3);
  }, 45_000);

  it("a burst of concurrent pool.query() requests under repeated backend termination yields only 200/503", () => {
    const run = runChild("poolConcurrentRequestsTerminate.child.ts", { ROUTE_MODE: "me" });
    const verdict = expectSurvived(run);
    expect(verdict["non503ServerErrors"]).toEqual([]);
    const statuses = Object.keys(verdict["statusCounts"] as Record<string, number>);
    expect(statuses).toContain("200");
    expect(statuses.filter((s) => s !== "200" && s !== "503")).toEqual([]);
    expect(verdict["afterStatus"]).toBe(200);
  }, 60_000);
});
