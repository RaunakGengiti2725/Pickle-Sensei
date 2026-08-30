# Supabase as the Google/Apple authenticator for Pickle Sensei

The mobile app already implements the full sign-in flow
(`apps/mobile/src/auth/authStore.ts`): native Google Sign-In produces an
**ID token**, and the app POSTs it as a bearer to
`{apiBaseUrl}/v1/account/bootstrap` expecting a canonical account back.
This directory makes Supabase serve that contract:

- `migrations/20260829000000_google_auth_bootstrap.sql` — profiles table,
  signup trigger, RLS. **This is all the SQL there is**; enabling the Google
  provider itself is a Dashboard step (SQL cannot switch providers on).
- `functions/api/index.ts` — Edge Function implementing
  `POST /v1/account/bootstrap` (Google + Apple ID tokens).

## 1. Google Cloud Console (one time)

1. <https://console.cloud.google.com/apis/credentials> → _Create credentials →
   OAuth client ID_:
   - **Web application** → this is `GOOGLE_WEB_CLIENT_ID`
     (also used by Supabase to verify the token audience).
   - **iOS** → bundle ID `com.picklesensei` → this is `GOOGLE_IOS_CLIENT_ID`;
     note its **reversed** form (`com.googleusercontent.apps.…`).

## 2. Supabase Dashboard (one time, not SQL)

1. _Authentication → Sign In / Providers → Google_: toggle **ON**.
2. **Client IDs**: paste `GOOGLE_WEB_CLIENT_ID` **and** `GOOGLE_IOS_CLIENT_ID`
   (comma-separated). Both must be listed or `signInWithIdToken` rejects the
   audience of tokens minted for the iOS client.
3. Client secret: the web client's secret (needed only for browser OAuth;
   harmless to set).
4. (Apple, optional but recommended since the app ships Apple sign-in:
   _Providers → Apple_ → ON, Client ID = `com.picklesensei`.)

## 3. SQL

Paste `migrations/20260829000000_google_auth_bootstrap.sql` into the SQL
editor and run it — or link the repo and push:

```bash
supabase link --project-ref <YOUR_PROJECT_REF>
supabase db push
```

## 4. Deploy the bootstrap function

```bash
supabase functions deploy api --no-verify-jwt
```

`--no-verify-jwt` is required: the incoming bearer is a _Google/Apple_ ID
token, not a Supabase JWT; verification happens inside the function via
`auth.signInWithIdToken`.

## 5. Point the app at it (2 files)

1. `apps/mobile/src/config/runtimeConfig.ts`
   ```ts
   const API_BASE_URL = "https://<YOUR_PROJECT_REF>.supabase.co/functions/v1/api";
   const GOOGLE_IOS_CLIENT_ID = "<ios-client-id>.apps.googleusercontent.com";
   const GOOGLE_WEB_CLIENT_ID = "<web-client-id>.apps.googleusercontent.com";
   ```
2. `apps/mobile/ios/PickleSensei/Info.plist` — the `CFBundleURLTypes` entry
   already contains the placeholder
   `com.googleusercontent.apps.REPLACE-WITH-IOS-CLIENT-ID`; replace it with
   your reversed iOS client ID. Without this URL scheme the native Google
   flow cannot return to the app.

Then rebuild the iOS app (`pod install` not required for these edits).

## 6. Verify

```bash
supabase functions serve api --no-verify-jwt   # local smoke test
curl -X POST 'http://127.0.0.1:54321/functions/v1/api/v1/account/bootstrap' \
  -H 'Authorization: Bearer <real google id token>' \
  -H 'Content-Type: application/json' -d '{}'
# expect: {"user":{"id":"<uuid>","email":"…"},"onboardingState":"pending"}
```

In-app: Sign in with Google → should land signed-in; the `profiles` table
gains one row (Dashboard → Table editor).

## Honest limits

- The Edge Function serves **only** `/v1/account/bootstrap`. Every other
  `/v1/*` endpoint (sync, training, billing, consent…) still needs the real
  `services/api` deployment; until then those features stay in their typed
  "not configured/unavailable" states — same as guest mode today.
- `functions/api/index.ts` is Deno-targeted and is **not** compiled by the
  pnpm workspace; it has not been executed against a live project from this
  machine (UNVERIFIED-HERE). Use step 6 before trusting it.
