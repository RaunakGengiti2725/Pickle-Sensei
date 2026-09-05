import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { DevTokenVerifier } from "../../src/auth/tokens.js";
import type { ApiConfig } from "../../src/config.js";
import { DEFAULT_RATE_LIMIT } from "../../src/plugins/rateLimitPlugin.js";

/**
 * Same probe as ATK-RL-CONCURRENT but importing only symbols that exist on
 * f702f0f8, so it can be executed against the integrated head for comparison.
 */

const baseConfig: ApiConfig = {
  env: "test",
  port: 0,
  host: "127.0.0.1",
  appVersion: "0.1.0-attack",
  databaseUrl: null,
  devAuthSecret: "attack-secret-0123456789abcdef",
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
const minter = new DevTokenVerifier("test", baseConfig.devAuthSecret);

describe("BASELINE COMPARE: concurrent verified callers behind one address", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = buildApp(baseConfig, { objectStore: null });
    await app.ready();
  });
  afterAll(async () => {
    await app?.close();
  });

  it("CMP-RL-CONCURRENT: 2x expensiveLimit concurrent verified bootstraps from one address → no 429", async () => {
    const tokens = await Promise.all(
      Array.from({ length: LIMIT * 2 }, (_, i) => minter.mint(`attack|concurrent|${i}`)),
    );
    const responses = await Promise.all(
      tokens.map((t) =>
        app.inject({
          method: "POST",
          url: "/v1/account/bootstrap",
          remoteAddress: "203.0.113.60",
          headers: { authorization: `Bearer ${t}` },
          payload: {
            locale: "en-US",
            timezone: "UTC",
            device: { platform: "ios", osVersion: "18.0", appVersion: "0.1.0", model: "attack" },
          },
        }),
      ),
    );
    const statuses = responses.map((r) => r.statusCode);
    console.log(
      `CMP-RL-CONCURRENT: ${statuses.length} concurrent verified callers → 503=${statuses.filter((s) => s === 503).length} 429=${statuses.filter((s) => s === 429).length}`,
    );
    expect(statuses.filter((s) => s === 429)).toEqual([]);
  });

  it("CMP-RL-CONCURRENT-61: expensiveLimit+1 concurrent verified bootstraps from one address → no 429", async () => {
    const tokens = await Promise.all(
      Array.from({ length: LIMIT + 1 }, (_, i) => minter.mint(`attack|concurrent61|${i}`)),
    );
    const responses = await Promise.all(
      tokens.map((t) =>
        app.inject({
          method: "POST",
          url: "/v1/account/bootstrap",
          remoteAddress: "203.0.113.62",
          headers: { authorization: `Bearer ${t}` },
          payload: {
            locale: "en-US",
            timezone: "UTC",
            device: { platform: "ios", osVersion: "18.0", appVersion: "0.1.0", model: "attack" },
          },
        }),
      ),
    );
    const statuses = responses.map((r) => r.statusCode);
    console.log(
      `CMP-RL-CONCURRENT-61: ${statuses.length} concurrent verified callers → 503=${statuses.filter((s) => s === 503).length} 429=${statuses.filter((s) => s === 429).length}`,
    );
    expect(statuses.filter((s) => s === 429)).toEqual([]);
  });
});
