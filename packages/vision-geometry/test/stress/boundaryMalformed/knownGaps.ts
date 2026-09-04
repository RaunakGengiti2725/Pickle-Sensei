import type { Mutation } from "./malformed.js";

/**
 * Catalogue of boundary-contract gaps the campaign reproduces on the current
 * production code. Each entry names the scenario(s) and violation kind it
 * explains and the input condition under which the defect fires. The stress
 * suite fails on any BROKEN record that no entry explains (a new gap), and
 * `boundaryMalformed.knownGaps.test.ts` pins every entry with a minimized
 * input — so fixing a defect forces its entry out of this list, and a new
 * defect cannot hide behind an old one.
 *
 * Nothing here weakens the contract: every matching record is still counted
 * as BROKEN in the campaign JSON; the catalogue only separates "already
 * reported" from "new".
 */

export interface KnownGap {
  id: string;
  severity: "P1" | "P2" | "P3";
  title: string;
  files: string[];
  scenarios: readonly string[];
  /** Violation-kind prefixes (text before the first ':') this gap explains. */
  kinds: readonly string[];
  /** Input precondition: the gap fires only when this holds for the mutations. */
  when: (mutations: readonly Mutation[]) => boolean;
}

const OVERFLOW_MAGNITUDE = 1e300;

/** True when the mutation list injects NaN/±Infinity or an overflow-scale number. */
export function injectsNonFiniteOrOverflow(mutations: readonly Mutation[]): boolean {
  return mutations.some((mutation) => {
    if (mutation.op === "poison_all_numbers") return true;
    if (mutation.op !== "number_special") return false;
    const detail = String(mutation.detail);
    if (/NaN|Infinity/.test(detail)) return true;
    const numeric = Number(detail);
    return Number.isFinite(numeric) && Math.abs(numeric) >= OVERFLOW_MAGNITUDE;
  });
}

const always = (): boolean => true;

export const KNOWN_GAPS: readonly KnownGap[] = [
  {
    id: "KG-01",
    severity: "P3",
    title: "Non-finite input numbers propagate unchecked into report/evidence outputs",
    files: [
      "packages/vision-geometry/src/frameAnalyzability.ts:137-215",
      "packages/vision-geometry/src/captureQuality.ts:63-133",
      "packages/vision-geometry/src/phaseSegmenter.ts:207",
      "packages/vision-geometry/src/offlineStroke.ts:35",
      "packages/vision-geometry/src/offlineStroke.ts:221",
      "packages/vision-geometry/src/paddleTrackIdentity.ts:257-261",
      "packages/vision-geometry/src/providers.ts:68-78",
    ],
    scenarios: [
      "frame_stats_gate",
      "capture_quality_gate",
      "phase_segmenter",
      "offline_stroke_window",
      "recorded_provider_pipeline",
      "paddle_identity",
      "paddle_ownership",
    ],
    kinds: ["non_finite_output"],
    when: injectsNonFiniteOrOverflow,
  },
  {
    id: "KG-02",
    severity: "P2",
    title: "Frame/pose analyzability gates report analyzable=true on all-NaN/±Infinity statistics",
    files: [
      "packages/vision-geometry/src/frameAnalyzability.ts:137-215",
      "packages/vision-geometry/src/captureQuality.ts:63-133",
    ],
    scenarios: ["frame_stats_gate", "capture_quality_gate"],
    kinds: ["gate"],
    when: injectsNonFiniteOrOverflow,
  },
  {
    id: "KG-03",
    severity: "P2",
    title: "GeometricPhaseSegmenter returns ok() phases with NaN/±Infinity bounds",
    files: ["packages/vision-geometry/src/phaseSegmenter.ts:207"],
    scenarios: ["phase_segmenter"],
    kinds: ["phases"],
    when: injectsNonFiniteOrOverflow,
  },
  {
    id: "KG-04",
    severity: "P2",
    title: "detectOfflineStrokeWindow returns ok() with NaN/±Infinity bounds and confidence",
    files: ["packages/vision-geometry/src/offlineStroke.ts:35-137"],
    scenarios: ["offline_stroke_window"],
    kinds: ["offline_window"],
    when: injectsNonFiniteOrOverflow,
  },
  {
    id: "KG-05",
    severity: "P2",
    title: "RecordedTriggerStrokeDetector passes NaN stroke windows/confidence through as ok()",
    files: ["packages/vision-geometry/src/providers.ts:68-78"],
    scenarios: ["recorded_provider_pipeline"],
    kinds: ["strokes"],
    when: injectsNonFiniteOrOverflow,
  },
  {
    id: "KG-06",
    severity: "P3",
    title: "paddleOwnershipFromHandAffinity returns confidence NaN instead of null on NaN geometry",
    files: ["packages/vision-geometry/src/offlineStroke.ts:221-225"],
    scenarios: ["paddle_ownership"],
    kinds: ["ownership"],
    when: injectsNonFiniteOrOverflow,
  },
  {
    id: "KG-07",
    severity: "P3",
    title:
      "One NaN/±Infinity sample makes speedSynchrony NaN (silently disables the synchrony branch)",
    files: ["packages/vision-geometry/src/paddleTrackIdentity.ts:179-261"],
    scenarios: ["paddle_identity"],
    kinds: ["identity"],
    when: injectsNonFiniteOrOverflow,
  },
  {
    id: "KG-08",
    severity: "P3",
    title: "Math.max(...series) throws RangeError once a wrist track exceeds ~124k samples",
    files: [
      "packages/vision-geometry/src/paddleTrackIdentity.ts:280",
      "packages/vision-geometry/src/offlineStroke.ts:1375",
      "packages/vision-geometry/src/featureExtractor.ts:196",
    ],
    scenarios: ["oversized_series"],
    kinds: ["throw"],
    when: always,
  },
  {
    id: "KG-09",
    severity: "P2",
    title:
      "estimateContact fusion grid never terminates / exhausts the heap on a ±Infinity window bound or ball timestamp",
    files: ["packages/vision-geometry/src/offlineStroke.ts:1021-1037"],
    scenarios: ["contact_estimator"],
    // Never a violation: the harness refuses the call (outcome `hazard`) and the
    // defect is pinned by a memory-capped child in boundaryMalformed.knownGaps.test.ts.
    kinds: [],
    when: injectsNonFiniteOrOverflow,
  },
];

/**
 * Split a broken record's violations into explained (known gap ids) and
 * unexplained. Hard invariants (mutation, pollution, nondeterminism) are never
 * explained by a catalogue entry.
 */
export function explainViolations(
  scenario: string,
  mutations: readonly Mutation[],
  violations: readonly string[],
): { knownGaps: string[]; unexplained: string[] } {
  const knownGaps = new Set<string>();
  const unexplained: string[] = [];
  for (const violation of violations) {
    const kind = violation.split(":")[0]?.trim() ?? violation;
    const gap = KNOWN_GAPS.find(
      (entry) =>
        entry.scenarios.includes(scenario) &&
        entry.kinds.includes(kind) &&
        (kind !== "throw" || violation.includes("Maximum call stack size exceeded")) &&
        entry.when(mutations),
    );
    if (gap) knownGaps.add(gap.id);
    else unexplained.push(violation);
  }
  return { knownGaps: [...knownGaps].sort(), unexplained };
}
