import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest, type Server } from "node:http";
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
 * ADJ-09 regression suite: malformed INPUT to the Coach Review Lab dev API
 * (the exact middleware vite.config.ts mounts) against a THROWAWAY repo root
 * under tmpdir — never the repo's datasets/.
 *
 *  (a) one unparseable file beside valid reviews must not 500 the whole
 *      GET /api/coach-reviews list, and no raw parser text may leak;
 *  (b) an oversized POST body must get an HTTP 413 JSON response and a clean
 *      close — never a socket reset before the client can read a status;
 *  (c) a body that parses to null / an array / a string must be answered
 *      with 400 promptly on every write route (never a hung request);
 *  (d) every OTHER reader of a persisted-record directory (the GET lists for
 *      adjudications / amendments / drill mappings / the provisioning log and
 *      the POST paths that consult reviews/ and amendments/ for gating) must
 *      tolerate one damaged file the same way: a controlled 4xx/200 that
 *      names the file, never a 500, never raw parser text.
 */

const RAW_PARSER_TEXT = /SyntaxError|Unexpected token|Unexpected end|EISDIR|EACCES/;

const WRITE_ROUTES = [
  "/api/coach-reviews",
  "/api/coach-adjudications",
  "/api/coach-review-amendments",
  "/api/coach-assignments",
  "/api/drill-mapping-proposals",
  "/api/coach-provisioning",
] as const;

const VALID_REVIEW_FILE = "wm-dink-01-E1.adj09-test-coach.json";
const CORRUPT_REVIEW_FILE = "corrupt.json";

let tmpRoot: string;
let server: Server;
let baseUrl: string;
let port: number;

beforeAll(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), "adj-09-labapi-"));
  const reviewsDir = join(tmpRoot, "datasets/coach-review/reviews");
  mkdirSync(reviewsDir, { recursive: true });
  writeFileSync(
    join(reviewsDir, VALID_REVIEW_FILE),
    JSON.stringify({
      reviewId: "wm-dink-01-E1.adj09-test-coach",
      coachId: "adj09-test-coach",
      queueItemId: "wm-dink-01-E1",
    }),
  );
  writeFileSync(join(reviewsDir, CORRUPT_REVIEW_FILE), "{ this is not json");
  writeFileSync(
    join(tmpRoot, "datasets/coach-review/coaches.json"),
    JSON.stringify({
      schemaVersion: 2,
      note: "TEST-ONLY empty throwaway registry for ADJ-09 input-handling tests.",
      qualificationPolicy: {
        version: "coach-qualification-policy-v1",
        document: "docs/COACH_QUALIFICATION_POLICY.md",
      },
      coaches: [],
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
  port = (server.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  rmSync(tmpRoot, { recursive: true, force: true });
});

async function post(
  path: string,
  body: string,
  timeoutMs = 1_000,
): Promise<{ status: number; contentType: string; body: string }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  return {
    status: response.status,
    contentType: response.headers.get("content-type") ?? "",
    body: await response.text(),
  };
}

/** Streams `bytes` of JSON with chunked transfer-encoding (no content-length),
 * so the server cannot know the size up front and must enforce the limit
 * while reading. Resolves with the response or rejects with the socket error
 * the client observed (e.g. ECONNRESET). */
function postChunked(
  path: string,
  bytes: number,
): Promise<{ status: number; contentType: string; body: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: { "content-type": "application/json", "transfer-encoding": "chunked" },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (text += chunk));
        res.on("end", () =>
          resolvePromise({
            status: res.statusCode ?? 0,
            contentType: res.headers["content-type"] ?? "",
            body: text,
          }),
        );
        res.on("error", rejectPromise);
      },
    );
    req.on("error", rejectPromise);
    req.write('{"pad":"');
    const chunk = "x".repeat(64 * 1024);
    let sent = 0;
    const pump = (): void => {
      while (sent < bytes) {
        sent += chunk.length;
        if (!req.write(chunk)) {
          req.once("drain", pump);
          return;
        }
      }
      req.end('"}');
    };
    pump();
  });
}

