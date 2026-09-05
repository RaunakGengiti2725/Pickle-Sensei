import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLabApiMiddleware, type LabApiMiddleware } from "../../labApi";
import type { CoachQualification } from "../../provisioning";
import { syntheticAgreeingPair } from "../../syntheticFixtures";
import type { CoachReview } from "../../types";
import type { Outcome } from "./faultCatalog";
import { createResultsTable, flushResultsTable, recordResult } from "./resultsTable";
import { campaignSeeds, makeRng, STRESS_DISABLED_HINT, stressEnabled, type Rng } from "./seededRng";

/**
 * STRESS / failure-injection — Coach Review Lab DEV API (src/coachReview/labApi.ts,
 * the exact middleware vite.config.ts mounts), against THROWAWAY repo roots.
 *
 * Dependencies attacked: the filesystem the middleware persists to and reads
 * from (missing / malformed / empty / null / array / wrong-shape / directory /
 * unreadable / truncated / read-only), the request body (invalid, empty,
 * truncated, `null`, scalar, oversized, slow trickle, aborted mid-body, wrong
 * content type) and the URL/method (malformed escapes, traversal, bad Range,
 * wrong verbs). Invariants per fault:
 *   - a response arrives within 5 s (never a hung socket);
 *   - the process does not crash (no uncaught exception / unhandled rejection);
 *   - a failing request writes NOTHING under datasets/ (tree hash unchanged);
 *   - once the fault is removed the same request succeeds (recoverable);
 *   - append-only + registry state stay mutually consistent.
 *
 * Scenario(seed) = CELLS[seed % CELLS.length]; RNG(seed) drives payload details
 * (truncation points, chunk timing). STRESS_ITER (default 30) / STRESS_SEEDS.
 * Permission faults need a non-root user (root ignores mode bits).
 */

const REAL_REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../..");
const RESPONSE_TIMEOUT_MS = 5_000;
const IS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;

const COACHES = [
  { coachId: "stress-test-coach-a", credentialRef: "stress-test-cred-a" },
  { coachId: "stress-test-coach-b", credentialRef: "stress-test-cred-b" },
];

function qualification(): CoachQualification {
  return {
    policyVersion: "coach-qualification-policy-v1",
    satisfiedCriteria: ["criterion.professional-coaching-history"],
    verdict: "qualified",
    assessedBy: "stress-harness",
    assessedAtIso: "2026-08-29T00:00:00.000Z",
    certifications: [],
    professionalCoachingHistory: {
      statement: "TEST-ONLY fixture claim (throwaway root, not a real coach)",
      verification: {
        method: "document_reviewed",
        verifiedBy: "stress-harness",
        verifiedAtIso: "2026-08-29T00:00:00.000Z",
        evidenceRef: "test-evidence-nonexistent",
      },
    },
    competitiveBackground: null,
    affiliation: null,
    yearsCoaching: null,
    specialties: [],
  };
}

function registryJson(): string {
  return JSON.stringify({
    schemaVersion: 2,
    note: "TEST-ONLY throwaway registry for the failure-injection stress harness.",
    qualificationPolicy: {
      version: "coach-qualification-policy-v1",
      document: "docs/COACH_QUALIFICATION_POLICY.md",
    },
    coaches: COACHES.map((coach) => ({
      ...coach,
      status: "active",
      provisionedAtIso: "2026-08-29T00:00:00.000Z",
      provisionedBy: "stress-harness",
      qualification: qualification(),
    })),
  });
}

function validReview(coachIndex: number, queueItemId = "wm-dink-01-E1"): CoachReview {
  const [fixture] = syntheticAgreeingPair();
  const coach = COACHES[coachIndex]!;
  const caseId = queueItemId.replace(/-E\d+$/, "");
  const eventIndex = Number(/-E(\d+)$/.exec(queueItemId)![1]) - 1;
  return {
    ...fixture!,
    coachId: coach.coachId,
    coachCredentialRef: coach.credentialRef,
    queueItemId,
    eventRef: { caseId, eventIndex },
    reviewId: `${queueItemId}.${coach.coachId}`,
    provenance: {
      ...fixture!.provenance,
      coachQualificationSnapshot: {
        ...fixture!.provenance.coachQualificationSnapshot,
        coachId: coach.coachId,
        credentialRef: coach.credentialRef,
        provisionedAtIso: "2026-08-29T00:00:00.000Z",
        provisionedBy: "stress-harness",
      },
    },
  };
}

function validAssignment(): string {
  return JSON.stringify({
    queueItemId: "wm-dink-01-E1",
    coachIds: [COACHES[0]!.coachId],
    assignedAtIso: "2026-08-29T00:00:00.000Z",
    assignedBy: "stress-harness-admin",
  });
}

function validProvisioning(coachId: string): string {
  return JSON.stringify({
    schemaVersion: 1,
    actionId: `${coachId}.a1`,
    action: "provision",
    coachId,
    performedBy: "stress-harness-admin",
    performedAtIso: "2026-08-29T00:00:00.000Z",
    reason: "TEST-ONLY provisioning inside throwaway root",
    registryEntry: {
      coachId,
      credentialRef: `${coachId}-cred`,
      status: "active",
      provisionedAtIso: "2026-08-29T00:00:00.000Z",
      provisionedBy: "stress-harness-admin",
      qualification: qualification(),
    },
  });
}

