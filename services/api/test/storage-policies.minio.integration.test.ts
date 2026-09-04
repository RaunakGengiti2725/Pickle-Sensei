import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DeleteObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations, seed } from "@pickle/database";
import { InMemoryJobQueue } from "@pickle/queue";
import { runOnce, type WorkerDeps } from "@pickle/media-worker/worker";
import { buildApp } from "../src/app.js";
import { DevTokenVerifier } from "../src/auth/tokens.js";
import type { ApiConfig } from "../src/config.js";
import {
  adminClient,
  buildHarnessStore,
  harnessEnvFromProcess,
  rawRequest,
  substituteKey,
  type HarnessEnv,
} from "./support/storagePolicyHarness.js";

/**
 * Storage-policy audit, end to end: the REAL API (buildApp) issuing REAL
 * presigned URLs through the production S3 object store against a REAL
 * S3-compatible endpoint (MinIO), on a REAL PostgreSQL schema, with the REAL
 * media worker purging. Two users; every cross-user, anonymous, spoofed,
 * oversized, expired and deleted-asset path is exercised with raw HTTP against
 * storage — nothing is faked.
 *
 * Requires DATABASE_URL_TEST and S3_TEST_ENDPOINT / S3_TEST_ACCESS_KEY_ID /
 * S3_TEST_SECRET_ACCESS_KEY / S3_TEST_BUCKET (docker compose `minio` +
 * `postgres_test`). Set STORAGE_AUDIT_OUT=<dir> to write the observed matrix
 * as `api-e2e.json` for evidence.
 */

const testUrl = process.env["DATABASE_URL_TEST"];
const s3Env = harnessEnvFromProcess(process.env);
const evidenceDir = process.env["STORAGE_AUDIT_OUT"];
const secret = "storage-policies-secret-0123456789";
const schemaName = `storage_policies_${process.pid}_${randomUUID().replaceAll("-", "")}`;
const migrationsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "packages",
  "database",
  "migrations",
);

const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;
const MAX_THUMBNAIL_BYTES = 10 * 1024 * 1024;

function schemaUrl(base: string, schema: string): string {
  const url = new URL(base);
  url.searchParams.set("options", `-c search_path=${schema}`);
  return url.toString();
}

interface UploadTicket {
  mediaAssetId: string;
  uploadUrl: string;
  expiresSeconds: number;
  requiredHeaders: Record<string, string>;
}

interface Observation {
  scenario: string;
  observed: Record<string, unknown>;
}

