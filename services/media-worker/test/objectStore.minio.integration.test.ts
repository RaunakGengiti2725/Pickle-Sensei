import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";
import {
  CreateBucketCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { runMigrations, seed } from "@pickle/database";
import { SqsJobQueue } from "@pickle/queue";
import type { AnalyticsEvent, IAnalyticsSink } from "@pickle/analytics";
import { buildObjectDeleter } from "../src/objectStore.js";
import { runOnce, type WorkerDeps } from "../src/worker.js";

/**
 * Execution audit harness (storage-media-worker, pass 2): the REAL
 * S3ObjectDeleter against a real S3-protocol store (MinIO from
 * docker-compose) and the REAL SqsJobQueue against ElasticMQ, driving the
 * real worker over a real PostgreSQL. Gated on S3_ENDPOINT_TEST (e.g.
 * http://localhost:9000) so it runs only where the store is up; the SQS
 * cases additionally need SQS_ENDPOINT_TEST and the DB cases DATABASE_URL_TEST.
 *
 *   S3_ENDPOINT_TEST=http://localhost:9000 S3_ACCESS_KEY_ID_TEST=pickle-local \
 *   S3_SECRET_ACCESS_KEY_TEST=pickle-local-secret \
 *   SQS_ENDPOINT_TEST=http://localhost:9324 \
 *   DATABASE_URL_TEST=postgres://pickle:pickle_test_password@localhost:5433/pickle_test \
 *   pnpm --filter @pickle/media-worker test -- objectStore.minio
 */

const s3Endpoint = process.env["S3_ENDPOINT_TEST"] ?? "";
const s3AccessKey = process.env["S3_ACCESS_KEY_ID_TEST"] ?? "pickle-local";
const s3Secret = process.env["S3_SECRET_ACCESS_KEY_TEST"] ?? "pickle-local-secret";
const sqsEndpoint = process.env["SQS_ENDPOINT_TEST"] ?? "";
const testUrl = process.env["DATABASE_URL_TEST"] ?? "";
const region = "us-east-1";

const migrationsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "packages",
  "database",
  "migrations",
);

function s3Env(bucket: string, overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    S3_MEDIA_BUCKET: bucket,
    AWS_REGION: region,
    S3_ENDPOINT: s3Endpoint,
    S3_ACCESS_KEY_ID: s3AccessKey,
    S3_SECRET_ACCESS_KEY: s3Secret,
    ...overrides,
  };
}

