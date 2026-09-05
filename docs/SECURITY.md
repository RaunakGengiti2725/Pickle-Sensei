# SECURITY

This overview covers the shipping React Native app in `apps/mobile` and the Supabase Edge Function in `supabase/functions/api`. The Fastify API, its database package, and the AWS infrastructure describe a separate legacy implementation. Their configuration is not evidence of production deployment.

## Identity and sessions

- Apple/Google bootstrap exchanges a provider ID token through Supabase Auth and returns an access/refresh session. Subsequent app requests use the Supabase access token; a transitional provider-token path remains for older builds.
- The app stores the refresh token and account descriptor in the device Keychain/Keystore, with device-only accessibility. Access and provider tokens stay in memory, not SQLite. Long-lived clients resolve the current bearer per request.
- The session keeper renews against receipt-based monotonic deadlines, uses relative lifetimes when available, and backs off on transient failures and unusable legacy expiry estimates. Foreground events cannot bypass network backoff. Only a definitive refresh-token refusal should implicitly sign the player out.
- A credential-free logout-intent marker and serialized vault tombstone fallback prevent failed credential cleanup from restoring the account just signed out of. If both storage channels fail, the app keeps the run blocked and warns before closing; durable restart safety is not then established.
- Logout requests `scope=local`, preserving other devices' sessions. Supabase access JWTs can remain valid until their `exp`; removing a refresh session or an Edge cache entry does not establish immediate access-token revocation. Other isolates can retain their own L1 cache entries. See [Supabase's sign-out semantics](https://supabase.com/docs/guides/auth/signout).
- Verification caches have finite lifetimes bounded by token expiry. Production JWT settings, cross-instance revocation timing, and deployment parity need separate evidence; a mocked Auth server cannot prove them.

## Authorization and input boundaries

- Authenticated Edge routes use a user-scoped Supabase client, so database RLS applies. Service-role access is limited to server-owned billing, audit, external-credential, and account-administration operations.
- Supabase migrations define owner policies, column-level write grants, append-only ledgers, and restricted function execution. Applied migration history must remain unchanged; fixes use new migrations.
- Rate limits cover pre-auth IP traffic, authentication failures, and per-user routes. Optional Upstash Redis shares state across instances; the fallback is per-isolate, not a distributed limit.
- The Edge function validates request shape and size and sanitizes free text. Server failures return generic public bodies. Logs must not contain credentials or private media.
- The RLS matrix checks both permitted owner operations and denied operations. Coverage is bounded by its cases; a passing matrix is not an exhaustive security claim.

## Billing and free ratings

- The backend verifies RevenueCat subscriber state rather than accepting premium claims from the client or webhook body. Only server credentials write `billing_entitlements`.
- Webhooks require the configured authorization secret. Duplicate delivery, upstream failures, and entitlement expiry belong in regression coverage.
- Two lifetime free ratings follow the sign-in identity, including after deletion and recreation. The service-only identity ledger has no account foreign key and retains no email or name. Its retention is disclosed in the privacy policy and deletion flow.
- Reservations and scored-shot sync use database accounting. Abstentions release their reservation; they do not spend a successful rating. Concurrency checks must use independent database connections, not only sequential SQL.
- StoreKit purchases and restores begin only after an explicit button press. iOS uses the App Store configuration; Android's Test Store configuration is not evidence of production Play billing.

## Local data and media

- Structured local data is owner-partitioned. Account switching must not adopt another owner's pending analysis, clip, outbox item, or response.
- Clips and pose sidecars live in the app container. Readers account for iOS container relocation and verify sidecar hashes before drawing recorded pose evidence.
- A checksum detects a byte mismatch; it is not an authenticated signature or proof of athlete identity, camera view, or coaching validity.
- Account deletion must remove the deleted owner's local media as well as database rows, preserve other owners' references, and report cleanup failures. Missing files should make retries idempotent; paths outside the capture store must not be deleted. A lost confirmation response leaves the server outcome unknown and must not produce a false “nothing was deleted” claim.
- Native filesystem protections, backup behavior, capture lifecycle, and physical-device resource limits need native verification. Simulator or JavaScript tests alone do not establish them.

## Release and operational evidence

`./supabase/tests/run_rls_tests.sh` runs against a disposable local PostgreSQL instance. Mobile verification uses `npx tsc --noEmit`, `npx jest --silent`, and `npm run check:distribution` from `apps/mobile`. Root CI also checks formatting, lint, workspace types, tests, migrations/seed, and Python validators.

The Edge test suites live in `supabase/functions/api/__wf__`. Test harnesses must use synthetic local services and must not inherit production endpoints or secrets. Historical tests that mirror old implementations are not evidence of current behavior; prefer regressions exercising the actual handler.

Dependency advisory results need installed-version and runtime-reachability analysis. Do not downgrade React Native, disable validation, or bypass release/security controls merely to make a scanner green.

Hosted settings, backups and restore tests, secrets, webhook configuration, App Store products, receipt behavior, and live deployment parity remain separate verification tasks. Static distribution checks are not App Review approval, legal certification, or a guarantee against compromise.
