// H07-01 adversarial tests that drive the REAL candidate against the LOCAL
// Supabase stack (Docker + `supabase_db_pickle-sensei` + `supabase_kong_pickle-sensei`
// must already be running, e.g. from one prior `deno run -A tools/diagnostics/edge_cold_start.ts`).
// Never touches the hosted project.
//
//   deno test -A tools/diagnostics/__attack__/h07_01/edge_cold_start_attack.integration.test.ts
//
// Attacks: process death (SIGTERM mid-cycle, SIGKILL + restart), boundary values
// (1 ms startup timeout), network failure at the stack step (Kong stopped), and a
// foreign container squatting on the edge-runtime name.

import { join } from "node:path";
import { assert, assertEquals } from "./assert.ts";
import {
  dockerNames,
  exec,
  lockPath,
  pathExists,
  readReport,
  REPO_ROOT,
  runCandidate,
  scratchDir,
  serveProcesses,
  sleep,
} from "./harness.ts";

const PROJECT_ID = "pickle-sensei";
const EDGE_CONTAINER = `supabase_edge_runtime_${PROJECT_ID}`;
const KONG = `supabase_kong_${PROJECT_ID}`;
const DB = `supabase_db_${PROJECT_ID}`;
const LOCK = lockPath(PROJECT_ID);

async function requireStack(): Promise<void> {
  const names = await dockerNames();
  assert(
    names.has(DB) && names.has(KONG),
    `local stack not running (${DB}, ${KONG}); start it with the candidate script first`,
  );
  const stale = await serveProcesses();
  assertEquals(stale, [], "precondition: no `functions serve` process is running");
  assert(!(await pathExists(LOCK)), `precondition: no lock at ${LOCK}`);
  assertEquals(await checkoutClean(), "", "precondition: checkout markers clean");
}

/** Put the tracked marker back to HEAD so one attack's damage cannot leak into the next. */
async function restoreTrackedMarker(): Promise<void> {
  const head = await exec("git", ["show", "HEAD:supabase/.temp/cli-latest"], { cwd: REPO_ROOT });
  if (head.code === 0) {
    await Deno.writeTextFile(join(REPO_ROOT, "supabase", ".temp", "cli-latest"), head.stdout);
  }
}

async function checkoutClean(): Promise<string> {
  const status = await exec(
    "git",
    ["status", "--porcelain", "--", "supabase/.temp", "supabase/.branches"],
    {
      cwd: REPO_ROOT,
    },
  );
  return status.stdout.trim();
}

interface Running {
  child: Deno.ChildProcess;
  stdout: () => string;
  done: Promise<Deno.CommandStatus>;
}

function startCandidate(args: readonly string[]): Running {
  const child = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", join(REPO_ROOT, "tools", "diagnostics", "edge_cold_start.ts"), ...args],
    cwd: REPO_ROOT,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const chunks: string[] = [];
  const decoder = new TextDecoder();
  const drain = (stream: ReadableStream<Uint8Array>) =>
    stream.pipeTo(
      new WritableStream<Uint8Array>({
        write(chunk) {
          chunks.push(decoder.decode(chunk));
        },
      }),
    );
  const drained = Promise.all([drain(child.stdout), drain(child.stderr)]);
  return {
    child,
    stdout: () => chunks.join(""),
    done: child.status.then(async (status) => {
      await drained;
      return status;
    }),
  };
}

/** Wait until the CLI's edge-runtime container is up (a cycle is in flight). */
async function waitForEdgeRuntime(run: Running, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ps = await exec("docker", ["ps", "--format", "{{.Names}}"]);
    if (ps.stdout.split("\n").includes(EDGE_CONTAINER)) {
      return;
    }
    await sleep(250);
  }
  throw new Error(`edge runtime never appeared within ${timeoutMs} ms:\n${run.stdout()}`);
}

async function killServeOrphans(): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const lines = await serveProcesses();
    if (lines.length === 0) {
      break;
    }
    for (const line of lines) {
      const pid = Number(/^\s*(\d+)/.exec(line)?.[1]);
      if (Number.isSafeInteger(pid)) {
        try {
          Deno.kill(pid, attempt < 2 ? "SIGINT" : "SIGKILL");
        } catch {
          // already gone
        }
      }
    }
    await sleep(2000);
  }
  await exec("docker", ["rm", "-f", EDGE_CONTAINER]);
}