describe.skipIf(!s3Endpoint)("S3ObjectDeleter against a real S3-protocol store (MinIO)", () => {
  let s3: S3Client;
  const bucket = `audit-smw-${Date.now()}`;

  async function put(key: string): Promise<void> {
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: "x" }));
  }

  async function exists(key: string): Promise<boolean> {
    try {
      await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return true;
    } catch (error) {
      if ((error as { name?: string }).name === "NotFound") return false;
      throw error;
    }
  }

  async function countAll(): Promise<number> {
    let n = 0;
    let token: string | undefined;
    do {
      const page = await s3.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          ...(token ? { ContinuationToken: token } : {}),
        }),
      );
      n += page.KeyCount ?? 0;
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return n;
  }

  beforeAll(async () => {
    s3 = new S3Client({
      region,
      endpoint: s3Endpoint,
      forcePathStyle: true,
      credentials: { accessKeyId: s3AccessKey, secretAccessKey: s3Secret },
    });
    try {
      await s3.send(new HeadBucketCommand({ Bucket: bucket }));
    } catch {
      await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    }
  }, 30000);

  afterAll(async () => {
    s3?.destroy();
  });

  it("deleteObject removes a real object; deleting a missing key is a no-op (idempotent purge)", async () => {
    const deleter = buildObjectDeleter(s3Env(bucket))!;
    const key = `media/${randomUUID()}`;
    await put(key);
    expect(await exists(key)).toBe(true);
    await deleter.deleteObject(key);
    expect(await exists(key)).toBe(false);
    // S3 semantics: DeleteObject on a missing key is 204, never an error —
    // so a redelivered purge cannot fail on an already-purged master.
    await expect(deleter.deleteObject(key)).resolves.toBeUndefined();
  });

  it("listObjects scopes to the master prefix and never matches sibling keys", async () => {
    const deleter = buildObjectDeleter(s3Env(bucket))!;
    const master = `media/${randomUUID()}`;
    await put(master);
    await put(`${master}/normalized.mp4`);
    await put(`${master}/thumb.jpg`);
    await put(`${master}-sibling`);
    await put(`${master}-sibling/derived.mp4`);
    const keys = await deleter.listObjects!(`${master}/`);
    expect(new Set(keys)).toEqual(new Set([`${master}/normalized.mp4`, `${master}/thumb.jpg`]));
  });

  it("listObjects follows continuation tokens past the 1000-key page limit", async () => {
    const deleter = buildObjectDeleter(s3Env(bucket))!;
    const master = `media/${randomUUID()}`;
    const total = 1005;
    const keys = Array.from(
      { length: total },
      (_, i) => `${master}/frame-${String(i).padStart(4, "0")}`,
    );
    // MinIO handles concurrent puts fine; batch to keep sockets bounded.
    for (let i = 0; i < keys.length; i += 50) {
      await Promise.all(keys.slice(i, i + 50).map((k) => put(k)));
    }
    const listed = await deleter.listObjects!(`${master}/`);
    expect(listed).toHaveLength(total);
    expect(new Set(listed)).toEqual(new Set(keys));
  }, 120000);

  it("wrong credentials surface as a rejected promise (never a silent success)", async () => {
    const bad = buildObjectDeleter(s3Env(bucket, { S3_SECRET_ACCESS_KEY: "definitely-wrong" }))!;
    const key = `media/${randomUUID()}`;
    await put(key);
    await expect(bad.deleteObject(key)).rejects.toBeDefined();
    await expect(bad.listObjects!(`${key}/`)).rejects.toBeDefined();
    expect(await exists(key)).toBe(true);
  });

  it("a missing bucket surfaces as NoSuchBucket rather than a swallowed error", async () => {
    const missing = buildObjectDeleter(s3Env(`audit-missing-${Date.now()}`))!;
    await expect(missing.deleteObject("anything")).rejects.toMatchObject({ name: "NoSuchBucket" });
  });

  it("buildObjectDeleter with only a bucket (no endpoint/keys) still constructs — SDK default chain", () => {
    const deleter = buildObjectDeleter({ S3_MEDIA_BUCKET: bucket });
    expect(deleter).not.toBeNull();
  });

  describe.skipIf(!sqsEndpoint || !testUrl)(
    "end to end: ElasticMQ → worker → PostgreSQL → MinIO",
    () => {
      let pool: pg.Pool;
      let userId: string;

      beforeAll(async () => {
        process.env["AWS_ACCESS_KEY_ID"] ??= "x";
        process.env["AWS_SECRET_ACCESS_KEY"] ??= "x";
        pool = new pg.Pool({ connectionString: testUrl });
        await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
        await runMigrations(pool, migrationsDir);
        await seed(pool);
        const user = await pool.query(
          "INSERT INTO app_user (auth_subject) VALUES ($1) RETURNING id",
          [`auth0|audit-smw-${randomUUID()}`],
        );
        userId = user.rows[0].id as string;
      }, 60000);

      afterAll(async () => {
        await pool?.end();
      });

      // The worker package has no direct @aws-sdk/client-sqs dependency, so
      // the queue is created through the SQS query protocol ElasticMQ speaks.
      async function makeQueue(name: string): Promise<SqsJobQueue> {
        const body = new URLSearchParams({
          Action: "CreateQueue",
          QueueName: name,
          "Attribute.1.Name": "VisibilityTimeout",
          "Attribute.1.Value": "1",
        });
        const response = await fetch(sqsEndpoint, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body,
        });
        const xml = await response.text();
        const queueUrl = /<QueueUrl>([^<]+)<\/QueueUrl>/.exec(xml)?.[1];
        if (!response.ok || !queueUrl)
          throw new Error(`CreateQueue failed: ${response.status} ${xml}`);
        return new SqsJobQueue({ queueUrl, region: "elasticmq", endpoint: sqsEndpoint });
      }

      async function insertDeletedAsset(): Promise<{ id: string; key: string }> {
        const key = `media/${userId}/${randomUUID()}`;
        await put(key);
        await put(`${key}/normalized.mp4`);
        await put(`${key}/thumb.jpg`);
        const row = await pool.query(
          `INSERT INTO media_asset (owner_user_id, kind, bucket, object_key, status, deleted_at)
           VALUES ($1, 'raw_video', $2, $3, 'deleted', now()) RETURNING id`,
          [userId, bucket, key],
        );
        return { id: row.rows[0].id as string, key };
      }

      function deps(queue: SqsJobQueue, env: NodeJS.ProcessEnv, sink?: IAnalyticsSink): WorkerDeps {
        return {
          pool,
          queue,
          objectStore: buildObjectDeleter(env),
          transcoder: null,
          log: () => {},
          ...(sink ? { analytics: sink } : {}),
        };
      }

      it("media.purge over real services deletes master + derived, nulls the key, acks the message", async () => {
        const queue = await makeQueue(`audit-purge-${Date.now()}`);
        const asset = await insertDeletedAsset();
        const before = await countAll();
        await queue.enqueue("media.purge", { mediaAssetId: asset.id });
        const result = await runOnce(deps(queue, s3Env(bucket)));
        expect(result.jobs).toBe(1);
        expect(await exists(asset.key)).toBe(false);
        expect(await exists(`${asset.key}/normalized.mp4`)).toBe(false);
        expect(await exists(`${asset.key}/thumb.jpg`)).toBe(false);
        expect(await countAll()).toBe(before - 3);
        const row = await pool.query("SELECT object_key FROM media_asset WHERE id = $1", [
          asset.id,
        ]);
        expect(row.rows[0].object_key).toBeNull();
        await new Promise((r) => setTimeout(r, 1300));
        expect(await queue.receive(10)).toHaveLength(0);
      }, 30000);

      it("storage failure (bad credentials) leaves the purge visible, keeps the key, emits media_storage_failure", async () => {
        const queue = await makeQueue(`audit-purge-fail-${Date.now()}`);
        const asset = await insertDeletedAsset();
        const tracked: AnalyticsEvent[] = [];
        const sink: IAnalyticsSink = { track: (e) => void tracked.push(e), flush: async () => {} };
        await queue.enqueue("media.purge", { mediaAssetId: asset.id });
        const result = await runOnce(
          deps(queue, s3Env(bucket, { S3_SECRET_ACCESS_KEY: "definitely-wrong" }), sink),
        );
        expect(result.jobs).toBe(0);
        expect(await exists(asset.key)).toBe(true);
        const row = await pool.query("SELECT object_key FROM media_asset WHERE id = $1", [
          asset.id,
        ]);
        expect(row.rows[0].object_key).toBe(asset.key);
        expect(tracked.map((e) => e.name)).toContain("media_storage_failure");
        expect(tracked.map((e) => e.name)).toContain("worker_failure");
        // Visibility timeout passes → the job is redelivered with attempt 2.
        await new Promise((r) => setTimeout(r, 1300));
        const redelivered = await queue.receive(10);
        expect(redelivered).toHaveLength(1);
        expect(redelivered[0]!.job.attempt).toBe(2);
        // Recovery: the same job now succeeds with valid credentials.
        await redelivered[0]!.ack();
        await queue.enqueue("media.purge", { mediaAssetId: asset.id });
        const recovered = await runOnce(deps(queue, s3Env(bucket)));
        expect(recovered.jobs).toBe(1);
        expect(await exists(asset.key)).toBe(false);
      }, 30000);

      it("account deletion media_purge over real MinIO removes every object of the user and completes", async () => {
        const queue = await makeQueue(`audit-account-${Date.now()}`);
        const owner = await pool.query(
          "INSERT INTO app_user (auth_subject) VALUES ($1) RETURNING id",
          [`auth0|audit-smw-owner-${randomUUID()}`],
        );
        const ownerId = owner.rows[0].id as string;
        const keys: string[] = [];
        for (let i = 0; i < 3; i++) {
          const key = `media/${ownerId}/${randomUUID()}`;
          await put(key);
          await put(`${key}/thumb.jpg`);
          keys.push(key);
          await pool.query(
            `INSERT INTO media_asset (owner_user_id, kind, bucket, object_key, status)
             VALUES ($1, 'raw_video', $2, $3, 'ready')`,
            [ownerId, bucket, key],
          );
        }
        for (const kind of [
          "media_purge",
          "ml_dataset_review",
          "social_cleanup",
          "final_hard_delete",
        ]) {
          await pool.query("INSERT INTO deletion_task (user_id, kind) VALUES ($1, $2)", [
            ownerId,
            kind,
          ]);
        }
        const first = await runOnce(deps(queue, s3Env(bucket)));
        expect(first.deletions).toBeGreaterThanOrEqual(3);
        for (const key of keys) {
          expect(await exists(key)).toBe(false);
          expect(await exists(`${key}/thumb.jpg`)).toBe(false);
        }
        const second = await runOnce(deps(queue, s3Env(bucket)));
        expect(second.deletions).toBeGreaterThanOrEqual(1);
        const user = await pool.query("SELECT id FROM app_user WHERE id = $1", [ownerId]);
        expect(user.rowCount).toBe(0);
        const tasks = await pool.query(
          "SELECT kind, status FROM deletion_task WHERE user_id = $1 ORDER BY kind",
          [ownerId],
        );
        expect(tasks.rows.every((r: { status: string }) => r.status === "done")).toBe(true);
      }, 30000);
    },
  );
});