// ---------------------------------------------------------------------------
// Throwaway root + tree hashing (the "no corrupted persisted state" oracle)
// ---------------------------------------------------------------------------

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "stress-labapi-"));
  const dir = join(root, "datasets/coach-review");
  mkdirSync(dir, { recursive: true });
  for (const name of ["queue.json", "schema.json"]) {
    cpSync(join(REAL_REPO_ROOT, "datasets/coach-review", name), join(dir, name));
  }
  cpSync(join(REAL_REPO_ROOT, "datasets/coach-review/taxonomy"), join(dir, "taxonomy"), {
    recursive: true,
  });
  cpSync(join(REAL_REPO_ROOT, "datasets/coach-review/drills"), join(dir, "drills"), {
    recursive: true,
  });
  writeFileSync(join(dir, "coaches.json"), registryJson());
  mkdirSync(join(dir, "reviews"));
  // One committed review by coach B so read paths have something to parse.
  const seeded = validReview(1, "wm-volley-02-E2");
  writeFileSync(join(dir, "reviews", `${seeded.reviewId}.json`), JSON.stringify(seeded, null, 2));
  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, "docs/COACHING.md"), "# COACHING (stress fixture)\n");
  return root;
}

type TreeSnapshot = Map<string, string>;

function snapshotTree(root: string): TreeSnapshot {
  const out: TreeSnapshot = new Map();
  const walk = (dir: string) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      out.set(`${relative(root, dir)}/`, "unreadable-dir");
      return;
    }
    for (const name of names) {
      const full = join(dir, name);
      let isDirectory = false;
      try {
        isDirectory = statSync(full).isDirectory();
      } catch {
        out.set(relative(root, full), "unstattable");
        continue;
      }
      if (isDirectory) {
        walk(full);
        continue;
      }
      try {
        out.set(relative(root, full), createHash("sha1").update(readFileSync(full)).digest("hex"));
      } catch {
        out.set(relative(root, full), "unreadable");
      }
    }
  };
  walk(root);
  return out;
}

function treeDiff(before: TreeSnapshot, after: TreeSnapshot): string[] {
  const changes: string[] = [];
  for (const [path, hash] of after) {
    const previous = before.get(path);
    if (previous === undefined) changes.push(`+${path}`);
    else if (previous !== hash) changes.push(`~${path}`);
  }
  for (const path of before.keys()) if (!after.has(path)) changes.push(`-${path}`);
  return changes.sort();
}

// ---------------------------------------------------------------------------
// HTTP client with timeout + streaming/aborting bodies
// ---------------------------------------------------------------------------

interface HttpResult {
  kind: "response";
  status: number;
  body: string;
  headers: Record<string, string>;
}
type WireResult =
  | HttpResult
  | { kind: "timeout" }
  | { kind: "client-error"; error: string }
  | { kind: "aborted-by-client" };

interface WireRequest {
  method: string;
  path: string;
  headers?: Record<string, string>;
  /** Static body, or chunks with delays (trickle), or abort after N chunks. */
  body?: string;
  chunks?: Array<{ data: string; delayMs: number }>;
  abortAfterChunks?: number;
}

function sendRaw(baseUrl: string, spec: WireRequest): Promise<WireResult> {
  return new Promise((resolvePromise) => {
    // The path is sent RAW (no URL normalisation) so `..` and `%2e%2e` reach the middleware.
    const base = new URL(baseUrl);
    const req = httpRequest(
      {
        host: base.hostname,
        port: base.port,
        path: spec.path,
        method: spec.method,
        headers: { "content-type": "application/json", ...(spec.headers ?? {}) },
      },
      (res) => {
        const parts: Buffer[] = [];
        res.on("data", (chunk: Buffer) => parts.push(chunk));
        res.on("end", () => {
          clearTimeout(timer);
          const headers: Record<string, string> = {};
          for (const [key, value] of Object.entries(res.headers)) {
            if (typeof value === "string") headers[key] = value;
          }
          resolvePromise({
            kind: "response",
            status: res.statusCode ?? 0,
            body: Buffer.concat(parts).toString("utf8"),
            headers,
          });
        });
        res.on("error", (error) => {
          clearTimeout(timer);
          resolvePromise({ kind: "client-error", error: String(error) });
        });
      },
    );
    let settledByAbort = false;
    const timer = setTimeout(() => {
      req.destroy();
      resolvePromise({ kind: "timeout" });
    }, RESPONSE_TIMEOUT_MS);
    req.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (settledByAbort) return;
      resolvePromise({
        kind: "client-error",
        error: `${error.code ?? error.name}: ${error.message}`,
      });
    });
    if (spec.chunks) {
      const chunks = spec.chunks;
      let index = 0;
      const pump = () => {
        if (spec.abortAfterChunks !== undefined && index >= spec.abortAfterChunks) {
          settledByAbort = true;
          clearTimeout(timer);
          req.destroy();
          resolvePromise({ kind: "aborted-by-client" });
          return;
        }
        if (index >= chunks.length) {
          req.end();
          return;
        }
        const chunk = chunks[index]!;
        index += 1;
        setTimeout(() => {
          req.write(chunk.data);
          pump();
        }, chunk.delayMs);
      };
      pump();
    } else {
      req.end(spec.body ?? "");
    }
  });
}

// ---------------------------------------------------------------------------
// Crash capture: the middleware pipes fs streams straight into the response, so
// an fs error on the stream surfaces as a process-level uncaught exception.
// ---------------------------------------------------------------------------

interface ProcessFaults {
  uncaught: string[];
  unhandled: string[];
}

