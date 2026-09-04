import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { S3Client } from "@aws-sdk/client-s3";
import { buildObjectDeleter } from "../src/objectStore.js";
import type { ObjectDeleter } from "../src/worker.js";
import {
  deleteAllUnderPrefix,
  ensureBucket,
  listAllKeys,
  minioClient,
  minioEndpoint,
  minioEnv,
  objectExists,
  putMany,
  putObject,
} from "./support/minio.js";

/**
 * Adversarial pass 3 — storage-media-worker, S3ObjectDeleter against the REAL
 * S3 protocol (MinIO). The unit tests only prove the deleter can be built;
 * these prove what it does on the wire:
 *  - S1: listObjects paginates past MinIO's 1,000-key page via
 *    ContinuationToken and returns every derived key exactly once (with
 *    hostile key material: unicode, spaces, '+', '%', '#', '?', '&', a
 *    trailing-slash marker, and the prefix itself as a key), never a sibling
 *    that merely shares the master's string prefix;
 *  - S3: deleteObject on a nonexistent key resolves (S3 semantics), so a
 *    double purge / sweep-after-purge stays idempotent on the real protocol;
 *    the same call against a nonexistent BUCKET rejects with NoSuchBucket
 *    (this is what the S5 sweep test relies on).
 * Gated on S3_ENDPOINT_TEST (docker compose up -d minio → http://localhost:9000).
 */

/** mulberry32 — seeded so a failing key set can be regenerated verbatim. */
function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEED = Number(process.env["ATTACK_SEED"] ?? 20260904);
const HOSTILE_SUFFIXES = [
  "normalized.mp4",
  "thumb.jpg",
  "with space.mp4",
  "plus+sign.mp4",
  "percent%25.mp4",
  "hash#frag.mp4",
  "question?mark.mp4",
  "amp&ersand.mp4",
  "媒体/缩略图.jpg",
  "emoji-🎾.mp4",
  "trailing-slash/",
  "nested/deeper/derived.bin",
  "..%2F..%2Fetc%2Fpasswd",
  "CRLF\r\ninjected",
];

