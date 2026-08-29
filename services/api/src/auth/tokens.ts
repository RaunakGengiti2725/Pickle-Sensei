import { createRemoteJWKSet, jwtVerify, SignJWT } from "jose";
import type { Result } from "@pickle/shared-types";
import { fail, failure, ok } from "@pickle/shared-types";

/**
 * Token verification (spec pp. 22–23). OIDC access tokens verified against the
 * provider's JWKS. A dev HS256 issuer exists for local/test ONLY:
 *   - it requires PICKLE_ENV development|test AND DEV_AUTH_SECRET set;
 *   - constructing it in production throws;
 *   - no password handling anywhere — identity lives in the IdP.
 */

export interface VerifiedIdentity {
  authSubject: string;
  role: "user" | "admin";
}

export interface ITokenVerifier {
  verify(token: string): Promise<Result<VerifiedIdentity>>;
}

export class OidcTokenVerifier implements ITokenVerifier {
  private jwks: ReturnType<typeof createRemoteJWKSet>;
  constructor(
    jwksUrl: string,
    private issuer: string,
    private audience: string,
  ) {
    this.jwks = createRemoteJWKSet(new URL(jwksUrl));
  }

  async verify(token: string): Promise<Result<VerifiedIdentity>> {
    try {
      const { payload } = await jwtVerify(token, this.jwks, {
        issuer: this.issuer,
        audience: this.audience,
      });
      if (!payload.sub) {
        return fail(failure("auth_failed", "auth.no_subject", "Token has no subject."));
      }
      const role = payload["pickle_role"] === "admin" ? "admin" : "user";
      return ok({ authSubject: payload.sub, role });
    } catch (error) {
      return fail(
        failure("auth_failed", "auth.invalid_token", "Token verification failed.", error),
      );
    }
  }
}

export const DEV_ISSUER = "pickle-dev";

export class DevTokenVerifier implements ITokenVerifier {
  private secret: Uint8Array;

  constructor(env: string, secret: string | undefined) {
    if (env !== "development" && env !== "test") {
      throw new Error(
        "DevTokenVerifier must never be constructed outside development/test (directive §5).",
      );
    }
    if (!secret || secret.length < 16) {
      throw new Error("DEV_AUTH_SECRET (≥16 chars) is required for the dev token verifier.");
    }
    this.secret = new TextEncoder().encode(secret);
  }

  async verify(token: string): Promise<Result<VerifiedIdentity>> {
    try {
      const { payload } = await jwtVerify(token, this.secret, { issuer: DEV_ISSUER });
      if (!payload.sub) {
        return fail(failure("auth_failed", "auth.no_subject", "Token has no subject."));
      }
      const role = payload["pickle_role"] === "admin" ? "admin" : "user";
      return ok({ authSubject: payload.sub, role });
    } catch (error) {
      return fail(
        failure("auth_failed", "auth.invalid_token", "Token verification failed.", error),
      );
    }
  }

  /** Mint a dev token (tests + local tooling only — verifier is env-guarded). */
  async mint(subject: string, role: "user" | "admin" = "user"): Promise<string> {
    return new SignJWT({ pickle_role: role })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(DEV_ISSUER)
      .setSubject(subject)
      .setIssuedAt()
      .setExpirationTime("15m")
      .sign(this.secret);
  }
}

export function buildVerifier(env: {
  pickleEnv: string;
  oidcJwksUrl?: string | undefined;
  oidcIssuer?: string | undefined;
  oidcAudience?: string | undefined;
  devAuthSecret?: string | undefined;
}): ITokenVerifier {
  const oidcConfigured =
    env.oidcJwksUrl &&
    env.oidcIssuer &&
    env.oidcAudience &&
    !env.oidcJwksUrl.startsWith("__PLACEHOLDER");
  if (oidcConfigured) {
    return new OidcTokenVerifier(env.oidcJwksUrl!, env.oidcIssuer!, env.oidcAudience!);
  }
  if (env.pickleEnv === "production" || env.pickleEnv === "staging") {
    throw new Error("OIDC must be configured in staging/production; dev tokens are forbidden.");
  }
  return new DevTokenVerifier(env.pickleEnv, env.devAuthSecret);
}
