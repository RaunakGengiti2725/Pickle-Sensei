// F16 Linux-proxy replay wrapper: runs the e02 contact-gold replay
// (packages/vision-geometry/eval/contactGoldReplay.ts, LINUX-CPU / committed
// pose / ORACLE-BALL / no paddle track — NOT the canonical Mac cascade) at
// the current commit and persists the full per-row report as a wave-g
// artifact WITHOUT the eval suite's assertions, so the head-state metrics
// are recorded even when an invariant fails (the failure itself is a
// finding, recorded separately in the f16 summary).
//
//   cd packages/vision-geometry && npx tsx ../../datasets/experiments/wave-g/g16-contact-replay-run.ts
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONTACT_ESTIMATOR_VERSION } from "../../../packages/vision-geometry/src/index.js";
import {
  loadGoldEvents,
  quantile,
  replayAll,
  type ReplayRow,
} from "../../../packages/vision-geometry/eval/contactGoldReplay.js";

const ROOT = join(import.meta.dirname ?? ".", "..", "..", "..");
const OUT_DIR = join(ROOT, "datasets/experiments/wave-g");

const STRICT_MS = 66;
const ACCEPT_MS = 132;

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
function roundOrNull(value: number | null): number | null {
  return value === null ? null : Math.round(value);
}

function metricsFor(rows: ReplayRow[]) {
  const target = rows.filter((row) => row.event.owner === "target");
  const estimated = target.filter((row) => row.status === "estimated");
  const errors = estimated
    .map((row) => row.errorMs!)
    .slice()
    .sort((a, b) => a - b);
  const wrong = estimated.filter((row) => row.errorMs! > ACCEPT_MS);
  return {
    targetEvents: target.length,
    estimated: estimated.length,
    abstained: target.length - estimated.length,
    coverage: target.length > 0 ? round3(estimated.length / target.length) : null,
    abstentionRate: target.length > 0 ? round3(1 - estimated.length / target.length) : null,
    wrongMarkers: wrong.length,
    wrongMarkerRateOfEstimated:
      estimated.length > 0 ? round3(wrong.length / estimated.length) : null,
    strictHits: errors.filter((error) => error <= STRICT_MS).length,
    acceptableHits: errors.filter((error) => error <= ACCEPT_MS).length,
    medianErrorMs: roundOrNull(quantile(errors, 0.5)),
    p75ErrorMs: roundOrNull(quantile(errors, 0.75)),
    p90ErrorMs: roundOrNull(quantile(errors, 0.9)),
  };
}

const rows = replayAll();
const gold = loadGoldEvents();
const overall = metricsFor(rows);
const sessions = [...new Set(rows.map((row) => row.event.session))].sort();
const bundles = [...new Set(rows.map((row) => row.event.bundle))].sort();
const highConfViolations = rows
  .filter(
    (row) =>
      row.event.owner === "target" &&
      row.status === "estimated" &&
      row.confidence! >= 0.7 &&
      row.errorMs! > ACCEPT_MS,
  )
  .map((row) => ({
    bundle: row.event.bundle,
    goldContactMs: row.event.contactMs,
    family: row.event.family,
    estimatedContactMs: row.estimatedContactMs,
    confidence: row.confidence,
    errorMs: Math.round(row.errorMs!),
    limitingFactors: row.limitingFactors,
  }));

const artifact = {
  experiment: "f16-cascade-linux-proxy (contact stage, e02 replay harness unmodified)",
  estimatorVersion: CONTACT_ESTIMATOR_VERSION,
  commit: execSync("git rev-parse HEAD", { cwd: ROOT }).toString().trim(),
  evaluatedAtIso: new Date().toISOString(),
  condition: {
    platform: "linux-cpu — NOT-CANONICAL / NOT-MAC",
    pose: "committed runs-wave-a people.json (auto target policy)",
    ball: "ORACLE (visually verified gold annotation frames, conf 0.9) — measures temporal fusion, NOT the ball tracker",
    paddle: "ABSENT (no committed paddle track for these bundles; wrist-gate proxy path exercised)",
    heldOut: "wm-dink-01 and afn-vic-rally1 never read",
    grouping: "bundle/session (no random-frame splits)",
    toleranceMs: { strict: STRICT_MS, acceptable: ACCEPT_MS },
  },
  goldEvents: gold.length,
  overall,
  highConfViolations,
  bySession: Object.fromEntries(
    sessions.map((session) => [
      session,
      metricsFor(rows.filter((row) => row.event.session === session)),
    ]),
  ),
  byBundle: Object.fromEntries(
    bundles.map((bundle) => [
      bundle,
      metricsFor(rows.filter((row) => row.event.bundle === bundle)),
    ]),
  ),
  rows: rows.map((row) => ({
    bundle: row.event.bundle,
    session: row.event.session,
    goldContactMs: row.event.contactMs,
    owner: row.event.owner,
    family: row.event.family,
    status: row.status,
    estimatedContactMs: row.estimatedContactMs,
    confidence: row.confidence,
    errorMs: row.errorMs === null ? null : Math.round(row.errorMs),
    reason: row.reason,
    limitingFactors: row.limitingFactors,
    ballConfirmed: row.ballConfirmed,
    supportingEvidence: row.supportingEvidence,
  })),
};
mkdirSync(OUT_DIR, { recursive: true });
const outPath = join(OUT_DIR, "g16-contact-replay.json");
writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`);
console.log(JSON.stringify(overall));
console.log(`highConfViolations: ${JSON.stringify(highConfViolations)}`);
console.log(`written: ${outPath}`);
