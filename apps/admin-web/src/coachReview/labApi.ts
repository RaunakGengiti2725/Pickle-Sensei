import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, normalize } from "node:path";
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
import {
  EXPECTED_REGISTRY_SCHEMA_VERSION,
  isEligibleReviewer,
  validateCoachRegistry,
  validateProvisioningAction,
  type ProvisioningAction,
} from "./provisioning";
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

class BodyTooLargeError extends Error {
  constructor(readonly limitBytes: number) {
    super(`request body exceeds the ${limitBytes}-byte limit`);
    this.name = "BodyTooLargeError";
  }
}

/** Buffers the request body up to `limitBytes`. An oversized body is DRAINED
 * (not destroyed) so the client always gets to read the 413 that follows —
 * tearing the socket down mid-upload surfaces as ECONNRESET on the client
 * instead of a status. Draining is capped so a runaway upload still ends. */
function readBody(req: IncomingMessage, limitBytes: number): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const declared = Number(req.headers["content-length"]);
    const drainCapBytes = Math.max(limitBytes * 16, 16_000_000);
    const chunks: Buffer[] = [];
    let total = 0;
    let tooLarge = Number.isFinite(declared) && declared > limitBytes;
    let settled = false;
    const settle = (outcome: () => void): void => {
      if (settled) return;
      settled = true;
      outcome();
    };
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (tooLarge) {
        if (total > drainCapBytes) {
          settle(() => rejectPromise(new BodyTooLargeError(limitBytes)));
          req.destroy();
        }
        return;
      }
      if (total > limitBytes) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () =>
      settle(() =>
        tooLarge
          ? rejectPromise(new BodyTooLargeError(limitBytes))
          : resolvePromise(Buffer.concat(chunks).toString("utf8")),
      ),
    );
    req.on("error", (error) => settle(() => rejectPromise(error)));
  });
}

function isJsonObject(value: unknown): value is object {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type JsonBodyResult<T> = { ok: true; value: T } | { ok: false };

interface InvalidFile {
  file: string;
  message: string;
}

type JsonObjectFileResult<T extends object> =
  { ok: true; value: T } | { ok: false; message: string };

/** Reads one persisted JSON-object record. A failure yields a FIXED phrase
 * (never the parser's or the filesystem's text) so callers can name the file
 * to the client without leaking internals. */
function readJsonObjectFile<T extends object>(path: string): JsonObjectFileResult<T> {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { ok: false, message: "could not be read" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, message: "is not valid JSON" };
  }
  if (!isJsonObject(parsed)) return { ok: false, message: "is not a JSON object" };
  return { ok: true, value: parsed as T };
}

/** Reads and parses a JSON OBJECT body. On any failure the response has
 * already been written (413 too large, 400 malformed / not an object) and
 * `{ ok: false }` is returned so handlers can simply stop. */