// ---------------------------------------------------------------------------
// Attack 8 — process death: SIGTERM while a serve cycle is in flight.
// Claim: the tree is interrupted, the CLI-owned container removed, an
// "interrupted" report persisted, the lock released, exit 128+15, checkout clean.
// ---------------------------------------------------------------------------
Deno.test(
  "attack: SIGTERM mid-cycle tears down the CLI tree, container, lock and persists an interrupted report",
  async () => {
    await requireStack();
    const out = await scratchDir("sigterm");
    try {
      const run = startCandidate(["--cycles", "2", "--warm-requests", "2", "--out", out]);
      await waitForEdgeRuntime(run, 120_000);
      await sleep(500);
      run.child.kill("SIGTERM");
      const status = await run.done;
      const log = run.stdout();

      assertEquals(status.code, 143, `exit 128+SIGTERM\n${log}`);
      const report = await readReport(out);
      assertEquals(report.status, "interrupted", `report status\n${log}`);
      assertEquals(report.error, "interrupted by SIGTERM", "report error");
      assert(report.bundle !== null, "bundle metrics kept in the interrupted report");
      await sleep(1000);
      assertEquals(await serveProcesses(), [], "no `functions serve` survives the signal");
      assert(!(await dockerNames()).has(EDGE_CONTAINER), "edge-runtime container removed");
      assert(!(await pathExists(LOCK)), "run lock released");
      assertEquals(await checkoutClean(), "", "checkout markers restored");
      assert(log.includes("SIGTERM received"), `handler announced the signal\n${log}`);
    } finally {
      await killServeOrphans();
      await Deno.remove(LOCK).catch(() => undefined);
      await Deno.remove(out, { recursive: true });
    }
  },
);

// ---------------------------------------------------------------------------
// Attack 9 — process death + restart: SIGKILL (no handler can run), then a new
// run. Claim: the orphaned `functions serve` is detected and the new run refuses
// (rather than sampling the wrong runtime), the dead pid's lock is reclaimed, and
// the new run's own teardown leaves no lock. The checkout must end clean.
// ---------------------------------------------------------------------------
Deno.test(
  "attack: SIGKILL leaves an orphan; the next run refuses, reclaims the dead lock and persists a report",
  async () => {
    await requireStack();
    const out1 = await scratchDir("sigkill-1");
    const out2 = await scratchDir("sigkill-2");
    try {
      const run = startCandidate(["--cycles", "2", "--warm-requests", "2", "--out", out1]);
      await waitForEdgeRuntime(run, 120_000);
      run.child.kill("SIGKILL");
      const status = await run.done;
      assertEquals(status.signal, "SIGKILL", "first run died by SIGKILL");
      assert(
        (await serveProcesses()).length > 0,
        "precondition: orphaned `functions serve` tree survives",
      );
      assert(await pathExists(LOCK), "precondition: the dead run's lock is left behind");

      const second = await runCandidate(REPO_ROOT, [
        "--cycles",
        "1",
        "--warm-requests",
        "1",
        "--out",
        out2,
      ]);
      assertEquals(second.code, 1, `second run fails closed\n${second.stdout}${second.stderr}`);
      assert(
        second.stdout.includes("another `supabase functions serve` is running"),
        `second run names the orphan\n${second.stdout}`,
      );
      const report = await readReport(out2);
      assertEquals(report.status, "failed", "second run persisted a failed report");
      assert(report.bundle !== null, "second run still measured the bundle");
      assert(!(await pathExists(LOCK)), "second run released the (reclaimed) lock");

      // Follow the refusal's instruction (stop the orphan), then restart once more.
      await killServeOrphans();
      const dirtyAfterOrphan = await checkoutClean();
      const third = await runCandidate(REPO_ROOT, [
        "--cycles",
        "1",
        "--warm-requests",
        "1",
        "--startup-timeout-ms",
        "1",
        "--out",
        out2,
      ]);
      assertEquals(third.code, 1, `third run fails closed on the 1 ms timeout\n${third.stdout}`);
      assertEquals(
        await checkoutClean(),
        "",
        `a restarted run must restore the tracked marker the killed run could not (state after orphan stop: ${JSON.stringify(dirtyAfterOrphan)})`,
      );
    } finally {
      await killServeOrphans();
      await Deno.remove(LOCK).catch(() => undefined);
      await Deno.remove(out1, { recursive: true });
      await Deno.remove(out2, { recursive: true });
      await restoreTrackedMarker();
    }
  },
);

