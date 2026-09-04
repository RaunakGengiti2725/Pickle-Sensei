import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { DevTokenVerifier } from "../../src/auth/tokens.js";
import type { ApiConfig } from "../../src/config.js";
import { DEFAULT_RATE_LIMIT } from "../../src/plugins/rateLimitPlugin.js";

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
  });
});
