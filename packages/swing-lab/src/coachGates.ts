import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  SHARED_SIDE_PROFILES_V1,
  TECHNIQUE_ANALYSIS_PROFILES_V1,
  type SharedSideProfile,
  type TechniqueAnalysisProfile,
} from "@pickle/shared-types";
import { REPO_ROOT } from "./engine/corpus.js";
import { DRILL_LIBRARY_V0, validateCoachReview, type CoachReview } from "./coachReview.js";

/**
 * COACH GATES — machine checker over the FROZEN release-criteria spec
 * `datasets/coach-review/gates/coach-gates.v1.json` (coach-gates-frozen-v1).
 *
 * The spec was frozen BEFORE any coach data existed; this checker pins its
 * SHA-256 and refuses a tampered file, so no threshold can be silently
 * weakened to make future data pass. Verdict semantics: every gate is PASS,
 * FAIL, or NOT_EVALUABLE, and NOT_EVALUABLE blocks release exactly like
 * FAIL. Nothing here fabricates evidence — with zero coach reviews the
 * honest output is RELEASE_BLOCKED across all three surfaces.
 */

export const COACH_GATES_SPEC_ID = "coach-gates-frozen-v1" as const;
export const COACH_GATES_SPEC_PATH = "datasets/coach-review/gates/coach-gates.v1.json" as const;
export const COACH_GATES_V1_SHA256 =
  "087bfe467e6fb56c2246c21f94a7a46a1ef81031ba6f0b7de6f0828093a63759" as const;

export const HELD_OUT_CASE_IDS = ["wm-dink-01", "afn-vic-rally1"] as const;

export type GateVerdict = "PASS" | "FAIL" | "NOT_EVALUABLE";

export interface GateResult {
  id: string;
  kind: string;
  title: string;
  verdict: GateVerdict;
  /** Honest evidence statement — what was measured or what is missing. */
  detail: string;
}

export interface CoachGatesReport {
  specId: typeof COACH_GATES_SPEC_ID;
  specSha256: string;
  generatedAtIso: string;
  gates: GateResult[];
  surfaces: Record<string, { gateIds: string[]; verdict: "RELEASABLE" | "RELEASE_BLOCKED" }>;
  overallVerdict: "RELEASABLE" | "RELEASE_BLOCKED";
  evidenceCounts: {
    activeCoaches: number;
    reviewFiles: number;
    countedReviews: number;
    heldOutReviewsExcluded: number;
    invalidReviewFiles: number;
  };
}

interface GateSpecEntry {
  id: string;
  kind: string;
  title: string;
  predicate: string;
  evaluableNow: boolean;
  thresholds?: Record<string, number>;
  requires?: string;
}

interface CoachGatesSpec {
  specId: string;
  heldOutCases: string[];
  surfaces: Record<string, string[]>;
  gates: GateSpecEntry[];
}

export function loadCoachGatesSpec(repoRoot: string = REPO_ROOT): {
  spec: CoachGatesSpec;
  sha256: string;
} {
  const raw = readFileSync(join(repoRoot, COACH_GATES_SPEC_PATH), "utf8");
  const sha256 = createHash("sha256").update(raw).digest("hex");
  if (sha256 !== COACH_GATES_V1_SHA256) {
    throw new Error(
      `coach-gates spec hash mismatch: expected ${COACH_GATES_V1_SHA256}, got ${sha256}. ` +
        "The frozen spec must never be edited in place — write a new versioned spec file " +
        "and update the checker pin in the same reviewed change.",
    );
  }
  const spec = JSON.parse(raw) as CoachGatesSpec;
  if (spec.specId !== COACH_GATES_SPEC_ID) {
    throw new Error(`coach-gates specId mismatch: ${spec.specId}`);
  }
  return { spec, sha256 };
}

interface CoachRegistryEntry {
  coachId: string;
  credentialRef: string;
  status: string;
}

