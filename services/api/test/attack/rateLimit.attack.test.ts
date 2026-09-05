import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { DevTokenVerifier } from "../../src/auth/tokens.js";
import type { ApiConfig } from "../../src/config.js";
import { DEFAULT_RATE_LIMIT } from "../../src/plugins/rateLimitPlugin.js";

/**
 * ADVERSARIAL suite for the ADJ-01 rate-limiter fix (candidate 90774571).
 * Each `it` asserts the behaviour the fix claims; a failure is a real defect in
 * the changed code (`services/api/src/plugins/rateLimitPlugin.ts`).
 *
 * Known failing on 90774571 (passes on f702f0f8): ATK-RL-ROLLOVER-REFUND —
 * `settleVerifiedCredential` refunds `charge.key` against whatever window is
 * live for that key at settle time; the `Charge` does not remember which
 * window it was charged in, so a verified request that straddles the window
 * boundary credits the NEXT window's address budget.
 *
 * Status legend on `POST /v1/account/bootstrap` without a datastore:
 * 401 = bearer rejected, 503 = bearer VERIFIED (handler reports no database),
 * 429 = throttled.
 */

const devAuthSecret = "attack-secret-0123456789abcdef";
const config: ApiConfig = {
  env: "test",
  port: 0,
  host: "127.0.0.1",
  appVersion: "0.1.0-attack",
  databaseUrl: null,
  devAuthSecret,
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
const WINDOW_MS = DEFAULT_RATE_LIMIT.windowMs;
const bootstrapBody = {
  locale: "en-US",
  timezone: "UTC",
  device: { platform: "ios", osVersion: "18.0", appVersion: "0.1.0", model: "attack" },
};

function floodAddress(i: number): string {
  return `10.${(i >> 16) & 0xff}.${(i >> 8) & 0xff}.${i & 0xff}`;
}

const count = (statuses: number[], code: number) => statuses.filter((s) => s === code).length;

describe("ATTACK rate limiter (no datastore)", () => {
  let app: FastifyInstance;
  const minter = new DevTokenVerifier("test", devAuthSecret);
  const mintValid = () => minter.mint(`attack|${randomUUID()}`);

  /**
   * Instance-level preHandler: runs AFTER `onRequest` (where the address is
   * charged) and BEFORE the route's own `verifyToken` + the fix's settlement
   * preHandler. Requests carrying `x-hold: 1` park here until `release()` —
   * that is a request whose verification is still in flight.
   */
  let hold: Promise<void> | null = null;
  let release: () => void = () => {};
  let parked = 0;

  beforeAll(async () => {
    app = buildApp(config, { objectStore: null });
    app.addHook("preHandler", async (request) => {
      if (request.headers["x-hold"] === "1" && hold) {
        parked += 1;
        await hold;
      }
    });
    await app.ready();
  });
  afterAll(async () => {
    await app?.close();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function bootstrap(bearer: string | null, ip: string, extra: Record<string, string> = {}) {
    return app.inject({
      method: "POST",
      url: "/v1/account/bootstrap",
      remoteAddress: ip,
      headers: bearer === null ? extra : { authorization: `Bearer ${bearer}`, ...extra },
      payload: bootstrapBody,
    });
  }

  async function settle(untilParked: number) {
    for (let i = 0; i < 1_000 && parked < untilParked; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(parked).toBe(untilParked);
  }

  it("ATK-RL-ROTATE-2X: 600 rotating invalid bearers from one address are throttled after the address budget", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < LIMIT * 10; i++)
      statuses.push((await bootstrap(`garbage-${randomUUID()}`, "203.0.113.120")).statusCode);
    console.log(`ATK-RL-ROTATE-2X: 401=${count(statuses, 401)} 429=${count(statuses, 429)}`);
    expect(count(statuses, 401)).toBe(LIMIT);
    expect(count(statuses, 429)).toBe(LIMIT * 9);
  });

  it("ATK-RL-CONCURRENT-ROTATE: 600 concurrent rotating invalid bearers from one address are throttled", async () => {
    const results = await Promise.all(
      Array.from({ length: LIMIT * 10 }, (_, i) =>
        bootstrap(`garbage-${i}-${randomUUID()}`, "203.0.113.121"),
      ),
    );
    const statuses = results.map((r) => r.statusCode);
    console.log(
      `ATK-RL-CONCURRENT-ROTATE: 401=${count(statuses, 401)} 429=${count(statuses, 429)}`,
    );
    expect(count(statuses, 401)).toBe(LIMIT);
    expect(count(statuses, 429)).toBe(LIMIT * 9);
  });

  it("ATK-RL-CONCURRENT-VERIFIED: one credential fired concurrently from two addresses is served exactly LIMIT times", async () => {
    const token = await mintValid();
    const results = await Promise.all(
      Array.from({ length: LIMIT * 2 }, (_, i) =>
        bootstrap(token, i % 2 === 0 ? "203.0.113.122" : "203.0.113.123"),
      ),
    );
    const statuses = results.map((r) => r.statusCode);
    console.log(
      `ATK-RL-CONCURRENT-VERIFIED: 503=${count(statuses, 503)} 429=${count(statuses, 429)}`,
    );
    expect(count(statuses, 503)).toBe(LIMIT);
    expect(count(statuses, 429)).toBe(LIMIT);
    // Neither address paid for the verified traffic.
    expect((await bootstrap("garbage", "203.0.113.122")).statusCode).toBe(401);
    expect((await bootstrap("garbage", "203.0.113.123")).statusCode).toBe(401);
  });

  it("ATK-RL-CLEAR-2X: a 100k flood of distinct live keys (same address + distinct addresses, interleaved) never resets an exhausted caller", async () => {
    const legit = `legit-${randomUUID()}`;
    for (let i = 0; i < LIMIT; i++)
      expect((await bootstrap(legit, "203.0.113.130")).statusCode).toBe(401);
    expect((await bootstrap(legit, "203.0.113.130")).statusCode).toBe(429);
    const spentToken = await mintValid();
    for (let i = 0; i < LIMIT; i++)
      expect((await bootstrap(spentToken, "203.0.113.131")).statusCode).toBe(503);
    expect((await bootstrap(spentToken, "203.0.113.131")).statusCode).toBe(429);

    for (let i = 0; i < 100_000; i++) {
      await bootstrap(`flood-${i}`, i % 2 === 0 ? "198.51.100.2" : floodAddress(i));
    }

    expect((await bootstrap(legit, "203.0.113.130")).statusCode).toBe(429);
    expect((await bootstrap(spentToken, "203.0.113.131")).statusCode).toBe(429);
    expect((await bootstrap(spentToken, "203.0.113.199")).statusCode).toBe(429);
  }, 600_000);

  it("ATK-RL-VERIFIED-FLOOD: 50k distinct VERIFIED credentials never reset an exhausted caller", async () => {
    const legit = `legit-${randomUUID()}`;
    for (let i = 0; i < LIMIT; i++)
      expect((await bootstrap(legit, "203.0.113.140")).statusCode).toBe(401);
    expect((await bootstrap(legit, "203.0.113.140")).statusCode).toBe(429);

    for (let i = 0; i < 50_000; i++) {
      const res = await bootstrap(await mintValid(), floodAddress(i));
      if (res.statusCode !== 503)
        throw new Error(`verified flood request ${i} → ${res.statusCode}`);
    }
    expect((await bootstrap(legit, "203.0.113.140")).statusCode).toBe(429);
  }, 600_000);

  it("ATK-RL-SCOPE-ISOLATION: a credential spent on one expensive route keeps its budget on other routes; a spent route budget never leaks to another address", async () => {
    const token = await mintValid();
    const ip = "203.0.113.150";
    for (let i = 0; i < LIMIT; i++) expect((await bootstrap(token, ip)).statusCode).toBe(503);
    expect((await bootstrap(token, ip)).statusCode).toBe(429);
    // Different expensive route, same credential: its own budget (verified → 503 without a DB).
    const other = await app.inject({
      method: "POST",
      url: "/v1/billing/sync",
      remoteAddress: ip,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    expect(other.statusCode).not.toBe(429);
    // Default-scope route, same credential: not throttled either.
    const me = await app.inject({
      method: "GET",
      url: "/v1/me",
      remoteAddress: ip,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.statusCode).not.toBe(429);
  });

  it("ATK-RL-RETRY-AFTER: every 429 (address, credential-at-settle, spent-credential-early) carries Retry-After ≤ window", async () => {
    const ip = "203.0.113.160";
    for (let i = 0; i < LIMIT; i++) await bootstrap("garbage", ip);
    const address = await bootstrap("garbage", ip);
    expect(address.statusCode).toBe(429);
    const ra = Number(address.headers["retry-after"]);
    expect(ra).toBeGreaterThanOrEqual(1);
    expect(ra).toBeLessThanOrEqual(WINDOW_MS / 1000);

    const token = await mintValid();
    for (let i = 0; i < LIMIT; i++) await bootstrap(token, "203.0.113.161");
    const early = await bootstrap(token, "203.0.113.161");
    expect(early.statusCode).toBe(429);
    expect(Number(early.headers["retry-after"])).toBeGreaterThanOrEqual(1);
  });

  it("ATK-RL-ROLLOVER-REFUND: a verified request whose verification straddles the window boundary must not refund the NEXT window", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.parse("2026-09-05T12:00:00.000Z");
    vi.setSystemTime(t0);
    const ip = "203.0.113.170";
    const held = 10;

    // Phase 1: `held` verified requests are charged to the address in window W1
    // and then park before verification completes.
    parked = 0;
    hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inFlight = Array.from({ length: held }, async () =>
      bootstrap(await mintValid(), ip, { "x-hold": "1" }),
    );
    await settle(held);

    // Window W1 expires; W2 begins. An unverified caller spends the ENTIRE W2
    // address budget.
    vi.setSystemTime(t0 + WINDOW_MS + 1_000);
    const garbage: number[] = [];
    for (let i = 0; i < LIMIT; i++) garbage.push((await bootstrap("garbage", ip)).statusCode);
    expect(garbage.every((s) => s === 401)).toBe(true);
    expect((await bootstrap("garbage", ip)).statusCode, "W2 budget spent").toBe(429);

    // The W1 requests finish verifying in W2. Their charges belonged to W1
    // (already rolled over — "a rolled-over window owes nothing"), so W2 must
    // stay spent.
    release();
    const finished = (await Promise.all(inFlight)).map((r) => r.statusCode);
    hold = null;
    expect(
      finished.every((s) => s === 503),
      `held verified requests → ${finished}`,
    ).toBe(true);

    const after: number[] = [];
    for (let i = 0; i < held + 1; i++) after.push((await bootstrap("garbage", ip)).statusCode);
    console.log(
      `ATK-RL-ROLLOVER-REFUND: after ${held} straddling verified requests settled, ${held + 1} garbage requests in the spent window → 401=${count(after, 401)} 429=${count(after, 429)} (expected 429=${held + 1})`,
    );
    expect(after, "spent W2 address budget must survive W1 settlements").toEqual(
      Array.from({ length: held + 1 }, () => 429),
    );
  });

  it("ATK-RL-STALE-CREDENTIAL: an expired (previously valid) credential is charged to the address like garbage, never to a credential budget", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.parse("2026-09-05T13:00:00.000Z");
    vi.setSystemTime(t0);
    const ip = "203.0.113.180";
    const token = await mintValid(); // 15 min lifetime
    expect((await bootstrap(token, ip)).statusCode).toBe(503);
    vi.setSystemTime(t0 + 16 * 60_000);
    const statuses: number[] = [];
    for (let i = 0; i < LIMIT + 5; i++) statuses.push((await bootstrap(token, ip)).statusCode);
    console.log(`ATK-RL-STALE-CREDENTIAL: 401=${count(statuses, 401)} 429=${count(statuses, 429)}`);
    expect(count(statuses, 401)).toBe(LIMIT);
    expect(count(statuses, 429)).toBe(5);
  });

  it("ATK-RL-REAL-SOCKETS: two real TCP clients sharing one address split one address budget (spent credential refused pre-auth over the wire)", async () => {
    const limit = 6;
    const server = buildApp(config, { objectStore: null, rateLimit: { expensiveLimit: limit } });
    try {
      const url = await server.listen({ port: 0, host: "127.0.0.1" });
      const token = await mintValid();
      const fire = (bearer: string) =>
        fetch(`${url}/v1/account/bootstrap`, {
          method: "POST",
          headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
          body: JSON.stringify(bootstrapBody),
        }).then((r) => r.status);
      // Session B (valid credential) spends its own budget; the shared address is refunded each time.
      const verified: number[] = [];
      for (let i = 0; i < limit + 1; i++) verified.push(await fire(token));
      // Session A (garbage) then still has the full address budget.
      const garbage: number[] = [];
      for (let i = 0; i < limit + 1; i++) garbage.push(await fire(`garbage-${i}`));
      console.log(`ATK-RL-REAL-SOCKETS: verified=${verified} garbage=${garbage}`);
      expect(verified).toEqual([...Array.from({ length: limit }, () => 503), 429]);
      expect(garbage).toEqual([...Array.from({ length: limit }, () => 401), 429]);
      // Credential is spent: refused pre-auth from a fresh address too.
      const r = await server.inject({
        method: "POST",
        url: "/v1/account/bootstrap",
        remoteAddress: "203.0.113.200",
        headers: { authorization: `Bearer ${token}` },
        payload: bootstrapBody,
      });
      expect(r.statusCode).toBe(429);
    } finally {
      await server.close();
    }
  });

  it("ATK-RL-MALFORMED-AUTH: malformed authorization headers are address-budgeted and never crash the limiter", async () => {
    const ip = "203.0.113.190";
    const variants = [
      "Bearer",
      "Bearer ",
      "bearer lowercase",
      "Basic dXNlcjpwYXNz",
      `Bearer ${"x".repeat(8_000)}`,
      "Bearer \u00e9\u00e8\u00ea",
      "Bearer a|b|c",
      "Bearer ip:203.0.113.190|*",
    ];
    const statuses: number[] = [];
    for (let i = 0; i < LIMIT; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/v1/account/bootstrap",
        remoteAddress: ip,
        headers: { authorization: variants[i % variants.length]! },
        payload: bootstrapBody,
      });
      statuses.push(res.statusCode);
    }
    expect(
      statuses.every((s) => s === 401),
      `statuses ${statuses}`,
    ).toBe(true);
    expect((await bootstrap(null, ip)).statusCode).toBe(429);
  });
});
