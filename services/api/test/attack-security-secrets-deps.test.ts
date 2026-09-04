import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations, seed } from "@pickle/database";
import { InMemoryJobQueue } from "@pickle/queue";
import { buildApp } from "../src/app.js";
import { buildVerifier, DevTokenVerifier } from "../src/auth/tokens.js";
import { loadConfig, type ApiConfig } from "../src/config.js";

/**
 * Adversarial pass 3 — subsystem `security-secrets-deps` (insecure defaults).
 *
 * S6: the dev HS256 issuer must be unconstructible when the *typed config*
 *     says production/staging, even when DEV_AUTH_SECRET is present and long
 *     enough (a leaked/copied .env in prod must not mint identities).
 * S7: with ADMIN_AUTH_SUBJECTS empty and env `test`, an `admin` token claim
 *     alone must NOT reach an admin route (config.ts adminAuthSubjects doc +
 *     authPlugin.ts requireAdmin allowlist).
 */

const migrationsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "packages",
  "database",
  "migrations",
);

function schemaUrl(base: string, schema: string): string {
  const url = new URL(base);
  url.searchParams.set("options", `-c search_path=${schema}`);
  return url.toString();
}

describe("S6 — DevTokenVerifier is unconstructible outside development/test", () => {
  const secret = "x".repeat(16);

  it("loadConfig(PICKLE_ENV=production, DEV_AUTH_SECRET=16 chars) → new DevTokenVerifier throws", () => {
    const cfg = loadConfig({ PICKLE_ENV: "production", DEV_AUTH_SECRET: secret });
    expect(cfg.env).toBe("production");
    expect(cfg.devAuthSecret).toBe(secret);
    expect(() => new DevTokenVerifier(cfg.env, cfg.devAuthSecret)).toThrow(
      /never be constructed outside development\/test/,
    );
  });

  it("same for staging", () => {
    const cfg = loadConfig({ PICKLE_ENV: "staging", DEV_AUTH_SECRET: secret });
    expect(() => new DevTokenVerifier(cfg.env, cfg.devAuthSecret)).toThrow(
      /never be constructed outside development\/test/,
    );
  });

  it("NODE_ENV=production alone (no PICKLE_ENV) is also production for the verifier", () => {
    const cfg = loadConfig({ NODE_ENV: "production", DEV_AUTH_SECRET: secret });
    expect(cfg.env).toBe("production");
    expect(() => new DevTokenVerifier(cfg.env, cfg.devAuthSecret)).toThrow();
  });

  it("buildVerifier refuses production/staging without OIDC and never falls back to dev tokens", () => {
    for (const env of ["production", "staging"] as const) {
      const cfg = loadConfig({ PICKLE_ENV: env, DEV_AUTH_SECRET: secret });
      expect(() =>
        buildVerifier({
          pickleEnv: cfg.env,
          oidcJwksUrl: cfg.oidcJwksUrl,
          oidcIssuer: cfg.oidcIssuer,
          oidcAudience: cfg.oidcAudience,
          devAuthSecret: cfg.devAuthSecret,
        }),
      ).toThrow(/OIDC must be configured/);
    }
  });

  it("a placeholder OIDC JWKS url in production does not silently select dev tokens", () => {
    const cfg = loadConfig({
      PICKLE_ENV: "production",
      DEV_AUTH_SECRET: secret,
      OIDC_JWKS_URL: "__PLACEHOLDER_JWKS__",
      OIDC_ISSUER: "https://issuer.example",
      OIDC_AUDIENCE: "pickle",
    });
    expect(() =>
      buildVerifier({
        pickleEnv: cfg.env,
        oidcJwksUrl: cfg.oidcJwksUrl,
        oidcIssuer: cfg.oidcIssuer,
        oidcAudience: cfg.oidcAudience,
        devAuthSecret: cfg.devAuthSecret,
      }),
    ).toThrow(/OIDC must be configured/);
  });

  it("buildApp(production config without OIDC) throws instead of booting with a dev issuer", () => {
    const cfg = loadConfig({ PICKLE_ENV: "production", DEV_AUTH_SECRET: secret });
    expect(() => buildApp(cfg, { queue: new InMemoryJobQueue() })).toThrow(
      /OIDC must be configured/,
    );
  });

  it("a short DEV_AUTH_SECRET (<16 chars) is rejected even in test", () => {
    const cfg = loadConfig({ PICKLE_ENV: "test", DEV_AUTH_SECRET: "short" });
    expect(() => new DevTokenVerifier(cfg.env, cfg.devAuthSecret)).toThrow(/≥16 chars/);
  });

  it("unicode 'padding' does not smuggle a short secret past the length check by code points", () => {
    // 15 code points + one combining mark = 16 JS string length; the guard is
    // by string length, so this is ACCEPTED. Pinned so the behaviour is explicit.
    const cfg = loadConfig({ PICKLE_ENV: "test", DEV_AUTH_SECRET: "x".repeat(15) + "\u0301" });
    expect(cfg.devAuthSecret!.length).toBe(16);
    expect(() => new DevTokenVerifier(cfg.env, cfg.devAuthSecret)).not.toThrow();
  });
});

