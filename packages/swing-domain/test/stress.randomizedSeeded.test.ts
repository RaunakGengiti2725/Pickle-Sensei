/**
 * Seeded randomized long-run stress campaign over @pickle/swing-domain.
 *
 * Every iteration derives a plan of 5..60 legal / near-legal / hostile actions
 * from a 32-bit seed (see test/stress/swingDomainCampaign.ts for the action
 * vocabulary and the invariant catalogue), executes it against the real
 * package with an oracle model, checks every invariant after every step and
 * executes the identical plan a second time to prove the trace is
 * byte-for-byte deterministic.
 *
 * Environment:
 *   STRESS_ITER  sequences per run (default 120 — fast enough for the suite)
 *   STRESS_SEED  base seed (default 20260904); per-sequence seeds derive from it
 *   STRESS_OUT   when set, the seed → outcome JSON table is written there
 *   STRESS_SINGLE=1 use STRESS_SEED verbatim as the (single) sequence seed
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CAPTURE_ENVELOPE_VERSION_NOT_MEASURED,
  explainAnalysisRun,
  sha256Hex,
  type AnalysisRecord,
} from "../src/index.js";
import { canonicalJson, sequenceSeed } from "./stress/rng.js";
import {
  executePlan,
  generatePlan,
  minimizePlan,
  type InputClass,
  type SwingAction,
  type Violation,
} from "./stress/swingDomainCampaign.js";

const ITER = Number.parseInt(process.env.STRESS_ITER ?? "120", 10);
const BASE_SEED = Number.parseInt(process.env.STRESS_SEED ?? "20260904", 10);
const SINGLE = process.env.STRESS_SINGLE === "1";
const OUT = process.env.STRESS_OUT;
const MAX_MINIMIZED_PER_INVARIANT = 3;

/**
 * Invariants the campaign has shown the CURRENT implementation violates for
 * in-domain input. Each is pinned below with a minimal deterministic repro
 * (`it.fails`) so the suite flips when it is fixed; the campaign records
 * but does not fail on them.
 */
const KNOWN_BROKEN: ReadonlySet<string> = new Set(["E2", "H3"]);

