import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations, seed } from "@pickle/database";
import { InMemoryJobQueue } from "@pickle/queue";
import { buildApp } from "../src/app.js";
import { DevTokenVerifier } from "../src/auth/tokens.js";
import type { ApiConfig } from "../src/config.js";
import type { IObjectStore } from "../src/modules/media/objectStore.js";
import { publishTestScoringRelease } from "./support/scoringRelease.js";

/**
 * Wave D3-12 red-team suite: media upload/deletion error taxonomy against a
 * REAL PostgreSQL database with a fake object store + fault-injectable queue.
 * Every failure asserted here must be a typed envelope — never an untyped 500.
 */

const testUrl = process.env["DATABASE_URL_TEST"];
const secret = "media-redteam-secret-0123456789";
const schemaName = `media_redteam_${process.pid}_${randomUUID().replaceAll("-", "")}`;
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

/** Synthetic in-memory object store: byte sizes are set per key by tests. */
class FakeObjectStore implements IObjectStore {
  readonly bucket = "fake-bucket";
  objects = new Map<string, number>();
  deletedKeys: string[] = [];

  async presignUpload(key: string): Promise<string> {
    return `https://fake/upload/${key}`;
  }
  async presignDownload(key: string): Promise<string> {
    return `https://fake/download/${key}`;
  }
  async deleteObject(key: string): Promise<void> {
    this.objects.delete(key);
    this.deletedKeys.push(key);
  }
  async headObject(key: string): Promise<{ sizeBytes: number } | null> {
    const size = this.objects.get(key);
    return size === undefined ? null : { sizeBytes: size };
  }
}

/** Queue wrapper that can be told to fail the next enqueue (dispatch fault). */
class FaultyQueue extends InMemoryJobQueue {
  failNextEnqueue = false;
  override async enqueue(kind: string, payload: unknown): Promise<string> {
    if (this.failNextEnqueue) {
      this.failNextEnqueue = false;
      throw new Error("synthetic queue outage");
    }
    return super.enqueue(kind, payload);
  }
}

