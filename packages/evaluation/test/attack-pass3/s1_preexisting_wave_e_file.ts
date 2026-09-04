/**
 * S1 — a pre-existing `datasets/experiments/wave-e/event-recall-<future-ts>.json`
 * must be ignored by the runner's before-set and never unlinked.
 *
 * Attack: plant a decoy whose timestamp is far in the FUTURE (so a naive
 * "newest file wins" strategy would pick it), plus a second decoy that is
 * byte-for-byte a plausible report, then run the full bench. Afterwards both
 * decoys must still exist with identical bytes, `event_recall` must be `ok`
 * with metrics parsed from the REAL run (not the decoy), and no other new
 * file may remain in wave-e.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BASELINE,
  OUT_DIR,
  WAVE_E_DIR,
  check,
  cli,
  ensureOutDir,
  finish,
  gitStatusShort,
  readJson,
  type Check,
} from "./harness.js";

interface Summary {
  provenance: { gitDirty: boolean };
  caveats: string[];
  benches: {
    id: string;
    status: string;
    metrics: Record<string, number | null>;
    error: string | null;
  }[];
  metrics: Record<string, number | null>;
}

const startedAtIso = new Date().toISOString();
const checks: Check[] = [];
ensureOutDir();

const futureTs = Date.now() + 10 * 365 * 24 * 3600 * 1000; // ~2036
const decoyFuture = join(WAVE_E_DIR, `event-recall-${futureTs}.json`);
// A decoy that LOOKS like a real report but carries impossible numbers, so a
// runner that read it instead of the fresh one would be caught.
const decoyBody = JSON.stringify(
  {
    benchVersion: "DECOY-DO-NOT-READ",
    summary: {
      goldTargetEvents: 999999,
      proposedOk: 999999,
      misBounded: 0,
      missed: 0,
      recall: 1,
      meanBestOverlapOfProposedOk: 1,
      contactInsideRate: 1,
      contactInsideDenominator: 999999,
      totalProposals: 999999,
      lowAmplitudeProposals: 0,
      falseInNonEvent: 0,
      nonEventSpans: 0,
      unmatchedProposals: 0,
    },
  },
  null,
  2,
);
const decoyPast = join(WAVE_E_DIR, "event-recall-0.json");
const sha = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");

const statusBefore = gitStatusShort();
const outDir = join(OUT_DIR, "s1");
rmSync(outDir, { recursive: true, force: true });

writeFileSync(decoyFuture, decoyBody);
writeFileSync(decoyPast, decoyBody);
const decoyHash = sha(Buffer.from(decoyBody));
const listingBefore = new Set(readdirSync(WAVE_E_DIR));

let run: ReturnType<typeof cli> | null = null;
try {
  run = cli(["run", "--out-dir", outDir, "--run-id", "s1"]);
  writeFileSync(join(OUT_DIR, "s1-run.stdout.log"), run.stdout);
  writeFileSync(join(OUT_DIR, "s1-run.stderr.log"), run.stderr);

  check(checks, "runner exit code", run.exitCode === 0, `exit ${run.exitCode}`, "exit 0");

  const futureStillThere = existsSync(decoyFuture);
  const pastStillThere = existsSync(decoyPast);
  check(
    checks,
    "future-timestamped decoy never unlinked",
    futureStillThere && sha(readFileSync(decoyFuture)) === decoyHash,
    futureStillThere ? "exists, bytes identical" : "MISSING — runner unlinked a pre-existing file",
    "still present, byte-identical",
  );
  check(
    checks,
    "past-timestamped decoy never unlinked",
    pastStillThere && sha(readFileSync(decoyPast)) === decoyHash,
    pastStillThere ? "exists, bytes identical" : "MISSING — runner unlinked a pre-existing file",
    "still present, byte-identical",
  );

  const listingAfter = readdirSync(WAVE_E_DIR);
  const leftovers = listingAfter.filter((name) => !listingBefore.has(name));
  check(
    checks,
    "no new file left behind in wave-e",
    leftovers.length === 0,
    leftovers.length === 0 ? "none" : leftovers.join(", "),
    "runner consumed and removed exactly its own output",
  );

  const summaryPath = join(outDir, "s1.json");
  if (existsSync(summaryPath)) {
    const summary = readJson<Summary>(summaryPath);
    const recall = summary.benches.find((bench) => bench.id === "event_recall");
    check(
      checks,
      "event_recall bench ok",
      recall?.status === "ok",
      `${recall?.status ?? "<absent>"} ${recall?.error?.split("\n")[0] ?? ""}`,
      "ok",
    );
    const baseline = readJson<Summary>(BASELINE);
    const recallKeys = Object.keys(baseline.metrics).filter((key) =>
      key.startsWith("event_recall."),
    );
    const mismatched = recallKeys.filter((key) => baseline.metrics[key] !== summary.metrics[key]);
    check(
      checks,
      "event_recall metrics came from the real run, not the decoy",
      mismatched.length === 0 && summary.metrics["event_recall.gold_target_events"] !== 999999,
      mismatched.length === 0
        ? `all ${recallKeys.length} event_recall metrics equal baseline`
        : `differs from baseline: ${mismatched.join(", ")}`,
      "identical to baseline.json (deterministic replay)",
    );
    // Documented behaviour: an untracked file under datasets/ outside
    // reports/ is a bench INPUT change and marks the tree dirty. Record it.
    check(
      checks,
      "runner flags the untracked wave-e decoys as a dirty tree (documented)",
      summary.provenance.gitDirty === true &&
        summary.caveats.some((line) => line.startsWith("Working tree had uncommitted")),
      `gitDirty=${summary.provenance.gitDirty}`,
      "gitDirty=true with the dirty-tree caveat (stale bench OUTPUT under wave-e is indistinguishable from an input change)",
    );
  } else {
    check(checks, "summary written", false, "no summary at " + summaryPath, "summary written");
  }
} finally {
  if (existsSync(decoyFuture)) unlinkSync(decoyFuture);
  if (existsSync(decoyPast)) unlinkSync(decoyPast);
}

const statusAfter = gitStatusShort();
check(
  checks,
  "git status unchanged after cleanup",
  statusAfter === statusBefore,
  statusAfter || "<clean>",
  statusBefore || "<clean>",
);

finish("s1_preexisting_wave_e_file", startedAtIso, checks, {
  decoyFuture,
  decoyPast,
  runExit: run?.exitCode ?? null,
  stdoutLog: join(OUT_DIR, "s1-run.stdout.log"),
  summary: join(outDir, "s1.json"),
});
