import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  deriveReleaseStatus,
  evaluateGoldAdmission,
  LABEL_SOURCES,
  type GoldCandidate,
  type PseudoLabelControls,
  type ReleaseEvidenceEvent,
} from "../src/goldAdmission.js";
import { collectCoachEvidence, runCoachGates } from "../src/coachGates.js";
import { validateCoachReview } from "../src/coachReview.js";

const REPO_ROOT = resolve(__dirname, "../../..");

/**
 * i35-no-self-confirmation red-team suite.
 *
 * Property + integration tests proving the continuous-learning loop cannot
 * self-confirm: model predictions never enter gold datasets without a
 * human/coach review step, pseudo-label paths are gated by explicit
 * scientific controls, and RELEASE_GREEN is always demotable by new
 * negative evidence.
 */

/** Deterministic PRNG (mulberry32) — property tests must be reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)]!;
}

const HUMAN_IDS = ["coach-2026-004", "annotator-a1", "rg-lead", "c-042"] as const;
const MACHINE_IDS = [
  "stroke-heuristic-v5",
  "SYNTHETIC-COACH-1",
  "demo-coach",
  "auto-resolver",
  "pseudo-labeler-2",
  "classifier-9",
  "pipeline-worker",
] as const;

function validControls(rng: () => number): PseudoLabelControls {
  return {
    protocolRef: "datasets/experiments/wave-i/i35-pseudo-protocol.md",
    humanSpotCheckRef: `datasets/experiments/wave-i/spotcheck-${Math.floor(rng() * 1000)}.json`,
    humanSpotCheckFraction: 0.05 + rng() * 0.9,
    holdoutDisjointnessRef: "datasets/experiments/wave-i/i35-holdout-attestation.json",
    producingModelVersion: "stroke-heuristic-v5-frozen",
  };
}

function randomCandidate(rng: () => number, index: number): GoldCandidate {
  const source = pick(rng, LABEL_SOURCES);
  const machineSource = source === "model_prediction" || source === "pseudo_label";
  const humanId =
    rng() < 0.5
      ? null
      : machineSource || rng() < 0.3
        ? pick(rng, MACHINE_IDS)
        : pick(rng, HUMAN_IDS);
  return {
    candidateId: `cand-${index}`,
    source,
    requestedTier: rng() < 0.5 ? "GOLD" : "TRAINING_POOL",
    humanId,
    humanArtifactRef: rng() < 0.6 ? `datasets/coach-review/reviews/r-${index}.json` : null,
    producingModelVersion: rng() < 0.4 ? "stroke-heuristic-v5-frozen" : null,
    pseudoLabelControls:
      source === "pseudo_label" && rng() < 0.5
        ? rng() < 0.7
          ? validControls(rng)
          : { ...validControls(rng), humanSpotCheckFraction: 0 }
        : null,
  };
}

describe("gold admission — predictions can never become gold (property)", () => {
  const rng = mulberry32(0x1350001);

  it("no candidate is ever admitted to GOLD without a human source, human id, and human artifact", () => {
    for (let i = 0; i < 5000; i++) {
      const candidate = randomCandidate(rng, i);
      const verdict = evaluateGoldAdmission(candidate);
      if (verdict.admittedTier === "GOLD") {
        expect(candidate.source === "human_annotator" || candidate.source === "coach_review").toBe(
          true,
        );
        expect(candidate.humanId).toBeTruthy();
        expect(candidate.humanArtifactRef).toBeTruthy();
        expect(candidate.producingModelVersion).toBeNull();
      }
      if (verdict.admitted) {
        expect(verdict.admittedTier).not.toBeNull();
        expect(verdict.reasons).toHaveLength(0);
      } else {
        expect(verdict.admittedTier).toBeNull();
        expect(verdict.reasons.length).toBeGreaterThan(0);
      }
    }
  });

  it("model_prediction is rejected for every tier, unconditionally", () => {
    const inner = mulberry32(0x1350002);
    for (let i = 0; i < 1000; i++) {
      const candidate: GoldCandidate = {
        ...randomCandidate(inner, i),
        source: "model_prediction",
      };
      const verdict = evaluateGoldAdmission(candidate);
      expect(verdict.admitted).toBe(false);
      expect(verdict.admittedTier).toBeNull();
    }
  });

  it("a prediction relabeled with a machine identity cannot launder into a human source", () => {
    for (const humanId of MACHINE_IDS) {
      for (const source of ["human_annotator", "coach_review"] as const) {
        const verdict = evaluateGoldAdmission({
          candidateId: `launder-${humanId}`,
          source,
          requestedTier: "GOLD",
          humanId,
          humanArtifactRef: "datasets/coach-review/reviews/fake.json",
          producingModelVersion: null,
          pseudoLabelControls: null,
        });
        expect(verdict.admitted).toBe(false);
        expect(verdict.reasons.join(" ")).toMatch(/machine|synthetic/i);
      }
    }
  });

  it("a human-source candidate that still carries producingModelVersion is rejected", () => {
    const verdict = evaluateGoldAdmission({
      candidateId: "hybrid-1",
      source: "coach_review",
      requestedTier: "GOLD",
      humanId: "coach-2026-004",
      humanArtifactRef: "datasets/coach-review/reviews/x.json",
      producingModelVersion: "stroke-heuristic-v5-frozen",
      pseudoLabelControls: null,
    });
    expect(verdict.admitted).toBe(false);
  });

  it("a fully-human candidate is admitted to the tier it requested — the guard is not a blanket reject", () => {
    for (const tier of ["GOLD", "TRAINING_POOL"] as const) {
      const verdict = evaluateGoldAdmission({
        candidateId: `human-${tier}`,
        source: "human_annotator",
        requestedTier: tier,
        humanId: "annotator-a1",
        humanArtifactRef: "packages/swing-lab/annotations/a1.json",
        producingModelVersion: null,
        pseudoLabelControls: null,
      });
      expect(verdict.admitted).toBe(true);
      expect(verdict.admittedTier).toBe(tier);
    }
  });
});

describe("pseudo-label path — gated by explicit scientific controls (property)", () => {
  it("pseudo-labels are NEVER admitted to GOLD, even with complete controls", () => {
    const rng = mulberry32(0x1350003);
    for (let i = 0; i < 1000; i++) {
      const verdict = evaluateGoldAdmission({
        candidateId: `pl-gold-${i}`,
        source: "pseudo_label",
        requestedTier: "GOLD",
        humanId: null,
        humanArtifactRef: null,
        producingModelVersion: "stroke-heuristic-v5-frozen",
        pseudoLabelControls: validControls(rng),
      });
      expect(verdict.admitted).toBe(false);
      expect(verdict.reasons.join(" ")).toMatch(/never GOLD/);
    }
  });

  it("dropping any single control field makes the batch inadmissible", () => {
    const rng = mulberry32(0x1350004);
    const base = validControls(rng);
    const broken: PseudoLabelControls[] = [
      { ...base, protocolRef: "" },
      { ...base, humanSpotCheckRef: " " },
      { ...base, humanSpotCheckFraction: 0 },
      { ...base, humanSpotCheckFraction: 1.5 },
      { ...base, humanSpotCheckFraction: Number.NaN },
      { ...base, holdoutDisjointnessRef: "" },
      { ...base, producingModelVersion: "" },
    ];
    for (const controls of broken) {
      const verdict = evaluateGoldAdmission({
        candidateId: "pl-broken",
        source: "pseudo_label",
        requestedTier: "TRAINING_POOL",
        humanId: null,
        humanArtifactRef: null,
        producingModelVersion: controls.producingModelVersion || null,
        pseudoLabelControls: controls,
      });
      expect(verdict.admitted).toBe(false);
    }
    const missing = evaluateGoldAdmission({
      candidateId: "pl-missing",
      source: "pseudo_label",
      requestedTier: "TRAINING_POOL",
      humanId: null,
      humanArtifactRef: null,
      producingModelVersion: "stroke-heuristic-v5-frozen",
      pseudoLabelControls: null,
    });
    expect(missing.admitted).toBe(false);
  });

  it("a complete control record admits the batch to TRAINING_POOL only", () => {
    const rng = mulberry32(0x1350005);
    const verdict = evaluateGoldAdmission({
      candidateId: "pl-ok",
      source: "pseudo_label",
      requestedTier: "TRAINING_POOL",
      humanId: null,
      humanArtifactRef: null,
      producingModelVersion: "stroke-heuristic-v5-frozen",
      pseudoLabelControls: validControls(rng),
    });
    expect(verdict.admitted).toBe(true);
    expect(verdict.admittedTier).toBe("TRAINING_POOL");
  });
});

describe("release-status ledger — RELEASE_GREEN is always demotable (property)", () => {
  function event(seq: number, kind: "positive" | "negative", ref?: string): ReleaseEvidenceEvent {
    return {
      evidenceRef: ref ?? `${kind}-ev-${seq}`,
      kind,
      seq,
      detail: `${kind} evidence #${seq}`,
    };
  }

  it("empty ledger is NOT_EVALUABLE — status without evidence does not exist", () => {
    expect(deriveReleaseStatus([]).status).toBe("NOT_EVALUABLE");
  });

  it("GREEN holds only when a promotion exists with no negative evidence after it (property)", () => {
    const rng = mulberry32(0x1350006);
    for (let trial = 0; trial < 2000; trial++) {
      const length = 1 + Math.floor(rng() * 12);
      const ledger: ReleaseEvidenceEvent[] = [];
      for (let seq = 1; seq <= length; seq++) {
        // Occasionally replay an already-used positive ref to attack one-shot.
        const replay = rng() < 0.15 && ledger.some((e) => e.kind === "positive");
        const kind = rng() < 0.5 ? "positive" : "negative";
        const ref = replay
          ? ledger.filter((e) => e.kind === "positive")[0]!.evidenceRef
          : undefined;
        ledger.push(event(seq, replay ? "positive" : kind, ref));
      }
      const derivation = deriveReleaseStatus(ledger);
      const firstUseBySeq = new Map<string, number>();
      for (const e of ledger) {
        if (e.kind === "positive" && !firstUseBySeq.has(e.evidenceRef)) {
          firstUseBySeq.set(e.evidenceRef, e.seq);
        }
      }
      const effectivePromotions = ledger.filter(
        (e) => e.kind === "positive" && firstUseBySeq.get(e.evidenceRef) === e.seq,
      );
      const lastPromotion = effectivePromotions.at(-1) ?? null;
      const negativesAfter = lastPromotion
        ? ledger.filter((e) => e.kind === "negative" && e.seq >= lastPromotion.seq)
        : [];
      const expectGreen = lastPromotion !== null && negativesAfter.length === 0;
      expect(derivation.status).toBe(expectGreen ? "RELEASE_GREEN" : "RELEASE_BLOCKED");
    }
  });

  it("appending new negative evidence to ANY ledger never yields GREEN (demotion property)", () => {
    const rng = mulberry32(0x1350007);
    for (let trial = 0; trial < 1000; trial++) {
      const length = Math.floor(rng() * 10);
      const ledger: ReleaseEvidenceEvent[] = [];
      for (let seq = 1; seq <= length; seq++) {
        ledger.push(event(seq, rng() < 0.6 ? "positive" : "negative"));
      }
      const demoted = deriveReleaseStatus([...ledger, event(length + 1, "negative")]);
      expect(demoted.status).not.toBe("RELEASE_GREEN");
      if (deriveReleaseStatus(ledger).status === "RELEASE_GREEN") {
        expect(demoted.status).toBe("RELEASE_BLOCKED");
        expect(demoted.demotingEvidence.map((e) => e.seq)).toContain(length + 1);
      }
    }
  });

  it("a consumed positive evidenceRef can never re-promote after demotion (one-shot)", () => {
    const ledger = [
      event(1, "positive", "gate-report-A"),
      event(2, "negative", "redteam-finding-1"),
      event(3, "positive", "gate-report-A"),
    ];
    const derivation = deriveReleaseStatus(ledger);
    expect(derivation.status).toBe("RELEASE_BLOCKED");
    expect(derivation.replayedPositiveRefs).toContain("gate-report-A");
  });

  it("re-promotion requires NEW positive evidence after the demoting negative", () => {
    const derivation = deriveReleaseStatus([
      event(1, "positive", "gate-report-A"),
      event(2, "negative", "redteam-finding-1"),
      event(3, "positive", "gate-report-B"),
    ]);
    expect(derivation.status).toBe("RELEASE_GREEN");
    expect(derivation.activePromotion?.evidenceRef).toBe("gate-report-B");
  });

  it("negative evidence alone (no promotion ever) blocks, not greens", () => {
    expect(deriveReleaseStatus([event(1, "negative")]).status).toBe("RELEASE_BLOCKED");
  });

  it("rejects a ledger with non-strictly-increasing seq — no reordering attacks", () => {
    expect(() => deriveReleaseStatus([event(1, "positive"), event(1, "negative")])).toThrowError(
      /strictly increasing/,
    );
  });
});

describe("integration — the repo's actual gold/coach-review surfaces cannot self-confirm", () => {
  it("every on-disk coach review counted as evidence passes human validation and belongs to a provisioned coach", () => {
    const evidence = collectCoachEvidence(REPO_ROOT);
    // Structural invariants that must hold no matter how many reviews exist:
    expect(evidence.syntheticRegistryIds).toHaveLength(0);
    for (const review of evidence.countedReviews) {
      expect(validateCoachReview(review)).toHaveLength(0);
      expect(/synthetic|demo/i.test(review.coachId)).toBe(false);
      expect(evidence.activeCoaches.some((coach) => coach.coachId === review.coachId)).toBe(true);
    }
  });

  it("the NOT-GOLD synthetic example reviews are rejected by validation and live outside the reviews dir", () => {
    const examplePath = join(
      REPO_ROOT,
      "datasets/coach-review/examples/EXAMPLE-synthetic-reviews.NOT-GOLD.json",
    );
    const parsed = JSON.parse(readFileSync(examplePath, "utf8")) as { reviews?: unknown[] };
    const reviews = Array.isArray(parsed.reviews) ? parsed.reviews : [parsed];
    expect(reviews.length).toBeGreaterThan(0);
    for (const review of reviews) {
      expect(validateCoachReview(review).length).toBeGreaterThan(0);
    }
    const reviewsDir = join(REPO_ROOT, "datasets/coach-review/reviews");
    if (existsSync(reviewsDir)) {
      for (const file of readdirSync(reviewsDir)) {
        expect(/NOT-GOLD|EXAMPLE|synthetic/i.test(file)).toBe(false);
      }
    }
  });

  it("with zero counted coach reviews the coach gates stay RELEASE_BLOCKED (honest RED preserved)", () => {
    const evidence = collectCoachEvidence(REPO_ROOT);
    if (evidence.countedReviews.length === 0) {
      expect(runCoachGates(REPO_ROOT).overallVerdict).toBe("RELEASE_BLOCKED");
    } else {
      // Real coach evidence exists — this test must not fabricate a verdict
      // about it; the frozen coach-gates suite owns that evaluation.
      expect(runCoachGates(REPO_ROOT).overallVerdict).toMatch(/RELEASABLE|RELEASE_BLOCKED/);
    }
  });

  it("a machine stroke prediction candidate (auto-resolution output) is inadmissible as gold", () => {
    // Shaped like strokeAutoResolution's HierarchicalStrokePrediction output.
    const verdict = evaluateGoldAdmission({
      candidateId: "auto-resolution-FOREHAND",
      source: "model_prediction",
      requestedTier: "GOLD",
      humanId: null,
      humanArtifactRef: null,
      producingModelVersion: "stroke-heuristic-v5-frozen",
      pseudoLabelControls: null,
    });
    expect(verdict.admitted).toBe(false);
  });
});
