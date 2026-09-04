import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import type { ApiConfig } from "../../src/config.js";
import { DEFAULT_RATE_LIMIT } from "../../src/plugins/rateLimitPlugin.js";

/**
 * ADJUDICATION reproduction (area: services-api-legacy-admin-web): the
 * per-process rate limiter keys UNAUTHENTICATED callers by the raw (never
 * verified) bearer string, and its bounded store resets every live counter
 * when it fills. No datastore is required — the throttle runs in `onRequest`.
 *
 * Each `it` asserts the correct behaviour; a failure is the reproduced defect.
 */

const config: ApiConfig = {
  env: "test",
  port: 0,
  host: "127.0.0.1",
  appVersion: "0.1.0-adjudicate",
  databaseUrl: null,
  devAuthSecret: "adjudicate-secret-0123456789abcdef",
  oidcIssuer: undefined,
  oidcAudience: undefined,
  oidcJwksUrl: undefined,
  sqsQueueUrl: undefined,
  consentExportSigningKey: undefined,
  consentExportSigningKeyId: "consent-export-k1",
  appleIapConfigured: false,
  googlePlayConfigured: false,
  adminAuthSubjects: [],
};

const LIMIT = DEFAULT_RATE_LIMIT.expensiveLimit;
const bootstrapBody = {
  locale: "en-US",
  timezone: "UTC",
  device: { platform: "ios", osVersion: "18.0", appVersion: "0.1.0", model: "adjudicate" },
};

describe("ADJUDICATE rate limiter (no datastore)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = buildApp(config, { objectStore: null });
    await app.ready();
  });
  afterAll(async () => {
    await app?.close();
  });

  function bootstrap(bearer: string, ip: string) {
    return app.inject({
      method: "POST",
      url: "/v1/account/bootstrap",
      remoteAddress: ip,
      headers: { authorization: `Bearer ${bearer}` },
      payload: bootstrapBody,
    });
  }

  it("control: one address with one (invalid) bearer is throttled after the expensive budget", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < LIMIT + 5; i++)
      statuses.push((await bootstrap("fixed-garbage", "203.0.113.10")).statusCode);
    console.log(
      `ADJ-RL-CONTROL: 401=${statuses.filter((s) => s === 401).length} 429=${statuses.filter((s) => s === 429).length}`,
    );
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
  });

  it("ADJ-RL-ROTATE: rotating invalid bearers from ONE address does not mint a fresh budget per token", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < LIMIT * 5; i++) {
      statuses.push((await bootstrap(`garbage-${randomUUID()}`, "203.0.113.20")).statusCode);
    }
    const throttled = statuses.filter((s) => s === 429).length;
    console.log(
      `ADJ-RL-ROTATE: ${statuses.length} unauthenticated requests from one IP → 401=${statuses.filter((s) => s === 401).length} 429=${throttled}`,
    );
    expect(
      throttled,
      "an unauthenticated caller must exhaust ONE budget per address",
    ).toBeGreaterThan(0);
  });

  it("ADJ-RL-CLEAR: a flood of distinct live keys must not reset another caller's exhausted counter", async () => {
    const legit = `legit-${randomUUID()}`;
    for (let i = 0; i < LIMIT; i++)
      expect((await bootstrap(legit, "203.0.113.30")).statusCode).toBe(401);
    expect(
      (await bootstrap(legit, "203.0.113.30")).statusCode,
      "budget exhausted before the flood",
    ).toBe(429);

    // WindowStore maxKeys = 50_000; every key is live (60s window) so evict() falls through to clear().
    for (let i = 0; i < 50_000; i++) await bootstrap(`flood-${i}`, "198.51.100.1");

    const after = await bootstrap(legit, "203.0.113.30");
    console.log(
      `ADJ-RL-CLEAR: exhausted caller after 50k-key flood → ${after.statusCode} (expected 429)`,
    );
    expect(
      after.statusCode,
      "exhausted budget must survive a key flood inside the same window",
    ).toBe(429);
  }, 300_000);
});
