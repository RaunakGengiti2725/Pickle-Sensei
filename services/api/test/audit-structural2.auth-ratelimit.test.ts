import { createHmac } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { buildVerifier, DevTokenVerifier } from "../src/auth/tokens.js";
import { loadConfig, type ApiConfig } from "../src/config.js";

/**
 * Structural audit probes (auditor #2) for the legacy Fastify API — no database.
 *
 * Every `it` below is a claim about the code at 4d812e1a. A failing case is a
 * finding, a passing case is a pinned invariant; nothing here changes production
 * code or existing tests.
 */

const DEV_SECRET = "audit-structural2-secret-0123456789";

function baseConfig(overrides: Partial<ApiConfig> = {}): ApiConfig {
  return {
    env: "test",
    port: 0,
    host: "127.0.0.1",
    appVersion: "0.1.0-audit",
    databaseUrl: null,
    devAuthSecret: DEV_SECRET,
    oidcIssuer: undefined,
    oidcAudience: undefined,
    oidcJwksUrl: undefined,
    sqsQueueUrl: undefined,
    consentExportSigningKey: undefined,
    consentExportSigningKeyId: "consent-export-k1",
    appleIapConfigured: false,
    googlePlayConfigured: false,
    ...overrides,
  };
}

function base64url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

/** Hand-rolled HS256 token so header/payload can be arbitrary (alg none, no exp, …). */
function rawToken(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  secret = DEV_SECRET,
): string {
  const h = base64url(JSON.stringify(header));
  const p = base64url(JSON.stringify(payload));
  const sig = createHmac("sha256", secret).update(`${h}.${p}`).digest("base64url");
  return `${h}.${p}.${sig}`;
}

describe("config.ts — PICKLE_ENV parsing", () => {
  it("rejects typo'd environments such as 'prod' before any verifier is built", () => {
    expect(() => loadConfig({ PICKLE_ENV: "prod" })).toThrow(/PICKLE_ENV must be one of/);
    expect(() => loadConfig({ PICKLE_ENV: "Production" })).toThrow(/PICKLE_ENV must be one of/);
    expect(() => loadConfig({ PICKLE_ENV: "" })).toThrow(/PICKLE_ENV must be one of/);
  });

  it("falls back to NODE_ENV then development when PICKLE_ENV is unset", () => {
    expect(loadConfig({}).env).toBe("development");
    expect(loadConfig({ NODE_ENV: "test" }).env).toBe("test");
    expect(loadConfig({ NODE_ENV: "production" }).env).toBe("production");
  });

  it("trims ADMIN_AUTH_SUBJECTS and drops empty entries", () => {
    const config = loadConfig({
      PICKLE_ENV: "test",
      ADMIN_AUTH_SUBJECTS: " auth0|a , ,auth0|b,, ",
    });
    expect(config.adminAuthSubjects).toEqual(["auth0|a", "auth0|b"]);
    expect(loadConfig({ PICKLE_ENV: "test" }).adminAuthSubjects).toEqual([]);
  });

  it("prefers DATABASE_URL_APP over DATABASE_URL", () => {
    const config = loadConfig({
      PICKLE_ENV: "test",
      DATABASE_URL: "postgres://owner@localhost/x",
      DATABASE_URL_APP: "postgres://app@localhost/x",
    });
    expect(config.databaseUrl).toBe("postgres://app@localhost/x");
    expect(loadConfig({ PICKLE_ENV: "test", DATABASE_URL: "postgres://o@h/x" }).databaseUrl).toBe(
      "postgres://o@h/x",
    );
    expect(loadConfig({ PICKLE_ENV: "test" }).databaseUrl).toBeNull();
  });
});

