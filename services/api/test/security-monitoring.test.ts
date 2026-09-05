import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { runMigrations, seed } from "@pickle/database";
import { InMemoryJobQueue } from "@pickle/queue";
import { buildApp } from "../src/app.js";
import { DevTokenVerifier } from "../src/auth/tokens.js";
import type { ApiConfig } from "../src/config.js";
import {
  classifySecurityEvent,
  findSecurityEventViolations,
  InMemorySecurityEventSink,
  type SecurityEvent,
} from "../src/lib/securityEvents.js";

/**
 * Security-monitoring detectors (workstream i25): typed events for auth
 * anomalies, authorization denials, admin anomalies, upload abuse,
 * rate-limit trips, media-access failures, DB privilege anomalies, consent
 * mutation attempts, and training-eligibility changes — exercised through
 * the same request paths the security/consent suites attack, plus redaction
 * checks proving no secrets or PII reach any recorded event.
 */

const DEV_SECRET = "security-monitoring-secret-0123456789";

const baseConfig: ApiConfig = {
  env: "test",
  port: 0,
  host: "127.0.0.1",
  appVersion: "0.1.0-test",
  databaseUrl: null,
  devAuthSecret: DEV_SECRET,
  oidcIssuer: undefined,
  oidcAudience: undefined,
  oidcJwksUrl: undefined,
  sqsQueueUrl: undefined,
  consentExportSigningKey: undefined,
  consentExportSigningKeyId: "consent-export-k1",
  appleIapConfigured: false,
  googlePlayConfigured: false,
};

const classifierBase = {
  at: new Date().toISOString(),
  requestId: "req-1",
  method: "GET",
};

describe("classifySecurityEvent (unit)", () => {
  it("maps a 401 with an auth code to auth_anomaly", () => {
    const event = classifySecurityEvent({
      ...classifierBase,
      route: "/v1/me",
      statusCode: 401,
      errorCode: "auth.missing_token",
    });
    expect(event).toMatchObject({ kind: "auth_anomaly", errorCode: "auth.missing_token" });
  });

  it("maps a 403 to authz_denial on non-admin routes", () => {
    const event = classifySecurityEvent({
      ...classifierBase,
      route: "/v1/media/:id",
      statusCode: 403,
      errorCode: "permission.denied",
    });
    // /v1/media/:id is a media-access route, so it wins over generic 403.
    expect(event).toMatchObject({ kind: "media_access_failure" });
    const generic = classifySecurityEvent({
      ...classifierBase,
      route: "/v1/sessions/:id",
      statusCode: 403,
      errorCode: "permission.denied",
    });
    expect(generic).toMatchObject({ kind: "authz_denial" });
  });

  it("maps admin-route denials and admin-claim refusals to admin_anomaly", () => {
    const onAdminRoute = classifySecurityEvent({
      ...classifierBase,
      route: "/v1/admin/users/:id",
      statusCode: 403,
      errorCode: "auth.admin_required",
    });
    expect(onAdminRoute).toMatchObject({ kind: "admin_anomaly" });
    const claimRefused = classifySecurityEvent({
      ...classifierBase,
      route: "/v1/admin/flags/:key",
      statusCode: 403,
      errorCode: "auth.admin_not_authorized",
    });
    expect(claimRefused).toMatchObject({ kind: "admin_anomaly" });
  });

  it("gives rate-limit trips precedence over every other kind", () => {
    const event = classifySecurityEvent({
      ...classifierBase,
      method: "POST",
      route: "/v1/media/uploads",
      statusCode: 429,
      errorCode: "api.rate_limited",
    });
    expect(event).toMatchObject({ kind: "rate_limit_trip" });
  });

  it("maps upload-route 4xx (other than auth) to upload_abuse", () => {
    const tooLarge = classifySecurityEvent({
      ...classifierBase,
      method: "POST",
      route: "/v1/media/uploads",
      statusCode: 400,
      errorCode: "media.too_large",
    });
    expect(tooLarge).toMatchObject({ kind: "upload_abuse" });
    const unauthed = classifySecurityEvent({
      ...classifierBase,
      method: "POST",
      route: "/v1/media/uploads",
      statusCode: 401,
      errorCode: "auth.missing_token",
    });
    expect(unauthed).toMatchObject({ kind: "auth_anomaly" });
  });

  it("maps consent mutation 4xx to consent_mutation_denied and 2xx to training_eligibility_change", () => {
    const denied = classifySecurityEvent({
      ...classifierBase,
      method: "POST",
      route: "/v1/me/consent/grant",
      statusCode: 400,
      errorCode: "consent.version_rejected",
    });
    expect(denied).toMatchObject({ kind: "consent_mutation_denied" });
    const changed = classifySecurityEvent({
      ...classifierBase,
      method: "POST",
      route: "/v1/me/consent/withdraw",
      statusCode: 200,
      errorCode: undefined,
    });
    expect(changed).toMatchObject({
      kind: "training_eligibility_change",
      surface: "consent_ledger",
    });
    const privacyCenter = classifySecurityEvent({
      ...classifierBase,
      method: "PUT",
      route: "/v1/me/ml-training-consent",
      statusCode: 200,
      errorCode: undefined,
    });
    expect(privacyCenter).toMatchObject({
      kind: "training_eligibility_change",
      surface: "privacy_center",
    });
  });

  it("returns null for requests with no security significance", () => {
    expect(
      classifySecurityEvent({
        ...classifierBase,
        route: "/v1/health",
        statusCode: 200,
        errorCode: undefined,
      }),
    ).toBeNull();
    expect(
      classifySecurityEvent({
        ...classifierBase,
        route: "/v1/drills/:slug",
        statusCode: 404,
        errorCode: "drill.not_found",
      }),
    ).toBeNull();
    expect(
      classifySecurityEvent({
        ...classifierBase,
        route: "/v1/catalog/shot-types",
        statusCode: 503,
        errorCode: "catalog.db_unavailable",
      }),
    ).toBeNull();
  });
});

