import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, normalize } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { validateReview, type ValidationContext } from "./validate";
import {
  EMPTY_ASSIGNMENTS,
  validateAdjudication,
  validateAmendment,
  validateAssignment,
  validateMappingProposal,
  type AdjudicationRecord,
  type AssignmentEntry,
  type AssignmentsFile,
  type DrillMappingProposal,
  type ReviewAmendment,
} from "./records";
import type {
  CoachRegistry,
  CoachRegistryEntry,
  CoachReview,
  DrillLibrary,
  FaultTaxonomy,
  QueueManifest,
  SchemaDescriptor,
} from "./types";

/**
 * Coach Review Lab dev API, extracted from vite.config.ts so the SAME write
 * gates the dev server enforces are unit-testable against a throwaway repo
 * root (never datasets/). vite.config.ts mounts this middleware unchanged.
 *
 * POST /api/coach-reviews is the ONLY review write path, and it is gated so
 * that fabricated reviews are structurally impossible from this tool:
 *  - the coachId MUST be provisioned (status "active") in the HUMAN-managed
 *    datasets/coach-review/coaches.json registry — which is EMPTY today, so
 *    every write is refused with 403 "no coach identity provisioned" until
 *    a real coach is onboarded per docs/COACHING.md;
 *  - SYNTHETIC ids are rejected outright (dev fixtures never persist);
 *  - storage is append-only: an existing reviewId can never be overwritten.
 */

const CONTENT_TYPES: Record<string, string> = {
  ".json": "application/json; charset=utf-8",
  ".mp4": "video/mp4",
  ".md": "text/markdown; charset=utf-8",
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(payload);
}

function readBody(req: IncomingMessage, limitBytes: number): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > limitBytes) {
        rejectPromise(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolvePromise(Buffer.concat(chunks).toString("utf8")));
    req.on("error", rejectPromise);
  });
}

async function readJsonBody<T>(
  req: IncomingMessage,
  res: ServerResponse,
  limitBytes: number,
): Promise<T | null> {
  try {
    return JSON.parse(await readBody(req, limitBytes)) as T;
  } catch (error) {
    sendJson(res, 400, { message: `invalid JSON body: ${String(error)}` });
    return null;
  }
}

export type LabApiMiddleware = (
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void,
) => void;

