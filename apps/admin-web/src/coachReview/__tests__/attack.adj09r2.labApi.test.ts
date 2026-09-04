import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
 * ADJ-09 r2 adversarial suite (candidate 7b68c347). Every test here FAILS on
 * the candidate and pins a contract the fix itself states but does not meet:
 *
 *  - readBody(): "An oversized body is DRAINED (not destroyed) so the client
 *    always gets to read the 413 that follows." Above the 16 MB drain cap the
 *    request is destroyed BEFORE the 413 is written, so the client sees
 *    ECONNRESET — the original ADJ-09 (b) symptom at a bigger boundary. The
 *    server knows the size up front from content-length and could answer
 *    413 immediately (write the response, then destroy).
 *  - "labApi tolerates a damaged record file in EVERY reader": assignments.json
 *    (written by POST /api/coach-assignments) is still parsed with a bare
 *    JSON.parse, so one truncated write 500s both GET and POST of that route.
 *  - "a damaged file in that review's OWN amendment history is 409 (revision
 *    numbering depends on it)": only unparseable files count as damaged; a
 *    parseable object whose `revision` is not a number poisons the sequence
 *    (`revision must be NaN`) and no further amendment of that review is ever
 *    accepted.
 *
 * All against a THROWAWAY repo root under tmpdir — never the repo's datasets/.
 */

const REAL_REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");
const RAW_PARSER_TEXT = /SyntaxError|Unexpected token|Unexpected end|EISDIR|EACCES|ENOENT/;
const MiB = 1024 * 1024;

const LAB_COACHES = [
  { coachId: "adj09-atk-coach-a", credentialRef: "adj09-atk-cred-a" },
  { coachId: "adj09-atk-coach-b", credentialRef: "adj09-atk-cred-b" },
];

function testQualification(): CoachQualification {
  return {
    policyVersion: "coach-qualification-policy-v1",
    satisfiedCriteria: ["criterion.professional-coaching-history"],
    verdict: "qualified",
    assessedBy: "adj09-atk-test",
    assessedAtIso: "2026-08-29T00:00:00.000Z",
    certifications: [],
    professionalCoachingHistory: {
      statement: "TEST-ONLY fixture claim (throwaway root, not a real coach)",
      verification: {
        method: "document_reviewed",
        verifiedBy: "adj09-atk-test",
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
        provisionedBy: "adj09-atk-test",
      },
    },
  };
}

let root: string;
let labDir: string;
let server: Server;
let port: number;
let baseUrl: string;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "adj-09-r2-attack-"));
  labDir = join(root, "datasets/coach-review");
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
      note: "TEST-ONLY throwaway registry for ADJ-09 r2 adversarial tests. Not a real registry.",
      qualificationPolicy: {
        version: "coach-qualification-policy-v1",
        document: "docs/COACH_QUALIFICATION_POLICY.md",
      },
      coaches: LAB_COACHES.map((coach) => ({
        ...coach,
        status: "active",
        provisionedAtIso: "2026-08-29T00:00:00.000Z",
        provisionedBy: "adj09-atk-test",
        qualification: testQualification(),
      })),
    }),
  );
  const middleware = createLabApiMiddleware(root);
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
  rmSync(root, { recursive: true, force: true });
});

async function call(path: string, init?: RequestInit): Promise<{ status: number; body: string }> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    signal: AbortSignal.timeout(3_000),
  });
  return { status: response.status, body: await response.text() };
}
const post = (path: string, body: unknown) =>
  call(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/** Streams `mebibytes` MiB of body and reports what the CLIENT observes: a
 * status line or the socket error code. `contentLength` selects a declared
 * length (server knows the size before the first byte) vs chunked. */
function postLarge(mebibytes: number, contentLength: boolean): Promise<string> {
  return new Promise((resolvePromise) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: "/api/coach-reviews",
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(contentLength
            ? { "content-length": String(mebibytes * MiB) }
            : { "transfer-encoding": "chunked" }),
        },
      },
      (res) => {
        let text = "";
        res.on("data", (chunk: Buffer) => (text += chunk.toString("utf8")));
        res.on("end", () => resolvePromise(`status=${res.statusCode} body=${text}`));
      },
    );
    req.on("error", (error: NodeJS.ErrnoException) => resolvePromise(`error=${error.code}`));
    const chunk = Buffer.alloc(MiB, "x");
    let sent = 0;
    const pump = (): void => {
      while (sent < mebibytes) {
        sent += 1;
        if (!req.write(chunk)) {
          req.once("drain", pump);
          return;
        }
      }
      req.end();
    };
    pump();
  });
}

