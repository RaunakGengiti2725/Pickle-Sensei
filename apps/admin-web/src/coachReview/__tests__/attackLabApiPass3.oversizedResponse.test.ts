import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLabApiMiddleware } from "../labApi";

/**
 * Adversarial pass 3 — S6 follow-up (expected-behaviour pin).
 *
 * The lab API documents a 400 `invalid JSON body: Error: body too large`
 * for oversized uploads. This test asserts that a browser-style `fetch`
 * actually RECEIVES that response. It is intentionally strict: at
 * 4d812e1a `readBody` calls `req.destroy()` synchronously before the 400 is
 * written, so the client observes a connection reset (`TypeError: fetch
 * failed`) and never sees the message. Kept separate from the tolerant
 * suite so the failure is attributable.
 */
const REAL_REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");

let tmpRoot: string;
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), "attack3-labapi-oversize-"));
  const dir = join(tmpRoot, "datasets/coach-review");
  mkdirSync(dir, { recursive: true });
  for (const name of ["queue.json", "schema.json"]) {
    cpSync(join(REAL_REPO_ROOT, "datasets/coach-review", name), join(dir, name));
  }
  writeFileSync(
    join(dir, "coaches.json"),
    JSON.stringify({
      schemaVersion: 2,
      qualificationPolicy: { version: "coach-qualification-policy-v1", document: "x" },
      coaches: [],
    }),
  );
  const middleware = createLabApiMiddleware(tmpRoot);
  server = createServer((req, res) => middleware(req, res, () => res.writeHead(404).end()));
  await new Promise<void>((r) => server.listen(0, () => r()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("S6 oversized review body — the documented 400 must reach the client", () => {
  it("fetch() of a 1 048 577-byte body resolves to 400 'invalid JSON body: Error: body too large'", async () => {
    let outcome: { status: number; body: string } | { thrown: string };
    try {
      const response = await fetch(`${baseUrl}/api/coach-reviews`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: Buffer.alloc(1_048_577, 0x41),
      });
      outcome = { status: response.status, body: await response.text() };
    } catch (error) {
      outcome = {
        thrown: `${String(error)} / cause=${String((error as { cause?: unknown }).cause)}`,
      };
    }
    expect(outcome).toMatchObject({ status: 400 });
    expect((outcome as { body: string }).body).toContain(
      "invalid JSON body: Error: body too large",
    );
  }, 30_000);
});
