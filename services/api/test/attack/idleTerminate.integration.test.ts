import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Adversarial pass 3 extra: an IDLE pooled Postgres connection is terminated
 * out-of-band (pg_terminate_backend — the same thing a Postgres restart,
 * failover or idle_session_timeout does). The API process must survive and
 * serve the next request; pg-pool re-emits idle-client errors on the Pool,
 * and a Pool with no 'error' listener turns that into an unhandled 'error'
 * event (process crash).
 *
 * The attack runs in a child process so a crash cannot take vitest down.
 * Skipped visibly without DATABASE_URL_TEST.
 */
const testUrl = process.env["DATABASE_URL_TEST"];
const here = dirname(fileURLToPath(import.meta.url));

describe.skipIf(!testUrl)("attack pass 3: idle pooled connection terminated", () => {
  it("the API process survives and the next request is served", () => {
    const child = spawnSync(
      process.execPath,
      ["--import", "tsx", join(here, "idleTerminateChild.ts")],
      {
        cwd: join(here, "..", ".."),
        env: { ...process.env, DATABASE_URL_TEST: testUrl! },
        encoding: "utf8",
        timeout: 60_000,
      },
    );
    const lastLine = child.stdout.trim().split("\n").at(-1) ?? "";
    const report = JSON.parse(lastLine || "{}") as { survived?: boolean; nextStatus?: number };
    expect(report, `stdout=${child.stdout}\nstderr=${child.stderr}`).toMatchObject({
      survived: true,
    });
    expect(child.status, child.stderr).toBe(0);
    // token is valid but has no account: the request must reach the DB again
    expect(report.nextStatus).toBe(401);
  }, 90_000);
});
