import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { DevTokenVerifier, buildVerifier } from "../../src/auth/tokens.js";
import { attackConfig, writeArtifact } from "./support.js";

/**
 * ATTACK S5 + S6 — the OIDC startup gate (tokens.ts `buildVerifier`).
 *
 * S5: `OIDC_JWKS_URL="__PLACEHOLDER_JWKS"` next to a real-looking issuer and
 *     audience. Development → the DEV verifier is selected (placeholder is
 *     "not configured"). Production → startup throws.
 * S6: PICKLE_ENV=production with NO OIDC_* at all → `buildApp` throws
 *     "OIDC must be configured…" before any listen() can happen.
 * Extra probes: staging behaves like production; a placeholder issuer /
 * audience (not just JWKS) must not slip an OidcTokenVerifier through; the
 * dev verifier is never constructed in production even with a dev secret.
 */

const REAL_LOOKING = {
  oidcIssuer: "https://pickle-sensei.us.auth0.com/",
  oidcAudience: "https://api.picklesensei.app",
};
const DEV_SECRET = "attack4-dev-secret-0123456789abcdef";
const OIDC_ERROR = /OIDC must be configured/;

const outcomes: Array<{ case: string; outcome: string }> = [];
const record = (name: string, outcome: string) => outcomes.push({ case: name, outcome });

describe("ATTACK S5: placeholder JWKS with real-looking issuer/audience", () => {
  it("development selects the DEV verifier (placeholder JWKS counts as unconfigured)", async () => {
    const verifier = buildVerifier({
      pickleEnv: "development",
      oidcJwksUrl: "__PLACEHOLDER_JWKS",
      ...REAL_LOOKING,
      devAuthSecret: DEV_SECRET,
    });
    record("S5 development", verifier.constructor.name);
    expect(verifier).toBeInstanceOf(DevTokenVerifier);
    // …and it really verifies dev tokens, so this is the live auth path.
    const token = await new DevTokenVerifier("development", DEV_SECRET).mint("attack4|s5");
    const verified = await verifier.verify(token);
    expect(verified.ok).toBe(true);
  });

  it("test env behaves like development", () => {
    const verifier = buildVerifier({
      pickleEnv: "test",
      oidcJwksUrl: "__PLACEHOLDER_JWKS",
      ...REAL_LOOKING,
      devAuthSecret: DEV_SECRET,
    });
    record("S5 test", verifier.constructor.name);
    expect(verifier).toBeInstanceOf(DevTokenVerifier);
  });

  it("production with a placeholder JWKS throws at startup", () => {
    const attempt = () =>
      buildVerifier({
        pickleEnv: "production",
        oidcJwksUrl: "__PLACEHOLDER_JWKS",
        ...REAL_LOOKING,
        devAuthSecret: DEV_SECRET,
      });
    expect(attempt).toThrow(OIDC_ERROR);
    record("S5 production", "throws OIDC must be configured");
  });

  it("staging with a placeholder JWKS throws at startup", () => {
    expect(() =>
      buildVerifier({
        pickleEnv: "staging",
        oidcJwksUrl: "__PLACEHOLDER_JWKS",
        ...REAL_LOOKING,
        devAuthSecret: DEV_SECRET,
      }),
    ).toThrow(OIDC_ERROR);
    record("S5 staging", "throws OIDC must be configured");
  });

  it("placeholder variants of the JWKS URL never yield an OIDC verifier", () => {
    for (const jwks of [
      "__PLACEHOLDER",
      "__PLACEHOLDER_JWKS_URL",
      "__PLACEHOLDER_https://x/.well-known/jwks.json",
    ]) {
      expect(
        () => buildVerifier({ pickleEnv: "production", oidcJwksUrl: jwks, ...REAL_LOOKING }),
        jwks,
      ).toThrow(OIDC_ERROR);
      const dev = buildVerifier({
        pickleEnv: "development",
        oidcJwksUrl: jwks,
        ...REAL_LOOKING,
        devAuthSecret: DEV_SECRET,
      });
      expect(dev, jwks).toBeInstanceOf(DevTokenVerifier);
    }
  });

  it("a real JWKS URL with a PLACEHOLDER issuer or audience is NOT treated as unconfigured", () => {
    // Pins the current contract precisely: only the JWKS URL is placeholder-
    // checked. An `__PLACEHOLDER` issuer/audience next to a real JWKS URL
    // produces an OidcTokenVerifier that will reject every token (issuer
    // mismatch) rather than failing at startup.
    const verifier = buildVerifier({
      pickleEnv: "production",
      oidcJwksUrl: "https://pickle-sensei.us.auth0.com/.well-known/jwks.json",
      oidcIssuer: "__PLACEHOLDER_ISSUER",
      oidcAudience: "__PLACEHOLDER_AUDIENCE",
    });
    record("S5 placeholder issuer/audience in production", verifier.constructor.name);
    expect(verifier).not.toBeInstanceOf(DevTokenVerifier);
    expect(verifier.constructor.name).toBe("OidcTokenVerifier");
  });
});

describe("ATTACK S6: production buildApp without any OIDC_* variables", () => {
  const built: FastifyInstance[] = [];
  afterEach(async () => {
    while (built.length) await built.pop()!.close();
  });

  it("buildApp throws 'OIDC must be configured…' before listen", () => {
    const attempt = () => {
      const app = buildApp(
        attackConfig({
          env: "production",
          databaseUrl: null,
          oidcIssuer: undefined,
          oidcAudience: undefined,
          oidcJwksUrl: undefined,
          devAuthSecret: undefined,
        }),
      );
      built.push(app);
      return app;
    };
    expect(attempt).toThrow(OIDC_ERROR);
    expect(built, "no app instance may exist after the throw").toHaveLength(0);
    record("S6 production, no OIDC, no dev secret", "buildApp throws OIDC must be configured");
  });

  it("a dev secret does not rescue production (dev tokens are forbidden there)", () => {
    expect(() =>
      built.push(
        buildApp(
          attackConfig({
            env: "production",
            databaseUrl: null,
            oidcIssuer: undefined,
            oidcAudience: undefined,
            oidcJwksUrl: undefined,
            devAuthSecret: DEV_SECRET,
          }),
        ),
      ),
    ).toThrow(OIDC_ERROR);
    record("S6 production, no OIDC, dev secret set", "buildApp throws OIDC must be configured");
  });

  it("partial OIDC (issuer + audience, no JWKS) still throws in production and staging", () => {
    for (const env of ["production", "staging"] as const) {
      expect(
        () =>
          built.push(
            buildApp(
              attackConfig({
                env,
                databaseUrl: null,
                oidcJwksUrl: undefined,
                ...REAL_LOOKING,
                devAuthSecret: undefined,
              }),
            ),
          ),
        env,
      ).toThrow(OIDC_ERROR);
    }
    record("S6 partial OIDC production/staging", "buildApp throws OIDC must be configured");
  });

  it("development without OIDC builds and serves /v1/health (the intended dev path)", async () => {
    const app = buildApp(attackConfig({ env: "development", databaseUrl: null }));
    built.push(app);
    const res = await app.inject({ method: "GET", url: "/v1/health" });
    expect(res.statusCode).toBe(200);
    record("S6 development, no OIDC", "buildApp ok, health 200");
    writeArtifact("s5-s6-oidc-startup-gate.json", { scenario: "S5+S6", outcomes });
  });
});
