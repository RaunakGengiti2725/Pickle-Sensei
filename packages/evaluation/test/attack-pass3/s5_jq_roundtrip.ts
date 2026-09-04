/**
 * S5 — round-trip a freshly generated candidate summary through `jq` and
 * confirm bench:compare is key-order / number-formatting independent.
 *
 * Variants:
 *   jq .          (jq-1.6 re-serialises numbers: 1.0 → 1, 17-sig-digit floats)
 *   jq -S .       (sorted keys at every level)
 *   jq -c .       (compact, single line)
 *   reverse key order at every level (Node, not jq — jq cannot reverse)
 *   every number spelled as `x.0` / exponent form (`2.7e1`) where lossless
 * All must compare against the untouched candidate as exit 0 with
 * identityDifferences = [] and counts identical to the untouched compare.
 * Also: a jq filter that DROPS one bench metric must NOT be exit 0.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BASELINE,
  OUT_DIR,
  check,
  cli,
  ensureOutDir,
  finish,
  readJson,
  runCommand,
  type Check,
} from "./harness.js";

interface Report {
  exitCode: number;
  comparable: boolean;
  identityDifferences: string[];
  counts: Record<string, number>;
}

const startedAtIso = new Date().toISOString();
const checks: Check[] = [];
const outDir = join(ensureOutDir(), "s5");
rmSync(outDir, { recursive: true, force: true });

const jqVersion = runCommand("jq", ["--version"]);
check(
  checks,
  "jq available",
  jqVersion.exitCode === 0,
  jqVersion.stdout.trim() || jqVersion.error || "",
  "jq present",
);

const runOut = join(outDir, "run");
const run = cli(["run", "--out-dir", runOut, "--run-id", "cand"]);
writeFileSync(join(OUT_DIR, "s5-run.stdout.log"), run.stdout);
const candPath = join(runOut, "cand.json");
check(
  checks,
  "fresh candidate produced",
  run.exitCode === 0 && existsSync(candPath),
  `exit ${run.exitCode}`,
  "exit 0 + cand.json",
);

function compare(
  a: string,
  b: string,
): { exitCode: number; report: Report | null; stderr: string } {
  const result = cli(["compare", a, b, "--json"]);
  let report: Report | null = null;
  try {
    report = JSON.parse(result.stdout) as Report;
  } catch {
    report = null;
  }
  return { exitCode: result.exitCode, report, stderr: result.stderr };
}

const reference = compare(BASELINE, candPath);
check(
  checks,
  "untouched candidate vs baseline exit 0",
  reference.exitCode === 0,
  `exit ${reference.exitCode}`,
  "exit 0",
);

const variants: { name: string; produce: () => string }[] = [
  {
    name: "jq .",
    produce: () => {
      const out = runCommand("jq", [".", candPath]);
      const path = join(outDir, "cand.jq.json");
      writeFileSync(path, out.stdout);
      return path;
    },
  },
  {
    name: "jq -S . (sorted keys)",
    produce: () => {
      const out = runCommand("jq", ["-S", ".", candPath]);
      const path = join(outDir, "cand.jq-sorted.json");
      writeFileSync(path, out.stdout);
      return path;
    },
  },
  {
    name: "jq -c . (compact)",
    produce: () => {
      const out = runCommand("jq", ["-c", ".", candPath]);
      const path = join(outDir, "cand.jq-compact.json");
      writeFileSync(path, out.stdout);
      return path;
    },
  },
  {
    name: "reverse key order at every level",
    produce: () => {
      const reverse = (value: unknown): unknown => {
        if (Array.isArray(value)) return value.map(reverse);
        if (value && typeof value === "object") {
          const entries = Object.entries(value as Record<string, unknown>).reverse();
          return Object.fromEntries(entries.map(([k, v]) => [k, reverse(v)]));
        }
        return value;
      };
      const path = join(outDir, "cand.reversed.json");
      writeFileSync(path, JSON.stringify(reverse(readJson(candPath)), null, 2));
      return path;
    },
  },
  {
    name: "integers spelled as 27.0 / floats as exponent",
    produce: () => {
      // Textual rewrite of number tokens that are metric values — integers get a
      // trailing `.0`, non-integers become exponent notation (lossless in JS).
      const text = readFileSync(candPath, "utf8");
      const rewritten = text.replace(
        /(": )(-?\d+(?:\.\d+)?)(?=,?\n)/g,
        (_m, prefix: string, num: string) => {
          const value = Number(num);
          if (!Number.isFinite(value)) return `${prefix}${num}`;
          if (Number.isInteger(value)) return `${prefix}${value}.0`;
          return `${prefix}${value.toExponential()}`;
        },
      );
      const path = join(outDir, "cand.numbers-respelled.json");
      writeFileSync(path, rewritten);
      return path;
    },
  },
];

for (const variant of variants) {
  const path = variant.produce();
  const vsBaseline = compare(BASELINE, path);
  const vsSelf = compare(candPath, path);
  const sameCounts =
    JSON.stringify(vsBaseline.report?.counts) === JSON.stringify(reference.report?.counts);
  check(
    checks,
    `${variant.name} → compare vs baseline exit 0 with identical counts`,
    vsBaseline.exitCode === 0 && sameCounts,
    `exit ${vsBaseline.exitCode} counts=${JSON.stringify(vsBaseline.report?.counts)} ${vsBaseline.stderr.trim().split("\n")[0]}`,
    `exit 0 counts=${JSON.stringify(reference.report?.counts)}`,
  );
  check(
    checks,
    `${variant.name} → compare vs untouched self: exit 0, no identity differences, all unchanged/informational`,
    vsSelf.exitCode === 0 &&
      vsSelf.report?.identityDifferences.length === 0 &&
      (vsSelf.report.counts.improved ?? 0) === 0 &&
      (vsSelf.report.counts.regressed ?? 0) === 0 &&
      (vsSelf.report.counts.within_tolerance ?? 0) === 0,
    `exit ${vsSelf.exitCode} identityDifferences=${JSON.stringify(vsSelf.report?.identityDifferences)} counts=${JSON.stringify(vsSelf.report?.counts)}`,
    "exit 0, [] , no improved/regressed/within_tolerance",
  );
}

// Negative control: jq that deletes a metric from BOTH views must be caught.
{
  const out = runCommand("jq", [
    'del(.benches[] | select(.id == "coach_gates") | .metrics.gates_pass) | del(.metrics["coach_gates.gates_pass"])',
    candPath,
  ]);
  const path = join(outDir, "cand.jq-dropped-metric.json");
  writeFileSync(path, out.stdout);
  const dropped = compare(BASELINE, path);
  check(
    checks,
    "jq that deletes coach_gates.gates_pass from both views → exit 1 (missing_in_candidate)",
    dropped.exitCode === 1 && (dropped.report?.counts.missing_in_candidate ?? 0) === 1,
    `exit ${dropped.exitCode} missing_in_candidate=${dropped.report?.counts.missing_in_candidate}`,
    "exit 1 missing_in_candidate=1",
  );
}

// Negative control: jq that deletes it from ONE view only → schema rejects (exit 2).
{
  const out = runCommand("jq", ['del(.metrics["coach_gates.gates_pass"])', candPath]);
  const path = join(outDir, "cand.jq-dropped-flat-only.json");
  writeFileSync(path, out.stdout);
  const dropped = compare(BASELINE, path);
  check(
    checks,
    "jq that deletes only the flattened key → exit 2 (mismatch), not silently compared",
    dropped.exitCode === 2,
    `exit ${dropped.exitCode}: ${dropped.stderr.trim().split("\n")[0]}`,
    "exit 2",
  );
}

finish("s5_jq_roundtrip", startedAtIso, checks, { jq: jqVersion.stdout.trim(), candPath, outDir });
