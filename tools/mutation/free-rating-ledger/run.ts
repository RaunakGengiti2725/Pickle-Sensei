/**
 * Mutation-testing runner for the free-rating identity ledger.
 *
 *   cd tools/mutation/free-rating-ledger && deno task run
 *
 * For every SQL mutant a SCRATCH copy of supabase/migrations is built with the
 * mutant applied, loaded into its own database inside one throwaway Docker
 * postgres:16 (shim_auth.sql + every migration, exactly like
 * supabase/tests/run_rls_tests.sh), and then the EXISTING suites are run
 * against it unmodified:
 *
 *   1. supabase/tests/security_regression.sql         (A..J9, via psql)
 *   2. __wf__/be-edge-routes-shots-rank.test.ts       (live, PICKLE_AUDIT_PG_URL)
 *   3. __wf__/db_migrations_rls_indexes.test.ts       (static pins, on the scratch chain)
 *
 * plus the NEW live probes in probes.ts (race / grants / cap / lapsed premium /
 * backfill), which are reported separately and never decide the verdict.
 *
 * For every TS mutant a scratch copy of supabase/functions/api is built and
 * the edge black-box suite (every test that does not need Postgres) runs
 * against it.
 *
 * Verdict: KILLED iff a pre-existing suite fails (or the mutated migration
 * chain fails to apply). Anything else is SURVIVED, with `caught_by_new_probes`
 * telling whether the additive probes/tests in this campaign catch it.
 *
 * Env:
 *   MUT_SEED=<int>      replayable seed for probe UUIDs / keys (default: time based)
 *   MUT_FILTER=<regex>  run only mutant ids matching
 *   MUT_ONLY=sql|ts     run one family
 *   MUT_PG_PORT=<port>  host port for the throwaway Postgres (default 55499)
 *   MUT_OUT=<dir>       output directory (default artifacts/mutation/free-rating-ledger/<run-id>)
 *   MUT_KEEP_DB=1       keep per-mutant databases (and the container) for inspection
 *   MUT_DENO=<path>     deno binary for the edge suites (default: the current one)
 */
import { copy, ensureDir } from "@std/fs";
import { fromFileUrl, join } from "@std/path";
import { type Edit, LEDGER_MIGRATION, SQL_MUTANTS, type SqlMutant } from "./mutants_sql.ts";
import { EDGE_INDEX, TS_MUTANTS, type TsMutant } from "./mutants_ts.ts";
import { type ProbeResult, runBackfillProbe, runLiveProbes } from "./probes.ts";

const HERE = fromFileUrl(new URL(".", import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const MIGRATIONS = join(REPO, "supabase", "migrations");
const TESTS = join(REPO, "supabase", "tests");
const API = join(REPO, "supabase", "functions", "api");
const WF = join(API, "__wf__");

const env = (k: string, d: string) => Deno.env.get(k) ?? d;
const log = (line: string) => Deno.stdout.writeSync(new TextEncoder().encode(line + "\n"));
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const RUN_ID = env("MUT_RUN_ID", new Date().toISOString().replace(/[:.]/g, "-"));
const SEED = Number(env("MUT_SEED", String(Date.now() % 1_000_000)));
const PORT = Number(env("MUT_PG_PORT", "55499"));
const OUT = env("MUT_OUT", join(REPO, "artifacts", "mutation", "free-rating-ledger", RUN_ID));
const FILTER = Deno.env.get("MUT_FILTER") ? new RegExp(Deno.env.get("MUT_FILTER")!) : null;
const ONLY = env("MUT_ONLY", "all");
const KEEP = Deno.env.get("MUT_KEEP_DB") === "1";
const DENO_BIN = env("MUT_DENO", Deno.execPath());
const CONTAINER = `pickle-mutation-${RUN_ID.toLowerCase().replace(/[^a-z0-9]/g, "")}`;
const PG_PASSWORD = "pg";

interface CmdResult {
  code: number;
  stdout: string;
  stderr: string;
  ms: number;
}

async function run(
  cmd: string[],
  opts: { cwd?: string; env?: Record<string, string> } = {},
): Promise<CmdResult> {
  const started = performance.now();
  const p = new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    cwd: opts.cwd,
    env: opts.env,
    stdout: "piped",
    stderr: "piped",
  });
  const out = await p.output();
  return {
    code: out.code,
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
    ms: Math.round(performance.now() - started),
  };
}

