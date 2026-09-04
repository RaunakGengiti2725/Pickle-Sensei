import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import type { ApiConfig } from "../../src/config.js";

/**
 * Structural audit (services-api-legacy-admin-web, pass 1): per-caller rate
 * limiting on expensive routes. No datastore is needed — the throttle runs in
 * `onRequest`, before auth, so an unauthenticated caller must be bounded by
 * client address regardless of what it puts in `Authorization`.
 */

const config: ApiConfig = {
  env: "test",
  port: 0,
  host: "127.0.0.1",
  appVersion: "0.1.0-audit",
  databaseUrl: null,
  devAuthSecret: "audit-secret-0123456789abcdef",
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

const EXPENSIVE_LIMIT = 60;
const bootstrapBody = {
  locale: "en-US",
  timezone: "UTC",
  device: { platform: "ios", osVersion: "18.0", appVersion: "0.1.0", model: "audit" },
};

describe("rate limit — caller keying on expensive routes (audit)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = buildApp(config, { objectStore: null });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
  });

  async function bootstrap(bearer: string, ip = "203.0.113.7") {
    return app.inject({
      method: "POST",
      url: "/v1/account/bootstrap",
      remoteAddress: ip,
      headers: { authorization: `Bearer ${bearer}` },
      payload: bootstrapBody,
    });
  }

  it("a single unauthenticated address is throttled on an expensive route (control)", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < EXPENSIVE_LIMIT + 5; i++) {
      const res = await bootstrap("same-garbage-token", "203.0.113.10");
      statuses.push(res.statusCode);
    }
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
  });

  it("rotating garbage bearers from ONE address does not grant a fresh budget per token", async () => {
    // Expected invariant: an unauthenticated caller (every token is rejected
    // with 401) is one caller and must exhaust ONE expensive-route budget.
    const statuses: number[] = [];
    for (let i = 0; i < EXPENSIVE_LIMIT * 3; i++) {
      const res = await bootstrap(`garbage-${randomUUID()}`, "203.0.113.20");
      statuses.push(res.statusCode);
    }
    const rejected = statuses.filter((s) => s === 401).length;
    const throttled = statuses.filter((s) => s === 429).length;
    expect(
      throttled,
      `expected a 429 within ${statuses.length} unauthenticated requests from one IP; ` +
        `got ${rejected}x401 and ${throttled}x429`,
    ).toBeGreaterThan(0);
  });

  it("a flood of distinct keys must not reset another caller's live counter (bounded store)", async () => {
    // Legit caller consumes its whole expensive budget …
    const legitToken = `legit-${randomUUID()}`;
    for (let i = 0; i < EXPENSIVE_LIMIT; i++) {
      const res = await bootstrap(legitToken, "203.0.113.30");
      expect(res.statusCode).toBe(401);
    }
    const before = await bootstrap(legitToken, "203.0.113.30");
    expect(before.statusCode, "budget exhausted before the flood").toBe(429);

    // … then an attacker floods the store with 50k distinct live keys
    // (WindowStore maxKeys = 50_000 → evict() → windows.clear()).
    for (let i = 0; i < 50_000; i++) {
      await bootstrap(`flood-${i}`, "198.51.100.1");
    }

    const after = await bootstrap(legitToken, "203.0.113.30");
    expect(
      after.statusCode,
      "legit caller's exhausted budget must survive a key flood within the same window",
    ).toBe(429);
  }, 180_000);
});
