import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { buildVerifier, DevTokenVerifier } from "../src/auth/tokens.js";
import type { ApiConfig } from "../src/config.js";
import { DEFAULT_RATE_LIMIT } from "../src/plugins/rateLimitPlugin.js";

/**
 * Adversarial pass 3 (services-api-legacy-admin-web) — no-database attacks on
 * the legacy Fastify API's rate limiter and dev-token gating, pinned to the
 * behaviour observed at 4d812e1a. Each `it` is one attack scenario and states
 * in its title whether the property HELD or is BROKEN at that commit; a
 * BROKEN case asserts the observed (bad) behaviour so a fix flips the test.
 */

const DEV_SECRET = "attack-pass3-secret-0123456789";

function config(overrides: Partial<ApiConfig> = {}): ApiConfig {
  return {
    env: "test",
    port: 0,
    host: "127.0.0.1",
    appVersion: "0.1.0-attack",
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

type Envelope = { error: { kind: string; code: string; retryable: boolean; requestId: string } };

const apps: FastifyInstance[] = [];
afterEach(async () => {
  vi.useRealTimers();
  while (apps.length > 0) await apps.pop()!.close();
});

function app(rateLimit?: Partial<ApiConfig> & { expensiveLimit?: number; defaultLimit?: number }) {
  const { expensiveLimit, defaultLimit, ...cfg } = rateLimit ?? {};
  const instance = buildApp(config(cfg), {
    rateLimit: {
      ...(expensiveLimit !== undefined ? { expensiveLimit } : {}),
      ...(defaultLimit !== undefined ? { defaultLimit } : {}),
    },
  });
  apps.push(instance);
  return instance;
}

const MEDIA_URL = `/v1/media/${randomUUID()}`;

/**
 * Scenario 2 — BoundedWindowStore eviction semantics.
 *
 * `WindowStore` is module-private in rateLimitPlugin.ts, so the class body is
 * lifted VERBATIM from the source file at test time (no copy that could drift)
 * and instantiated with maxKeys = 5. The behavioural twin below drives the real
 * plugin through `buildApp` at the production maxKeys of 50 000.
 */
function loadWindowStoreClass(): new (maxKeys?: number) => {
  hit(key: string, windowMs: number, now: number): { count: number; resetAt: number };
} {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "src", "plugins", "rateLimitPlugin.ts"),
    "utf8",
  );
  const start = source.indexOf("class WindowStore");
  const end = source.indexOf("function callerKey");
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const body = source
    .slice(start, end)
    // strip the TS-only bits so the exact logic runs as plain JS
    .replace(/private windows = new Map<string, Window>\(\);/, "windows = new Map();")
    .replace(
      /constructor\(private maxKeys = 50_000\) \{\}/,
      "constructor(maxKeys = 50_000) { this.maxKeys = maxKeys; }",
    )
    .replace(/: string|: number|: Window|: void/g, "")
    .replace(/private evict/, "evict");
  return new Function(`${body}; return WindowStore;`)() as ReturnType<typeof loadWindowStoreClass>;
}

describe("S2 — WindowStore(maxKeys=5) eviction (verbatim class from rateLimitPlugin.ts)", () => {
  it("BROKEN: a 6th distinct key inside one window wipes ALL five live counters (clear() at rateLimitPlugin.ts:74)", () => {
    const WindowStore = loadWindowStoreClass();
    const store = new WindowStore(5);
    const now = 1_000_000;
    for (let i = 1; i <= 5; i += 1) {
      // three hits per key so the counters are unmistakably "live"
      store.hit(`k${i}`, 60_000, now);
      store.hit(`k${i}`, 60_000, now);
      expect(store.hit(`k${i}`, 60_000, now).count).toBe(3);
    }
    // sixth distinct key, none of the five has expired
    expect(store.hit("k6", 60_000, now + 1).count).toBe(1);
    // the first five counters did NOT survive: every one restarts at 1
    const survivors = [1, 2, 3, 4, 5].map((i) => store.hit(`k${i}`, 60_000, now + 2).count);
    expect(survivors).toEqual([1, 1, 1, 1, 1]);
  });

  it("HELD: eviction prefers expired windows — live counters survive when an expired key can be dropped", () => {
    const WindowStore = loadWindowStoreClass();
    const store = new WindowStore(5);
    const now = 1_000_000;
    store.hit("expired", 1, now - 10); // resetAt = now - 9 → already expired
    for (let i = 1; i <= 4; i += 1) {
      store.hit(`k${i}`, 60_000, now);
      store.hit(`k${i}`, 60_000, now);
    }
    store.hit("k6", 60_000, now); // size 5 → evict(): drops "expired" only
    expect([1, 2, 3, 4].map((i) => store.hit(`k${i}`, 60_000, now).count)).toEqual([3, 3, 3, 3]);
  });
});

