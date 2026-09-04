import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLabApiMiddleware } from "../labApi";

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
 *      with 400 promptly on every write route (never a hung request).
 */

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
