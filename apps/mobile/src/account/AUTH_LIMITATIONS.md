# Account authentication boundary

The mobile bootstrap deliberately does not mint an API token or treat an Apple
user ID / Google subject as an app account ID. Apple and Google must return a
signed identity token; `/v1/account/bootstrap` verifies that bearer and returns
the canonical `app_user.id` UUID used by billing and training.

The current API has one `OIDC_ISSUER`, `OIDC_AUDIENCE`, and `OIDC_JWKS_URL`.
That safely supports one configured issuer at a time. It cannot safely accept
both Apple (`https://appleid.apple.com`) and Google
(`https://accounts.google.com`) identity tokens in the same deployment. A
production deployment must either:

1. put both providers behind one trusted identity broker and configure the API
   for that broker, or
2. extend the API to choose from an explicit allowlist of per-issuer JWKS and
   audiences before enabling both buttons.

Do not remove issuer/audience verification or infer the provider from
unverified JWT claims. Google also requires a web OAuth client ID so the native
SDK returns an ID token with the backend's configured audience. Apple requires
the backend audience to match the app/service identifier.

Provider tokens are spent exactly once: `/v1/account/bootstrap` exchanges the
Google/Apple ID token with Supabase Auth and returns a revocable Supabase
session (short-lived access token + rotating refresh token). The access token
is the only API bearer after bootstrap; `/v1/auth/refresh` rotates it and
`/v1/auth/logout` revokes every refresh token for the account server-side, so
sign-out (or a remote revocation) actually kills the application session
instead of waiting for the provider ID token's natural expiry.

All session material lives in memory only. On process restart a synced user is
restored via the provider's silent sign-in (Google) or must authenticate again
(Apple) until native Keychain/Keystore storage is implemented. Guest mode has
no server token and remains explicitly local-only.
