/**
 * Structural audit (pass 1) — annotate.ts HTTP server probes.
 *
 * The server (root `lab:annotate`) has no tests. It is spawned here against a
 * temporary bundles root on an ephemeral port and probed over HTTP. A FAILING
 * case is the evidence for a finding; passing cases are `verified_ok`.
 * Production code is not modified.
 *
 * Plane: Linux bench.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PKG = resolve(__dirname, "..");
const TSX = join(PKG, "node_modules", ".bin", "tsx");

let root: string;
let port: number;
let child: ChildProcess | null = null;

function post(path: string, body: string): Promise<{ status: number; text: string }> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  }).then(async (r) => ({ status: r.status, text: await r.text() }));
}

function validAnnotation(captureBundle: string, annotatorId = "audit-1"): Record<string, unknown> {
  return {
    schemaVersion: 1,
    captureBundle,
    annotatorId,
    stroke: "volley",
    handedness: "right",
    analyzable: true,
    notAnalyzableReason: null,
    phases: {},
    faults: [],
    checkpointScores: {},
    paddleFrames: [],
    ballFrames: [],
    overallScore: null,
    annotatorConfidence: 0.5,
    notes: "audit probe",
  };
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "audit-annotate-root-"));
  mkdirSync(join(root, "bundle-a"));
  writeFileSync(join(root, "bundle-a", "clip.mp4"), Buffer.alloc(16));
  port = 40000 + Math.floor(Math.random() * 20000);
  child = spawn(TSX, [join(PKG, "src", "annotate.ts"), root, String(port)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise<void>((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error("annotate server did not start")), 30_000);
    child!.stdout!.on("data", (chunk: Buffer) => {
      if (chunk.toString("utf8").includes("annotation bench:")) {
        clearTimeout(timer);
        resolveReady();
      }
    });
    child!.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`annotate exited early (${String(code)})`));
    });
  });
}, 40_000);

afterAll(() => {
  child?.kill("SIGKILL");
});

describe("audit: annotate.ts write targets", () => {
  it("valid POST for an existing bundle is accepted (control)", async () => {
    const r = await post("/api/annotation", JSON.stringify(validAnnotation("bundle-a")));
    expect(r.status).toBe(200);
    expect(existsSync(join(root, "bundle-a", "annotation", "audit-1.json"))).toBe(true);
  });

  it("path traversal in captureBundle is rejected with 422 (control)", async () => {
    const r = await post("/api/annotation", JSON.stringify(validAnnotation("../outside")));
    expect(r.status).toBe(422);
    expect(existsSync(join(root, "..", "outside"))).toBe(false);
  });

  it("an EMPTY captureBundle does not create a phantom annotation directory at the bundles root", async () => {
    const r = await post("/api/annotation", JSON.stringify(validAnnotation("", "audit-empty")));
    const phantom = join(root, "annotation", "audit-empty.json");
    expect({ status: r.status, phantomWritten: existsSync(phantom) }).toEqual({
      status: 422,
      phantomWritten: false,
    });
  });

  it("captureBundle '.' does not create a phantom annotation directory at the bundles root", async () => {
    const r = await post("/api/annotation", JSON.stringify(validAnnotation(".", "audit-dot")));
    const phantom = join(root, "annotation", "audit-dot.json");
    expect({ status: r.status, phantomWritten: existsSync(phantom) }).toEqual({
      status: 422,
      phantomWritten: false,
    });
  });

  it("a non-object JSON body yields a structured 4xx, not a server crash", async () => {
    const r = await post("/api/annotation", "null");
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
    const alive = await fetch(`http://127.0.0.1:${port}/api/bundles`);
    expect(alive.status).toBe(200);
  });

  it("revision increments monotonically across sequential saves (control)", async () => {
    const a = await post(
      "/api/annotation",
      JSON.stringify(validAnnotation("bundle-a", "audit-rev")),
    );
    const b = await post(
      "/api/annotation",
      JSON.stringify(validAnnotation("bundle-a", "audit-rev")),
    );
    expect(JSON.parse(a.text)).toEqual({ saved: true, revision: 1 });
    expect(JSON.parse(b.text)).toEqual({ saved: true, revision: 2 });
  });

  it("concurrent saves to the same annotator produce distinct revisions (control)", async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        post("/api/annotation", JSON.stringify(validAnnotation("bundle-a", "audit-conc"))),
      ),
    );
    const revisions = results.map((r) => (JSON.parse(r.text) as { revision: number }).revision);
    expect(new Set(revisions).size).toBe(5);
    expect(readdirSync(join(root, "bundle-a", "annotation"))).toContain("audit-conc.json");
  });
});
