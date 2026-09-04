// Mutation runner for the RevenueCat webhook + billing entitlement sync.
//
//   cd supabase/functions/api/__wf__
//   deno run -A mutation/run_mutations.ts --mode existing --out /tmp/mut/existing
//   deno run -A mutation/run_mutations.ts --mode all      --out /tmp/mut/all
//   deno run -A mutation/run_mutations.ts --check                 # validate anchors only
//   deno run -A mutation/run_mutations.ts --only SEC-01-skip-secret-check,DUP-01-dedupe-removed
//
// For every mutant in mutation/mutants.ts the runner:
//   1. copies supabase/functions/api/ into a throwaway root that mirrors the
//      repo layout (supabase/migrations and packages/ are symlinked, because
//      db_migrations_rls_indexes.test.ts and be-edge-routes-shots-rank.test.ts
//      reach across the tree),
//   2. applies exactly one textual substitution to the COPY (the checked-in
//      source is never modified; an anchor that does not occur exactly once
//      marks the mutant `invalid` — it is not counted as killed),
//   3. runs `deno test -A --no-check --config deno.json .` inside the copied
//      __wf__ (the same command as `deno task test`), serially — router_test.ts
//      boots the function on a fixed :8000 so runs cannot overlap,
//   4. records exit code, pass/fail/ignore counts, the failing test names and
//      the full log for every run.
//
// `--mode existing` deletes `*_attack.test.ts` from the copy so the verdict
// reflects only the tests that were already in the tree at the start commit;
// `--mode all` keeps them. An unmutated BASELINE run is always executed first
// and must exit 0 — otherwise the run aborts, since kills would be meaningless.
//
// A mutant is `killed` when the suite exits non-zero WITH a parsable summary
// line (i.e. tests actually failed); `survived` when it exits 0; `error` when
// deno produced no summary (module failed to load) — reported separately and
// never counted as a kill.

import { MUTANTS, type Mutant } from "./mutants.ts";

interface RunRecord {
  id: string;
  category: string;
  file: string;
  description: string;
  expectExisting: string;
  status: "baseline-ok" | "baseline-failed" | "killed" | "survived" | "invalid" | "error";
  exitCode: number | null;
  passed: number | null;
  failed: number | null;
  ignored: number | null;
  failingTests: string[];
  killedByAttackTest: boolean | null;
  durationMs: number;
  log: string;
  anchorOccurrences: number;
}

const args = parseArgs(Deno.args);
const mode = (args.mode ?? "all") as "existing" | "all";
if (mode !== "existing" && mode !== "all") {
  console.error(`--mode must be existing|all (got ${mode})`);
  Deno.exit(2);
}
const checkOnly = args.check === "true";
const only = args.only
  ? new Set(
      args.only
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    )
  : null;
const apiDir = new URL("../../", import.meta.url);
const repoRoot = new URL("../../../../../", import.meta.url);
const outDir = args.out ?? `${Deno.makeTempDirSync({ prefix: "mutation-edge-webhook-" })}`;
await Deno.mkdir(outDir, { recursive: true });
const logDir = `${outDir}/logs`;
await Deno.mkdir(logDir, { recursive: true });

const startedAt = new Date().toISOString();
const gitSha = await shell(["git", "rev-parse", "HEAD"], fromUrl(repoRoot));
const denoVersion = await shell(["deno", "--version"], fromUrl(repoRoot));

// ── 1. anchor validation ────────────────────────────────────────────────────
const sources: Record<string, string> = {};
for (const file of ["index.ts", "http.ts"]) {
  sources[file] = await Deno.readTextFile(new URL(file, apiDir));
}
const anchorReport: Array<{ id: string; file: string; occurrences: number }> = [];
for (const mutant of MUTANTS) {
  const occurrences = countOccurrences(sources[mutant.file], mutant.find);
  anchorReport.push({ id: mutant.id, file: mutant.file, occurrences });
}
const duplicateIds = MUTANTS.map((m) => m.id).filter((id, i, all) => all.indexOf(id) !== i);
if (duplicateIds.length) {
  console.error(`duplicate mutant ids: ${duplicateIds.join(", ")}`);
  Deno.exit(2);
}
const badAnchors = anchorReport.filter((a) => a.occurrences !== 1);
if (checkOnly) {
  console.log(JSON.stringify({ anchors: anchorReport, bad: badAnchors }, null, 2));
  Deno.exit(badAnchors.length ? 1 : 0);
}

