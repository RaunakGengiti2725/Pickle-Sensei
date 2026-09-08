// Adversarial tests for tools/diagnostics/edge_cold_start.ts (work package H07-01,
// candidate a84b02bf). These drive the real script against the local Docker stack
// (project pickle-sensei); they never contact the hosted project.
//
//   deno test -A tools/diagnostics/__attack__/edge_cold_start_live.attack.test.ts
//
// Requirements: Docker daemon, network access for `npx --yes supabase@2.117.0`, and the
// `docker`/`git` binaries on PATH. Tests run sequentially and clean up what they start.
// A failing test is a confirmed break; a passing test is an attack that did not break it.

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const script = join(repoRoot, "tools", "diagnostics", "edge_cold_start.ts");
const decoder = new TextDecoder();
const EDGE_CONTAINER = "supabase_edge_runtime_pickle-sensei";
const CLI_SPEC = "supabase@2.117.0";

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface ReportShape {
  ok: boolean;
  serve: Array<{
    target: string;
    status: string;
    cycles: Array<{ coldHealthzMs: number }>;
  }>;
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function run(cmd: string, args: readonly string[], cwd = repoRoot): Promise<RunResult> {
  const output = await new Deno.Command(cmd, {
    args: [...args],
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: output.code,
    stdout: decoder.decode(output.stdout),
    stderr: decoder.decode(output.stderr),
  };
}

function runScript(args: readonly string[], cwd = repoRoot): Promise<RunResult> {
  return run(Deno.execPath(), ["run", "-A", script, ...args], cwd);
}

async function runningContainers(): Promise<string[]> {
  const result = await run("docker", ["ps", "--format", "{{.Names}}"]);
  return result.stdout.split("\n").filter((line) => line.length > 0);
}

async function servePids(workdirMarker: string): Promise<number[]> {
  const result = await run("pgrep", ["-f", `supabase --workdir ${workdirMarker}`]);
  return result.stdout
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => Number(line));
}

async function killPids(pids: readonly number[]): Promise<void> {
  for (const pid of pids) {
    try {
      Deno.kill(pid, "SIGINT");
    } catch {
      // already gone
    }
  }
  await sleep(2_000);
  for (const pid of pids) {
    try {
      Deno.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

async function readReport(outDir: string): Promise<ReportShape | null> {
  try {
    return JSON.parse(await Deno.readTextFile(join(outDir, "report.json"))) as ReportShape;
  } catch {
    return null;
  }
}

async function ensureStackUp(): Promise<void> {
  const names = await runningContainers();
  if (
    names.includes("supabase_db_pickle-sensei") &&
    names.includes("supabase_kong_pickle-sensei")
  ) {
    return;
  }
  const started = await run("npx", [
    "--yes",
    CLI_SPEC,
    "start",
    "-x",
    "gotrue,realtime,storage-api,imgproxy,mailpit,postgrest,postgres-meta,studio,edge-runtime,logflare,vector,supavisor",
  ]);
  assert(started.code === 0, `supabase start failed: ${started.stderr}`);
}

// Restores the two paths the pinned CLI mutates so later git-status assertions are exact.
async function restoreCliSideEffects(): Promise<void> {
  const tracked = await run("git", ["show", "HEAD:supabase/.temp/cli-latest"]);
  assert(tracked.code === 0, "supabase/.temp/cli-latest is not tracked at HEAD");
  await Deno.writeTextFile(join(repoRoot, "supabase", ".temp", "cli-latest"), tracked.stdout);
  await Deno.remove(join(repoRoot, "supabase", ".branches"), { recursive: true }).catch(() => {});
}

Deno.test(
  "ATTACK process death: SIGTERM to the script must not orphan `supabase functions serve`",
  async () => {
    await ensureStackUp();
    const outDir = await Deno.makeTempDir({ prefix: "h07-attack-sigterm-" });
    const child = new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", script, "--cycles", "1", "--out", outDir],
      cwd: repoRoot,
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    let killed = false;
    const stdoutText = child.stdout.pipeTo(new WritableStream<Uint8Array>()).catch(() => undefined);
    const stderrText = child.stderr.pipeTo(new WritableStream<Uint8Array>()).catch(() => undefined);
    const deadline = Date.now() + 150_000;
    try {
      // Wait until the bundle-target serve process is alive, then kill the parent.
      while (Date.now() < deadline) {
        const pids = await servePids(join(outDir, "workdir"));
        if (pids.length > 0 && (await runningContainers()).includes(EDGE_CONTAINER)) {
          break;
        }
        await sleep(500);
      }
      const before = await servePids(join(outDir, "workdir"));
      assert(before.length > 0, "precondition: bundle serve process never appeared");
      child.kill("SIGTERM");
      killed = true;
      const status = await child.status;
      await Promise.all([stdoutText, stderrText]);
      assert(status.signal === "SIGTERM" || status.code !== 0, "parent should have died");
      await sleep(5_000);
      const after = await servePids(join(outDir, "workdir"));
      const containers = await runningContainers();
      const orphaned = after.length > 0 || containers.includes(EDGE_CONTAINER);
      try {
        assert(
          !orphaned,
          `after SIGTERM the parent (deno) exited but ${after.length} supabase CLI process(es) ${JSON.stringify(after)} and edge container present=${containers.includes(EDGE_CONTAINER)} were left running`,
        );
      } finally {
        await killPids(after);
        await run("docker", ["rm", "-f", EDGE_CONTAINER]);
      }
    } finally {
      if (!killed) {
        child.kill("SIGKILL");
        await child.status;
      }
      await Deno.remove(outDir, { recursive: true }).catch(() => {});
    }
  },
);

Deno.test(
  "ATTACK crash between steps: a failed later cycle must still leave report.json + logs",
  async () => {
    await ensureStackUp();
    const outDir = await Deno.makeTempDir({ prefix: "h07-attack-partial-" });
    const bundlePath = join(outDir, "workdir", "supabase", "functions", "api", "index.js");
    const child = new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", script, "--cycles", "2", "--out", outDir],
      cwd: repoRoot,
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    let stdout = "";
    const pump = child.stdout.pipeTo(
      new WritableStream<Uint8Array>({
        write(chunk) {
          stdout += decoder.decode(chunk);
        },
      }),
    );
    const stderrPump = child.stderr.pipeTo(new WritableStream<Uint8Array>()).catch(() => undefined);
    try {
      const deadline = Date.now() + 240_000;
      while (Date.now() < deadline && !stdout.includes("[bundle] cycle 1:")) {
        await sleep(250);
      }
      assert(stdout.includes("[bundle] cycle 1:"), `cycle 1 never completed:\n${stdout}`);
      // Corrupt the generated state between cycle 1 and cycle 2.
      await Deno.remove(bundlePath);
      const status = await child.status;
      await Promise.all([pump, stderrPump]);
      assert(status.code !== 0, "run must fail after its bundle vanished");
      const entries: string[] = [];
      for await (const entry of Deno.readDir(outDir)) {
        entries.push(entry.name);
      }
      const report = await readReport(outDir);
      assert(
        report !== null && entries.some((name) => name.startsWith("serve-bundle-1")),
        `cycle 1 was measured (${stdout
          .trim()
          .split("\n")
          .find((l) =>
            l.includes("[bundle] cycle 1:"),
          )}) but the failed run left no report.json and no serve-bundle-1 log; out dir contains ${JSON.stringify(entries)}`,
      );
    } finally {
      try {
        child.kill("SIGKILL");
      } catch {
        // exited
      }
      await run("docker", ["rm", "-f", EDGE_CONTAINER]);
      await Deno.remove(outDir, { recursive: true }).catch(() => {});
    }
  },
);

Deno.test(
  "ATTACK corrupt state: a foreign container holding the edge-runtime name must not be destroyed",
  async () => {
    await ensureStackUp();
    await run("docker", ["rm", "-f", EDGE_CONTAINER]);
    // Something else (another supabase CLI session, an operator debugging) owns the name.
    const created = await run("docker", [
      "create",
      "--name",
      EDGE_CONTAINER,
      "--label",
      "h07.attack=foreign",
      "public.ecr.aws/supabase/kong:2.8.1",
      "sleep",
      "600",
    ]);
    assert(created.code === 0, `docker create failed: ${created.stderr}`);
    const outDir = await Deno.makeTempDir({ prefix: "h07-attack-foreign-" });
    try {
      const result = await runScript(["--cycles", "1", "--out", outDir]);
      const inspect = await run("docker", [
        "inspect",
        "--format",
        '{{index .Config.Labels "h07.attack"}}',
        EDGE_CONTAINER,
      ]);
      const foreignSurvived = inspect.code === 0 && inspect.stdout.trim() === "foreign";
      assert(
        foreignSurvived,
        `script exit=${result.code}: the pre-existing container ${EDGE_CONTAINER} (not created by this run) was force-removed (docker inspect exit=${inspect.code}); expected the run to refuse/abort and leave foreign state untouched`,
      );
    } finally {
      await run("docker", ["rm", "-f", EDGE_CONTAINER]);
      await Deno.remove(outDir, { recursive: true }).catch(() => {});
    }
  },
);

Deno.test(
  "ATTACK side effects: a measurement run must not dirty tracked files in the checkout",
  async () => {
    await ensureStackUp();
    await restoreCliSideEffects();
    const before = await run("git", [
      "status",
      "--porcelain",
      "--",
      "supabase/.temp",
      "supabase/.branches",
    ]);
    assert(before.stdout.trim() === "", `precondition: dirty before run:\n${before.stdout}`);
    const outDir = await Deno.makeTempDir({ prefix: "h07-attack-dirty-" });
    try {
      const result = await runScript(["--cycles", "1", "--out", outDir]);
      assert(result.code === 0, `run failed:\n${result.stdout}\n${result.stderr}`);
      const after = await run("git", [
        "status",
        "--porcelain",
        "--",
        "supabase/.temp",
        "supabase/.branches",
      ]);
      assert(
        after.stdout.trim() === "",
        `successful run left the checkout dirty (tracked file rewritten / untracked dir created):\n${after.stdout}`,
      );
    } finally {
      await restoreCliSideEffects();
      await Deno.remove(outDir, { recursive: true }).catch(() => {});
    }
  },
);

Deno.test("ATTACK boundary: --out '' writes artifacts into the repository root", async () => {
  await ensureStackUp();
  const worktree = await Deno.makeTempDir({ prefix: "h07-attack-out-empty-" });
  await Deno.remove(worktree);
  const head = (await run("git", ["rev-parse", "HEAD"])).stdout.trim();
  const added = await run("git", ["worktree", "add", "--detach", worktree, head]);
  assert(added.code === 0, `worktree add failed: ${added.stderr}`);
  try {
    const wtScript = join(worktree, "tools", "diagnostics", "edge_cold_start.ts");
    const result = await run(
      Deno.execPath(),
      ["run", "-A", wtScript, "--cycles", "1", "--out", ""],
      worktree,
    );
    const status = await run("git", ["status", "--porcelain", "--untracked-files=all"], worktree);
    const polluted = status.stdout
      .split("\n")
      .filter((line) => /(^|\s)(report\.json|serve-.*\.log|workdir\/)/.test(line));
    assert(
      polluted.length === 0,
      `--out "" (exit=${result.code}) wrote measurement artifacts into the repo root instead of rejecting the empty path; git sees:\n${polluted.join("\n")}`,
    );
  } finally {
    await run("docker", ["rm", "-f", EDGE_CONTAINER]);
    await run("git", ["worktree", "remove", "--force", worktree]);
  }
});

Deno.test(
  "ATTACK concurrency: two simultaneous runs must not both claim ok, and neither may report a bogus sample",
  async () => {
    await ensureStackUp();
    const outA = await Deno.makeTempDir({ prefix: "h07-attack-conc-a-" });
    const outB = await Deno.makeTempDir({ prefix: "h07-attack-conc-b-" });
    try {
      const [a, b] = await Promise.all([
        runScript(["--cycles", "1", "--out", outA]),
        runScript(["--cycles", "1", "--out", outB]),
      ]);
      const reports = [await readReport(outA), await readReport(outB)];
      const okCount = [a, b].filter((r) => r.code === 0).length;
      const observed =
        `exit codes A=${a.code} B=${b.code}; ` +
        `A tail: ${a.stdout.trim().split("\n").slice(-2).join(" | ")}; ` +
        `B tail: ${b.stdout.trim().split("\n").slice(-2).join(" | ")}`;
      // Invariant: a run that shares the fixed container name with a sibling must either
      // serialise or fail loudly — it must never publish a "measured" bundle number that was
      // produced while a sibling was tearing the runtime down (a sub-10 ms "cold" start is
      // physically implausible for a fresh edge-runtime container).
      for (const report of reports) {
        if (report === null) continue;
        const bundle = report.serve.find((entry) => entry.target === "bundle");
        const implausible = bundle?.cycles.filter((cycle) => cycle.coldHealthzMs < 10) ?? [];
        assert(
          implausible.length === 0,
          `implausible cold sample published: ${JSON.stringify(implausible)}; ${observed}`,
        );
      }
      assert(okCount <= 1, `both concurrent runs exited 0; ${observed}`);
      // Supported-path expectation: at least one of two concurrent invocations of the acceptance
      // command produces a measurement (serialisation or a per-run container name).
      assert(okCount >= 1, `neither concurrent run produced a measurement; ${observed}`);
    } finally {
      await run("docker", ["rm", "-f", EDGE_CONTAINER]);
      await Deno.remove(outA, { recursive: true }).catch(() => {});
      await Deno.remove(outB, { recursive: true }).catch(() => {});
    }
  },
);

Deno.test(
  "ATTACK reproducibility: bundle bytes/sha256 must not depend on where the checkout lives",
  async () => {
    // A checkout under /tmp sits at a different depth from $DENO_DIR (~/.cache/deno) than one
    // under /home/<user>/repos; the reported raw size and sha256 must not change with that.
    const worktree = await Deno.makeTempDir({ prefix: "h07-attack-repro-" });
    await Deno.remove(worktree);
    const head = (await run("git", ["rev-parse", "HEAD"])).stdout.trim();
    const added = await run("git", ["worktree", "add", "--detach", worktree, head]);
    assert(added.code === 0, `worktree add failed: ${added.stderr}`);
    const outA = await Deno.makeTempFile({ suffix: ".js" });
    const outB = await Deno.makeTempFile({ suffix: ".js" });
    try {
      const bundleArgs = (out: string) => [
        "bundle",
        "--config",
        "supabase/functions/api/deno.json",
        "--platform",
        "deno",
        "-o",
        out,
        "supabase/functions/api/index.ts",
      ];
      const a = await run(Deno.execPath(), bundleArgs(outA), repoRoot);
      const b = await run(Deno.execPath(), bundleArgs(outB), worktree);
      assert(a.code === 0 && b.code === 0, `bundle failed: ${a.stderr}\n${b.stderr}`);
      const [bytesA, bytesB] = await Promise.all([Deno.readFile(outA), Deno.readFile(outB)]);
      const digest = async (bytes: Uint8Array<ArrayBuffer>) =>
        Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
          .map((byte) => byte.toString(16).padStart(2, "0"))
          .join("");
      const [shaA, shaB] = await Promise.all([digest(bytesA), digest(bytesB)]);
      assert(
        shaA === shaB,
        `bundle differs by checkout path: ${bytesA.byteLength} B ${shaA} (${repoRoot}) vs ${bytesB.byteLength} B ${shaB} (${worktree}); the bundle embeds paths relative to the npm cache, so the documented size/sha256 are machine-layout dependent`,
      );
    } finally {
      await Deno.remove(outA).catch(() => {});
      await Deno.remove(outB).catch(() => {});
      await run("git", ["worktree", "remove", "--force", worktree]);
    }
  },
);

Deno.test(
  "ATTACK side effects: bundling with the shipping lockfile must not rewrite deno.lock (no break expected)",
  async () => {
    const out = await Deno.makeTempFile({ suffix: ".js" });
    try {
      const bundle = await run(Deno.execPath(), [
        "bundle",
        "--config",
        "supabase/functions/api/deno.json",
        "--platform",
        "deno",
        "-o",
        out,
        "supabase/functions/api/index.ts",
      ]);
      const info = await run(Deno.execPath(), [
        "info",
        "--json",
        "--config",
        "supabase/functions/api/deno.json",
        "supabase/functions/api/index.ts",
      ]);
      assert(bundle.code === 0 && info.code === 0, "bundle/info failed");
      const status = await run("git", [
        "status",
        "--porcelain",
        "--",
        "supabase/functions/api/deno.lock",
      ]);
      assert(status.stdout.trim() === "", `deno.lock modified:\n${status.stdout}`);
    } finally {
      await Deno.remove(out).catch(() => {});
    }
  },
);

Deno.test(
  "ATTACK reproducibility: the recorded `supabase start` command must be the one actually run",
  async () => {
    // Reproducible method means the printed command can be pasted back. Stop the stack so the
    // script has to start it and print the command it used.
    const stop = await run("npx", ["--yes", CLI_SPEC, "stop"]);
    assert(stop.code === 0, `supabase stop failed: ${stop.stderr}`);
    const outDir = await Deno.makeTempDir({ prefix: "h07-attack-startcmd-" });
    try {
      const result = await runScript(["--cycles", "1", "--out", outDir]);
      const startLine = result.stdout
        .split("\n")
        .find((line) => line.includes("starting local stack:"));
      if (startLine === undefined) {
        throw new Error(
          `no start line printed (exit=${result.code}):\n${result.stdout}\n${result.stderr}`,
        );
      }
      const expected = `npx --yes ${CLI_SPEC} start -x `;
      assert(
        startLine.includes(expected) && !startLine.includes(`${CLI_SPEC} ${CLI_SPEC}`),
        `printed start command is not the executed one: ${JSON.stringify(startLine.trim())}`,
      );
      assert(
        result.code === 0,
        `run after cold stack start failed: ${result.stdout}\n${result.stderr}`,
      );
    } finally {
      await restoreCliSideEffects();
      await Deno.remove(outDir, { recursive: true }).catch(() => {});
    }
  },
);
