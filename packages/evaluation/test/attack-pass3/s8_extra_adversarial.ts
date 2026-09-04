/**
 * S8 — extra adversarial probes (beyond the seven assigned scenarios):
 *
 *  A. run-id fuzz (unicode, whitespace, path traversal, leading dot/dash,
 *     129 chars, empty) — every bad id must be rejected BEFORE anything is
 *     written; boundary-valid ids (128 chars, "CON") must be accepted.
 *  B. comparator robustness on corrupt/huge input — truncated JSON, `1e999`
 *     (Infinity after JSON.parse), string metric, array document, empty
 *     file, corrupt baseline, unicode metric key, 200 000 extra metrics.
 *  C. exact-tolerance boundary — candidate = baseline ± absoluteTolerance for
 *     every guarded metric with a non-zero tolerance; `|delta| <= tol` must
 *     hold at the boundary (float rounding of `candidate - baseline` would
 *     turn an intended pass into a spurious regression).
 *  D. permission denial — read-only --out-dir and a FILE as --out-dir.
 *  E. cancellation mid-flight — SIGTERM the runner while the event_recall
 *     subprocess is running; check what the orphaned child leaves behind in
 *     datasets/experiments/wave-e and whether the scratch dir is cleaned.
 *  F. clock skew — candidate generatedAtIso far in the past / future and a
 *     runner invocation with a skewed TZ; compare must not care.
 */
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BASELINE,
  CLI,
  EVAL_TSX,
  EVALUATION_DIR,
  TOLERANCES,
  WAVE_E_DIR,
  check,
  cli,
  ensureOutDir,
  finish,
  gitStatusShort,
  readJson,
  runCommand,
  writeJson,
  type Check,
} from "./harness.js";

interface Summary {
  runId: string;
  generatedAtIso: string;
  metrics: Record<string, number | null>;
  benches: { id: string; status: string; metrics: Record<string, number | null> }[];
}
interface Tolerances {
  metrics: Record<string, { direction: string; absoluteTolerance: number }>;
}
interface Report {
  exitCode: number;
  counts: Record<string, number>;
  metrics: { metric: string; status: string; failing: boolean }[];
}

const startedAtIso = new Date().toISOString();
const checks: Check[] = [];
const outDir = join(ensureOutDir(), "s8");
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
const statusBefore = gitStatusShort();

const baseline = readJson<Summary>(BASELINE);
const tolerances = readJson<Tolerances>(TOLERANCES);
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function compareFile(candidatePath: string, extra: string[] = []) {
  const result = cli(["compare", BASELINE, candidatePath, "--json", ...extra]);
  let report: Report | null = null;
  try {
    report = JSON.parse(result.stdout) as Report;
  } catch {
    report = null;
  }
  return { result, report };
}

function compareDoc(name: string, doc: unknown, extra: string[] = []) {
  const path = join(outDir, `${name}.json`);
  writeJson(path, doc);
  return { path, ...compareFile(path, extra) };
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0] ?? "";
}

// ───────────────────────────── A. run-id fuzz ─────────────────────────────
const badIds: [string, string][] = [
  ["unicode", "cand-ünï-🥒"],
  ["space", "a b"],
  ["dotdot", ".."],
  ["slash", "a/b"],
  ["leading-dash", "-lead"],
  ["leading-dot", ".hidden"],
  ["129-chars", "x".repeat(129)],
  ["newline", "a\nb"],
];
for (const [label, runId] of badIds) {
  const runOut = join(outDir, `runid-${label}`);
  const result = cli(["run", "--out-dir", runOut, "--run-id", runId, "--only", "contact_replay"]);
  const written = existsSync(runOut) ? readdirSync(runOut) : [];
  check(
    checks,
    `A: run-id ${label} (${JSON.stringify(runId).slice(0, 40)}) rejected before writing anything`,
    result.exitCode !== 0 && written.length === 0 && /invalid run id/.test(result.stderr),
    `exit ${result.exitCode}, files=${JSON.stringify(written)}, stderr="${firstLine(result.stderr).slice(0, 120)}"`,
    "exit != 0, no files, 'invalid run id'",
  );
}
{
  // `--run-id ""` — must either be rejected or fall back to the auto
  // timestamp id; it must never produce ".json" or an odd file name.
  const runOut = join(outDir, "runid-empty");
  const result = cli(["run", "--out-dir", runOut, "--run-id", "", "--only", "contact_replay"]);
  const written = existsSync(runOut) ? readdirSync(runOut) : [];
  const rejected = result.exitCode !== 0 && written.length === 0;
  const autoId =
    result.exitCode === 0 &&
    written.length === 1 &&
    /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z\.json$/.test(written[0]!);
  check(
    checks,
    'A: run-id "" (empty) → rejected, or treated as absent (auto timestamp id); never ".json"',
    rejected || autoId,
    `exit ${result.exitCode}, files=${JSON.stringify(written)} (${rejected ? "rejected" : autoId ? "auto id fallback" : "neither"})`,
    "rejected or auto id",
  );
}
for (const [label, runId] of [
  ["128-chars", "y".repeat(128)],
  ["CON", "CON"],
  ["dots-and-dashes", "1.2.3-rc_4"],
] as [string, string][]) {
  const runOut = join(outDir, `runid-${label}`);
  const result = cli(["run", "--out-dir", runOut, "--run-id", runId, "--only", "contact_replay"]);
  const written = existsSync(runOut) ? readdirSync(runOut) : [];
  check(
    checks,
    `A: boundary-valid run-id ${label} accepted and produces exactly <id>.json`,
    result.exitCode === 0 && written.length === 1 && written[0] === `${runId}.json`,
    `exit ${result.exitCode}, files=${JSON.stringify(written.map((f) => f.slice(0, 20) + (f.length > 20 ? "…" : "")))}`,
    `exit 0, [${runId.slice(0, 20)}….json]`,
  );
}