async function withProcessFaultCapture<T>(
  run: () => Promise<T>,
): Promise<{ value: T; faults: ProcessFaults }> {
  const faults: ProcessFaults = { uncaught: [], unhandled: [] };
  const savedUncaught = process.listeners("uncaughtException");
  const savedUnhandled = process.listeners("unhandledRejection");
  process.removeAllListeners("uncaughtException");
  process.removeAllListeners("unhandledRejection");
  const onUncaught = (error: Error) =>
    faults.uncaught.push(
      `${(error as NodeJS.ErrnoException).code ?? error.name}: ${error.message}`,
    );
  const onUnhandled = (reason: unknown) => faults.unhandled.push(String(reason));
  process.on("uncaughtException", onUncaught);
  process.on("unhandledRejection", onUnhandled);
  try {
    const value = await run();
    // Stream errors are emitted on a later tick than the response end.
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 30));
    return { value, faults };
  } finally {
    process.off("uncaughtException", onUncaught);
    process.off("unhandledRejection", onUnhandled);
    for (const listener of savedUncaught) process.on("uncaughtException", listener);
    for (const listener of savedUnhandled) process.on("unhandledRejection", listener);
  }
}

// ---------------------------------------------------------------------------
// Fault cells
// ---------------------------------------------------------------------------

type FileMode =
  | "missing"
  | "malformed"
  | "empty"
  | "null"
  | "array"
  | "wrong-shape"
  | "directory"
  | "unreadable"
  | "truncated";

const FILE_MODES: FileMode[] = [
  "missing",
  "malformed",
  "empty",
  "null",
  "array",
  "wrong-shape",
  "directory",
  "unreadable",
  "truncated",
];

function applyFileFault(path: string, mode: FileMode, rng: Rng): void {
  const original = existsSync(path) && statSync(path).isFile() ? readFileSync(path, "utf8") : "{}";
  rmSync(path, { recursive: true, force: true });
  switch (mode) {
    case "missing":
      return;
    case "malformed":
      writeFileSync(
        path,
        rng.pick(["{not json", '{"a":1,}', "<html>", "\u0000\u0001", "{'single': 'quotes'}"]),
      );
      return;
    case "empty":
      writeFileSync(path, "");
      return;
    case "null":
      writeFileSync(path, "null");
      return;
    case "array":
      writeFileSync(path, "[]");
      return;
    case "wrong-shape":
      writeFileSync(path, rng.pick(["{}", '{"schemaVersion":"x"}', "42", '"string"']));
      return;
    case "directory":
      mkdirSync(path, { recursive: true });
      return;
    case "unreadable":
      writeFileSync(path, original);
      chmodSync(path, 0o000);
      return;
    case "truncated":
      writeFileSync(
        path,
        original.slice(0, Math.max(1, Math.floor(original.length * (0.2 + rng.float() * 0.7)))),
      );
      return;
  }
}

type ConsumerId =
  | "postReview"
  | "postAssignment"
  | "getStatic"
  | "getProvisioning"
  | "getReviews"
  | "getAssignments"
  | "postAdjudication"
  | "getReviewsProbe";

interface Consumer {
  id: ConsumerId;
  request: (root: string) => WireRequest;
  /** Status the request yields with no fault injected (recovery oracle). */
  healthyStatus: number;
  writes: boolean;
}

const CONSUMERS: Record<ConsumerId, Consumer> = {
  postReview: {
    id: "postReview",
    request: () => ({
      method: "POST",
      path: "/api/coach-reviews",
      body: JSON.stringify(validReview(0)),
    }),
    healthyStatus: 201,
    writes: true,
  },
  postAssignment: {
    id: "postAssignment",
    request: () => ({ method: "POST", path: "/api/coach-assignments", body: validAssignment() }),
    healthyStatus: 201,
    writes: true,
  },
  getStatic: {
    id: "getStatic",
    request: () => ({ method: "GET", path: "/datasets/coach-review/queue.json" }),
    healthyStatus: 200,
    writes: false,
  },
  getProvisioning: {
    id: "getProvisioning",
    request: () => ({ method: "GET", path: "/api/coach-provisioning" }),
    healthyStatus: 200,
    writes: false,
  },
  getReviews: {
    id: "getReviews",
    request: () => ({ method: "GET", path: "/api/coach-reviews" }),
    healthyStatus: 200,
    writes: false,
  },
  getAssignments: {
    id: "getAssignments",
    request: () => ({ method: "GET", path: "/api/coach-assignments" }),
    healthyStatus: 200,
    writes: false,
  },
  postAdjudication: {
    id: "postAdjudication",
    request: () => ({
      method: "POST",
      path: "/api/coach-adjudications",
      body: JSON.stringify({
        schemaVersion: 1,
        queueItemId: "wm-volley-02-E2",
        adjudicatorId: COACHES[0]!.coachId,
        adjudicatorCredentialRef: COACHES[0]!.credentialRef,
        reviewedReviewIds: [`wm-volley-02-E2.${COACHES[1]!.coachId}`],
        outcome: {
          kind: "unresolvable",
          reason: "stress fixture — single review cannot be adjudicated",
        },
        rationale: "stress harness adjudication rationale, long enough for the validator",
        evidenceTimestampsMs: [],
        createdAtIso: "2026-08-29T00:00:00.000Z",
      }),
    }),
    healthyStatus: 422,
    writes: false,
  },
  getReviewsProbe: {
    id: "getReviewsProbe",
    request: () => ({ method: "GET", path: "/api/coach-reviews" }),
    healthyStatus: 200,
    writes: false,
  },
};