describe("findSecurityEventViolations (redaction)", () => {
  const clean: SecurityEvent = {
    kind: "auth_anomaly",
    at: new Date().toISOString(),
    requestId: "req-2",
    route: "/v1/me",
    method: "GET",
    statusCode: 401,
    errorCode: "auth.missing_token",
  };

  it("passes a clean event", () => {
    expect(findSecurityEventViolations(clean)).toEqual([]);
  });

  it("flags bearer credentials, JWTs, emails, and long hex secrets", () => {
    const poisoned = {
      ...clean,
      errorCode: "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl",
    };
    const violations = findSecurityEventViolations(poisoned);
    expect(violations.some((v) => v.includes("bearer"))).toBe(true);
    expect(violations.some((v) => v.includes("JWT"))).toBe(true);
    expect(
      findSecurityEventViolations({ ...clean, requestId: "coach@example.com" }),
    ).toContainEqual(expect.stringContaining("email"));
    expect(findSecurityEventViolations({ ...clean, requestId: "a".repeat(64) })).toContainEqual(
      expect.stringContaining("hex"),
    );
  });

  it("flags a concrete UUID leaking into the route field", () => {
    const violations = findSecurityEventViolations({
      ...clean,
      route: `/v1/media/${randomUUID()}`,
    });
    expect(violations).toContainEqual(expect.stringContaining("route template"));
  });

  it("flags fields outside the allowlist", () => {
    const withExtra = { ...clean, userEmail: "x@y.com" } as unknown as SecurityEvent;
    expect(findSecurityEventViolations(withExtra)).toContainEqual(
      expect.stringContaining("disallowed field"),
    );
  });
});