describe.skipIf(!minioEndpoint)("S3ObjectDeleter against MinIO (adversarial pass 3)", () => {
  const bucket = `attack-deleter-${randomUUID().slice(0, 8)}`;
  let client: S3Client;
  let deleter: ObjectDeleter;

  beforeAll(async () => {
    client = minioClient();
    await ensureBucket(client, bucket);
    const built = buildObjectDeleter(minioEnv(bucket));
    expect(built).not.toBeNull();
    deleter = built!;
  }, 30_000);

  afterAll(async () => {
    await deleteAllUnderPrefix(client, bucket, "");
  });

  it("S1: listObjects paginates past 1,000 keys via ContinuationToken and returns every derived key exactly once", async () => {
    const rand = seededRandom(SEED);
    const master = `media/u/${randomUUID()}`;
    const prefix = `${master}/`;
    const total = 1_000 + 250 + HOSTILE_SUFFIXES.length; // 1,264 > one MinIO page
    const derived = new Set<string>();
    for (const suffix of HOSTILE_SUFFIXES) derived.add(`${prefix}${suffix}`);
    while (derived.size < total) {
      derived.add(`${prefix}derived-${Math.floor(rand() * 1e9).toString(36)}.bin`);
    }
    // Decoys that share the master's STRING prefix but are not derived from it.
    // The master object itself is deliberately ABSENT here so this test
    // measures pagination alone — S1d covers the master-present layout.
    const decoys = [
      `${master}-sibling.mp4`,
      `${master}2/normalized.mp4`,
      `${master}.bak`,
      `media/u/${randomUUID()}/normalized.mp4`,
    ];
    const expected = [...derived];
    await putMany(client, bucket, [...expected, ...decoys]);

    const groundTruth = await listAllKeys(client, bucket, prefix);
    expect(groundTruth.length, "harness: MinIO holds every derived key").toBe(total);

    const listed = await deleter.listObjects!(prefix);
    const listedSet = new Set(listed);
    expect(listed.length, `seed=${SEED}: duplicates in listing`).toBe(listedSet.size);
    expect(listedSet.size, `seed=${SEED}: keys lost across the page boundary`).toBe(total);
    const missing = expected.filter((k) => !listedSet.has(k));
    expect(missing, `seed=${SEED}: missing keys`).toEqual([]);
    for (const decoy of decoys) {
      expect(listedSet.has(decoy), `decoy ${decoy} must not be treated as derived`).toBe(false);
    }

    // Full purge over the real protocol: every derived key is gone, decoys survive.
    for (const key of listed) await deleter.deleteObject(key);
    await deleter.deleteObject(master);
    expect(await listAllKeys(client, bucket, prefix)).toEqual([]);
    expect(await objectExists(client, bucket, master)).toBe(false);
    for (const decoy of decoys) {
      expect(await objectExists(client, bucket, decoy), `decoy ${decoy} survived`).toBe(true);
    }
  }, 180_000);

  it("S1b: exactly 1,000 and 1,001 keys — the page-boundary edge is handled in both directions", async () => {
    for (const n of [1_000, 1_001]) {
      const prefix = `media/edge-${n}/${randomUUID()}/`;
      const keys = Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(5, "0")}`);
      await putMany(client, bucket, keys);
      const listed = await deleter.listObjects!(prefix);
      expect(new Set(listed).size, `n=${n}`).toBe(n);
      expect([...listed].sort()).toEqual(keys);
      await deleteAllUnderPrefix(client, bucket, prefix);
    }
  }, 180_000);

  it("S1c: an empty prefix listing returns [] (fresh master with no derived artifacts)", async () => {
    expect(await deleter.listObjects!(`media/none/${randomUUID()}/`)).toEqual([]);
  });

  it("S1d: production layout — master object PLUS `${master}/normalized|thumb` derived objects: listObjects(`${master}/`) must return the derived keys (purge relies on it)", async () => {
    // media.process (worker.ts) requires the transcoder to emit derived keys
    // under `${objectKey}/` and media.purge deletes `listObjects(`${objectKey}/`)`
    // BEFORE deleting the master. Both orders of creation are exercised.
    const results: Record<
      string,
      { expected: string[]; listed: string[]; afterMasterGone: string[]; orphaned: string[] }
    > = {};
    for (const order of ["master-first", "derived-first"] as const) {
      const master = `media/u/${randomUUID()}`;
      const derived = [`${master}/normalized.mp4`, `${master}/thumb.jpg`];
      if (order === "master-first") await putObject(client, bucket, master, "master");
      for (const key of derived) await putObject(client, bucket, key, "derived");
      if (order === "derived-first") await putObject(client, bucket, master, "master");

      // Every object is individually addressable...
      expect(await objectExists(client, bucket, master), `${order}: master`).toBe(true);
      for (const key of derived) {
        expect(await objectExists(client, bucket, key), `${order}: ${key}`).toBe(true);
      }
      // ...so the purge-time listing must see the derived artifacts.
      const listed = [...(await deleter.listObjects!(`${master}/`))].sort();
      // Reproduce deleteObjectAndDerived (worker.ts) literally: delete what
      // the listing returned, then the master.
      for (const key of listed) await deleter.deleteObject(key);
      await deleter.deleteObject(master);
      const afterMasterGone = [...(await deleter.listObjects!(`${master}/`))].sort();
      const orphaned: string[] = [];
      for (const key of derived) if (await objectExists(client, bucket, key)) orphaned.push(key);
      results[order] = { expected: derived, listed, afterMasterGone, orphaned };
    }
    console.log("S1d results", JSON.stringify(results, null, 2));
    for (const [order, r] of Object.entries(results)) {
      expect(r.orphaned, `${order}: derived objects left behind by a purge`).toEqual([]);
    }
    for (const [order, r] of Object.entries(results)) {
      expect(r.listed, `${order}: listObjects with master present → ${JSON.stringify(r)}`).toEqual(
        r.expected,
      );
    }
  });

  it("S3: deleteObject on a nonexistent key resolves, so double purge is idempotent on the wire", async () => {
    const key = `media/ghost/${randomUUID()}`;
    await expect(deleter.deleteObject(key)).resolves.toBeUndefined();
    // Real object: delete twice, and once more after a sweep-style re-list.
    await putObject(client, bucket, key);
    await expect(deleter.deleteObject(key)).resolves.toBeUndefined();
    await expect(deleter.deleteObject(key)).resolves.toBeUndefined();
    expect(await objectExists(client, bucket, key)).toBe(false);
    // Rapid concurrent deletes of the same (now absent) key: all resolve.
    await expect(
      Promise.all(Array.from({ length: 16 }, () => deleter.deleteObject(key))),
    ).resolves.toHaveLength(16);
  });

  it("S3b: hostile keys (unicode, reserved URL characters, CR/LF) round-trip through delete", async () => {
    for (const suffix of HOSTILE_SUFFIXES) {
      const key = `media/hostile/${randomUUID()}/${suffix}`;
      await putObject(client, bucket, key);
      expect(await objectExists(client, bucket, key), `put ${JSON.stringify(suffix)}`).toBe(true);
      await expect(deleter.deleteObject(key)).resolves.toBeUndefined();
      expect(await objectExists(client, bucket, key), `delete ${JSON.stringify(suffix)}`).toBe(
        false,
      );
    }
  });

  it("S3c: deleteObject against a NONEXISTENT bucket rejects with NoSuchBucket (never a silent success)", async () => {
    const ghostBucket = `attack-no-such-bucket-${randomUUID().slice(0, 8)}`;
    const ghost = buildObjectDeleter(minioEnv(ghostBucket))!;
    await expect(ghost.deleteObject("media/x/y")).rejects.toMatchObject({ name: "NoSuchBucket" });
    await expect(ghost.listObjects!("media/x/")).rejects.toMatchObject({ name: "NoSuchBucket" });
  });
});
