import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  minimalAnnotation,
  rawPost,
  startAnnotateServer,
  type AnnotateServer,
} from "./annotateServerHarness.js";

/**
 * Adversarial pass 3 (tester #3) — S4: POST /api/annotation with a traversal
 * captureBundle and a 50 MB body.
 *
 * Contracts under attack (annotate.ts):
 *   - safeBundle(): "Reject any path that escapes the bundles root" → the
 *     request must be answered 404/422 and NOTHING may be written outside
 *     the chosen bundle directory.
 *   - the request body is buffered with `body += chunk` and there is no cap
 *     → a 50 MB body must be refused early (413 / socket close) or, at
 *     minimum, must not grow the server's peak RSS by the size of the body.
 *
 * Memory is read from /proc/<pid>/status (VmHWM = peak RSS) of the real
 * server process. BOUNDED_GROWTH_KB is generous (16 MiB) so a server that
 * enforces any sane cap passes; a server that buffers the whole body cannot.
 */

const FIFTY_MB = 50 * 1024 * 1024;
const BOUNDED_GROWTH_KB = 16 * 1024;
const TEST_TIMEOUT_MS = 120_000;

let server: AnnotateServer;

beforeAll(async () => {
  server = await startAnnotateServer(["bundle-a", "bundle-b"]);
}, 60_000);

afterAll(async () => {
  await server.stop();
});

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...filesUnder(full));
    else out.push(full);
  }
  return out;
}

function hugeBody(bundle: string, sizeBytes: number, valid: boolean): Buffer {
  const skeleton = valid
    ? JSON.stringify(minimalAnnotation(bundle, "hugeposter", { notes: "@" }))
    : JSON.stringify({ captureBundle: bundle, annotatorId: "hugeposter", notes: "@" });
  const padding = Math.max(0, sizeBytes - Buffer.byteLength(skeleton) + 1);
  return Buffer.from(skeleton.replace('"notes":"@"', `"notes":"${"x".repeat(padding)}"`));
}