describe("S2 (behavioural twin) — real plugin at maxKeys=50 000", () => {
  it("BROKEN: 50 000 unauthenticated garbage bearers from one IP reset an exhausted expensive budget", async () => {
    const api = app({ expensiveLimit: 3 });
    const minter = new DevTokenVerifier("test", DEV_SECRET);
    const token = await minter.mint("auth0|attack-s2");
    const headers = { authorization: `Bearer ${token}` };

    for (let i = 0; i < 3; i += 1) {
      const res = await api.inject({ method: "GET", url: MEDIA_URL, headers });
      expect(res.statusCode).toBe(503); // authenticated, DB unavailable → counted
    }
    const limited = await api.inject({ method: "GET", url: MEDIA_URL, headers });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBeDefined();

    // flood: 50 000 distinct never-verified bearer strings → 50 000 store keys
    for (let i = 0; i < 50_000; i += 1) {
      const res = await api.inject({
        method: "GET",
        url: "/v1/me",
        headers: { authorization: `Bearer garbage-${i}` },
      });
      if (res.statusCode !== 401) throw new Error(`flood #${i} → ${res.statusCode} ${res.body}`);
    }

    // the attacker's own exhausted counter has been wiped by clear()
    const after = await api.inject({ method: "GET", url: MEDIA_URL, headers });
    expect(after.statusCode).toBe(503);
    expect(after.headers["retry-after"]).toBeUndefined();
  }, 300_000);
});