interface Row {
  seed: number;
  length: number;
  actions: Record<string, number>;
  traceHash: string;
  deterministic: boolean;
  outcome: "held" | "violated" | "hostile_only" | "known_broken_only";
  violations: Violation[];
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function classify(violations: Violation[]): Row["outcome"] {
  if (violations.length === 0) return "held";
  const inDomain = violations.filter((v) => v.inputClass !== "hostile");
  if (inDomain.length === 0) return "hostile_only";
  if (inDomain.every((v) => KNOWN_BROKEN.has(v.invariant))) return "known_broken_only";
  return "violated";
}

describe("stress: seeded randomized long-run over @pickle/swing-domain", () => {
  it(
    `holds every invariant over ${ITER} seeded action sequences (len 5-60) and replays deterministically`,
    { timeout: 30 * 60_000 },
    async () => {
      const rows: Row[] = [];
      let scenarios = 0;
      let steps = 0;
      for (let i = 0; i < ITER; i++) {
        const seed = SINGLE ? BASE_SEED : sequenceSeed(BASE_SEED, i);
        const plan = generatePlan(seed);
        const planAgain = generatePlan(seed);
        expect(canonicalJson(planAgain), `plan generation for seed ${seed} is deterministic`).toBe(
          canonicalJson(plan),
        );
        const first = await executePlan(plan);
        const second = await executePlan(plan);
        const traceHash = hash(canonicalJson(first.trace));
        const deterministic = traceHash === hash(canonicalJson(second.trace));
        const violations = [...first.violations];
        if (!deterministic) {
          violations.push({
            step: -1,
            action: "pose_roundtrip",
            invariant: "DETERMINISM",
            inputClass: "legal",
            detail: "same plan executed twice produced different traces",
          });
        }
        scenarios++;
        steps += plan.length;
        rows.push({
          seed,
          length: plan.length,
          actions: first.actionCounts,
          traceHash,
          deterministic,
          outcome: classify(violations),
          violations,
        });
      }

      const minimized: Array<{
        seed: number;
        invariant: string;
        inputClass: InputClass;
        originalLength: number;
        minimizedLength: number;
        detail: string;
        actions: SwingAction[];
      }> = [];
      const perInvariant = new Map<string, number>();
      for (const row of rows) {
        const seen = new Set<string>();
        for (const v of row.violations) {
          if (v.invariant === "DETERMINISM") continue;
          const key = `${v.inputClass}:${v.invariant}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const n = perInvariant.get(key) ?? 0;
          if (n >= MAX_MINIMIZED_PER_INVARIANT) continue;
          perInvariant.set(key, n + 1);
          const plan = generatePlan(row.seed);
          const result = await minimizePlan(plan, v.invariant);
          minimized.push({
            seed: row.seed,
            invariant: v.invariant,
            inputClass: result.violation?.inputClass ?? v.inputClass,
            originalLength: plan.length,
            minimizedLength: result.actions.length,
            detail: result.violation?.detail ?? v.detail,
            actions: result.actions,
          });
        }
      }

      const byInvariant: Record<
        string,
        { sequences: number; steps: number; classes: Record<string, number> }
      > = {};
      for (const row of rows) {
        const seenInRow = new Set<string>();
        for (const v of row.violations) {
          const entry = (byInvariant[v.invariant] ??= { sequences: 0, steps: 0, classes: {} });
          entry.steps++;
          entry.classes[v.inputClass] = (entry.classes[v.inputClass] ?? 0) + 1;
          if (!seenInRow.has(v.invariant)) {
            seenInRow.add(v.invariant);
            entry.sequences++;
          }
        }
      }
      const summary = {
        package: "@pickle/swing-domain",
        baseSeed: BASE_SEED,
        iterations: ITER,
        scenariosExecuted: scenarios,
        stepsExecuted: steps,
        minLength: Math.min(...rows.map((r) => r.length)),
        maxLength: Math.max(...rows.map((r) => r.length)),
        deterministicSequences: rows.filter((r) => r.deterministic).length,
        outcomes: {
          held: rows.filter((r) => r.outcome === "held").length,
          known_broken_only: rows.filter((r) => r.outcome === "known_broken_only").length,
          hostile_only: rows.filter((r) => r.outcome === "hostile_only").length,
          violated: rows.filter((r) => r.outcome === "violated").length,
        },
        knownBroken: [...KNOWN_BROKEN],
        violationsByInvariant: byInvariant,
      };
      if (OUT) {
        mkdirSync(dirname(OUT), { recursive: true });
        writeFileSync(OUT, canonicalJson({ summary, minimized, rows }) + "\n");
      }

      expect(scenarios).toBe(ITER);
      expect(rows.every((r) => r.length >= 5 && r.length <= 60)).toBe(true);
      expect(rows.filter((r) => !r.deterministic).map((r) => r.seed)).toEqual([]);
      const unexpected = rows
        .flatMap((r) => r.violations.map((v) => ({ seed: r.seed, ...v })))
        .filter((v) => v.inputClass !== "hostile" && !KNOWN_BROKEN.has(v.invariant));
      expect(unexpected, JSON.stringify(unexpected.slice(0, 5), null, 2)).toEqual([]);
    },
  );
});

// ---------------------------------------------------------------------------
// Pinned minimal repros for the invariants the campaign found BROKEN. Each is
// `it.fails`: the assertion states the intended behaviour, and the test turns
// red the day the behaviour is fixed (then move it to a regular `it`).
// ---------------------------------------------------------------------------

describe("stress findings pinned (currently failing on purpose)", () => {
  it.fails("E2: explainAnalysisRun rejects non-ISO provenance timestamps", () => {
    const record: AnalysisRecord = {
      schemaVersion: 1,
      id: "record-1",
      captureId: "capture-1",
      createdAtIso: "2026-01-01T00:00:00.000Z",
      engineVersion: "fusion-1",
      strokeTaxonomyVersion: "pickleball-taxonomy-v2",
      strokeResolution: { kind: "declared", shotType: "dink" },
      modalities: { pose: true, paddle: false, ball: false, court: false, camera: false },
      modelRuns: [],
      provenance: {
        appVersion: "1.0.0",
        pipelineVersion: "fusion-1",
        providerVersions: [
          {
            providerId: "pose.apple-vision",
            modelVersion: "apple-vision-bodypose-1",
            runtime: "vision_framework",
            executionTarget: "on_device",
            artifactHash: null,
          },
        ],
        scoreVersion: "sm-v1",
        taxonomyVersion: "pickleball-taxonomy-v2",
        drillMappingVersion: "none",
        captureEnvelopeVersion: CAPTURE_ENVELOPE_VERSION_NOT_MEASURED,
        recordedAtIso: "1",
      },
      result: null,
      faults: [],
      uncertainty: {
        analysisConfidence: 0.5,
        presentation: "normal",
        perCheckpoint: {},
        limitingFactors: [],
      },
      evidence: [],
      shadow: [],
    };
    for (const value of ["1", "12/25/2026", "Jan 5 2026", "2026-02-30T00:00:00Z"]) {
      const result = explainAnalysisRun({
        ...record,
        provenance: { ...record.provenance, recordedAtIso: value },
      });
      expect(result.ok, `recordedAtIso=${JSON.stringify(value)} must be rejected`).toBe(false);
      if (!result.ok) expect(result.failure.code).toBe("provenance.invalid_timestamp");
    }
  });

  it.fails("H3: sha256Hex fallback encoder agrees with TextEncoder on lone surrogates", () => {
    const input = "paddle\ud83c";
    const withEncoder = sha256Hex(input);
    const g = globalThis as { TextEncoder?: unknown };
    const saved = g.TextEncoder;
    delete g.TextEncoder;
    let withoutEncoder: string;
    try {
      withoutEncoder = sha256Hex(input);
    } finally {
      g.TextEncoder = saved;
    }
    expect(withoutEncoder).toBe(withEncoder);
  });
});
