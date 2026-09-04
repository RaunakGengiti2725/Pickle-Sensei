import {
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
 * Adversarial pass 3 (tester #2) — Coach Review Lab dev API, real middleware,
 * THROWAWAY repo root under tmpdir (never the repo's datasets/).
 *
 *   S6  1 048 577-byte review body → refused, nothing written
 *   S7  amendment revision 3 when only revision 1 exists / coachId ≠ original
 *       → both refused, base review file byte-identical
 *   +   boundary bodies (1 000 000 / 1 000 001), rapid repeats, interleaving,
 *       path-traversal reviewId, unicode, snapshot smuggling
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
    assessedBy: "attack3-test",
    assessedAtIso: "2026-08-29T00:00:00.000Z",
    certifications: [],
    professionalCoachingHistory: {
      statement: "TEST-ONLY fixture claim (throwaway root, not a real coach)",
      verification: {
        method: "document_reviewed",
        verifiedBy: "attack3-test",
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
let port: number;

const REVIEWS = () => join(tmpRoot, "datasets/coach-review/reviews");
const AMENDMENTS = () => join(tmpRoot, "datasets/coach-review/amendments");

/** Recursive snapshot of every file under the throwaway root: path → bytes. */
function snapshotTree(dir: string, out = new Map<string, Buffer>()): Map<string, Buffer> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) snapshotTree(p, out);
    else out.set(p, readFileSync(p));
  }
  return out;
}

function expectTreeUnchanged(before: Map<string, Buffer>): void {
  const after = snapshotTree(tmpRoot);
  expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
  for (const [p, bytes] of before) expect(after.get(p)!.equals(bytes), p).toBe(true);
}

beforeAll(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), "attack3-labapi-"));
  const dir = join(tmpRoot, "datasets/coach-review");
  mkdirSync(dir, { recursive: true });
  for (const name of ["queue.json", "schema.json"]) {
    cpSync(join(REAL_REPO_ROOT, "datasets/coach-review", name), join(dir, name));
  }
  for (const sub of ["taxonomy", "drills"]) {
    cpSync(join(REAL_REPO_ROOT, "datasets/coach-review", sub), join(dir, sub), { recursive: true });
  }
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
        provisionedAtIso: "2026-08-29T00:00:00.000Z",
        provisionedBy: "attack3-test",
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
  await new Promise<void>((r) => server.listen(0, () => r()));
  port = (server.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
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
        provisionedBy: "attack3-test",
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

/** Raw HTTP POST that reports EITHER the response OR the socket error, so a
 * server that destroys the connection mid-upload is observable as such. */
type RawResult = { status?: number | undefined; body?: string; error?: string };

function rawPost(path: string, body: Buffer): Promise<RawResult> {
  return new Promise((resolvePromise) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: { "content-type": "application/json", "content-length": body.length },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolvePromise({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }),
        );
        res.on("error", (e) => resolvePromise({ status: res.statusCode, error: String(e) }));
      },
    );
    req.on("error", (e: NodeJS.ErrnoException) =>
      resolvePromise({ error: `${e.code ?? ""} ${e.message}` }),
    );
    req.end(body);
  });
}

function amendmentFor(original: CoachReview, revision: number, review: CoachReview) {
  return {
    schemaVersion: 1,
    amendmentId: `${original.reviewId}.r${revision}`,
    reviewId: original.reviewId,
    revision,
    reason: "attack pass 3 — adversarial amendment attempt (≥10 chars)",
    review,
    createdAtIso: "2026-08-29T00:00:00.000Z",
  };
}