// ── 2. baseline ─────────────────────────────────────────────────────────────
const records: RunRecord[] = [];
const baseline = await runVariant(null);
records.push(baseline);
console.log(
  `[baseline] exit=${baseline.exitCode} passed=${baseline.passed} failed=${baseline.failed}`,
);
if (baseline.status !== "baseline-ok") {
  await writeOutputs(records, "aborted: baseline failed");
  console.error("baseline failed — aborting (see logs/BASELINE.log)");
  Deno.exit(1);
}

// ── 3. mutants ──────────────────────────────────────────────────────────────
const selected = MUTANTS.filter((m) => !only || only.has(m.id));
for (const mutant of selected) {
  const occurrences = countOccurrences(sources[mutant.file], mutant.find);
  if (occurrences !== 1) {
    records.push({
      ...emptyRecord(mutant),
      status: "invalid",
      anchorOccurrences: occurrences,
    });
    console.log(`[${mutant.id}] INVALID anchor occurrences=${occurrences}`);
    continue;
  }
  const rec = await runVariant(mutant);
  records.push(rec);
  console.log(
    `[${mutant.id}] ${rec.status.toUpperCase()} exit=${rec.exitCode} failed=${rec.failed} ` +
      `(${(rec.durationMs / 1000).toFixed(1)}s)` +
      (rec.failingTests.length ? `\n    ${rec.failingTests.join("\n    ")}` : ""),
  );
  await writeOutputs(records, "in-progress");
}
await writeOutputs(records, "complete");
const mutants = records.filter((r) => r.id !== "BASELINE");
const killed = mutants.filter((r) => r.status === "killed").length;
const survived = mutants.filter((r) => r.status === "survived").length;
const other = mutants.length - killed - survived;
console.log(
  `\nmode=${mode} mutants=${mutants.length} killed=${killed} survived=${survived} ` +
    `invalid/error=${other} score=${mutants.length ? ((100 * killed) / mutants.length).toFixed(1) : "n/a"}%` +
    `\noutputs: ${outDir}/results.json ${outDir}/results.md`,
);
Deno.exit(survived || other ? 1 : 0);

// ── helpers ─────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = "true";
    }
  }
  return out;
}

