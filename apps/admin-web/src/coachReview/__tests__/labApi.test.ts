import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLabApiMiddleware } from "../labApi";
import { syntheticAgreeingPair } from "../syntheticFixtures";
import type { CoachReview } from "../types";

/**
 * D3-09 red-team: endpoint-level tests against the REAL dev-API middleware
 * (the exact code vite.config.ts mounts), pointed at a THROWAWAY repo root
 * under tmpdir — never the repo's datasets/. The registry in the throwaway
 * root contains TEST-ONLY identities that exist nowhere else; the repo's
 * human-managed coaches.json stays empty and untouched.
 */

const REAL_REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");

const TEST_COACHES = [
  { coachId: "redteam-test-coach-a", credentialRef: "redteam-test-cred-a" },
  { coachId: "redteam-test-coach-b", credentialRef: "redteam-test-cred-b" },
  { coachId: "redteam-test-coach-c", credentialRef: "redteam-test-cred-c" },
];

let tmpRoot: string;
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), "d3-09-labapi-"));
  const dir = join(tmpRoot, "datasets/coach-review");
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
  writeFileSync(
    join(dir, "coaches.json"),
    JSON.stringify({
      schemaVersion: 1,
      note: "TEST-ONLY throwaway registry for red-team endpoint tests. Not a real registry.",
      coaches: TEST_COACHES.map((coach) => ({
        ...coach,
        status: "active",
        provisionedAtIso: "2026-08-29T00:00:00.000Z",
        provisionedBy: "d3-09-redteam-test",
      })),
    }),
  );
  const middleware = createLabApiMiddleware(tmpRoot);
  server = createServer((req, res) => {
    middleware(req, res, () => {
      res.writeHead(404);
      res.end("fell through");
    });
  });
  await new Promise<void>((resolvePromise) => server.listen(0, () => resolvePromise()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  rmSync(tmpRoot, { recursive: true, force: true });
});

function testReview(coachIndex: number, queueItemId = "wm-dink-01-E1"): CoachReview {
  const [fixture] = syntheticAgreeingPair();
  const coach = TEST_COACHES[coachIndex]!;
  const caseId = queueItemId.replace(/-E\d+$/, "");
  const eventIndex = Number(/-E(\d+)$/.exec(queueItemId)![1]) - 1;
  return {
    ...fixture!,
    coachId: coach.coachId,
    coachCredentialRef: coach.credentialRef,
    queueItemId,
    eventRef: { caseId, eventIndex },
    reviewId: `${queueItemId}.${coach.coachId}`,
  };
}

async function post(path: string, body: string): Promise<{ status: number; body: string }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  return { status: response.status, body: await response.text() };
}

describe("review submission gates (real middleware, throwaway root)", () => {
  it("rejects invalid JSON with 400, not a crash", async () => {
    const result = await post("/api/coach-reviews", "{not json");
    expect(result.status).toBe(400);
    expect(result.body).toContain("invalid JSON");
  });

  it("rejects an unprovisioned coach with 403 and persists nothing", async () => {
    const review = {
      ...testReview(0),
      coachId: "unknown-coach",
      reviewId: "wm-dink-01-E1.unknown-coach",
    };
    const result = await post("/api/coach-reviews", JSON.stringify(review));
    expect(result.status).toBe(403);
    expect(result.body).toContain("no coach identity provisioned");
  });

  it("rejects a credentialRef that does not match the registry", async () => {
    const review = { ...testReview(0), coachCredentialRef: "stolen-cred" };
    const result = await post("/api/coach-reviews", JSON.stringify(review));
    expect(result.status).toBe(403);
    expect(result.body).toContain("does not match");
  });

  it("rejects a schema-invalid review (NaN confidence smuggled as null via JSON) with 422", async () => {
    const review = { ...testReview(0), confidence: "0.8" as unknown as number };
    const result = await post("/api/coach-reviews", JSON.stringify(review));
    expect(result.status).toBe(422);
    expect(result.body).toContain("confidence must be 0..1");
  });

  it("rejects a review of a nonexistent queue item/event with 422", async () => {
    const review = testReview(0, "wm-dink-01-E99");
    const result = await post("/api/coach-reviews", JSON.stringify(review));
    expect(result.status).toBe(422);
    expect(result.body).toContain("not in the current queue");
  });

  it("accepts a valid review once, then refuses the duplicate with 409 (append-only)", async () => {
    const review = testReview(0);
    const first = await post("/api/coach-reviews", JSON.stringify(review));
    expect(first.status).toBe(201);
    const duplicate = await post("/api/coach-reviews", JSON.stringify(review));
    expect(duplicate.status).toBe(409);
    expect(duplicate.body).toContain("append-only");
    const files = readdirSync(join(tmpRoot, "datasets/coach-review/reviews"));
    expect(files.filter((name) => name === `${review.reviewId}.json`)).toHaveLength(1);
  });
});