export interface CoachEvidence {
  activeCoaches: CoachRegistryEntry[];
  syntheticRegistryIds: string[];
  /** Valid reviews by provisioned active coaches on NON-held-out items. */
  countedReviews: CoachReview[];
  heldOutReviewsExcluded: number;
  invalidReviewFiles: string[];
  unprovisionedReviewFiles: string[];
  reviewFileCount: number;
}

function isHeldOutQueueItem(queueItemId: string): boolean {
  return HELD_OUT_CASE_IDS.some((caseId) => queueItemId.startsWith(`${caseId}-E`));
}

/** Collect the only evidence that counts: valid, provisioned, non-held-out reviews. */
export function collectCoachEvidence(repoRoot: string = REPO_ROOT): CoachEvidence {
  const registryPath = join(repoRoot, "datasets/coach-review/coaches.json");
  const registry = JSON.parse(readFileSync(registryPath, "utf8")) as {
    coaches: CoachRegistryEntry[];
  };
  const syntheticRegistryIds = registry.coaches
    .filter((coach) => /synthetic|demo/i.test(coach.coachId))
    .map((coach) => coach.coachId);
  const activeCoaches = registry.coaches.filter(
    (coach) => coach.status === "active" && !/synthetic|demo/i.test(coach.coachId),
  );
  const activeIds = new Set(activeCoaches.map((coach) => coach.coachId));

  const reviewsDir = join(repoRoot, "datasets/coach-review/reviews");
  const reviewFiles = existsSync(reviewsDir)
    ? readdirSync(reviewsDir).filter((name) => name.endsWith(".json"))
    : [];

  const countedReviews: CoachReview[] = [];
  const invalidReviewFiles: string[] = [];
  const unprovisionedReviewFiles: string[] = [];
  let heldOutReviewsExcluded = 0;
  for (const file of reviewFiles) {
    const raw = JSON.parse(readFileSync(join(reviewsDir, file), "utf8")) as unknown;
    const problems = validateCoachReview(raw);
    if (problems.length > 0) {
      invalidReviewFiles.push(file);
      continue;
    }
    const review = raw as CoachReview;
    if (!activeIds.has(review.coachId)) {
      unprovisionedReviewFiles.push(file);
      continue;
    }
    if (isHeldOutQueueItem(review.queueItemId)) {
      heldOutReviewsExcluded += 1;
      continue;
    }
    countedReviews.push(review);
  }

  return {
    activeCoaches,
    syntheticRegistryIds,
    countedReviews,
    heldOutReviewsExcluded,
    invalidReviewFiles,
    unprovisionedReviewFiles,
    reviewFileCount: reviewFiles.length,
  };
}

function checkLockedProfile(profile: TechniqueAnalysisProfile | SharedSideProfile): string[] {
  const problems: string[] = [];
  if ((profile.techniqueEvaluator as string) !== "BLOCKED_ON_VALIDATION") {
    problems.push(`techniqueEvaluator=${String(profile.techniqueEvaluator)}`);
  }
  if ((profile.faultTaxonomyVersion as string) !== "pending-expert-program") {
    problems.push(`faultTaxonomyVersion=${String(profile.faultTaxonomyVersion)}`);
  }
  if ((profile.drillMappingVersion as string) !== "none") {
    problems.push(`drillMappingVersion=${String(profile.drillMappingVersion)}`);
  }
  if ((profile.abstentionPolicy as string) !== "abstain-over-invent") {
    problems.push(`abstentionPolicy=${String(profile.abstentionPolicy)}`);
  }
  return problems;
}

function evaluateL1(): GateResult["verdict"] {
  const leafProblems = Object.values(TECHNIQUE_ANALYSIS_PROFILES_V1).flatMap(checkLockedProfile);
  const sharedProblems = Object.values(SHARED_SIDE_PROFILES_V1).flatMap(checkLockedProfile);
  return leafProblems.length === 0 && sharedProblems.length === 0 ? "PASS" : "FAIL";
}

