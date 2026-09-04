import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import { runMigrations, seed } from "@pickle/database";
import { InMemoryJobQueue } from "@pickle/queue";
import { runOnce, type WorkerDeps } from "@pickle/media-worker/worker";
import { buildApp } from "../src/app.js";
import { DevTokenVerifier } from "../src/auth/tokens.js";
import type { ApiConfig } from "../src/config.js";
import { buildObjectStore, type IObjectStore } from "../src/modules/media/objectStore.js";

/**
 * Adversarial pass 3 — storage-media-worker: the upload lifecycle against the
 * REAL API (Fastify inject), REAL PostgreSQL and REAL MinIO (S3 protocol).
 * The FakeObjectStore used elsewhere models what storage *should* enforce;
 * this file asks MinIO what it actually enforces.
 *
 *  - S4: presignUpload → PUT with a wrong x-amz-checksum-sha256 → MinIO must
 *    reject, so /complete's headObject never sees an object (422 object_missing).
 *  - S2: PUT valid body → /complete (200) → PUT a DIFFERENT body to the same key
 *    with the still-valid presigned URL → does GET /v1/media/:id serve the new
 *    bytes (TOCTOU), and does checksum binding prevent it?
 *  - Extras: header-omitted / re-hashed uploads at /complete time, signed-header
 *    spoofing, the URL surviving DELETE + purge (orphan resurrection).
 *
 * Gated on DATABASE_URL_TEST and S3_ENDPOINT_TEST (docker compose up -d postgres_test minio).
 */

const testUrl = process.env["DATABASE_URL_TEST"];
const s3Endpoint = process.env["S3_ENDPOINT_TEST"] ?? "";
const s3AccessKeyId = process.env["S3_ACCESS_KEY_ID_TEST"] ?? "pickle-local";
const s3SecretAccessKey = process.env["S3_SECRET_ACCESS_KEY_TEST"] ?? "pickle-local-secret";
const secret = "attack-minio-upload-secret-0123456789";
const schemaName = `attack_minio_${process.pid}_${randomUUID().replaceAll("-", "")}`;
const migrationsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "packages",
  "database",
  "migrations",
);

function schemaUrl(base: string, schema: string): string {
  const url = new URL(base);
  url.searchParams.set("options", `-c search_path=${schema}`);
  return url.toString();
}

function sha256Hex(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}
function sha256B64(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("base64");
}

async function putPresigned(
  url: string,
  body: Uint8Array,
  headers: Record<string, string>,
): Promise<{ status: number; text: string }> {
  const res = await fetch(url, { method: "PUT", body, headers });
  return { status: res.status, text: (await res.text()).slice(0, 400) };
}

