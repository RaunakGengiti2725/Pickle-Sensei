import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { Agent, createServer, request as httpRequest, type Server } from "node:http";
import { connect as netConnect } from "node:net";
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
 * ADJ-09 ADVERSARIAL probes against the candidate fix (ba0a80f6) — boundary
 * sizes, keep-alive/pipelining after a 413, mid-flight cancellation, raw
 * socket framing, concurrency, and the corrupt-review-file neighbourhood
 * (every OTHER code path that still parses reviews/). Throwaway root only.
 */

const REAL_REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");

const COACHES = [
  { coachId: "adj09-attack-coach-a", credentialRef: "adj09-attack-cred-a" },
  { coachId: "adj09-attack-coach-b", credentialRef: "adj09-attack-cred-b" },
  { coachId: "adj09-attack-coach-c", credentialRef: "adj09-attack-cred-c" },
];

function testQualification(): CoachQualification {
  return {
    policyVersion: "coach-qualification-policy-v1",
    satisfiedCriteria: ["criterion.professional-coaching-history"],
    verdict: "qualified",
    assessedBy: "adj09-attack-test",
    assessedAtIso: "2026-08-29T00:00:00.000Z",
    certifications: [],
    professionalCoachingHistory: {
      statement: "TEST-ONLY fixture claim (throwaway root, not a real coach)",
      verification: {
        method: "document_reviewed",
        verifiedBy: "adj09-attack-test",
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
let reviewsDir: string;
let server: Server;
let baseUrl: string;
let port: number;
const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown): void => {
  unhandled.push(reason);
};

beforeAll(async () => {
  process.on("unhandledRejection", onUnhandled);
  tmpRoot = mkdtempSync(join(tmpdir(), "adj-09-attack-"));
  const dir = join(tmpRoot, "datasets/coach-review");
  reviewsDir = join(dir, "reviews");
  mkdirSync(reviewsDir, { recursive: true });
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
      note: "TEST-ONLY throwaway registry for ADJ-09 attack probes.",
      qualificationPolicy: {
        version: "coach-qualification-policy-v1",
        document: "docs/COACH_QUALIFICATION_POLICY.md",
      },
      coaches: COACHES.map((coach) => ({
        ...coach,
        status: "active",
        provisionedAtIso: "2026-08-29T00:00:00.000Z",
        provisionedBy: "adj09-attack-test",
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
  port = (server.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  process.off("unhandledRejection", onUnhandled);
  await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  rmSync(tmpRoot, { recursive: true, force: true });
});

function testReview(coachIndex: number, queueItemId = "wm-dink-01-E1"): CoachReview {
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
        provisionedBy: "adj09-attack-test",
      },
    },
  };
}

interface Reply {
  status: number;
  contentType: string;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}

function rawPost(
  path: string,
  body: string | Buffer,
  options: { agent?: Agent; headers?: Record<string, string>; chunked?: boolean } = {},
): Promise<Reply> {
  return new Promise((resolvePromise, rejectPromise) => {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...options.headers,
    };
    if (options.chunked) headers["transfer-encoding"] = "chunked";
    else headers["content-length"] = String(Buffer.byteLength(body));
    const req = httpRequest(
      { host: "127.0.0.1", port, path, method: "POST", headers, agent: options.agent },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (text += chunk));
        res.on("end", () =>
          resolvePromise({
            status: res.statusCode ?? 0,
            contentType: res.headers["content-type"] ?? "",
            body: text,
            headers: res.headers,
          }),
        );
        res.on("error", rejectPromise);
      },
    );
    req.on("error", rejectPromise);
    req.end(body);
  });
}

async function fetchJson(path: string, init?: RequestInit): Promise<Reply> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    signal: AbortSignal.timeout(5_000),
  });
  return {
    status: response.status,
    contentType: response.headers.get("content-type") ?? "",
    body: await response.text(),
    headers: Object.fromEntries(response.headers.entries()),
  };
}

function objectOfBytes(totalBytes: number): string {
  const wrapper = JSON.stringify({ pad: "" });
  return JSON.stringify({ pad: "x".repeat(totalBytes - wrapper.length) });
}

