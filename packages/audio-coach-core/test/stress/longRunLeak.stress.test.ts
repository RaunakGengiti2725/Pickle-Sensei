import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { CHECKPOINTS } from "@pickle/shared-types";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_CUE_RULES,
  DEFAULT_LIVE_CUE_RULES,
  formatSpokenScore,
  INITIAL_COACH_STATE,
  INITIAL_LIVE_COACH_STATE,
  selectCue,
  selectLiveCue,
  sessionEndLine,
  SETUP_GUIDANCE_PHRASE,
  type CoachState,
  type CueDecision,
  type LiveCoachSessionState,
  type LiveCueDecision,
  type LiveRepObservation,
  type RepObservation,
} from "../../src/index.js";
import { liveRepStream, sessionEndInput, sparseRepStream } from "./seededStream.js";

/**
 * LONG-RUN LEAK stress campaign for the audio-coach cue engines.
 *
 * One "iteration" = one complete live coaching session mounted from
 * INITIAL_*_STATE, driven through `STRESS_REPS` seeded synthetic reps on BOTH
 * engines (talkative `selectLiveCue`, sparse `selectCue`) plus the closing
 * `sessionEndLine`, then dropped. Each iteration is replayable from its seed
 * (`STRESS_SEED + i`) and is run twice to pin determinism.
 *
 * Every 50 iterations the harness forces GC and records heap, RSS, external
 * memory, active libuv resources (timers/handles) and the per-iteration wall
 * time of the window. Findings by construction:
 *   - monotone heap slope > 5 % of the first sample per 100 iterations,
 *   - active resources not identical to the pre-campaign baseline,
 *   - per-iteration time drifting > 3× between the first and last window,
 *   - any property violation (listed per seed).
 *
 * Env knobs (defaults are small enough for the regular suite):
 *   STRESS_ITER  iterations            (default 500 — the lens minimum)
 *   STRESS_REPS  reps per session      (default 60)
 *   STRESS_SEED  base seed             (default 20260904)
 *   STRESS_OUT   JSON table path       (default: not written)
 *   STRESS_KEEP_ROWS=0  retain only failing rows so the heap series measures
 *                       the engines alone, without harness bookkeeping
 *
 * Replay one seed:
 *   STRESS_ITER=1 STRESS_SEED=<seed> pnpm --filter @pickle/audio-coach-core test -- test/stress
 */

const ITERATIONS = readIntEnv("STRESS_ITER", 500);
const REPS = readIntEnv("STRESS_REPS", 60);
const BASE_SEED = readIntEnv("STRESS_SEED", 20260904);
const OUT_PATH = process.env["STRESS_OUT"] ?? null;
const KEEP_ROWS = process.env["STRESS_KEEP_ROWS"] !== "0";
const SAMPLE_EVERY = 50;
const HEAP_SLOPE_LIMIT_PCT_PER_100 = 5;
const TIME_DRIFT_LIMIT = 3;

const LIVE_CATEGORIES = new Set([
  "CORRECTION",
  "REPEAT_CORRECTION",
  "IMPROVEMENT",
  "PERSONAL_BEST",
  "PRAISE",
  "NO_READ",
  "SETUP_GUIDANCE",
]);
const SPARSE_CATEGORIES = new Set([
  "CORRECTION",
  "IMPROVEMENT",
  "PERSONAL_BEST",
  "REPEAT",
  "STABLE",
  "SILENCE",
]);
const CHECKPOINT_SET = new Set<string>(CHECKPOINTS);
const NON_FINITE_TOKENS = ["NaN", "Infinity", "undefined", "null"];

function readIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative int`);
  return parsed;
}

function forceGc(): boolean {
  if (typeof globalThis.gc !== "function") return false;
  globalThis.gc();
  globalThis.gc();
  return true;
}

function resourceCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const name of process.getActiveResourcesInfo()) counts[name] = (counts[name] ?? 0) + 1;
  return counts;
}

function sameCounts(a: Record<string, number>, b: Record<string, number>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) if ((a[key] ?? 0) !== (b[key] ?? 0)) return false;
  return true;
}

function textIsClean(text: string): boolean {
  return text.length > 0 && !NON_FINITE_TOKENS.some((token) => text.includes(token));
}

interface LiveRun {
  decisions: LiveCueDecision[];
  state: LiveCoachSessionState;
}

function runLive(reps: readonly LiveRepObservation[]): LiveRun {
  const decisions: LiveCueDecision[] = [];
  let state = INITIAL_LIVE_COACH_STATE;
  for (const rep of reps) {
    const { decision, nextState } = selectLiveCue(state, rep, DEFAULT_LIVE_CUE_RULES);
    decisions.push(decision);
    state = nextState;
  }
  return { decisions, state };
}

interface SparseRun {
  decisions: CueDecision[];
  state: CoachState;
}

function runSparse(reps: readonly RepObservation[]): SparseRun {
  const decisions: CueDecision[] = [];
  let state = INITIAL_COACH_STATE;
  for (const rep of reps) {
    const { decision, nextState } = selectCue(state, rep, DEFAULT_CUE_RULES);
    decisions.push(decision);
    state = nextState;
  }
  return { decisions, state };
}

/** Independent oracle for the live policy's hard rules. */
function checkLive(reps: readonly LiveRepObservation[], run: LiveRun, violations: string[]): void {
  const { decisions, state } = run;
  if (decisions.length !== reps.length) violations.push("live: decision count != rep count");
  let noReadStreak = 0;
  let bestSoFar: number | null = null;
  for (let i = 0; i < reps.length; i += 1) {
    const rep = reps[i];
    const d = decisions[i];
    if (!rep || !d) continue;
    const at = `live rep ${rep.repIndex}`;
    if (!LIVE_CATEGORIES.has(d.category)) violations.push(`${at}: unknown category ${d.category}`);
    if (!textIsClean(d.text)) violations.push(`${at}: unclean text ${JSON.stringify(d.text)}`);
    if (d.targetCheckpoint !== null && !CHECKPOINT_SET.has(d.targetCheckpoint)) {
      violations.push(`${at}: targetCheckpoint outside canon ${d.targetCheckpoint}`);
    }
    if (d.announcedScore !== null) {
      if (!Number.isFinite(d.announcedScore)) violations.push(`${at}: non-finite announcedScore`);
      if (d.announcedScore !== rep.overallScore) {
        violations.push(`${at}: announcedScore ${d.announcedScore} != overall ${rep.overallScore}`);
      }
      if (!d.text.includes(formatSpokenScore(d.announcedScore))) {
        violations.push(`${at}: announced score missing from text`);
      }
    }
    if (rep.kind !== "scored") {
      noReadStreak += 1;
      const expected =
        noReadStreak >= DEFAULT_LIVE_CUE_RULES.setupGuidanceAfter ? "SETUP_GUIDANCE" : "NO_READ";
      if (d.category !== expected)
        violations.push(`${at}: expected ${expected}, got ${d.category}`);
      if (expected === "SETUP_GUIDANCE") {
        noReadStreak = 0;
        if (d.text !== SETUP_GUIDANCE_PHRASE) violations.push(`${at}: setup guidance text drifted`);
      }
      if (d.targetCheckpoint !== null || d.announcedScore !== null) {
        violations.push(`${at}: no-read carries checkpoint/score`);
      }
      continue;
    }
    noReadStreak = 0;
    if (d.category === "NO_READ" || d.category === "SETUP_GUIDANCE") {
      violations.push(`${at}: scored rep spoken as ${d.category}`);
    }
    const isPersonalBest =
      rep.overallScore !== null &&
      bestSoFar !== null &&
      rep.overallScore > bestSoFar &&
      rep.repIndex >= DEFAULT_LIVE_CUE_RULES.personalBestMinRep;
    if (isPersonalBest !== (d.category === "PERSONAL_BEST")) {
      violations.push(`${at}: personal-best oracle ${isPersonalBest} vs ${d.category}`);
    }
    if (rep.overallScore !== null) {
      bestSoFar = bestSoFar === null ? rep.overallScore : Math.max(bestSoFar, rep.overallScore);
    }
    const needsTarget =
      d.category === "CORRECTION" ||
      d.category === "REPEAT_CORRECTION" ||
      d.category === "IMPROVEMENT";
    if (needsTarget !== (d.targetCheckpoint !== null)) {
      violations.push(`${at}: ${d.category} target presence mismatch`);
    }
  }
  if (state.bestOverall !== bestSoFar) violations.push("live: bestOverall != oracle max");
  const stateKeys = Object.keys(state).sort().join(",");
  const initialKeys = Object.keys(INITIAL_LIVE_COACH_STATE).sort().join(",");
  if (stateKeys !== initialKeys) violations.push(`live: state grew extra keys ${stateKeys}`);
  if (Object.keys(state.previousCheckpointScores).length > CHECKPOINTS.length) {
    violations.push("live: previousCheckpointScores grew beyond checkpoint canon");
  }
  for (const counter of [state.praiseCounter, state.noReadCounter, state.noReadStreak]) {
    if (!Number.isSafeInteger(counter) || counter < 0)
      violations.push("live: counter not a safe int");
  }
}

/** Independent oracle for the sparse engine's hard rules. */
function checkSparse(reps: readonly RepObservation[], run: SparseRun, violations: string[]): void {
  const { decisions, state } = run;
  if (decisions.length !== reps.length) violations.push("sparse: decision count != rep count");
  let lowStreak = 0;
  let bestSoFar: number | null = null;
  let correctionRun = 0;
  let lastStableRep: number | null = null;
  for (let i = 0; i < reps.length; i += 1) {
    const rep = reps[i];
    const d = decisions[i];
    if (!rep || !d) continue;
    const at = `sparse rep ${rep.repIndex}`;
    if (!SPARSE_CATEGORIES.has(d.category))
      violations.push(`${at}: unknown category ${d.category}`);
    if (d.category === "SILENCE") {
      if (d.text !== null) violations.push(`${at}: SILENCE carries text`);
    } else if (d.text === null || !textIsClean(d.text)) {
      violations.push(`${at}: ${d.category} text unclean ${JSON.stringify(d.text)}`);
    }
    if (rep.resultKind === "low_confidence") {
      lowStreak += 1;
      correctionRun = 0;
      if (lowStreak >= DEFAULT_CUE_RULES.lowConfidenceGuidanceAfter) {
        lowStreak = 0;
        if (d.category !== "CORRECTION" || d.text !== SETUP_GUIDANCE_PHRASE) {
          violations.push(`${at}: expected setup guidance, got ${d.category}`);
        }
      } else if (d.category !== "SILENCE") {
        violations.push(`${at}: low-confidence rep spoken as ${d.category}`);
      }
      continue;
    }
    lowStreak = 0;
    const isPersonalBest =
      rep.overallScore !== null &&
      bestSoFar !== null &&
      rep.overallScore > bestSoFar &&
      rep.repIndex >= DEFAULT_CUE_RULES.personalBestMinRep;
    if (isPersonalBest !== (d.category === "PERSONAL_BEST")) {
      violations.push(`${at}: personal-best oracle ${isPersonalBest} vs ${d.category}`);
    }
    if (rep.overallScore !== null) {
      bestSoFar = bestSoFar === null ? rep.overallScore : Math.max(bestSoFar, rep.overallScore);
    }
    if (d.category === "CORRECTION" || d.category === "REPEAT") {
      correctionRun += 1;
      if (correctionRun > DEFAULT_CUE_RULES.maxConsecutiveCorrections) {
        violations.push(`${at}: ${correctionRun} corrections in a row (nagging)`);
      }
    } else {
      correctionRun = 0;
    }
    if (d.category === "STABLE") {
      if (
        lastStableRep !== null &&
        rep.repIndex - lastStableRep < DEFAULT_CUE_RULES.stableCooldownReps
      ) {
        violations.push(`${at}: STABLE inside cooldown (last ${lastStableRep})`);
      }
      lastStableRep = rep.repIndex;
    }
  }
  if (state.bestOverallScore !== bestSoFar)
    violations.push("sparse: bestOverallScore != oracle max");
  const stateKeys = Object.keys(state).sort().join(",");
  const initialKeys = Object.keys(INITIAL_COACH_STATE).sort().join(",");
  if (stateKeys !== initialKeys) violations.push(`sparse: state grew extra keys ${stateKeys}`);
}

interface IterationRow {
  iteration: number;
  seed: number;
  ok: boolean;
  violations: string[];
  liveCategories: Record<string, number>;
  sparseCategories: Record<string, number>;
  ms: number;
}

interface Sample {
  iteration: number;
  heapUsed: number;
  heapTotal: number;
  rss: number;
  external: number;
  arrayBuffers: number;
  resources: Record<string, number>;
  resourcesMatchBaseline: boolean;
  msPerIterationWindow: number;
}

function tally(categories: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const category of categories) counts[category] = (counts[category] ?? 0) + 1;
  return counts;
}

function runIteration(iteration: number): IterationRow {
  const seed = BASE_SEED + iteration;
  const started = performance.now();
  const violations: string[] = [];

  const liveReps = liveRepStream(seed, REPS);
  const liveInputSnapshot = JSON.stringify(liveReps);
  const liveA = runLive(liveReps);
  const liveB = runLive(liveReps);
  if (JSON.stringify(liveA) !== JSON.stringify(liveB))
    violations.push("live: non-deterministic replay");
  if (JSON.stringify(liveReps) !== liveInputSnapshot) violations.push("live: input mutated");
  checkLive(liveReps, liveA, violations);

  const sparseReps = sparseRepStream(seed, REPS);
  const sparseInputSnapshot = JSON.stringify(sparseReps);
  const sparseA = runSparse(sparseReps);
  const sparseB = runSparse(sparseReps);
  if (JSON.stringify(sparseA) !== JSON.stringify(sparseB)) {
    violations.push("sparse: non-deterministic replay");
  }
  if (JSON.stringify(sparseReps) !== sparseInputSnapshot) violations.push("sparse: input mutated");
  checkSparse(sparseReps, sparseA, violations);

  const endLine = sessionEndLine(sessionEndInput(seed, REPS));
  if (!textIsClean(endLine)) violations.push(`end line unclean ${JSON.stringify(endLine)}`);

  return {
    iteration,
    seed,
    ok: violations.length === 0,
    violations,
    liveCategories: tally(liveA.decisions.map((d) => d.category)),
    sparseCategories: tally(sparseA.decisions.map((d) => d.category)),
    ms: performance.now() - started,
  };
}

/** Ordinary least squares slope of heapUsed over iteration index. */
function heapSlopePer100(samples: readonly Sample[]): number | null {
  if (samples.length < 2) return null;
  const n = samples.length;
  const meanX = samples.reduce((acc, s) => acc + s.iteration, 0) / n;
  const meanY = samples.reduce((acc, s) => acc + s.heapUsed, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (const s of samples) {
    sxy += (s.iteration - meanX) * (s.heapUsed - meanY);
    sxx += (s.iteration - meanX) ** 2;
  }
  if (sxx === 0) return null;
  return (sxy / sxx) * 100;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const lo = sorted[mid - 1];
  const hi = sorted[mid];
  if (hi === undefined) return 0;
  return sorted.length % 2 === 0 && lo !== undefined ? (lo + hi) / 2 : hi;
}

describe(`long-run leak: ${ITERATIONS} sessions × ${REPS} reps (seed ${BASE_SEED})`, () => {
  const initialLiveSnapshot = JSON.stringify(INITIAL_LIVE_COACH_STATE);
  const initialSparseSnapshot = JSON.stringify(INITIAL_COACH_STATE);

  it(
    "holds every property, returns handles to baseline and keeps the heap flat",
    () => {
      const gcAvailable = forceGc();
      const baselineResources = resourceCounts();
      const baselineHeap = process.memoryUsage().heapUsed;

      const rows: IterationRow[] = [];
      const timings: number[] = [];
      const samples: Sample[] = [];
      let executed = 0;
      let windowMs = 0;
      for (let iteration = 1; iteration <= ITERATIONS; iteration += 1) {
        const row = runIteration(iteration);
        executed += 1;
        if (KEEP_ROWS || !row.ok) rows.push(row);
        timings.push(row.ms);
        windowMs += row.ms;
        if (iteration % SAMPLE_EVERY === 0 || iteration === ITERATIONS) {
          forceGc();
          const memory = process.memoryUsage();
          const resources = resourceCounts();
          samples.push({
            iteration,
            heapUsed: memory.heapUsed,
            heapTotal: memory.heapTotal,
            rss: memory.rss,
            external: memory.external,
            arrayBuffers: memory.arrayBuffers,
            resources,
            resourcesMatchBaseline: sameCounts(resources, baselineResources),
            msPerIterationWindow: windowMs / SAMPLE_EVERY,
          });
          windowMs = 0;
        }
      }

      const failing = rows.filter((row) => !row.ok);
      const firstSample = samples[0];
      const slope = heapSlopePer100(samples);
      const slopePct =
        slope !== null && firstSample !== undefined ? (slope / firstSample.heapUsed) * 100 : null;
      const windowSize = Math.max(1, Math.min(2 * SAMPLE_EVERY, Math.floor(timings.length / 2)));
      const firstWindow = timings.slice(0, windowSize);
      const lastWindow = timings.slice(-windowSize);
      const firstMedian = median(firstWindow);
      const lastMedian = median(lastWindow);
      const timeDrift = firstMedian > 0 ? lastMedian / firstMedian : null;
      const handlesReturned = samples.every((sample) => sample.resourcesMatchBaseline);

      const report = {
        config: {
          iterations: ITERATIONS,
          reps: REPS,
          baseSeed: BASE_SEED,
          sampleEvery: SAMPLE_EVERY,
          keepRows: KEEP_ROWS,
        },
        gcAvailable,
        node: process.version,
        baseline: { heapUsed: baselineHeap, resources: baselineResources },
        samples,
        heap: {
          slopeBytesPer100Iterations: slope,
          slopePctOfFirstSamplePer100Iterations: slopePct,
          limitPctPer100: HEAP_SLOPE_LIMIT_PCT_PER_100,
        },
        timing: {
          firstWindowMedianMs: firstMedian,
          lastWindowMedianMs: lastMedian,
          drift: timeDrift,
        },
        handlesReturnedToBaseline: handlesReturned,
        initialStatesUntouched:
          JSON.stringify(INITIAL_LIVE_COACH_STATE) === initialLiveSnapshot &&
          JSON.stringify(INITIAL_COACH_STATE) === initialSparseSnapshot,
        executed,
        failingSeeds: failing.map((row) => row.seed),
        iterations: rows,
      };
      if (OUT_PATH !== null) {
        mkdirSync(dirname(OUT_PATH), { recursive: true });
        writeFileSync(OUT_PATH, JSON.stringify(report, null, 2));
      }

      expect(executed).toBe(ITERATIONS);
      expect(
        failing.map((row) => `${row.seed}: ${row.violations.slice(0, 3).join(" | ")}`),
        "property violations by seed",
      ).toEqual([]);
      expect(report.initialStatesUntouched, "INITIAL_*_STATE mutated by a session").toBe(true);
      expect(
        handlesReturned,
        `active resources drifted: ${JSON.stringify(samples.map((s) => s.resources))}`,
      ).toBe(true);
      if (ITERATIONS >= 2 * SAMPLE_EVERY) {
        expect(gcAvailable, "GC not exposed — heap slope cannot be measured").toBe(true);
        expect(slopePct, "heap slope % per 100 iterations").not.toBeNull();
        if (slopePct !== null) expect(slopePct).toBeLessThan(HEAP_SLOPE_LIMIT_PCT_PER_100);
        if (timeDrift !== null)
          expect(timeDrift, "per-iteration time drift").toBeLessThan(TIME_DRIFT_LIMIT);
      }
    },
    Math.max(30_000, ITERATIONS * 25),
  );
});
