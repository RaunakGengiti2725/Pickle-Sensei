import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import {
  CreateBucketCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type pg from "pg";
import { buildObjectDeleter } from "../src/objectStore.js";
import { handleJob, type ObjectDeleter, type WorkerDeps } from "../src/worker.js";

/**
 * Structural audit #2: the repo has no test against a real S3-protocol
 * endpoint. Gated on S3_ENDPOINT_TEST (MinIO from docker-compose, e.g.
 * http://localhost:9000 with S3_ACCESS_KEY_ID_TEST / S3_SECRET_ACCESS_KEY_TEST).
 * Verifies ListObjectsV2 pagination past 1000 derived keys, that deleting a
 * missing key does not throw, that a purge through the real deleter leaves
 * nothing under the master prefix, and that the master+derived key layout the
 * worker mandates can actually exist on the endpoint.
 */

const endpoint = process.env["S3_ENDPOINT_TEST"] ?? "";
const accessKeyId = process.env["S3_ACCESS_KEY_ID_TEST"] ?? "";
const secretAccessKey = process.env["S3_SECRET_ACCESS_KEY_TEST"] ?? "";
const enabled = Boolean(endpoint && accessKeyId && secretAccessKey);

describe.skipIf(!enabled)("structural audit #2: S3ObjectDeleter against MinIO", () => {
  const bucket = `audit-s2-${Date.now()}`;
  let client: S3Client;
  let deleter: ObjectDeleter;

  beforeAll(async () => {
    client = new S3Client({
      region: "us-east-1",
      endpoint,
      forcePathStyle: true,
      credentials: { accessKeyId, secretAccessKey },
    });
    try {
      await client.send(new HeadBucketCommand({ Bucket: bucket }));
    } catch {
      await client.send(new CreateBucketCommand({ Bucket: bucket }));
    }
    const built = buildObjectDeleter({
      S3_MEDIA_BUCKET: bucket,
      AWS_REGION: "us-east-1",
      S3_ENDPOINT: endpoint,
      S3_ACCESS_KEY_ID: accessKeyId,
      S3_SECRET_ACCESS_KEY: secretAccessKey,
    });
    if (!built) throw new Error("buildObjectDeleter returned null with a bucket configured");
    deleter = built;
  }, 60_000);

  async function put(key: string): Promise<void> {
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: "x" }));
  }

  async function listAll(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const page = await client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          ...(token ? { ContinuationToken: token } : {}),
        }),
      );
      for (const o of page.Contents ?? []) if (o.Key) keys.push(o.Key);
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return keys;
  }

  it("deleting a key that does not exist does not throw (purge idempotency on real S3 semantics)", async () => {
    await expect(
      deleter.deleteObject(`media/audit/missing-${randomUUID()}`),
    ).resolves.toBeUndefined();
  });

  it("the worker's key layout (master object + `${master}/derived`) is representable on the configured endpoint", async () => {
    // worker.ts requires derived artifacts to live under `${objectKey}/` while
    // the master itself is an object at `${objectKey}`. Both PUTs return 200;
    // both objects must then be listable, else a transcode silently destroys
    // the master (or the master upload destroys the derived artifacts).
    const master = `media/audit/layout-${randomUUID()}`;
    await put(master);
    await put(`${master}/normalized.mp4`);
    await put(`${master}/thumb.jpg`);
    expect((await listAll(master)).sort()).toEqual(
      [master, `${master}/normalized.mp4`, `${master}/thumb.jpg`].sort(),
    );
  });

  it("listObjects paginates past 1000 derived artifacts and purge removes every one of them", async () => {
    const master = `media/audit/master-${randomUUID()}`;
    const derivedCount = 1005;
    const puts: Promise<void>[] = [];
    for (let i = 0; i < derivedCount; i++) {
      puts.push(put(`${master}/derived-${String(i).padStart(4, "0")}.bin`));
      if (puts.length >= 50) {
        await Promise.all(puts);
        puts.length = 0;
      }
    }
    await Promise.all(puts);
    // A sibling whose key merely shares the master as a string prefix must survive.
    const sibling = `${master}-sibling`;
    await put(sibling);

    expect((await deleter.listObjects!(`${master}/`)).length).toBe(derivedCount);

    const pool = {
      query: async (text: string) => {
        if (text.startsWith("SELECT object_key, deleted_at"))
          return { rows: [{ object_key: master, deleted_at: new Date() }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      },
    } as unknown as pg.Pool;
    const deps: WorkerDeps = {
      pool,
      queue: {
        enqueue: async () => "n/a",
        receive: async () => [],
        size: async () => 0,
        oldestJobAgeMs: async () => null,
      },
      objectStore: deleter,
      transcoder: null,
      log: () => {},
    };
    const outcome = await handleJob(deps, {
      id: "j-minio",
      kind: "media.purge",
      payload: { mediaAssetId: randomUUID() },
      attempt: 1,
    });
    expect(outcome.handled).toBe(true);
    expect(outcome.note).toContain(`${derivedCount + 1} artifact(s)`);
    expect(await listAll(`${master}/`)).toEqual([]);
    expect(await listAll(master)).toEqual([sibling]); // prefix-sharing sibling untouched
  }, 120_000);
});