describe("ADJ-09 attack: size boundaries", () => {
  it("accepts a body of EXACTLY 1_000_000 bytes on /api/coach-reviews (gate 403, not 413)", async () => {
    const body = objectOfBytes(1_000_000);
    expect(Buffer.byteLength(body)).toBe(1_000_000);
    const reply = await rawPost("/api/coach-reviews", body);
    expect(reply.status, reply.body).toBe(403);
  });

  it("rejects a body of 1_000_001 bytes with 413", async () => {
    const body = objectOfBytes(1_000_001);
    const reply = await rawPost("/api/coach-reviews", body);
    expect(reply.status, reply.body).toBe(413);
    expect(reply.headers.connection).toBe("close");
  });

  it("chunked body of exactly 1_000_000 bytes passes the size gate", async () => {
    const body = objectOfBytes(1_000_000);
    const reply = await rawPost("/api/coach-reviews", body, { chunked: true });
    expect(reply.status, reply.body).toBe(403);
  });

  it("chunked body of 1_000_001 bytes → 413", async () => {
    const reply = await rawPost("/api/coach-reviews", objectOfBytes(1_000_001), { chunked: true });
    expect(reply.status, reply.body).toBe(413);
  });

  it("multi-byte UTF-8: 400_000 chars of U+20AC (1.2 MB) counts BYTES, not chars → 413", async () => {
    const body = JSON.stringify({ pad: "€".repeat(400_000) });
    expect(body.length).toBeLessThan(1_000_000);
    expect(Buffer.byteLength(body)).toBeGreaterThan(1_000_000);
    const reply = await rawPost("/api/coach-reviews", body);
    expect(reply.status, reply.body).toBe(413);
  });

  it("/api/coach-assignments limit 100_000: 100_001 bytes → 413, 100_000 → not 413", async () => {
    const over = await rawPost("/api/coach-assignments", objectOfBytes(100_001));
    expect(over.status, over.body).toBe(413);
    const at = await rawPost("/api/coach-assignments", objectOfBytes(100_000));
    expect(at.status, at.body).not.toBe(413);
    expect(at.status, at.body).toBeLessThan(500);
  });

  it("content-length declared > limit but body is tiny JSON-valid prefix: server waits for the declared bytes, then 413", async () => {
    const body = objectOfBytes(1_000_500);
    const reply = await rawPost("/api/coach-reviews", body);
    expect(reply.status).toBe(413);
  });
});

describe("ADJ-09 attack: connection reuse / pipelining after 413 and 400", () => {
  it("keep-alive agent: 413 then two more requests on the same agent all succeed", async () => {
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    try {
      const big = await rawPost("/api/coach-reviews", objectOfBytes(1_100_000), { agent });
      expect(big.status).toBe(413);
      const small = await rawPost("/api/coach-reviews", "null", { agent });
      expect(small.status).toBe(400);
      const small2 = await rawPost("/api/coach-reviews", "[]", { agent });
      expect(small2.status).toBe(400);
    } finally {
      agent.destroy();
    }
  });

  it("raw socket: pipelined `null` + `[]` + oversized on ONE connection get 400, 400, 413 in order", async () => {
    const big = objectOfBytes(1_100_000);
    const reqs =
      `POST /api/coach-reviews HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 4\r\n\r\nnull` +
      `POST /api/coach-adjudications HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n[]` +
      `POST /api/coach-reviews HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: ${big.length}\r\n\r\n${big}`;
    const text = await new Promise<string>((resolvePromise, rejectPromise) => {
      const socket = netConnect(port, "127.0.0.1", () => socket.write(reqs));
      let out = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => (out += chunk));
      socket.on("end", () => resolvePromise(out));
      socket.on("close", () => resolvePromise(out));
      socket.on("error", rejectPromise);
      setTimeout(() => {
        socket.destroy();
        rejectPromise(new Error(`timeout; got so far: ${out.slice(0, 500)}`));
      }, 5_000);
    });
    const statuses = [...text.matchAll(/HTTP\/1\.1 (\d{3})/g)].map((m) => Number(m[1]));
    expect(statuses).toEqual([400, 400, 413]);
  });
});

