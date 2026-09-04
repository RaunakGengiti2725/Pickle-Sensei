import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLabApiMiddleware } from "../labApi";
import { syntheticAgreeingPair } from "../syntheticFixtures";
import type { CoachQualification } from "../provisioning";
import type { CoachReview } from "../types";

/**
 * Structural audit probes (auditor #2) for the Coach Review Lab dev API,
 * against the REAL middleware mounted by vite.config.ts and a THROWAWAY root:
 *   - a corrupted / partially written reviews/*.json file vs GET listing
 *   - oversized request bodies (413 vs 400)
 *   - simultaneous identical submissions vs the append-only 409 check
 * Never touches the repo's datasets/.
 */

const REAL_REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");

const TEST_COACHES = [
  { coachId: "audit2-test-coach-a", credentialRef: "audit2-test-cred-a" },
  { coachId: "audit2-test-coach-b", credentialRef: "audit2-test-cred-b" },
];

function testQualification(): CoachQualification {
  return {
    policyVersion: "coach-qualification-policy-v1",
    satisfiedCriteria: ["criterion.professional-coaching-history"],
    verdict: "qualified",
    assessedBy: "audit2-test",
    assessedAtIso: "2026-08-29T00:00:00.000Z",
    certifications: [],
    professionalCoachingHistory: {
      statement: "TEST-ONLY fixture claim (throwaway root, not a real coach)",
      verification: {
        method: "document_reviewed",
        verifiedBy: "audit2-test",
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
const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => {
  unhandled.push(reason);
};

beforeAll(async () => {
  process.on("unhandledRejection", onUnhandled);
  tmpRoot = mkdtempSync(join(tmpdir(), "audit2-labapi-"));
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
      coaches: TEST_COACHES.map((coach) => ({
        ...coach,
        status: "active",
        provisionedAtIso: "2026-08-29T00:00:00.000Z",
        provisionedBy: "audit2-test",
        qualification: testQualification(),
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
  process.off("unhandledRejection", onUnhandled);
  server.closeAllConnections?.();
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
    provenance: {
      ...fixture!.provenance,
      coachQualificationSnapshot: {
        ...fixture!.provenance.coachQualificationSnapshot,
        coachId: coach.coachId,
        credentialRef: coach.credentialRef,
        provisionedAtIso: "2026-08-29T00:00:00.000Z",
        provisionedBy: "audit2-test",
      },
    },
  };
}

async function post(
  path: string,
  body: string,
  timeoutMs = 5_000,
): Promise<{ status: number; body: string }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { status: response.status, body: await response.text() };
}

describe("GET /api/coach-reviews resilience", () => {
  it("lists valid reviews when the directory is clean", async () => {
    const review = testReview(0);
    expect((await post("/api/coach-reviews", JSON.stringify(review))).status).toBe(201);
    const response = await fetch(`${baseUrl}/api/coach-reviews`, {
      signal: AbortSignal.timeout(5_000),
    });
    expect(response.status).toBe(200);
    const entries = (await response.json()) as Array<{ review: CoachReview }>;
    expect(entries.map((e) => e.review.reviewId)).toContain(review.reviewId);
  });

  it("SUSPECTED DEFECT: one corrupted reviews/*.json (crash mid-write) must not take down the whole listing", async () => {
    // Simulates a partially written file (process killed inside writeFileSync).
    writeFileSync(join(reviewsDir, "zz-partial-write.json"), '{"reviewId":"wm-dink-01-E9.tru');
    let outcome: { status: number; body: string } | { failure: string };
    try {
      const response = await fetch(`${baseUrl}/api/coach-reviews`, {
        signal: AbortSignal.timeout(3_000),
      });
      outcome = { status: response.status, body: await response.text() };
    } catch (error) {
      outcome = { failure: String(error) };
    } finally {
      rmSync(join(reviewsDir, "zz-partial-write.json"), { force: true });
    }
    console.info(`[audit] GET with corrupted file → ${JSON.stringify(outcome).slice(0, 400)}`);
    // Give the middleware's detached async IIFE a tick to surface any rejection.
    await new Promise((r) => setTimeout(r, 50));
    const rejections = unhandled.map((r) => String(r));
    unhandled.length = 0;
    expect(
      rejections,
      "the middleware must not leak an unhandledRejection (would crash a Node process with --unhandled-rejections=throw, the Node ≥15 default)",
    ).toEqual([]);
    expect("status" in outcome, `client outcome: ${JSON.stringify(outcome)}`).toBe(true);
    if ("status" in outcome) {
      // Either a 200 with the valid entries or a typed error JSON is acceptable; a hang is not.
      expect(outcome.status).toBeLessThan(500);
    }
  });
});

describe("POST /api/coach-reviews body limits", () => {
  it("SUSPECTED DEFECT: a >1 MB body is reported as 413 (payload too large), not 400 'invalid JSON'", async () => {
    const review = testReview(1);
    const padded = { ...review, notes: "x".repeat(1_200_000) };
    let outcome: { status: number; body: string } | { failure: string };
    try {
      outcome = await post("/api/coach-reviews", JSON.stringify(padded));
    } catch (error) {
      outcome = { failure: String(error) };
    }
    expect("status" in outcome, `client outcome: ${JSON.stringify(outcome).slice(0, 300)}`).toBe(
      true,
    );
    if ("status" in outcome) {
      expect(outcome.status, outcome.body.slice(0, 200)).toBe(413);
    }
  });
});

describe("append-only under concurrency", () => {
  it("N simultaneous identical submissions → exactly one 201, the rest 409, one file on disk", async () => {
    const review = testReview(1);
    const results = await Promise.all(
      Array.from({ length: 12 }, () => post("/api/coach-reviews", JSON.stringify(review))),
    );
    const statuses = results.map((r) => r.status).sort();
    expect(
      statuses.filter((s) => s === 201),
      JSON.stringify(results.map((r) => [r.status, r.body.slice(0, 120)])),
    ).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(11);
    const files = readdirSync(reviewsDir).filter((name) => name === `${review.reviewId}.json`);
    expect(files).toHaveLength(1);
  });
});
