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
  /** True when ?synthetic=1 injected dev fixtures into `reviews`. */
  syntheticMode: boolean;
  problems: string[];
}

export function isSyntheticMode(): boolean {
  return new URLSearchParams(window.location.search).get("synthetic") === "1";
}

export async function loadCoachReviewData(): Promise<CoachReviewData> {
  const problems: string[] = [];
  const [queue, schema, taxonomy, drills, registry, realReviews] = await Promise.all([
    getJson<QueueManifest>("/datasets/coach-review/queue.json"),
    getJson<SchemaDescriptor>("/datasets/coach-review/schema.json"),
    getJson<FaultTaxonomy>("/datasets/coach-review/taxonomy/fault-taxonomy.v0-draft.json"),
    getJson<DrillLibrary>("/datasets/coach-review/drills/drill-library.v0.json"),
    getJson<CoachRegistry>("/datasets/coach-review/coaches.json"),
    getJson<Array<{ file: string; review: CoachReview }>>("/api/coach-reviews"),
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
  return { queue, schema, taxonomy, drills, registry, reviews, syntheticMode, problems };
}

export function validationContextFrom(data: CoachReviewData): ValidationContext {
  return {
    knownQueueItemIds: data.queue.queue.map((item) => item.queueItemId),
    knownFaultIds: data.taxonomy.families.flatMap((family) => family.faults.map((fault) => fault.id)),
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
  const body = (await response.json().catch(() => null)) as
    | { ok?: boolean; message?: string; path?: string; problems?: string[] }
    | null;
  const problems = body?.problems ? ` — ${body.problems.join("; ")}` : "";
  const result: SubmitResult = {
    ok: response.ok,
    status: response.status,
    message: `${body?.message ?? `HTTP ${response.status}`}${problems}`,
  };
  if (body?.path) result.path = body.path;
  return result;
}

export function downloadReviewJson(review: CoachReview): void {
  const blob = new Blob([JSON.stringify(review, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${review.reviewId}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}