// ------------------------------------------------------------------ S6 ----
describe("S6 oversized review body", () => {
  it("1 048 577 bytes of a syntactically VALID review → refused, nothing written", async () => {
    const before = snapshotTree(tmpRoot);
    const review = testReview(0, "wm-volley-02-E1");
    const target = 1_048_577;
    // pad rationale (ASCII) so the whole body is exactly `target` BYTES
    const paddedBytes = Buffer.byteLength(JSON.stringify({ ...review, rationale: "" }));
    const body = Buffer.from(
      JSON.stringify({ ...review, rationale: "x".repeat(target - paddedBytes) }),
    );
    expect(body.length).toBe(target);
    expect(Buffer.byteLength(JSON.stringify(review))).toBeLessThan(1_000_000);

    const result = await rawPost("/api/coach-reviews", body);
    // The server destroys the socket after exceeding the limit; whichever way
    // the client observes that, it is NOT a 2xx and NOTHING is written.
    if (result.status !== undefined) {
      expect(result.status).toBe(400);
      expect(result.body).toContain("invalid JSON body: Error: body too large");
    } else {
      expect(result.error).toMatch(/ECONNRESET|EPIPE|socket hang up/);
    }
    console.log(`[observe S6 valid-json 1048577B] ${JSON.stringify(result).slice(0, 200)}`);
    expectTreeUnchanged(before);
    expect(existsSync(join(REVIEWS(), `${review.reviewId}.json`))).toBe(false);
  }, 30_000);

  it("1 048 577 bytes of garbage → refused, nothing written", async () => {
    const before = snapshotTree(tmpRoot);
    const result = await rawPost("/api/coach-reviews", Buffer.alloc(1_048_577, 0x41));
    if (result.status !== undefined) {
      expect(result.status).toBe(400);
      expect(result.body).toContain("body too large");
    } else {
      expect(result.error).toMatch(/ECONNRESET|EPIPE|socket hang up/);
    }
    console.log(`[observe S6 garbage 1048577B] ${JSON.stringify(result).slice(0, 200)}`);
    expectTreeUnchanged(before);
  }, 30_000);

  it("boundary: 1 000 001 bytes refused, 1 000 000 bytes reaches the JSON parser", async () => {
    const before = snapshotTree(tmpRoot);
    const over = await rawPost("/api/coach-reviews", Buffer.alloc(1_000_001, 0x20));
    expect(over.status === 400 || over.error !== undefined).toBe(true);
    if (over.status !== undefined) expect(over.body).toContain("body too large");
    // exactly the limit: whitespace-only → JSON parse error (400), NOT "too large"
    const exact = await rawPost("/api/coach-reviews", Buffer.alloc(1_000_000, 0x20));
    expect(exact.status).toBe(400);
    expect(exact.body).toContain("invalid JSON body");
    expect(exact.body).not.toContain("body too large");
    expectTreeUnchanged(before);
  }, 30_000);

  it("rapid repeat: 20 concurrent oversized uploads → server stays up, nothing written, valid post still works", async () => {
    const before = snapshotTree(tmpRoot);
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        rawPost("/api/coach-reviews", Buffer.alloc(1_048_577, 0x7b)),
      ),
    );
    for (const r of results) expect(r.status === 400 || r.error !== undefined).toBe(true);
    expectTreeUnchanged(before);
    const ok = await post("/api/coach-reviews", JSON.stringify(testReview(1, "afn-vic-rally1-E1")));
    expect(ok.status, ok.body).toBe(201);
  }, 60_000);

  it("Content-Length lies (declares 10 bytes, sends 1 048 577) → still refused, nothing written", async () => {
    const before = snapshotTree(tmpRoot);
    const body = Buffer.alloc(1_048_577, 0x41);
    const result = await new Promise<RawResult>((resolvePromise) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port,
          path: "/api/coach-reviews",
          method: "POST",
          headers: { "content-type": "application/json", "content-length": 10 },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolvePromise({ status: res.statusCode }));
        },
      );
      req.on("error", (e) => resolvePromise({ error: String(e) }));
      req.write(body, () => req.end());
    });
    expect(result.status === undefined || result.status >= 400).toBe(true);
    expectTreeUnchanged(before);
  }, 30_000);
});