describe("ADJ-09 (a): GET /api/coach-reviews with one corrupt file", () => {
  it("returns 200 with the valid reviews and names the bad file without raw parser text", async () => {
    const response = await fetch(`${baseUrl}/api/coach-reviews`, {
      signal: AbortSignal.timeout(1_000),
    });
    const text = await response.text();
    expect(response.status, text).toBe(200);
    expect(text).not.toContain("SyntaxError");
    expect(text).not.toContain("Unexpected token");
    const body = JSON.parse(text) as {
      reviews: Array<{ file: string; review: { reviewId: string } }>;
      invalidFiles: Array<{ file: string; message: string }>;
    };
    expect(body.reviews.map((entry) => entry.file)).toEqual([
      `datasets/coach-review/reviews/${VALID_REVIEW_FILE}`,
    ]);
    expect(body.reviews[0]!.review.reviewId).toBe("wm-dink-01-E1.adj09-test-coach");
    expect(body.invalidFiles).toHaveLength(1);
    expect(body.invalidFiles[0]!.file).toBe(`datasets/coach-review/reviews/${CORRUPT_REVIEW_FILE}`);
    expect(body.invalidFiles[0]!.message).toMatch(/JSON/);
  });
});

describe("ADJ-09 (b): oversized POST body", () => {
  const ONE_POINT_ONE_MB = 1_100_000;

  it("answers a 1.1 MB content-length body with HTTP 413 JSON (no ECONNRESET)", async () => {
    const body = JSON.stringify({ pad: "x".repeat(ONE_POINT_ONE_MB) });
    expect(body.length).toBeGreaterThan(ONE_POINT_ONE_MB);
    const result = await post("/api/coach-reviews", body, 5_000);
    expect(result.status).toBe(413);
    expect(result.contentType).toContain("application/json");
    const parsed = JSON.parse(result.body) as { message: string };
    expect(parsed.message).toMatch(/too large|exceeds/i);
  });

  it("answers a 1.1 MB chunked body (no content-length) with HTTP 413 JSON (no ECONNRESET)", async () => {
    const result = await postChunked("/api/coach-reviews", ONE_POINT_ONE_MB);
    expect(result.status).toBe(413);
    expect(result.contentType).toContain("application/json");
    const parsed = JSON.parse(result.body) as { message: string };
    expect(parsed.message).toMatch(/too large|exceeds/i);
  });

  it("still serves the next request on the same server after a 413", async () => {
    const response = await fetch(`${baseUrl}/api/coach-reviews`, {
      signal: AbortSignal.timeout(1_000),
    });
    expect(response.status).toBe(200);
  });
});

describe("ADJ-09 (c): JSON bodies that are not objects", () => {
  for (const route of WRITE_ROUTES) {
    for (const body of ["null", "[]", '"str"', "42", "true"]) {
      it(`POST ${route} with body ${body} returns 400 within 1 s`, async () => {
        const result = await post(route, body);
        expect(result.status, result.body).toBe(400);
        expect(result.contentType).toContain("application/json");
        expect(JSON.parse(result.body)).toMatchObject({ message: expect.any(String) });
      });
    }
  }

  it("still rejects malformed JSON with 400 on every write route", async () => {
    for (const route of WRITE_ROUTES) {
      const result = await post(route, "{not json");
      expect(result.status, route).toBe(400);
      expect(result.body).toContain("invalid JSON");
    }
  });
});

/**
 * (d) runs against a SECOND throwaway root with a TEST-ONLY provisioned
 * registry (identities that exist nowhere else), so the write paths get past
 * the identity gate and actually reach the directory readers under test.
 */
const REAL_REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");

const LAB_COACHES = [
  { coachId: "adj09-r2-coach-a", credentialRef: "adj09-r2-cred-a" },
  { coachId: "adj09-r2-coach-b", credentialRef: "adj09-r2-cred-b" },
  { coachId: "adj09-r2-coach-c", credentialRef: "adj09-r2-cred-c" },
];

