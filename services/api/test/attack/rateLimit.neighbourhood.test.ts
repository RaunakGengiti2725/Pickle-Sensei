import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../src/app.js";
import { DevTokenVerifier } from "../../src/auth/tokens.js";
import type { ApiConfig } from "../../src/config.js";
import { DEFAULT_RATE_LIMIT, WindowStore } from "../../src/plugins/rateLimitPlugin.js";

/**
 * Neighbourhood probes for the ADJ-01 fix (57ece572). These assert behaviour
 * the changed code must keep; all of them PASS on the candidate and are kept
 * as regression pins (they document what was attacked and found sound).
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
const bootstrapBody = {
  locale: "en-US",
  timezone: "UTC",
  device: { platform: "ios", osVersion: "18.0", appVersion: "0.1.0", model: "attack" },
};
const minter = new DevTokenVerifier("test", baseConfig.devAuthSecret);

function bootstrapRaw(app: FastifyInstance, authorization: string | undefined, ip: string) {
  return app.inject({
    method: "POST",
    url: "/v1/account/bootstrap",
    remoteAddress: ip,
    headers: authorization === undefined ? {} : { authorization },
    payload: bootstrapBody,
  });
}

describe("ATTACK ADJ-01 neighbourhood: malformed credentials are address-budgeted, never keyed", () => {
  let app: FastifyInstance;
  const hitSpy = vi.spyOn(WindowStore.prototype, "hit");
  beforeAll(async () => {
    app = buildApp(baseConfig, { objectStore: null });
    await app.ready();
  });
  afterAll(async () => {
    await app?.close();
    hitSpy.mockRestore();
  });

  it("ATK-RL-MALFORMED: empty bearer, lowercase scheme, Basic, unicode, NUL and 8 KiB bearers all collapse onto ONE address key and trip 429", async () => {
    hitSpy.mockClear();
    const ip = "203.0.113.90";
    const variants = [
      "Bearer ",
      "Bearer  ",
      "bearer abc",
      "Basic YWJjOmRlZg==",
      `Bearer ${"\u00e9\u4e2d\ud83c\udfd3".repeat(8)}`,
      "Bearer a\u0000b",
      `Bearer ${"x".repeat(8192)}`,
      "Bearer",
      "",
    ];
    const statuses: number[] = [];
    for (let i = 0; i < LIMIT + 5; i++) {
      const v = variants[i % variants.length]!;
      const res = await bootstrapRaw(app, v === "" ? undefined : `${v}${i}`, ip);
      statuses.push(res.statusCode);
      expect(res.statusCode, `variant ${JSON.stringify(v.slice(0, 16))} must not 5xx`).toBeLessThan(
        500,
      );
    }
    const keys = new Set(hitSpy.mock.calls.map((c) => c[0]));
    console.log(
      `ATK-RL-MALFORMED: ${statuses.length} malformed-credential requests → keys=${keys.size} 401=${statuses.filter((s) => s === 401).length} 429=${statuses.filter((s) => s === 429).length}`,
    );
    expect(keys.size).toBe(1);
    expect(statuses.slice(0, LIMIT).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(LIMIT).every((s) => s === 429)).toBe(true);
  });

  it("ATK-RL-NO-DOUBLE-CHARGE: a verified request charges the credential exactly once and leaves the address at zero", async () => {
    hitSpy.mockClear();
    const ip = "203.0.113.91";
    const token = await minter.mint("attack|single-charge");
    const res = await bootstrapRaw(app, `Bearer ${token}`, ip);
    expect(res.statusCode).toBe(503); // no datastore — past auth + rate limit
    const keys = hitSpy.mock.calls.map((c) => c[0]);
    const addressKey = keys.find((k) => k.startsWith(`ip:${ip}|`));
    const credKeys = keys.filter((k) => k.startsWith("t:"));
    expect(addressKey).toBeDefined();
    expect(credKeys).toHaveLength(1);
    const addressWindow = hitSpy.mock.results[keys.indexOf(addressKey!)]!.value as {
      count: number;
    };
    expect(addressWindow.count, "address charge refunded after verification").toBe(0);
  });

  it("ATK-RL-REFUND-NOT-NEGATIVE: refunds can never push an address window below zero to bank future requests", async () => {
    const ip = "203.0.113.92";
    const token = await minter.mint("attack|refund-bank");
    // Plenty of verified requests: if refunds under-flowed the address counter
    // an attacker could then send more than LIMIT garbage requests.
    for (let i = 0; i < LIMIT * 2; i++) await bootstrapRaw(app, `Bearer ${token}`, ip);
    const statuses: number[] = [];
    for (let i = 0; i < LIMIT + 1; i++)
      statuses.push((await bootstrapRaw(app, `Bearer junk-${i}`, ip)).statusCode);
    expect(statuses.slice(0, LIMIT).every((s) => s === 401)).toBe(true);
    expect(statuses[LIMIT]).toBe(429);
  });
});

describe("ATTACK ADJ-01 neighbourhood: disabled limiter", () => {
  it("ATK-RL-DISABLED: with enabled=false neither the address nor the credential budget ever replies 429", async () => {
    const app = buildApp(baseConfig, { objectStore: null, rateLimit: { enabled: false } });
    await app.ready();
    try {
      const token = await minter.mint("attack|disabled");
      const statuses: number[] = [];
      for (let i = 0; i < LIMIT * 2 + 2; i++) {
        statuses.push(
          (await bootstrapRaw(app, `Bearer ${i % 2 ? token : "junk"}`, "203.0.113.93")).statusCode,
        );
      }
      expect(statuses.filter((s) => s === 429)).toEqual([]);
      expect(new Set(statuses)).toEqual(new Set([401, 503]));
    } finally {
      await app.close();
    }
  });
});

describe("ATTACK ADJ-01 neighbourhood: WindowStore boundaries", () => {
  const WINDOW_MS = 60_000;

  it("ATK-RL-BOUNDARY: a window is live until resetAt exclusive; at resetAt it rolls over to count 1", () => {
    const store = new WindowStore(10);
    const t0 = 5_000;
    store.hit("k", WINDOW_MS, t0);
    expect(store.hit("k", WINDOW_MS, t0 + WINDOW_MS - 1).count).toBe(2);
    const rolled = store.hit("k", WINDOW_MS, t0 + WINDOW_MS);
    expect(rolled.count).toBe(1);
    expect(rolled.resetAt).toBe(t0 + WINDOW_MS + WINDOW_MS);
    expect(store.size).toBe(1);
  });

  it("ATK-RL-CLOCK-SKEW: a clock that jumps backwards keeps counting in the live window instead of minting a fresh one", () => {
    const store = new WindowStore(10);
    for (let i = 0; i < 5; i++) store.hit("k", WINDOW_MS, 100_000 + i);
    expect(store.hit("k", WINDOW_MS, 50_000).count).toBe(6);
  });

  it("ATK-RL-EVICT-EXPIRED-FIRST: at capacity, expired windows are dropped before any live one", () => {
    const store = new WindowStore(3);
    store.hit("old-expired", WINDOW_MS, 0);
    store.hit("live-a", WINDOW_MS, 10);
    store.hit("live-b", WINDOW_MS, 20);
    store.hit("fresh", WINDOW_MS, WINDOW_MS + 1);
    expect(store.peek("old-expired")).toBeUndefined();
    expect(store.peek("live-a")).toBeDefined();
    expect(store.peek("live-b")).toBeDefined();
    expect(store.peek("fresh")).toBeDefined();
    expect(store.size).toBe(3);
  });

  it("ATK-RL-EVICT-NEVER-ALL: filling the store with 2x maxKeys live keys never empties it", () => {
    const store = new WindowStore(100);
    for (let i = 0; i < 200; i++) store.hit(`k${i}`, WINDOW_MS, 1_000 + i);
    expect(store.size).toBe(100);
    expect(store.peek("k199")).toBeDefined();
  });

  it("ATK-RL-MAXKEYS-ONE: maxKeys=1 still admits and counts the newest key", () => {
    const store = new WindowStore(1);
    store.hit("a", WINDOW_MS, 1);
    store.hit("b", WINDOW_MS, 2);
    expect(store.size).toBe(1);
    expect(store.peek("b")?.count).toBe(1);
    expect(store.hit("b", WINDOW_MS, 3).count).toBe(2);
  });
});