// ------------------------------------------------------------------ S7 ----
describe("S7 amendment tampering against a persisted base review", () => {
  const original = testReview(0); // wm-dink-01-E1 by coach A
  let basePath: string;
  let baseBytes: Buffer;

  beforeAll(async () => {
    const created = await post("/api/coach-reviews", JSON.stringify(original));
    expect(created.status, created.body).toBe(201);
    basePath = join(REVIEWS(), `${original.reviewId}.json`);
    baseBytes = readFileSync(basePath);
    expect(existsSync(AMENDMENTS())).toBe(false);
  });

  const assertBaseIntact = () => {
    expect(readFileSync(basePath).equals(baseBytes)).toBe(true);
    const amendmentFiles = existsSync(AMENDMENTS()) ? readdirSync(AMENDMENTS()) : [];
    return amendmentFiles;
  };

  it("revision 3 when only revision 1 exists → 409 'revision must be 2', nothing written", async () => {
    const before = snapshotTree(tmpRoot);
    const result = await post(
      "/api/coach-review-amendments",
      JSON.stringify(amendmentFor(original, 3, { ...original, confidence: 0.1 })),
    );
    expect(result.status).toBe(409);
    expect(result.body).toContain("revision must be 2 (append-only, sequential)");
    expect(assertBaseIntact()).toEqual([]);
    expectTreeUnchanged(before);
  });

  it("revision 2 by the ORIGINAL coach but with a stranger's coachId embedded → refused, base intact", async () => {
    const before = snapshotTree(tmpRoot);
    const impostor = TEST_COACHES[1]!;
    // Fully consistent impostor identity (valid registry entry + matching
    // snapshot) so only the "same coach as the base review" gate can stop it.
    const review: CoachReview = {
      ...original,
      coachId: impostor.coachId,
      coachCredentialRef: impostor.credentialRef,
      provenance: {
        ...original.provenance,
        coachQualificationSnapshot: {
          ...original.provenance.coachQualificationSnapshot,
          coachId: impostor.coachId,
          credentialRef: impostor.credentialRef,
        },
      },
    };
    const result = await post(
      "/api/coach-review-amendments",
      JSON.stringify(amendmentFor(original, 2, review)),
    );
    expect(result.status).toBe(403);
    expect(result.body).toContain("only the original reviewing coach can amend their review");
    expect(assertBaseIntact()).toEqual([]);
    expectTreeUnchanged(before);
  });

  it("coachId of the original but the impostor's credentialRef → 403, nothing written", async () => {
    const before = snapshotTree(tmpRoot);
    const review = { ...original, coachCredentialRef: TEST_COACHES[1]!.credentialRef };
    const result = await post(
      "/api/coach-review-amendments",
      JSON.stringify(amendmentFor(original, 2, review)),
    );
    expect(result.status).toBe(403);
    expect(assertBaseIntact()).toEqual([]);
    expectTreeUnchanged(before);
  });

  it("snapshot smuggling: original coach with a fabricated provisionedBy → 422, nothing written", async () => {
    const before = snapshotTree(tmpRoot);
    const review: CoachReview = {
      ...original,
      provenance: {
        ...original.provenance,
        coachQualificationSnapshot: {
          ...original.provenance.coachQualificationSnapshot,
          provisionedBy: "someone-else",
        },
      },
    };
    const result = await post(
      "/api/coach-review-amendments",
      JSON.stringify(amendmentFor(original, 2, review)),
    );
    expect(result.status).toBe(422);
    expect(assertBaseIntact()).toEqual([]);
    expectTreeUnchanged(before);
  });

  for (const revision of [0, 1, -1, 2.5, Number.MAX_SAFE_INTEGER, NaN]) {
    it(`revision ${String(revision)} → refused (409/422), nothing written`, async () => {
      const before = snapshotTree(tmpRoot);
      const payload = amendmentFor(original, revision, { ...original, confidence: 0.2 });
      const result = await post("/api/coach-review-amendments", JSON.stringify(payload));
      expect([409, 422]).toContain(result.status);
      expect(assertBaseIntact()).toEqual([]);
      expectTreeUnchanged(before);
    });
  }

  it("revision as a numeric string '2' → refused, nothing written", async () => {
    const before = snapshotTree(tmpRoot);
    const payload = { ...amendmentFor(original, 2, original), revision: "2" };
    const result = await post("/api/coach-review-amendments", JSON.stringify(payload));
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(assertBaseIntact()).toEqual([]);
    expectTreeUnchanged(before);
  });

  it("path-traversal reviewId never writes outside amendments/ and never overwrites the base", async () => {
    const before = snapshotTree(tmpRoot);
    for (const reviewId of [
      `../reviews/${original.reviewId}`,
      `../../coach-review/reviews/${original.reviewId}`,
      `${original.reviewId}\u0000`,
      "../coaches",
    ]) {
      const payload = {
        ...amendmentFor(original, 2, { ...original, reviewId, confidence: 0.3 }),
        reviewId,
        amendmentId: `${reviewId}.r2`,
      };
      const result = await post("/api/coach-review-amendments", JSON.stringify(payload));
      expect(result.status, `${reviewId} → ${result.body}`).toBeGreaterThanOrEqual(400);
      expect(result.status, `${reviewId} → ${result.body}`).not.toBe(500);
    }
    expect(assertBaseIntact()).toEqual([]);
    expectTreeUnchanged(before);
  });

  it("interleaving: 10 concurrent revision-2 amendments → exactly one persisted, rest 409, base intact", async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        post(
          "/api/coach-review-amendments",
          JSON.stringify(amendmentFor(original, 2, { ...original, confidence: (i + 1) / 20 })),
        ),
      ),
    );
    const created = results.filter((r) => r.status === 201);
    const conflicts = results.filter((r) => r.status === 409);
    expect(created.length).toBe(1);
    expect(conflicts.length).toBe(9);
    expect(assertBaseIntact()).toEqual([`${original.reviewId}.r2.json`]);
    // Rapid follow-up: now revision 3 is the only acceptable next revision.
    const r4 = await post(
      "/api/coach-review-amendments",
      JSON.stringify(amendmentFor(original, 4, { ...original, confidence: 0.9 })),
    );
    expect(r4.status).toBe(409);
    expect(r4.body).toContain("revision must be 3");
    expect(assertBaseIntact()).toEqual([`${original.reviewId}.r2.json`]);
  });

  it("unicode reason / huge reason → schema-validated, never 500, base intact", async () => {
    const before = snapshotTree(tmpRoot);
    for (const reason of ["🥒".repeat(5), "\u202e" + "a".repeat(20), "z".repeat(500_000)]) {
      const payload = { ...amendmentFor(original, 3, { ...original, confidence: 0.4 }), reason };
      const result = await post("/api/coach-review-amendments", JSON.stringify(payload));
      expect(result.status).not.toBe(500);
      if (result.status === 201) {
        // a long/unicode reason is legal — it must land as revision 3 only once
        expect(readdirSync(AMENDMENTS())).toContain(`${original.reviewId}.r3.json`);
        break;
      }
    }
    expect(readFileSync(basePath).equals(baseBytes)).toBe(true);
    // base review bytes never change regardless of what amendments landed
    expect(snapshotTree(tmpRoot).get(basePath)!.equals(before.get(basePath)!)).toBe(true);
  });
});