// ─────────────────── B. corrupt / huge comparator input ───────────────────
// Fresh full candidate for this commit (reuses S5's if it is still around).
const candPath = existsSync(join(ensureOutDir(), "s5/run/cand.json"))
  ? join(ensureOutDir(), "s5/run/cand.json")
  : join(outDir, "run/cand.json");
if (!existsSync(candPath)) {
  const gen = cli(["run", "--out-dir", join(outDir, "run"), "--run-id", "cand"]);
  if (gen.exitCode !== 0)
    throw new Error(`candidate generation failed (${gen.exitCode}): ${gen.stderr}`);
}
const cand = readJson<Summary>(candPath);
const guardedKey = Object.entries(tolerances.metrics).find(
  ([key, tol]) => tol.direction !== "informational" && typeof baseline.metrics[key] === "number",
)![0];
const benchOf = (key: string) => key.split(".")[0]!;

{
  const truncatedPath = join(outDir, "cand.truncated.json");
  writeFileSync(truncatedPath, JSON.stringify(cand, null, 2).slice(0, 4000));
  const { result } = compareFile(truncatedPath);
  check(
    checks,
    "B: truncated candidate JSON → exit 2",
    result.exitCode === 2,
    `exit ${result.exitCode}: ${firstLine(result.stderr)}`,
    "2",
  );
}
{
  const infPath = join(outDir, "cand.infinity.json");
  const doc = clone(cand);
  const text = JSON.stringify(doc, null, 2).replace(
    new RegExp(`"${guardedKey.replace(/\./g, "\\.")}": [-0-9.e+]+`),
    `"${guardedKey}": 1e999`,
  );
  writeFileSync(infPath, text);
  const { result } = compareFile(infPath);
  check(
    checks,
    "B: 1e999 (Infinity) metric in candidate → exit 2, not a silent pass",
    result.exitCode === 2,
    `exit ${result.exitCode}: ${firstLine(result.stderr)}`,
    "2",
  );
}
{
  const doc = clone(cand) as unknown as {
    metrics: Record<string, unknown>;
    benches: { id: string; metrics: Record<string, unknown> }[];
  };
  doc.metrics[guardedKey] = String(doc.metrics[guardedKey]);
  const bench = doc.benches.find((b) => b.id === benchOf(guardedKey))!;
  bench.metrics[guardedKey.slice(benchOf(guardedKey).length + 1)] = doc.metrics[guardedKey];
  const { result } = compareDoc("cand.string-metric", doc);
  check(
    checks,
    "B: string-typed metric → exit 2",
    result.exitCode === 2,
    `exit ${result.exitCode}: ${firstLine(result.stderr)}`,
    "2",
  );
}
{
  const { result } = compareDoc("cand.array", []);
  check(
    checks,
    "B: array document → exit 2",
    result.exitCode === 2,
    `exit ${result.exitCode}: ${firstLine(result.stderr)}`,
    "2",
  );
}
{
  const emptyPath = join(outDir, "cand.empty.json");
  writeFileSync(emptyPath, "");
  const { result } = compareFile(emptyPath);
  check(
    checks,
    "B: empty candidate file → exit 2",
    result.exitCode === 2,
    `exit ${result.exitCode}: ${firstLine(result.stderr)}`,
    "2",
  );
}
{
  const badBaseline = join(outDir, "baseline.truncated.json");
  writeFileSync(badBaseline, JSON.stringify(baseline).slice(0, 1000));
  const result = cli([
    "compare",
    badBaseline,
    join("/tmp/attack-pass3/s5/run", "cand.json"),
    "--json",
  ]);
  check(
    checks,
    "B: truncated BASELINE → exit 2",
    result.exitCode === 2,
    `exit ${result.exitCode}: ${firstLine(result.stderr)}`,
    "2",
  );
}
{
  const doc = clone(cand);
  const key = "coach_gates.ünïcødé_🥒";
  doc.metrics[key] = 1;
  doc.benches.find((b) => b.id === "coach_gates")!.metrics["ünïcødé_🥒"] = 1;
  const { result, report } = compareDoc("cand.unicode-key", doc);
  const row = report?.metrics.find((m) => m.metric === key);
  const schemaRejected =
    result.exitCode === 2 && /metric key .* is not \[A-Za-z0-9_.-\]\+/.test(result.stderr);
  const gated = result.exitCode === 1 && row?.failing === true;
  check(
    checks,
    "B: unicode metric key → rejected by schema (exit 2) or gated as failing (exit 1); never a silent pass",
    schemaRejected || gated,
    `exit ${result.exitCode}, row=${JSON.stringify(row)}, stderr="${firstLine(result.stderr).slice(0, 120)}"`,
    "exit 2 (schema) or exit 1 (gated)",
  );
}
{
  // A metric NEW in the candidate (absent from baseline AND tolerances).
  // docs/EVALUATION.md §1.3: "a new metric must be classified before it can
  // pass" — so with unlistedMetricPolicy "fail" this must not exit 0.
  const doc = clone(cand);
  doc.metrics["coach_gates.brand_new_unclassified"] = 1;
  doc.benches.find((b) => b.id === "coach_gates")!.metrics["brand_new_unclassified"] = 1;
  const { result, report } = compareDoc("cand.new-unlisted-metric", doc);
  const row = report?.metrics.find((m) => m.metric === "coach_gates.brand_new_unclassified");
  check(
    checks,
    "B: brand-new metric absent from baseline AND tolerances (policy fail) → does not pass silently",
    result.exitCode !== 0 && row?.failing === true,
    `exit ${result.exitCode}, row=${JSON.stringify(row)}, counts=${JSON.stringify(report?.counts)}`,
    "exit 1, failing (unlisted) — or docs must say new metrics pass until the baseline is refreshed",
  );
}
{
  const doc = clone(cand);
  const bench = doc.benches.find((b) => b.id === "coach_gates")!;
  const extra = 200_000;
  for (let i = 0; i < extra; i += 1) {
    doc.metrics[`coach_gates.huge_${i}`] = i;
    bench.metrics[`huge_${i}`] = i;
  }
  const startedAt = Date.now();
  const { path, result, report } = compareDoc("cand.huge", doc);
  const size = statSync(path).size;
  check(
    checks,
    `B: ${extra} extra candidate-only metrics (${(size / 1e6).toFixed(1)} MB) → no crash, every one accounted for as missing_in_baseline`,
    report !== null &&
      report.counts.missing_in_baseline === extra &&
      result.exitCode === report.exitCode,
    `exit ${result.exitCode}, counts=${JSON.stringify(report?.counts)}, ${Date.now() - startedAt}ms, stderr="${firstLine(result.stderr).slice(0, 100)}"`,
    `missing_in_baseline ${extra}, parseable report`,
  );
  rmSync(path);
}

