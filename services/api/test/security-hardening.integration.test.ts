import { createHash, randomUUID } from "node:crypto";
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
import { sha256HexToBase64 } from "../src/modules/media/objectStore.js";
import { FakeObjectStore } from "./support/fakeObjectStore.js";
import { publishTestScoringRelease } from "./support/scoringRelease.js";

/**
 * Wave H gate 8 regression suite: every exploit that the live security pass
 * against the local stack found, asserted against a REAL PostgreSQL database.
 * Covers cross-user resource binding on share cards, stored-object integrity
 * (size/type/checksum), typed handling of malformed identifiers, and per-caller
 * request budgets.
 */

const testUrl = process.env["DATABASE_URL_TEST"];
const secret = "security-hardening-secret-0123456789";
const schemaName = `sec_hardening_${process.pid}_${randomUUID().replaceAll("-", "")}`;
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

const hex = (value: string) => createHash("sha256").update(value).digest("hex");

describe.skipIf(!testUrl)("security hardening regressions (isolated PostgreSQL schema)", () => {
  let app: FastifyInstance;
  let pool: pg.Pool;
  let adminPool: pg.Pool;
  let store: FakeObjectStore;
  let tokenA: string;
  let tokenB: string;
  let sessionA: string;

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  async function bootstrapUser(minter: DevTokenVerifier): Promise<string> {
    const token = await minter.mint(`sec-hardening|${randomUUID()}`);
    const bootstrap = await app.inject({
      method: "POST",
      url: "/v1/account/bootstrap",
      headers: auth(token),
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
      headers: auth(token),
      payload: { cloudSyncEnabled: true },
    });
    expect(settings.statusCode, settings.body).toBe(200);
    return token;
  }

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
    store = new FakeObjectStore();
    app = buildApp(config, { queue: new InMemoryJobQueue(), objectStore: store });

    const minter = new DevTokenVerifier("test", secret);
    tokenA = await bootstrapUser(minter);
    tokenB = await bootstrapUser(minter);

    sessionA = randomUUID();
    const created = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: auth(tokenA),
      payload: {
        id: sessionA,
        mode: "live",
        shotType: "forehand_drive",
        focusCheckpoint: "contact_position",
        cameraView: "side",
        startedAt: new Date().toISOString(),
      },
    });
    expect(created.statusCode, created.body).toBe(200);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    if (adminPool) {
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await adminPool.end();
    }
  });

  async function createUpload(
    token: string,
    overrides: Record<string, unknown> = {},
  ): Promise<{ mediaAssetId: string; objectKey: string; body: Record<string, unknown> }> {
    const payload = {
      kind: "raw_video",
      filename: "clip.mp4",
      bytes: 2048,
      contentType: "video/mp4",
      sha256: hex(randomUUID()),
      ...overrides,
    };
    const res = await app.inject({
      method: "POST",
      url: "/v1/media/uploads",
      headers: auth(token),
      payload,
    });
    expect(res.statusCode, res.body).toBe(200);
    const created = res.json() as {
      mediaAssetId: string;
      requiredHeaders: Record<string, string>;
    };
    const row = await pool.query("SELECT object_key FROM media_asset WHERE id = $1", [
      created.mediaAssetId,
    ]);
    return {
      mediaAssetId: created.mediaAssetId,
      objectKey: row.rows[0].object_key as string,
      body: payload,
    };
  }

  it("share cards cannot reference another user's session (IDOR)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/share-cards",
      headers: auth(tokenB),
      payload: {
        shotId: null,
        sessionId: sessionA,
        templateKey: "progress_card",
        privacyOptions: { hideFace: true, hideName: false },
      },
    });
    expect(res.statusCode, res.body).toBe(404);
    expect((res.json() as { error: { code: string } }).error.code).toBe("session.not_found");
    const leaked = await pool.query("SELECT id FROM share_card WHERE session_id = $1", [sessionA]);
    expect(leaked.rowCount).toBe(0);
  });

  it("share cards still accept the owner's own session", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/share-cards",
      headers: auth(tokenA),
      payload: {
        shotId: null,
        sessionId: sessionA,
        templateKey: "progress_card",
        privacyOptions: { hideFace: true, hideName: false },
      },
    });
    expect(res.statusCode, res.body).toBe(200);
  });

  it("presigned upload response binds content type, byte count, and checksum", async () => {
    const sha256 = hex("bound-upload");
    const res = await app.inject({
      method: "POST",
      url: "/v1/media/uploads",
      headers: auth(tokenA),
      payload: {
        kind: "raw_video",
        filename: "clip.mp4",
        bytes: 4096,
        contentType: "video/mp4",
        sha256,
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    const created = res.json() as { requiredHeaders: Record<string, string>; uploadUrl: string };
    expect(created.requiredHeaders["content-type"]).toBe("video/mp4");
    expect(created.requiredHeaders["content-length"]).toBe("4096");
    expect(created.requiredHeaders["x-amz-checksum-sha256"]).toBe(sha256HexToBase64(sha256));
  });

  it("stored bytes whose checksum differs from the declared hash are rejected and purged", async () => {
    const { mediaAssetId, objectKey } = await createUpload(tokenA);
    store.objects.set(objectKey, 2048);
    store.storedChecksum.set(objectKey, sha256HexToBase64(hex("other-bytes")));
    const res = await app.inject({
      method: "POST",
      url: `/v1/media/${mediaAssetId}/complete`,
      headers: auth(tokenA),
    });
    expect(res.statusCode, res.body).toBe(422);
    const body = res.json() as { error: { kind: string; code: string } };
    expect(body.error.kind).toBe("corrupted_media");
    expect(body.error.code).toBe("media.checksum_mismatch");
    const row = await pool.query("SELECT status FROM media_asset WHERE id = $1", [mediaAssetId]);
    expect(row.rows[0].status).toBe("deleted");
  });

  it("an object stored without a checksum is never promoted to ready", async () => {
    const { mediaAssetId, objectKey } = await createUpload(tokenA);
    store.objects.set(objectKey, 2048);
    store.storedChecksum.set(objectKey, null);
    const res = await app.inject({
      method: "POST",
      url: `/v1/media/${mediaAssetId}/complete`,
      headers: auth(tokenA),
    });
    expect(res.statusCode, res.body).toBe(422);
    expect((res.json() as { error: { code: string } }).error.code).toBe("media.checksum_mismatch");
  });

  it("content-type spoofing (executable stored under a declared video) is rejected", async () => {
    const { mediaAssetId, objectKey } = await createUpload(tokenA);
    store.objects.set(objectKey, 2048);
    store.storedContentType.set(objectKey, "application/x-msdownload");
    const res = await app.inject({
      method: "POST",
      url: `/v1/media/${mediaAssetId}/complete`,
      headers: auth(tokenA),
    });
    expect(res.statusCode, res.body).toBe(422);
    expect((res.json() as { error: { code: string } }).error.code).toBe(
      "media.content_type_mismatch",
    );
    const row = await pool.query("SELECT status FROM media_asset WHERE id = $1", [mediaAssetId]);
    expect(row.rows[0].status).toBe("deleted");
  });

  it("an honest upload (declared type, size, and hash all match) still completes", async () => {
    const { mediaAssetId, objectKey } = await createUpload(tokenA);
    store.objects.set(objectKey, 2048);
    const res = await app.inject({
      method: "POST",
      url: `/v1/media/${mediaAssetId}/complete`,
      headers: auth(tokenA),
    });
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as { mediaAsset: { status: string } }).mediaAsset.status).toBe("ready");
  });

  it("malformed identifiers are typed 400s, never untyped 500s", async () => {
    const hostile = ["not-a-uuid", "1 OR 1=1", "../../etc/passwd", "%00", "0x00"];
    for (const bad of hostile) {
      for (const url of [
        `/v1/sessions/${encodeURIComponent(bad)}`,
        `/v1/media/${encodeURIComponent(bad)}`,
        `/v1/share-cards/${encodeURIComponent(bad)}`,
      ]) {
        const res = await app.inject({ method: "GET", url, headers: auth(tokenA) });
        expect([400, 404], `${url} -> ${res.statusCode} ${res.body}`).toContain(res.statusCode);
        const body = res.json() as { error: { kind: string; code: string; requestId: string } };
        expect(body.error.kind).toBe("permanent");
        expect(body.error.requestId).toBeTruthy();
      }
    }
  });

  it("a NUL byte in the path is a typed 400 and never reaches the database", async () => {
    for (const url of ["/v1/sessions/%00", "/v1/media/abc%00def", "/v1/catalog/drills/%00"]) {
      const res = await app.inject({ method: "GET", url, headers: auth(tokenA) });
      expect(res.statusCode, `${url} -> ${res.body}`).toBe(400);
      const body = res.json() as { error: { kind: string; code: string } };
      expect(body.error.kind).toBe("permanent");
      expect(body.error.code).toBe("validation.identifier");
    }
  });

  it("an unparseable JSON body is a typed 400, not an internal error", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/media/uploads",
      headers: { ...auth(tokenA), "content-type": "application/json" },
      payload: "{not json",
    });
    expect(res.statusCode, res.body).toBe(400);
    expect((res.json() as { error: { kind: string } }).error.kind).toBe("permanent");
  });

  it("expensive routes are rate limited per caller, and other callers are unaffected", async () => {
    const limitedApp = buildApp(
      {
        env: "test",
        port: 0,
        host: "127.0.0.1",
        appVersion: "0.1.0-test",
        databaseUrl: schemaUrl(testUrl!, schemaName),
        devAuthSecret: secret,
        oidcIssuer: undefined,
        oidcAudience: undefined,
        oidcJwksUrl: undefined,
        sqsQueueUrl: undefined,
        consentExportSigningKey: undefined,
        consentExportSigningKeyId: "consent-export-k1",
        appleIapConfigured: false,
        googlePlayConfigured: false,
      },
      {
        queue: new InMemoryJobQueue(),
        objectStore: store,
        rateLimit: { enabled: true, windowMs: 60_000, defaultLimit: 50, expensiveLimit: 3 },
      },
    );
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 6; i += 1) {
        const res = await limitedApp.inject({
          method: "POST",
          url: "/v1/me/export",
          headers: auth(tokenA),
        });
        statuses.push(res.statusCode);
      }
      expect(statuses.slice(0, 3)).toEqual([200, 200, 200]);
      expect(statuses.slice(3)).toEqual([429, 429, 429]);

      const limited = await limitedApp.inject({
        method: "POST",
        url: "/v1/me/export",
        headers: auth(tokenA),
      });
      const body = limited.json() as { error: { kind: string; code: string; retryable: boolean } };
      expect(body.error.code).toBe("api.rate_limited");
      expect(body.error.retryable).toBe(true);
      expect(limited.headers["retry-after"]).toBeTruthy();

      const other = await limitedApp.inject({
        method: "POST",
        url: "/v1/me/export",
        headers: auth(tokenB),
      });
      expect(other.statusCode, other.body).toBe(200);

      // A different route class keeps its own, larger budget.
      const health = await limitedApp.inject({ method: "GET", url: "/v1/health" });
      expect(health.statusCode).toBe(200);
    } finally {
      await limitedApp.close();
    }
  });
});
