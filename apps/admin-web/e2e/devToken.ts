import { createHmac } from "node:crypto";

/**
 * Mints a token the API's `DevTokenVerifier` (services/api/src/auth/tokens.ts)
 * accepts: HS256, issuer `pickle-dev`, `pickle_role` claim. That verifier only
 * exists in PICKLE_ENV development|test, so this token is useless against any
 * staging/production deployment by construction.
 */
const DEV_ISSUER = "pickle-dev";

function base64url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

export function mintDevToken(
  secret: string,
  subject: string,
  role: "user" | "admin",
  ttlSeconds = 15 * 60,
): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({
      pickle_role: role,
      iss: DEV_ISSUER,
      sub: subject,
      iat: now,
      exp: now + ttlSeconds,
    }),
  );
  const signature = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}