async function readJsonBody<T extends object>(
  req: IncomingMessage,
  res: ServerResponse,
  limitBytes: number,
): Promise<JsonBodyResult<T>> {
  let raw: string;
  try {
    raw = await readBody(req, limitBytes);
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      res.setHeader("connection", "close");
      sendJson(res, 413, { message: error.message });
      return { ok: false };
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unparseable";
    sendJson(res, 400, { message: `invalid JSON body: ${detail}` });
    return { ok: false };
  }
  if (!isJsonObject(parsed)) {
    sendJson(res, 400, {
      message: `invalid JSON body: expected an object, got ${
        parsed === null ? "null" : Array.isArray(parsed) ? "an array" : `a ${typeof parsed}`
      }`,
    });
    return { ok: false };
  }
  return { ok: true, value: parsed as T };
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
  const PROVISIONING_LOG_DIR = join(COACH_REVIEW_DIR, "provisioning-log");
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

  /** Repo-relative path of a persisted record file, as shown to clients. */
  function publicPathOf(dir: string, name: string): string {
    return `datasets/coach-review/${basename(dir)}/${name}`;
  }

  /** Reads every `*.json` record in a persisted-record directory. A file that
   * cannot be read, parsed, or is not a JSON object is reported in
   * `invalidFiles` (repo-relative path + fixed phrase — never parser text)
   * instead of failing the whole read, so one damaged file can neither hide
   * every other record nor turn a request into a 500. */
  function readJsonDir<T extends object>(
    dir: string,
  ): { records: Array<{ file: string; record: T }>; invalidFiles: InvalidFile[] } {
    mkdirSync(dir, { recursive: true });
    const records: Array<{ file: string; record: T }> = [];
    const invalidFiles: InvalidFile[] = [];
    for (const name of readdirSync(dir).filter((entry) => entry.endsWith(".json"))) {
      const file = publicPathOf(dir, name);
      const result = readJsonObjectFile<T>(join(dir, name));
      if (result.ok) records.push({ file, record: result.value });
      else invalidFiles.push({ file, message: `${result.message} — skipped` });
    }
    return { records, invalidFiles };
  }

  /** Record files are named `${id}.json` (or `${id}.<suffix>.json` for the
   * revisions/actions of one id), so the damaged history OF ONE ENTITY is the
   * set of invalid files whose name starts with `${id}.`. Write paths whose
   * gating or sequencing depends on that history refuse while it is unreadable
   * (an unrelated damaged file must not block them). */
  function invalidFilesOf(invalidFiles: InvalidFile[], id: string): InvalidFile[] {
    return invalidFiles.filter((entry) => basename(entry.file).startsWith(`${id}.`));
  }

  function listReviews(): {
    reviews: Array<{ file: string; review: CoachReview }>;
    invalidFiles: InvalidFile[];
  } {
    const { records, invalidFiles } = readJsonDir<CoachReview>(REVIEWS_DIR);
    return {
      reviews: records.map((entry) => ({ file: entry.file, review: entry.record })),
      invalidFiles,
    };
  }

  function loadRegistry(): CoachRegistry {
    return JSON.parse(
      readFileSync(join(COACH_REVIEW_DIR, "coaches.json"), "utf8"),
    ) as CoachRegistry;
  }

  /** Shared identity gate: every write path requires a provisioned, active,
   * non-synthetic, QUALIFIED coach (registry v2 entry with a verdict-qualified
   * qualification record) whose credentialRef matches the registry entry. */
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
    if (
      registry.schemaVersion !== EXPECTED_REGISTRY_SCHEMA_VERSION ||
      !isEligibleReviewer(active)
    ) {
      sendJson(res, 403, {
        message:
          "coach is not qualification-verified: production writes require a registry v2 entry with a " +
          "verdict-qualified qualification record under docs/COACH_QUALIFICATION_POLICY.md " +
          "(provisioned via the audited flow — docs/COACHING.md §2).",
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
      const { records, invalidFiles } = readJsonDir<AdjudicationRecord>(ADJUDICATIONS_DIR);
      sendJson(res, 200, { adjudications: records.map((entry) => entry.record), invalidFiles });
      return;
    }
    if (req.method !== "POST") {
      sendJson(res, 405, { message: "method not allowed" });
      return;
    }
    const body = await readJsonBody<AdjudicationRecord>(req, res, 1_000_000);
    if (!body.ok) return;
    const record = body.value;
    if (!gateIdentity(res, record.adjudicatorId, record.adjudicatorCredentialRef)) return;
    const reviews = readJsonDir<CoachReview>(REVIEWS_DIR);
    const reviewerCoachIdsByReviewId: Record<string, string> = {};
    const reviewQueueItemIdsByReviewId: Record<string, string> = {};
    for (const entry of reviews.records) {
      reviewerCoachIdsByReviewId[entry.record.reviewId] = entry.record.coachId;
      reviewQueueItemIdsByReviewId[entry.record.reviewId] = entry.record.queueItemId;
    }
    const problems = validateAdjudication(record, {
      ...loadValidationContext(),
      reviewerCoachIdsByReviewId,
      reviewQueueItemIdsByReviewId,
    });
    // An adjudication weighs EVERY review of its queue item; a damaged review
    // file for that item (or one it names) must be repaired first, not ignored.
    const relevantIds = [
      record.queueItemId,
      ...(Array.isArray(record.reviewedReviewIds) ? record.reviewedReviewIds : []),
    ].filter((id): id is string => typeof id === "string");
    const damagedReviews = new Map(
      relevantIds
        .flatMap((id) => invalidFilesOf(reviews.invalidFiles, id))
        .map((invalid) => [invalid.file, invalid] as const),
    );
    for (const invalid of damagedReviews.values()) {
      problems.push(
        `review file ${invalid.file} ${invalid.message} — repair or remove it before adjudicating ${record.queueItemId}`,
      );
    }
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
      const { records, invalidFiles } = readJsonDir<ReviewAmendment>(AMENDMENTS_DIR);
      sendJson(res, 200, { amendments: records.map((entry) => entry.record), invalidFiles });
      return;
    }
    if (req.method !== "POST") {
      sendJson(res, 405, { message: "method not allowed" });
      return;
    }
    const body = await readJsonBody<ReviewAmendment>(req, res, 1_000_000);
    if (!body.ok) return;
    const amendment = body.value;
    const activeCoach = gateIdentity(
      res,
      amendment.review?.coachId,
      amendment.review?.coachCredentialRef,
    );
    if (!activeCoach) return;
    const snapshot = amendment.review?.provenance?.coachQualificationSnapshot;
    if (
      !snapshot ||
      snapshot.coachId !== activeCoach.coachId ||
      snapshot.credentialRef !== activeCoach.credentialRef ||
      snapshot.provisionedAtIso !== activeCoach.provisionedAtIso ||
      snapshot.provisionedBy !== activeCoach.provisionedBy
    ) {
      sendJson(res, 422, {
        message:
          "provenance.coachQualificationSnapshot must exactly match the provisioned registry entry — qualification metadata cannot be fabricated client-side",
      });
      return;
    }
    const basePath = join(REVIEWS_DIR, `${amendment.reviewId}.json`);
    if (!existsSync(basePath)) {
      sendJson(res, 404, {
        message: `no base review ${amendment.reviewId} — amendments can only version an existing review`,
      });
      return;
    }
    const base = readJsonObjectFile<CoachReview>(basePath);
    if (!base.ok) {
      const file = publicPathOf(REVIEWS_DIR, basename(basePath));
      sendJson(res, 422, {
        message: `base review file ${file} ${base.message} — repair it before amending ${amendment.reviewId}`,
        invalidFiles: [{ file, message: base.message }],
      });
      return;
    }
    if (base.value.coachId !== amendment.review.coachId) {
      sendJson(res, 403, { message: "only the original reviewing coach can amend their review" });
      return;
    }
    const amendments = readJsonDir<ReviewAmendment>(AMENDMENTS_DIR);
    const damagedHistory = invalidFilesOf(amendments.invalidFiles, amendment.reviewId);
    if (damagedHistory.length > 0) {
      sendJson(res, 409, {
        message: `amendment history of ${amendment.reviewId} contains unreadable files — repair or remove them before appending a revision`,
        invalidFiles: damagedHistory,
      });
      return;
    }
    const existing = amendments.records
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
    const body = await readJsonBody<AssignmentEntry>(req, res, 100_000);
    if (!body.ok) return;
    const entry = body.value;
    const registry = loadRegistry();
    const activeCoachIds = registry.coaches
      .filter((coach) => isEligibleReviewer(coach))
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
      const { records, invalidFiles } = readJsonDir<DrillMappingProposal>(DRILL_MAPPINGS_DIR);
      sendJson(res, 200, { proposals: records.map((entry) => entry.record), invalidFiles });
      return;
    }
    if (req.method !== "POST") {
      sendJson(res, 405, { message: "method not allowed" });
      return;
    }
    const body = await readJsonBody<DrillMappingProposal>(req, res, 200_000);
    if (!body.ok) return;
    const proposal = body.value;
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

  async function handleProvisioning(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === "GET") {
      const { records, invalidFiles } = readJsonDir<ProvisioningAction>(PROVISIONING_LOG_DIR);
      sendJson(res, 200, {
        registry: loadRegistry(),
        log: records.map((entry) => entry.record),
        invalidFiles,
      });
      return;
    }
    if (req.method !== "POST") {
      sendJson(res, 405, { message: "method not allowed" });
      return;
    }
    const body = await readJsonBody<ProvisioningAction>(req, res, 500_000);
    if (!body.ok) return;
    const action = body.value;
    const registry = loadRegistry();
    if (registry.schemaVersion !== EXPECTED_REGISTRY_SCHEMA_VERSION) {
      sendJson(res, 409, {
        message: `registry schemaVersion must be ${EXPECTED_REGISTRY_SCHEMA_VERSION} before provisioning (see docs/COACH_QUALIFICATION_POLICY.md)`,
      });
      return;
    }
    const auditLog = readJsonDir<ProvisioningAction>(PROVISIONING_LOG_DIR);
    const damagedHistory =
      typeof action.coachId === "string"
        ? invalidFilesOf(auditLog.invalidFiles, action.coachId)
        : [];
    if (damagedHistory.length > 0) {
      sendJson(res, 409, {
        message: `provisioning audit log of ${action.coachId} contains unreadable files — repair or remove them before appending an action`,
        invalidFiles: damagedHistory,
      });
      return;
    }
    const log = auditLog.records.map((entry) => entry.record);
    const existingSequencesByCoachId: Record<string, number[]> = {};
    for (const record of log) {
      const match = /\.a(\d+)$/.exec(record.actionId);
      if (!match) continue;
      existingSequencesByCoachId[record.coachId] = [
        ...(existingSequencesByCoachId[record.coachId] ?? []),
        Number(match[1]),
      ];
    }
    const problems = validateProvisioningAction(action, {
      existingSequencesByCoachId,
      registryCoachIds: registry.coaches.map((coach) => coach.coachId),
    });
    const existing = registry.coaches.find((coach) => coach.coachId === action.coachId);
    if (action.action === "provision" && existing) {
      problems.push(`coachId ${action.coachId} is already in the registry`);
    }
    if (action.action === "suspend" && existing && existing.status !== "active") {
      problems.push(`coachId ${action.coachId} is not active`);
    }
    if (action.action === "reinstate" && existing && existing.status !== "suspended") {
      problems.push(`coachId ${action.coachId} is not suspended`);
    }
    if (problems.length > 0) {
      sendJson(res, 422, { message: "provisioning action failed validation", problems });
      return;
    }
    // Audit record FIRST (append-only): the trail records who provisioned
    // whom, when, and on what qualification basis, before any state change.
    const auditPath = join(PROVISIONING_LOG_DIR, `${action.actionId}.json`);
    mkdirSync(PROVISIONING_LOG_DIR, { recursive: true });
    if (existsSync(auditPath)) {
      sendJson(res, 409, {
        message: `append-only: provisioning-log/${action.actionId}.json already exists`,
      });
      return;
    }
    const nextRegistry: CoachRegistry = {
      ...registry,
      coaches:
        action.action === "provision"
          ? [...registry.coaches, action.registryEntry!]
          : registry.coaches.map((coach) =>
              coach.coachId === action.coachId
                ? { ...coach, status: action.action === "suspend" ? "suspended" : "active" }
                : coach,
            ),
    };
    const registryProblems = validateCoachRegistry(nextRegistry);
    if (registryProblems.length > 0) {
      sendJson(res, 422, {
        message: "resulting registry would fail v2 validation",
        problems: registryProblems,
      });
      return;
    }
    writeFileSync(auditPath, JSON.stringify(action, null, 2));
    writeFileSync(join(COACH_REVIEW_DIR, "coaches.json"), JSON.stringify(nextRegistry, null, 2));
    sendJson(res, 201, {
      ok: true,
      message: `provisioning action persisted (append-only audit) and registry updated`,
      auditPath: `datasets/coach-review/provisioning-log/${action.actionId}.json`,
      registryPath: "datasets/coach-review/coaches.json",
    });
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
      if (route === "/api/coach-provisioning") {
        await handleProvisioning(req, res);
        return;
      }
      if (route !== "/api/coach-reviews") {
        next();
        return;
      }
      if (req.method === "GET") {
        sendJson(res, 200, listReviews());
        return;
      }
      if (req.method !== "POST") {
        sendJson(res, 405, { message: "method not allowed" });
        return;
      }
      const body = await readJsonBody<CoachReview>(req, res, 1_000_000);
      if (!body.ok) return;
      const review = body.value;
      const activeCoach = gateIdentity(res, review.coachId, review.coachCredentialRef);
      if (!activeCoach) return;
      const snapshot = review.provenance?.coachQualificationSnapshot;
      if (
        !snapshot ||
        snapshot.coachId !== activeCoach.coachId ||
        snapshot.credentialRef !== activeCoach.credentialRef ||
        snapshot.provisionedAtIso !== activeCoach.provisionedAtIso ||
        snapshot.provisionedBy !== activeCoach.provisionedBy
      ) {
        sendJson(res, 422, {
          message:
            "provenance.coachQualificationSnapshot must exactly match the provisioned registry entry — qualification metadata cannot be fabricated client-side",
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
    })().catch((error: unknown) => {
      console.error(`[coach-review-lab] ${req.method ?? ""} ${req.url ?? ""} failed:`, error);
      if (res.headersSent) {
        res.destroy();
        return;
      }
      sendJson(res, 500, {
        message: "internal error while handling the request — see the dev server log for detail",
      });
    });
  };
}