// ─────────────────── C. exact tolerance boundary (float) ───────────────────
{
  // Every committed guarded tolerance is 0 (exact match), so the boundary is
  // probed with a scratch tolerance copy that widens each guarded metric to
  // a realistic non-zero band. `Math.abs(candidate - baseline) <= tol` is
  // exercised exactly AT the band edge for several decimal tolerances.
  const committedZero = Object.values(tolerances.metrics)
    .filter((t) => t.direction !== "informational")
    .every((t) => t.absoluteTolerance === 0);
  check(
    checks,
    "C: precondition — every committed guarded tolerance is 0 (exact-match gate)",
    committedZero,
    String(committedZero),
    "true",
  );
  for (const band of [0.1, 0.01, 0.5, 1]) {
    const scratch = clone(tolerances);
    const doc = clone(cand);
    const boundaryKeys: string[] = [];
    for (const [key, tol] of Object.entries(scratch.metrics)) {
      if (tol.direction === "informational") continue;
      const base = baseline.metrics[key];
      if (typeof base !== "number") continue;
      tol.absoluteTolerance = band;
      const value = tol.direction === "lower_is_better" ? base + band : base - band;
      doc.metrics[key] = value;
      doc.benches.find((b) => b.id === benchOf(key))!.metrics[key.slice(benchOf(key).length + 1)] =
        value;
      boundaryKeys.push(key);
    }
    const tolPath = join(outDir, `tolerances.band-${band}.json`);
    writeJson(tolPath, scratch);
    const { result, report } = compareDoc(`cand.tolerance-boundary-${band}`, doc, [
      "--tolerances",
      tolPath,
    ]);
    const spurious = (report?.metrics ?? []).filter(
      (m) => boundaryKeys.includes(m.metric) && m.failing,
    );
    check(
      checks,
      `C: ${boundaryKeys.length} guarded metrics exactly at baseline±${band} with tolerance ${band} → all within_tolerance, exit 0`,
      result.exitCode === 0 && spurious.length === 0,
      `exit ${result.exitCode}, spurious regressions=${spurious.length}${
        spurious.length
          ? ": " +
            spurious
              .map((m) => `${m.metric}`)
              .slice(0, 6)
              .join(", ") +
            (spurious.length > 6 ? ", …" : "")
          : ""
      }`,
      "exit 0, 0 spurious",
    );
    if (band === 0.1) {
      const doc2 = clone(cand);
      const key = boundaryKeys[0]!;
      const tol = scratch.metrics[key]!;
      const base = baseline.metrics[key] as number;
      const past = tol.direction === "lower_is_better" ? base + band * 1.01 : base - band * 1.01;
      doc2.metrics[key] = past;
      doc2.benches.find((b) => b.id === benchOf(key))!.metrics[key.slice(benchOf(key).length + 1)] =
        past;
      const past1 = compareDoc("cand.tolerance-past", doc2, ["--tolerances", tolPath]);
      const row = past1.report?.metrics.find((m) => m.metric === key);
      check(
        checks,
        `C: ${key} 1% past the ${band} band → regressed, exit 1`,
        past1.result.exitCode === 1 && row?.failing === true && row.status === "regressed",
        `exit ${past1.result.exitCode}, row=${JSON.stringify(row)}`,
        "exit 1, regressed",
      );
    }
  }
}

