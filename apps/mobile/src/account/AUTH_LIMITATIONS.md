# Account authentication boundary

The shipping app uses the Supabase Edge Function in `supabase/functions/api`, not the single-issuer OIDC server in `services/api`. Both Apple and Google are supported. Provider subjects are not app account IDs: bootstrap returns the verified canonical account UUID used by local ownership, billing, and synchronization.

## Bootstrap and verification

`POST /v1/account/bootstrap` exchanges the signed provider identity token through Supabase Auth's `id_token` grant. Decoding an issuer selects the verification path; it does not authenticate the caller. Supabase verifies the signature, issuer and configured audience. Google requires the configured web OAuth client ID; Apple's audience must match the app/service configuration.

Bootstrap returns the account and `session { accessToken, refreshToken, expiresAt, expiresIn }`. The relative lifetime is optional for compatibility with older servers. Normal application requests use the **Supabase access token**. The Edge handler verifies uncached access tokens through `/auth/v1/user` and creates a user-scoped database client, preserving RLS. Only valid verification is cached, with expiry bounds.

Bootstrap has a separate budget of 30 attempts per IP per aligned minute, including valid exchanges. Shared-NAT users can receive a retryable 429 at that boundary. Access-token requests and refresh have separate route budgets.

## Durable sign-in

`sessionVault.ts` stores the refresh token and account descriptor in Keychain/Keystore using `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`. Access tokens and provider tokens remain in memory; credentials do not go into SQLite. Secure-store operations are serialized, and ownership/generation checks prevent an old write or cleanup from replacing a newer account's record.

`POST /v1/auth/refresh` rotates the token pair. `sessionKeeper.ts` uses receipt-based monotonic deadlines, checks on foreground, and retries transient failures with backoff. Relative lifetimes protect renewal from a skewed device clock. Legacy responses that still appear expired use a conservative cooldown rather than a refresh loop; current-token 401 recovery remains available. A failed secure write retries persistence of the received pair rather than discarding the session. Cold-launch restoration can continue with cached owner-scoped data while the network request remains pending.

An access-route 401 requests refresh; it is not itself permission to sign the player out. Only a definitive refresh-token refusal, represented as 401/403, ends a durable session. Network errors, timeouts, 429 responses and 5xx responses remain retryable. The Edge function does not classify an unknown upstream response as revoked credentials, and transient failures do not charge `AUTH_FAILURE_LIMIT`.

Long-lived clients resolve the current bearer with `bearerTokenFor(canonicalAppUserId)` for each request. They must not capture a token at construction or reset their stores on rotation. Analysis supplies an owner-bound `resolveApiToken` callback, so reservation and release follow rotation during lengthy extraction or inference. Static legacy inputs retain their entry snapshot. A drain invalidated by an owner/generation change discards its late outcome without modifying the old queue's retry history; the next legitimate session can replay it idempotently.

A canonical owner with no local profile must fetch its server profile before the app decides that onboarding is missing. An unavailable bearer produces a retryable profile state, not a fresh questionnaire. Arrival of the matching API session triggers profile recovery without rehydrating on every token rotation. A loaded same-owner profile stays available during this work, preserving navigation and active capture. Pending onboarding answers remain pending until a canonical save can succeed.

## Sign-out and deletion

Explicit sign-out clears local session state and requests `POST /v1/auth/logout` with `scope=local`. A credential-free `auth.logout-intent` marker and an in-run latch block stale-vault restoration when secure deletion fails. A vault tombstone provides a serialized fallback when the marker cannot be written. Retry completes cleanup instead of restoring the account; explicit sign-in removes the block only after safe persistence. If both storage channels fail, the app keeps the run blocked and warns the player to retry before closing; restart safety cannot then be guaranteed. An in-flight rotation is handed to the revocation path so logout can use the resulting pair without reinstalling it. Other devices' sessions are not intentionally revoked.

Access JWTs can remain valid until their `exp`. Cache eviction is not global JWT revocation; other Edge isolates may retain L1 entries. See [Supabase sign-out semantics](https://supabase.com/docs/guides/auth/signout). GoTrue's active-child replay exception can recover a lost refresh response; a timeout alone does not establish that the refresh token is unusable. Persistent storage failure or credential loss can still require an explicit sign-in.

Account deletion captures `captureAccountDeletionScope()` before the challenge request and passes that scope to `completeAccountDeletion`. An old account's response must not clear a new account's credentials, SDK state or files. Stored Apple credentials are revoked even when Google is the account's primary provider. On-device media cleanup precedes owner-row purge; genuine cleanup failures retain references and surface the documented recovery notice. A lost confirmation response leaves the server outcome unknown. The client must not claim that nothing was deleted or treat that failure as a confirmed local-purge instruction.

## Compatibility and limits

Older builds may still send a provider ID token on application routes. The Edge handler retains that transitional path; the legacy Google silent-restore flag is a fallback for installations predating the vault. It is not the normal durable-session strategy. Do not remove compatibility until supported app-version evidence permits it.

Guest mode remains local-only. A secure-store read failure is distinguishable from an empty store and has an explicit in-app retry. Filesystem, Keychain, OS suspension and provider/store dialogs require native validation in addition to unit tests. Static checks and fake Auth services do not prove hosted configuration, live revocation timing, or App Review approval.