interface Cell {
  name: string;
  family: "fs" | "fs-perm" | "body" | "url";
  /** Mutates the throwaway root; returns a cleanup that removes the fault. */
  inject: (root: string, rng: Rng) => () => void;
  request: (root: string, rng: Rng) => WireRequest;
  /** Request that must succeed after the fault is removed (null = GET probe only). */
  recovery: Consumer | null;
  /** Files the FAULTED request is allowed to change (relative to root). */
  allowedWrites: string[];
  /** Expected wire status class when faulted (checked loosely; hangs/crashes always fail). */
  expect: (result: WireResult) => string | null;
}

const RELATIVE_FILES: Record<string, string> = {
  queue: "datasets/coach-review/queue.json",
  schema: "datasets/coach-review/schema.json",
  taxonomy: "datasets/coach-review/taxonomy/fault-taxonomy.v0-draft.json",
  drills: "datasets/coach-review/drills/drill-library.v0.json",
  coaches: "datasets/coach-review/coaches.json",
  assignments: "datasets/coach-review/assignments.json",
  seededReview: `datasets/coach-review/reviews/wm-volley-02-E2.${COACHES[1]!.coachId}.json`,
};

const FILE_CONSUMERS: Record<string, ConsumerId[]> = {
  queue: ["postReview", "postAssignment", "getStatic"],
  schema: ["postReview"],
  taxonomy: ["postReview"],
  drills: ["postReview"],
  coaches: ["postReview", "getProvisioning", "postAssignment"],
  assignments: ["getAssignments", "postAssignment"],
  seededReview: ["getReviews", "postAdjudication"],
};

function isVisibleFailure(result: WireResult): string | null {
  if (result.kind === "timeout") return "no response within 5s";
  if (result.kind === "client-error") return `client error: ${result.error}`;
  if (result.kind === "aborted-by-client") return null;
  if (result.status < 400)
    return `unexpected success HTTP ${result.status} while dependency is broken`;
  if (!result.headers["content-type"]?.includes("application/json"))
    return `error without JSON body (HTTP ${result.status})`;
  try {
    const parsed = JSON.parse(result.body) as { message?: unknown };
    if (typeof parsed.message !== "string" || parsed.message === "")
      return `error JSON without message (HTTP ${result.status})`;
  } catch {
    return `error body is not JSON (HTTP ${result.status})`;
  }
  return null;
}

function restoreFile(root: string, relativePath: string, content: string): () => void {
  return () => {
    const path = join(root, relativePath);
    rmSync(path, { recursive: true, force: true });
    if (content !== "") {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
    }
  };
}

function fsCells(): Cell[] {
  const cells: Cell[] = [];
  for (const [key, relativePath] of Object.entries(RELATIVE_FILES)) {
    for (const mode of FILE_MODES) {
      for (const consumerId of FILE_CONSUMERS[key]!) {
        const consumer = CONSUMERS[consumerId];
        const staticServe = consumerId === "getStatic";
        cells.push({
          name: `fs:${key}:${mode}:${consumerId}`,
          family: mode === "unreadable" ? "fs-perm" : "fs",
          inject: (root, rng) => {
            const path = join(root, relativePath);
            const original =
              existsSync(path) && statSync(path).isFile() ? readFileSync(path, "utf8") : "";
            applyFileFault(path, mode, rng);
            const restore = restoreFile(root, relativePath, original);
            return () => {
              if (existsSync(path) && statSync(path).isFile()) {
                try {
                  chmodSync(path, 0o644);
                } catch {
                  /* directory or gone */
                }
              }
              restore();
            };
          },
          request: (root) => consumer.request(root),
          recovery: consumer,
          allowedWrites:
            key === "assignments" && mode === "missing" && consumer.writes
              ? [RELATIVE_FILES["assignments"]!]
              : [],
          expect: (result) => {
            if (key === "assignments" && mode === "missing") {
              // assignments.json is optional: absence is the empty file, so both consumers succeed.
              return result.kind === "response" && result.status < 300
                ? null
                : `expected success, got ${JSON.stringify(result).slice(0, 120)}`;
            }
            if (key === "seededReview" && mode === "missing") {
              // A review file that is simply absent is a legitimate state (0 or fewer reviews).
              return result.kind === "response" && result.status < 500
                ? null
                : `expected a normal verdict, got ${JSON.stringify(result).slice(0, 120)}`;
            }
            if (staticServe) {
              // Static serving is byte-transparent: content faults are the client's problem; only
              // missing/directory (404) and unreadable (must not crash) matter here.
              if (mode === "missing" || mode === "directory") {
                return result.kind === "response" && result.status === 404
                  ? null
                  : `expected 404, got ${JSON.stringify(result).slice(0, 120)}`;
              }
              if (mode === "unreadable") return isVisibleFailure(result);
              return result.kind === "response" && result.status === 200
                ? null
                : `expected 200 passthrough, got ${JSON.stringify(result).slice(0, 120)}`;
            }
            return isVisibleFailure(result);
          },
        });
      }
    }
  }
  return cells;
}

