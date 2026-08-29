// W3 (wave-b) per-case forensics over ta-bench result files (dev n=54).
// Usage: node datasets/experiments/wave-b/W3-analyze.mjs
// Reads ONLY datasets/ta-bench/results/* produced by `pnpm lab:ta-bench run
// --split dev`; never touches cases.json verdicts, locked_test, or shadow.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const resultsDir = join(here, "../../ta-bench/results");

// Variant → results file (all runs are --split dev, verified only, n=54).
const RUNS = {
  shipped: "ta-bench-1787969176233.json",
  legacy: "ta-bench-1787969182746.json",
  hysteresis: "ta-bench-1787968922982.json",
  "sustained-gesture": "ta-bench-1787968929834.json",
  "ambiguity-timeout": "ta-bench-1787968937199.json",
  "dominance-gate": "ta-bench-1787969272621.json",
  "sustained-ambiguity": "ta-bench-1787969281721.json",
  "acquire-v3": "ta-bench-1787969290367.json",
  "acquire-v3-strict-gesture": "ta-bench-1787969297321.json",
  "centered-gate": "ta-bench-1787969707165.json",
  "acquire-v4": "ta-bench-1787969715899.json",
  "acquire-v4-strict-gesture": "ta-bench-1787969723950.json",
};

const load = (file) => JSON.parse(readFileSync(join(resultsDir, file), "utf8"));
const runs = Object.fromEntries(Object.entries(RUNS).map(([name, file]) => [name, load(file)]));
const shipped = runs.shipped.results;
const byId = (results) => new Map(results.map((r) => [r.caseId, r]));
const shippedById = byId(shipped);

// ── shipped failure buckets (the wave-a anatomy, recomputed from results) ──
const bucketOf = {
  instantWrong: shipped
    .filter((r) => r.lockSource === "start_region_occupancy" && r.lockCorrect === false)
    .map((r) => r.caseId),
  timeoutWrong: shipped
    .filter((r) => r.lockSource === "ambiguity_timeout" && r.lockCorrect === false)
    .map((r) => r.caseId),
  gestureWrong: shipped
    .filter((r) => r.lockSource === "gesture_confirmed" && r.lockCorrect === false)
    .map((r) => r.caseId),
  drift: shipped
    .filter((r) => r.lockCorrect === true && (r.postLock?.onTargetFraction ?? 1) < 0.5)
    .map((r) => r.caseId),
};

const median = (xs) =>
  xs.length ? xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null;
const round = (x, d = 3) => (x === null ? null : Number(x.toFixed(d)));

function summarize(results) {
  const locked = results.filter((r) => r.outcome === "locked");
  const correct = locked.filter((r) => r.lockCorrect === true);
  const wrong = locked.filter((r) => r.lockCorrect !== true);
  const falseGesture = wrong.filter((r) => r.lockSource === "gesture_confirmed");
  return {
    n: results.length,
    lockRate: round(locked.length / Math.max(1, results.length)),
    lockCorrect: `${correct.length}/${locked.length}`,
    lockCorrectRate: round(locked.length ? correct.length / locked.length : null),
    wrongLocks: wrong.length,
    wrongLockRateOfCases: round(wrong.length / Math.max(1, results.length)),
    falseGestureLocks: falseGesture.length,
    medianLockLatencyMs: median(locked.map((r) => r.lockLatencyMs)),
    meanOnTargetFraction: round(
      locked.length
        ? locked.reduce((t, r) => t + (r.postLock?.onTargetFraction ?? 0), 0) / locked.length
        : null,
    ),
    ambiguityEntered: results.filter((r) => r.ambiguityEntered).length,
    unresolvedOrNeverLocked: results.filter((r) => r.outcome !== "locked").length,
    lockSources: Object.fromEntries(
      [...new Set(locked.map((r) => r.lockSource))].map((s) => [
        s,
        locked.filter((r) => r.lockSource === s).length,
      ]),
    ),
    driftCorrectLocksBelow50: correct.filter((r) => (r.postLock?.onTargetFraction ?? 1) < 0.5)
      .length,
  };
}

const outcomeOf = (r) =>
  r.outcome !== "locked"
    ? r.outcome // never_locked | ambiguous_unresolved (recoverable non-locks)
    : r.lockCorrect === true
      ? `correct_lock(${r.lockSource})`
      : `WRONG_lock(${r.lockSource})`;

const table = {};
for (const [name, run] of Object.entries(runs)) {
  const results = run.results;
  const contested = results.filter((r) => r.situation.includes("contested_region"));
  const nonContested = results.filter((r) => !r.situation.includes("contested_region"));
  const map = byId(results);
  const bucketView = {};
  for (const [bucket, ids] of Object.entries(bucketOf)) {
    bucketView[bucket] = {};
    for (const id of ids) bucketView[bucket][id] = outcomeOf(map.get(id));
  }
  const regressions = results
    .filter(
      (r) =>
        shippedById.get(r.caseId).lockCorrect === true &&
        r.outcome === "locked" &&
        r.lockCorrect !== true,
    )
    .map((r) => `${r.caseId} (${r.lockSource})`);
  table[name] = {
    variantConfig: run.variant.config,
    overall: summarize(results),
    contested_region: summarize(contested),
    nonContested: summarize(nonContested),
    shippedBuckets: bucketView,
    regressionsVsShipped_correctBecameWrong: regressions,
  };
}

const bucketCounts = Object.fromEntries(Object.entries(bucketOf).map(([k, v]) => [k, v.length]));
const out = {
  generatedFrom: RUNS,
  shippedBucketSizes: bucketCounts,
  shippedBucketCaseIds: bucketOf,
  variants: table,
};
writeFileSync(join(here, "W3-variant-table.json"), JSON.stringify(out, null, 2));

// Console digest
console.log("shipped buckets:", JSON.stringify(bucketCounts));
const cols = [
  "lockRate",
  "lockCorrect",
  "lockCorrectRate",
  "wrongLocks",
  "falseGestureLocks",
  "medianLockLatencyMs",
  "meanOnTargetFraction",
  "unresolvedOrNeverLocked",
];
for (const [name, entry] of Object.entries(table)) {
  console.log(`\n═ ${name}`);
  console.log("  overall  ", cols.map((c) => `${c}=${JSON.stringify(entry.overall[c])}`).join(" "));
  console.log(
    "  contested",
    cols.map((c) => `${c}=${JSON.stringify(entry.contested_region[c])}`).join(" "),
  );
  console.log(
    "  nonCont. ",
    cols.map((c) => `${c}=${JSON.stringify(entry.nonContested[c])}`).join(" "),
  );
  console.log("  sources  ", JSON.stringify(entry.overall.lockSources));
  const flips = {};
  for (const [bucket, view] of Object.entries(entry.shippedBuckets)) {
    flips[bucket] = Object.values(view).reduce((acc, o) => ((acc[o] = (acc[o] ?? 0) + 1), acc), {});
  }
  console.log("  buckets  ", JSON.stringify(flips));
  console.log("  regress. ", JSON.stringify(entry.regressionsVsShipped_correctBecameWrong));
}