describe("adjudication gates (real middleware, throwaway root)", () => {
  beforeAll(async () => {
    expect((await post("/api/coach-reviews", JSON.stringify(testReview(1)))).status).toBe(201);
    expect(
      (await post("/api/coach-reviews", JSON.stringify(testReview(0, "wm-volley-02-E1")))).status,
    ).toBe(201);
  });

  const baseAdjudication = () => ({
    schemaVersion: 1,
    queueItemId: "wm-dink-01-E1",
    adjudicatorId: TEST_COACHES[2]!.coachId,
    adjudicatorCredentialRef: TEST_COACHES[2]!.credentialRef,
    reviewedReviewIds: [
      `wm-dink-01-E1.${TEST_COACHES[0]!.coachId}`,
      `wm-dink-01-E1.${TEST_COACHES[1]!.coachId}`,
    ],
    outcome: { kind: "uphold", reviewId: `wm-dink-01-E1.${TEST_COACHES[0]!.coachId}` },
    rationale: "red-team test rationale long enough to satisfy the twenty char gate",
    evidenceTimestampsMs: [],
    createdAtIso: "2026-08-29T00:00:00.000Z",
  });

  it("rejects invalid JSON with 400", async () => {
    const result = await post("/api/coach-adjudications", "{not json");
    expect(result.status).toBe(400);
  });

  it("rejects an adjudication with only ONE review present", async () => {
    const record = baseAdjudication();
    record.reviewedReviewIds = [record.reviewedReviewIds[0]!];
    record.outcome = { kind: "uphold", reviewId: record.reviewedReviewIds[0]! };
    const result = await post("/api/coach-adjudications", JSON.stringify(record));
    expect(result.status).toBe(422);
    expect(result.body).toContain("DISTINCT disagreeing reviews");
  });

  it("rejects duplicated reviewedReviewIds masquerading as two reviews", async () => {
    const record = baseAdjudication();
    record.reviewedReviewIds = [record.reviewedReviewIds[0]!, record.reviewedReviewIds[0]!];
    const result = await post("/api/coach-adjudications", JSON.stringify(record));
    expect(result.status).toBe(422);
    expect(result.body).toContain("DISTINCT");
  });

  it("rejects a reviewedReviewId that belongs to a DIFFERENT queue item", async () => {
    const record = baseAdjudication();
    record.reviewedReviewIds = [
      record.reviewedReviewIds[0]!,
      `wm-volley-02-E1.${TEST_COACHES[0]!.coachId}`,
    ];
    const result = await post("/api/coach-adjudications", JSON.stringify(record));
    expect(result.status).toBe(422);
    expect(result.body).toContain("not the adjudicated item");
  });

  it("rejects an adjudicator who was an original reviewer", async () => {
    const record = baseAdjudication();
    record.adjudicatorId = TEST_COACHES[0]!.coachId;
    record.adjudicatorCredentialRef = TEST_COACHES[0]!.credentialRef;
    const result = await post("/api/coach-adjudications", JSON.stringify(record));
    expect(result.status).toBe(422);
    expect(result.body).toContain("must not be one of the original reviewers");
  });

  it("accepts a valid adjudication once, then refuses overwrite with 409", async () => {
    const first = await post("/api/coach-adjudications", JSON.stringify(baseAdjudication()));
    expect(first.status).toBe(201);
    const second = await post("/api/coach-adjudications", JSON.stringify(baseAdjudication()));
    expect(second.status).toBe(409);
  });
});

describe("amendment gates (real middleware, throwaway root)", () => {
  it("refuses an amendment from a coach other than the original reviewer", async () => {
    const original = testReview(0);
    const impostor = TEST_COACHES[1]!;
    const amendment = {
      schemaVersion: 1,
      amendmentId: `${original.reviewId}.r2`,
      reviewId: original.reviewId,
      revision: 2,
      reason: "red-team impostor amendment attempt",
      review: {
        ...original,
        coachId: impostor.coachId,
        coachCredentialRef: impostor.credentialRef,
      },
      createdAtIso: "2026-08-29T00:00:00.000Z",
    };
    const result = await post("/api/coach-review-amendments", JSON.stringify(amendment));
    expect(result.status).toBe(403);
    expect(result.body).toContain("original reviewing coach");
  });

  it("refuses a non-sequential revision (append-only versioning)", async () => {
    const original = testReview(0);
    const amendment = {
      schemaVersion: 1,
      amendmentId: `${original.reviewId}.r5`,
      reviewId: original.reviewId,
      revision: 5,
      reason: "red-team revision skip attempt",
      review: { ...original, confidence: 0.9 },
      createdAtIso: "2026-08-29T00:00:00.000Z",
    };
    const result = await post("/api/coach-review-amendments", JSON.stringify(amendment));
    expect(result.status).toBe(409);
    expect(result.body).toContain("revision must be 2");
  });
});