describe("ADJ-09 r2 attack: oversized bodies above the 16 MB drain cap", () => {
  it("content-length 17 MiB (size known before the first byte) still yields a 413, not ECONNRESET", async () => {
    const observed = await postLarge(17, true);
    expect(observed).toMatch(/^status=413 /);
    expect(observed).toContain("exceeds the 1000000-byte limit");
  });

  it("chunked 17 MiB still yields a 413, not ECONNRESET", async () => {
    const observed = await postLarge(17, false);
    expect(observed).toMatch(/^status=413 /);
  });
});

describe("ADJ-09 r2 attack: assignments.json is a record reader too", () => {
  const validAssignment = () => ({
    queueItemId: "wm-dink-01-E1",
    coachIds: [LAB_COACHES[0]!.coachId],
    assignedAtIso: "2026-09-04T00:00:00.000Z",
    assignedBy: "adj09-atk-test",
  });

  it("GET /api/coach-assignments with a truncated assignments.json is a controlled response naming the file, never a 500", async () => {
    writeFileSync(join(labDir, "assignments.json"), '{"schemaVersion":1,"assignments":[{"queueIte');
    try {
      const response = await call("/api/coach-assignments");
      expect(response.body).not.toMatch(RAW_PARSER_TEXT);
      expect(response.status).not.toBe(500);
      expect(response.body).toContain("assignments.json");
    } finally {
      rmSync(join(labDir, "assignments.json"), { force: true });
    }
  });

  it("POST /api/coach-assignments with a truncated assignments.json is a 4xx naming the file, never a 500", async () => {
    writeFileSync(join(labDir, "assignments.json"), '{"schemaVersion":1,"assignments":[{"queueIte');
    try {
      const response = await post("/api/coach-assignments", validAssignment());
      expect(response.body).not.toMatch(RAW_PARSER_TEXT);
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
      expect(response.body).toContain("assignments.json");
    } finally {
      rmSync(join(labDir, "assignments.json"), { force: true });
    }
  });
});

describe("ADJ-09 r2 attack: parseable-but-invalid amendment in a review's own history", () => {
  it("does not poison revision numbering (never `revision must be NaN`) and either refuses naming the file or ignores it", async () => {
    const review = labReview(0, "wm-dink-01-E1");
    const persisted = await post("/api/coach-reviews", review);
    expect(persisted.status).toBe(201);

    const amendmentsDir = join(labDir, "amendments");
    mkdirSync(amendmentsDir, { recursive: true });
    const damagedFile = `${review.reviewId}.r9.json`;
    // Valid JSON, a JSON object, but not an amendment record: `revision` is a string.
    writeFileSync(
      join(amendmentsDir, damagedFile),
      JSON.stringify({
        amendmentId: `${review.reviewId}.r9`,
        reviewId: review.reviewId,
        revision: "nine",
      }),
    );
    const amendment = {
      schemaVersion: 1,
      amendmentId: `${review.reviewId}.r2`,
      reviewId: review.reviewId,
      revision: 2,
      reason: "adversarial probe: first amendment beside a schema-invalid history file",
      review: { ...review, rationale: `${review.rationale} (amended)` },
      createdAtIso: "2026-09-04T00:00:00.000Z",
    };
    const response = await post("/api/coach-review-amendments", amendment);
    expect(response.body).not.toMatch(/NaN/);
    if (response.status === 409) {
      expect(response.body).toContain(damagedFile);
    } else {
      expect(response.status).toBe(201);
    }
  });
});