function fromUrl(url: URL): string {
  return decodeURIComponent(url.pathname).replace(/\/$/, "");
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count += 1;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

async function shell(cmd: string[], cwd: string): Promise<string> {
  const out = await new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return new TextDecoder().decode(out.stdout).trim();
}

function emptyRecord(mutant: Mutant | null): RunRecord {
  return {
    id: mutant?.id ?? "BASELINE",
    category: mutant?.category ?? "baseline",
    file: mutant?.file ?? "-",
    description: mutant?.description ?? "unmutated source",
    expectExisting: mutant?.expect ?? "-",
    status: "error",
    exitCode: null,
    passed: null,
    failed: null,
    ignored: null,
    failingTests: [],
    killedByAttackTest: null,
    durationMs: 0,
    log: "",
    anchorOccurrences: 1,
  };
}

async function runVariant(mutant: Mutant | null): Promise<RunRecord> {
  const rec = emptyRecord(mutant);
  const started = performance.now();
  const root = await Deno.makeTempDir({ prefix: `mut-${rec.id}-` });
  try {
    // Mirror the repo layout so cross-tree imports/reads resolve.
    await Deno.mkdir(`${root}/supabase/functions`, { recursive: true });
    await copyDir(fromUrl(apiDir), `${root}/supabase/functions/api`);
    // Real copies, not symlinks: the db audit test `docker cp`s these dirs
    // into a container and docker cp does not follow symlinks.
    await copyDir(`${fromUrl(repoRoot)}/supabase/migrations`, `${root}/supabase/migrations`);
    await copyDir(`${fromUrl(repoRoot)}/supabase/tests`, `${root}/supabase/tests`);
    await Deno.symlink(`${fromUrl(repoRoot)}/packages`, `${root}/packages`);
    const copiedWf = `${root}/supabase/functions/api/__wf__`;
    // The runner itself must never be collected as a test in the copy.
    await Deno.remove(`${copiedWf}/mutation`, { recursive: true });
    if (mode === "existing") {
      for await (const entry of Deno.readDir(copiedWf)) {
        if (entry.isFile && entry.name.endsWith("_attack.test.ts")) {
          await Deno.remove(`${copiedWf}/${entry.name}`);
        }
      }
    }
    if (mutant) {
      const target = `${root}/supabase/functions/api/${mutant.file}`;
      const source = await Deno.readTextFile(target);
      const occurrences = countOccurrences(source, mutant.find);
      rec.anchorOccurrences = occurrences;
      if (occurrences !== 1) {
        rec.status = "invalid";
        return rec;
      }
      await Deno.writeTextFile(target, source.replace(mutant.find, mutant.replace));
    }
    const proc = await new Deno.Command("deno", {
      args: ["test", "-A", "--no-check", "--config", "deno.json", "."],
      cwd: copiedWf,
      env: { NO_COLOR: "1" },
      stdout: "piped",
      stderr: "piped",
    }).output();
    const text =
      new TextDecoder().decode(proc.stdout) + "\n" + new TextDecoder().decode(proc.stderr);
    const logPath = `${logDir}/${rec.id}.log`;
    await Deno.writeTextFile(logPath, text);
    rec.log = logPath;
    rec.exitCode = proc.code;
    const summary =
      /(?:ok|FAILED) \| (\d+) passed(?: \((\d+) steps?\))? \| (\d+) failed(?: \((\d+) steps?\))? \| (\d+) ignored/.exec(
        text,
      ) ??
      /(?:ok|FAILED) \| (\d+) passed(?: \((\d+) steps?\))? \| (\d+) failed(?: \((\d+) steps?\))?/.exec(
        text,
      );
    if (summary) {
      rec.passed = Number(summary[1]);
      rec.failed = Number(summary[3]);
      rec.ignored = summary[5] !== undefined ? Number(summary[5]) : 0;
    }
    rec.failingTests = parseFailures(text);
    if (!mutant) {
      rec.status = proc.code === 0 && summary ? "baseline-ok" : "baseline-failed";
    } else if (!summary) {
      rec.status = "error";
    } else if (proc.code === 0) {
      rec.status = "survived";
    } else {
      rec.status = "killed";
      rec.killedByAttackTest = rec.failingTests.some((t) => t.includes("_attack.test.ts"));
    }
    return rec;
  } finally {
    rec.durationMs = Math.round(performance.now() - started);
    await Deno.remove(root, { recursive: true }).catch(() => undefined);
  }
}

/** Failure names from the `FAILURES` block: `name => ./file.ts:line:col`. */
function parseFailures(text: string): string[] {
  const idx = text.indexOf("\n FAILURES ");
  if (idx === -1) return [];
  const block = text.slice(idx);
  const names: string[] = [];
  for (const line of block.split("\n")) {
    const m = /^(.+?) => (\.\/\S+\.ts:\d+:\d+)$/.exec(line.trim());
    if (m) names.push(`${m[1]} => ${m[2]}`);
  }
  return names;
}

async function copyDir(src: string, dst: string): Promise<void> {
  await Deno.mkdir(dst, { recursive: true });
  for await (const entry of Deno.readDir(src)) {
    if (entry.name === "node_modules") continue;
    const from = `${src}/${entry.name}`;
    const to = `${dst}/${entry.name}`;
    if (entry.isDirectory) await copyDir(from, to);
    else if (entry.isFile) await Deno.copyFile(from, to);
  }
}

async function writeOutputs(recs: RunRecord[], state: string): Promise<void> {
  const mutants = recs.filter((r) => r.id !== "BASELINE");
  const json = {
    run: {
      startedAt,
      finishedAt: new Date().toISOString(),
      state,
      mode,
      gitSha,
      denoVersion,
      command: `deno run -A mutation/run_mutations.ts --mode ${mode} --out ${outDir}`,
      testCommand: "deno test -A --no-check --config deno.json .",
      mutantCatalogue: "supabase/functions/api/__wf__/mutation/mutants.ts",
      totals: {
        mutants: mutants.length,
        killed: mutants.filter((r) => r.status === "killed").length,
        survived: mutants.filter((r) => r.status === "survived").length,
        invalid: mutants.filter((r) => r.status === "invalid").length,
        error: mutants.filter((r) => r.status === "error").length,
      },
    },
    results: recs,
  };
  await Deno.writeTextFile(`${outDir}/results.json`, JSON.stringify(json, null, 2) + "\n");
  const lines = [
    `# Mutation results — mode=${mode} (${state})`,
    "",
    `commit ${gitSha} · ${denoVersion.split("\n")[0]} · started ${startedAt}`,
    "",
    "| id | category | status | exit | passed | failed | expected (existing) | failing tests |",
    "|---|---|---|---|---|---|---|---|",
  ];
  for (const r of recs) {
    lines.push(
      `| ${r.id} | ${r.category} | ${r.status} | ${r.exitCode ?? "-"} | ${r.passed ?? "-"} | ${r.failed ?? "-"} | ${r.expectExisting} | ${r.failingTests.map((t) => t.split(" => ")[0]).join("<br>")} |`,
    );
  }
  lines.push("", `totals: ${JSON.stringify(json.run.totals)}`, "");
  await Deno.writeTextFile(`${outDir}/results.md`, lines.join("\n"));
}