export function createLabApiMiddleware(repoRoot: string): LabApiMiddleware {
  const COACH_REVIEW_DIR = join(repoRoot, "datasets/coach-review");
  const REVIEWS_DIR = join(COACH_REVIEW_DIR, "reviews");
  const AMENDMENTS_DIR = join(COACH_REVIEW_DIR, "amendments");
  const ADJUDICATIONS_DIR = join(COACH_REVIEW_DIR, "adjudications");
  const DRILL_MAPPINGS_DIR = join(COACH_REVIEW_DIR, "drill-mappings");
  const ASSIGNMENTS_FILE = join(COACH_REVIEW_DIR, "assignments.json");

  /** Static read-only file serving for /datasets/** (+ docs/COACHING.md), with
   * HTTP Range support so the event <video> can seek/loop efficiently. */
  function serveRepoFile(req: IncomingMessage, res: ServerResponse, urlPath: string): void {
    const decoded = decodeURIComponent(urlPath.split("?")[0] ?? "");
    const filePath = normalize(join(repoRoot, decoded));
    const allowed =
      filePath.startsWith(join(repoRoot, "datasets") + "/") ||
      filePath === join(repoRoot, "docs/COACHING.md");
    if (!allowed || !existsSync(filePath) || !statSync(filePath).isFile()) {
      sendJson(res, 404, { message: `not found: ${decoded}` });
      return;
    }
    const extension = filePath.slice(filePath.lastIndexOf("."));
    const contentType = CONTENT_TYPES[extension] ?? "application/octet-stream";
    const { size } = statSync(filePath);
    const range = req.headers.range;
    if (range) {
      const match = /bytes=(\d*)-(\d*)/.exec(range);
      const start = match?.[1] ? Number(match[1]) : 0;
      const end = match?.[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
      if (start >= size || start > end) {
        res.writeHead(416, { "content-range": `bytes */${size}` });
        res.end();
        return;
      }
      res.writeHead(206, {
        "content-type": contentType,
        "content-range": `bytes ${start}-${end}/${size}`,
        "accept-ranges": "bytes",
        "content-length": end - start + 1,
      });
      createReadStream(filePath, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, {
      "content-type": contentType,
      "content-length": size,
      "accept-ranges": "bytes",
    });
    createReadStream(filePath).pipe(res);
  }

  function loadValidationContext(): ValidationContext {
    const queue = JSON.parse(
      readFileSync(join(COACH_REVIEW_DIR, "queue.json"), "utf8"),
    ) as QueueManifest;
    const schema = JSON.parse(
      readFileSync(join(COACH_REVIEW_DIR, "schema.json"), "utf8"),
    ) as SchemaDescriptor;
    const taxonomy = JSON.parse(
      readFileSync(join(COACH_REVIEW_DIR, "taxonomy/fault-taxonomy.v0-draft.json"), "utf8"),
    ) as FaultTaxonomy;
    const drills = JSON.parse(
      readFileSync(join(COACH_REVIEW_DIR, "drills/drill-library.v0.json"), "utf8"),
    ) as DrillLibrary;
    return {
      knownQueueItemIds: queue.queue.map((item) => item.queueItemId),
      knownFaultIds: taxonomy.families.flatMap((family) => family.faults.map((fault) => fault.id)),
      knownDrillIds: drills.drills.map((drill) => drill.id),
      strokeTaxonomyVersion: schema.strokeTaxonomy.version,
      strokeLabels: schema.strokeTaxonomy.labels,
      faultTaxonomyVersion: schema.faultTaxonomyVersion,
      qualityScaleId: schema.qualityScale.id,
    };
  }

  function readJsonDir<T>(dir: string): Array<{ file: string; record: T }> {
    mkdirSync(dir, { recursive: true });
    return readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => ({
        file: join(dir, name),
        record: JSON.parse(readFileSync(join(dir, name), "utf8")) as T,
      }));
  }

  function loadRegistry(): CoachRegistry {
    return JSON.parse(
      readFileSync(join(COACH_REVIEW_DIR, "coaches.json"), "utf8"),
    ) as CoachRegistry;
  }

  /** Shared identity gate: every write path requires a provisioned, active,
   * non-synthetic coach whose credentialRef matches the registry entry. */
  function gateIdentity(
    res: ServerResponse,
    coachId: string | undefined,
    credentialRef: string | undefined,
  ): CoachRegistryEntry | null {
    const registry = loadRegistry();
    const active = registry.coaches.find(
      (coach) => coach.coachId === coachId && coach.status === "active",
    );
    if (!active) {
      sendJson(res, 403, {
        message:
          "no coach identity provisioned: coachId is not an active entry in datasets/coach-review/coaches.json. " +
          "Writes require a provisioned coach (docs/COACHING.md §2).",
      });
      return null;
    }
    if (/synthetic/i.test(coachId ?? "") || /synthetic/i.test(credentialRef ?? "")) {
      sendJson(res, 403, {
        message: "SYNTHETIC identities are dev fixtures and can never be persisted",
      });
      return null;
    }
    if (credentialRef !== active.credentialRef) {
      sendJson(res, 403, {
        message: "credentialRef does not match the provisioned registry entry",
      });
      return null;
    }
    return active;
  }

  function writeAppendOnly(
    res: ServerResponse,
    filePath: string,
    record: unknown,
    publicPath: string,
  ): void {
    mkdirSync(dirname(filePath), { recursive: true });
    if (existsSync(filePath)) {
      sendJson(res, 409, {
        message: `append-only: ${publicPath} already exists and is never overwritten`,
      });
      return;
    }
    writeFileSync(filePath, JSON.stringify(record, null, 2));
    sendJson(res, 201, { ok: true, message: "persisted (append-only)", path: publicPath });
  }

  function readAssignments(): AssignmentsFile {
    if (!existsSync(ASSIGNMENTS_FILE)) return EMPTY_ASSIGNMENTS;
    return JSON.parse(readFileSync(ASSIGNMENTS_FILE, "utf8")) as AssignmentsFile;
  }

  async function handleAdjudications(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === "GET") {
      sendJson(
        res,
        200,
        readJsonDir<AdjudicationRecord>(ADJUDICATIONS_DIR).map((entry) => entry.record),
      );
      return;
    }
    if (req.method !== "POST") {
      sendJson(res, 405, { message: "method not allowed" });
      return;
    }
    const record = await readJsonBody<AdjudicationRecord>(req, res, 1_000_000);
    if (record === null) return;
    if (!gateIdentity(res, record.adjudicatorId, record.adjudicatorCredentialRef)) return;
    const reviewerCoachIdsByReviewId: Record<string, string> = {};
    const reviewQueueItemIdsByReviewId: Record<string, string> = {};
    for (const entry of readJsonDir<CoachReview>(REVIEWS_DIR)) {
      reviewerCoachIdsByReviewId[entry.record.reviewId] = entry.record.coachId;
      reviewQueueItemIdsByReviewId[entry.record.reviewId] = entry.record.queueItemId;
    }
    const problems = validateAdjudication(record, {
      ...loadValidationContext(),
      reviewerCoachIdsByReviewId,
      reviewQueueItemIdsByReviewId,
    });
    if (problems.length > 0) {
      sendJson(res, 422, { message: "adjudication failed schema validation", problems });
      return;
    }
    writeAppendOnly(
      res,
      join(ADJUDICATIONS_DIR, `${record.queueItemId}.json`),
      record,
      `datasets/coach-review/adjudications/${record.queueItemId}.json`,
    );
  }

  async function handleAmendments(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === "GET") {
      sendJson(
        res,
        200,
        readJsonDir<ReviewAmendment>(AMENDMENTS_DIR).map((entry) => entry.record),
      );
      return;
    }
    if (req.method !== "POST") {
      sendJson(res, 405, { message: "method not allowed" });
      return;
    }
    const amendment = await readJsonBody<ReviewAmendment>(req, res, 1_000_000);
    if (amendment === null) return;
    if (!gateIdentity(res, amendment.review?.coachId, amendment.review?.coachCredentialRef)) return;
    const basePath = join(REVIEWS_DIR, `${amendment.reviewId}.json`);
    if (!existsSync(basePath)) {
      sendJson(res, 404, {
        message: `no base review ${amendment.reviewId} — amendments can only version an existing review`,
      });
      return;
    }
    const base = JSON.parse(readFileSync(basePath, "utf8")) as CoachReview;
    if (base.coachId !== amendment.review.coachId) {
      sendJson(res, 403, { message: "only the original reviewing coach can amend their review" });
      return;
    }
    const existing = readJsonDir<ReviewAmendment>(AMENDMENTS_DIR)
      .map((entry) => entry.record)
      .filter((entry) => entry.reviewId === amendment.reviewId);
    const nextRevision = existing.reduce((max, entry) => Math.max(max, entry.revision), 1) + 1;
    if (amendment.revision !== nextRevision) {
      sendJson(res, 409, { message: `revision must be ${nextRevision} (append-only, sequential)` });
      return;
    }
    const problems = validateAmendment(amendment, loadValidationContext());
    if (problems.length > 0) {
      sendJson(res, 422, { message: "amendment failed schema validation", problems });
      return;
    }
    writeAppendOnly(
      res,
      join(AMENDMENTS_DIR, `${amendment.amendmentId}.json`),
      amendment,
      `datasets/coach-review/amendments/${amendment.amendmentId}.json`,
    );
  }

  async function handleAssignments(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === "GET") {
      sendJson(res, 200, readAssignments());
      return;
    }
    if (req.method !== "POST") {
      sendJson(res, 405, { message: "method not allowed" });
      return;
    }
    const entry = await readJsonBody<AssignmentEntry>(req, res, 100_000);
    if (entry === null) return;
    const registry = loadRegistry();
    const activeCoachIds = registry.coaches
      .filter((coach) => coach.status === "active")
      .map((coach) => coach.coachId);
    if (activeCoachIds.length === 0) {
      sendJson(res, 403, {
        message:
          "no coach identity provisioned: assignments require ≥1 active coach in coaches.json",
      });
      return;
    }
    const problems = validateAssignment(entry, {
      knownQueueItemIds: loadValidationContext().knownQueueItemIds,
      activeCoachIds,
    });
    if (problems.length > 0) {
      sendJson(res, 422, { message: "assignment failed validation", problems });
      return;
    }
    const file = readAssignments();
    const next: AssignmentsFile = {
      ...file,
      assignments: [
        ...file.assignments.filter((existing) => existing.queueItemId !== entry.queueItemId),
        entry,
      ],
    };
    writeFileSync(ASSIGNMENTS_FILE, JSON.stringify(next, null, 2));
    sendJson(res, 201, {
      ok: true,
      message: "assignment saved",
      path: "datasets/coach-review/assignments.json",
    });
  }

  async function handleMappingProposals(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === "GET") {
      sendJson(
        res,
        200,
        readJsonDir<DrillMappingProposal>(DRILL_MAPPINGS_DIR).map((entry) => entry.record),
      );
      return;
    }
    if (req.method !== "POST") {
      sendJson(res, 405, { message: "method not allowed" });
      return;
    }
    const proposal = await readJsonBody<DrillMappingProposal>(req, res, 200_000);
    if (proposal === null) return;
    if (!gateIdentity(res, proposal.coachId, proposal.coachCredentialRef)) return;
    const problems = validateMappingProposal(proposal, loadValidationContext());
    if (problems.length > 0) {
      sendJson(res, 422, { message: "mapping proposal failed schema validation", problems });
      return;
    }
    writeAppendOnly(
      res,
      join(DRILL_MAPPINGS_DIR, `${proposal.proposalId}.json`),
      proposal,
      `datasets/coach-review/drill-mappings/${proposal.proposalId}.json`,
    );
  }

  return (req, res, next) => {
    void (async () => {
      const url = req.url ?? "";
      if (req.method === "GET" && (url.startsWith("/datasets/") || url === "/docs/COACHING.md")) {
        serveRepoFile(req, res, url);
        return;
      }
      const route = url.split("?")[0];
      if (route === "/api/coach-adjudications") {
        await handleAdjudications(req, res);
        return;
      }
      if (route === "/api/coach-review-amendments") {
        await handleAmendments(req, res);
        return;
      }
      if (route === "/api/coach-assignments") {
        await handleAssignments(req, res);
        return;
      }
      if (route === "/api/drill-mapping-proposals") {
        await handleMappingProposals(req, res);
        return;
      }
      if (route !== "/api/coach-reviews") {
        next();
        return;
      }
      if (req.method === "GET") {
        mkdirSync(REVIEWS_DIR, { recursive: true });
        const entries = readdirSync(REVIEWS_DIR)
          .filter((name) => name.endsWith(".json"))
          .map((name) => ({
            file: `datasets/coach-review/reviews/${name}`,
            review: JSON.parse(readFileSync(join(REVIEWS_DIR, name), "utf8")) as CoachReview,
          }));
        sendJson(res, 200, entries);
        return;
      }
      if (req.method !== "POST") {
        sendJson(res, 405, { message: "method not allowed" });
        return;
      }
      const review = await readJsonBody<CoachReview>(req, res, 1_000_000);
      if (review === null) return;
      const registry = loadRegistry();
      const activeCoach = registry.coaches.find(
        (coach) => coach.coachId === review.coachId && coach.status === "active",
      );
      if (!activeCoach) {
        sendJson(res, 403, {
          message:
            "no coach identity provisioned: coachId is not an active entry in datasets/coach-review/coaches.json. " +
            "Reviews can only be persisted by provisioned coaches (docs/COACHING.md §2). Review count remains unchanged.",
        });
        return;
      }
      if (/synthetic/i.test(review.coachId) || /synthetic/i.test(review.coachCredentialRef ?? "")) {
        sendJson(res, 403, {
          message: "SYNTHETIC identities are dev fixtures and can never be persisted",
        });
        return;
      }
      if (review.coachCredentialRef !== activeCoach.credentialRef) {
        sendJson(res, 403, {
          message: "coachCredentialRef does not match the provisioned registry entry",
        });
        return;
      }
      const problems = validateReview(review, loadValidationContext());
      if (problems.length > 0) {
        sendJson(res, 422, { message: "review failed schema validation", problems });
        return;
      }
      mkdirSync(REVIEWS_DIR, { recursive: true });
      const filePath = join(REVIEWS_DIR, `${review.reviewId}.json`);
      if (existsSync(filePath)) {
        sendJson(res, 409, {
          message: `append-only: ${review.reviewId}.json already exists and is never overwritten. Adjudication/amendments are separate records (docs/COACHING.md §6).`,
        });
        return;
      }
      writeFileSync(filePath, JSON.stringify(review, null, 2));
      sendJson(res, 201, {
        ok: true,
        message: "review persisted (append-only)",
        path: `datasets/coach-review/reviews/${review.reviewId}.json`,
      });
    })().catch((error) => sendJson(res, 500, { message: String(error) }));
  };
}