function fsStructureCells(): Cell[] {
  const reviewsDir = "datasets/coach-review/reviews";
  const cells: Cell[] = [
    {
      name: "fs:reviews-dir-is-a-file:getReviews",
      family: "fs",
      inject: (root) => {
        const path = join(root, reviewsDir);
        const backup = join(root, "reviews.bak");
        cpSync(path, backup, { recursive: true });
        rmSync(path, { recursive: true, force: true });
        writeFileSync(path, "not a directory");
        return () => {
          rmSync(path, { recursive: true, force: true });
          cpSync(backup, path, { recursive: true });
          rmSync(backup, { recursive: true, force: true });
        };
      },
      request: () => CONSUMERS.getReviews.request(""),
      recovery: CONSUMERS.getReviews,
      allowedWrites: [],
      expect: isVisibleFailure,
    },
    {
      name: "fs:reviews-dir-is-a-file:postReview",
      family: "fs",
      inject: (root) => {
        const path = join(root, reviewsDir);
        const backup = join(root, "reviews.bak");
        cpSync(path, backup, { recursive: true });
        rmSync(path, { recursive: true, force: true });
        writeFileSync(path, "not a directory");
        return () => {
          rmSync(path, { recursive: true, force: true });
          cpSync(backup, path, { recursive: true });
          rmSync(backup, { recursive: true, force: true });
        };
      },
      request: () => CONSUMERS.postReview.request(""),
      recovery: CONSUMERS.postReview,
      allowedWrites: [],
      expect: isVisibleFailure,
    },
    {
      name: "fs-perm:reviews-dir-read-only:postReview",
      family: "fs-perm",
      inject: (root) => {
        const path = join(root, reviewsDir);
        chmodSync(path, 0o555);
        return () => chmodSync(path, 0o755);
      },
      request: () => CONSUMERS.postReview.request(""),
      recovery: CONSUMERS.postReview,
      allowedWrites: [],
      expect: isVisibleFailure,
    },
    {
      name: "fs-perm:coaches-read-only:postAssignment",
      family: "fs-perm",
      inject: (root) => {
        // assignments.json is created next to coaches.json; make the directory unwritable.
        const dir = join(root, "datasets/coach-review");
        chmodSync(dir, 0o555);
        return () => chmodSync(dir, 0o755);
      },
      request: () => CONSUMERS.postAssignment.request(""),
      recovery: CONSUMERS.postAssignment,
      allowedWrites: [],
      expect: isVisibleFailure,
    },
    {
      name: "fs-perm:registry-read-only:postProvisioning",
      family: "fs-perm",
      inject: (root) => {
        const path = join(root, RELATIVE_FILES["coaches"]!);
        chmodSync(path, 0o444);
        return () => chmodSync(path, 0o644);
      },
      request: () => ({
        method: "POST",
        path: "/api/coach-provisioning",
        body: validProvisioning("stress-test-coach-c"),
      }),
      recovery: {
        id: "getProvisioning",
        request: () => ({
          method: "POST",
          path: "/api/coach-provisioning",
          body: validProvisioning("stress-test-coach-c"),
        }),
        healthyStatus: 201,
        writes: true,
      },
      allowedWrites: [],
      expect: isVisibleFailure,
    },
  ];
  return cells;
}

type BodyMode =
  | "invalid-json"
  | "empty"
  | "truncated"
  | "null"
  | "number"
  | "string"
  | "array"
  | "empty-object"
  | "oversized"
  | "trickle-slow"
  | "abort-mid-body"
  | "text-content-type";

const BODY_MODES: BodyMode[] = [
  "invalid-json",
  "empty",
  "truncated",
  "null",
  "number",
  "string",
  "array",
  "empty-object",
  "oversized",
  "trickle-slow",
  "abort-mid-body",
  "text-content-type",
];

const POST_ROUTES: Array<{ path: string; limit: number; valid: () => string; recovery: Consumer }> =
  [
    {
      path: "/api/coach-reviews",
      limit: 1_000_000,
      valid: () => JSON.stringify(validReview(0)),
      recovery: CONSUMERS.postReview,
    },
    {
      path: "/api/coach-adjudications",
      limit: 1_000_000,
      valid: () => CONSUMERS.postAdjudication.request("").body!,
      recovery: CONSUMERS.postAdjudication,
    },
    {
      path: "/api/coach-review-amendments",
      limit: 1_000_000,
      valid: () =>
        JSON.stringify({
          schemaVersion: 1,
          amendmentId: "stress.a1",
          reviewId: `wm-volley-02-E2.${COACHES[1]!.coachId}`,
          revision: 2,
          reason: "stress harness amendment reason",
          createdAtIso: "2026-08-29T00:00:00.000Z",
          review: validReview(1, "wm-volley-02-E2"),
        }),
      recovery: CONSUMERS.getReviewsProbe,
    },
    {
      path: "/api/coach-assignments",
      limit: 100_000,
      valid: validAssignment,
      recovery: CONSUMERS.postAssignment,
    },
    {
      path: "/api/drill-mapping-proposals",
      limit: 200_000,
      valid: () =>
        JSON.stringify({
          schemaVersion: 1,
          proposalId: "stress.p1",
          coachId: COACHES[0]!.coachId,
          coachCredentialRef: COACHES[0]!.credentialRef,
          faultId: "global.late_prep",
          drillId: "drill.shadow_dink",
          evidence: [],
          rationale: "stress harness mapping rationale long enough",
          createdAtIso: "2026-08-29T00:00:00.000Z",
        }),
      recovery: CONSUMERS.getReviewsProbe,
    },
    {
      path: "/api/coach-provisioning",
      limit: 500_000,
      valid: () => validProvisioning("stress-test-coach-c"),
      recovery: CONSUMERS.getProvisioning,
    },
  ];

