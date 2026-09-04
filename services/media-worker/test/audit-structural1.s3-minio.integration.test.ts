import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CreateBucketCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { buildObjectDeleter } from "../src/objectStore.js";

/**
 * Structural audit #1 (storage-media-worker): the production S3ObjectDeleter
 * against a REAL S3-protocol endpoint (MinIO from docker-compose). The repo
 * had no test touching an S3 endpoint; this pins the behaviours purge relies
 * on: ListObjectsV2 pagination past 1000 keys, prefix isolation between
 * `<key>/` and `<key>-sibling`, and idempotent delete of a missing key.
 *
 * Gated on S3_ENDPOINT_TEST (e.g. http://localhost:9000) with
 * S3_ACCESS_KEY_ID_TEST / S3_SECRET_ACCESS_KEY_TEST.
 */

const endpoint = process.env["S3_ENDPOINT_TEST"] ?? "";
const accessKeyId = process.env["S3_ACCESS_KEY_ID_TEST"] ?? "";
const secretAccessKey = process.env["S3_SECRET_ACCESS_KEY_TEST"] ?? "";
const enabled = Boolean(endpoint && accessKeyId && secretAccessKey);

describe.skipIf(!enabled)("audit-structural1: S3ObjectDeleter against MinIO", () => {
  const bucket = `audit-s1-${randomUUID().slice(0, 8)}`;
  const region = "us-east-1";
  let client: S3Client;

  beforeAll(async () => {
    client = new S3Client({
      region,
      endpoint,
      forcePathStyle: true,
      credentials: { accessKeyId, secretAccessKey },
    });
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
  }, 30_000);

  afterAll(async () => {
    client?.destroy();
  });

  function deleter() {
    const d = buildObjectDeleter({
      S3_MEDIA_BUCKET: bucket,
      AWS_REGION: region,
      S3_ENDPOINT: endpoint,
      S3_ACCESS_KEY_ID: accessKeyId,
      S3_SECRET_ACCESS_KEY: secretAccessKey,
    });
    expect(d).not.toBeNull();
    return d!;
  }

  async function put(key: string): Promise<void> {
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: "x" }));
  }

  async function putMany(keys: string[], concurrency = 64): Promise<void> {
    let cursor = 0;
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        while (cursor < keys.length) {
          const key = keys[cursor++]!;
          await put(key);
        }
      }),
    );
  }

  async function count(prefix: string): Promise<number> {
    let total = 0;
    let token: string | undefined;
    do {
      const page = await client.send(
        new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }),
      );
      total += page.KeyCount ?? 0;
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return total;
  }

  it("VERIFY listObjects paginates past the 1000-key page limit (pure prefix, no master object)", async () => {
    const prefix = `u1/${randomUUID()}/derived/`;
    const derived = Array.from(
      { length: 1005 },
      (_, i) => `${prefix}seg-${String(i).padStart(4, "0")}.ts`,
    );
    await putMany(derived);
    const listed = await deleter().listObjects!(prefix);
    expect(listed).toHaveLength(1005);
    expect(new Set(listed).size).toBe(1005);
    for (const key of listed) expect(key.startsWith(prefix)).toBe(true);
  }, 120_000);

  it("VERIFY prefix `<key>/` does not match sibling keys that merely extend the master key as a string", async () => {
    const master = `u2/${randomUUID()}/clip`;
    await put(`${master}/n.mp4`);
    await put(`${master}-other.mov`); // sibling asset; must never be purged with `master`
    await put(`${master}2/n.mp4`); // another asset whose key extends `master`
    const listed = await deleter().listObjects!(`${master}/`);
    expect(listed).toEqual([`${master}/n.mp4`]);
  }, 30_000);

  it("HOTSPOT derived layout: `${objectKey}/…` derived keys are listable while the master object `${objectKey}` exists", async () => {
    // worker.ts deleteObjectAndDerived lists `${objectKey}/` and then deletes
    // the master. The layout puts an OBJECT and a PREFIX at the same name.
    // If the store cannot list the prefix while the object exists, purge
    // deletes the master and silently orphans every derived artifact.
    const master = `u5/${randomUUID()}/master.mov`;
    await put(master);
    await put(`${master}/normalized.mp4`);
    await put(`${master}/thumb.jpg`);
    // Both derived objects are addressable individually…
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: `${master}/normalized.mp4` }));
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: `${master}/thumb.jpg` }));
    // …so the production lister must see them under the derived prefix.
    const listed = await deleter().listObjects!(`${master}/`);
    expect(listed.sort()).toEqual([`${master}/normalized.mp4`, `${master}/thumb.jpg`]);
  }, 30_000);

  it("HOTSPOT derived layout: purge order (list derived → delete master) leaves no derived artifact behind", async () => {
    const d = deleter();
    const master = `u6/${randomUUID()}/master.mov`;
    await put(master);
    await put(`${master}/normalized.mp4`);
    // Mirror worker.ts deleteObjectAndDerived exactly.
    const derived = await d.listObjects!(`${master}/`);
    for (const key of derived) await d.deleteObject(key);
    await d.deleteObject(master);
    // Nothing under the master key may survive a purge.
    const remaining = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: `${master}` }),
    );
    expect((remaining.Contents ?? []).map((o) => o.Key)).toEqual([]);
    await expect(
      client.send(new HeadObjectCommand({ Bucket: bucket, Key: `${master}/normalized.mp4` })),
    ).rejects.toMatchObject({ name: "NotFound" });
  }, 30_000);

  it("deleteObject on a missing key is idempotent (no throw) and on a present key removes it", async () => {
    const d = deleter();
    const key = `u3/${randomUUID()}/gone.mov`;
    await expect(d.deleteObject(key)).resolves.toBeUndefined();
    await put(key);
    await d.deleteObject(key);
    await expect(
      client.send(new HeadObjectCommand({ Bucket: bucket, Key: key })),
    ).rejects.toMatchObject({
      name: "NotFound",
    });
    await expect(d.deleteObject(key)).resolves.toBeUndefined();
  }, 30_000);

  it("deleteObject against a bucket that does not exist rejects (never silently 'succeeds')", async () => {
    const d = buildObjectDeleter({
      S3_MEDIA_BUCKET: `audit-s1-missing-${randomUUID().slice(0, 8)}`,
      AWS_REGION: region,
      S3_ENDPOINT: endpoint,
      S3_ACCESS_KEY_ID: accessKeyId,
      S3_SECRET_ACCESS_KEY: secretAccessKey,
    })!;
    await expect(d.deleteObject("any/key")).rejects.toBeTruthy();
    await expect(d.listObjects!("any/")).rejects.toBeTruthy();
  }, 30_000);

  it("deleteObject with wrong credentials rejects (purge stays unhandled rather than claiming erasure)", async () => {
    const d = buildObjectDeleter({
      S3_MEDIA_BUCKET: bucket,
      AWS_REGION: region,
      S3_ENDPOINT: endpoint,
      S3_ACCESS_KEY_ID: "not-a-real-key",
      S3_SECRET_ACCESS_KEY: "not-a-real-secret",
    })!;
    const key = `u4/${randomUUID()}/keep.mov`;
    await put(key);
    await expect(d.deleteObject(key)).rejects.toBeTruthy();
    expect(await count(key)).toBe(1);
  }, 30_000);
});