const testUrl = process.env["DATABASE_URL_TEST"];

describe.skipIf(!testUrl)(
  "S7 — empty ADMIN_AUTH_SUBJECTS in env=test refuses an admin-claim token (isolated PostgreSQL schema)",
  () => {
    const secret = "attack-admin-allowlist-secret-0123456789";
    const schemaName = `attack_admin_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    let app: FastifyInstance;
    let pool: pg.Pool;
    let adminPool: pg.Pool;
    let adminToken: string;
    let userToken: string;

    const auth = (token: string) => ({ authorization: `Bearer ${token}` });

    async function bootstrap(token: string): Promise<void> {
      const res = await app.inject({
        method: "POST",
        url: "/v1/account/bootstrap",
        headers: auth(token),
        payload: {
          locale: "en-US",
          timezone: "America/Los_Angeles",
          device: { platform: "ios", osVersion: "18.0", appVersion: "0.1.0", model: "iPhone16,1" },
        },
      });
      expect(res.statusCode, res.body).toBe(200);
    }

    beforeAll(async () => {
      adminPool = new pg.Pool({ connectionString: testUrl });
      await adminPool.query(`CREATE SCHEMA ${schemaName}`);
      const scopedUrl = schemaUrl(testUrl!, schemaName);
      pool = new pg.Pool({ connectionString: scopedUrl });
      await runMigrations(pool, migrationsDir);
      await seed(pool);

      // EXACTLY the loader path: ADMIN_AUTH_SUBJECTS='' → [] ; PICKLE_ENV=test.
      const loaded = loadConfig({
        PICKLE_ENV: "test",
        DEV_AUTH_SECRET: secret,
        ADMIN_AUTH_SUBJECTS: "",
        DATABASE_URL_APP: scopedUrl,
      });
      expect(loaded.adminAuthSubjects).toEqual([]);
      const config: ApiConfig = { ...loaded, appVersion: "0.1.0-attack", port: 0 };
      app = buildApp(config, { queue: new InMemoryJobQueue() });

      const minter = new DevTokenVerifier("test", secret);
      adminToken = await minter.mint(`attack|admin-${randomUUID()}`, "admin");
      userToken = await minter.mint(`attack|user-${randomUUID()}`, "user");
      await bootstrap(adminToken);
      await bootstrap(userToken);
    }, 60_000);

    afterAll(async () => {
      await app?.close();
      await pool?.end();
      if (adminPool) {
        await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
        await adminPool.end();
      }
    });

    it("PUT /v1/admin/flags/x with pickle_role=admin → 403 auth.admin_not_authorized, flag not written", async () => {
      const res = await app.inject({
        method: "PUT",
        url: "/v1/admin/flags/x",
        headers: auth(adminToken),
        payload: { enabled: true },
      });
      expect(res.statusCode, res.body).toBe(403);
      const body = res.json() as { error: { kind: string; code: string } };
      expect(body.error.kind).toBe("permission_denied");
      expect(body.error.code).toBe("auth.admin_not_authorized");
      const flag = await pool.query("SELECT key FROM feature_flag WHERE key = $1", ["x"]);
      expect(flag.rowCount).toBe(0);
    });

    it("the other admin surfaces refuse too (disable, rollback, users)", async () => {
      for (const [method, url] of [
        ["POST", "/v1/admin/flags/x/disable"],
        ["POST", "/v1/admin/rollback/feature-flags/known-good"],
        ["GET", `/v1/admin/users/${randomUUID()}`],
      ] as const) {
        const res = await app.inject({ method, url, headers: auth(adminToken) });
        expect(res.statusCode, `${method} ${url} -> ${res.body}`).toBe(403);
        expect((res.json() as { error: { code: string } }).error.code).toBe(
          "auth.admin_not_authorized",
        );
      }
    });

    it("a plain user token is refused earlier with auth.admin_required (no allowlist leak)", async () => {
      const res = await app.inject({
        method: "PUT",
        url: "/v1/admin/flags/x",
        headers: auth(userToken),
        payload: { enabled: true },
      });
      expect(res.statusCode).toBe(403);
      expect((res.json() as { error: { code: string } }).error.code).toBe("auth.admin_required");
    });

    it("rapid repeats: 25 concurrent admin-claim requests all 403, zero flags written", async () => {
      const results = await Promise.all(
        Array.from({ length: 25 }, (_, i) =>
          app.inject({
            method: "PUT",
            url: `/v1/admin/flags/x-${i}`,
            headers: auth(adminToken),
            payload: { enabled: true, rolloutPercent: 100 },
          }),
        ),
      );
      for (const res of results) expect(res.statusCode).toBe(403);
      const flags = await pool.query("SELECT key FROM feature_flag WHERE key LIKE 'x-%'");
      expect(flags.rowCount).toBe(0);
    });

    it("whitespace-only / comma-only ADMIN_AUTH_SUBJECTS is still an empty allowlist", () => {
      for (const raw of ["   ", ",,,", " , , ", "\t,\n"]) {
        expect(
          loadConfig({ PICKLE_ENV: "test", ADMIN_AUTH_SUBJECTS: raw }).adminAuthSubjects,
        ).toEqual([]);
      }
    });

    it("an allowlist entry that merely contains the subject does not match (exact match only)", async () => {
      const subject = `attack|prefix-${randomUUID()}`;
      const loaded = loadConfig({
        PICKLE_ENV: "test",
        DEV_AUTH_SECRET: secret,
        ADMIN_AUTH_SUBJECTS: `${subject}-suffix,prefix-${subject}`,
        DATABASE_URL_APP: schemaUrl(testUrl!, schemaName),
      });
      const other = buildApp(
        { ...loaded, appVersion: "0.1.0-attack", port: 0 },
        { queue: new InMemoryJobQueue() },
      );
      try {
        const token = await new DevTokenVerifier("test", secret).mint(subject, "admin");
        const boot = await other.inject({
          method: "POST",
          url: "/v1/account/bootstrap",
          headers: auth(token),
          payload: {
            locale: "en-US",
            timezone: "America/Los_Angeles",
            device: {
              platform: "ios",
              osVersion: "18.0",
              appVersion: "0.1.0",
              model: "iPhone16,1",
            },
          },
        });
        expect(boot.statusCode, boot.body).toBe(200);
        const res = await other.inject({
          method: "PUT",
          url: "/v1/admin/flags/x",
          headers: auth(token),
          payload: { enabled: true },
        });
        expect(res.statusCode, res.body).toBe(403);
        expect((res.json() as { error: { code: string } }).error.code).toBe(
          "auth.admin_not_authorized",
        );
      } finally {
        await other.close();
      }
    });
  },
);