describe("security-monitoring detectors (no database)", () => {
  const sink = new InMemorySecurityEventSink();
  const app = buildApp(baseConfig, {
    queue: new InMemoryJobQueue(),
    securityEvents: sink,
    rateLimit: { defaultLimit: 3 },
  });
  // Test-only route that simulates the API's DB role hitting a Postgres
  // privilege wall (SQLSTATE 42501 insufficient_privilege).
  app.get("/v1/__test-priv", async () => {
    const error = new Error("permission denied for table consent_record") as Error & {
      code: string;
    };
    error.code = "42501";
    throw error;
  });

  afterAll(async () => {
    await app.close();
  });
  afterEach(() => {
    for (const event of sink.events) {
      expect(findSecurityEventViolations(event), JSON.stringify(event)).toEqual([]);
    }
    sink.events.length = 0;
  });

  it("records auth_anomaly for a request with no credential", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/me" });
    expect(res.statusCode).toBe(401);
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]).toMatchObject({
      kind: "auth_anomaly",
      route: "/v1/me",
      statusCode: 401,
      errorCode: "auth.missing_token",
    });
  });

  it("records admin_anomaly for an unauthenticated probe of an admin route", async () => {
    const res = await app.inject({ method: "GET", url: `/v1/admin/users/${randomUUID()}` });
    expect(res.statusCode).toBe(401);
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]).toMatchObject({ kind: "admin_anomaly", route: "/v1/admin/users/:id" });
  });

  it("records db_privilege_anomaly with the Postgres SQLSTATE when the DB role is refused", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/__test-priv" });
    expect(res.statusCode).toBe(500);
    expect((res.json() as { error: { code: string } }).error.code).toBe("api.internal_error");
    const anomalies = sink.events.filter((e) => e.kind === "db_privilege_anomaly");
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]).toMatchObject({ pgCode: "42501", route: "/v1/__test-priv" });
    // The response body never carries the Postgres detail.
    expect(res.body).not.toContain("consent_record");
  });

  it("records rate_limit_trip when a caller exhausts its budget", async () => {
    let tripped = false;
    for (let i = 0; i < 5; i += 1) {
      const res = await app.inject({ method: "GET", url: "/v1/openapi.json" });
      if (res.statusCode === 429) tripped = true;
    }
    expect(tripped).toBe(true);
    const trips = sink.events.filter((e) => e.kind === "rate_limit_trip");
    expect(trips.length).toBeGreaterThan(0);
    expect(trips[0]).toMatchObject({ errorCode: "api.rate_limited", statusCode: 429 });
  });

  it("never records the bearer token, URL query, or body of the offending request", async () => {
    const secretToken = `eyJhbGciOiJIUzI1NiJ9.${"a".repeat(24)}.${"b".repeat(24)}`;
    // An unverified bearer is budgeted by address, and the previous test
    // exhausted 127.0.0.1's — probe from a fresh address to reach auth.
    const res = await app.inject({
      method: "GET",
      url: "/v1/me?email=victim@example.com",
      remoteAddress: "203.0.113.99",
      headers: { authorization: `Bearer ${secretToken}` },
    });
    expect(res.statusCode).toBe(401);
    expect(sink.events).toHaveLength(1);
    const serialized = JSON.stringify(sink.events[0]);
    expect(serialized).not.toContain(secretToken);
    expect(serialized).not.toContain("victim@example.com");
    expect(serialized).not.toContain("email=");
  });
});

const testUrl = process.env["DATABASE_URL_TEST"];
const schemaName = `sec_monitoring_${process.pid}_${randomUUID().replaceAll("-", "")}`;
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