describe.skipIf(!testUrl)("media error taxonomy red team (isolated PostgreSQL schema)", () => {
  let app: FastifyInstance;
  let pool: pg.Pool;
  let adminPool: pg.Pool;
  let queue: FaultyQueue;
  let store: FakeObjectStore;
  let userToken: string;

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  beforeAll(async () => {
    adminPool = new pg.Pool({ connectionString: testUrl });
    await adminPool.query(`CREATE SCHEMA ${schemaName}`);
    const scopedUrl = schemaUrl(testUrl!, schemaName);
    pool = new pg.Pool({ connectionString: scopedUrl });
    await runMigrations(pool, migrationsDir);
    await seed(pool);
    await publishTestScoringRelease(pool);

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
    queue = new FaultyQueue();
    store = new FakeObjectStore();
    app = buildApp(config, { queue, objectStore: store });

    const minter = new DevTokenVerifier("test", secret);
    userToken = await minter.mint(`media-rt|${randomUUID()}`);
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
    expect(bootstrap.statusCode).toBe(200);
    const settings = await app.inject({
      method: "PATCH",
      url: "/v1/me/settings",
      headers: auth(userToken),
      payload: { cloudSyncEnabled: true },
    });
    expect(settings.statusCode).toBe(200);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    if (adminPool) {
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await adminPool.end();
    }
  });

  function uploadBody(overrides: Record<string, unknown> = {}) {
    return {
      kind: "raw_video",
      filename: "clip.mp4",
      bytes: 1024,
      contentType: "video/mp4",
      sha256: "a".repeat(64),
      ...overrides,
    };
  }

  async function createUpload(
    overrides: Record<string, unknown> = {},
  ): Promise<{ mediaAssetId: string; objectKey: string }> {
    const res = await app.inject({
      method: "POST",
      url: "/v1/media/uploads",
      headers: auth(userToken),
      payload: uploadBody(overrides),
    });
    expect(res.statusCode, res.body).toBe(200);
    const { mediaAssetId } = res.json() as { mediaAssetId: string };
    const row = await pool.query("SELECT object_key FROM media_asset WHERE id = $1", [
      mediaAssetId,
    ]);
    return { mediaAssetId, objectKey: row.rows[0].object_key as string };
  }

  it("malformed upload bodies are typed 400s, never crashes", async () => {
    for (const bad of [
      {},
      uploadBody({ bytes: -5 }),
      uploadBody({ bytes: 1.5 }),
      uploadBody({ sha256: "not-hex" }),
      uploadBody({ kind: "model_bundle" }),
      uploadBody({ filename: "x".repeat(300) }),
    ]) {
      const res = await app.inject({
        method: "POST",
        url: "/v1/media/uploads",
        headers: auth(userToken),
        payload: bad,
      });
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
      const body = res.json() as { error: { kind: string; code: string; requestId: string } };
      expect(body.error.kind).toBe("permanent");
      expect(body.error.code).toBe("validation.upload");
      expect(body.error.requestId).toBeTruthy();
    }
  });

  it("kind/contentType mismatch is rejected (raw_video must be video, thumbnail must be image)", async () => {
    for (const bad of [
      uploadBody({ kind: "raw_video", contentType: "image/jpeg" }),
      uploadBody({ kind: "thumbnail", contentType: "video/mp4" }),
      uploadBody({ contentType: "application/x-msdownload" }),
    ]) {
      const res = await app.inject({
        method: "POST",
        url: "/v1/media/uploads",
        headers: auth(userToken),
        payload: bad,
      });
      expect(res.statusCode, JSON.stringify(bad)).toBe(422);
      const body = res.json() as { error: { kind: string; code: string } };
      expect(body.error.kind).toBe("corrupted_media");
      expect(body.error.code).toBe("media.unsupported_type");
    }
  });

  it("oversized declarations are rejected per kind (500MB thumbnail is not a thumbnail)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/media/uploads",
      headers: auth(userToken),
      payload: uploadBody({
        kind: "thumbnail",
        contentType: "image/jpeg",
        bytes: 400 * 1024 * 1024,
      }),
    });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: { code: string } }).error.code).toBe("media.too_large");
  });

  it("complete with no uploaded object is a typed 422 and the upload stays retryable", async () => {
    const { mediaAssetId } = await createUpload();
    const res = await app.inject({
      method: "POST",
      url: `/v1/media/${mediaAssetId}/complete`,
      headers: auth(userToken),
    });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: { code: string } }).error.code).toBe("media.object_missing");
    const row = await pool.query("SELECT status FROM media_asset WHERE id = $1", [mediaAssetId]);
    expect(row.rows[0].status).toBe("uploading");
  });

  it("oversized actual upload (declared small, uploaded huge) is rejected and purged", async () => {
    const { mediaAssetId, objectKey } = await createUpload({ bytes: 1024 });
    store.objects.set(objectKey, 900 * 1024 * 1024); // lied about the size
    const res = await app.inject({
      method: "POST",
      url: `/v1/media/${mediaAssetId}/complete`,
      headers: auth(userToken),
    });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: { code: string } }).error.code).toBe("media.size_exceeded");
    const row = await pool.query("SELECT status, deleted_at FROM media_asset WHERE id = $1", [
      mediaAssetId,
    ]);
    expect(row.rows[0].status).toBe("deleted");
    expect(row.rows[0].deleted_at).not.toBeNull();
    const received = await queue.receive(100);
    const purge = received.find(
      ({ job }) =>
        job.kind === "media.purge" &&
        (job.payload as { mediaAssetId: string }).mediaAssetId === mediaAssetId,
    );
    expect(purge, "purge job queued for the oversized object").toBeTruthy();
    queue.expireInFlight(); // put everything back for later tests
  });

  it("dispatch failure mid-pipeline: complete reverts to uploading with a typed retryable 503, then retry works", async () => {
    const { mediaAssetId, objectKey } = await createUpload();
    store.objects.set(objectKey, 1024);
    queue.failNextEnqueue = true;
    const res = await app.inject({
      method: "POST",
      url: `/v1/media/${mediaAssetId}/complete`,
      headers: auth(userToken),
    });
    expect(res.statusCode).toBe(503);
    const body = res.json() as { error: { kind: string; code: string; retryable: boolean } };
    expect(body.error.kind).toBe("retryable");
    expect(body.error.code).toBe("media.dispatch_failed");
    expect(body.error.retryable).toBe(true);
    const row = await pool.query("SELECT status FROM media_asset WHERE id = $1", [mediaAssetId]);
    expect(row.rows[0].status).toBe("uploading"); // client can retry complete

    const retry = await app.inject({
      method: "POST",
      url: `/v1/media/${mediaAssetId}/complete`,
      headers: auth(userToken),
    });
    expect(retry.statusCode).toBe(200);
    expect((retry.json() as { mediaAsset: { status: string } }).mediaAsset.status).toBe("ready");
  });

  it("deletion survives a purge dispatch failure: still 204, still recorded deleted", async () => {
    const { mediaAssetId, objectKey } = await createUpload();
    store.objects.set(objectKey, 1024);
    await app.inject({
      method: "POST",
      url: `/v1/media/${mediaAssetId}/complete`,
      headers: auth(userToken),
    });
    queue.failNextEnqueue = true;
    const res = await app.inject({
      method: "DELETE",
      url: `/v1/media/${mediaAssetId}`,
      headers: auth(userToken),
    });
    expect(res.statusCode).toBe(204);
    const row = await pool.query(
      "SELECT status, deleted_at, object_key FROM media_asset WHERE id = $1",
      [mediaAssetId],
    );
    expect(row.rows[0].status).toBe("deleted");
    expect(row.rows[0].deleted_at).not.toBeNull();
    // object_key intentionally kept so the worker sweep can still purge it.
    expect(row.rows[0].object_key).toBe(objectKey);
  });

  it("double-deletion: the second delete is a typed 404, not a duplicate purge", async () => {
    const { mediaAssetId } = await createUpload();
    const first = await app.inject({
      method: "DELETE",
      url: `/v1/media/${mediaAssetId}`,
      headers: auth(userToken),
    });
    expect(first.statusCode).toBe(204);
    const second = await app.inject({
      method: "DELETE",
      url: `/v1/media/${mediaAssetId}`,
      headers: auth(userToken),
    });
    expect(second.statusCode).toBe(404);
    expect((second.json() as { error: { code: string } }).error.code).toBe("media.not_found");
  });

  it("deleted media cannot be completed, played back, or analyzed", async () => {
    const { mediaAssetId, objectKey } = await createUpload();
    store.objects.set(objectKey, 1024);
    await app.inject({
      method: "POST",
      url: `/v1/media/${mediaAssetId}/complete`,
      headers: auth(userToken),
    });
    const del = await app.inject({
      method: "DELETE",
      url: `/v1/media/${mediaAssetId}`,
      headers: auth(userToken),
    });
    expect(del.statusCode).toBe(204);

    const playback = await app.inject({
      method: "GET",
      url: `/v1/media/${mediaAssetId}`,
      headers: auth(userToken),
    });
    expect(playback.statusCode).toBe(404);

    const complete = await app.inject({
      method: "POST",
      url: `/v1/media/${mediaAssetId}/complete`,
      headers: auth(userToken),
    });
    expect(complete.statusCode).toBe(404);

    const permit = await app.inject({
      method: "POST",
      url: "/v1/analysis-permits",
      headers: auth(userToken),
      payload: { idempotencyKey: randomUUID() },
    });
    expect(permit.statusCode, permit.body).toBe(200);
    const permitId = (permit.json() as { permit: { id: string } }).permit.id;
    const analysis = await app.inject({
      method: "POST",
      url: "/v1/analyses",
      headers: auth(userToken),
      payload: {
        mediaAssetId,
        localAnalysisId: randomUUID(),
        expectedShotType: null,
        inferenceMode: "on_device",
        sessionId: null,
        permitId,
      },
    });
    expect(analysis.statusCode).toBe(404);
    expect((analysis.json() as { error: { code: string } }).error.code).toBe("media.not_found");
  });
});
