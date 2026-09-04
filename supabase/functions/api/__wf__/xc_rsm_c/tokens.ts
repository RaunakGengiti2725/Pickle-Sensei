// Token helpers shared by the fake Supabase and the request generator. These
// tokens are syntactically JWTs (three base64url segments) so the edge's
// issuer routing sees them the way it sees real ones; nothing here is signed.

export function b64url(value: string): string {
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const segments = token.split(".");
  if (segments.length !== 3) return null;
  try {
    const raw = segments[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = raw + "=".repeat((4 - (raw.length % 4)) % 4);
    const parsed = JSON.parse(atob(padded)) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export type IdTokenIssuer = "google" | "apple" | "other";

const ISSUERS: Record<IdTokenIssuer, string> = {
  google: "https://accounts.google.com",
  apple: "https://appleid.apple.com",
  other: "https://issuer.example.invalid",
};

/** A provider ID token. `expSeconds` is absolute unix seconds (may be in the
 * past to model an expired credential or a skewed client clock). `nonce`
 * makes otherwise-identical tokens hash to different cache keys. */
export function fakeIdToken(
  issuer: IdTokenIssuer,
  sub: string,
  expSeconds: number,
  nonce: string,
): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "xc" }));
  const payload = b64url(
    JSON.stringify({ iss: ISSUERS[issuer], sub, aud: "com.picklesensei", exp: expSeconds, nonce }),
  );
  return `${header}.${payload}.sig-${nonce}`;
}

/** Same payload as `token`, different signature — a forgery of a real access token. */
export function forgeSignature(token: string, nonce: string): string {
  const segments = token.split(".");
  if (segments.length !== 3) return `${token}.forged-${nonce}`;
  return `${segments[0]}.${segments[1]}.forged-${nonce}`;
}

/** Re-encode a Supabase-shaped access token with a different exp claim. The
 * fake Auth does not know this token, so it must be refused upstream; the edge
 * must refuse it before that if the new exp is in the past. */
export function withExp(token: string, expSeconds: number, nonce: string): string {
  const payload = decodeJwtPayload(token) ?? {};
  const segments = token.split(".");
  return `${segments[0]}.${b64url(JSON.stringify({ ...payload, exp: expSeconds }))}.tamper-${nonce}`;
}