describe("ADJ-09 attack: mid-flight cancellation and malformed framing", () => {
  it("client aborts a chunked upload halfway: server survives, logs, and serves the next request", async () => {
    await new Promise<void>((resolvePromise) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port,
          path: "/api/coach-reviews",
          method: "POST",
          headers: { "content-type": "application/json", "transfer-encoding": "chunked" },
        },
        () => resolvePromise(),
      );
      req.on("error", () => resolvePromise());
      req.write('{"pad":"' + "x".repeat(500_000));
      setTimeout(() => {
        req.destroy();
        setTimeout(resolvePromise, 50);
      }, 20);
    });
    const after = await fetchJson("/api/coach-reviews");
    expect(after.status).toBe(200);
    expect(unhandled).toEqual([]);
  });

  it("client aborts an OVERSIZED chunked upload (already past the limit): server survives", async () => {
    await new Promise<void>((resolvePromise) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port,
          path: "/api/coach-reviews",
          method: "POST",
          headers: { "content-type": "application/json", "transfer-encoding": "chunked" },
        },
        () => resolvePromise(),
      );
      req.on("error", () => resolvePromise());
      req.write('{"pad":"' + "x".repeat(1_200_000), () => {
        setTimeout(() => {
          req.destroy();
          setTimeout(resolvePromise, 50);
        }, 20);
      });
    });
    const after = await fetchJson("/api/coach-reviews");
    expect(after.status).toBe(200);
    expect(unhandled).toEqual([]);
  });

  it("client declares content-length 1.1 MB but sends only 100 KB then closes: server survives", async () => {
    await new Promise<void>((resolvePromise) => {
      const socket = netConnect(port, "127.0.0.1", () => {
        socket.write(
          `POST /api/coach-reviews HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 1100000\r\n\r\n` +
            '{"pad":"' +
            "x".repeat(100_000),
          () => setTimeout(() => socket.destroy(), 20),
        );
      });
      socket.on("close", () => setTimeout(resolvePromise, 50));
      socket.on("error", () => undefined);
    });
    const after = await fetchJson("/api/coach-reviews");
    expect(after.status).toBe(200);
    expect(unhandled).toEqual([]);
  });

  it("Expect: 100-continue with a 1.1 MB body still gets a 413 JSON", async () => {
    const reply = await rawPost("/api/coach-reviews", objectOfBytes(1_100_000), {
      headers: { expect: "100-continue" },
    });
    expect(reply.status).toBe(413);
    expect(reply.contentType).toContain("application/json");
  });

  it("empty body (content-length: 0) → 400 on every write route", async () => {
    for (const route of [
      "/api/coach-reviews",
      "/api/coach-adjudications",
      "/api/coach-review-amendments",
      "/api/coach-assignments",
      "/api/drill-mapping-proposals",
      "/api/coach-provisioning",
    ]) {
      const reply = await rawPost(route, "");
      expect(reply.status, `${route}: ${reply.body}`).toBe(400);
    }
  });

  it("UTF-8 BOM prefix and invalid UTF-8 bytes → 400, never 500", async () => {
    const bom = await rawPost(
      "/api/coach-reviews",
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("{}")]),
    );
    expect(bom.status, bom.body).toBe(400);
    const bad = await rawPost("/api/coach-reviews", Buffer.from([0x7b, 0xff, 0xfe, 0x7d]));
    expect(bad.status, bad.body).toBe(400);
  });

  it("nested-object bodies with prototype keys are just objects (no 500)", async () => {
    const reply = await rawPost(
      "/api/coach-reviews",
      '{"__proto__":{"coachId":"adj09-attack-coach-a"},"constructor":{"prototype":{}}}',
    );
    expect(reply.status, reply.body).toBe(403);
  });

  it("body `{}` on every write route is answered with 4xx, never 500", async () => {
    for (const route of [
      "/api/coach-reviews",
      "/api/coach-adjudications",
      "/api/coach-review-amendments",
      "/api/coach-assignments",
      "/api/drill-mapping-proposals",
      "/api/coach-provisioning",
    ]) {
      const reply = await rawPost(route, "{}");
      expect(reply.status, `${route}: ${reply.body}`).toBeGreaterThanOrEqual(400);
      expect(reply.status, `${route}: ${reply.body}`).toBeLessThan(500);
    }
  });
});

describe("ADJ-09 attack: concurrency", () => {
  it("16 concurrent 1.1 MB posts all get 413; 16 concurrent `null` posts all get 400; list still works", async () => {
    const bigs = Array.from({ length: 16 }, () =>
      rawPost("/api/coach-reviews", objectOfBytes(1_100_000)),
    );
    const nulls = Array.from({ length: 16 }, () => rawPost("/api/coach-adjudications", "null"));
    const results = await Promise.all([...bigs, ...nulls]);
    expect(results.slice(0, 16).map((r) => r.status)).toEqual(Array(16).fill(413));
    expect(results.slice(16).map((r) => r.status)).toEqual(Array(16).fill(400));
    expect((await fetchJson("/api/coach-reviews")).status).toBe(200);
  });
});