describe("S3 — DevTokenVerifier construction gates", () => {
  it("HELD: staging + valid secret throws the directive §5 message", () => {
    expect(() => new DevTokenVerifier("staging", "a-perfectly-valid-secret-0123")).toThrowError(
      /must never be constructed outside development\/test \(directive §5\)/,
    );
  });

  it("HELD: development + 15-char secret throws the ≥16-char message", () => {
    const short = "15chars-secret!";
    expect(short).toHaveLength(15);
    expect(() => new DevTokenVerifier("development", short)).toThrowError(
      /DEV_AUTH_SECRET \(≥16 chars\) is required/,
    );
  });

  it("HELD: production, empty, undefined and 16-char boundary behave as documented", () => {
    expect(() => new DevTokenVerifier("production", "a-perfectly-valid-secret-0123")).toThrowError(
      /directive §5/,
    );
    expect(() => new DevTokenVerifier("development", undefined)).toThrowError(/≥16 chars/);
    expect(() => new DevTokenVerifier("development", "")).toThrowError(/≥16 chars/);
    expect(() => new DevTokenVerifier("development", "exactly16chars!!")).not.toThrow();
    // env check runs first: a bad env with a bad secret reports the env problem
    expect(() => new DevTokenVerifier("staging", "x")).toThrowError(/directive §5/);
  });

  it("HELD: buildVerifier refuses staging/production without OIDC (placeholder JWKS counts as unset)", () => {
    for (const pickleEnv of ["staging", "production"]) {
      expect(() =>
        buildVerifier({ pickleEnv, devAuthSecret: "a-perfectly-valid-secret-0123" }),
      ).toThrowError(/OIDC must be configured in staging\/production/);
      expect(() =>
        buildVerifier({
          pickleEnv,
          oidcJwksUrl: "__PLACEHOLDER_JWKS__",
          oidcIssuer: "https://issuer.example",
          oidcAudience: "pickle",
          devAuthSecret: "a-perfectly-valid-secret-0123",
        }),
      ).toThrowError(/OIDC must be configured/);
    }
  });

  it("HELD: a dev token minted with a different secret / issuer / alg=none is refused", async () => {
    const good = new DevTokenVerifier("test", DEV_SECRET);
    const evil = new DevTokenVerifier("test", "another-secret-0123456789");
    const forged = await evil.mint("auth0|forged", "admin");
    const refused = await good.verify(forged);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.failure.code).toBe("auth.invalid_token");

    const [h, p] = (await good.mint("auth0|victim", "admin")).split(".");
    const none = `${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")}.${p}.`;
    const noneResult = await good.verify(none);
    expect(noneResult.ok).toBe(false);
    expect(h).toBeTruthy();

    // right secret, wrong issuer
    const { SignJWT } = await import("jose");
    const wrongIssuer = await new SignJWT({ pickle_role: "admin" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("pickle-prod")
      .setSubject("auth0|victim")
      .setIssuedAt()
      .setExpirationTime("15m")
      .sign(new TextEncoder().encode(DEV_SECRET));
    expect((await good.verify(wrongIssuer)).ok).toBe(false);
  });
});

describe("S4 — expensive budget window reset", () => {
  it("HELD: after 60 requests the 61st is 429 with retry-after; +60 001 ms the window is fresh and no stale retry-after leaks", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = new Date("2026-09-04T12:00:00.000Z").getTime();
    vi.setSystemTime(t0);

    const api = app(); // DEFAULT_RATE_LIMIT: expensiveLimit 60, windowMs 60 000
    expect(DEFAULT_RATE_LIMIT.expensiveLimit).toBe(60);
    const token = await new DevTokenVerifier("test", DEV_SECRET).mint("auth0|attack-s4");
    const headers = { authorization: `Bearer ${token}` };

    for (let i = 0; i < 60; i += 1) {
      const res = await api.inject({ method: "GET", url: MEDIA_URL, headers });
      expect(res.statusCode, `request #${i + 1}`).toBe(503);
      expect(res.headers["retry-after"]).toBeUndefined();
    }
    const limited = await api.inject({ method: "GET", url: MEDIA_URL, headers });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBe("60");
    const body = limited.json() as Envelope;
    expect(body.error).toMatchObject({
      kind: "retryable",
      code: "api.rate_limited",
      retryable: true,
    });

    // 59 999 ms later: still the same window, retry-after shrinks to 1
    vi.setSystemTime(t0 + 59_999);
    const stillLimited = await api.inject({ method: "GET", url: MEDIA_URL, headers });
    expect(stillLimited.statusCode).toBe(429);
    expect(stillLimited.headers["retry-after"]).toBe("1");

    // exactly resetAt: `resetAt > now` is false → fresh window
    vi.setSystemTime(t0 + 60_000);
    const boundary = await api.inject({ method: "GET", url: MEDIA_URL, headers });
    expect(boundary.statusCode).toBe(503);
    expect(boundary.headers["retry-after"]).toBeUndefined();

    // the requested +60 001 ms probe (window opened at t0+60 000, count now 2)
    vi.setSystemTime(t0 + 60_001);
    const fresh = await api.inject({ method: "GET", url: MEDIA_URL, headers });
    expect(fresh.statusCode).toBe(503);
    expect(fresh.headers["retry-after"]).toBeUndefined();

    // and the fresh window has its own full budget: 58 more succeed, the 61st is 429 again
    for (let i = 0; i < 58; i += 1) {
      const res = await api.inject({ method: "GET", url: MEDIA_URL, headers });
      expect(res.statusCode, `fresh window request #${i + 3}`).toBe(503);
    }
    const limitedAgain = await api.inject({ method: "GET", url: MEDIA_URL, headers });
    expect(limitedAgain.statusCode).toBe(429);
    expect(limitedAgain.headers["retry-after"]).toBe("60");
  });

  it("HELD: the expensive budget is per route — exhausting GET /v1/media/:id leaves POST /v1/account/bootstrap and ordinary reads untouched", async () => {
    const api = app({ expensiveLimit: 2 });
    const token = await new DevTokenVerifier("test", DEV_SECRET).mint("auth0|attack-s4b");
    const headers = { authorization: `Bearer ${token}` };
    for (let i = 0; i < 2; i += 1) await api.inject({ method: "GET", url: MEDIA_URL, headers });
    expect((await api.inject({ method: "GET", url: MEDIA_URL, headers })).statusCode).toBe(429);
    const bootstrap = await api.inject({
      method: "POST",
      url: "/v1/account/bootstrap",
      headers,
      payload: {},
    });
    expect(bootstrap.statusCode).toBe(503); // db.unavailable, not 429
    expect((await api.inject({ method: "GET", url: "/v1/me", headers })).statusCode).toBe(503);
  });
});

