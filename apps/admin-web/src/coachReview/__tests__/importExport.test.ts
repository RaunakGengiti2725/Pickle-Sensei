import { describe, expect, it } from "vitest";
import { buildAdjudicatedExport, type AdjudicatedExport } from "../data";
import {
  canonicalJson,
  mergeAdjudicatedImport,
  parseAdjudicatedExport,
  type LocalStore,
} from "../importExport";
import { amendmentIdFor, type AdjudicationRecord, type ReviewAmendment } from "../records";
import { syntheticAgreeingPair } from "../syntheticFixtures";
import type { CoachReview, LoadedReview } from "../types";

function review(coachId: string): CoachReview {
  const [fixture] = syntheticAgreeingPair();
  return {
    ...fixture!,
    coachId,
    coachCredentialRef: `cred-${coachId}`,
    reviewId: `wm-volley-02-E1.${coachId}`,
    queueItemId: "wm-volley-02-E1",
  };
}

const reviewA = review("coach-01");
const reviewB = review("coach-02");
const amendment: ReviewAmendment = {
  schemaVersion: 1,
  amendmentId: amendmentIdFor(reviewA.reviewId, 2),
  reviewId: reviewA.reviewId,
  revision: 2,
  reason: "rewatched at quarter speed",
  review: { ...reviewA, confidence: 0.9 },
  createdAtIso: "2026-08-29T00:00:00.000Z",
};
const adjudication: AdjudicationRecord = {
  schemaVersion: 1,
  queueItemId: "wm-volley-02-E1",
  adjudicatorId: "coach-03",
  adjudicatorCredentialRef: "cred-coach-03",
  reviewedReviewIds: [reviewA.reviewId, reviewB.reviewId],
  outcome: { kind: "uphold", reviewId: reviewA.reviewId },
  rationale: "severity call matches the visible wrist action",
  evidenceTimestampsMs: [1200],
  createdAtIso: "2026-08-29T00:00:00.000Z",
};

function loaded(entries: CoachReview[]): LoadedReview[] {
  return entries.map((entry, index) => ({
    review: entry,
    source: `datasets/coach-review/reviews/${index}.json`,
    synthetic: false,
  }));
}

const NOW = "2026-08-29T01:00:00.000Z";

function exportFixture(): AdjudicatedExport {
  return buildAdjudicatedExport(loaded([reviewA, reviewB]), [amendment], [adjudication], NOW);
}

describe("parseAdjudicatedExport", () => {
  it("refuses unknown export versions instead of best-effort parsing", () => {
    const result = parseAdjudicatedExport({
      exportVersion: "adjudicated-reviews-export-v2",
      generatedAtIso: NOW,
      items: [],
    });
    expect(result.export).toBeNull();
    expect(result.problems[0]).toContain("unknown exportVersion");
    expect(parseAdjudicatedExport({}).export).toBeNull();
    expect(parseAdjudicatedExport("nope").export).toBeNull();
  });

  it("accepts a real export after a JSON round trip", () => {
    const parsed = parseAdjudicatedExport(JSON.parse(JSON.stringify(exportFixture())));
    expect(parsed.problems).toEqual([]);
    expect(parsed.export?.items).toHaveLength(1);
  });

  it("refuses SYNTHETIC identities at the import boundary", () => {
    const payload = JSON.parse(JSON.stringify(exportFixture())) as AdjudicatedExport;
    payload.items[0]!.adjudication.adjudicatorId = "SYNTHETIC-coach";
    const result = parseAdjudicatedExport(JSON.parse(JSON.stringify(payload)));
    expect(result.export).toBeNull();
    expect(result.problems.join("\n")).toContain("SYNTHETIC");
  });

  it("reports structural problems with paths", () => {
    const payload = JSON.parse(JSON.stringify(exportFixture())) as Record<string, unknown>;
    (payload.items as Array<Record<string, unknown>>)[0]!.reviews = "nope";
    const result = parseAdjudicatedExport(JSON.parse(JSON.stringify(payload)));
    expect(result.export).toBeNull();
    expect(result.problems.join("\n")).toContain("items[0].reviews");
  });
});

describe("mergeAdjudicatedImport (append-only)", () => {
  const empty: LocalStore = { reviews: [], amendments: [], adjudications: [] };

  it("imports into an empty store; a latest-revision review without its original is flagged, never guessed", () => {
    const merge = mergeAdjudicatedImport(empty, exportFixture());
    expect(merge.toAppend.adjudications).toHaveLength(1);
    expect(merge.toAppend.amendments).toHaveLength(1);
    // reviewA arrives as revision 2 (latest); the export does not carry its
    // revision-1 original, so only revision-1 reviewB is a direct append.
    expect(merge.toAppend.reviews.map((entry) => entry.reviewId)).toEqual([reviewB.reviewId]);
    expect(merge.conflicts).toEqual([
      {
        kind: "review",
        id: reviewA.reviewId,
        detail: expect.stringContaining("no local revision-1 original") as unknown as string,
      },
    ]);
  });

  it("is idempotent: re-importing into the merged store appends nothing", () => {
    const exported = exportFixture();
    const store: LocalStore = {
      reviews: [reviewA, reviewB],
      amendments: [amendment],
      adjudications: [adjudication],
    };
    const merge = mergeAdjudicatedImport(store, exported);
    expect(merge.conflicts).toEqual([]);
    expect(merge.toAppend).toEqual({ reviews: [], amendments: [], adjudications: [] });
    expect(merge.unchanged.adjudications).toEqual(["wm-volley-02-E1"]);
    expect(merge.unchanged.amendments).toEqual([amendment.amendmentId]);
  });

  it("reports a conflict and never overwrites when the same id differs", () => {
    const store: LocalStore = {
      reviews: [reviewA, reviewB],
      amendments: [{ ...amendment, reason: "a different local reason" }],
      adjudications: [{ ...adjudication, rationale: "a different local adjudication rationale" }],
    };
    const merge = mergeAdjudicatedImport(store, exportFixture());
    expect(merge.toAppend).toEqual({ reviews: [], amendments: [], adjudications: [] });
    expect(merge.conflicts.map((conflict) => conflict.kind).sort()).toEqual([
      "adjudication",
      "amendment",
    ]);
    for (const conflict of merge.conflicts) {
      expect(conflict.detail).toContain("NOT applied");
    }
  });

  it("round-trips byte-stably: export → parse → merge → re-export", () => {
    const exported = exportFixture();
    const serialized = JSON.stringify(exported, null, 2);
    const parsed = parseAdjudicatedExport(JSON.parse(serialized));
    expect(parsed.export).not.toBeNull();
    const merge = mergeAdjudicatedImport(
      { reviews: [reviewA], amendments: [], adjudications: [] },
      parsed.export!,
    );
    expect(merge.conflicts).toEqual([]);
    const rebuilt: LocalStore = {
      reviews: [reviewA, ...merge.toAppend.reviews],
      amendments: merge.toAppend.amendments,
      adjudications: merge.toAppend.adjudications,
    };
    const reExported = buildAdjudicatedExport(
      loaded(rebuilt.reviews),
      rebuilt.amendments,
      rebuilt.adjudications,
      NOW,
    );
    expect(JSON.stringify(reExported, null, 2)).toBe(serialized);
  });
});

describe("canonicalJson", () => {
  it("is key-order independent", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(
      canonicalJson({ a: { c: 3, d: 2 }, b: 1 }),
    );
  });
});