describe.skipIf(!testUrl || !s3Env)(
  "storage policies: presigned URLs + bucket access (API + MinIO + PostgreSQL + worker)",
  () => {
    const env = s3Env as HarnessEnv;
    let app: FastifyInstance;
    let pool: pg.Pool;
    let adminPool: pg.Pool;
    let queue: InMemoryJobQueue;
    let workerDeps: WorkerDeps;
    let tokenA: string;
    let tokenB: string;
    let userA: string;
    let userB: string;
    const observations: Observation[] = [];
    const createdKeys: string[] = [];

    const auth = (token: string) => ({ authorization: `Bearer ${token}` });
    const record = (scenario: string, observed: Record<string, unknown>) =>
      observations.push({ scenario, observed });

    async function bootstrap(token: string): Promise<string> {
      const res = await app.inject({
        method: "POST",
        url: "/v1/account/bootstrap",
        headers: auth(token),
        payload: {
          locale: "en-US",
          timezone: "America/Los_Angeles",
          device: { platform: "ios", osVersion: "18.0", appVersion: "0.1.0", model: "iPhone16,1" },
        },
      });
      expect(res.statusCode, res.body).toBe(200);
      const settings = await app.inject({
        method: "PATCH",
        url: "/v1/me/settings",
        headers: auth(token),
        payload: { cloudSyncEnabled: true },
      });
      expect(settings.statusCode, settings.body).toBe(200);
      return (res.json() as { user: { id: string } }).user.id;
    }

    beforeAll(async () => {
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
      const store = buildHarnessStore(env);
      // The expensive-route budget is 60/min per credential; this suite issues
      // more than that for one user, so lift it — rate limiting is not under
      // test here (it has its own suite).
      app = buildApp(config, { queue, objectStore: store, rateLimit: { enabled: false } });

      const admin = adminClient(env);
      workerDeps = {
        pool,
        queue,
        objectStore: {
          deleteObject: async (key) => {
            await admin.send(new DeleteObjectCommand({ Bucket: env.bucket, Key: key }));
          },
          listObjects: async (prefix) => {
            const page = await admin.send(
              new ListObjectsV2Command({ Bucket: env.bucket, Prefix: prefix }),
            );
            return (page.Contents ?? []).map((o) => o.Key ?? "").filter((k) => k.length > 0);
          },
        },
        transcoder: null,
        log: () => {},
      };

      const minter = new DevTokenVerifier("test", secret);
      tokenA = await minter.mint(`storage-a|${randomUUID()}`);
      tokenB = await minter.mint(`storage-b|${randomUUID()}`);
      userA = await bootstrap(tokenA);
      userB = await bootstrap(tokenB);
      expect(userA).not.toBe(userB);
    }, 90_000);

    afterAll(async () => {
      if (evidenceDir) {
        mkdirSync(evidenceDir, { recursive: true });
        writeFileSync(
          join(evidenceDir, "api-e2e.json"),
          JSON.stringify(
            {
              endpoint: env.endpoint,
              bucket: env.bucket,
              users: { a: userA, b: userB },
              objectKeysCreated: createdKeys.length,
              observations,
            },
            null,
            2,
          ),
        );
      }
      await app?.close();
      await pool?.end();
      if (adminPool) {
        await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
        await adminPool.end();
      }
    });

    function clip(size = 4096, fill = 7): { body: Buffer; sha256: string } {
      const body = Buffer.alloc(size, fill);
      return { body, sha256: createHash("sha256").update(body).digest("hex") };
    }

    async function createUpload(
      token: string,
      overrides: Record<string, unknown> = {},
    ): Promise<{ ticket: UploadTicket; objectKey: string; bucket: string; status: string }> {
      const { sha256 } = clip();
      const res = await app.inject({
        method: "POST",
        url: "/v1/media/uploads",
        headers: auth(token),
        payload: {
          kind: "raw_video",
          filename: "clip.mp4",
          bytes: 4096,
          contentType: "video/mp4",
          sha256,
          ...overrides,
        },
      });
      expect(res.statusCode, res.body).toBe(200);
      const ticket = res.json() as UploadTicket;
      const row = await pool.query(
        "SELECT object_key, bucket, status FROM media_asset WHERE id = $1",
        [ticket.mediaAssetId],
      );
      const objectKey = row.rows[0].object_key as string;
      createdKeys.push(objectKey);
      return {
        ticket,
        objectKey,
        bucket: row.rows[0].bucket as string,
        status: row.rows[0].status,
      };
    }

    async function putHonest(ticket: UploadTicket, body: Buffer) {
      return rawRequest("PUT", ticket.uploadUrl, ticket.requiredHeaders, body);
    }

    async function complete(token: string, mediaAssetId: string) {
      return app.inject({
        method: "POST",
        url: `/v1/media/${mediaAssetId}/complete`,
        headers: auth(token),
      });
    }

    async function readyAsset(
      token: string,
    ): Promise<{ mediaAssetId: string; objectKey: string; body: Buffer }> {
      const { body } = clip();
      const { ticket, objectKey } = await createUpload(token);
      const put = await putHonest(ticket, body);
      expect(put.status, put.bodyPrefix).toBe(200);
      const done = await complete(token, ticket.mediaAssetId);
      expect(done.statusCode, done.body).toBe(200);
      return { mediaAssetId: ticket.mediaAssetId, objectKey, body };
    }

    async function objectExists(key: string): Promise<boolean> {
      const page = await adminClient(env).send(
        new ListObjectsV2Command({ Bucket: env.bucket, Prefix: key, MaxKeys: 1 }),
      );
      return (page.Contents ?? []).some((o) => o.Key === key);
    }

    async function drainWorker(cycles = 4): Promise<void> {
      for (let i = 0; i < cycles; i++) await runOnce(workerDeps);
    }

    it("path ownership: object keys are bound to the owner's id prefix and the configured bucket, never to client input", async () => {
      const { ticket, objectKey, bucket, status } = await createUpload(tokenA, {
        filename: "../../../etc/passwd",
      });
      expect(objectKey.startsWith(`media/${userA}/`)).toBe(true);
      expect(objectKey).toMatch(new RegExp(`^media/${userA}/[0-9a-f]{48}$`));
      expect(objectKey).not.toContain("passwd");
      expect(bucket).toBe(env.bucket);
      expect(status).toBe("uploading");
      const url = new URL(ticket.uploadUrl);
      expect(url.pathname).toBe(`/${env.bucket}/${objectKey}`);
      expect(url.searchParams.get("X-Amz-Expires")).toBe("900");
      expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("content-length;content-type;host");
      expect(ticket.expiresSeconds).toBe(900);
      record("path_ownership", {
        objectKey,
        bucket,
        uploadPath: url.pathname,
        signedHeaders: url.searchParams.get("X-Amz-SignedHeaders"),
      });
    });

    it("honest upload round-trips: PUT with the required headers, complete → ready, signed GET returns the bytes", async () => {
      const { mediaAssetId, body } = await readyAsset(tokenA);
      const res = await app.inject({
        method: "GET",
        url: `/v1/media/${mediaAssetId}`,
        headers: auth(tokenA),
      });
      expect(res.statusCode, res.body).toBe(200);
      const payload = res.json() as {
        signedUrl: string;
        expiresAt: string;
        asset: { status: string };
      };
      expect(payload.asset.status).toBe("ready");
      const url = new URL(payload.signedUrl);
      expect(url.searchParams.get("X-Amz-Expires")).toBe("300");
      const expiresInMs = new Date(payload.expiresAt).getTime() - Date.now();
      expect(expiresInMs).toBeGreaterThan(290_000);
      expect(expiresInMs).toBeLessThanOrEqual(300_000);
      const download = await rawRequest("GET", payload.signedUrl, {});
      expect(download.status).toBe(200);
      expect(download.bodyBytes).toBe(body.length);
      record("honest_roundtrip", {
        downloadStatus: download.status,
        downloadExpires: url.searchParams.get("X-Amz-Expires"),
      });
    });

    it("cross-user: B cannot read, complete, or delete A's asset through the API (404, no existence leak)", async () => {
      const { mediaAssetId } = await readyAsset(tokenA);
      const pending = await createUpload(tokenA);
      const read = await app.inject({
        method: "GET",
        url: `/v1/media/${mediaAssetId}`,
        headers: auth(tokenB),
      });
      const finish = await complete(tokenB, pending.ticket.mediaAssetId);
      const remove = await app.inject({
        method: "DELETE",
        url: `/v1/media/${mediaAssetId}`,
        headers: auth(tokenB),
      });
      const missing = await app.inject({
        method: "GET",
        url: `/v1/media/${randomUUID()}`,
        headers: auth(tokenB),
      });
      for (const res of [read, finish, remove]) {
        expect(res.statusCode, res.body).toBe(404);
        expect((res.json() as { error: { code: string } }).error.code).toBe("media.not_found");
      }
      // Same status and code for "exists but not yours" and "does not exist".
      expect(missing.statusCode).toBe(404);
      expect(remove.body).not.toContain(userA);
      const row = await pool.query("SELECT status, deleted_at FROM media_asset WHERE id = $1", [
        mediaAssetId,
      ]);
      expect(row.rows[0].status).toBe("ready");
      expect(row.rows[0].deleted_at).toBeNull();
      record("cross_user_api", {
        read: read.statusCode,
        complete: finish.statusCode,
        delete: remove.statusCode,
        unknownId: missing.statusCode,
      });
    });

    it("anonymous: every media route requires a bearer token", async () => {
      const { mediaAssetId } = await readyAsset(tokenA);
      const results = await Promise.all([
        app.inject({ method: "POST", url: "/v1/media/uploads", payload: {} }),
        app.inject({ method: "POST", url: `/v1/media/${mediaAssetId}/complete` }),
        app.inject({ method: "GET", url: `/v1/media/${mediaAssetId}` }),
        app.inject({ method: "DELETE", url: `/v1/media/${mediaAssetId}` }),
        app.inject({
          method: "GET",
          url: `/v1/media/${mediaAssetId}`,
          headers: auth("not-a-token"),
        }),
      ]);
      for (const res of results) expect(res.statusCode, res.body).toBe(401);
      record("anonymous_api", { statuses: results.map((r) => r.statusCode) });
    });

    it("cross-user at storage: A's signed download URL cannot be re-pointed at B's object", async () => {
      const a = await readyAsset(tokenA);
      const b = await readyAsset(tokenB);
      const res = await app.inject({
        method: "GET",
        url: `/v1/media/${a.mediaAssetId}`,
        headers: auth(tokenA),
      });
      const { signedUrl } = res.json() as { signedUrl: string };
      const forged = substituteKey(signedUrl, env.bucket, b.objectKey);
      const attempt = await rawRequest("GET", forged, {});
      expect(attempt.status).toBe(403);
      expect(attempt.code).toBe("SignatureDoesNotMatch");
      expect(attempt.bodyBytes).not.toBe(b.body.length);
      const direct = await rawRequest("GET", `${env.endpoint}/${env.bucket}/${b.objectKey}`, {});
      expect(direct.status).toBe(403);
      expect(direct.code).toBe("AccessDenied");
      record("cross_user_storage", {
        substituted: attempt.status,
        substitutedCode: attempt.code,
        anonymousDirect: direct.status,
      });
    });

    it("cross-user at storage: A's presigned upload cannot write into B's prefix (key substitution + traversal)", async () => {
      const b = await readyAsset(tokenB);
      const { ticket, objectKey } = await createUpload(tokenA);
      const { body } = clip();
      const substituted = await rawRequest(
        "PUT",
        substituteKey(ticket.uploadUrl, env.bucket, b.objectKey),
        ticket.requiredHeaders,
        body,
      );
      const leaf = b.objectKey.split("/").pop() ?? "";
      const traversal = `media/${userA}/../${userB}/${leaf}`;
      const traversed = await rawRequest(
        "PUT",
        substituteKey(ticket.uploadUrl, env.bucket, traversal),
        ticket.requiredHeaders,
        body,
      );
      expect(substituted.status).toBe(403);
      expect(traversed.status).toBe(403);
      // B's object still holds B's bytes.
      const bRead = await app.inject({
        method: "GET",
        url: `/v1/media/${b.mediaAssetId}`,
        headers: auth(tokenB),
      });
      const bDownload = await rawRequest(
        "GET",
        (bRead.json() as { signedUrl: string }).signedUrl,
        {},
      );
      expect(bDownload.status).toBe(200);
      expect(bDownload.bodyBytes).toBe(b.body.length);
      expect(await objectExists(objectKey)).toBe(false);
      record("cross_user_upload", {
        substituted: substituted.status,
        traversed: traversed.status,
        victimIntact: bDownload.bodyBytes === b.body.length,
      });
    });

    it("spoofed bytes: storage may accept the PUT, but complete() rejects and purges it; no playback URL is ever issued", async () => {
      const { ticket, objectKey } = await createUpload(tokenA);
      const other = Buffer.alloc(4096, 9);
      const headersNoChecksum = { ...ticket.requiredHeaders };
      delete headersNoChecksum["x-amz-checksum-sha256"];
      const put = await rawRequest("PUT", ticket.uploadUrl, headersNoChecksum, other);
      const storedBeforeComplete = await objectExists(objectKey);
      const done = await complete(tokenA, ticket.mediaAssetId);
      expect(done.statusCode, done.body).toBe(422);
      expect((done.json() as { error: { code: string } }).error.code).toBe(
        "media.checksum_mismatch",
      );
      const read = await app.inject({
        method: "GET",
        url: `/v1/media/${ticket.mediaAssetId}`,
        headers: auth(tokenA),
      });
      expect(read.statusCode).toBe(404);
      const row = await pool.query("SELECT status, deleted_at FROM media_asset WHERE id = $1", [
        ticket.mediaAssetId,
      ]);
      expect(row.rows[0].status).toBe("deleted");
      expect(row.rows[0].deleted_at).not.toBeNull();
      await drainWorker();
      expect(await objectExists(objectKey)).toBe(false);
      record("spoofed_bytes", {
        storagePut: put.status,
        storedBeforeComplete,
        complete: done.statusCode,
        readAfter: read.statusCode,
        purged: true,
      });
    });

    it("spoofed bytes with the declared checksum header: storage itself refuses (400) and complete() sees no object", async () => {
      const { ticket, objectKey } = await createUpload(tokenA);
      const put = await rawRequest(
        "PUT",
        ticket.uploadUrl,
        ticket.requiredHeaders,
        Buffer.alloc(4096, 9),
      );
      expect(put.status).toBe(400);
      expect(put.code).toBe("XAmzContentChecksumMismatch");
      expect(await objectExists(objectKey)).toBe(false);
      const done = await complete(tokenA, ticket.mediaAssetId);
      expect(done.statusCode).toBe(422);
      expect((done.json() as { error: { code: string } }).error.code).toBe("media.object_missing");
      record("spoofed_bytes_declared_checksum", {
        storagePut: put.status,
        code: put.code,
        complete: done.statusCode,
      });
    });

    it("oversize: declarations above the per-kind cap are refused before any URL is signed", async () => {
      const { sha256 } = clip();
      const cases = [
        {
          kind: "raw_video",
          contentType: "video/mp4",
          bytes: MAX_UPLOAD_BYTES + 1,
          expectStatus: 400,
          expectCode: "validation.upload",
        },
        {
          kind: "thumbnail",
          contentType: "image/jpeg",
          bytes: MAX_THUMBNAIL_BYTES + 1,
          expectStatus: 422,
          expectCode: "media.too_large",
        },
        {
          kind: "raw_video",
          contentType: "video/mp4",
          bytes: Number.MAX_SAFE_INTEGER,
          expectStatus: 400,
          expectCode: "validation.upload",
        },
        {
          kind: "raw_video",
          contentType: "video/mp4",
          bytes: 0,
          expectStatus: 400,
          expectCode: "validation.upload",
        },
      ];
      const before = await pool.query(
        "SELECT count(*)::int AS n FROM media_asset WHERE owner_user_id = $1",
        [userA],
      );
      const observed: Array<{ bytes: number; status: number; code: string }> = [];
      for (const c of cases) {
        const res = await app.inject({
          method: "POST",
          url: "/v1/media/uploads",
          headers: auth(tokenA),
          payload: {
            kind: c.kind,
            filename: "big.bin",
            bytes: c.bytes,
            contentType: c.contentType,
            sha256,
          },
        });
        const code = (res.json() as { error: { code: string } }).error.code;
        expect(res.statusCode, res.body).toBe(c.expectStatus);
        expect(code).toBe(c.expectCode);
        observed.push({ bytes: c.bytes, status: res.statusCode, code });
      }
      const after = await pool.query(
        "SELECT count(*)::int AS n FROM media_asset WHERE owner_user_id = $1",
        [userA],
      );
      expect(after.rows[0].n).toBe(before.rows[0].n);
      record("oversize_declaration", { observed });
    });

    it("oversize at storage: a body larger than the signed content-length is refused and complete() sees no object", async () => {
      const { ticket, objectKey } = await createUpload(tokenA);
      const big = Buffer.alloc(4096 + 1, 7);
      const headers = {
        ...ticket.requiredHeaders,
        "content-length": String(big.length),
        "x-amz-checksum-sha256": createHash("sha256").update(big).digest("base64"),
      };
      const put = await rawRequest("PUT", ticket.uploadUrl, headers, big);
      expect(put.status).toBe(403);
      expect(put.code).toBe("SignatureDoesNotMatch");
      expect(await objectExists(objectKey)).toBe(false);
      const done = await complete(tokenA, ticket.mediaAssetId);
      expect(done.statusCode).toBe(422);
      expect((done.json() as { error: { code: string } }).error.code).toBe("media.object_missing");
      record("oversize_storage", {
        storagePut: put.status,
        code: put.code,
        complete: done.statusCode,
      });
    });

    it("content-type spoof at storage: a PUT with a different content-type than signed is refused", async () => {
      const { ticket, objectKey } = await createUpload(tokenA);
      const { body } = clip();
      const put = await rawRequest(
        "PUT",
        ticket.uploadUrl,
        { ...ticket.requiredHeaders, "content-type": "text/html" },
        body,
      );
      expect(put.status).toBe(403);
      expect(await objectExists(objectKey)).toBe(false);
      record("content_type_spoof", { storagePut: put.status, code: put.code });
    });

    it("kind/content-type binding: raw_video must be video, thumbnail must be image", async () => {
      const { sha256 } = clip();
      const bad = [
        { kind: "raw_video", contentType: "image/jpeg" },
        { kind: "thumbnail", contentType: "video/mp4" },
        { kind: "raw_video", contentType: "text/html" },
        { kind: "thumbnail", contentType: "image/svg+xml" },
      ];
      for (const c of bad) {
        const res = await app.inject({
          method: "POST",
          url: "/v1/media/uploads",
          headers: auth(tokenA),
          payload: { ...c, filename: "x", bytes: 1024, sha256 },
        });
        expect(res.statusCode, res.body).toBe(422);
        expect((res.json() as { error: { code: string } }).error.code).toBe(
          "media.unsupported_type",
        );
      }
      record("kind_type_binding", { rejected: bad.length });
    });

    it("expiry: a signed download URL stops working after its window; complete() cannot rescue an expired upload URL", async () => {
      const store = buildHarnessStore(env);
      const a = await readyAsset(tokenA);
      const shortDownload = await store.presignDownload(a.objectKey, 1);
      const { ticket, objectKey } = await createUpload(tokenA);
      const pending = await pool.query(
        "SELECT sha256, content_type, size_bytes FROM media_asset WHERE id = $1",
        [ticket.mediaAssetId],
      );
      const shortUpload = await store.presignUpload(objectKey, 1, {
        contentType: pending.rows[0].content_type,
        sizeBytes: Number(pending.rows[0].size_bytes),
        sha256Hex: pending.rows[0].sha256,
      });
      await new Promise((resolve) => setTimeout(resolve, 2100));
      const download = await rawRequest("GET", shortDownload, {});
      const upload = await rawRequest("PUT", shortUpload, ticket.requiredHeaders, clip().body);
      expect(download.status).toBe(403);
      expect(upload.status).toBe(403);
      const done = await complete(tokenA, ticket.mediaAssetId);
      expect(done.statusCode).toBe(422);
      expect((done.json() as { error: { code: string } }).error.code).toBe("media.object_missing");
      record("expiry", {
        download: download.status,
        downloadCode: download.code,
        upload: upload.status,
        uploadCode: upload.code,
        complete: done.statusCode,
      });
    }, 15_000);

    it("non-ready assets never yield a playback URL (409 while uploading)", async () => {
      const { ticket } = await createUpload(tokenA);
      const res = await app.inject({
        method: "GET",
        url: `/v1/media/${ticket.mediaAssetId}`,
        headers: auth(tokenA),
      });
      expect(res.statusCode).toBe(409);
      const body = res.json() as { error: { code: string }; signedUrl?: string };
      expect(body.error.code).toBe("media.not_ready");
      expect(body.signedUrl).toBeUndefined();
      record("not_ready", { status: res.statusCode, code: body.error.code });
    });

    it("deleted assets: the API stops issuing URLs immediately; the worker purge revokes an already-issued URL", async () => {
      const a = await readyAsset(tokenA);
      const read = await app.inject({
        method: "GET",
        url: `/v1/media/${a.mediaAssetId}`,
        headers: auth(tokenA),
      });
      const { signedUrl } = read.json() as { signedUrl: string };
      const remove = await app.inject({
        method: "DELETE",
        url: `/v1/media/${a.mediaAssetId}`,
        headers: auth(tokenA),
      });
      expect(remove.statusCode).toBe(204);
      const afterDelete = await app.inject({
        method: "GET",
        url: `/v1/media/${a.mediaAssetId}`,
        headers: auth(tokenA),
      });
      expect(afterDelete.statusCode).toBe(404);
      // Until the purge runs, the previously issued URL is still honoured by
      // storage (recorded, not asserted either way — the window is bounded
      // by the 300s signature and the worker cadence).
      const beforePurge = await rawRequest("GET", signedUrl, {});
      await drainWorker();
      const afterPurge = await rawRequest("GET", signedUrl, {});
      expect(afterPurge.status).toBe(404);
      expect(afterPurge.code).toBe("NoSuchKey");
      expect(await objectExists(a.objectKey)).toBe(false);
      const row = await pool.query("SELECT object_key FROM media_asset WHERE id = $1", [
        a.mediaAssetId,
      ]);
      expect(row.rows[0].object_key).toBeNull();
      record("deleted_asset", {
        apiAfterDelete: afterDelete.statusCode,
        storageBeforePurge: beforePurge.status,
        storageAfterPurge: afterPurge.status,
      });
    });

    it("privacy gate: with cloud sync off, uploads are refused and an in-flight complete() discards the object", async () => {
      const { ticket, objectKey } = await createUpload(tokenB);
      const put = await putHonest(ticket, clip().body);
      expect(put.status).toBe(200);
      const off = await app.inject({
        method: "PATCH",
        url: "/v1/me/settings",
        headers: auth(tokenB),
        payload: { cloudSyncEnabled: false },
      });
      expect(off.statusCode).toBe(200);
      const refused = await app.inject({
        method: "POST",
        url: "/v1/media/uploads",
        headers: auth(tokenB),
        payload: {
          kind: "raw_video",
          filename: "c.mp4",
          bytes: 10,
          contentType: "video/mp4",
          sha256: clip().sha256,
        },
      });
      expect(refused.statusCode).toBe(403);
      expect((refused.json() as { error: { code: string } }).error.code).toBe(
        "media.cloud_sync_disabled",
      );
      const done = await complete(tokenB, ticket.mediaAssetId);
      expect(done.statusCode).toBe(403);
      expect((done.json() as { error: { code: string } }).error.code).toBe(
        "media.cloud_sync_disabled",
      );
      await drainWorker();
      expect(await objectExists(objectKey)).toBe(false);
      const on = await app.inject({
        method: "PATCH",
        url: "/v1/me/settings",
        headers: auth(tokenB),
        payload: { cloudSyncEnabled: true },
      });
      expect(on.statusCode).toBe(200);
      record("privacy_gate", {
        create: refused.statusCode,
        complete: done.statusCode,
        purged: true,
      });
    });

    it("bucket is private: anonymous list/get/head/delete on the bucket and on real keys are all denied", async () => {
      const a = await readyAsset(tokenA);
      const base = `${env.endpoint}/${env.bucket}`;
      const probes = await Promise.all([
        rawRequest("GET", `${base}/`, {}),
        rawRequest("GET", `${base}?list-type=2&prefix=media/${userA}/`, {}),
        rawRequest("GET", `${base}/${a.objectKey}`, {}),
        rawRequest("HEAD", `${base}/${a.objectKey}`, {}),
        rawRequest("DELETE", `${base}/${a.objectKey}`, {}),
        rawRequest(
          "PUT",
          `${base}/${a.objectKey}`,
          { "content-length": "3", "content-type": "video/mp4" },
          Buffer.from("abc"),
        ),
        rawRequest("GET", `${base}?acl`, {}),
        rawRequest("GET", `${base}?policy`, {}),
      ]);
      for (const probe of probes) expect(probe.status, probe.bodyPrefix).toBe(403);
      expect(await objectExists(a.objectKey)).toBe(true);
      record("bucket_private", { statuses: probes.map((p) => `${p.status}/${p.code ?? "-"}`) });
    });
  },
);