describe.skipIf(!testUrl)("security-monitoring detectors (real PostgreSQL)", () => {
  let app: FastifyInstance;
  let pool: pg.Pool;
  let adminPool: pg.Pool;
  let userToken: string;
  const sink = new InMemorySecurityEventSink();
  const headers = () => ({ authorization: `Bearer ${userToken}` });

  beforeAll(async () => {
    adminPool = new pg.Pool({ connectionString: testUrl });
    await adminPool.query(`CREATE SCHEMA ${schemaName}`);
    const scopedUrl = schemaUrl(testUrl!, schemaName);
    pool = new pg.Pool({ connectionString: scopedUrl });
    await runMigrations(pool, migrationsDir);
    await seed(pool);

    app = buildApp(
      { ...baseConfig, databaseUrl: scopedUrl },
      { queue: new InMemoryJobQueue(), securityEvents: sink },
    );
    const minter = new DevTokenVerifier("test", DEV_SECRET);
    userToken = await minter.mint(`auth0|sec-monitoring-${randomUUID()}`);
    const bootstrap = await app.inject({
      method: "POST",
      url: "/v1/account/bootstrap",
      headers: headers(),
      payload: {
        locale: "en-US",
        timezone: "America/Los_Angeles",
        device: { platform: "ios", osVersion: "18.0", appVersion: "0.1.0", model: "iPhone16,1" },
      },
    });
    expect(bootstrap.statusCode, bootstrap.body).toBe(200);
    sink.events.length = 0;
  }, 60000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    if (adminPool) {
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await adminPool.end();
    }
  });

  afterEach(() => {
    for (const event of sink.events) {
      expect(findSecurityEventViolations(event), JSON.stringify(event)).toEqual([]);
    }
    sink.events.length = 0;
  });

  it("records admin_anomaly when an authenticated non-admin hits an admin route", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/v1/admin/users/${randomUUID()}`,
      headers: headers(),
    });
    expect(res.statusCode).toBe(403);
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]).toMatchObject({
      kind: "admin_anomaly",
      errorCode: "auth.admin_required",
      route: "/v1/admin/users/:id",
    });
  });

  it("records admin_anomaly when an admin claim is refused by the server-side allowlist", async () => {
    const minter = new DevTokenVerifier("test", DEV_SECRET);
    const forgedAdmin = await minter.mint(`auth0|sec-monitoring-${randomUUID()}`, "admin");
    const bootstrap = await app.inject({
      method: "POST",
      url: "/v1/account/bootstrap",
      headers: { authorization: `Bearer ${forgedAdmin}` },
      payload: {
        locale: "en-US",
        timezone: "America/Los_Angeles",
        device: { platform: "ios", osVersion: "18.0", appVersion: "0.1.0", model: "iPhone16,1" },
      },
    });
    expect(bootstrap.statusCode, bootstrap.body).toBe(200);
    sink.events.length = 0;
    const res = await app.inject({
      method: "GET",
      url: `/v1/admin/users/${randomUUID()}`,
      headers: { authorization: `Bearer ${forgedAdmin}` },
    });
    expect(res.statusCode).toBe(403);
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]).toMatchObject({
      kind: "admin_anomaly",
      errorCode: "auth.admin_not_authorized",
    });
  });

  it("records media_access_failure for probing a media id the caller does not own", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/v1/media/${randomUUID()}`,
      headers: headers(),
    });
    expect(res.statusCode).toBe(404);
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]).toMatchObject({
      kind: "media_access_failure",
      route: "/v1/media/:id",
      errorCode: "media.not_found",
    });
  });

  it("records upload_abuse for a malformed upload request", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/media/uploads",
      headers: headers(),
      payload: { nonsense: true },
    });
    expect(res.statusCode).toBe(400);
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]).toMatchObject({ kind: "upload_abuse", route: "/v1/media/uploads" });
  });

  it("records consent_mutation_denied for a rejected consent mutation", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/me/consent/grant",
      headers: headers(),
      payload: { scope: "everything", consentVersion: "x" },
    });
    expect(res.statusCode).toBe(400);
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]).toMatchObject({
      kind: "consent_mutation_denied",
      route: "/v1/me/consent/grant",
    });
  });

  it("records training_eligibility_change for a successful model_training grant and withdrawal", async () => {
    const grant = await app.inject({
      method: "POST",
      url: "/v1/me/consent/grant",
      headers: headers(),
      payload: {
        scope: "model_training",
        consentVersion: "model-training-v1",
        source: "mobile_settings",
        device: "iPhone16,1",
        captureMode: "automatic_pose_trigger",
        strokeIntent: "forehand_drive",
      },
    });
    expect(grant.statusCode, grant.body).toBe(200);
    const withdraw = await app.inject({
      method: "POST",
      url: "/v1/me/consent/withdraw",
      headers: headers(),
      payload: {
        scope: "model_training",
        consentVersion: "model-training-v1",
        source: "mobile_settings",
      },
    });
    expect(withdraw.statusCode, withdraw.body).toBe(200);
    const changes = sink.events.filter((e) => e.kind === "training_eligibility_change");
    expect(changes).toHaveLength(2);
    for (const change of changes) {
      expect(change).toMatchObject({ surface: "consent_ledger", statusCode: 200 });
    }
    // Consent decisions are pseudonymous; the event carries no subject at all.
    for (const change of changes) {
      const serialized = JSON.stringify(change);
      expect(serialized).not.toContain(userToken);
    }
  });

  it("records nothing for an ordinary successful read", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/me", headers: headers() });
    expect(res.statusCode).toBe(200);
    expect(sink.events).toHaveLength(0);
  });
});
