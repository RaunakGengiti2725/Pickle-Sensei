import { describe, expect, it } from "vitest";
import { SignJWT } from "jose";
import { DevTokenVerifier, buildVerifier } from "../../src/auth/tokens.js";
import { loadConfig } from "../../src/config.js";

/**
 * Structural audit (pass 1): dev-token gating and PICKLE_ENV fail-closed
 * behaviour that the mapper listed as untested. Pure unit tests, no datastore.
 */

const SECRET = "audit-secret-0123456789abcdef";
const key = new TextEncoder().encode(SECRET);

function base64url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

describe("config: PICKLE_ENV parsing (audit)", () => {
  it("rejects a typo'd environment such as 'prod' instead of defaulting open", () => {
    expect(() => loadConfig({ PICKLE_ENV: "prod" })).toThrow(/PICKLE_ENV must be one of/);
    expect(() => loadConfig({ PICKLE_ENV: "Production" })).toThrow(/PICKLE_ENV must be one of/);
    expect(() => loadConfig({ PICKLE_ENV: "" })).toThrow(/PICKLE_ENV must be one of/);
  });

  it("ADMIN_AUTH_SUBJECTS ignores whitespace and empty entries", () => {
    const config = loadConfig({
      PICKLE_ENV: "test",
      ADMIN_AUTH_SUBJECTS: " auth0|a , ,auth0|b,, ",
    });
    expect(config.adminAuthSubjects).toEqual(["auth0|a", "auth0|b"]);
  });

  it("DATABASE_URL_APP takes precedence over DATABASE_URL", () => {
    const config = loadConfig({
      PICKLE_ENV: "test",
      DATABASE_URL: "postgres://owner",
      DATABASE_URL_APP: "postgres://runtime",
    });
    expect(config.databaseUrl).toBe("postgres://runtime");
  });
});

describe("buildVerifier: dev tokens only ever exist in development|test (audit)", () => {
  it("throws in staging/production without OIDC (fail closed at startup)", () => {
    for (const pickleEnv of ["staging", "production"]) {
      expect(() => buildVerifier({ pickleEnv, devAuthSecret: SECRET })).toThrow(/OIDC/);
    }
  });

  it("treats a __PLACEHOLDER JWKS as unconfigured (still throws in production)", () => {
    expect(() =>
      buildVerifier({
        pickleEnv: "production",
        oidcJwksUrl: "__PLACEHOLDER_JWKS_URL__",
        oidcIssuer: "https://issuer.example",
        oidcAudience: "pickle",
        devAuthSecret: SECRET,
      }),
    ).toThrow(/OIDC/);
  });

  it("refuses to construct a DevTokenVerifier outside development/test", () => {
    for (const env of ["staging", "production", "prod", ""]) {
      expect(() => new DevTokenVerifier(env, SECRET)).toThrow(/never be constructed/);
    }
  });

  it("requires a ≥16 char DEV_AUTH_SECRET", () => {
    expect(() => new DevTokenVerifier("test", undefined)).toThrow(/DEV_AUTH_SECRET/);
    expect(() => new DevTokenVerifier("test", "short")).toThrow(/DEV_AUTH_SECRET/);
  });
});

describe("DevTokenVerifier: forged/expired/malformed tokens are refused (audit)", () => {
  const verifier = new DevTokenVerifier("test", SECRET);

  it("accepts a well-formed token it minted (control)", async () => {
    const token = await verifier.mint("auth0|audit-user");
    const result = await verifier.verify(token);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ authSubject: "auth0|audit-user", role: "user" });
  });

  it("refuses alg=none", async () => {
    const header = base64url(JSON.stringify({ alg: "none", typ: "JWT" }));
    const payload = base64url(
      JSON.stringify({ iss: "pickle-dev", sub: "attacker", pickle_role: "admin" }),
    );
    const result = await verifier.verify(`${header}.${payload}.`);
    expect(result.ok).toBe(false);
  });

  it("refuses a token signed with a different secret", async () => {
    const token = await new SignJWT({ pickle_role: "admin" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("pickle-dev")
      .setSubject("attacker")
      .setIssuedAt()
      .setExpirationTime("15m")
      .sign(new TextEncoder().encode("other-secret-0123456789abcdef"));
    expect((await verifier.verify(token)).ok).toBe(false);
  });

  it("refuses an expired token", async () => {
    const token = await new SignJWT({ pickle_role: "user" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("pickle-dev")
      .setSubject("auth0|expired")
      .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 1800)
      .sign(key);
    expect((await verifier.verify(token)).ok).toBe(false);
  });

  it("refuses a wrong issuer", async () => {
    const token = await new SignJWT({ pickle_role: "user" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("someone-else")
      .setSubject("auth0|wrong-iss")
      .setIssuedAt()
      .setExpirationTime("15m")
      .sign(key);
    expect((await verifier.verify(token)).ok).toBe(false);
  });

  it("refuses a token without a subject", async () => {
    const token = await new SignJWT({ pickle_role: "user" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("pickle-dev")
      .setIssuedAt()
      .setExpirationTime("15m")
      .sign(key);
    const result = await verifier.verify(token);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe("auth.no_subject");
  });

  it("refuses garbage and empty strings", async () => {
    for (const token of ["", "not-a-jwt", "a.b", "a.b.c"]) {
      expect((await verifier.verify(token)).ok).toBe(false);
    }
  });
});