describe("tokens.ts — dev-token environment gating", () => {
  it("DevTokenVerifier cannot be constructed outside development/test", () => {
    for (const env of ["staging", "production", "prod", "", "Development"]) {
      expect(() => new DevTokenVerifier(env, DEV_SECRET)).toThrow(/never be constructed/);
    }
  });

  it("DevTokenVerifier requires a ≥16 char secret", () => {
    expect(() => new DevTokenVerifier("test", undefined)).toThrow(/DEV_AUTH_SECRET/);
    expect(() => new DevTokenVerifier("test", "short")).toThrow(/DEV_AUTH_SECRET/);
    expect(() => new DevTokenVerifier("test", "exactly16chars!!")).not.toThrow();
  });

  it("buildVerifier throws in staging/production without OIDC (fail closed)", () => {
    for (const pickleEnv of ["staging", "production"]) {
      expect(() => buildVerifier({ pickleEnv, devAuthSecret: DEV_SECRET })).toThrow(
        /OIDC must be configured/,
      );
    }
  });

  it("buildVerifier treats a __PLACEHOLDER JWKS url as unconfigured and still fails closed in production", () => {
    expect(() =>
      buildVerifier({
        pickleEnv: "production",
        oidcJwksUrl: "__PLACEHOLDER_JWKS_URL__",
        oidcIssuer: "https://issuer.example",
        oidcAudience: "pickle",
        devAuthSecret: DEV_SECRET,
      }),
    ).toThrow(/OIDC must be configured/);
  });

  it("buildVerifier with an unknown PICKLE_ENV string never yields a dev verifier", () => {
    // config.ts already rejects these; this pins the defence in depth in tokens.ts.
    for (const pickleEnv of ["prod", "stage", "dev", "local"]) {
      expect(() => buildVerifier({ pickleEnv, devAuthSecret: DEV_SECRET })).toThrow();
    }
  });

  it("buildVerifier with a 12-char secret in development throws instead of accepting a weak key", () => {
    expect(() => buildVerifier({ pickleEnv: "development", devAuthSecret: "weak-secret" })).toThrow(
      /DEV_AUTH_SECRET/,
    );
  });

  it("dev verifier rejects alg=none, wrong issuer, wrong secret, expired, and subject-less tokens", async () => {
    const verifier = new DevTokenVerifier("test", DEV_SECRET);
    const now = Math.floor(Date.now() / 1000);
    const good = { iss: "pickle-dev", sub: "auth0|x", iat: now, exp: now + 60 };

    const okResult = await verifier.verify(rawToken({ alg: "HS256", typ: "JWT" }, good));
    expect(okResult.ok).toBe(true);

    const cases: Array<[string, string]> = [
      [
        "alg none",
        `${base64url(JSON.stringify({ alg: "none" }))}.${base64url(JSON.stringify(good))}.`,
      ],
      ["wrong issuer", rawToken({ alg: "HS256" }, { ...good, iss: "pickle-prod" })],
      ["wrong secret", rawToken({ alg: "HS256" }, good, "another-secret-0123456789")],
      ["expired", rawToken({ alg: "HS256" }, { ...good, exp: now - 5 })],
      ["garbage", "not.a.jwt"],
    ];
    for (const [label, token] of cases) {
      const result = await verifier.verify(token);
      expect(result.ok, label).toBe(false);
      if (!result.ok) expect(result.failure.code).toBe("auth.invalid_token");
    }
    const noSub = await verifier.verify(
      rawToken({ alg: "HS256" }, { iss: "pickle-dev", exp: now + 60 }),
    );
    expect(noSub.ok).toBe(false);
    if (!noSub.ok) expect(noSub.failure.code).toBe("auth.no_subject");
  });

  it("dev verifier: a token WITHOUT exp is accepted (never expires) — dev/test only", async () => {
    // Documented here as an observed property, not an invariant: mint() always sets 15m,
    // but verify() does not require exp. Confined to development/test by the ctor guard.
    const verifier = new DevTokenVerifier("test", DEV_SECRET);
    const result = await verifier.verify(
      rawToken({ alg: "HS256" }, { iss: "pickle-dev", sub: "auth0|forever" }),
    );
    expect(result.ok).toBe(true);
  });

  it("role claim: only the literal string 'admin' is honoured", async () => {
    const verifier = new DevTokenVerifier("test", DEV_SECRET);
    const now = Math.floor(Date.now() / 1000);
    for (const role of ["Admin", "ADMIN", true, ["admin"], 1]) {
      const result = await verifier.verify(
        rawToken(
          { alg: "HS256" },
          { iss: "pickle-dev", sub: "s", exp: now + 60, pickle_role: role },
        ),
      );
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.role).toBe("user");
    }
  });
});

describe("buildApp — startup gating", () => {
  it("refuses to start in staging/production without OIDC configuration", () => {
    expect(() => buildApp(baseConfig({ env: "staging" }))).toThrow(/OIDC must be configured/);
    expect(() => buildApp(baseConfig({ env: "production" }))).toThrow(/OIDC must be configured/);
  });
});

