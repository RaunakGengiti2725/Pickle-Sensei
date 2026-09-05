import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { DevTokenVerifier } from "../../src/auth/tokens.js";
import type { ApiConfig } from "../../src/config.js";
import { DEFAULT_RATE_LIMIT } from "../../src/plugins/rateLimitPlugin.js";

/**
 * ADJUDICATION reproduction (area: services-api-legacy-admin-web): the
 * per-process rate limiter keys UNAUTHENTICATED callers by the raw (never
 * verified) bearer string, and its bounded store resets every live counter
 * when it fills. No datastore is required — the throttle runs in `onRequest`.
 *
 * Each `it` asserts the correct behaviour; a failure is the reproduced defect.
 *
 * Status legend on `POST /v1/account/bootstrap` without a datastore:
 * 401 = bearer rejected before any budget could follow the credential,
 * 503 = bearer VERIFIED (the handler then reports the missing database),
 * 429 = throttled.
 */

const devAuthSecret = "adjudicate-secret-0123456789abcdef";
const config: ApiConfig = {
  env: "test",
  port: 0,
  host: "127.0.0.1",
  appVersion: "0.1.0-adjudicate",
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
const bootstrapBody = {
  locale: "en-US",
  timezone: "UTC",
  device: { platform: "ios", osVersion: "18.0", appVersion: "0.1.0", model: "adjudicate" },
};

/** 50 000 distinct client addresses (10.x.y.z), one per pre-auth key. */
function floodAddress(i: number): string {
  return `10.${(i >> 16) & 0xff}.${(i >> 8) & 0xff}.${i & 0xff}`;
}

describe("ADJUDICATE rate limiter (no datastore)", () => {
  let app: FastifyInstance;
  const minter = new DevTokenVerifier("test", devAuthSecret);
  const mintValid = () => minter.mint(`adjudicate|${randomUUID()}`);
  /**
   * Requests per client address that reached the preHandler phase, i.e. were
   * NOT refused in `onRequest`. An instance-level preHandler runs before any
   * route's own `verifyToken` / `authenticate`, so this counts exactly the
   * requests on which token verification (and, with a datastore, the
   * `app_user` lookup) would have been spent.
   */
  const reachedAuth = new Map<string, number>();

  beforeAll(async () => {
    app = buildApp(config, { objectStore: null });
    app.addHook("preHandler", async (request) => {
      reachedAuth.set(request.ip, (reachedAuth.get(request.ip) ?? 0) + 1);
    });
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

  it("ADJ-RL-EVICT: at capacity the store evicts other windows, never an exhausted caller's", async () => {
    const legit = `legit-${randomUUID()}`;
    for (let i = 0; i < LIMIT; i++)
      expect((await bootstrap(legit, "203.0.113.40")).statusCode).toBe(401);
    expect(
      (await bootstrap(legit, "203.0.113.40")).statusCode,
      "budget exhausted before the flood",
    ).toBe(429);

    // 50 000 DISTINCT addresses → 50 000 distinct live pre-auth keys, so the
    // bounded store must actually evict something. Whatever it drops, the
    // throttled caller's counter is not a candidate.
    for (let i = 0; i < 50_000; i++) await bootstrap(`flood-${i}`, floodAddress(i));

    const after = await bootstrap(legit, "203.0.113.40");
    console.log(
      `ADJ-RL-EVICT: exhausted caller after 50k-address flood → ${after.statusCode} (expected 429)`,
    );
    expect(after.statusCode, "eviction must not free an exhausted counter").toBe(429);
  }, 300_000);

  it("ADJ-RL-VERIFIED-SHARED-ADDRESS: verified credentials behind one address do not spend the address budget", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < LIMIT * 2; i++) {
      statuses.push((await bootstrap(await mintValid(), "203.0.113.50")).statusCode);
    }
    console.log(
      `ADJ-RL-VERIFIED-SHARED-ADDRESS: ${statuses.length} verified callers behind one IP → 503=${statuses.filter((s) => s === 503).length} 429=${statuses.filter((s) => s === 429).length}`,
    );
    expect(
      statuses.every((s) => s === 503),
      "every verified first request must be served",
    ).toBe(true);
    // The address still has its own pre-auth budget intact for garbage bearers.
    expect((await bootstrap("garbage", "203.0.113.50")).statusCode).toBe(401);
  });

  it("ADJ-RL-VERIFIED-BUDGET: a verified credential exhausts its own budget and nobody else's", async () => {
    const token = await mintValid();
    const statuses: number[] = [];
    for (let i = 0; i < LIMIT + 3; i++)
      statuses.push((await bootstrap(token, "203.0.113.60")).statusCode);
    expect(statuses.slice(0, LIMIT).every((s) => s === 503)).toBe(true);
    expect(statuses.slice(LIMIT)).toEqual([429, 429, 429]);

    // Same address, different verified credential: its own fresh budget.
    expect((await bootstrap(await mintValid(), "203.0.113.60")).statusCode).toBe(503);
    // Same address, unverified bearer: the address budget was never charged.
    expect((await bootstrap("garbage", "203.0.113.60")).statusCode).toBe(401);
    // The exhausted credential stays exhausted from any address.
    expect((await bootstrap(token, "203.0.113.61")).statusCode).toBe(429);
  });

  it("ADJ-RL-SPENT-CREDENTIAL-EARLY: a spent verified credential is refused before its route's auth runs", async () => {
    const token = await mintValid();
    const ip = "203.0.113.70";
    for (let i = 0; i < LIMIT; i++) expect((await bootstrap(token, ip)).statusCode).toBe(503);

    // Every served request had to be verified (the budget follows the
    // credential, which is only known after verification). From here on the
    // credential's window is spent, so its requests must be refused in
    // `onRequest` like any other over-budget caller: no token verification,
    // no datastore round trip.
    const before = reachedAuth.get(ip) ?? 0;
    expect(before).toBe(LIMIT);
    const statuses: number[] = [];
    for (let i = 0; i < 20; i++) statuses.push((await bootstrap(token, ip)).statusCode);
    const after = reachedAuth.get(ip) ?? 0;
    console.log(
      `ADJ-RL-SPENT-CREDENTIAL-EARLY: 20 requests on a spent credential → 429=${statuses.filter((s) => s === 429).length}, reached auth: ${after - before} (expected 0)`,
    );
    expect(statuses.every((s) => s === 429)).toBe(true);
    expect(after - before, "over-budget requests must not reach token verification").toBe(0);
    // The address budget was never touched by the verified credential, spent or not.
    expect((await bootstrap("garbage", ip)).statusCode).toBe(401);
  });

  it("ADJ-RL-ANON: requests without any bearer share the address budget with invalid bearers", async () => {
    const ip = "203.0.113.80";
    const anon = () =>
      app.inject({
        method: "POST",
        url: "/v1/account/bootstrap",
        remoteAddress: ip,
        payload: bootstrapBody,
      });
    const statuses: number[] = [];
    for (let i = 0; i < LIMIT / 2; i++) statuses.push((await anon()).statusCode);
    for (let i = 0; i < LIMIT / 2; i++)
      statuses.push((await bootstrap(`garbage-${randomUUID()}`, ip)).statusCode);
    expect(statuses.every((s) => s === 401)).toBe(true);
    expect((await anon()).statusCode, "anonymous request after the shared budget").toBe(429);
    expect((await bootstrap("garbage", ip)).statusCode).toBe(429);
    // Once an address has burnt its pre-auth budget, nothing from it is
    // verified until the window rolls over — not even a valid credential.
    // The budget is only known to belong to a credential AFTER verification,
    // and letting a spent address reach verification would make the pre-auth
    // limit purely cosmetic. (Same posture as the production edge function's
    // auth-failure budget in `supabase/functions/api/rateLimit.ts`.)
    const rescued = await bootstrap(await mintValid(), ip);
    expect(rescued.statusCode, "spent address is refused before verification").toBe(429);
    expect(reachedAuth.get(ip) ?? 0, "no request from the spent address reached auth").toBe(LIMIT);
  });
});
