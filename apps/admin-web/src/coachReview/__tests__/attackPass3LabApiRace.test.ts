import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
 * Adversarial pass 3 (services-api-legacy-admin-web), scenario S6 — concurrent
 * identical review POSTs against the REAL lab middleware (the code
 * vite.config.ts mounts) pointed at a THROWAWAY root under tmpdir. The repo's
 * datasets/ are read for fixtures and never written. Pinned at 4d812e1a.
 */

const REAL_REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");

const TEST_COACHES = [
  { coachId: "attack3-test-coach-a", credentialRef: "attack3-test-cred-a" },
  { coachId: "attack3-test-coach-b", credentialRef: "attack3-test-cred-b" },
];

function testQualification(): CoachQualification {
  return {
    policyVersion: "coach-qualification-policy-v1",
    satisfiedCriteria: ["criterion.professional-coaching-history"],
    verdict: "qualified",
    assessedBy: "attack-pass3-test",
    assessedAtIso: "2026-09-04T00:00:00.000Z",
    certifications: [],
    professionalCoachingHistory: {
      statement: "TEST-ONLY fixture claim (throwaway root, not a real coach)",
      verification: {
        method: "document_reviewed",
        verifiedBy: "attack-pass3-test",
        verifiedAtIso: "2026-09-04T00:00:00.000Z",
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
let realReviewsSnapshot: string[];

const REAL_REVIEWS_DIR = join(REAL_REPO_ROOT, "datasets/coach-review/reviews");
const listReal = () => {
  try {
    return readdirSync(REAL_REVIEWS_DIR).sort();
  } catch {
    return [];
  }
};

beforeAll(async () => {
  realReviewsSnapshot = listReal();
  tmpRoot = mkdtempSync(join(tmpdir(), "attack3-labapi-"));
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
      schemaVersion: 2,
      note: "TEST-ONLY throwaway registry for adversarial pass 3. Not a real registry.",
      qualificationPolicy: {
        version: "coach-qualification-policy-v1",
        document: "docs/COACH_QUALIFICATION_POLICY.md",
      },
      coaches: TEST_COACHES.map((coach) => ({
        ...coach,
        status: "active",
        provisionedAtIso: "2026-09-04T00:00:00.000Z",
        provisionedBy: "attack-pass3-test",
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
  // the `null`-body attack below leaves sockets open on purpose; drop them so close() returns
  server.closeAllConnections();
  await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  rmSync(tmpRoot, { recursive: true, force: true });
  // the real repo datasets must be byte-for-byte untouched by this suite
  expect(listReal()).toEqual(realReviewsSnapshot);
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
        provisionedAtIso: "2026-09-04T00:00:00.000Z",
        provisionedBy: "attack-pass3-test",
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

const reviewFiles = () => {
  try {
    return readdirSync(join(tmpRoot, "datasets/coach-review/reviews"));
  } catch {
    return [];
  }
};

describe("S6 — concurrent identical review POSTs (real middleware, throwaway root)", () => {
  it("HELD: two identical valid reviews fired with Promise.all → exactly one file, one 201, one 409", async () => {
    const review = testReview(0);
    const body = JSON.stringify(review);
    const [a, b] = await Promise.all([
      post("/api/coach-reviews", body),
      post("/api/coach-reviews", body),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const loser = a.status === 409 ? a : b;
    expect(loser.body).toContain("append-only");
    expect(reviewFiles().filter((name) => name === `${review.reviewId}.json`)).toHaveLength(1);
    const persisted = JSON.parse(
      readFileSync(
        join(tmpRoot, "datasets/coach-review/reviews", `${review.reviewId}.json`),
        "utf8",
      ),
    ) as CoachReview;
    expect(persisted.reviewId).toBe(review.reviewId);
  });

  it("HELD: 25 identical reviews in one burst → exactly one 201, 24 × 409, one file (the existsSync→writeFileSync pair is synchronous after the body read, so no interleaving)", async () => {
    const review = testReview(1);
    const body = JSON.stringify(review);
    const results = await Promise.all(
      Array.from({ length: 25 }, () => post("/api/coach-reviews", body)),
    );
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(24);
    expect(reviewFiles().filter((name) => name === `${review.reviewId}.json`)).toHaveLength(1);
  });

  it("HELD: a 'first-write-wins' burst with DIVERGENT payloads for the same reviewId keeps exactly the winner's bytes", async () => {
    const review = testReview(0, "wm-volley-02-E1");
    const variants = Array.from({ length: 10 }, (_, i) =>
      JSON.stringify({ ...review, confidence: Number((0.5 + i / 100).toFixed(2)) }),
    );
    const results = await Promise.all(variants.map((v) => post("/api/coach-reviews", v)));
    const winners = results.map((r, i) => (r.status === 201 ? i : -1)).filter((i) => i >= 0);
    expect(winners).toHaveLength(1);
    const persisted = JSON.parse(
      readFileSync(
        join(tmpRoot, "datasets/coach-review/reviews", `${review.reviewId}.json`),
        "utf8",
      ),
    ) as CoachReview;
    expect(persisted.confidence).toBe(Number((0.5 + winners[0]! / 100).toFixed(2)));
  });

  it("HELD: reviewId cannot be steered off the reviews dir — traversal / unicode / NUL ids are 422 and write nothing", async () => {
    const base = testReview(1, "wm-volley-02-E1");
    const before = reviewFiles().length;
    const hostile = [
      "../../../etc/attack3",
      "..\\..\\attack3",
      `${base.queueItemId}.${base.coachId}/../pwn`,
      `${base.queueItemId}.${base.coachId}\u0000.json`,
      `${base.queueItemId}.${base.coachId}😀`,
      "",
    ];
    for (const reviewId of hostile) {
      const result = await post("/api/coach-reviews", JSON.stringify({ ...base, reviewId }));
      expect(result.status).toBe(422);
      expect(result.body).toContain("reviewId must equal");
    }
    expect(reviewFiles().length).toBe(before);
    expect(listReal()).toEqual(realReviewsSnapshot);
  });
});

describe("extra — lab middleware body handling", () => {
  it("HELD: a JSON body over the 1 000 000-byte limit is refused (400 body too large or connection reset), never persisted", async () => {
    const review = testReview(0, "wm-volley-02-E1");
    const before = reviewFiles().length;
    const body = JSON.stringify({ ...review, notes: "x".repeat(1_000_000) });
    let outcome: string;
    try {
      const result = await post("/api/coach-reviews", body);
      outcome = `${result.status}:${result.body}`;
      expect(result.status).toBe(400);
      expect(result.body).toContain("body too large");
    } catch (error) {
      outcome = `fetch-error:${String(error)}`;
      expect(String(error)).toMatch(/fetch failed|ECONNRESET|EPIPE|socket/i);
    }
    console.log(`[attack-s6] oversize body outcome: ${outcome.slice(0, 120)}`);
    expect(reviewFiles().length).toBe(before);
  });

  it("HELD: 40 concurrent malformed bodies (truncated JSON, BOM, NUL, empty, non-object JSON) all get 400/403 and never crash the server", async () => {
    const bodies = [
      "{",
      "\uFEFF{}",
      "\u0000",
      "",
      "[]",
      "42",
      '"x"',
      "true",
      '{"reviewId":1e999}',
      "{}",
    ];
    const results = await Promise.all(
      Array.from({ length: 40 }, (_, i) => post("/api/coach-reviews", bodies[i % bodies.length]!)),
    );
    for (const result of results) {
      expect([400, 403]).toContain(result.status);
    }
    // server still alive and correct afterwards
    const probe = await post("/api/coach-reviews", "{not json");
    expect(probe.status).toBe(400);
  });

  const POST_ROUTES = [
    "/api/coach-reviews",
    "/api/coach-adjudications",
    "/api/coach-review-amendments",
    "/api/coach-assignments",
    "/api/drill-mapping-proposals",
    "/api/coach-provisioning",
  ];

  async function postWithDeadline(
    path: string,
    body: string,
    ms: number,
  ): Promise<number | "HUNG"> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
      const response = await fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: controller.signal,
      });
      await response.text();
      return response.status;
    } catch (error) {
      if ((error as Error).name === "AbortError") return "HUNG";
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  it("BROKEN: the JSON literal `null` makes EVERY lab POST route hang forever — readJsonBody returns null for a valid body and each handler's `=== null` early-return sends no response (labApi.ts:280,319,383,433,461,584)", async () => {
    const outcomes = await Promise.all(
      POST_ROUTES.map((route) => postWithDeadline(route, "null", 1500)),
    );
    // observed at 4d812e1a: no status line ever arrives on any of the six routes
    expect(outcomes).toEqual(POST_ROUTES.map(() => "HUNG"));
    // control: the same routes answer a malformed body immediately, so the hang is body-specific
    const controls = await Promise.all(
      POST_ROUTES.map((route) => postWithDeadline(route, "{", 1500)),
    );
    expect(controls).toEqual(POST_ROUTES.map(() => 400));
  }, 15_000);
});
