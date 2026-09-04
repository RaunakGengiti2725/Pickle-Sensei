import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLabApiMiddleware } from "../../labApi";
import { syntheticAgreeingPair } from "../../syntheticFixtures";
import type { CoachQualification } from "../../provisioning";
import type { CoachReview } from "../../types";

/**
 * Structural audit (services-api-legacy-admin-web, pass 1): resilience of the
 * Coach Review Lab dev-API middleware (the exact code vite.config.ts mounts)
 * against a THROWAWAY repo root — corrupted on-disk records, oversize bodies,
 * and concurrent identical submissions. Never touches the repo's datasets/.
 */

const REAL_REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../..");

const TEST_COACH = { coachId: "audit-test-coach-a", credentialRef: "audit-test-cred-a" };

function testQualification(): CoachQualification {
  return {
    policyVersion: "coach-qualification-policy-v1",
    satisfiedCriteria: ["criterion.professional-coaching-history"],
    verdict: "qualified",
    assessedBy: "structural-audit-test",
    assessedAtIso: "2026-08-29T00:00:00.000Z",
    certifications: [],
    professionalCoachingHistory: {
      statement: "TEST-ONLY fixture claim (throwaway root, not a real coach)",
      verification: {
        method: "document_reviewed",
        verifiedBy: "structural-audit-test",
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

let tmpRoot: string;
let server: Server;
let baseUrl: string;
let reviewsDir: string;

beforeAll(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), "audit-labapi-"));
  const dir = join(tmpRoot, "datasets/coach-review");
  reviewsDir = join(dir, "reviews");
  mkdirSync(dir, { recursive: true });
  for (const name of ["queue.json", "schema.json"]) {
    cpSync(join(REAL_REPO_ROOT, "datasets/coach-review", name), join(dir, name));
  }
  for (const sub of ["taxonomy", "drills"]) {
    cpSync(join(REAL_REPO_ROOT, "datasets/coach-review", sub), join(dir, sub), {
      recursive: true,
    });
  }
  writeFileSync(
    join(dir, "coaches.json"),
    JSON.stringify({
      schemaVersion: 2,
      note: "TEST-ONLY throwaway registry for structural audit tests. Not a real registry.",
      qualificationPolicy: {
        version: "coach-qualification-policy-v1",
        document: "docs/COACH_QUALIFICATION_POLICY.md",
      },
      coaches: [
        {
          ...TEST_COACH,
          status: "active",
          provisionedAtIso: "2026-08-29T00:00:00.000Z",
          provisionedBy: "structural-audit-test",
          qualification: testQualification(),
        },
      ],
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

function testReview(queueItemId = "wm-dink-01-E1"): CoachReview {
  const [fixture] = syntheticAgreeingPair();
  const caseId = queueItemId.replace(/-E\d+$/, "");
  const eventIndex = Number(/-E(\d+)$/.exec(queueItemId)![1]) - 1;
  return {
    ...fixture!,
    coachId: TEST_COACH.coachId,
    coachCredentialRef: TEST_COACH.credentialRef,
    queueItemId,
    eventRef: { caseId, eventIndex },
    reviewId: `${queueItemId}.${TEST_COACH.coachId}`,
    provenance: {
      ...fixture!.provenance,
      coachQualificationSnapshot: {
        ...fixture!.provenance.coachQualificationSnapshot,
        coachId: TEST_COACH.coachId,
        credentialRef: TEST_COACH.credentialRef,
        provisionedAtIso: "2026-08-29T00:00:00.000Z",
        provisionedBy: "structural-audit-test",
      },
    },
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

describe("concurrent identical submissions (append-only check-then-write)", () => {
  it("exactly one of N simultaneous identical reviews is persisted; the rest get 409", async () => {
    const review = testReview("wm-dink-01-E1");
    const results = await Promise.all(
      Array.from({ length: 8 }, () => post("/api/coach-reviews", JSON.stringify(review))),
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(7);
    expect(readdirSync(reviewsDir).filter((n) => n === `${review.reviewId}.json`)).toHaveLength(1);
  });
});

describe("oversize request bodies", () => {
  it("a >1 MB review body is refused with 413, distinguishable from malformed JSON", async () => {
    const review = testReview("wm-dink-01-E2");
    const padded = { ...review, notes: "x".repeat(1_100_000) };
    let status: number | "connection-error" = "connection-error";
    let body = "";
    try {
      const response = await fetch(`${baseUrl}/api/coach-reviews`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(padded),
      });
      status = response.status;
      body = await response.text();
    } catch (error) {
      body = String(error);
    }
    expect(status, `oversize body → ${String(status)} ${body.slice(0, 200)}`).toBe(413);
    expect(body).not.toContain("invalid JSON");
  });
});

describe("corrupted on-disk records", () => {
  it("one truncated reviews/*.json file does not 500 the whole GET /api/coach-reviews listing", async () => {
    const good = testReview("wm-dink-01-E1");
    // Persist a good record through the real write path first.
    const seeded = await post("/api/coach-reviews", JSON.stringify(good));
    expect([201, 409]).toContain(seeded.status);

    // Simulate a crash mid-writeFileSync: a partially written JSON document.
    writeFileSync(join(reviewsDir, "wm-dink-01-E9.crashed.json"), '{"reviewId": "wm-dink-01-E9.cr');

    const response = await fetch(`${baseUrl}/api/coach-reviews`);
    const text = await response.text();
    expect(
      response.status,
      `GET listing with one corrupt file → ${response.status}: ${text.slice(0, 200)}`,
    ).toBe(200);
    const listing = JSON.parse(text) as Array<{ review: CoachReview }>;
    expect(listing.some((entry) => entry.review.reviewId === good.reviewId)).toBe(true);
  });

  it("one corrupt reviews/*.json file does not block adjudication of unrelated items", async () => {
    // Corrupt file from the previous test is still present.
    const response = await fetch(`${baseUrl}/api/coach-adjudications`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        adjudicatorId: TEST_COACH.coachId,
        adjudicatorCredentialRef: TEST_COACH.credentialRef,
        queueItemId: "wm-dink-01-E1",
      }),
    });
    const text = await response.text();
    // Anything typed (403 self-adjudication / 422 schema) is fine; a 500
    // means the corrupt neighbour file took the endpoint down.
    expect(
      response.status,
      `POST adjudication → ${response.status}: ${text.slice(0, 200)}`,
    ).not.toBe(500);
  });
});
