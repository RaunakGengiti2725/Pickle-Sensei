import {
  EXPECTED_SCHEMA_VERSION,
  type CoachRegistry,
  type CoachReview,
  type DrillLibrary,
  type FaultTaxonomy,
  type LoadedReview,
  type QueueManifest,
  type SchemaDescriptor,
} from "./types";
import type { ValidationContext } from "./validate";
import {
  EMPTY_ASSIGNMENTS,
  type AdjudicationRecord,
  type AssignmentEntry,
  type AssignmentsFile,
  type DrillMappingProposal,
  type ReviewAmendment,
} from "./records";
import { syntheticLoadedReviews } from "./syntheticFixtures";

/**
 * Data access for the Coach Review Lab. Everything comes from the repo's
 * datasets/coach-review artifacts, served read-only by the vite dev
 * middleware (see vite.config.ts). Reviews are listed via /api/coach-reviews
 * so the append-only reviews/ directory is the single source of truth.
 */

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`GET ${path} → HTTP ${response.status}`);
  return (await response.json()) as T;
}

export interface CoachReviewData {
  queue: QueueManifest;
  schema: SchemaDescriptor;
  taxonomy: FaultTaxonomy;
  drills: DrillLibrary;
  registry: CoachRegistry;
  reviews: LoadedReview[];
  assignments: AssignmentsFile;
  adjudications: AdjudicationRecord[];
  amendments: ReviewAmendment[];
  mappingProposals: DrillMappingProposal[];
  /** True when ?synthetic=1 injected dev fixtures into `reviews`. */
  syntheticMode: boolean;
  problems: string[];
}

function isSyntheticMode(): boolean {
  return new URLSearchParams(window.location.search).get("synthetic") === "1";
}

export async function loadCoachReviewData(): Promise<CoachReviewData> {
  const problems: string[] = [];
  const [
    queue,
    schema,
    taxonomy,
    drills,
    registry,
    realReviews,
    assignments,
    adjudications,
    amendments,
    mappingProposals,
  ] = await Promise.all([
    getJson<QueueManifest>("/datasets/coach-review/queue.json"),
    getJson<SchemaDescriptor>("/datasets/coach-review/schema.json"),
    getJson<FaultTaxonomy>("/datasets/coach-review/taxonomy/fault-taxonomy.v0-draft.json"),
    getJson<DrillLibrary>("/datasets/coach-review/drills/drill-library.v0.json"),
    getJson<CoachRegistry>("/datasets/coach-review/coaches.json"),
    getJson<Array<{ file: string; review: CoachReview }>>("/api/coach-reviews"),
    getJson<AssignmentsFile>("/api/coach-assignments").catch(() => EMPTY_ASSIGNMENTS),
    getJson<AdjudicationRecord[]>("/api/coach-adjudications").catch(
      () => [] as AdjudicationRecord[],
    ),
    getJson<ReviewAmendment[]>("/api/coach-review-amendments").catch(() => [] as ReviewAmendment[]),
    getJson<DrillMappingProposal[]>("/api/drill-mapping-proposals").catch(
      () => [] as DrillMappingProposal[],
    ),
  ]);
  if (queue.schemaVersion !== EXPECTED_SCHEMA_VERSION) {
    problems.push(
      `queue.json schemaVersion ${queue.schemaVersion} ≠ UI's expected ${EXPECTED_SCHEMA_VERSION} — regenerate with \`pnpm lab:coach-queue\` or update the UI mirror.`,
    );
  }
  const reviews: LoadedReview[] = realReviews.map((entry) => ({
    review: entry.review,
    source: entry.file,
    synthetic: false,
  }));
  const syntheticMode = isSyntheticMode();
  if (syntheticMode) reviews.push(...syntheticLoadedReviews());
  return {
    queue,
    schema,
    taxonomy,
    drills,
    registry,
    reviews,
    assignments,
    adjudications,
    amendments,
    mappingProposals,
    syntheticMode,
    problems,
  };
}

/** Latest revision of a review: the original (revision 1) unless append-only
 * amendments supersede it. History is never dropped — callers get both. */
export function currentReviewVersion(
  review: CoachReview,
  amendments: ReviewAmendment[],
): { review: CoachReview; revision: number; history: ReviewAmendment[] } {
  const chain = amendments
    .filter((amendment) => amendment.reviewId === review.reviewId)
    .sort((a, b) => a.revision - b.revision);
  const latest = chain[chain.length - 1];
  return {
    review: latest ? latest.review : review,
    revision: latest ? latest.revision : 1,
    history: chain,
  };
}

