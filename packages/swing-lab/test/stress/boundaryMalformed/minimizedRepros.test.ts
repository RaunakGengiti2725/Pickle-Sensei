/**
 * Minimized reproductions distilled from the seeded boundary/malformed
 * campaign (boundaryMalformed.stress.test.ts). Each case is the smallest
 * payload that reproduces one campaign row; the originating seed is noted so
 * the full row can be replayed with
 *   STRESS_SEED=<seed> pnpm --filter @pickle/swing-lab test -- boundaryMalformed
 *
 * The assertions state the contract the lens expects (a validator returns
 * problems and never throws; typed surfaces never emit NaN/±Infinity). They
 * fail on the current sources on purpose — they are the regression pins for
 * whoever fixes the underlying gaps.
 */
import { describe, expect, it } from "vitest";
import {
  buildPlayerTracks,
  checkArtifactInvariants,
  checkProvenanceChain,
  deriveReleaseStatus,
  validateCoachQualification,
  validateStrokeGoldFile,
} from "../../../src/index.js";
import { validateAnnotation } from "../../../src/annotationSchema.js";
import { COACH_QUALIFICATION_POLICY_VERSION } from "../../../src/coachProvisioning.js";
import type { ReleaseEvidenceEvent } from "../../../src/goldAdmission.js";
import { validateInvestigationCase } from "../../../src/modelCoachDisagreement.js";
import type { PeopleFile } from "../../../src/playerTracker.js";
import { STROKE_GOLD_TAXONOMY_VERSION } from "../../../src/strokeTaxonomyBench.js";

/** `[ <hole>, {} ]` — what `JSON.parse` never produces but a sparse in-memory array does. */
function holeThen(value: unknown): unknown[] {
  const list: unknown[] = [];
  list[1] = value;
  return list;
}

function nested(depth: number): unknown {
  let value: unknown = 1;
  for (let index = 0; index < depth; index += 1) value = [value];
  return value;
}

/**
 * `JSON.parse` accepts this depth (checked to 100 000), so a corpus file can
 * carry it. The walkers overflow from ~1 800 (arrays) / ~3 600 (objects) on a
 * fresh Node 22 stack; the exact threshold moves with the caller's stack
 * depth, so the pin sits far above it to stay deterministic.
 */
const JSON_REACHABLE_DEPTH = 16384;

describe("validators return problems instead of throwing (validator contract: raw: unknown → string[])", () => {
  it("validateAnnotation: faults that is not an array (seed 955342939)", () => {
    expect(() => validateAnnotation({ faults: 4.4 })).not.toThrow();
  });

  it("validateAnnotation: null / hole inside faults[] (seed 701298646)", () => {
    expect(() => validateAnnotation({ faults: [null] })).not.toThrow();
    expect(() => validateAnnotation({ faults: holeThen({}) })).not.toThrow();
  });

  it("validateCoachQualification: null inside certifications[] (seed 2102476936)", () => {
    expect(() =>
      validateCoachQualification({
        policyVersion: COACH_QUALIFICATION_POLICY_VERSION,
        certifications: [null],
      }),
    ).not.toThrow();
  });

  it("validateCoachQualification: professionalCoachingHistory.statement not a string (seed 2759293766)", () => {
    expect(() =>
      validateCoachQualification({
        policyVersion: COACH_QUALIFICATION_POLICY_VERSION,
        certifications: [],
        professionalCoachingHistory: { statement: 7, verification: null },
      }),
    ).not.toThrow();
  });

  it("validateInvestigationCase: null / hole inside hypotheses[] (seeds 876792298, 3690505476)", () => {
    expect(() => validateInvestigationCase({ hypotheses: [null] })).not.toThrow();
    expect(() => validateInvestigationCase({ hypotheses: holeThen({}) })).not.toThrow();
  });

  it("validateInvestigationCase: null inside adjudicationEntries[] (seed 989041225)", () => {
    expect(() =>
      validateInvestigationCase({ hypotheses: [], adjudicationEntries: [null] }),
    ).not.toThrow();
  });

  it("validateStrokeGoldFile: null / hole inside labels[] (seeds 391391624, 3603714348)", () => {
    expect(() => validateStrokeGoldFile({ labels: [null] })).not.toThrow();
    expect(() => validateStrokeGoldFile({ labels: holeThen({}) })).not.toThrow();
  });
});