describe("S4 — traversal captureBundle values (small body)", () => {
  it.each([
    "../../etc",
    "..\\..\\etc",
    "/etc",
    "bundle-a/../../etc",
    "%2e%2e/etc",
    "bundle-a\u0000",
    "../../etc/passwd",
    "\u002e\u002e/\u002e\u002e/etc",
  ])("captureBundle %j → 404/422 and no file outside root", async (bundle) => {
    const before = filesUnder(server.root);
    const response = await rawPost(
      server.port,
      "/api/annotation",
      Buffer.from(JSON.stringify(minimalAnnotation(bundle, "traversal"))),
    );
    expect(response.status, response.body).toBeOneOf([404, 422]);
    expect(filesUnder(server.root)).toEqual(before);
    expect(existsSync("/etc/annotation")).toBe(false);
    expect(server.alive()).toBe(true);
  });

  it.each([
    ["bundle-a/../bundle-b", "bundle-b"],
    ["./bundle-a", "bundle-a"],
    ["bundle-a/", "bundle-a"],
  ])(
    "non-canonical but in-root captureBundle %j: either 422, or saved under %j WITH the persisted captureBundle canonicalised",
    async (bundle, canonical) => {
      const annotator = `canon${canonical.replace(/[^a-z0-9]/gi, "")}`;
      const response = await rawPost(
        server.port,
        "/api/annotation",
        Buffer.from(JSON.stringify(minimalAnnotation(bundle, annotator))),
      );
      if (response.status === 422 || response.status === 404) return; // strict — held.
      expect(response.status, response.body).toBe(200);
      const saved = join(server.root, canonical, "annotation", `${annotator}.json`);
      expect(existsSync(saved), `expected save under ${canonical}`).toBe(true);
      const record = JSON.parse(readFileSync(saved, "utf8")) as { captureBundle: string };
      // A record must name the bundle directory it lives in; otherwise
      // dataset export/joins on captureBundle silently miss it.
      expect(
        record.captureBundle,
        `persisted captureBundle for input ${JSON.stringify(bundle)}`,
      ).toBe(canonical);
    },
  );

  it("captureBundle '' / '.' must be rejected — normalize('') is '.', which IS the root", async () => {
    for (const bundle of ["", "."]) {
      const response = await rawPost(
        server.port,
        "/api/annotation",
        Buffer.from(JSON.stringify(minimalAnnotation(bundle, "rootwriter"))),
      );
      expect(
        response.status,
        `captureBundle=${JSON.stringify(bundle)} → ${response.body}`,
      ).toBeOneOf([404, 422]);
    }
    // The bundles ROOT must never receive an annotation directory of its own.
    expect(existsSync(join(server.root, "annotation"))).toBe(false);
  });

  it("a symlinked bundle must not let a save escape the bundles root", async () => {
    const outside = mkdtempSync(join(tmpdir(), "attack3-outside-"));
    try {
      symlinkSync(outside, join(server.root, "linked"));
      const response = await rawPost(
        server.port,
        "/api/annotation",
        Buffer.from(JSON.stringify(minimalAnnotation("linked", "escaper"))),
      );
      // Either refuse the symlink (404/422) or at least keep the write inside root.
      const escaped = existsSync(join(outside, "annotation", "escaper.json"));
      expect(
        escaped,
        `status=${response.status}; annotation written outside root at ${outside}`,
      ).toBe(false);
    } finally {
      rmSync(join(server.root, "linked"), { force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

/** Peak RSS is monotonic, so every memory measurement gets its own server. */
async function withFreshServer<T>(fn: (fresh: AnnotateServer) => Promise<T>): Promise<T> {
  const fresh = await startAnnotateServer(["bundle-a", "bundle-b"]);
  try {
    return await fn(fresh);
  } finally {
    await fresh.stop();
  }
}

describe("S4 — 50 MB bodies", () => {
  it(
    "traversal bundle + 50 MB body → 404/422/413 with bounded server memory",
    () =>
      withFreshServer(async (fresh) => {
        const peakBefore = fresh.peakRssKb();
        const started = Date.now();
        const response = await rawPost(
          fresh.port,
          "/api/annotation",
          hugeBody("../../etc", FIFTY_MB, false),
        );
        const elapsedMs = Date.now() - started;
        const peakAfter = fresh.peakRssKb();
        const growthKb = peakAfter - peakBefore;
        console.log(
          `[S4] traversal+50MB: status=${response.status} closedEarly=${response.socketClosedEarly} bytesWritten=${response.bytesWritten} elapsedMs=${elapsedMs} peakRss ${peakBefore}kB → ${peakAfter}kB (Δ ${growthKb}kB)`,
        );
        expect(fresh.alive()).toBe(true);
        if (!response.socketClosedEarly) {
          expect(response.status).toBeOneOf([404, 413, 422]);
        }
        expect(
          growthKb,
          `server peak RSS grew by ${growthKb}kB while handling a 50 MB body (no body cap)`,
        ).toBeLessThan(BOUNDED_GROWTH_KB);
      }),
    TEST_TIMEOUT_MS,
  );

  it(
    "VALID annotation with a 50 MB notes field → must be refused (413/422), not persisted to disk",
    async () => {
      const response = await rawPost(
        server.port,
        "/api/annotation",
        hugeBody("bundle-a", FIFTY_MB, true),
      );
      const saved = join(server.root, "bundle-a", "annotation", "hugeposter.json");
      const savedSize = existsSync(saved) ? statSync(saved).size : 0;
      console.log(
        `[S4] valid+50MB notes: status=${response.status} body=${response.body.slice(0, 80)} savedBytes=${savedSize}`,
      );
      expect(server.alive()).toBe(true);
      if (!response.socketClosedEarly) {
        expect(response.status).toBeOneOf([413, 422]);
      }
      expect(savedSize, `50 MB annotation persisted at ${saved}`).toBeLessThan(1024 * 1024);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "cancellation mid-flight: Content-Length 50 MB, 1 MB sent, socket destroyed → server survives and serves the next request",
    async () => {
      const aborted = await rawPost(
        server.port,
        "/api/annotation",
        hugeBody("bundle-b", FIFTY_MB, true),
        {
          abortAfterBytes: 1 << 20,
        },
      );
      expect(aborted.bytesWritten).toBeGreaterThanOrEqual(1 << 20);
      expect(server.alive()).toBe(true);
      const follow = await rawPost(
        server.port,
        "/api/annotation",
        Buffer.from(JSON.stringify(minimalAnnotation("bundle-b", "afterabort"))),
      );
      expect(follow.status).toBe(200);
      expect(JSON.parse(follow.body)).toEqual({ saved: true, revision: 1 });
      // The aborted upload must not have left a partial file behind.
      expect(existsSync(join(server.root, "bundle-b", "annotation", "hugeposter.json"))).toBe(
        false,
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "rapid repeats: 4 concurrent 8 MB junk bodies must not push peak RSS up by their combined size",
    () =>
      withFreshServer(async (fresh) => {
        const peakBefore = fresh.peakRssKb();
        const bodies = Array.from({ length: 4 }, () =>
          hugeBody("../../etc", 8 * 1024 * 1024, false),
        );
        const responses = await Promise.all(
          bodies.map((b) => rawPost(fresh.port, "/api/annotation", b)),
        );
        const growthKb = fresh.peakRssKb() - peakBefore;
        console.log(
          `[S4] 4×8MB concurrent: statuses=${responses.map((r) => r.status).join(",")} peakΔ=${growthKb}kB`,
        );
        expect(fresh.alive()).toBe(true);
        for (const r of responses) {
          if (!r.socketClosedEarly) expect(r.status).toBeOneOf([404, 413, 422]);
        }
        expect(growthKb).toBeLessThan(BOUNDED_GROWTH_KB);
      }),
    TEST_TIMEOUT_MS,
  );
});
