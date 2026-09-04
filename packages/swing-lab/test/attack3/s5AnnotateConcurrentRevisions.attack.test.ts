import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SwingAnnotation } from "../../src/annotationSchema.js";
import {
  minimalAnnotation,
  rawPost,
  startAnnotateServer,
  type AnnotateServer,
} from "./annotateServerHarness.js";

/**
 * Adversarial pass 3 (tester #3) — S5: concurrent saves for one annotator.
 *
 * Contract under attack: `revision` is "incremented every save; prior
 * revisions are kept in history". Two (or N) concurrent POSTs for the same
 * bundle+annotator must therefore be assigned distinct, consecutive
 * revisions 1..N, and the persisted file must be revision N with a history
 * of length N. The handler is a read-modify-write (existsSync → readFileSync
 * → writeFileSync) — the attack checks whether interleaved uploads can make
 * two requests observe the same `previous` and both write revision 1.
 *
 * Seed: interleavings are driven by a seeded PRNG (SEED below) that decides
 * per-request chunk sizes so byte arrival is deliberately staggered.
 */

const SEED = 0x5eed_0003;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let server: AnnotateServer;

beforeAll(async () => {
  server = await startAnnotateServer(["bundle-a", "bundle-b", "bundle-c", "bundle-d"]);
}, 60_000);

afterAll(async () => {
  await server.stop();
});

function readSaved(bundle: string, annotator: string): SwingAnnotation | null {
  const path = join(server.root, bundle, "annotation", `${annotator}.json`);
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as SwingAnnotation) : null;
}

function bodyFor(bundle: string, annotator: string, tag: string, padBytes = 0): Buffer {
  return Buffer.from(
    JSON.stringify(
      minimalAnnotation(bundle, annotator, { notes: `${tag}${"·".repeat(padBytes)}` }),
    ),
  );
}

describe("S5 — concurrent POST /api/annotation for the same annotator", () => {
  it("two concurrent saves receive revisions {1,2} and the file ends at revision 2 with history length 2", async () => {
    const [a, b] = await Promise.all([
      rawPost(server.port, "/api/annotation", bodyFor("bundle-a", "alice", "A")),
      rawPost(server.port, "/api/annotation", bodyFor("bundle-a", "alice", "B")),
    ]);
    expect(a.status, a.body).toBe(200);
    expect(b.status, b.body).toBe(200);
    const revisions = [JSON.parse(a.body).revision, JSON.parse(b.body).revision].sort();
    expect(revisions).toEqual([1, 2]);
    const saved = readSaved("bundle-a", "alice");
    expect(saved?.revision).toBe(2);
    expect(saved?.history.map((h) => h.revision)).toEqual([1, 2]);
  });

  it("32 concurrent saves with seeded staggered chunking yield revisions 1..32 exactly once each", async () => {
    const rng = mulberry32(SEED);
    const N = 32;
    const posts = Array.from({ length: N }, (_, i) => {
      // 0.5–64 KiB padding and 1–4 KiB chunks so bodies interleave on the wire.
      const pad = 512 + Math.floor(rng() * 64 * 1024);
      const chunkSize = 1024 + Math.floor(rng() * 3 * 1024);
      return rawPost(server.port, "/api/annotation", bodyFor("bundle-b", "bob", `#${i}`, pad), {
        chunkSize,
      });
    });
    const responses = await Promise.all(posts);
    for (const r of responses) expect(r.status, r.body).toBe(200);
    const revisions = responses
      .map((r) => JSON.parse(r.body).revision as number)
      .sort((x, y) => x - y);
    expect(revisions, `seed=${SEED.toString(16)}`).toEqual(
      Array.from({ length: N }, (_, i) => i + 1),
    );
    const saved = readSaved("bundle-b", "bob");
    expect(saved?.revision).toBe(N);
    expect(saved?.history).toHaveLength(N);
    expect(new Set(saved?.history.map((h) => h.revision)).size).toBe(N);
  });

  it("createdAtIso is fixed by the first save and preserved across concurrent later saves", async () => {
    const first = await rawPost(
      server.port,
      "/api/annotation",
      bodyFor("bundle-c", "carol", "first"),
    );
    expect(first.status).toBe(200);
    const created = readSaved("bundle-c", "carol")?.createdAtIso;
    expect(created).toBeTruthy();
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        rawPost(server.port, "/api/annotation", bodyFor("bundle-c", "carol", `later-${i}`)),
      ),
    );
    const saved = readSaved("bundle-c", "carol");
    expect(saved?.createdAtIso).toBe(created);
    expect(saved?.revision).toBe(9);
  });

  it("client-supplied revision/history are ignored — a forged revision 999 still gets the next real revision", async () => {
    const forged = Buffer.from(
      JSON.stringify(
        minimalAnnotation("bundle-d", "dave", {
          revision: 999,
          history: [{ revision: 998, savedAtIso: "1999-01-01T00:00:00.000Z" }],
        }),
      ),
    );
    const response = await rawPost(server.port, "/api/annotation", forged);
    expect(response.status, response.body).toBe(200);
    expect(JSON.parse(response.body).revision).toBe(1);
    const saved = readSaved("bundle-d", "dave");
    expect(saved?.revision).toBe(1);
    expect(saved?.history).toEqual([{ revision: 1, savedAtIso: expect.any(String) }]);
  });

  it("annotatorId case variants ('Eve' vs 'eve') are distinct files — but the GET index keys collapse on annotatorId as stored", async () => {
    await Promise.all([
      rawPost(server.port, "/api/annotation", bodyFor("bundle-d", "Eve", "upper")),
      rawPost(server.port, "/api/annotation", bodyFor("bundle-d", "eve", "lower")),
    ]);
    // Two distinct files on a case-sensitive filesystem (Linux bench).
    expect(readSaved("bundle-d", "Eve")?.notes).toBe("upper");
    expect(readSaved("bundle-d", "eve")?.notes).toBe("lower");
    const index = await fetch(server.url("/api/bundles")).then(
      (r) => r.json() as Promise<{ bundles: Array<{ bundle: string; annotators: string[] }> }>,
    );
    const annotators = index.bundles.find((b) => b.bundle === "bundle-d")?.annotators ?? [];
    expect(annotators).toEqual(expect.arrayContaining(["Eve", "eve"]));
  });
});
