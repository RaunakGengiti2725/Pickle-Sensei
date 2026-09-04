import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { DevTokenVerifier } from "../../src/auth/tokens.js";
import type { ApiConfig } from "../../src/config.js";
import { DEFAULT_RATE_LIMIT, WindowStore } from "../../src/plugins/rateLimitPlugin.js";

/**
 * ADJ-01 — the request budget must not be chosen by an unauthenticated caller.
 *
 * Before the fix the limiter keyed every request carrying `Authorization:
 * Bearer …` by a hash of the raw (unverified) token, so an attacker rotating
 * garbage tokens minted a fresh budget per request, and the bounded store
 * answered capacity by clearing EVERY window — resetting every exhausted
 * caller. These suites run without a database: an invalid bearer is refused by
 * `verifyToken` before any handler, and a valid dev token proves the verified
 * path (the handler answers 503 db.unavailable, which is not a budget verdict).
 */

const secret = "adjudicate-rate-limit-secret-0123456789";

const config: ApiConfig = {
  env: "test",
  port: 0,
  host: "127.0.0.1",
  appVersion: "0.1.0-test",
  databaseUrl: null,
  devAuthSecret: secret,
  oidcIssuer: undefined,
  oidcAudience: undefined,
  oidcJwksUrl: undefined,
  sqsQueueUrl: undefined,
  consentExportSigningKey: undefined,
  consentExportSigningKeyId: "consent-export-k1",
  appleIapConfigured: false,
  googlePlayConfigured: false,
};

const BOOTSTRAP = { method: "POST" as const, url: "/v1/account/bootstrap" };
const ATTACKER_IP = "203.0.113.7";
const STORE_CAPACITY = 50_000;

function tally(statuses: number[]): Record<number, number> {
  const counts: Record<number, number> = {};
  for (const status of statuses) counts[status] = (counts[status] ?? 0) + 1;
  return counts;
}

/** Distinct routable-looking addresses, never colliding with ATTACKER_IP. */
function distinctIp(index: number): string {
  return `10.${(index >> 16) & 0xff}.${(index >> 8) & 0xff}.${index & 0xff}`;
}

async function inject(
  app: FastifyInstance,
  bearer: string,
  remoteAddress: string,
): Promise<number> {
  const res = await app.inject({
    ...BOOTSTRAP,
    remoteAddress,
    headers: { authorization: `Bearer ${bearer}` },
  });
  return res.statusCode;
}

