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

## Bearer lifetime

The provider identity token IS the API bearer: `bootstrap.ts` returns it as
`apiSession.bearerToken` and `apiSession.ts` holds it in memory. There is no
backend token-exchange or refresh-session endpoint, so the bearer lives
exactly as long as the provider allows — Apple ID tokens expire after roughly
10 minutes, Google ID tokens after roughly 1 hour. Once expired, the edge
function's `signInWithIdToken` verification fails and EVERY authenticated
route answers 401 `The identity token could not be verified.` Sign-in is not
"done" when the bootstrap succeeds; every later request can be the first one
to hit an expired bearer.

Contract for an expired bearer (a 401 on a request that carried one):

- The 401 is an auth event, not a transient network error. The client must
  attempt exactly one recovery, never a blind retry with the same bearer:
  Google can mint a fresh ID token silently (`GoogleSignin.signInSilently()`,
  the same path `restoreGoogleSessionSilently` uses on cold start), then
  re-establish the API session and retry the request once. Apple has no
  silent path: clear the API session, set an actionable auth error
  ("Your sign-in expired — sign in again to keep syncing"), and route to the
  sign-in gate.
- Transports read the bearer from `getApiSession()` at request time rather
  than capturing it once at configuration.
- The sync outbox must not keep draining against a dead bearer: 401 pauses
  the retry loop until a fresh session is established. Retrying every 30 s /
  on foreground burns the backend per-IP auth-failure budget
  (`AUTH_FAILURE_LIMIT`) and can lock the user out of the recovery call.
- No screen may render a control whose only action re-runs the failed call
  with the same expired bearer (a "Try again" that cannot succeed dead-ends
  the user — App Review 2.1 / 4.2). The offered action is the recovery above.
- The auth store must not present a signed-in account (`error: null`) while
  the API session is known-expired.

The durable fix is a backend `/v1/auth/session` exchange that returns a
Supabase refresh token stored in Keychain/Keystore (`react-native-keychain`),
so cold starts and Apple users survive without re-authenticating.

Provider tokens live in memory only. On process restart a synced user must
authenticate again until that token-exchange/refresh-session endpoint and
native Keychain/Keystore storage are implemented. Guest mode has no server
token and remains explicitly local-only.