/** Number of distinct non-held-out events with >=2 evaluable quality ratings. */
export function eventsWithAgreeingQuality(reviews: CoachReview[]): Map<string, number[]> {
  const byItem = new Map<string, number[]>();
  for (const review of reviews) {
    if (review.cannotEvaluate || review.overallQuality === null) continue;
    byItem.set(review.queueItemId, [
      ...(byItem.get(review.queueItemId) ?? []),
      review.overallQuality.value,
    ]);
  }
  return new Map([...byItem].filter(([, values]) => values.length >= 2));
}

/** Spearman rank correlation (average-rank ties). Exported for gate S1 evaluation. */
export function spearman(xs: number[], ys: number[]): number | null {
  if (xs.length !== ys.length || xs.length < 3) return null;
  const rank = (values: number[]): number[] => {
    const sorted = values.map((value, index) => ({ value, index }));
    sorted.sort((a, b) => a.value - b.value);
    const ranks = new Array<number>(values.length);
    let i = 0;
    while (i < sorted.length) {
      let j = i;
      while (j + 1 < sorted.length && sorted[j + 1]!.value === sorted[i]!.value) j += 1;
      const shared = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) ranks[sorted[k]!.index] = shared;
      i = j + 1;
    }
    return ranks;
  };
  const rx = rank(xs);
  const ry = rank(ys);
  const mean = (values: number[]): number =>
    values.reduce((sum, value) => sum + value, 0) / values.length;
  const mx = mean(rx);
  const my = mean(ry);
  let numerator = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < rx.length; i++) {
    numerator += (rx[i]! - mx) * (ry[i]! - my);
    dx += (rx[i]! - mx) ** 2;
    dy += (ry[i]! - my) ** 2;
  }
  if (dx === 0 || dy === 0) return null;
  return numerator / Math.sqrt(dx * dy);
}

/** Pairwise ranking agreement over pairs whose coach quality differs >= minGap. */
export function pairwiseRankingAgreement(
  scores: number[],
  qualities: number[],
  minGap: number,
): { agreement: number; pairs: number } | null {
  if (scores.length !== qualities.length) return null;
  let pairs = 0;
  let agree = 0;
  for (let i = 0; i < scores.length; i++) {
    for (let j = i + 1; j < scores.length; j++) {
      const gap = qualities[i]! - qualities[j]!;
      if (Math.abs(gap) < minGap) continue;
      pairs += 1;
      const scoreGap = scores[i]! - scores[j]!;
      if (Math.sign(scoreGap) === Math.sign(gap)) agree += 1;
    }
  }
  if (pairs === 0) return null;
  return { agreement: agree / pairs, pairs };
}

