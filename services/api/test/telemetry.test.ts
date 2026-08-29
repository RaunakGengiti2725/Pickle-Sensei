import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { AnalyticsEvent, IAnalyticsSink } from "@pickle/analytics";
import { findPrivacyViolations } from "@pickle/analytics";
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

const tracked: AnalyticsEvent[] = [];
const sink: IAnalyticsSink = {
  track: (event) => void tracked.push(event),
  flush: async () => {},
};
const app = buildApp(config, { analytics: sink });
afterAll(async () => {
  await app.close();
});
beforeEach(() => {
  tracked.length = 0;
});

describe("api_failure telemetry", () => {
  it("emits a typed event for auth failures (security-sensitive slice)", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/me" });
    expect(res.statusCode).toBe(401);
    const failures = tracked.filter((e) => e.name === "api_failure");
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      name: "api_failure",
      method: "GET",
      route: "/v1/me",
      statusCode: 401,
    });
  });

  it("emits a typed event for backend errors with the typed error code", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/catalog/shot-types" });
    expect(res.statusCode).toBe(503);
    const failures = tracked.filter((e) => e.name === "api_failure");
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      statusCode: 503,
      errorCode: "catalog.db_unavailable",
      route: "/v1/catalog/shot-types",
    });
  });

  it("emits nothing for successful requests", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/health" });
    expect(res.statusCode).toBe(200);
    expect(tracked.filter((e) => e.name === "api_failure")).toHaveLength(0);
  });

  it("never carries a concrete URL, query, or body — redaction guard clean", async () => {
    await app.inject({
      method: "GET",
      url: "/v1/me?email=player@example.com",
    });
    const failures = tracked.filter((e) => e.name === "api_failure");
    expect(failures).toHaveLength(1);
    const failure = failures[0]!;
    expect(JSON.stringify(failure)).not.toContain("player@example.com");
    expect(findPrivacyViolations(failure)).toEqual([]);
  });
});
