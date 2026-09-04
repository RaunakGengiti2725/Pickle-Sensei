import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Structural audit (pass 1, auditor #2) — the `lab:annotate` HTTP server
 * (src/annotate.ts). The module has no tests; this file drives the real
 * process over loopback. Mapper hints under test: traversal guard, 422 path,
 * "read-modify-write revision race" on concurrent POSTs, and unbounded body
 * buffering. A FAILING test is a reproduced finding on 4d812e1a; a passing
 * one refutes the hint.
 */

const root = mkdtempSync(join(tmpdir(), "audit-annotate-"));
const pkgDir = join(import.meta.dirname, "..");
let child: ChildProcess | null = null;
let port = 0;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const chosen = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(chosen));
    });
  });
}

function annotation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    captureBundle: "bundle-a",
    annotatorId: "auditor",
    stroke: "unsure",
    analyzable: true,
    annotatorConfidence: 0.5,
    faults: [],
    checkpointScores: {},
    ...overrides,
  };
}

async function post(body: string | Buffer): Promise<{ status: number; json: unknown }> {
  const response = await fetch(`http://127.0.0.1:${port}/api/annotation`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  const text = await response.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: response.status, json };
}

beforeAll(async () => {
  mkdirSync(join(root, "bundle-a"), { recursive: true });
  writeFileSync(join(root, "bundle-a", "clip.mp4"), Buffer.alloc(16));
  writeFileSync(join(root, "secret.json"), '{"leak":true}');
  port = await freePort();
  child = spawn(
    join(pkgDir, "node_modules/.bin/tsx"),
    [join(pkgDir, "src/annotate.ts"), root, String(port)],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("annotate server did not start")), 20_000);
    child?.stdout?.on("data", (chunk: Buffer) => {
      if (chunk.toString("utf8").includes("annotation bench:")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child?.stderr?.on("data", (chunk: Buffer) => process.stderr.write(chunk));
    child?.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`annotate server exited early with ${code}`));
    });
  });
}, 30_000);

afterAll(() => {
  child?.kill("SIGKILL");
  rmSync(root, { recursive: true, force: true });
});

describe("audit: lab:annotate server", () => {
  it("lists only real bundles and rejects traversal in bundle names (verified_ok candidate)", async () => {
    const bundles = (await (await fetch(`http://127.0.0.1:${port}/api/bundles`)).json()) as {
      bundles: Array<{ bundle: string }>;
    };
    expect(bundles.bundles.map((b) => b.bundle)).toEqual(["bundle-a"]);
    for (const evil of ["../", "..%2F", "../secret.json", "%2e%2e", "/etc", "bundle-a/../../etc"]) {
      const response = await fetch(
        `http://127.0.0.1:${port}/api/clip?bundle=${encodeURIComponent(evil)}`,
      );
      expect(response.status, evil).toBe(404);
      expect(await response.text()).not.toContain("leak");
    }
    const status = (await post(JSON.stringify(annotation({ captureBundle: "../" })))).status;
    expect(status).toBe(422);
  });

  it("a bundle name that normalizes to a FILE inside the root is a 404, not a 500", async () => {
    // safeBundle() normalizes before checking, so "bundle-a/../secret.json"
    // becomes "secret.json" (inside the root, so not traversal) and then
    // clipPath() calls readdirSync on a regular file.
    for (const name of ["secret.json", "bundle-a/../secret.json"]) {
      const response = await fetch(
        `http://127.0.0.1:${port}/api/clip?bundle=${encodeURIComponent(name)}`,
      );
      expect(response.status, name).toBe(404);
    }
  });

  it("422 on schema problems, 200 with revision 1 on a valid annotation", async () => {
    const bad = await post(JSON.stringify(annotation({ stroke: "moonball" })));
    expect(bad.status).toBe(422);
    const good = await post(JSON.stringify(annotation({ annotatorId: "single" })));
    expect(good.status).toBe(200);
    expect(good.json).toEqual({ saved: true, revision: 1 });
  });

  it("concurrent POSTs for one annotator never collide on revision (mapper hint: RMW race)", async () => {
    const total = 25;
    const responses = await Promise.all(
      Array.from({ length: total }, (_, i) =>
        post(JSON.stringify(annotation({ annotatorId: "racer", annotatorConfidence: i / total }))),
      ),
    );
    const revisions = responses
      .map((r) => (r.json as { revision?: number }).revision)
      .filter((r): r is number => typeof r === "number")
      .sort((a, b) => a - b);
    expect(revisions).toEqual(Array.from({ length: total }, (_, i) => i + 1));
    const stored = JSON.parse(
      readFileSync(join(root, "bundle-a", "annotation", "racer.json"), "utf8"),
    ) as { revision: number; history: unknown[] };
    expect(stored.revision).toBe(total);
    expect(stored.history).toHaveLength(total);
  });

  it("rejects an oversized body with 413 before buffering it (mapper hint: unbounded body)", async () => {
    // 32 MiB of non-JSON: a bounded server answers 413 (or closes) without
    // accumulating the whole body into a string first.
    const big = Buffer.alloc(32 * 1024 * 1024, 0x61);
    const result = await post(big);
    expect(result.status).toBe(413);
  }, 30_000);
});