describe("ADJ-09 attack: corrupt review file neighbourhood", () => {
  const corruptName = "zz-corrupt.json";
  const nullName = "zz-null.json";
  const arrayName = "zz-array.json";
  const dirName = "zz-dir.json";
  const unreadableName = "zz-unreadable.json";

  beforeAll(async () => {
    // two valid, persisted reviews from provisioned test coaches (so adjudication is possible)
    const a = await rawPost("/api/coach-reviews", JSON.stringify(testReview(0)));
    expect(a.status, a.body).toBe(201);
    const b = await rawPost("/api/coach-reviews", JSON.stringify(testReview(1)));
    expect(b.status, b.body).toBe(201);
    writeFileSync(join(reviewsDir, corruptName), "{ not json");
    writeFileSync(join(reviewsDir, nullName), "null");
    writeFileSync(join(reviewsDir, arrayName), "[]");
    mkdirSync(join(reviewsDir, dirName));
    writeFileSync(join(reviewsDir, unreadableName), "{}");
    chmodSync(join(reviewsDir, unreadableName), 0o000);
  });

  afterAll(() => {
    chmodSync(join(reviewsDir, unreadableName), 0o644);
  });

  it("GET /api/coach-reviews lists both valid reviews and names every damaged entry (incl. a directory and an unreadable file)", async () => {
    const reply = await fetchJson("/api/coach-reviews");
    expect(reply.status, reply.body).toBe(200);
    const body = JSON.parse(reply.body) as {
      reviews: Array<{ file: string }>;
      invalidFiles: Array<{ file: string; message: string }>;
    };
    expect(body.reviews.map((e) => e.file).sort()).toEqual(
      [testReview(0).reviewId, testReview(1).reviewId]
        .map((id) => `datasets/coach-review/reviews/${id}.json`)
        .sort(),
    );
    const invalid = body.invalidFiles.map((e) => e.file.split("/").pop()).sort();
    const expectedInvalid = [corruptName, nullName, arrayName, dirName];
    if (process.getuid?.() !== 0) expectedInvalid.push(unreadableName);
    expect(invalid).toEqual(expectedInvalid.sort());
    expect(reply.body).not.toMatch(/SyntaxError|Unexpected token|EISDIR|EACCES/);
  });

  it("POST /api/coach-adjudications by a third coach with one corrupt review file present must not 500", async () => {
    const record = {
      schemaVersion: 1,
      queueItemId: "wm-dink-01-E1",
      adjudicatorId: COACHES[2]!.coachId,
      adjudicatorCredentialRef: COACHES[2]!.credentialRef,
      reviewedReviewIds: [testReview(0).reviewId, testReview(1).reviewId],
      outcome: { kind: "uphold", reviewId: testReview(0).reviewId },
      rationale: "attack probe rationale long enough to satisfy the twenty char gate",
      evidenceTimestampsMs: [],
      createdAtIso: "2026-08-29T00:00:00.000Z",
    };
    const reply = await rawPost("/api/coach-adjudications", JSON.stringify(record));
    expect(reply.status, reply.body).not.toBe(500);
    expect(reply.body).not.toMatch(/SyntaxError|Unexpected token/);
  });

  it("POST /api/coach-review-amendments whose base review file is corrupt must not 500", async () => {
    const original = testReview(0);
    writeFileSync(join(reviewsDir, "zz-base.adj09-attack-coach-a.json"), "{ broken");
    const amendment = {
      schemaVersion: 1,
      amendmentId: "zz-base.adj09-attack-coach-a.r2",
      reviewId: "zz-base.adj09-attack-coach-a",
      revision: 2,
      reason: "attack probe amendment against a damaged base file",
      review: { ...original, reviewId: "zz-base.adj09-attack-coach-a", confidence: 0.5 },
      createdAtIso: "2026-08-29T00:00:00.000Z",
    };
    const reply = await rawPost("/api/coach-review-amendments", JSON.stringify(amendment));
    expect(reply.status, reply.body).not.toBe(500);
    expect(reply.body).not.toMatch(/SyntaxError|Unexpected token/);
  });

  it("a corrupt adjudication / amendment / drill-mapping / provisioning-log file must not 500 its GET list", async () => {
    for (const [dir, route] of [
      ["adjudications", "/api/coach-adjudications"],
      ["amendments", "/api/coach-review-amendments"],
      ["drill-mappings", "/api/drill-mapping-proposals"],
      ["provisioning-log", "/api/coach-provisioning"],
    ] as const) {
      const target = join(tmpRoot, "datasets/coach-review", dir);
      mkdirSync(target, { recursive: true });
      writeFileSync(join(target, "zz-corrupt.json"), "{ not json");
      try {
        const reply = await fetchJson(route);
        expect(reply.status, `${route}: ${reply.body}`).not.toBe(500);
      } finally {
        rmSync(join(target, "zz-corrupt.json"));
      }
    }
  });

  it("sanity: the reviews dir still holds exactly the files we expect", () => {
    expect(readdirSync(reviewsDir).length).toBeGreaterThanOrEqual(7);
  });
});