function bodyCells(): Cell[] {
  const cells: Cell[] = [];
  for (const route of POST_ROUTES) {
    for (const mode of BODY_MODES) {
      cells.push({
        name: `body:${route.path}:${mode}`,
        family: "body",
        inject: () => () => undefined,
        request: (_root, rng) => {
          const valid = route.valid();
          switch (mode) {
            case "invalid-json":
              return {
                method: "POST",
                path: route.path,
                body: rng.pick(["{not json", valid + "}", '{"a":}', "\u0000"]),
              };
            case "empty":
              return { method: "POST", path: route.path, body: "" };
            case "truncated":
              return {
                method: "POST",
                path: route.path,
                body: valid.slice(0, Math.floor(valid.length * (0.1 + rng.float() * 0.8))),
              };
            case "null":
              return { method: "POST", path: route.path, body: "null" };
            case "number":
              return { method: "POST", path: route.path, body: String(rng.int(-5, 99999)) };
            case "string":
              return {
                method: "POST",
                path: route.path,
                body: JSON.stringify("payload-as-string"),
              };
            case "array":
              return {
                method: "POST",
                path: route.path,
                body: rng.pick(["[]", "[1,2,3]", `[${valid}]`]),
              };
            case "empty-object":
              return { method: "POST", path: route.path, body: "{}" };
            case "oversized":
              return {
                method: "POST",
                path: route.path,
                body: `{"pad":"${"x".repeat(route.limit + 1024)}"}`,
              };
            case "trickle-slow": {
              const parts = 4;
              const size = Math.ceil(valid.length / parts);
              return {
                method: "POST",
                path: route.path,
                chunks: Array.from({ length: parts }, (_, index) => ({
                  data: valid.slice(index * size, (index + 1) * size),
                  delayMs: rng.int(150, 450),
                })),
              };
            }
            case "abort-mid-body": {
              const size = Math.ceil(valid.length / 3);
              return {
                method: "POST",
                path: route.path,
                chunks: [
                  { data: valid.slice(0, size), delayMs: 20 },
                  { data: valid.slice(size, 2 * size), delayMs: 20 },
                  { data: valid.slice(2 * size), delayMs: 20 },
                ],
                abortAfterChunks: rng.int(1, 2),
              };
            }
            case "text-content-type":
              return {
                method: "POST",
                path: route.path,
                headers: { "content-type": "text/plain" },
                body: valid,
              };
          }
        },
        recovery: route.recovery,
        // trickle-slow / text-content-type deliver the VALID payload oddly — persisting it is correct.
        allowedWrites: mode === "trickle-slow" || mode === "text-content-type" ? ["*"] : [],
        expect: (result) => {
          if (mode === "trickle-slow" || mode === "text-content-type") {
            // Valid payload delivered oddly: server must answer with its normal verdict (2xx/4xx), not hang.
            if (result.kind !== "response")
              return `expected a normal response, got ${JSON.stringify(result)}`;
            return result.status >= 500
              ? `HTTP ${result.status} for a valid body: ${result.body.slice(0, 120)}`
              : null;
          }
          if (mode === "abort-mid-body")
            return result.kind === "aborted-by-client"
              ? null
              : `expected client abort, got ${JSON.stringify(result).slice(0, 120)}`;
          if (mode === "oversized") {
            // Either a 400 or a reset socket (server destroys the request) is a visible refusal.
            if (result.kind === "client-error") return null;
            if (result.kind === "response" && result.status >= 400 && result.status < 500)
              return null;
            return `oversized body: ${JSON.stringify(result).slice(0, 120)}`;
          }
          if (mode === "array") {
            // `[valid]` is not a record → must fail; `[]` must fail; never 5xx.
            if (result.kind !== "response")
              return `expected a response, got ${JSON.stringify(result)}`;
            return result.status >= 400 && result.status < 500
              ? null
              : `array body → HTTP ${result.status}: ${result.body.slice(0, 120)}`;
          }
          if (result.kind !== "response")
            return `expected a 4xx response, got ${JSON.stringify(result)}`;
          if (result.status < 400) return `bad body accepted with HTTP ${result.status}`;
          return isVisibleFailure(result);
        },
      });
    }
  }
  return cells;
}