export function runCoachGates(repoRoot: string = REPO_ROOT): CoachGatesReport {
  const { spec, sha256 } = loadCoachGatesSpec(repoRoot);
  const evidence = collectCoachEvidence(repoRoot);
  const gates: GateResult[] = [];

  for (const gate of spec.gates) {
    let verdict: GateVerdict;
    let detail: string;

    if (gate.id === "L1") {
      verdict = evaluateL1();
      detail =
        verdict === "PASS"
          ? "all TechniqueAnalysisProfiles + SharedSideProfiles carry BLOCKED_ON_VALIDATION / pending-expert-program / none / abstain-over-invent"
          : "a production profile has been unlocked without coach validation";
    } else if (gate.id === "L2") {
      const clean =
        evidence.syntheticRegistryIds.length === 0 &&
        evidence.unprovisionedReviewFiles.length === 0;
      verdict = clean ? "PASS" : "FAIL";
      detail = clean
        ? `registry synthetic-free (${evidence.activeCoaches.length} active coaches); ${evidence.reviewFileCount} review files, ${evidence.invalidReviewFiles.length} invalid, ${evidence.unprovisionedReviewFiles.length} unprovisioned`
        : `synthetic ids: [${evidence.syntheticRegistryIds.join(", ")}]; unprovisioned review files: [${evidence.unprovisionedReviewFiles.join(", ")}]`;
    } else if (gate.id === "L4") {
      const offenders = DRILL_LIBRARY_V0.drills.filter(
        (drill) =>
          drill.validationStatus !== "UNVALIDATED" || drill.validatedFaultMappings.length > 0,
      );
      verdict = offenders.length === 0 ? "PASS" : "FAIL";
      detail =
        offenders.length === 0
          ? `all ${DRILL_LIBRARY_V0.drills.length} drill entries UNVALIDATED with empty validatedFaultMappings`
          : `validated-looking drills without coach evidence: [${offenders.map((drill) => drill.id).join(", ")}]`;
    } else if (gate.id === "S1") {
      const events = eventsWithAgreeingQuality(evidence.countedReviews);
      const minEvents = gate.thresholds?.minEvents ?? 30;
      if (events.size < minEvents) {
        verdict = "NOT_EVALUABLE";
        detail = `${events.size}/${minEvents} coach-rated non-held-out events (>=2 evaluable quality ratings each); real coach reviews are the only unlock`;
      } else {
        // Evidence threshold met — correlation itself needs the matching shipped
        // scores replayed per event, which requires the Mac pipeline run dirs.
        verdict = "NOT_EVALUABLE";
        detail = `coach evidence present (${events.size} events) but shipped-score replay per event not wired on this box — Mac pipeline run required`;
      }
    } else if (gate.evaluableNow === false) {
      const events = eventsWithAgreeingQuality(evidence.countedReviews);
      verdict = "NOT_EVALUABLE";
      detail = `requires: ${gate.requires ?? "real external evidence"} (today: ${evidence.countedReviews.length} counted reviews, ${events.size} events with >=2 quality ratings)`;
    } else {
      verdict = "FAIL";
      detail = `gate ${gate.id} marked evaluableNow but the checker has no evaluator for it — refusing to pass silently`;
    }

    gates.push({ id: gate.id, kind: gate.kind, title: gate.title, verdict, detail });
  }

  const byId = new Map(gates.map((gate) => [gate.id, gate]));
  const surfaces: CoachGatesReport["surfaces"] = {};
  for (const [surface, gateIds] of Object.entries(spec.surfaces)) {
    const allPass = gateIds.every((id) => byId.get(id)?.verdict === "PASS");
    surfaces[surface] = { gateIds, verdict: allPass ? "RELEASABLE" : "RELEASE_BLOCKED" };
  }
  const overallVerdict = Object.values(surfaces).every((s) => s.verdict === "RELEASABLE")
    ? "RELEASABLE"
    : "RELEASE_BLOCKED";

  return {
    specId: COACH_GATES_SPEC_ID,
    specSha256: sha256,
    generatedAtIso: new Date().toISOString(),
    gates,
    surfaces,
    overallVerdict,
    evidenceCounts: {
      activeCoaches: evidence.activeCoaches.length,
      reviewFiles: evidence.reviewFileCount,
      countedReviews: evidence.countedReviews.length,
      heldOutReviewsExcluded: evidence.heldOutReviewsExcluded,
      invalidReviewFiles: evidence.invalidReviewFiles.length,
    },
  };
}

/* ------------------------------------------------------------------------ *
 * CLI — pnpm lab:coach-gates [--out <path>]
 * ------------------------------------------------------------------------ */

const isMain = process.argv[1]?.endsWith("coachGates.ts");
if (isMain) {
  const report = runCoachGates();
  const outFlag = process.argv.indexOf("--out");
  const outPath =
    outFlag !== -1 && process.argv[outFlag + 1]
      ? process.argv[outFlag + 1]!
      : join(REPO_ROOT, "datasets/coach-review/gates/coach-gates-latest-report.json");
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  for (const gate of report.gates) {
    console.log(`${gate.verdict.padEnd(14)} ${gate.id.padEnd(3)} ${gate.title}`);
  }
  for (const [surface, s] of Object.entries(report.surfaces)) {
    console.log(`${s.verdict.padEnd(16)} surface:${surface}`);
  }
  console.log(`OVERALL: ${report.overallVerdict} → ${outPath}`);
  if (report.gates.some((gate) => gate.verdict === "FAIL")) process.exitCode = 1;
}