describe("ADJ-01: pre-auth budgets are owned by the client address, not by the bearer", () => {
  const apps: FastifyInstance[] = [];
  const build = () => {
    const app = buildApp(config);
    apps.push(app);
    return app;
  };
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it("300 distinct invalid bearers from one IP exhaust that IP's expensive budget", async () => {
    const app = build();
    const statuses: number[] = [];
    for (let i = 0; i < 300; i += 1) {
      statuses.push(await inject(app, `rotating-garbage-${i}`, ATTACKER_IP));
    }
    const counts = tally(statuses);
    expect(counts[429] ?? 0, JSON.stringify(counts)).toBeGreaterThanOrEqual(1);
    expect(counts[401] ?? 0, JSON.stringify(counts)).toBe(DEFAULT_RATE_LIMIT.expensiveLimit);
    expect(counts[429]).toBe(300 - DEFAULT_RATE_LIMIT.expensiveLimit);
    // Every refusal after the budget is a budget verdict, never a 5xx.
    expect(Object.keys(counts).map(Number).sort()).toEqual([401, 429]);
  });

  it("a caller that hit 429 stays limited after 50 000 other distinct pre-auth keys in the window", async () => {
    const app = build();
    // One fixed (invalid) bearer so this case isolates eviction from the
    // rotating-bearer defect: the caller is limited under either keying.
    const fixedBearer = "exhaust-fixed";
    let last = 0;
    for (let i = 0; i <= DEFAULT_RATE_LIMIT.expensiveLimit; i += 1) {
      last = await inject(app, fixedBearer, ATTACKER_IP);
    }
    expect(last).toBe(429);

    // Capacity is measured in stored windows; each stranger below is distinct
    // by address AND by bearer, so it creates one window under either keying.
    // The limiter must evict something else, never everyone.
    const strangers: number[] = [];
    for (let i = 0; i < STORE_CAPACITY; i += 1) {
      strangers.push(await inject(app, `stranger-${i}`, distinctIp(i)));
    }
    const flood = tally(strangers);
    expect(flood, JSON.stringify(flood)).toEqual({ 401: STORE_CAPACITY });

    const after = await app.inject({
      ...BOOTSTRAP,
      remoteAddress: ATTACKER_IP,
      headers: { authorization: `Bearer ${fixedBearer}` },
    });
    expect(after.statusCode, after.body).toBe(429);
    expect((after.json() as { error: { code: string } }).error.code).toBe("api.rate_limited");
    expect(after.headers["retry-after"]).toBeTruthy();
  }, 180_000);

  it("a verified token is budgeted by identity; strangers on the same IP keep their own budget", async () => {
    const app = build();
    const minter = new DevTokenVerifier("test", secret);
    const tokenA = await minter.mint("adjudicate|caller-a");
    const tokenB = await minter.mint("adjudicate|caller-b");
    const sharedIp = "198.51.100.42";

    const statuses: number[] = [];
    for (let i = 0; i < DEFAULT_RATE_LIMIT.expensiveLimit + 5; i += 1) {
      statuses.push(await inject(app, tokenA, sharedIp));
    }
    const counts = tally(statuses);
    // Verified but no database: the handler answers 503, never 401.
    expect(counts[503], JSON.stringify(counts)).toBe(DEFAULT_RATE_LIMIT.expensiveLimit);
    expect(counts[429], JSON.stringify(counts)).toBe(5);

    // A second verified caller behind the same NAT is unaffected …
    expect(await inject(app, tokenB, sharedIp)).toBe(503);
    // … and A's verified traffic did not consume the address's pre-auth budget.
    expect(await inject(app, "not-a-token", sharedIp)).toBe(401);
    // The budget follows the verified subject, not the address it came from.
    expect(await inject(app, tokenA, "198.51.100.43")).toBe(429);
  });
});

describe("ADJ-01: WindowStore capacity eviction never clears every window", () => {
  const windowMs = 60_000;

  it("drops expired windows first and keeps a refused caller's window", () => {
    const store = new WindowStore(100);
    const t0 = 1_000_000;
    for (let i = 0; i <= 3; i += 1) store.hit("victim", windowMs, t0, 3);
    expect(store.hit("victim", windowMs, t0, 3).count).toBe(5);
    for (let i = 0; i < 99; i += 1) store.hit(`stranger-${i}`, windowMs, t0, 3);
    expect(store.size).toBe(100);

    // Capacity reached: the next fresh key must evict, but never the victim.
    for (let i = 0; i < 5_000; i += 1) store.hit(`flood-${i}`, windowMs, t0 + 1, 3);
    expect(store.size).toBeLessThanOrEqual(100);
    expect(store.hit("victim", windowMs, t0 + 2, 3).count).toBe(6);
  });

  it("evicts only expired windows when enough of them exist", () => {
    const store = new WindowStore(10);
    const t0 = 5_000_000;
    for (let i = 0; i < 9; i += 1) store.hit(`old-${i}`, windowMs, t0, 3);
    store.hit("fresh", windowMs, t0 + windowMs - 1, 3);
    expect(store.size).toBe(10);
    store.hit("newcomer", windowMs, t0 + windowMs, 3);
    // The nine expired windows went; the live one and the newcomer remain.
    expect(store.size).toBe(2);
    expect(store.hit("fresh", windowMs, t0 + windowMs, 3).count).toBe(2);
  });

  it("when every window has refused, frees a bounded slice rather than all", () => {
    const store = new WindowStore(10);
    const t0 = 9_000_000;
    for (let i = 0; i < 10; i += 1) {
      for (let n = 0; n <= 1; n += 1) store.hit(`refused-${i}`, windowMs, t0, 1);
    }
    expect(store.size).toBe(10);
    store.hit("newcomer", windowMs, t0 + 1, 1);
    // 90% target → one slot freed for the newcomer, nine refusals still stand.
    expect(store.size).toBe(10);
    let stillRefused = 0;
    for (let i = 0; i < 10; i += 1) {
      if (store.hit(`refused-${i}`, windowMs, t0 + 2, 1).count > 1) stillRefused += 1;
    }
    expect(stillRefused).toBe(9);
  });
});
