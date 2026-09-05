import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../src/app.js";
import { DevTokenVerifier } from "../../src/auth/tokens.js";
import type { ApiConfig } from "../../src/config.js";
import { DEFAULT_RATE_LIMIT, WindowStore } from "../../src/plugins/rateLimitPlugin.js";

/**
 * ADVERSARIAL probes against the ADJ-01 fix (57ece572): address-budgeted
 * pre-auth requests with a per-credential budget after verification, and FIFO
 * eviction in WindowStore. Each `it` asserts the behaviour the fix CLAIMS; a
 * failure is a reproduced defect in the changed code.
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

function bootstrap(app: FastifyInstance, bearer: string, ip: string) {
  return app.inject({
    method: "POST",
    url: "/v1/account/bootstrap",
    remoteAddress: ip,
    headers: { authorization: `Bearer ${bearer}` },
    payload: bootstrapBody,
  });
}

describe("ATTACK ADJ-01: verified callers behind one address (no datastore)", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = buildApp(baseConfig, { objectStore: null });
    await app.ready();
  });
  afterAll(async () => {
    await app?.close();
  });

  it("ATK-RL-CONCURRENT: 2x expensiveLimit verified callers launching CONCURRENTLY behind one address are all admitted", async () => {
    // The fix charges the ADDRESS in onRequest and refunds only after
    // verifyToken() completes. While verification is in flight the address
    // counter is inflated by every concurrent verified request, so a burst of
    // distinct, VALID credentials behind one NAT trips the address budget.
    // On f702f0f8 verified traffic was keyed by credential and never shared
    // an address budget.
    const tokens = await Promise.all(
      Array.from({ length: LIMIT * 2 }, (_, i) => minter.mint(`attack|concurrent|${i}`)),
    );
    const responses = await Promise.all(tokens.map((t) => bootstrap(app, t, "203.0.113.60")));
    const statuses = responses.map((r) => r.statusCode);
    console.log(
      `ATK-RL-CONCURRENT: ${statuses.length} concurrent verified callers → 503=${statuses.filter((s) => s === 503).length} 429=${statuses.filter((s) => s === 429).length}`,
    );
    expect(
      statuses.filter((s) => s === 429),
      "verified traffic is not address-budgeted (ADJ-RL-VERIFIED-SHARED-ADDRESS claim)",
    ).toEqual([]);
  });

  it("ATK-RL-CONCURRENT-TCP: the same burst over real TCP connections (expensiveLimit+1 callers) is admitted", async () => {
    const tcpApp = buildApp(baseConfig, { objectStore: null });
    const address = await tcpApp.listen({ port: 0, host: "127.0.0.1" });
    try {
      const tokens = await Promise.all(
        Array.from({ length: LIMIT + 1 }, (_, i) => minter.mint(`attack|tcp|${i}`)),
      );
      const responses = await Promise.all(
        tokens.map((t) =>
          fetch(`${address}/v1/account/bootstrap`, {
            method: "POST",
            headers: { authorization: `Bearer ${t}`, "content-type": "application/json" },
            body: JSON.stringify(bootstrapBody),
          }),
        ),
      );
      const statuses = responses.map((r) => r.status);
      console.log(
        `ATK-RL-CONCURRENT-TCP: ${statuses.length} concurrent verified callers over TCP → 503=${statuses.filter((s) => s === 503).length} 429=${statuses.filter((s) => s === 429).length}`,
      );
      expect(statuses.filter((s) => s === 429)).toEqual([]);
    } finally {
      await tcpApp.close();
    }
  });

  it("ATK-RL-CONCURRENT-OIDC-TCP: production-shaped OIDC verifier (remote JWKS, 300ms IdP latency), expensiveLimit+1 concurrent verified callers over TCP are admitted", async () => {
    // Production verifies bearers against a REMOTE JWKS: the first
    // verification (and every refetch) waits on the identity provider, so a
    // burst of valid callers is in flight together while each one still holds
    // its address charge.
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwk = { ...(await exportJWK(publicKey)), kid: "attack-k1", alg: "RS256", use: "sig" };
    const idp = createServer((_req, res) => {
      setTimeout(() => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ keys: [jwk] }));
      }, 300);
    });
    await new Promise<void>((resolve) => idp.listen(0, "127.0.0.1", resolve));
    const idpPort = (idp.address() as AddressInfo).port;
    const issuer = "https://idp.attack.invalid/";
    const audience = "pickle-attack";
    const oidcApp = buildApp(
      {
        ...baseConfig,
        env: "production",
        devAuthSecret: undefined,
        oidcIssuer: issuer,
        oidcAudience: audience,
        oidcJwksUrl: `http://127.0.0.1:${idpPort}/jwks.json`,
      },
      { objectStore: null },
    );
    const address = await oidcApp.listen({ port: 0, host: "127.0.0.1" });
    try {
      const tokens = await Promise.all(
        Array.from({ length: LIMIT + 1 }, (_, i) =>
          new SignJWT({})
            .setProtectedHeader({ alg: "RS256", kid: "attack-k1" })
            .setIssuer(issuer)
            .setAudience(audience)
            .setSubject(`attack|oidc|${i}`)
            .setIssuedAt()
            .setExpirationTime("15m")
            .sign(privateKey),
        ),
      );
      const responses = await Promise.all(
        tokens.map((t) =>
          fetch(`${address}/v1/account/bootstrap`, {
            method: "POST",
            headers: { authorization: `Bearer ${t}`, "content-type": "application/json" },
            body: JSON.stringify(bootstrapBody),
          }),
        ),
      );
      const statuses = responses.map((r) => r.status);
      console.log(
        `ATK-RL-CONCURRENT-OIDC-TCP: ${statuses.length} concurrent verified callers over TCP (remote JWKS) → 503=${statuses.filter((s) => s === 503).length} 429=${statuses.filter((s) => s === 429).length}`,
      );
      expect(statuses.filter((s) => s === 429)).toEqual([]);
    } finally {
      await oidcApp.close();
      await new Promise<void>((resolve) => idp.close(() => resolve()));
    }
  }, 30_000);

  it("ATK-RL-STALE-NEIGHBOUR: a verified caller is admitted even when a stale-token neighbour exhausted the address", async () => {
    // Expected by the fix's design (pre-auth is address-budgeted): documents
    // the behaviour change vs f702f0f8, where the verified caller was keyed by
    // credential and unaffected. Recorded, not asserted as a defect.
    for (let i = 0; i < LIMIT + 1; i++) await bootstrap(app, "expired-session", "203.0.113.61");
    const fresh = await minter.mint("attack|fresh-neighbour");
    const res = await bootstrap(app, fresh, "203.0.113.61");
    console.log(
      `ATK-RL-STALE-NEIGHBOUR: verified caller behind exhausted address → ${res.statusCode}`,
    );
    expect([429, 503]).toContain(res.statusCode);
  });
});

describe("ATTACK ADJ-01: credential 429 inside authenticate() must not reach the datastore", () => {
  let app: FastifyInstance;
  const querySpy = vi.spyOn(pg.Pool.prototype, "query");
  beforeAll(async () => {
    app = buildApp(
      { ...baseConfig, databaseUrl: "postgres://pickle:nope@127.0.0.1:1/unreachable" },
      { objectStore: null, rateLimit: { defaultLimit: 2, expensiveLimit: 2 } },
    );
    await app.ready();
  });
  afterAll(async () => {
    await app?.close();
    querySpy.mockRestore();
  });
  afterEach(() => querySpy.mockClear());

  it("ATK-RL-AUTHENTICATE-429: once the credential budget is exhausted no SQL is issued for the throttled request", async () => {
    const token = await minter.mint("attack|authenticate");
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      statuses.push(
        (
          await app.inject({
            method: "GET",
            url: "/v1/me",
            remoteAddress: "203.0.113.70",
            headers: { authorization: `Bearer ${token}` },
          })
        ).statusCode,
      );
    }
    console.log(
      `ATK-RL-AUTHENTICATE-429: statuses=${statuses.join(",")} queries=${querySpy.mock.calls.length}`,
    );
    expect(statuses.slice(0, 2)).toEqual([503, 503]);
    expect(statuses.slice(2)).toEqual([429, 429, 429]);
    expect(querySpy.mock.calls.length, "throttled requests must not query the database").toBe(2);
  });
});

describe("ATTACK ADJ-01: WindowStore FIFO eviction", () => {
  const WINDOW_MS = 60_000;

  it("ATK-RL-EVICT-ACTIVE: an exhausted counter that is STILL BEING HIT survives a flood of fresh keys", () => {
    // The fix's doc comment: "a burst of fresh keys cannot reset another
    // caller's exhausted counter". FIFO by creation time evicts the OLDEST
    // window first — which is exactly the long-lived, exhausted, still-active
    // caller. Fresh single-hit flood keys are younger and survive instead.
    const store = new WindowStore(4);
    const t0 = 1_000_000;
    for (let i = 0; i < 10; i++) store.hit("exhausted", WINDOW_MS, t0 + i);
    store.hit("flood-1", WINDOW_MS, t0 + 20);
    store.hit("flood-2", WINDOW_MS, t0 + 21);
    store.hit("flood-3", WINDOW_MS, t0 + 22);
    store.hit("exhausted", WINDOW_MS, t0 + 23); // caller keeps hammering
    store.hit("flood-4", WINDOW_MS, t0 + 24); // store full → evict
    expect(
      store.peek("exhausted")?.count,
      "the actively-hit exhausted counter must not be the one dropped",
    ).toBe(11);
  });
});

describe("ATTACK ADJ-01: distinct-address flood resets an exhausted caller (app level)", () => {
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

  it("ATK-RL-CLEAR-VACUOUS: the candidate's ADJ-RL-CLEAR flood (distinct bearers, ONE address) never fills the store", async () => {
    hitSpy.mockClear();
    for (let i = 0; i < 1_000; i++) await bootstrap(app, `flood-${i}`, "198.51.100.1");
    const keys = new Set(hitSpy.mock.calls.map((c) => c[0]));
    console.log(
      `ATK-RL-CLEAR-VACUOUS: 1000 distinct bearers from one address → ${keys.size} store key(s)`,
    );
    // With the fix every unverified bearer collapses onto the address key, so
    // the candidate's own ADJ-RL-CLEAR test can no longer reach maxKeys and
    // does not exercise evict() at all.
    expect(keys.size).toBe(1);
  });

  it("ATK-RL-CLEAR-ADDRESSES: an exhausted caller's counter survives 50 000 fresh keys from DISTINCT addresses (same window)", async () => {
    const legit = "203.0.113.80";
    for (let i = 0; i < LIMIT; i++)
      expect((await bootstrap(app, "stale", legit)).statusCode).toBe(401);
    expect((await bootstrap(app, "stale", legit)).statusCode, "exhausted before flood").toBe(429);

    // IPv6 gives any host a /64 — 2^64 distinct source addresses for free.
    for (let i = 0; i < 50_000; i++) {
      const ip = `2001:db8::${(i >>> 16).toString(16)}:${(i & 0xffff).toString(16)}`;
      await bootstrap(app, "flood", ip);
    }
    const after = await bootstrap(app, "stale", legit);
    console.log(
      `ATK-RL-CLEAR-ADDRESSES: exhausted caller after 50k distinct-address flood → ${after.statusCode} (expected 429)`,
    );
    expect(
      after.statusCode,
      "exhausted budget must survive a key flood inside the same window",
    ).toBe(429);
  }, 300_000);
});
