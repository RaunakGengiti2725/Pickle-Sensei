/**
 * S6 — `pnpm --filter @pickle/evaluation bench:compare … --json > compare.json`
 * WITHOUT `-s`: does pnpm's script banner land in the redirected stdout and
 * break JSON.parse? Reproduce under the installed pnpm 9, then repeat under
 * pnpm 10.15.1 (the version pinned by root `packageManager`), each with and
 * without `-s` (the `-s` runs are the documented control, docs/EVALUATION.md).
 *
 * Classification note: docs/EVALUATION.md already documents `-s` as required,
 * so a broken parse WITHOUT `-s` is expected behaviour of pnpm, not a runner
 * defect — this script records exactly what each pnpm version does so the
 * doc claim is backed by evidence. The unexpected outcome would be `-s`
 * ALSO leaking, or exit codes being masked.
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BASELINE,
  REPO_ROOT,
  check,
  ensureOutDir,
  finish,
  runCommand,
  type Check,
} from "./harness.js";

const startedAtIso = new Date().toISOString();
const checks: Check[] = [];
const outDir = join(ensureOutDir(), "s6");
mkdirSync(outDir, { recursive: true });

interface PnpmFlavour {
  label: string;
  file: string;
  prefix: string[];
}

const flavours: PnpmFlavour[] = [
  { label: "pnpm9", file: "pnpm", prefix: [] },
  { label: "pnpm10", file: "npx", prefix: ["-y", "pnpm@10.15.1"] },
];

// Same pnpm 9 CLI but launched by a Node 20 (engine-satisfying) runtime so the
// `Unsupported engine` WARN disappears and only the script banner remains.
const node20 = join(process.env.HOME ?? "", ".nvm/versions/node/v20.20.2/bin/node");
const pnpm9Cjs = join(
  process.env.HOME ?? "",
  ".nvm/versions/node/v22.12.0/lib/node_modules/pnpm/bin/pnpm.cjs",
);
if (existsSync(node20) && existsSync(pnpm9Cjs)) {
  flavours.push({ label: "pnpm9-node20", file: node20, prefix: [pnpm9Cjs] });
}

const versions: Record<string, string> = {};
for (const flavour of flavours) {
  const v = runCommand(flavour.file, [...flavour.prefix, "--version"], { cwd: REPO_ROOT });
  versions[flavour.label] = v.stdout.trim() || `${v.error ?? ""} ${v.stderr.trim()}`;
}
check(checks, "pnpm 9 present", /^9\./.test(versions.pnpm9 ?? ""), versions.pnpm9 ?? "", "9.x");
check(
  checks,
  "pnpm 10.15.1 obtainable via npx",
  versions.pnpm10 === "10.15.1",
  versions.pnpm10 ?? "",
  "10.15.1",
);
if (versions["pnpm9-node20"] !== undefined) {
  check(
    checks,
    "pnpm 9 under Node 20 runtime",
    /^9\./.test(versions["pnpm9-node20"] ?? ""),
    versions["pnpm9-node20"] ?? "",
    "9.x",
  );
}

interface Outcome {
  exitCode: number;
  parsed: boolean;
  parseError: string | null;
  stdoutHead: string;
  stderrHead: string;
  bytes: number;
  path: string;
}

function redirectedCompare(
  flavour: PnpmFlavour,
  silent: boolean,
  candidate: string,
  label: string,
): Outcome {
  const path = join(outDir, `${flavour.label}${silent ? "-s" : ""}-${label}.compare.json`);
  const fd = openSync(path, "w");
  const args = [
    ...flavour.prefix,
    ...(silent ? ["-s"] : []),
    "--filter",
    "@pickle/evaluation",
    "bench:compare",
    BASELINE,
    candidate,
    "--json",
  ];
  const spawn = runCommand(flavour.file, args, { cwd: REPO_ROOT, stdio: ["ignore", fd, "pipe"] });
  closeSync(fd);
  const text = readFileSync(path, "utf8");
  let parsed = true;
  let parseError: string | null = null;
  try {
    JSON.parse(text);
  } catch (error) {
    parsed = false;
    parseError = error instanceof Error ? error.message : String(error);
  }
  writeFileSync(
    join(outDir, `${flavour.label}${silent ? "-s" : ""}-${label}.stderr.log`),
    spawn.stderr,
  );
  return {
    exitCode: spawn.exitCode,
    parsed,
    parseError,
    stdoutHead: text.split("\n").slice(0, 3).join("\\n"),
    stderrHead: spawn.stderr.split("\n").slice(0, 3).join("\\n"),
    bytes: text.length,
    path,
  };
}

// A candidate that regresses (exit 1) so we can also see whether pnpm masks the code.
const regressed = join(outDir, "regressed-candidate.json");
{
  const doc = JSON.parse(readFileSync(BASELINE, "utf8")) as {
    benches: { id: string; metrics: Record<string, number | null> }[];
    metrics: Record<string, number | null>;
  };
  const bench = doc.benches.find((b) => b.id === "contact_replay")!;
  bench.metrics.median_error_ms = (bench.metrics.median_error_ms as number) + 1000;
  doc.metrics["contact_replay.median_error_ms"] = bench.metrics.median_error_ms;
  writeFileSync(regressed, JSON.stringify(doc, null, 2));
}

const outcomes: Record<string, Outcome> = {};
for (const flavour of flavours) {
  if (!/^(9|10)\./.test(versions[flavour.label] ?? "")) continue;
  for (const silent of [false, true]) {
    const clean = redirectedCompare(flavour, silent, BASELINE, "clean");
    const bad = redirectedCompare(flavour, silent, regressed, "regressed");
    const key = `${flavour.label}${silent ? " -s" : ""}`;
    outcomes[`${key} clean`] = clean;
    outcomes[`${key} regressed`] = bad;

    if (silent) {
      check(
        checks,
        `${key}: redirected stdout is pure JSON (documented invocation)`,
        clean.parsed && bad.parsed,
        `clean parsed=${clean.parsed} regressed parsed=${bad.parsed} head="${clean.stdoutHead.slice(0, 80)}"`,
        "both parse",
      );
    } else {
      // Not a runner defect — record whether the banner lands in stdout.
      const text = readFileSync(clean.path, "utf8");
      check(
        checks,
        `${key}: WITHOUT -s the banner corrupts redirected JSON (expected pnpm behaviour; recorded)`,
        true,
        `parsed=${clean.parsed} error=${clean.parseError ?? "none"} engineWarnOnStdout=${/Unsupported engine/.test(text)} scriptBannerOnStdout=${/^> @pickle\/evaluation@/m.test(text)}`,
        "informational — see docs/EVALUATION.md",
      );
    }
    check(
      checks,
      `${key}: exit codes propagate (clean 0, regressed 1)`,
      clean.exitCode === 0 && bad.exitCode === 1,
      `clean exit ${clean.exitCode}, regressed exit ${bad.exitCode}`,
      "0 / 1",
    );
  }
}

const pnpm9NoS = outcomes["pnpm9 clean"];
const pnpm10NoS = outcomes["pnpm10 clean"];
check(
  checks,
  "pnpm 9 without -s: JSON.parse of redirected compare.json fails (reproduction)",
  pnpm9NoS !== undefined && pnpm9NoS.parsed === false,
  pnpm9NoS
    ? `parsed=${pnpm9NoS.parsed} ${pnpm9NoS.parseError ?? ""} head="${pnpm9NoS.stdoutHead.slice(0, 120)}"`
    : "not run",
  "parse fails (banner on stdout) — this is the documented reason for -s",
);
check(
  checks,
  "pnpm 10.15.1 without -s: banner behaviour recorded",
  pnpm10NoS !== undefined,
  pnpm10NoS
    ? `parsed=${pnpm10NoS.parsed} ${pnpm10NoS.parseError ?? ""} head="${pnpm10NoS.stdoutHead.slice(0, 120)}"`
    : "not run",
  "recorded (either outcome) — informs whether the -s note is still needed on pnpm 10",
);

finish("s6_pnpm_banner_stdout", startedAtIso, checks, { versions, outcomes, outDir });
