import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InMemoryJobQueue } from "@pickle/queue";
import { buildApp } from "../src/app.js";
import { DevTokenVerifier } from "../src/auth/tokens.js";
import type { ApiConfig } from "../src/config.js";

/**
 * h27 red team: network failure injection.
 *
 * A datastore outage must surface as a retryable 503 so the app keeps queued
 * work instead of discarding it as permanently rejected.
 */
const secret = "h27-outage-secret-0123456789";

describe("h27 datastore outage", () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    const config: ApiConfig = {
      env: "test",
      port: 0,
      host: "127.0.0.1",
      appVersion: "0.1.0-test",
      // Nothing listens on this port: connection refused, as in an outage.
      databaseUrl: "postgres://pickle:pickle@127.0.0.1:5999/pickle_test",
      devAuthSecret: secret,
      oidcIssuer: undefined,
      oidcAudience: undefined,
      oidcJwksUrl: undefined,
      sqsQueueUrl: undefined,
      consentExportSigningKey: undefined,
      consentExportSigningKeyId: "k1",
      appleIapConfigured: false,
      googlePlayConfigured: false,
    };
    app = buildApp(config, { queue: new InMemoryJobQueue() });
    token = await new DevTokenVerifier("test", secret).mint(`h27-outage|${randomUUID()}`);
  });

  afterAll(async () => {
    await app?.close();
  });

  it("health stays honest without the database", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/health" });
    expect(res.statusCode).toBe(200);
  });

  it("authenticated reads report a retryable outage, not a permanent failure", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/progress",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(503);
    const body = res.json() as {
      error: { kind: string; code: string; retryable: boolean };
    };
    expect(body.error.code).toBe("api.datastore_unavailable");
    expect(body.error.kind).toBe("retryable");
    expect(body.error.retryable).toBe(true);
  });

  it("sync writes report a retryable outage so the outbox is preserved", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/account/bootstrap",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        locale: "en-US",
        timezone: "UTC",
        device: { platform: "ios", osVersion: "18.0", appVersion: "0.1.0", model: "iPhone16,1" },
      },
    });
    expect(res.statusCode).toBe(503);
    expect((res.json() as { error: { retryable: boolean } }).error.retryable).toBe(true);
  });
});