function urlCells(): Cell[] {
  const get = (path: string, headers?: Record<string, string>): WireRequest =>
    headers ? { method: "GET", path, headers } : { method: "GET", path };
  const statusIs = (allowed: number[]) => (result: WireResult) =>
    result.kind === "response" && allowed.includes(result.status)
      ? null
      : `expected HTTP ${allowed.join("/")}, got ${JSON.stringify(result).slice(0, 160)}`;
  const cells: Cell[] = [
    // A URIError on a bad escape is answered 500 (visible JSON) — accepted with a note, ideally 400.
    {
      name: "url:malformed-percent-escape",
      family: "url",
      inject: () => () => undefined,
      request: () => get("/datasets/coach-review/%E0%A4%A"),
      recovery: CONSUMERS.getStatic,
      allowedWrites: [],
      expect: statusIs([400, 404, 500]),
    },
    {
      name: "url:path-traversal-dotdot",
      family: "url",
      inject: () => () => undefined,
      request: () => get("/datasets/../package.json"),
      recovery: CONSUMERS.getStatic,
      allowedWrites: [],
      expect: statusIs([404]),
    },
    {
      name: "url:path-traversal-encoded",
      family: "url",
      inject: () => () => undefined,
      request: () => get("/datasets/%2e%2e/package.json"),
      recovery: CONSUMERS.getStatic,
      allowedWrites: [],
      expect: statusIs([404]),
    },
    {
      name: "url:path-traversal-into-docs",
      family: "url",
      inject: () => () => undefined,
      request: () => get("/datasets/../docs/COACHING.md"),
      recovery: CONSUMERS.getStatic,
      allowedWrites: [],
      expect: statusIs([200, 404]),
    },
    {
      name: "url:directory-not-file",
      family: "url",
      inject: () => () => undefined,
      request: () => get("/datasets/coach-review"),
      recovery: CONSUMERS.getStatic,
      allowedWrites: [],
      expect: statusIs([404]),
    },
    {
      name: "url:range-non-numeric",
      family: "url",
      inject: () => () => undefined,
      request: () => get("/datasets/coach-review/queue.json", { range: "bytes=abc-def" }),
      recovery: CONSUMERS.getStatic,
      allowedWrites: [],
      expect: statusIs([200, 206, 416]),
    },
    {
      name: "url:range-reversed",
      family: "url",
      inject: () => () => undefined,
      request: () => get("/datasets/coach-review/queue.json", { range: "bytes=50-10" }),
      recovery: CONSUMERS.getStatic,
      allowedWrites: [],
      expect: statusIs([416]),
    },
    {
      name: "url:range-past-end",
      family: "url",
      inject: () => () => undefined,
      request: () => get("/datasets/coach-review/queue.json", { range: "bytes=99999999-" }),
      recovery: CONSUMERS.getStatic,
      allowedWrites: [],
      expect: statusIs([416]),
    },
    {
      name: "url:range-suffix-only",
      family: "url",
      inject: () => () => undefined,
      request: () => get("/datasets/coach-review/queue.json", { range: "bytes=-100" }),
      recovery: CONSUMERS.getStatic,
      allowedWrites: [],
      expect: statusIs([200, 206]),
    },
    {
      name: "url:range-multi",
      family: "url",
      inject: () => () => undefined,
      request: () => get("/datasets/coach-review/queue.json", { range: "bytes=0-10,20-30" }),
      recovery: CONSUMERS.getStatic,
      allowedWrites: [],
      expect: statusIs([200, 206, 416]),
    },
    {
      name: "url:put-on-api-route",
      family: "url",
      inject: () => () => undefined,
      request: () => ({ method: "PUT", path: "/api/coach-reviews", body: "{}" }),
      recovery: CONSUMERS.getReviews,
      allowedWrites: [],
      expect: statusIs([405]),
    },
    {
      name: "url:delete-on-api-route",
      family: "url",
      inject: () => () => undefined,
      request: () => ({ method: "DELETE", path: "/api/coach-provisioning" }),
      recovery: CONSUMERS.getProvisioning,
      allowedWrites: [],
      expect: statusIs([405]),
    },
    {
      name: "url:api-route-with-query",
      family: "url",
      inject: () => () => undefined,
      request: () => get("/api/coach-reviews?x=%zz"),
      recovery: CONSUMERS.getReviews,
      allowedWrites: [],
      expect: statusIs([200]),
    },
  ];
  return cells;
}

const CELLS: Cell[] = [...fsCells(), ...fsStructureCells(), ...bodyCells(), ...urlCells()];

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const table = createResultsTable("admin-web labApi filesystem/body/url failure-injection (vitest)");
const seeds = campaignSeeds(process.env, 30);
const enabled = stressEnabled(process.env);

let server: Server;
let baseUrl: string;
let currentMiddleware: LabApiMiddleware | null = null;

it.skipIf(enabled)(`labApi failure injection — ${STRESS_DISABLED_HINT}`, () => undefined);

beforeAll(async () => {
  if (!enabled) return;
  server = createServer((req, res) => {
    if (!currentMiddleware) {
      res.writeHead(503);
      res.end("no root mounted");
      return;
    }
    currentMiddleware(req, res, () => {
      res.writeHead(404);
      res.end("fell through");
    });
  });
  await new Promise<void>((resolvePromise) =>
    server.listen(0, "127.0.0.1", () => resolvePromise()),
  );
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  if (!enabled) return;
  // Requests the middleware never answered (see BROKEN_NO_RESPONSE) would otherwise keep
  // server.close() waiting forever.
  server.closeAllConnections();
  await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  const path = flushResultsTable(table, "labapi-fs-body-url.json");

  console.warn(
    `[stress:labApi] executed=${table.executed} held=${table.byOutcome.HELD} failing=${table.failingSeeds.length} → ${path}`,
  );
});

interface Verdict {
  outcome: Outcome;
  observed: string;
  notes: string[];
}

