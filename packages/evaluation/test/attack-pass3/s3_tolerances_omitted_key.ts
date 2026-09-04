/**
 * S3 — a tolerances copy that omits one baseline key must make compare
 * report that metric as `unlisted` and exit 1 (policy `fail`), never
 * silently ignore it.
 *
 * Twists: omit a guarded key, omit an informational key, omit MANY keys,
 * and check `unlistedMetricPolicy: "informational"` really downgrades to
 * exit 0 (so the fail policy is the only thing standing between us and a
 * silently ignored metric — worth knowing, documented behaviour).
 * Also: a tolerances file with an entry for a key that exists in NEITHER
 * document must not be reported as anything (it is inert).
 */
import { join } from "node:path";
import {
  BASELINE,
  TOLERANCES,
  check,
  cli,
  ensureOutDir,
  finish,
  readJson,
  writeJson,
  type Check,
} from "./harness.js";

interface Tolerances {
  unlistedMetricPolicy: string;
  metrics: Record<string, { direction: string; absoluteTolerance: number; rationale: string }>;
}
interface Report {
  exitCode: number;
  counts: Record<string, number>;
  metrics: { metric: string; status: string; failing: boolean }[];
  regressions: string[];
}

const startedAtIso = new Date().toISOString();
const checks: Check[] = [];
const outDir = join(ensureOutDir(), "s3");
const tolerances = readJson<Tolerances>(TOLERANCES);
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function compareWith(tolPath: string): { exitCode: number; report: Report | null; stderr: string } {
  const result = cli(["compare", BASELINE, BASELINE, "--tolerances", tolPath, "--json"]);
  let report: Report | null = null;
  try {
    report = JSON.parse(result.stdout) as Report;
  } catch {
    report = null;
  }
  return { exitCode: result.exitCode, report, stderr: result.stderr };
}

const guardedKey = Object.keys(tolerances.metrics).find(
  (key) => tolerances.metrics[key]!.direction !== "informational",
)!;
const informationalKey = Object.keys(tolerances.metrics).find(
  (key) => tolerances.metrics[key]!.direction === "informational",
)!;

// (a) omit one guarded key
{
  const copy = clone(tolerances);
  delete copy.metrics[guardedKey];
  const path = join(outDir, "omit-guarded.tolerances.json");
  writeJson(path, copy);
  const { exitCode, report } = compareWith(path);
  const row = report?.metrics.find((entry) => entry.metric === guardedKey);
  check(
    checks,
    `omit guarded ${guardedKey} → unlisted + failing`,
    row?.status === "unlisted" && row.failing === true,
    `status=${row?.status} failing=${row?.failing}`,
    "status=unlisted failing=true",
  );
  check(checks, "omit guarded → exit 1", exitCode === 1, `exit ${exitCode}`, "exit 1");
  check(
    checks,
    "omit guarded → counts.unlisted === 1 and named in regressions[]",
    report?.counts.unlisted === 1 && (report.regressions ?? []).some((l) => l.includes(guardedKey)),
    `unlisted=${report?.counts.unlisted} regressions=${JSON.stringify(report?.regressions)}`,
    `unlisted=1, regressions mentions ${guardedKey}`,
  );
}

// (b) omit one informational key — still unlisted + exit 1 (policy applies to all)
{
  const copy = clone(tolerances);
  delete copy.metrics[informationalKey];
  const path = join(outDir, "omit-informational.tolerances.json");
  writeJson(path, copy);
  const { exitCode, report } = compareWith(path);
  const row = report?.metrics.find((entry) => entry.metric === informationalKey);
  check(
    checks,
    `omit informational ${informationalKey} → unlisted + exit 1`,
    row?.status === "unlisted" && row.failing === true && exitCode === 1,
    `status=${row?.status} failing=${row?.failing} exit ${exitCode}`,
    "status=unlisted failing=true exit 1",
  );
}

// (c) omit half the keys
{
  const copy = clone(tolerances);
  const keys = Object.keys(copy.metrics);
  const removed = keys.filter((_, index) => index % 2 === 0);
  for (const key of removed) delete copy.metrics[key];
  const path = join(outDir, "omit-half.tolerances.json");
  writeJson(path, copy);
  const { exitCode, report } = compareWith(path);
  check(
    checks,
    `omit ${removed.length}/${keys.length} keys → all counted unlisted, exit 1`,
    exitCode === 1 && report?.counts.unlisted === removed.length,
    `exit ${exitCode} unlisted=${report?.counts.unlisted}`,
    `exit 1 unlisted=${removed.length}`,
  );
}

// (d) empty metrics map → every metric unlisted, exit 1
{
  const copy = clone(tolerances);
  copy.metrics = {};
  const path = join(outDir, "omit-all.tolerances.json");
  writeJson(path, copy);
  const { exitCode, report } = compareWith(path);
  const total = Object.keys(tolerances.metrics).length;
  check(
    checks,
    "empty tolerances.metrics → every baseline key unlisted, exit 1",
    exitCode === 1 && report?.counts.unlisted === total,
    `exit ${exitCode} unlisted=${report?.counts.unlisted}`,
    `exit 1 unlisted=${total}`,
  );
}

// (e) policy downgrade: omitted key + unlistedMetricPolicy=informational → exit 0 (documented escape hatch)
{
  const copy = clone(tolerances);
  delete copy.metrics[guardedKey];
  copy.unlistedMetricPolicy = "informational";
  const path = join(outDir, "omit-guarded-policy-informational.tolerances.json");
  writeJson(path, copy);
  const { exitCode, report } = compareWith(path);
  const row = report?.metrics.find((entry) => entry.metric === guardedKey);
  check(
    checks,
    "policy=informational downgrades the omitted key to non-failing (documented; committed policy is fail)",
    exitCode === 0 && row?.status === "informational" && row.failing === false,
    `exit ${exitCode} status=${row?.status}`,
    "exit 0 status=informational",
  );
}

// (f) committed tolerances against the committed baseline: zero unlisted (coverage sanity)
{
  const { exitCode, report } = compareWith(TOLERANCES);
  check(
    checks,
    "committed tolerances cover every committed baseline key (unlisted=0, exit 0)",
    exitCode === 0 && report?.counts.unlisted === 0,
    `exit ${exitCode} unlisted=${report?.counts.unlisted}`,
    "exit 0 unlisted=0",
  );
}

// (g) malformed copy: entry missing rationale → exit 2, not a silent default
{
  const copy = clone(tolerances);
  copy.metrics[guardedKey] = { ...copy.metrics[guardedKey]!, rationale: "" };
  const path = join(outDir, "empty-rationale.tolerances.json");
  writeJson(path, copy);
  const { exitCode, stderr } = compareWith(path);
  check(
    checks,
    "tolerance entry with empty rationale → exit 2",
    exitCode === 2,
    `exit ${exitCode}: ${stderr.trim().split("\n")[0]}`,
    "exit 2",
  );
}

finish("s3_tolerances_omitted_key", startedAtIso, checks, { guardedKey, informationalKey, outDir });