// ---------------------------------------------------------------------------
// Attack 10 — boundary value: --startup-timeout-ms 1.
// Claim: both targets record UNAVAILABLE with the timeout reason, the run exits 1
// with report.json persisted, and nothing (process, container, lock) leaks.
// ---------------------------------------------------------------------------
Deno.test(
  "attack: a 1 ms startup timeout fails closed without leaking processes, containers or the lock",
  async () => {
    await requireStack();
    const out = await scratchDir("timeout");
    try {
      const result = await runCandidate(REPO_ROOT, [
        "--cycles",
        "1",
        "--warm-requests",
        "1",
        "--startup-timeout-ms",
        "1",
        "--out",
        out,
      ]);
      assertEquals(result.code, 1, `exit 1\n${result.stdout}${result.stderr}`);
      const report = await readReport(out);
      assertEquals(report.status, "failed", "report failed");
      assertEquals(report.ok, false, "ok=false");
      assertEquals(report.serve.length, 2, "both targets recorded");
      for (const target of report.serve) {
        assertEquals(target.status, "unavailable", `${target.target} unavailable`);
        assert(
          (target.reason ?? "").includes("runtime not healthy after 1ms"),
          `${target.target} reason: ${target.reason}`,
        );
        assertEquals(target.cycles.length, 0, `${target.target} has no cycle`);
      }
      await sleep(1000);
      assertEquals(await serveProcesses(), [], "no `functions serve` leaked");
      assert(!(await dockerNames()).has(EDGE_CONTAINER), "edge-runtime container removed");
      assert(!(await pathExists(LOCK)), "lock released");
      assertEquals(await checkoutClean(), "", "checkout markers restored");
    } finally {
      await killServeOrphans();
      await Deno.remove(LOCK).catch(() => undefined);
      await Deno.remove(out, { recursive: true });
    }
  },
);

// ---------------------------------------------------------------------------
// Attack 11 — network failure at the stack step: Kong is down while Postgres is up.
// Claim: the run explains the half-up stack and exits 1 with a persisted report,
// never starting a serve against a dead gateway.
// ---------------------------------------------------------------------------
Deno.test(
  "attack: Kong stopped beside a running db fails closed with a persisted report",
  async () => {
    await requireStack();
    const out = await scratchDir("kong-down");
    try {
      await exec("docker", ["stop", KONG]);
      const result = await runCandidate(REPO_ROOT, [
        "--cycles",
        "1",
        "--warm-requests",
        "1",
        "--out",
        out,
      ]);
      assertEquals(result.code, 1, `exit 1\n${result.stdout}${result.stderr}`);
      assert(
        result.stdout.includes(`${KONG} is not`),
        `names the missing gateway\n${result.stdout}`,
      );
      const report = await readReport(out);
      assertEquals(report.status, "failed", "report failed");
      assert((report.error ?? "").includes(KONG), "report.error names Kong");
      assertEquals(report.serve, [], "no serve target attempted");
      assertEquals(await serveProcesses(), [], "no `functions serve` started");
      assert(!(await pathExists(LOCK)), "lock released");
    } finally {
      await exec("docker", ["start", KONG]);
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const health = await exec("docker", [
          "inspect",
          "--format",
          "{{.State.Health.Status}}",
          KONG,
        ]);
        if (health.stdout.trim() === "healthy") {
          break;
        }
        await sleep(1000);
      }
      await Deno.remove(LOCK).catch(() => undefined);
      await Deno.remove(out, { recursive: true });
    }
  },
);

// ---------------------------------------------------------------------------
// Attack 12 — foreign state: a container that is not the CLI's squats on the
// edge-runtime name. Claim: the run refuses to remove it and never launches a
// serve that would destroy it; the container survives untouched.
// ---------------------------------------------------------------------------
Deno.test(
  "attack: a foreign container on the edge-runtime name is refused, not destroyed",
  async () => {
    await requireStack();
    const out = await scratchDir("foreign");
    const image = (
      await exec("docker", ["inspect", "--format", "{{.Config.Image}}", KONG])
    ).stdout.trim();
    try {
      const created = await exec("docker", [
        "create",
        "--name",
        EDGE_CONTAINER,
        "--label",
        "com.supabase.cli.project=someone-else",
        image,
      ]);
      assertEquals(created.code, 0, `created foreign container\n${created.stderr}`);
      const result = await runCandidate(REPO_ROOT, [
        "--cycles",
        "1",
        "--warm-requests",
        "1",
        "--out",
        out,
      ]);
      assertEquals(result.code, 1, `exit 1\n${result.stdout}${result.stderr}`);
      assert(result.stdout.includes("refusing to remove it"), `refusal printed\n${result.stdout}`);
      const label = await exec("docker", [
        "inspect",
        "--format",
        '{{index .Config.Labels "com.supabase.cli.project"}}',
        EDGE_CONTAINER,
      ]);
      assertEquals(
        label.stdout.trim(),
        "someone-else",
        "foreign container still exists, untouched",
      );
      assertEquals(await serveProcesses(), [], "no `functions serve` launched beside it");
      const report = await readReport(out);
      assertEquals(report.status, "failed", "report failed");
      for (const target of report.serve) {
        assertEquals(target.status, "unavailable", `${target.target} unavailable`);
      }
      assert(!(await pathExists(LOCK)), "lock released");
    } finally {
      await exec("docker", ["rm", "-f", EDGE_CONTAINER]);
      await killServeOrphans();
      await Deno.remove(LOCK).catch(() => undefined);
      await Deno.remove(out, { recursive: true });
    }
  },
);