// ───────────────────────── D. permission denial ─────────────────────────
{
  const roDir = join(outDir, "readonly-out");
  mkdirSync(roDir, { recursive: true });
  chmodSync(roDir, 0o555);
  const before = new Set(readdirSync(tmpdir()).filter((n) => n.startsWith("pickle-regression-")));
  const result = cli(["run", "--out-dir", roDir, "--run-id", "ro", "--only", "contact_replay"]);
  const after = readdirSync(tmpdir()).filter(
    (n) => n.startsWith("pickle-regression-") && !before.has(n),
  );
  chmodSync(roDir, 0o755);
  check(
    checks,
    "D: read-only --out-dir → non-zero exit with EACCES, no summary, scratch dir cleaned",
    result.exitCode !== 0 &&
      /EACCES|permission denied/i.test(result.stderr) &&
      readdirSync(roDir).length === 0 &&
      after.length === 0,
    `exit ${result.exitCode}, files=${JSON.stringify(readdirSync(roDir))}, leaked scratch=${JSON.stringify(after)}, stderr="${firstLine(result.stderr).slice(0, 120)}"`,
    "exit != 0, EACCES, [], []",
  );
}
{
  const filePath = join(outDir, "out-dir-is-a-file");
  writeFileSync(filePath, "not a directory");
  const result = cli(["run", "--out-dir", filePath, "--run-id", "f", "--only", "contact_replay"]);
  check(
    checks,
    "D: --out-dir pointing at a FILE → non-zero exit, file untouched",
    result.exitCode !== 0 &&
      statSync(filePath).isFile() &&
      statSync(filePath).size === "not a directory".length,
    `exit ${result.exitCode}, stderr="${firstLine(result.stderr).slice(0, 120)}"`,
    "exit != 0, file intact",
  );
}