describe.skipIf(!testUrl || s3Endpoint === "")(
  "upload lifecycle against MinIO (adversarial pass 3: S2 TOCTOU, S4 checksum)",
  () => {
    const bucket = `attack-upload-${randomUUID().slice(0, 8)}`;
    const env = {
      S3_MEDIA_BUCKET: bucket,
      S3_ENDPOINT: s3Endpoint,
      AWS_REGION: "us-east-1",
      S3_ACCESS_KEY_ID: s3AccessKeyId,
      S3_SECRET_ACCESS_KEY: s3SecretAccessKey,
    };
    let app: FastifyInstance;
    let pool: pg.Pool;
    let adminPool: pg.Pool;
    let queue: InMemoryJobQueue;
    let store: IObjectStore;
    let s3: S3Client;
    let workerDeps: WorkerDeps;
    let userToken: string;
    const auth = (token: string) => ({ authorization: `Bearer ${token}` });

    beforeAll(async () => {
      s3 = new S3Client({
        region: "us-east-1",
        endpoint: s3Endpoint,
        forcePathStyle: true,
        credentials: { accessKeyId: s3AccessKeyId, secretAccessKey: s3SecretAccessKey },
      });
      await s3.send(new CreateBucketCommand({ Bucket: bucket }));
      store = buildObjectStore(env)!;
      expect(store).toBeTruthy();

      adminPool = new pg.Pool({ connectionString: testUrl });
      await adminPool.query(`CREATE SCHEMA ${schemaName}`);
      const scopedUrl = schemaUrl(testUrl!, schemaName);
      pool = new pg.Pool({ connectionString: scopedUrl });
      await runMigrations(pool, migrationsDir);
      await seed(pool);

      const config: ApiConfig = {
        env: "test",
        port: 0,
        host: "127.0.0.1",
        appVersion: "0.1.0-test",
        databaseUrl: scopedUrl,
        devAuthSecret: secret,
        oidcIssuer: undefined,
        oidcAudience: undefined,
        oidcJwksUrl: undefined,
        sqsQueueUrl: undefined,
        consentExportSigningKey: undefined,
        consentExportSigningKeyId: "consent-export-k1",
        appleIapConfigured: false,
        googlePlayConfigured: false,
      };
      queue = new InMemoryJobQueue();
      app = buildApp(config, { queue, objectStore: store });
      // The worker's real S3ObjectDeleter is not an exported entry point of
      // @pickle/media-worker; this is the same two calls over the same client.
      workerDeps = {
        pool,
        queue,
        objectStore: {
          deleteObject: async (key) => {
            await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
          },
          listObjects: async (prefix) => {
            const page = await s3.send(
              new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }),
            );
            return (page.Contents ?? []).map((o) => o.Key!).filter(Boolean);
          },
        },
        transcoder: null,
        log: () => {},
      };

      const minter = new DevTokenVerifier("test", secret);
      userToken = await minter.mint(`attack-minio|${randomUUID()}`);
      const bootstrap = await app.inject({
        method: "POST",
        url: "/v1/account/bootstrap",
        headers: auth(userToken),
        payload: {
          locale: "en-US",
          timezone: "America/Los_Angeles",
          device: { platform: "ios", osVersion: "18.0", appVersion: "0.1.0", model: "iPhone16,1" },
        },
      });
      expect(bootstrap.statusCode, bootstrap.body).toBe(200);
      const settings = await app.inject({
        method: "PATCH",
        url: "/v1/me/settings",
        headers: auth(userToken),
        payload: { cloudSyncEnabled: true },
      });
      expect(settings.statusCode, settings.body).toBe(200);
    }, 60_000);

    afterAll(async () => {
      await app?.close();
      await pool?.end();
      if (adminPool) {
        await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
        await adminPool.end();
      }
    });

    async function createUpload(body: Uint8Array, contentType = "video/mp4") {
      const created = await app.inject({
        method: "POST",
        url: "/v1/media/uploads",
        headers: auth(userToken),
        payload: {
          kind: "raw_video",
          filename: "clip.mp4",
          bytes: body.byteLength,
          contentType,
          sha256: sha256Hex(body),
        },
      });
      expect(created.statusCode, created.body).toBe(200);
      const json = created.json() as {
        mediaAssetId: string;
        uploadUrl: string;
        requiredHeaders: Record<string, string>;
      };
      const row = await pool.query("SELECT object_key FROM media_asset WHERE id = $1", [
        json.mediaAssetId,
      ]);
      return { ...json, objectKey: row.rows[0].object_key as string };
    }

    async function complete(id: string) {
      return app.inject({
        method: "POST",
        url: `/v1/media/${id}/complete`,
        headers: auth(userToken),
      });
    }

    async function playbackBytes(id: string): Promise<{ status: number; bytes: string | null }> {
      const res = await app.inject({
        method: "GET",
        url: `/v1/media/${id}`,
        headers: auth(userToken),
      });
      if (res.statusCode !== 200) return { status: res.statusCode, bytes: null };
      const { signedUrl } = res.json() as { signedUrl: string };
      const got = await fetch(signedUrl);
      return { status: res.statusCode, bytes: await got.text() };
    }

    async function assetRow(id: string) {
      const { rows } = await pool.query(
        "SELECT status, deleted_at, object_key, sha256 FROM media_asset WHERE id = $1",
        [id],
      );
      return rows[0] as {
        status: string;
        deleted_at: Date | null;
        object_key: string | null;
        sha256: string;
      };
    }

    // ───────────────────────── S4 ─────────────────────────

    it("S4: PUT with a wrong x-amz-checksum-sha256 is rejected by MinIO; /complete sees no object (422 media.object_missing)", async () => {
      const good = Buffer.from("G".repeat(256));
      const up = await createUpload(good);
      const wrongChecksum = sha256B64(Buffer.from("not the body"));
      const put = await putPresigned(up.uploadUrl, good, {
        ...up.requiredHeaders,
        "x-amz-checksum-sha256": wrongChecksum,
      });
      console.log(`S4 wrong-checksum PUT → ${put.status} ${put.text}`);
      expect(put.status).toBeGreaterThanOrEqual(400);
      expect(await store.headObject(up.objectKey)).toBeNull();

      const done = await complete(up.mediaAssetId);
      expect(done.statusCode, done.body).toBe(422);
      expect(done.body).toContain("media.object_missing");
      // Still 'uploading' — the client may retry with the right bytes.
      expect((await assetRow(up.mediaAssetId)).status).toBe("uploading");

      // Correct retry on the SAME URL succeeds and completes.
      const retry = await putPresigned(up.uploadUrl, good, up.requiredHeaders);
      expect(retry.status).toBe(200);
      expect((await complete(up.mediaAssetId)).statusCode).toBe(200);
    });

    it("S4b: the declared (correct) checksum header with a DIFFERENT body is rejected by MinIO (XAmzContentChecksumMismatch)", async () => {
      const declared = Buffer.from("D".repeat(256));
      const evil = Buffer.from("E".repeat(256));
      const up = await createUpload(declared);
      const put = await putPresigned(up.uploadUrl, evil, up.requiredHeaders);
      console.log(`S4b stale-checksum PUT → ${put.status} ${put.text}`);
      expect(put.status).toBe(400);
      expect(put.text).toContain("XAmzContentChecksumMismatch");
      expect(await store.headObject(up.objectKey)).toBeNull();
      expect((await complete(up.mediaAssetId)).statusCode).toBe(422);
    });

    it("S4c: a different body with a re-hashed checksum header or NO checksum header is ACCEPTED by MinIO; /complete must catch it and purge", async () => {
      const declared = Buffer.from("D".repeat(256));
      const evil = Buffer.from("E".repeat(256));
      for (const variant of ["rehashed", "omitted"] as const) {
        const up = await createUpload(declared);
        const headers: Record<string, string> =
          variant === "rehashed"
            ? { ...up.requiredHeaders, "x-amz-checksum-sha256": sha256B64(evil) }
            : {
                "content-type": up.requiredHeaders["content-type"]!,
                "content-length": up.requiredHeaders["content-length"]!,
              };
        const put = await putPresigned(up.uploadUrl, evil, headers);
        console.log(`S4c ${variant} PUT → ${put.status} ${put.text}`);
        // MinIO stores it: the query-string checksum in the signed URL is NOT enforced.
        expect(put.status, variant).toBe(200);
        const head = await store.headObject(up.objectKey);
        console.log(`S4c ${variant} head → ${JSON.stringify(head)}`);
        expect(head, variant).not.toBeNull();

        const done = await complete(up.mediaAssetId);
        expect(done.statusCode, `${variant}: ${done.body}`).toBe(422);
        expect(done.body, variant).toContain("media.checksum_mismatch");
        const row = await assetRow(up.mediaAssetId);
        expect(row.status, variant).toBe("deleted");
        expect(row.deleted_at, variant).not.toBeNull();
        // The queued purge removes the spoofed object from MinIO.
        await runOnce(workerDeps);
        expect(await store.headObject(up.objectKey), `${variant}: purged`).toBeNull();
        expect((await assetRow(up.mediaAssetId)).object_key, variant).toBeNull();
      }
    }, 30_000);

    it("S4d: signed headers cannot be changed — spoofed content-type / larger content-length are refused (403)", async () => {
      const body = Buffer.from("B".repeat(128));
      const up = await createUpload(body);
      const spoofType = await putPresigned(up.uploadUrl, body, {
        ...up.requiredHeaders,
        "content-type": "text/html",
      });
      expect(spoofType.status).toBe(403);
      const bigger = Buffer.from("B".repeat(4096));
      const spoofLength = await putPresigned(up.uploadUrl, bigger, {
        ...up.requiredHeaders,
        "content-length": String(bigger.byteLength),
        "x-amz-checksum-sha256": sha256B64(bigger),
      });
      expect(spoofLength.status).toBe(403);
      expect(await store.headObject(up.objectKey)).toBeNull();
    });

    // ───────────────────────── S2 ─────────────────────────

    it("S2: after /complete, the still-valid presigned URL must NOT be able to replace the bytes GET /v1/media/:id serves (TOCTOU)", async () => {
      const good = Buffer.from("GOOD".repeat(64));
      const evil = Buffer.from("EVIL".repeat(64));
      const up = await createUpload(good);
      expect((await putPresigned(up.uploadUrl, good, up.requiredHeaders)).status).toBe(200);
      const done = await complete(up.mediaAssetId);
      expect(done.statusCode, done.body).toBe(200);
      const before = await playbackBytes(up.mediaAssetId);
      expect(before.status).toBe(200);
      expect(before.bytes).toBe(good.toString());

      // Attack: same URL, different body, re-hashed checksum header (and a
      // second variant with the header omitted).
      const overwrite = await putPresigned(up.uploadUrl, evil, {
        ...up.requiredHeaders,
        "x-amz-checksum-sha256": sha256B64(evil),
      });
      console.log(`S2 post-complete overwrite PUT → ${overwrite.status} ${overwrite.text}`);
      const head = await store.headObject(up.objectKey);
      const row = await assetRow(up.mediaAssetId);
      const after = await playbackBytes(up.mediaAssetId);
      console.log(
        `S2 after overwrite: head=${JSON.stringify(head)} row=${JSON.stringify(row)} playback=${JSON.stringify(after)}`,
      );

      // Checksum binding: the stored checksum no longer matches what /complete accepted.
      expect(head?.checksumSha256).not.toBe(sha256B64(good));
      // Yet the asset is still 'ready' with the ORIGINAL sha256 recorded...
      expect(row.status).toBe("ready");
      expect(row.sha256).toBe(sha256Hex(good));
      // ...so playback must still serve the bytes /complete validated.
      expect(after.status).toBe(200);
      expect(after.bytes, "playback serves bytes that were never checksum-validated").toBe(
        good.toString(),
      );
    });

    it("S2b: the presigned URL survives DELETE + purge — a re-PUT resurrects an orphan object no DB row points at", async () => {
      const good = Buffer.from("G".repeat(64));
      const up = await createUpload(good);
      expect((await putPresigned(up.uploadUrl, good, up.requiredHeaders)).status).toBe(200);
      expect((await complete(up.mediaAssetId)).statusCode).toBe(200);
      const del = await app.inject({
        method: "DELETE",
        url: `/v1/media/${up.mediaAssetId}`,
        headers: auth(userToken),
      });
      expect(del.statusCode).toBe(204);
      await runOnce(workerDeps);
      expect(await store.headObject(up.objectKey)).toBeNull();
      expect((await assetRow(up.mediaAssetId)).object_key).toBeNull();

      const resurrect = await putPresigned(up.uploadUrl, good, up.requiredHeaders);
      console.log(`S2b re-PUT after purge → ${resurrect.status}`);
      const orphan = await store.headObject(up.objectKey);
      console.log(`S2b orphan head → ${JSON.stringify(orphan)}`);
      // Two more sweeps: nothing in the DB references the key, so nothing purges it.
      await runOnce(workerDeps);
      await runOnce(workerDeps);
      const stillThere = await store.headObject(up.objectKey);
      expect(stillThere, "orphan object survives every sweep").toBeNull();
    });

    it("S2c: rapid interleaving — PUT good, PUT evil (rehashed), then /complete once: the checksum check must see the LAST bytes", async () => {
      const good = Buffer.from("GOOD".repeat(64));
      const evil = Buffer.from("EVIL".repeat(64));
      const up = await createUpload(good);
      const [a, b] = await Promise.all([
        putPresigned(up.uploadUrl, good, up.requiredHeaders),
        putPresigned(up.uploadUrl, evil, {
          ...up.requiredHeaders,
          "x-amz-checksum-sha256": sha256B64(evil),
        }),
      ]);
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      const head = await store.headObject(up.objectKey);
      const stored = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: up.objectKey }));
      const bytes = await stored.Body!.transformToString();
      const done = await complete(up.mediaAssetId);
      console.log(
        `S2c last-writer bytes=${bytes.slice(0, 4)} head=${JSON.stringify(head)} complete=${done.statusCode}`,
      );
      if (bytes === good.toString()) {
        expect(done.statusCode).toBe(200);
      } else {
        expect(done.statusCode).toBe(422);
        expect(done.body).toContain("media.checksum_mismatch");
      }
    });
  },
);
