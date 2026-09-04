import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLabApiMiddleware } from "../labApi";

/**
 * ADJUDICATION reproductions (area: services-api-legacy-admin-web) against the
 * REAL Coach Review Lab dev-API middleware (the exact code vite.config.ts
 * mounts), pointed at a THROWAWAY root under tmpdir — never the repo's
 * datasets/. Each `it` asserts the correct behaviour; a failure is the
 * reproduced defect.
 */

const REAL_REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");

let tmpRoot: string;
let server: Server;
let baseUrl: string;
let reviewsDir: string;

beforeAll(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), "adjudicate-labapi-"));
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
      note: "TEST-ONLY throwaway registry (adjudication). Not a real registry.",
      qualificationPolicy: {
        version: "coach-qualification-policy-v1",
        document: "docs/COACH_QUALIFICATION_POLICY.md",
      },
      coaches: [],
    }),
  );
  reviewsDir = join(dir, "reviews");
  mkdirSync(reviewsDir, { recursive: true });

  const middleware = createLabApiMiddleware(tmpRoot);
  server = createServer((req, res) => {
    middleware(req, res, () => {
      res.writeHead(404);
      res.end("fell through");
    });
  });
  await new Promise<void>((r) => server.listen(0, () => r()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(tmpRoot, { recursive: true, force: true });
});

interface RawResult {
  status: number | null;
  body: string;
  error: string | null;
}

/** Raw http client: distinguishes an HTTP status from a destroyed socket / hang. */
function rawPost(path: string, body: Buffer | string, timeoutMs: number): Promise<RawResult> {
  return new Promise((resolvePromise) => {
    const url = new URL(path, baseUrl);
    const req = httpRequest(
      {
        host: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolvePromise({
            status: res.statusCode ?? null,
            body: Buffer.concat(chunks).toString("utf8"),
            error: null,
          }),
        );
        res.on("error", (e) =>
          resolvePromise({ status: res.statusCode ?? null, body: "", error: String(e) }),
        );
      },
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`client timeout after ${timeoutMs}ms — server never answered`));
    });
    req.on("error", (e: NodeJS.ErrnoException) =>
      resolvePromise({ status: null, body: "", error: e.code ?? e.message }),
    );
    req.end(body);
  });
}

describe("ADJUDICATE Coach Review Lab dev API", () => {
  it("ADJ-LAB-CORRUPT: one unparseable review file must not take down GET /api/coach-reviews", async () => {
    writeFileSync(
      join(reviewsDir, "good.json"),
      JSON.stringify({ reviewId: "good", coachId: "x" }),
    );
    writeFileSync(join(reviewsDir, "corrupt.json"), "{ this is not json");
    const res = await fetch(`${baseUrl}/api/coach-reviews`);
    const text = await res.text();
    console.log(`ADJ-LAB-CORRUPT: GET /api/coach-reviews → ${res.status} ${text.slice(0, 160)}`);
    rmSync(join(reviewsDir, "corrupt.json"));
    rmSync(join(reviewsDir, "good.json"));
    expect(
      res.status,
      "the list must still be served (200) with the bad file reported/skipped",
    ).toBe(200);
  });

  it("ADJ-LAB-OVERSIZE: a body above the limit gets an HTTP 413/400, not a destroyed socket", async () => {
    const big = Buffer.alloc(1_100_000, 0x61); // 1.1 MB > 1_000_000 limit on /api/coach-reviews
    const res = await rawPost("/api/coach-reviews", big, 5_000);
    console.log(
      `ADJ-LAB-OVERSIZE: 1.1MB POST → status=${res.status} error=${res.error} body=${res.body.slice(0, 120)}`,
    );
    expect(res.error, "client must receive an HTTP response, not a socket error").toBeNull();
    expect([400, 413]).toContain(res.status);
  });

  it("ADJ-LAB-NULL: a JSON body of literal `null` gets a 400, and the request does not hang", async () => {
    const results: Record<string, RawResult> = {};
    for (const route of [
      "/api/coach-reviews",
      "/api/coach-adjudications",
      "/api/coach-review-amendments",
      "/api/coach-assignments",
    ]) {
      results[route] = await rawPost(route, "null", 3_000);
    }
    console.log(
      `ADJ-LAB-NULL: ${JSON.stringify(Object.fromEntries(Object.entries(results).map(([k, v]) => [k, { status: v.status, error: v.error }])))}`,
    );
    for (const [route, res] of Object.entries(results)) {
      expect(res.error, `${route}: server must answer (no hang)`).toBeNull();
      expect(res.status, route).toBe(400);
    }
  }, 30_000);
});