function testQualification(): CoachQualification {
  return {
    policyVersion: "coach-qualification-policy-v1",
    satisfiedCriteria: ["criterion.professional-coaching-history"],
    verdict: "qualified",
    assessedBy: "adj09-r2-test",
    assessedAtIso: "2026-08-29T00:00:00.000Z",
    certifications: [],
    professionalCoachingHistory: {
      statement: "TEST-ONLY fixture claim (throwaway root, not a real coach)",
      verification: {
        method: "document_reviewed",
        verifiedBy: "adj09-r2-test",
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

function labReview(coachIndex: number, queueItemId: string): CoachReview {
  const [fixture] = syntheticAgreeingPair();
  const coach = LAB_COACHES[coachIndex]!;
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
        provisionedBy: "adj09-r2-test",
      },
    },
  };
}

describe("ADJ-09 (d): one corrupt file beside every OTHER record reader", () => {
  let labRoot: string;
  let labDir: string;
  let labServer: Server;
  let labUrl: string;

  const labFetch = async (
    path: string,
    init?: RequestInit,
  ): Promise<{ status: number; body: string }> => {
    const response = await fetch(`${labUrl}${path}`, {
      ...init,
      signal: AbortSignal.timeout(2_000),
    });
    return { status: response.status, body: await response.text() };
  };
  const labPost = (path: string, body: unknown) =>
    labFetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    labRoot = mkdtempSync(join(tmpdir(), "adj-09-labapi-readers-"));
    labDir = join(labRoot, "datasets/coach-review");
    mkdirSync(join(labDir, "reviews"), { recursive: true });
    for (const name of ["queue.json", "schema.json"]) {
      cpSync(join(REAL_REPO_ROOT, "datasets/coach-review", name), join(labDir, name));
    }
    for (const name of ["taxonomy", "drills"]) {
      cpSync(join(REAL_REPO_ROOT, "datasets/coach-review", name), join(labDir, name), {
        recursive: true,
      });
    }
    writeFileSync(
      join(labDir, "coaches.json"),
      JSON.stringify({
        schemaVersion: 2,
        note: "TEST-ONLY throwaway registry for ADJ-09 reader tests. Not a real registry.",
        qualificationPolicy: {
          version: "coach-qualification-policy-v1",
          document: "docs/COACH_QUALIFICATION_POLICY.md",
        },
        coaches: LAB_COACHES.map((coach) => ({
          ...coach,
          status: "active",
          provisionedAtIso: "2026-08-29T00:00:00.000Z",
          provisionedBy: "adj09-r2-test",
          qualification: testQualification(),
        })),
      }),
    );
    // Two valid reviews per adjudicable item (coaches a and b) written the way
    // POST /api/coach-reviews persists them, plus ONE corrupt neighbour.
    for (const queueItemId of ["wm-dink-01-E1", "wm-volley-02-E1"]) {
      for (const coachIndex of [0, 1]) {
        const review = labReview(coachIndex, queueItemId);
        writeFileSync(
          join(labDir, "reviews", `${review.reviewId}.json`),
          JSON.stringify(review, null, 2),
        );
      }
    }
    writeFileSync(join(labDir, "reviews", "corrupt.json"), "{ this is not json");
    const middleware = createLabApiMiddleware(labRoot);
    labServer = createServer((req, res) => {
      middleware(req, res, () => {
        res.writeHead(404);
        res.end("fell through");
      });
    });
    await new Promise<void>((resolvePromise) => labServer.listen(0, () => resolvePromise()));
    labUrl = `http://127.0.0.1:${(labServer.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolvePromise) => labServer.close(() => resolvePromise()));
    rmSync(labRoot, { recursive: true, force: true });
  });

  const adjudication = (queueItemId: string) => ({
    schemaVersion: 1,
    queueItemId,
    adjudicatorId: LAB_COACHES[2]!.coachId,
    adjudicatorCredentialRef: LAB_COACHES[2]!.credentialRef,
    reviewedReviewIds: [
      `${queueItemId}.${LAB_COACHES[0]!.coachId}`,
      `${queueItemId}.${LAB_COACHES[1]!.coachId}`,
    ],
    outcome: { kind: "uphold", reviewId: `${queueItemId}.${LAB_COACHES[0]!.coachId}` },
    rationale: "ADJ-09 reader test rationale long enough to satisfy the twenty char gate",
    evidenceTimestampsMs: [],
    createdAtIso: "2026-08-29T00:00:00.000Z",
  });

  const amendment = (original: CoachReview, revision: number) => ({
    schemaVersion: 1,
    amendmentId: `${original.reviewId}.r${revision}`,
    reviewId: original.reviewId,
    revision,
    reason: "ADJ-09 reader test amendment — confidence revised after a rewatch",
    review: { ...original, confidence: 0.55 },
    createdAtIso: "2026-08-29T00:00:00.000Z",
  });

  it("POST /api/coach-adjudications persists a valid adjudication although an UNRELATED review file is corrupt", async () => {
    const result = await labPost("/api/coach-adjudications", adjudication("wm-dink-01-E1"));
    expect(result.status, result.body).toBe(201);
    expect(result.body).not.toMatch(RAW_PARSER_TEXT);
    expect(existsSync(join(labDir, "adjudications", "wm-dink-01-E1.json"))).toBe(true);
  });

  it("POST /api/coach-adjudications refuses (422, names the file) when a review OF THE ADJUDICATED ITEM is corrupt", async () => {
    const damaged = `wm-volley-02-E1.${LAB_COACHES[2]!.coachId}.json`;
    writeFileSync(join(labDir, "reviews", damaged), "{ broken");
    try {
      const result = await labPost("/api/coach-adjudications", adjudication("wm-volley-02-E1"));
      expect(result.status, result.body).toBe(422);
      expect(result.body).toContain(`datasets/coach-review/reviews/${damaged}`);
      expect(result.body).not.toMatch(RAW_PARSER_TEXT);
      expect(existsSync(join(labDir, "adjudications", "wm-volley-02-E1.json"))).toBe(false);
    } finally {
      rmSync(join(labDir, "reviews", damaged));
    }
  });

  it("POST /api/coach-review-amendments answers 422 (names the file, no parser text) when the base review file is corrupt", async () => {
    const original = labReview(0, "afn-sasebo-rally1-E1");
    const basePath = join(labDir, "reviews", `${original.reviewId}.json`);
    writeFileSync(basePath, "{ broken");
    try {
      const result = await labPost("/api/coach-review-amendments", amendment(original, 2));
      expect(result.status, result.body).toBe(422);
      expect(result.body).toContain(`datasets/coach-review/reviews/${original.reviewId}.json`);
      expect(result.body).not.toMatch(RAW_PARSER_TEXT);
      expect(existsSync(join(labDir, "amendments", `${original.reviewId}.r2.json`))).toBe(false);
    } finally {
      rmSync(basePath);
    }
  });

  it("POST /api/coach-review-amendments answers 422 when the base review file parses to a non-object", async () => {
    const original = labReview(0, "afn-sasebo-rally1-E3");
    const basePath = join(labDir, "reviews", `${original.reviewId}.json`);
    writeFileSync(basePath, "null");
    try {
      const result = await labPost("/api/coach-review-amendments", amendment(original, 2));
      expect(result.status, result.body).toBe(422);
      expect(result.body).toContain(`datasets/coach-review/reviews/${original.reviewId}.json`);
      expect(result.body).not.toMatch(RAW_PARSER_TEXT);
    } finally {
      rmSync(basePath);
    }
  });

  it("POST /api/coach-review-amendments persists r2 although an UNRELATED amendment file is corrupt, but refuses (409) while ITS OWN history is unreadable", async () => {
    const original = labReview(0, "wm-dink-01-E1");
    mkdirSync(join(labDir, "amendments"), { recursive: true });
    writeFileSync(join(labDir, "amendments", "corrupt.json"), "{ not json");
    const accepted = await labPost("/api/coach-review-amendments", amendment(original, 2));
    expect(accepted.status, accepted.body).toBe(201);
    expect(existsSync(join(labDir, "amendments", `${original.reviewId}.r2.json`))).toBe(true);

    const damaged = `${original.reviewId}.r3.json`;
    writeFileSync(join(labDir, "amendments", damaged), "{ broken");
    try {
      const refused = await labPost("/api/coach-review-amendments", amendment(original, 4));
      expect(refused.status, refused.body).toBe(409);
      expect(refused.body).toContain(`datasets/coach-review/amendments/${damaged}`);
      expect(refused.body).not.toMatch(RAW_PARSER_TEXT);
      expect(existsSync(join(labDir, "amendments", `${original.reviewId}.r4.json`))).toBe(false);
    } finally {
      rmSync(join(labDir, "amendments", damaged));
    }
  });

  it("POST /api/coach-provisioning refuses (409, names the file) while the coach's own audit log is unreadable", async () => {
    mkdirSync(join(labDir, "provisioning-log"), { recursive: true });
    const damaged = "adj09-r2-coach-d.a1.json";
    writeFileSync(join(labDir, "provisioning-log", damaged), "{ broken");
    writeFileSync(join(labDir, "provisioning-log", "corrupt.json"), "{ not json");
    const action = {
      schemaVersion: 1,
      actionId: "adj09-r2-coach-d.a2",
      action: "provision",
      coachId: "adj09-r2-coach-d",
      performedBy: "adj09-r2-test-admin",
      performedAtIso: "2026-08-29T00:00:00.000Z",
      reason: "TEST-ONLY provisioning inside throwaway root",
      registryEntry: {
        coachId: "adj09-r2-coach-d",
        credentialRef: "adj09-r2-coach-d-cred",
        status: "active",
        provisionedAtIso: "2026-08-29T00:00:00.000Z",
        provisionedBy: "adj09-r2-test-admin",
        qualification: testQualification(),
      },
    };
    try {
      const result = await labPost("/api/coach-provisioning", action);
      expect(result.status, result.body).toBe(409);
      expect(result.body).toContain(`datasets/coach-review/provisioning-log/${damaged}`);
      expect(result.body).not.toMatch(RAW_PARSER_TEXT);
      expect(existsSync(join(labDir, "provisioning-log", "adj09-r2-coach-d.a2.json"))).toBe(false);
    } finally {
      rmSync(join(labDir, "provisioning-log", damaged));
    }
  });

  it("GET lists return 200 with the valid records and name the corrupt file (adjudications / amendments / drill mappings / provisioning log)", async () => {
    const cases = [
      {
        dir: "adjudications",
        route: "/api/coach-adjudications",
        key: "adjudications",
        id: "wm-dink-01-E1",
        idKey: "queueItemId",
      },
      {
        dir: "amendments",
        route: "/api/coach-review-amendments",
        key: "amendments",
        id: `wm-dink-01-E1.${LAB_COACHES[0]!.coachId}.r2`,
        idKey: "amendmentId",
      },
      {
        dir: "drill-mappings",
        route: "/api/drill-mapping-proposals",
        key: "proposals",
        id: "adj09-r2-proposal-1",
        idKey: "proposalId",
      },
      {
        dir: "provisioning-log",
        route: "/api/coach-provisioning",
        key: "log",
        id: "adj09-r2-coach-a.a1",
        idKey: "actionId",
      },
    ] as const;
    mkdirSync(join(labDir, "drill-mappings"), { recursive: true });
    writeFileSync(
      join(labDir, "drill-mappings", "adj09-r2-proposal-1.json"),
      JSON.stringify({ proposalId: "adj09-r2-proposal-1" }),
    );
    writeFileSync(join(labDir, "drill-mappings", "corrupt.json"), "{ not json");
    writeFileSync(
      join(labDir, "provisioning-log", "adj09-r2-coach-a.a1.json"),
      JSON.stringify({ actionId: "adj09-r2-coach-a.a1", coachId: "adj09-r2-coach-a" }),
    );
    for (const testCase of cases) {
      mkdirSync(join(labDir, testCase.dir), { recursive: true });
      writeFileSync(join(labDir, testCase.dir, "corrupt.json"), "{ not json");
      const result = await labFetch(testCase.route);
      expect(result.status, `${testCase.route}: ${result.body}`).toBe(200);
      expect(result.body).not.toMatch(RAW_PARSER_TEXT);
      const body = JSON.parse(result.body) as Record<string, unknown> & {
        invalidFiles: Array<{ file: string; message: string }>;
      };
      const records = body[testCase.key] as Array<Record<string, unknown>>;
      expect(
        records.map((record) => record[testCase.idKey]),
        testCase.route,
      ).toContain(testCase.id);
      expect(
        body.invalidFiles.map((entry) => entry.file),
        testCase.route,
      ).toEqual([`datasets/coach-review/${testCase.dir}/corrupt.json`]);
      expect(body.invalidFiles[0]!.message).toMatch(/JSON/);
    }
  });
});
