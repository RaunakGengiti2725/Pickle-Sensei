import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { ApiConfig } from "../src/config.js";

const config: ApiConfig = {
  env: "test",
  port: 0,
  host: "127.0.0.1",
  appVersion: "0.1.0-test",
  databaseUrl: null,
  devAuthSecret: "test-secret-0123456789",
  oidcIssuer: undefined,
  oidcAudience: undefined,
  oidcJwksUrl: undefined,
  sqsQueueUrl: undefined,
  consentExportSigningKey: undefined,
  consentExportSigningKeyId: "consent-export-k1",
  appleIapConfigured: false,
  googlePlayConfigured: false,
};

const app = buildApp(config);
afterAll(async () => {
  await app.close();
});

describe("API skeleton (no database)", () => {
  it("GET /v1/health returns ok + version", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok", version: "0.1.0-test" });
  });

  it("GET /v1/openapi.json serves the generated contract", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/openapi.json" });
    expect(res.statusCode).toBe(200);
    const doc = res.json() as { openapi: string; info: { title: string } };
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info.title).toMatch(/Pickle Sensei/);
  });

  it("catalog fails loudly with a typed envelope when the DB is unavailable", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/catalog/shot-types" });
    expect(res.statusCode).toBe(503);
    const body = res.json() as { error: { kind: string; code: string; requestId: string } };
    expect(body.error.kind).toBe("retryable");
    expect(body.error.code).toBe("catalog.db_unavailable");
    expect(body.error.requestId).toBeTruthy();
  });

  it("private routes require a bearer token", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/me" });
    expect(res.statusCode).toBe(401);
    expect((res.json() as { error: { kind: string } }).error.kind).toBe("auth_failed");
  });

  it("billing store sync fails loudly without credentials — never fake validation", async () => {
    // (auth would fail first without DB; verify the guard exists via webhooks)
    const res = await app.inject({ method: "POST", url: "/v1/webhooks/apple", payload: {} });
    expect(res.statusCode).toBe(503);
    expect((res.json() as { error: { code: string } }).error.code).toBe(
      "billing.apple_unconfigured",
    );
  });

  it("echoes/propagates x-request-id", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/health",
      headers: { "x-request-id": "req-abc-123" },
    });
    expect(res.headers["x-request-id"]).toBe("req-abc-123");
  });

  it("mints a fresh request id instead of echoing a malformed client one", async () => {
    for (const bad of ["short", "x".repeat(65), "evil\r\nx-injected: 1", "a b c d e f g h"]) {
      const res = await app.inject({
        method: "GET",
        url: "/v1/health",
        headers: { "x-request-id": bad },
      });
      const echoed = res.headers["x-request-id"];
      expect(echoed).not.toBe(bad);
      expect(String(echoed)).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it("sends browser-hardening headers on every response", async () => {
    for (const url of ["/v1/health", "/v1/me", "/v1/does-not-exist"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.headers["content-security-policy"]).toBe(
        "default-src 'none'; frame-ancestors 'none'",
      );
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.headers["x-frame-options"]).toBe("DENY");
      expect(res.headers["referrer-policy"]).toBe("no-referrer");
      expect(res.headers["strict-transport-security"]).toBe("max-age=63072000; includeSubDomains");
      expect(res.headers["cache-control"]).toBe("no-store");
    }
  });
});