/** All loaded reviews resolved to their latest amendment revision (synthetic
 * flags preserved). Consumers computing agreement/kappa must use this — a
 * superseded revision 1 is history, not the coach's current judgment. */
export function latestReviewVersions(
  reviews: LoadedReview[],
  amendments: ReviewAmendment[],
): LoadedReview[] {
  return reviews.map((entry) => ({
    ...entry,
    review: currentReviewVersion(entry.review, amendments).review,
  }));
}

export function validationContextFrom(data: CoachReviewData): ValidationContext {
  return {
    knownQueueItemIds: data.queue.queue.map((item) => item.queueItemId),
    knownFaultIds: data.taxonomy.families.flatMap((family) =>
      family.faults.map((fault) => fault.id),
    ),
    knownDrillIds: data.drills.drills.map((drill) => drill.id),
    strokeTaxonomyVersion: data.schema.strokeTaxonomy.version,
    strokeLabels: data.schema.strokeTaxonomy.labels,
    faultTaxonomyVersion: data.schema.faultTaxonomyVersion,
    qualityScaleId: data.schema.qualityScale.id,
  };
}

export interface SubmitResult {
  ok: boolean;
  status: number;
  message: string;
  path?: string;
}

export async function submitReview(review: CoachReview): Promise<SubmitResult> {
  const response = await fetch("/api/coach-reviews", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(review),
  });
  const body = (await response.json().catch(() => null)) as {
    ok?: boolean;
    message?: string;
    path?: string;
    problems?: string[];
  } | null;
  const problems = body?.problems ? ` — ${body.problems.join("; ")}` : "";
  const result: SubmitResult = {
    ok: response.ok,
    status: response.status,
    message: `${body?.message ?? `HTTP ${response.status}`}${problems}`,
  };
  if (body?.path) result.path = body.path;
  return result;
}

async function postJson(path: string, payload: unknown): Promise<SubmitResult> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = (await response.json().catch(() => null)) as {
    ok?: boolean;
    message?: string;
    path?: string;
    problems?: string[];
  } | null;
  const problems = body?.problems ? ` — ${body.problems.join("; ")}` : "";
  const result: SubmitResult = {
    ok: response.ok,
    status: response.status,
    message: `${body?.message ?? `HTTP ${response.status}`}${problems}`,
  };
  if (body?.path) result.path = body.path;
  return result;
}

export function submitAdjudication(record: AdjudicationRecord): Promise<SubmitResult> {
  return postJson("/api/coach-adjudications", record);
}

export function submitAmendment(amendment: ReviewAmendment): Promise<SubmitResult> {
  return postJson("/api/coach-review-amendments", amendment);
}

export function submitAssignment(entry: AssignmentEntry): Promise<SubmitResult> {
  return postJson("/api/coach-assignments", entry);
}

export function submitMappingProposal(proposal: DrillMappingProposal): Promise<SubmitResult> {
  return postJson("/api/drill-mapping-proposals", proposal);
}

export function downloadJson(filename: string, payload: unknown): void {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function downloadReviewJson(review: CoachReview): void {
  downloadJson(`${review.reviewId}.json`, review);
}

export interface AdjudicatedExport {
  exportVersion: "adjudicated-reviews-export-v1";
  generatedAtIso: string;
  items: Array<{
    queueItemId: string;
    adjudication: AdjudicationRecord;
    reviews: Array<{ review: CoachReview; revision: number; amendmentHistory: ReviewAmendment[] }>;
  }>;
}

/** Export of adjudicated items only: the adjudication verdict PLUS the frozen
 * disagreeing reviews (latest revision + full amendment history) — consumers
 * keep the variance, not just the verdict. Synthetic fixtures are excluded. */
export function buildAdjudicatedExport(
  reviews: LoadedReview[],
  amendments: ReviewAmendment[],
  adjudications: AdjudicationRecord[],
  nowIso: string = new Date().toISOString(),
): AdjudicatedExport {
  const real = reviews.filter((entry) => !entry.synthetic).map((entry) => entry.review);
  return {
    exportVersion: "adjudicated-reviews-export-v1",
    generatedAtIso: nowIso,
    items: adjudications.map((adjudication) => ({
      queueItemId: adjudication.queueItemId,
      adjudication,
      reviews: real
        .filter((review) => review.queueItemId === adjudication.queueItemId)
        .map((review) => {
          const { review: current, revision, history } = currentReviewVersion(review, amendments);
          return { review: current, revision, amendmentHistory: history };
        }),
    })),
  };
}
