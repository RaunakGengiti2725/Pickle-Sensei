import type { AdjudicatedExport } from "./data";
import type { AdjudicationRecord, ReviewAmendment } from "./records";
import type { CoachReview } from "./types";

/**
 * Import / validation counterpart of buildAdjudicatedExport (C14).
 *
 * Contract:
 *  - schema-versioned: only "adjudicated-reviews-export-v1" is accepted; any
 *    other exportVersion (or a missing one) is REFUSED, never best-effort
 *    parsed;
 *  - append-only merge: importing can only ADD records that do not exist in
 *    the local store. An identical record already present is a no-op
 *    (idempotent re-import); a record whose id exists locally with different
 *    content is a CONFLICT surfaced in the report — the local record is never
 *    silently overwritten and the imported one is never applied;
 *  - synthetic identities are refused at the import boundary exactly like the
 *    write endpoints refuse them.
 *
 * The merge result lists exactly what a caller may append (via the existing
 * append-only persistence paths); it never mutates its inputs.
 */

export const ADJUDICATED_EXPORT_VERSION = "adjudicated-reviews-export-v1" as const;

export interface ParseResult {
  export: AdjudicatedExport | null;
  problems: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIso(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

/** Structural validation of an untrusted payload. Refuses unknown versions. */
export function parseAdjudicatedExport(payload: unknown): ParseResult {
  const problems: string[] = [];
  if (!isRecord(payload)) {
    return { export: null, problems: ["payload must be a JSON object"] };
  }
  if (payload.exportVersion !== ADJUDICATED_EXPORT_VERSION) {
    return {
      export: null,
      problems: [
        `unknown exportVersion ${JSON.stringify(payload.exportVersion ?? null)} — this importer only accepts ${ADJUDICATED_EXPORT_VERSION}`,
      ],
    };
  }
  if (!isIso(payload.generatedAtIso)) problems.push("generatedAtIso must be an ISO timestamp");
  if (!Array.isArray(payload.items)) {
    problems.push("items must be an array");
    return { export: null, problems };
  }
  payload.items.forEach((item: unknown, index: number) => {
    const at = `items[${index}]`;
    if (!isRecord(item)) {
      problems.push(`${at} must be an object`);
      return;
    }
    if (typeof item.queueItemId !== "string" || item.queueItemId.length === 0) {
      problems.push(`${at}.queueItemId required`);
    }
    const adjudication = item.adjudication;
    if (!isRecord(adjudication)) {
      problems.push(`${at}.adjudication required`);
    } else {
      if (adjudication.schemaVersion !== 1) {
        problems.push(`${at}.adjudication.schemaVersion must be 1`);
      }
      if (adjudication.queueItemId !== item.queueItemId) {
        problems.push(`${at}.adjudication.queueItemId must equal ${at}.queueItemId`);
      }
      if (typeof adjudication.adjudicatorId !== "string" || !adjudication.adjudicatorId) {
        problems.push(`${at}.adjudication.adjudicatorId required`);
      } else if (/synthetic/i.test(adjudication.adjudicatorId)) {
        problems.push(`${at}.adjudication: SYNTHETIC adjudicator ids may never be imported`);
      }
      if (!isIso(adjudication.createdAtIso)) {
        problems.push(`${at}.adjudication.createdAtIso must be an ISO timestamp`);
      }
    }
    if (!Array.isArray(item.reviews)) {
      problems.push(`${at}.reviews must be an array`);
      return;
    }
    item.reviews.forEach((entry: unknown, reviewIndex: number) => {
      const rat = `${at}.reviews[${reviewIndex}]`;
      if (!isRecord(entry)) {
        problems.push(`${rat} must be an object`);
        return;
      }
      if (!Number.isInteger(entry.revision) || (entry.revision as number) < 1) {
        problems.push(`${rat}.revision must be an integer ≥1`);
      }
      const review = entry.review;
      if (!isRecord(review) || typeof review.reviewId !== "string" || !review.reviewId) {
        problems.push(`${rat}.review.reviewId required`);
      } else {
        if (typeof review.coachId !== "string" || !review.coachId) {
          problems.push(`${rat}.review.coachId required`);
        } else if (/synthetic/i.test(review.coachId)) {
          problems.push(`${rat}: SYNTHETIC coach ids may never be imported`);
        }
        if (review.queueItemId !== item.queueItemId) {
          problems.push(`${rat}.review.queueItemId must equal ${at}.queueItemId`);
        }
      }
      if (!Array.isArray(entry.amendmentHistory)) {
        problems.push(`${rat}.amendmentHistory must be an array`);
        return;
      }
      entry.amendmentHistory.forEach((amendment: unknown, amendmentIndex: number) => {
        const aat = `${rat}.amendmentHistory[${amendmentIndex}]`;
        if (!isRecord(amendment)) {
          problems.push(`${aat} must be an object`);
          return;
        }
        if (amendment.schemaVersion !== 1) problems.push(`${aat}.schemaVersion must be 1`);
        if (typeof amendment.amendmentId !== "string" || !amendment.amendmentId) {
          problems.push(`${aat}.amendmentId required`);
        }
        if (!Number.isInteger(amendment.revision) || (amendment.revision as number) < 2) {
          problems.push(`${aat}.revision must be an integer ≥2`);
        }
      });
    });
  });
  if (problems.length > 0) return { export: null, problems };
  return { export: payload as unknown as AdjudicatedExport, problems: [] };
}

/** Stable serialization used for content-identity comparison. Key order is
 * canonicalized recursively so two structurally-equal records compare equal
 * regardless of the key order they were serialized with. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (isRecord(value)) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) sorted[key] = sortKeys(value[key]);
    return sorted;
  }
  return value;
}

export interface ImportConflict {
  kind: "adjudication" | "review" | "amendment";
  id: string;
  detail: string;
}

export interface LocalStore {
  /** Latest known persisted reviews (revision 1 originals). */
  reviews: CoachReview[];
  amendments: ReviewAmendment[];
  adjudications: AdjudicationRecord[];
}

export interface MergeResult {
  /** Records safe to append — none of these ids exist locally. */
  toAppend: {
    reviews: CoachReview[];
    amendments: ReviewAmendment[];
    adjudications: AdjudicationRecord[];
  };
  /** Ids present locally with byte-identical content (idempotent no-ops). */
  unchanged: { reviews: string[]; amendments: string[]; adjudications: string[] };
  /** Same id, different content. NEVER applied — surfaced for a human. */
  conflicts: ImportConflict[];
}

/** Append-only merge of a parsed export into the local store. Pure: inputs
 * are never mutated; the caller persists `toAppend` through the existing
 * append-only endpoints only when `conflicts` is empty (or after explicit
 * human resolution of each conflict). */
export function mergeAdjudicatedImport(
  local: LocalStore,
  imported: AdjudicatedExport,
): MergeResult {
  const localReviewsById = new Map(local.reviews.map((review) => [review.reviewId, review]));
  const localAmendmentsById = new Map(
    local.amendments.map((amendment) => [amendment.amendmentId, amendment]),
  );
  const localAdjudicationsByItem = new Map(
    local.adjudications.map((record) => [record.queueItemId, record]),
  );

  const result: MergeResult = {
    toAppend: { reviews: [], amendments: [], adjudications: [] },
    unchanged: { reviews: [], amendments: [], adjudications: [] },
    conflicts: [],
  };
  const seenReviewIds = new Set<string>();
  const seenAmendmentIds = new Set<string>();
  const seenQueueItemIds = new Set<string>();

  for (const item of imported.items) {
    const adjudicationId = item.queueItemId;
    if (!seenQueueItemIds.has(adjudicationId)) {
      seenQueueItemIds.add(adjudicationId);
      const localAdjudication = localAdjudicationsByItem.get(adjudicationId);
      if (localAdjudication === undefined) {
        result.toAppend.adjudications.push(item.adjudication);
      } else if (canonicalJson(localAdjudication) === canonicalJson(item.adjudication)) {
        result.unchanged.adjudications.push(adjudicationId);
      } else {
        result.conflicts.push({
          kind: "adjudication",
          id: adjudicationId,
          detail: `local adjudication for ${adjudicationId} differs from the imported one (adjudicator ${localAdjudication.adjudicatorId} vs ${item.adjudication.adjudicatorId}); keeping local, import NOT applied`,
        });
      }
    }

    for (const entry of item.reviews) {
      // The export carries the LATEST revision in `review`; revision 1 (the
      // original) is only recoverable when it is the latest or via the
      // amendment chain, so the original-review append is gated on revision 1.
      const reviewId = entry.review.reviewId;
      if (!seenReviewIds.has(reviewId)) {
        seenReviewIds.add(reviewId);
        const localReview = localReviewsById.get(reviewId);
        if (localReview === undefined) {
          if (entry.revision === 1) {
            result.toAppend.reviews.push(entry.review);
          } else {
            result.conflicts.push({
              kind: "review",
              id: reviewId,
              detail: `imported review ${reviewId} is revision ${entry.revision} but no local revision-1 original exists and the export does not carry it; import NOT applied`,
            });
          }
        } else if (
          entry.revision === 1 &&
          canonicalJson(localReview) !== canonicalJson(entry.review)
        ) {
          result.conflicts.push({
            kind: "review",
            id: reviewId,
            detail: `local review ${reviewId} differs from the imported revision-1 review; keeping local, import NOT applied`,
          });
        } else {
          result.unchanged.reviews.push(reviewId);
        }
      }

      for (const amendment of entry.amendmentHistory) {
        if (seenAmendmentIds.has(amendment.amendmentId)) continue;
        seenAmendmentIds.add(amendment.amendmentId);
        const localAmendment = localAmendmentsById.get(amendment.amendmentId);
        if (localAmendment === undefined) {
          result.toAppend.amendments.push(amendment);
        } else if (canonicalJson(localAmendment) === canonicalJson(amendment)) {
          result.unchanged.amendments.push(amendment.amendmentId);
        } else {
          result.conflicts.push({
            kind: "amendment",
            id: amendment.amendmentId,
            detail: `local amendment ${amendment.amendmentId} differs from the imported one; keeping local, import NOT applied`,
          });
        }
      }
    }
  }
  return result;
}