describe("authPlugin — no datastore", () => {
  const app = buildApp(baseConfig());
  afterAll(async () => {
    await app.close();
  });

  it("missing bearer → 401 auth.missing_token on private and admin routes", async () => {
    for (const url of ["/v1/me", "/v1/flags", "/v1/admin/quality-dashboard"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(401);
      expect((res.json() as { error: { code: string } }).error.code).toBe("auth.missing_token");
    }
  });

  it("malformed Authorization schemes are refused as missing tokens", async () => {
    for (const authorization of ["Basic abc", "bearer x.y.z", "Bearer", "Bearer "]) {
      const res = await app.inject({ method: "GET", url: "/v1/me", headers: { authorization } });
      expect(res.statusCode, authorization).toBe(401);
    }
  });

  it("a valid dev token with no datastore → typed retryable 503 (account lookup cannot run)", async () => {
    const token = await new DevTokenVerifier("test", DEV_SECRET).mint("auth0|no-db");
    const res = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(503);
    const body = res.json() as { error: { kind: string; code: string } };
    expect(body.error.kind).toBe("retryable");
  });

  it("admin route with a valid ADMIN dev token but no datastore never returns 2xx", async () => {
    const token = await new DevTokenVerifier("test", DEV_SECRET).mint("auth0|no-db-admin", "admin");
    const res = await app.inject({
      method: "PUT",
      url: "/v1/admin/flags/social",
      headers: { authorization: `Bearer ${token}` },
      payload: { enabled: false },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).not.toBe(500);
  });
});

describe("rateLimitPlugin — caller keying (no datastore)", () => {
  const app = buildApp(baseConfig());
  afterAll(async () => {
    await app.close();
  });

  const expensive = { method: "POST" as const, url: "/v1/account/bootstrap", payload: {} };

  it("a fixed garbage bearer is throttled on an expensive route after 60 hits (401 → 429)", async () => {
    const headers = { authorization: "Bearer garbage-token-fixed" };
    let last = 0;
    for (let i = 0; i < 60; i += 1) {
      const res = await app.inject({ ...expensive, headers });
      last = res.statusCode;
      expect(last, `hit ${i + 1}`).toBe(401);
    }
    const throttled = await app.inject({ ...expensive, headers });
    expect(throttled.statusCode).toBe(429);
    expect(throttled.headers["retry-after"]).toBeTruthy();
    expect((throttled.json() as { error: { code: string } }).error.code).toBe("api.rate_limited");
  });

  it("SUSPECTED DEFECT: an unauthenticated caller rotating garbage bearers is never throttled by IP", async () => {
    // 200 requests from ONE client address (fastify inject → 127.0.0.1), each with a
    // distinct unverifiable bearer. If the IP budget applied, some would be 429.
    let throttled = 0;
    for (let i = 0; i < 200; i += 1) {
      const res = await app.inject({
        ...expensive,
        headers: { authorization: `Bearer rotate-${i}-${Math.random()}` },
      });
      if (res.statusCode === 429) throttled += 1;
    }
    expect(
      throttled,
      "requests throttled among 200 rotating-bearer hits from one IP",
    ).toBeGreaterThan(0);
  });

  it("a caller without a bearer IS throttled by IP on the same route", async () => {
    // Fresh app so the previous cases' buckets do not interfere.
    const fresh = buildApp(baseConfig());
    try {
      let firstThrottle = -1;
      for (let i = 0; i < 61; i += 1) {
        const res = await fresh.inject(expensive);
        if (res.statusCode === 429) {
          firstThrottle = i + 1;
          break;
        }
      }
      expect(firstThrottle).toBe(61);
    } finally {
      await fresh.close();
    }
  });
});

describe("rateLimitPlugin — bounded store eviction (no datastore)", () => {
  it("SUSPECTED DEFECT: 50k distinct keys wipe a live caller's counter (bypass by exhaustion)", async () => {
    const app = buildApp(baseConfig());
    try {
      const victim = { authorization: "Bearer victim-token-0001" };
      const expensive = { method: "POST" as const, url: "/v1/account/bootstrap", payload: {} };
      for (let i = 0; i < 60; i += 1) {
        expect((await app.inject({ ...expensive, headers: victim })).statusCode).toBe(401);
      }
      expect((await app.inject({ ...expensive, headers: victim })).statusCode).toBe(429);

      // Flood: 50_000 distinct bearer fingerprints on any non-health route.
      // WindowStore.maxKeys defaults to 50_000; when the store is full and nothing
      // has expired, evict() clears EVERY window.
      for (let i = 0; i < 50_000; i += 1) {
        await app.inject({
          method: "GET",
          url: "/v1/me",
          headers: { authorization: `Bearer flood-${i}` },
        });
      }

      const afterFlood = await app.inject({ ...expensive, headers: victim });
      expect(
        afterFlood.statusCode,
        "victim should still be throttled inside the same 60s window",
      ).toBe(429);
    } finally {
      await app.close();
    }
  }, 180_000);
});