async function writeLog(dir: string, name: string, r: CmdResult, header: string): Promise<string> {
  await ensureDir(dir);
  const path = join(dir, `${name}.log`);
  await Deno.writeTextFile(
    path,
    `# ${header}\n# exit=${r.code} ms=${r.ms}\n\n## stdout\n${r.stdout}\n\n## stderr\n${r.stderr}\n`,
  );
  return path;
}

function applyEdits(source: string, edits: Edit[], id: string): string {
  let text = source;
  for (const e of edits) {
    const parts = text.split(e.find);
    if (parts.length !== 2) {
      throw new Error(
        `${id}: find text occurs ${parts.length - 1} times (must be exactly 1):\n${e.find}`,
      );
    }
    text = parts[0] + e.replace + parts[1];
  }
  return text;
}

// ── docker / postgres helpers ─────────────────────────────────────────────────

async function dockerExec(args: string[]): Promise<CmdResult> {
  return await run(["docker", "exec", CONTAINER, ...args]);
}

async function psqlFile(db: string, file: string): Promise<CmdResult> {
  return await dockerExec([
    "psql",
    "-U",
    "postgres",
    "-d",
    db,
    "-v",
    "ON_ERROR_STOP=1",
    "-q",
    "-f",
    file,
  ]);
}

async function bootContainer(): Promise<void> {
  const r = await run([
    "docker",
    "run",
    "-d",
    "--rm",
    "--name",
    CONTAINER,
    "-p",
    `127.0.0.1:${PORT}:5432`,
    "-e",
    `POSTGRES_PASSWORD=${PG_PASSWORD}`,
    "postgres:16",
  ]);
  if (r.code !== 0) throw new Error(`docker run failed: ${r.stderr}`);
  for (let i = 0; i < 60; i++) {
    const ready = await dockerExec(["pg_isready", "-U", "postgres"]);
    if (ready.code === 0) {
      // pg_isready can pass during the init restart; confirm a real query.
      const q = await dockerExec(["psql", "-U", "postgres", "-Atc", "select 1"]);
      if (q.code === 0 && q.stdout.trim() === "1") break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  const mk = await dockerExec(["mkdir", "-p", "/mut"]);
  if (mk.code !== 0) throw new Error(mk.stderr);
  const cp = await run(["docker", "cp", TESTS, `${CONTAINER}:/tests`]);
  if (cp.code !== 0) throw new Error(`docker cp tests failed: ${cp.stderr}`);
}

async function teardownContainer(): Promise<void> {
  if (KEEP) {
    log(`MUT_KEEP_DB=1 → container ${CONTAINER} left running on 127.0.0.1:${PORT}`);
    return;
  }
  await run(["docker", "rm", "-f", CONTAINER]);
}

async function createDb(db: string): Promise<void> {
  const r = await dockerExec([
    "psql",
    "-U",
    "postgres",
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    `create database "${db}"`,
  ]);
  if (r.code !== 0) throw new Error(`create database ${db}: ${r.stderr}`);
}

async function dropDb(db: string): Promise<void> {
  if (KEEP) return;
  await dockerExec([
    "psql",
    "-U",
    "postgres",
    "-c",
    `drop database if exists "${db}" with (force)`,
  ]);
}

const pgUrl = (db: string) => `postgres://postgres:${PG_PASSWORD}@127.0.0.1:${PORT}/${db}`;

/** Applies shim + the given migration files (container paths) in order. */
async function applyChain(db: string, files: string[]): Promise<CmdResult> {
  const started = performance.now();
  const shim = await psqlFile(db, "/tests/shim_auth.sql");
  if (shim.code !== 0) return { ...shim, ms: Math.round(performance.now() - started) };
  let stdout = shim.stdout;
  let stderr = shim.stderr;
  for (const f of files) {
    const r = await psqlFile(db, f);
    stdout += `\n-- ${f}\n${r.stdout}`;
    stderr += r.stderr ? `\n-- ${f}\n${r.stderr}` : "";
    if (r.code !== 0)
      return { code: r.code, stdout, stderr, ms: Math.round(performance.now() - started) };
  }
  return { code: 0, stdout, stderr, ms: Math.round(performance.now() - started) };
}

// ── result shapes ─────────────────────────────────────────────────────────────

interface Stage {
  ran: boolean;
  passed: boolean | null;
  exit: number | null;
  ms: number | null;
  log: string | null;
  /** Failing test names / first failing SQL case. */
  failures: string[];
  command: string;
}

interface MutantResult {
  id: string;
  kind: "sql" | "ts" | "baseline";
  target: string;
  description: string;
  expect: string;
  diff: string | null;
  stages: Record<string, Stage>;
  probes: ProbeResult[];
  killed_by_existing: string[];
  caught_by_new_probes: string[];
  verdict: "KILLED" | "SURVIVED" | "BASELINE_OK" | "BASELINE_BROKEN" | "HARNESS_ERROR";
  error?: string;
}

const notRun = (command: string): Stage => ({
  ran: false,
  passed: null,
  exit: null,
  ms: null,
  log: null,
  failures: [],
  command,
});

function denoFailures(output: string): string[] {
  const names = new Set<string>();
  for (const line of output.split("\n")) {
    // "name ... FAILED (12ms)"
    const m = /^(.*?) \.\.\. FAILED/.exec(stripAnsi(line));
    if (m) names.add(m[1].trim());
  }
  return [...names];
}

function stripAnsi(s: string): string {
  return s.replace(ANSI, "");
}

/** Attributes deno failures to files using the "name => ./file.ts:line" lines. */
function denoFailureFiles(output: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const line of stripAnsi(output).split("\n")) {
    const m = /^(.*?) => \.\/(\S+?\.ts):\d+:\d+$/.exec(line.trim());
    if (m) map[m[1].trim()] = m[2];
  }
  return map;
}

function sqlFirstFailure(stderr: string): string[] {
  const m = /ERROR:\s+(.*)/.exec(stderr);
  return m ? [m[1].trim()] : [];
}

// ── SQL family ────────────────────────────────────────────────────────────────

let migrationFiles: string[] = [];

async function buildScratchMigrations(
  id: string,
  mutant: SqlMutant | null,
): Promise<{ dir: string; diff: string | null }> {
  const dir = join(OUT, "scratch", id, "supabase", "migrations");
  await ensureDir(dir);
  for (const f of migrationFiles) {
    let text = await Deno.readTextFile(join(MIGRATIONS, f));
    if (mutant && f === LEDGER_MIGRATION) text = applyEdits(text, mutant.edits, id);
    await Deno.writeTextFile(join(dir, f), text);
  }
  let diffPath: string | null = null;
  if (mutant) {
    await ensureDir(join(OUT, "mutants"));
    diffPath = join(OUT, "mutants", `${id}.diff`);
    const d = await run([
      "diff",
      "-u",
      join(MIGRATIONS, LEDGER_MIGRATION),
      join(dir, LEDGER_MIGRATION),
    ]);
    await Deno.writeTextFile(diffPath, d.stdout);
    await Deno.writeTextFile(
      join(OUT, "mutants", `${id}.sql`),
      await Deno.readTextFile(join(dir, LEDGER_MIGRATION)),
    );
  }
  // Scratch __wf__ for the static pin test (resolves ../../../migrations).
  const wf = join(OUT, "scratch", id, "supabase", "functions", "api", "__wf__");
  await ensureDir(wf);
  await Deno.copyFile(
    join(WF, "db_migrations_rls_indexes.test.ts"),
    join(wf, "db_migrations_rls_indexes.test.ts"),
  );
  await Deno.copyFile(join(WF, "deno.json"), join(wf, "deno.json"));
  return { dir, diff: diffPath };
}

async function runSqlMutant(mutant: SqlMutant | null): Promise<MutantResult> {
  const id = mutant ? mutant.id : "S00_baseline";
  const logDir = join(OUT, "logs", id);
  const db = `m_${id.toLowerCase()}`;
  const bdb = `b_${id.toLowerCase()}`;
  const result: MutantResult = {
    id,
    kind: mutant ? "sql" : "baseline",
    target: mutant ? mutant.target : "baseline",
    description: mutant ? mutant.description : "unmodified migration chain (control)",
    expect: mutant ? mutant.expect : "pass",
    diff: null,
    stages: {
      migrate: notRun(`psql -f /tests/shim_auth.sql && for f in /mut/${id}/*.sql; psql -f $f`),
      edge_live: notRun(
        `PICKLE_AUDIT_PG_URL=${pgUrl(db)} deno test -A --no-check --config deno.json be-edge-routes-shots-rank.test.ts`,
      ),
      security_regression: notRun(
        `psql -d ${db} -v ON_ERROR_STOP=1 -q -f /tests/security_regression.sql`,
      ),
      edge_static: notRun(
        `deno test -A --no-check --config deno.json db_migrations_rls_indexes.test.ts  (cwd: scratch/${id}/supabase/functions/api/__wf__)`,
      ),
      backfill_probe: notRun(
        `shim + migrations < ${LEDGER_MIGRATION} → seed → ${LEDGER_MIGRATION} → assert ledger`,
      ),
    },
    probes: [],
    killed_by_existing: [],
    caught_by_new_probes: [],
    verdict: "SURVIVED",
  };
  log(`\n=== ${id} ${mutant ? `— ${mutant.description}` : "(baseline)"}`);
  try {
    const { dir, diff } = await buildScratchMigrations(id, mutant);
    result.diff = diff;
    const cp = await run(["docker", "cp", dir, `${CONTAINER}:/mut/${id}`]);
    if (cp.code !== 0) throw new Error(`docker cp: ${cp.stderr}`);
    const containerFiles = migrationFiles.map((f) => `/mut/${id}/${f}`);

    // 1. migrate
    await createDb(db);
    const mig = await applyChain(db, containerFiles);
    result.stages.migrate = {
      ran: true,
      passed: mig.code === 0,
      exit: mig.code,
      ms: mig.ms,
      log: await writeLog(logDir, "migrate", mig, result.stages.migrate.command),
      failures: mig.code === 0 ? [] : sqlFirstFailure(mig.stderr),
      command: result.stages.migrate.command,
    };
    log(
      `  migrate: exit=${mig.code} (${mig.ms}ms)${mig.code ? " " + result.stages.migrate.failures[0] : ""}`,
    );

    if (mig.code === 0) {
      // 2. live edge tests (transactions roll back → DB stays pristine for 3.)
      const live = await run(
        [
          DENO_BIN,
          "test",
          "-A",
          "--no-check",
          "--config",
          "deno.json",
          "be-edge-routes-shots-rank.test.ts",
        ],
        { cwd: WF, env: { PICKLE_AUDIT_PG_URL: pgUrl(db), HOME: Deno.env.get("HOME") ?? "/tmp" } },
      );
      result.stages.edge_live = {
        ran: true,
        passed: live.code === 0,
        exit: live.code,
        ms: live.ms,
        log: await writeLog(logDir, "edge_live", live, result.stages.edge_live.command),
        failures: denoFailures(live.stdout + live.stderr),
        command: result.stages.edge_live.command,
      };
      log(
        `  edge_live: exit=${live.code} (${live.ms}ms) ${result.stages.edge_live.failures.join(" | ")}`,
      );

      // 3. security_regression.sql
      const sec = await psqlFile(db, "/tests/security_regression.sql");
      result.stages.security_regression = {
        ran: true,
        passed: sec.code === 0 && sec.stdout.includes("ALL CASES PASSED"),
        exit: sec.code,
        ms: sec.ms,
        log: await writeLog(
          logDir,
          "security_regression",
          sec,
          result.stages.security_regression.command,
        ),
        failures: sec.code === 0 ? [] : sqlFirstFailure(sec.stderr),
        command: result.stages.security_regression.command,
      };
      log(
        `  security_regression: exit=${sec.code} (${sec.ms}ms) ${result.stages.security_regression.failures.join(" | ")}`,
      );

      // 5. new live probes (after the matrix so its fixtures are untouched)
      result.probes = await runLiveProbes(pgUrl(db), SEED);
      for (const p of result.probes)
        log(
          `  probe ${p.id}: ${p.passed ? "pass" : "FAIL"} — ${p.detail}${p.error ? " :: " + p.error : ""}`,
        );
    }

    // 4. static pins on the scratch chain (independent of the DB)
    const wf = join(OUT, "scratch", id, "supabase", "functions", "api", "__wf__");
    const st = await run(
      [
        DENO_BIN,
        "test",
        "-A",
        "--no-check",
        "--config",
        "deno.json",
        "db_migrations_rls_indexes.test.ts",
      ],
      { cwd: wf, env: { HOME: Deno.env.get("HOME") ?? "/tmp" } },
    );
    result.stages.edge_static = {
      ran: true,
      passed: st.code === 0,
      exit: st.code,
      ms: st.ms,
      log: await writeLog(logDir, "edge_static", st, result.stages.edge_static.command),
      failures: denoFailures(st.stdout + st.stderr),
      command: result.stages.edge_static.command,
    };
    log(
      `  edge_static: exit=${st.code} (${st.ms}ms) ${result.stages.edge_static.failures.join(" | ")}`,
    );

    // 6. backfill probe: pre-ledger chain, seed, then the (mutated) ledger migration.
    const before = containerFiles.filter((f) => !f.endsWith(LEDGER_MIGRATION));
    const after = containerFiles.filter((f) => f.endsWith(LEDGER_MIGRATION));
    await createDb(bdb);
    const pre = await applyChain(bdb, before);
    let bfLog = `# pre-ledger chain exit=${pre.code}\n${pre.stderr}\n`;
    let bf: ProbeResult;
    if (pre.code !== 0) {
      bf = {
        id: "P7_backfill_pre_existing_scored_shots",
        passed: false,
        detail: "pre-ledger chain failed to apply",
        seed: {},
        error: pre.stderr,
      };
    } else {
      let restExit: number | null = null;
      let restErr = "";
      bf = await runBackfillProbe(pgUrl(bdb), SEED, async () => {
        for (const f of after) {
          const r = await psqlFile(bdb, f);
          restExit = r.code;
          restErr += r.stderr;
          if (r.code !== 0) throw new Error(`ledger migration failed to apply: ${r.stderr}`);
        }
      });
      bfLog += `# ledger migration exit=${restExit}\n${restErr}\n# probe: ${JSON.stringify(bf)}\n`;
    }
    await ensureDir(logDir);
    const bfPath = join(logDir, "backfill_probe.log");
    await Deno.writeTextFile(bfPath, bfLog);
    result.stages.backfill_probe = {
      ran: true,
      passed: bf.passed,
      exit: bf.passed ? 0 : 1,
      ms: null,
      log: bfPath,
      failures: bf.passed ? [] : [bf.detail + (bf.error ? ` :: ${bf.error}` : "")],
      command: result.stages.backfill_probe.command,
    };
    result.probes.push(bf);
    log(
      `  backfill_probe: ${bf.passed ? "pass" : "FAIL"} — ${bf.detail}${bf.error ? " :: " + bf.error : ""}`,
    );

    // verdict
    for (const name of ["migrate", "edge_live", "security_regression", "edge_static"]) {
      const s = result.stages[name];
      if (s.ran && s.passed === false) result.killed_by_existing.push(name);
    }
    result.caught_by_new_probes = result.probes.filter((p) => !p.passed).map((p) => p.id);
    if (!mutant) {
      result.verdict =
        result.killed_by_existing.length === 0 && result.caught_by_new_probes.length === 0
          ? "BASELINE_OK"
          : "BASELINE_BROKEN";
    } else {
      result.verdict = result.killed_by_existing.length > 0 ? "KILLED" : "SURVIVED";
    }
  } catch (error) {
    result.verdict = "HARNESS_ERROR";
    result.error = String(error);
    log(`  HARNESS_ERROR: ${result.error}`);
  } finally {
    await dropDb(db);
    await dropDb(bdb);
  }
  log(
    `  → ${result.verdict}${result.killed_by_existing.length ? " by " + result.killed_by_existing.join(",") : ""}${result.caught_by_new_probes.length ? " | new probes: " + result.caught_by_new_probes.join(",") : ""}`,
  );
  return result;
}

// ── TS family ─────────────────────────────────────────────────────────────────

const NEW_EDGE_TEST = "free_rating_access_payload.test.ts";
const EXCLUDED_EDGE_TESTS = new Set([
  "db_migrations_rls_indexes.audit.test.ts", // boots its own docker (schema, not index.ts)
  "db_migrations_rls_indexes.test.ts", // static migration pins (not index.ts)
  "be-edge-routes-shots-rank.test.ts", // live DB RPC tests (not index.ts)
]);

async function edgeTestFiles(): Promise<string[]> {
  const files: string[] = [];
  for await (const e of Deno.readDir(WF)) {
    if (!e.isFile) continue;
    if (!(e.name.endsWith(".test.ts") || e.name.endsWith("_test.ts"))) continue;
    if (EXCLUDED_EDGE_TESTS.has(e.name)) continue;
    files.push(e.name);
  }
  return files.sort();
}

async function runTsMutant(mutant: TsMutant | null): Promise<MutantResult> {
  const id = mutant ? mutant.id : "T00_baseline";
  const logDir = join(OUT, "logs", id);
  const scratchApi = join(OUT, "scratch", id, "supabase", "functions", "api");
  const files = await edgeTestFiles();
  const command = `deno test -A --no-check --config deno.json ${files.join(" ")}  (cwd: scratch/${id}/supabase/functions/api/__wf__)`;
  const result: MutantResult = {
    id,
    kind: mutant ? "ts" : "baseline",
    target: mutant ? mutant.target : "baseline",
    description: mutant ? mutant.description : "unmodified supabase/functions/api (control)",
    expect: mutant ? mutant.expect : "pass",
    diff: null,
    stages: { edge_suite: notRun(command) },
    probes: [],
    killed_by_existing: [],
    caught_by_new_probes: [],
    verdict: "SURVIVED",
  };
  log(`\n=== ${id} ${mutant ? `— ${mutant.description}` : "(baseline)"}`);
  try {
    await ensureDir(join(OUT, "scratch", id, "supabase", "functions"));
    await copy(API, scratchApi, { overwrite: true });
    if (mutant) {
      const src = await Deno.readTextFile(join(API, EDGE_INDEX));
      const mutated = applyEdits(src, mutant.edits, id);
      await Deno.writeTextFile(join(scratchApi, EDGE_INDEX), mutated);
      await ensureDir(join(OUT, "mutants"));
      result.diff = join(OUT, "mutants", `${id}.diff`);
      const d = await run(["diff", "-u", join(API, EDGE_INDEX), join(scratchApi, EDGE_INDEX)]);
      await Deno.writeTextFile(result.diff, d.stdout);
    }
    const r = await run([DENO_BIN, "test", "-A", "--no-check", "--config", "deno.json", ...files], {
      cwd: join(scratchApi, "__wf__"),
      env: { HOME: Deno.env.get("HOME") ?? "/tmp" },
    });
    const failures = denoFailures(r.stdout + r.stderr);
    const byFile = denoFailureFiles(r.stdout + r.stderr);
    result.stages.edge_suite = {
      ran: true,
      passed: r.code === 0,
      exit: r.code,
      ms: r.ms,
      log: await writeLog(logDir, "edge_suite", r, command),
      failures,
      command,
    };
    const existing = failures.filter((n) => byFile[n] !== NEW_EDGE_TEST);
    const fresh = failures.filter((n) => byFile[n] === NEW_EDGE_TEST);
    // A failure we could not attribute to a file counts as existing (conservative
    // for the "new tests caught it" claim, never for the kill claim).
    if (existing.length > 0) result.killed_by_existing.push("edge_suite");
    result.caught_by_new_probes = fresh.map((n) => `${NEW_EDGE_TEST}: ${n}`);
    if (r.code !== 0 && failures.length === 0)
      result.killed_by_existing.push("edge_suite(exit≠0, no test names parsed)");
    log(
      `  edge_suite: exit=${r.code} (${r.ms}ms) existing_failures=${existing.length} new_test_failures=${fresh.length}`,
    );
    for (const n of failures) log(`    FAILED [${byFile[n] ?? "?"}] ${n}`);
    if (!mutant) {
      result.verdict = r.code === 0 ? "BASELINE_OK" : "BASELINE_BROKEN";
    } else {
      result.verdict = result.killed_by_existing.length > 0 ? "KILLED" : "SURVIVED";
    }
  } catch (error) {
    result.verdict = "HARNESS_ERROR";
    result.error = String(error);
    log(`  HARNESS_ERROR: ${result.error}`);
  }
  log(
    `  → ${result.verdict}${result.caught_by_new_probes.length ? " | new test kills: " + result.caught_by_new_probes.length : ""}`,
  );
  return result;
}

// ── reporting ─────────────────────────────────────────────────────────────────

function matrixMarkdown(results: MutantResult[], meta: Record<string, unknown>): string {
  const lines: string[] = [];
  lines.push(`# Free-rating identity ledger — mutation matrix`);
  lines.push("");
  lines.push(`run_id: ${meta.run_id}  seed: ${meta.seed}  commit: ${meta.commit}`);
  lines.push(`started: ${meta.started}  finished: ${meta.finished}`);
  lines.push("");
  const sql = results.filter((r) => r.kind === "sql");
  const ts = results.filter((r) => r.kind === "ts");
  const count = (arr: MutantResult[], v: string) => arr.filter((r) => r.verdict === v).length;
  lines.push(
    `SQL mutants: ${sql.length} — KILLED ${count(sql, "KILLED")}, SURVIVED ${count(sql, "SURVIVED")}, HARNESS_ERROR ${count(sql, "HARNESS_ERROR")}`,
  );
  lines.push(
    `  survivors caught only by the new probes: ${sql.filter((r) => r.verdict === "SURVIVED" && r.caught_by_new_probes.length > 0).length}`,
  );
  lines.push(
    `  survivors flagged equivalent by the author: ${sql.filter((r) => r.verdict === "SURVIVED" && r.expect === "equivalent").length}`,
  );
  lines.push(
    `TS mutants: ${ts.length} — KILLED ${count(ts, "KILLED")}, SURVIVED ${count(ts, "SURVIVED")}, HARNESS_ERROR ${count(ts, "HARNESS_ERROR")}`,
  );
  lines.push(
    `  survivors caught only by the new edge test: ${ts.filter((r) => r.verdict === "SURVIVED" && r.caught_by_new_probes.length > 0).length}`,
  );
  lines.push("");
  lines.push(
    `## SQL mutants (existing suites: migrate / security_regression.sql / be-edge live / static pins)`,
  );
  lines.push("");
  lines.push(
    `| id | target | verdict | killed by (existing) | first failure | new probes that catch it | prior |`,
  );
  lines.push(`|---|---|---|---|---|---|---|`);
  for (const r of [
    ...results.filter((r) => r.kind === "baseline" && r.id.startsWith("S")),
    ...sql,
  ]) {
    const first = Object.values(r.stages).flatMap((s) => s.failures)[0] ?? "";
    lines.push(
      `| ${r.id} | ${r.target} | ${r.verdict} | ${r.killed_by_existing.join(", ")} | ${first.replace(/\|/g, "\\|").slice(0, 140)} | ${r.caught_by_new_probes.join(", ")} | ${r.expect} |`,
    );
  }
  lines.push("");
  lines.push(
    `## TS mutants (existing edge black-box suite; the new free_rating_access_payload.test.ts is reported separately)`,
  );
  lines.push("");
  lines.push(`| id | target | verdict | existing failures | new-test failures | prior |`);
  lines.push(`|---|---|---|---|---|---|`);
  for (const r of [
    ...results.filter((r) => r.kind === "baseline" && r.id.startsWith("T")),
    ...ts,
  ]) {
    const existing =
      r.stages.edge_suite?.failures.filter(
        (n) => !r.caught_by_new_probes.includes(`${NEW_EDGE_TEST}: ${n}`),
      ) ?? [];
    lines.push(
      `| ${r.id} | ${r.target} | ${r.verdict} | ${existing.length} | ${r.caught_by_new_probes.length} | ${r.expect} |`,
    );
  }
  lines.push("");
  lines.push(`## Descriptions`);
  lines.push("");
  for (const r of results)
    lines.push(
      `- **${r.id}** (${r.kind}/${r.target}): ${r.description}${r.diff ? ` — diff: ${r.diff}` : ""}`,
    );
  return lines.join("\n") + "\n";
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const started = new Date().toISOString();
  await ensureDir(OUT);
  const commit = (await run(["git", "rev-parse", "HEAD"], { cwd: REPO })).stdout.trim();
  migrationFiles = [];
  for await (const e of Deno.readDir(MIGRATIONS))
    if (e.isFile && e.name.endsWith(".sql")) migrationFiles.push(e.name);
  migrationFiles.sort();
  if (!migrationFiles.includes(LEDGER_MIGRATION)) throw new Error(`missing ${LEDGER_MIGRATION}`);

  const sqlMutants = SQL_MUTANTS.filter((m) => !FILTER || FILTER.test(m.id));
  const tsMutants = TS_MUTANTS.filter((m) => !FILTER || FILTER.test(m.id));
  const ids = new Set([...SQL_MUTANTS, ...TS_MUTANTS].map((m) => m.id));
  if (ids.size !== SQL_MUTANTS.length + TS_MUTANTS.length) throw new Error("duplicate mutant ids");

  log(
    `run_id=${RUN_ID} seed=${SEED} commit=${commit}\nout=${OUT}\nsql=${sqlMutants.length} ts=${tsMutants.length} only=${ONLY}`,
  );
  const results: MutantResult[] = [];

  if (ONLY === "all" || ONLY === "sql") {
    await bootContainer();
    try {
      const base = await runSqlMutant(null);
      results.push(base);
      if (base.verdict !== "BASELINE_OK") {
        log(
          "SQL baseline is not clean — mutant verdicts would be meaningless; stopping SQL family.",
        );
      } else {
        for (const m of sqlMutants) results.push(await runSqlMutant(m));
      }
    } finally {
      await teardownContainer();
    }
  }
  if (ONLY === "all" || ONLY === "ts") {
    const base = await runTsMutant(null);
    results.push(base);
    if (base.verdict !== "BASELINE_OK") {
      log("TS baseline is not clean — stopping TS family.");
    } else {
      for (const m of tsMutants) results.push(await runTsMutant(m));
    }
  }

  const finished = new Date().toISOString();
  const meta = {
    run_id: RUN_ID,
    seed: SEED,
    commit,
    started,
    finished,
    deno: Deno.version.deno,
    postgres_image: "postgres:16",
    replay: `MUT_SEED=${SEED} MUT_RUN_ID=<new> deno task run`,
  };
  const summary = {
    sql: {
      total: results.filter((r) => r.kind === "sql").length,
      killed: results.filter((r) => r.kind === "sql" && r.verdict === "KILLED").length,
      survived: results.filter((r) => r.kind === "sql" && r.verdict === "SURVIVED").length,
      survived_caught_by_new_probes: results.filter(
        (r) => r.kind === "sql" && r.verdict === "SURVIVED" && r.caught_by_new_probes.length > 0,
      ).length,
      survived_equivalent_prior: results.filter(
        (r) => r.kind === "sql" && r.verdict === "SURVIVED" && r.expect === "equivalent",
      ).length,
      harness_error: results.filter((r) => r.kind === "sql" && r.verdict === "HARNESS_ERROR")
        .length,
    },
    ts: {
      total: results.filter((r) => r.kind === "ts").length,
      killed: results.filter((r) => r.kind === "ts" && r.verdict === "KILLED").length,
      survived: results.filter((r) => r.kind === "ts" && r.verdict === "SURVIVED").length,
      survived_caught_by_new_test: results.filter(
        (r) => r.kind === "ts" && r.verdict === "SURVIVED" && r.caught_by_new_probes.length > 0,
      ).length,
      harness_error: results.filter((r) => r.kind === "ts" && r.verdict === "HARNESS_ERROR").length,
    },
    baselines: results
      .filter((r) => r.kind === "baseline")
      .map((r) => ({ id: r.id, verdict: r.verdict })),
  };
  await Deno.writeTextFile(
    join(OUT, "results.json"),
    JSON.stringify({ meta, summary, results }, null, 2),
  );
  await Deno.writeTextFile(join(OUT, "matrix.md"), matrixMarkdown(results, meta));
  log(
    `\n${JSON.stringify(summary, null, 2)}\nresults: ${join(OUT, "results.json")}\nmatrix:  ${join(OUT, "matrix.md")}`,
  );
  const broken = results.some(
    (r) => r.verdict === "BASELINE_BROKEN" || r.verdict === "HARNESS_ERROR",
  );
  return broken ? 2 : 0;
}

Deno.exit(await main());