// ──────────────────────── E. cancellation mid-flight ────────────────────────
async function cancellationProbe(): Promise<void> {
  const waveBefore = new Set(readdirSync(WAVE_E_DIR));
  const scratchBefore = new Set(
    readdirSync(tmpdir()).filter((n) => n.startsWith("pickle-regression-")),
  );
  const runOut = join(outDir, "cancel");
  const runner = spawn(
    EVAL_TSX,
    [CLI, "run", "--out-dir", runOut, "--run-id", "cancel", "--only", "event_recall"],
    {
      cwd: EVALUATION_DIR,
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stderr = "";
  runner.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
  // Wait until the swing-lab child is alive, then SIGTERM the runner (as Ctrl-C / CI cancel would).
  const deadline = Date.now() + 30_000;
  let childPid = "";
  while (Date.now() < deadline) {
    const pgrep = runCommand("pgrep", ["-f", "src/eventRecallBench.ts"]);
    childPid = pgrep.stdout.trim().split("\n").filter(Boolean)[0] ?? "";
    if (childPid) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  const runnerExit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolvePromise) => runner.on("close", (code, signal) => resolvePromise({ code, signal })),
  );
  runner.kill("SIGTERM");
  const exit = await runnerExit;
  // Give the orphaned child time to finish and write its report.
  const childDeadline = Date.now() + 60_000;
  while (
    Date.now() < childDeadline &&
    runCommand("pgrep", ["-f", "src/eventRecallBench.ts"]).exitCode === 0
  ) {
    await new Promise((r) => setTimeout(r, 100));
  }
  const leaked = readdirSync(WAVE_E_DIR).filter((n) => !waveBefore.has(n));
  const scratchLeaked = readdirSync(tmpdir()).filter(
    (n) => n.startsWith("pickle-regression-") && !scratchBefore.has(n),
  );
  const summaryWritten = existsSync(join(runOut, "cancel.json"));
  check(
    checks,
    "E: SIGTERM runner while event_recall child runs → no summary, orphan child leaves nothing in wave-e, scratch cleaned",
    !summaryWritten && leaked.length === 0 && scratchLeaked.length === 0,
    `runner exit code=${exit.code} signal=${exit.signal} (child pid seen: ${childPid || "none"}), summary=${summaryWritten}, leaked wave-e=${JSON.stringify(leaked)}, leaked scratch=${JSON.stringify(scratchLeaked)}, stderr="${firstLine(stderr).slice(0, 100)}"`,
    "no summary, [], []",
  );
  // Clean up ONLY what this probe leaked (never touch pre-existing files).
  for (const n of leaked) rmSync(join(WAVE_E_DIR, n));
  for (const n of scratchLeaked) rmSync(join(tmpdir(), n), { recursive: true, force: true });
}

// ───────────────────────────── F. clock skew ─────────────────────────────
function clockSkewProbe(): void {
  for (const [label, iso] of [
    ["epoch", "1970-01-01T00:00:00.000Z"],
    ["far-future", "2999-12-31T23:59:59.999Z"],
  ] as [string, string][]) {
    const doc = clone(cand);
    doc.generatedAtIso = iso;
    const { result } = compareDoc(`cand.clock-${label}`, doc);
    check(
      checks,
      `F: candidate generatedAtIso=${label} → compare exit 0 (timestamps are informational)`,
      result.exitCode === 0,
      `exit ${result.exitCode}: ${firstLine(result.stderr)}`,
      "0",
    );
  }
  const runOut = join(outDir, "tz-skew");
  const result = runCommand(
    EVAL_TSX,
    [CLI, "run", "--out-dir", runOut, "--only", "contact_replay"],
    {
      cwd: EVALUATION_DIR,
      env: { ...process.env, TZ: "Pacific/Kiritimati", LANG: "tr_TR.UTF-8", LC_ALL: "tr_TR.UTF-8" },
    },
  );
  const files = existsSync(runOut) ? readdirSync(runOut) : [];
  const summary = files[0] ? readJson<Summary>(join(runOut, files[0])) : null;
  const drift = summary
    ? Object.keys(summary.metrics).filter((k) => summary.metrics[k] !== baseline.metrics[k])
    : ["<none>"];
  check(
    checks,
    "F: TZ=Pacific/Kiritimati + tr_TR locale, auto run-id → valid run-id, exit 0, metrics identical",
    result.exitCode === 0 &&
      files.length === 1 &&
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/.test(files[0]!) &&
      drift.length === 0,
    `exit ${result.exitCode}, files=${JSON.stringify(files)}, drift=${drift.length}`,
    "exit 0, one valid file, 0 drift",
  );
}

void (async () => {
  await cancellationProbe();
  clockSkewProbe();
  const statusAfter = gitStatusShort();
  check(
    checks,
    "git status unchanged after attack",
    statusAfter === statusBefore,
    statusAfter || "<clean>",
    statusBefore || "<clean>",
  );
  finish("s8_extra_adversarial", startedAtIso, checks, { outDir });
})();
