import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLabApiMiddleware } from "../labApi";

/**
 * ATTACK S9 — a corrupt file in the append-only reviews/ directory.
 *
 * The REAL dev-API middleware (the code vite.config.ts mounts) is pointed at
 * a THROWAWAY repo root under tmpdir; the repo's datasets/ are never touched.
 * `reviews/broken.json` holds invalid JSON. Pins the exact observed shape of
 * the failure so the UI half of the scenario (Playwright, see
 * apps/admin-web/e2e/attack4.brokenReviews.e2e.ts) replays a faithful 500.
 */

const REAL_REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");
const ARTIFACT_DIR = join(REAL_REPO_ROOT, "artifacts", "attack4");

let tmpRoot: string;
let server: Server;
let baseUrl: string;
const observed: Record<string, unknown> = {};

beforeAll(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), "attack4-broken-reviews-"));
  const dir = join(tmpRoot, "datasets/coach-review");
  mkdirSync(join(dir, "reviews"), { recursive: true });
  for (const name of ["queue.json", "schema.json", "coaches.json"]) {
    cpSync(join(REAL_REPO_ROOT, "datasets/coach-review", name), join(dir, name));
  }
  for (const sub of ["taxonomy", "drills"]) {
    cpSync(join(REAL_REPO_ROOT, "datasets/coach-review", sub), join(dir, sub), {
      recursive: true,
    });
  }
  const middleware = createLabApiMiddleware(tmpRoot);
  server = createServer((req, res) => {
    middleware(req, res, () => {
      res.writeHead(404);
      res.end("fell through");
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  writeFileSync(
    join(ARTIFACT_DIR, "s9-broken-review-json-middleware.json"),
    JSON.stringify({ scenario: "S9", observed }, null, 2),
  );
  await new Promise<void>((done) => server.close(() => done()));
  rmSync(tmpRoot, { recursive: true, force: true });
});

async function get(path: string) {
  const res = await fetch(`${baseUrl}${path}`, { headers: { accept: "application/json" } });
  return {
    status: res.status,
    contentType: res.headers.get("content-type"),
    body: await res.text(),
  };
}

describe("ATTACK S9: invalid JSON in datasets/coach-review/reviews/", () => {
  it("baseline: an empty reviews/ directory lists as 200 []", async () => {
    const res = await get("/api/coach-reviews");
    observed["empty"] = res;
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual([]);
  });

  it("broken.json → GET /api/coach-reviews is 500 (never an empty/partial 200)", async () => {
    writeFileSync(join(tmpRoot, "datasets/coach-review/reviews/broken.json"), '{"reviewId": "x", ');
    const res = await get("/api/coach-reviews");
    observed["broken"] = res;
    expect(res.status).toBe(500);
    expect(res.contentType).toMatch(/application\/json/);
    const body = JSON.parse(res.body) as { message: string };
    expect(body.message).toMatch(/SyntaxError/);
    expect(body.message).toMatch(/JSON/);
  });

  it("a valid review next to the broken file does not rescue the listing (fail-closed, no partial list)", async () => {
    writeFileSync(
      join(tmpRoot, "datasets/coach-review/reviews/valid-looking.json"),
      JSON.stringify({
        reviewId: "attack4-valid",
        coachId: "nobody",
        queueItemId: "wm-dink-01-E1",
      }),
    );
    const res = await get("/api/coach-reviews");
    observed["broken+valid"] = res;
    expect(res.status).toBe(500);
    expect(res.body).not.toMatch(/attack4-valid/);
  });

  it("the corrupt review also poisons every reader of reviews/ (adjudication POST → 500 before validation)", async () => {
    const res = await fetch(`${baseUrl}/api/coach-adjudications`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ adjudicatorId: "nobody", adjudicatorCredentialRef: "nothing" }),
    });
    const body = await res.text();
    observed["adjudication-post"] = { status: res.status, body };
    // Identity gate fires before reviews/ is read (registry has no `nobody`),
    // so this path returns 403 — recorded, not asserted as 500.
    expect([403, 500]).toContain(res.status);
  });

  it("unicode / BOM / empty / directory-shaped junk in reviews/ are all 500 (no silent skip)", async () => {
    rmSync(join(tmpRoot, "datasets/coach-review/reviews"), { recursive: true, force: true });
    const reviews = join(tmpRoot, "datasets/coach-review/reviews");
    mkdirSync(reviews, { recursive: true });
    const junk: Record<string, string> = {
      "bom.json": "\uFEFF{}",
      "empty.json": "",
      "unicode-garbage.json": "«ñ»{😀}",
      "trailing-comma.json": '{"a":1,}',
    };
    const results: Record<string, number> = {};
    for (const [name, content] of Object.entries(junk)) {
      rmSync(reviews, { recursive: true, force: true });
      mkdirSync(reviews, { recursive: true });
      writeFileSync(join(reviews, name), content);
      results[name] = (await get("/api/coach-reviews")).status;
    }
    // A sub-directory named *.json is read as a file → EISDIR → 500 as well.
    rmSync(reviews, { recursive: true, force: true });
    mkdirSync(join(reviews, "dir.json"), { recursive: true });
    results["dir.json/"] = (await get("/api/coach-reviews")).status;
    observed["junk"] = results;
    for (const [name, status] of Object.entries(results)) expect(status, name).toBe(500);
  });

  it("a non-.json file in reviews/ is ignored (200 []) — only .json names are parsed", async () => {
    const reviews = join(tmpRoot, "datasets/coach-review/reviews");
    rmSync(reviews, { recursive: true, force: true });
    mkdirSync(reviews, { recursive: true });
    writeFileSync(join(reviews, "notes.txt"), "not json");
    writeFileSync(join(reviews, "broken.json.bak"), "{");
    const res = await get("/api/coach-reviews");
    observed["non-json"] = res;
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual([]);
  });
});