describe("recursive walkers survive JSON-reachable nesting depth", () => {
  it("checkArtifactInvariants (seed 1381496565; minimal depth 1812 arrays / 3584 objects)", () => {
    expect(() => checkArtifactInvariants(nested(JSON_REACHABLE_DEPTH))).not.toThrow();
  });

  it("checkProvenanceChain (seed 2244176071; minimal depth 1856 arrays / 3584 objects)", () => {
    expect(() => checkProvenanceChain(nested(JSON_REACHABLE_DEPTH))).not.toThrow();
  });

  it("validateCoachQualification stringifying a nested satisfiedCriteria element (seed 1656044262; minimal depth 3240)", () => {
    expect(() =>
      validateCoachQualification({
        policyVersion: COACH_QUALIFICATION_POLICY_VERSION,
        satisfiedCriteria: nested(JSON_REACHABLE_DEPTH),
        certifications: [],
      }),
    ).not.toThrow();
  });
});

describe("validators reject unambiguously wrong field types", () => {
  it("validateStrokeGoldFile: contactMs NaN and object caseId (seeds 1159398518, 417031706)", () => {
    const file = {
      schemaVersion: 1,
      taxonomyVersion: STROKE_GOLD_TAXONOMY_VERSION,
      labels: [
        {
          caseId: { not: "a string" },
          eventStartMs: 1000,
          contactMs: Number.NaN,
          eventEndMs: 1900,
          owner: "target",
          l1: "unknown",
          l2: "unknown",
          l3: "unknown",
          reasoning: "minimized repro",
          annotatorId: "a",
          createdAtIso: "not a timestamp",
        },
      ],
    };
    const problems = validateStrokeGoldFile(file);
    expect(problems.some((p) => p.includes("caseId"))).toBe(true);
    expect(problems.some((p) => p.includes("contactMs"))).toBe(true);
    expect(problems.some((p) => p.includes("createdAtIso"))).toBe(true);
  });

  it("validateAnnotation: captureBundle boolean and createdAtIso array (seeds 2197129395, 1074954140)", () => {
    const problems = validateAnnotation({
      schemaVersion: 1,
      captureBundle: true,
      annotatorId: "a",
      createdAtIso: [null, null],
      revision: 1,
      stroke: "unsure",
      analyzable: false,
      notAnalyzableReason: "occluded",
      phases: null,
      faults: [],
      checkpointScores: {},
      overallScore: null,
      annotatorConfidence: 0.5,
      notes: "",
      history: [],
    });
    expect(problems.some((p) => p.includes("captureBundle"))).toBe(true);
    expect(problems.some((p) => p.includes("createdAtIso"))).toBe(true);
  });
});

describe("typed surfaces never emit NaN / ±Infinity (JSON `1e999` parses to Infinity)", () => {
  it("deriveReleaseStatus echoes seq=Infinity into activePromotion (seed 2654909021)", () => {
    const ledger = JSON.parse(
      `[{"evidenceRef":"stress-evidence-0","kind":"positive","seq":1e999,"detail":"minimized"}]`,
    ) as ReleaseEvidenceEvent[];
    const status = deriveReleaseStatus(ledger);
    expect(Number.isFinite(status.activePromotion?.seq ?? 0)).toBe(true);
  });

  it("buildPlayerTracks propagates landmark confidence 1e21 / -2^53 and v=Infinity (seeds 3681555249, 2058256365, 3356926457)", () => {
    const landmarks = ["left_shoulder", "right_shoulder", "left_hip", "right_hip", "right_wrist"]
      .map(
        (n, j) =>
          `{"n":"${n}","x":${0.3 + (j % 2) * 0.1},"y":${0.4 + Math.floor(j / 2) * 0.1},"v":1e999}`,
      )
      .join(",");
    // buildPlayerTracks keeps tracks of >= 8 frames only.
    const frames = Array.from({ length: 8 }, (_, index) => {
      const c = index % 2 === 0 ? "1e21" : "-9007199254740992";
      return `{"t":${index * 33},"p":[{"c":${c},"l":[${landmarks}]}]}`;
    }).join(",");
    const file = JSON.parse(
      `{"schemaVersion":1,"poseModelVersion":"minimized","video":{"w":1080,"h":1920,"fps":30},"frames":[${frames}]}`,
    ) as PeopleFile;
    const tracks = buildPlayerTracks(file);
    expect(tracks.length).toBeGreaterThan(0);
    const flat = JSON.stringify(tracks, (_key, value: unknown) =>
      typeof value === "number" && !Number.isFinite(value)
        ? `<non-finite ${String(value)}>`
        : value,
    );
    expect(flat).not.toContain("<non-finite");
    for (const track of tracks) {
      for (const frame of track.frames) {
        expect(frame.confidence).toBeGreaterThanOrEqual(0);
        expect(frame.confidence).toBeLessThanOrEqual(1);
      }
    }
  });
});