describe("S7 — 61 garbage bearers against GET /v1/media/<uuid>", () => {
  it("BROKEN: rate limiting is keyed by the UNVERIFIED bearer hash (rateLimitPlugin.ts:82) — 61 rotating garbage tokens from one IP are never throttled", async () => {
    const api = app(); // expensiveLimit 60
    const statuses: number[] = [];
    const retryAfterSeen: string[] = [];
    for (let i = 0; i < 61; i += 1) {
      const res = await api.inject({
        method: "GET",
        url: MEDIA_URL,
        headers: { authorization: `Bearer not-a-jwt-${i}-${randomUUID()}` },
      });
      statuses.push(res.statusCode);
      if (res.headers["retry-after"] !== undefined) {
        retryAfterSeen.push(String(res.headers["retry-after"]));
      }
    }
    // observed at 4d812e1a: every request is a fresh key → 61 × 401, zero 429
    expect(statuses.filter((s) => s === 429)).toHaveLength(0);
    expect(statuses.every((s) => s === 401)).toBe(true);
    expect(retryAfterSeen).toEqual([]);
  });

  it("HELD (control): the SAME garbage bearer 61 times IS throttled on the 61st request", async () => {
    const api = app();
    const headers = { authorization: "Bearer same-garbage-token" };
    const statuses: number[] = [];
    let retryAfter: string | undefined;
    for (let i = 0; i < 61; i += 1) {
      const res = await api.inject({ method: "GET", url: MEDIA_URL, headers });
      statuses.push(res.statusCode);
      if (i === 60) retryAfter = res.headers["retry-after"] as string | undefined;
    }
    expect(statuses.slice(0, 60).every((s) => s === 401)).toBe(true);
    expect(statuses[60]).toBe(429);
    expect(retryAfter).toBe("60");
  });

  it("HELD (control): with NO bearer the budget is per IP — 61 unauthenticated requests trip 429 and x-forwarded-for cannot rotate the key (trustProxy off)", async () => {
    const api = app();
    const statuses: number[] = [];
    for (let i = 0; i < 61; i += 1) {
      const res = await api.inject({
        method: "GET",
        url: MEDIA_URL,
        headers: { "x-forwarded-for": `10.0.${Math.floor(i / 256)}.${i % 256}` },
      });
      statuses.push(res.statusCode);
    }
    expect(statuses.slice(0, 60).every((s) => s === 401)).toBe(true);
    expect(statuses[60]).toBe(429);
  });

  it("BROKEN (variant): a lowercase `bearer ` prefix is counted per IP but `Bearer ` + garbage never is — the bypass needs only the case-correct prefix", async () => {
    const api = app({ expensiveLimit: 2 });
    // lowercase prefix: callerKey falls back to ip, verifyToken says missing_token
    for (let i = 0; i < 2; i += 1) {
      const res = await api.inject({
        method: "GET",
        url: MEDIA_URL,
        headers: { authorization: `bearer junk-${i}` },
      });
      expect(res.statusCode).toBe(401);
      expect((res.json() as Envelope).error.code).toBe("auth.missing_token");
    }
    expect(
      (await api.inject({ method: "GET", url: MEDIA_URL, headers: { authorization: "bearer x" } }))
        .statusCode,
    ).toBe(429);
    // case-correct prefix with rotating garbage: unlimited
    for (let i = 0; i < 10; i += 1) {
      const res = await api.inject({
        method: "GET",
        url: MEDIA_URL,
        headers: { authorization: `Bearer junk-${i}` },
      });
      expect(res.statusCode).toBe(401);
      expect((res.json() as Envelope).error.code).toBe("auth.invalid_token");
    }
  });
});