async function runCell(cell: Cell, seed: number): Promise<Verdict> {
  if (cell.family === "fs-perm" && IS_ROOT) {
    return {
      outcome: "HARNESS_ERROR",
      observed: "permission faults need a non-root user",
      notes: [],
    };
  }
  const rng = makeRng(seed);
  const root = makeRoot();
  currentMiddleware = createLabApiMiddleware(root);
  const notes: string[] = [];
  try {
    const before = snapshotTree(root);
    const cleanup = cell.inject(root, rng);
    const injected = snapshotTree(root);
    const spec = cell.request(root, rng);
    const { value: faulted, faults } = await withProcessFaultCapture(() => sendRaw(baseUrl, spec));
    const afterFault = snapshotTree(root);
    cleanup();
    const afterCleanup = snapshotTree(root);

    if (faults.uncaught.length > 0 || faults.unhandled.length > 0) {
      return {
        outcome: "BROKEN_CRASH",
        observed: `process-level fault while serving ${spec.method} ${spec.path}: uncaught=[${faults.uncaught.join("; ")}] unhandled=[${faults.unhandled.join("; ")}] (wire: ${JSON.stringify(faulted).slice(0, 100)})`,
        notes,
      };
    }
    if (faulted.kind === "timeout") {
      return {
        outcome: "BROKEN_NO_RESPONSE",
        observed: `${spec.method} ${spec.path} (${cell.name}) never answered within ${RESPONSE_TIMEOUT_MS}ms — the browser's fetch hangs forever`,
        notes,
      };
    }
    const expectation = cell.expect(faulted);
    // What the request itself wrote (the injected fault is already in `injected`).
    const wrote = treeDiff(injected, afterFault);
    const disallowed = cell.allowedWrites.includes("*")
      ? []
      : wrote.filter((change) => !cell.allowedWrites.includes(change.slice(1)));
    if (
      expectation !== null &&
      faulted.kind === "response" &&
      faulted.status < 300 &&
      cell.family !== "url"
    ) {
      return {
        outcome: "BROKEN_FAKE_SUCCESS",
        observed: `${cell.name}: ${expectation}; body=${faulted.body.slice(0, 120)}`,
        notes,
      };
    }
    if (disallowed.length > 0) {
      const retry = cell.recovery ? await sendRaw(baseUrl, cell.recovery.request(root)) : null;
      return {
        outcome: "BROKEN_STATE",
        observed: `${cell.name}: request that must fail changed persisted state: ${disallowed.join(", ")} (wire: ${JSON.stringify(faulted).slice(0, 100)}); retry after removing the fault → ${JSON.stringify(retry).slice(0, 160)}`,
        notes,
      };
    }
    if (expectation !== null) {
      return { outcome: "BROKEN_WRONG_RESPONSE", observed: `${cell.name}: ${expectation}`, notes };
    }
    if (faulted.kind === "response" && faulted.status >= 500) {
      notes.push(
        `answered HTTP ${faulted.status}: ${faulted.body.replace(/\s+/g, " ").slice(0, 140)}`,
      );
    }
    if (faulted.kind === "client-error") notes.push(`client saw: ${faulted.error}`);

    // Recovery: the same consumer must succeed now that the fault is gone. (Skipped when the
    // faulted request itself legitimately succeeded — replaying an append-only write is a 409.)
    const faultedSucceeded = faulted.kind === "response" && faulted.status < 300;
    if (cell.recovery && !faultedSucceeded) {
      const recovered = await sendRaw(baseUrl, cell.recovery.request(root));
      const ok = recovered.kind === "response" && recovered.status === cell.recovery.healthyStatus;
      if (!ok) {
        const stateChanges = treeDiff(before, afterCleanup);
        const outcome: Outcome = stateChanges.length > 0 ? "BROKEN_STATE" : "BROKEN_NO_RECOVERY";
        return {
          outcome,
          observed: `${cell.name}: after removing the fault ${cell.recovery.request(root).method} ${cell.recovery.request(root).path} → ${JSON.stringify(recovered).slice(0, 160)} (expected ${cell.recovery.healthyStatus}); residue from the failed attempt: [${stateChanges.join(", ")}]`,
          notes,
        };
      }
    }
    // Server still alive for everyone else.
    const probe = await sendRaw(baseUrl, CONSUMERS.getReviewsProbe.request(root));
    if (probe.kind !== "response" || probe.status !== 200) {
      return {
        outcome: "BROKEN_NO_RECOVERY",
        observed: `${cell.name}: server unhealthy afterwards: ${JSON.stringify(probe).slice(0, 120)}`,
        notes,
      };
    }
    return {
      outcome: "HELD",
      observed:
        faulted.kind === "response"
          ? `HTTP ${faulted.status} ${faulted.body.replace(/\s+/g, " ").slice(0, 100)}`
          : faulted.kind,
      notes,
    };
  } finally {
    currentMiddleware = null;
    try {
      chmodSync(join(root, "datasets/coach-review"), 0o755);
    } catch {
      /* already fine */
    }
    for (const relativePath of Object.values(RELATIVE_FILES)) {
      const path = join(root, relativePath);
      try {
        if (existsSync(path) && statSync(path).isFile()) chmodSync(path, 0o644);
      } catch {
        /* gone */
      }
    }
    try {
      chmodSync(join(root, "datasets/coach-review/reviews"), 0o755);
    } catch {
      /* gone */
    }
    rmSync(root, { recursive: true, force: true });
  }
}

describe.skipIf(!enabled)(
  `labApi failure injection (${seeds.length} seeds over ${CELLS.length} cells)`,
  () => {
    for (const seed of seeds) {
      const cell = CELLS[seed % CELLS.length]!;
      it(`seed ${seed} → ${cell.name}`, async () => {
        const started = Date.now();
        let verdict: Verdict;
        try {
          verdict = await runCell(cell, seed);
        } catch (error) {
          verdict = { outcome: "HARNESS_ERROR", observed: String(error), notes: [] };
        }
        recordResult(table, {
          seed,
          scenario: cell.name,
          outcome: verdict.outcome,
          observed: verdict.observed,
          notes: verdict.notes,
          durationMs: Date.now() - started,
        });
        expect(verdict.outcome, `${verdict.observed}\nreplay: STRESS_SEEDS=${seed}`).toBe("HELD");
      }, 20_000);
    }
  },
);