describe("extra — request-id and identifier hygiene on the rate-limited path", () => {
  it("HELD: a 2 KB client-supplied x-request-id is echoed verbatim into the 429 envelope", async () => {
    const api = app({ expensiveLimit: 1 });
    const headers = { authorization: "Bearer same" };
    await api.inject({ method: "GET", url: MEDIA_URL, headers });
    const requestId = `attack-${"x".repeat(2048)}`;
    const res = await api.inject({
      method: "GET",
      url: MEDIA_URL,
      headers: { ...headers, "x-request-id": requestId },
    });
    expect(res.statusCode).toBe(429);
    expect((res.json() as Envelope).error.requestId).toBe(requestId);
    expect(res.headers["x-request-id"]).toBe(requestId);
  });

  it("HELD (real socket): UTF-8 / NUL / DEL / 20 KB x-request-id never 500 over real HTTP (200, 400, 400, 431)", async () => {
    // light-my-request hands the JS string straight to Node's header setter, so a
    // non-latin1 request id 500s ONLY under inject; over a real socket Node
    // decodes header bytes as latin1 and the echo is legal. Probe the real path.
    const api = app();
    await api.listen({ port: 0, host: "127.0.0.1" });
    const port = (api.server.address() as { port: number }).port;
    const { connect } = await import("node:net");
    const raw = (bytes: Buffer) =>
      new Promise<string>((resolve) => {
        const sock = connect(port, "127.0.0.1", () => sock.write(bytes));
        const chunks: Buffer[] = [];
        sock.on("data", (c: Buffer) => chunks.push(c));
        sock.on("close", () => resolve(Buffer.concat(chunks).toString("latin1")));
        sock.on("error", (e: Error) => resolve(`SOCKET ERROR ${e.message}`));
        setTimeout(() => sock.destroy(), 1500);
      });
    const head = "GET /v1/health HTTP/1.1\r\nHost: x\r\nConnection: close\r\nx-request-id: ";
    const status = (res: string) => Number(res.split(" ")[1]);
    const utf8 = Buffer.concat([
      Buffer.from(head),
      Buffer.from("ünïcödé-😀", "utf8"),
      Buffer.from("\r\n\r\n"),
    ]);
    const nul = Buffer.concat([
      Buffer.from(`${head}ab`),
      Buffer.from([0]),
      Buffer.from("cd\r\n\r\n"),
    ]);
    const del = Buffer.concat([
      Buffer.from(`${head}ab`),
      Buffer.from([0x7f]),
      Buffer.from("cd\r\n\r\n"),
    ]);
    const huge = Buffer.from(`${head}${"x".repeat(20_480)}\r\n\r\n`);
    expect(status(await raw(utf8))).toBe(200);
    expect(status(await raw(nul))).toBe(400);
    expect(status(await raw(del))).toBe(400);
    expect(status(await raw(huge))).toBe(431);
  });

  it("HELD: malformed / NUL-bearing path ids are rejected before the handler and still consume budget", async () => {
    const api = app({ expensiveLimit: 2 });
    const headers = { authorization: "Bearer same" };
    const bad = await api.inject({ method: "GET", url: "/v1/media/not-a-uuid", headers });
    expect(bad.statusCode).toBe(400);
    expect((bad.json() as Envelope).error.code).toBe("validation.path_id");
    const nul = await api.inject({ method: "GET", url: `${MEDIA_URL}%00`, headers });
    expect(nul.statusCode).toBe(400);
    expect((nul.json() as Envelope).error.code).toBe("validation.identifier");
    const third = await api.inject({ method: "GET", url: MEDIA_URL, headers });
    expect(third.statusCode).toBe(429);
  });
});
