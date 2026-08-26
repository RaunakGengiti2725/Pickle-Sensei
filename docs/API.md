# API

Base `/v1`. Contract source: `packages/api-contracts` (Zod → OpenAPI 3.1 at `GET /v1/openapi.json`). Auth: OIDC bearer (dev issuer in dev/test only). Errors: typed envelope `{error:{kind,code,message,retryable,requestId}}` everywhere.

## Endpoint status

TESTED = covered by the integration suite against real PostgreSQL.

| Area            | Endpoints                                                                                                                                                | Status                                                                                     |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Health/contract | GET /v1/health · GET /v1/openapi.json                                                                                                                    | TESTED                                                                                     |
| Account         | POST /v1/account/bootstrap · GET /v1/me · PATCH /v1/me/profile · PATCH /v1/me/settings · PUT /v1/me/onboarding · POST /v1/devices                        | TESTED (device reg: IMPLEMENTED)                                                           |
| Goals           | POST/GET /v1/me/goals · PATCH /v1/me/goals/:id                                                                                                           | IMPLEMENTED (creation via onboarding TESTED)                                               |
| Catalog         | shot-types · checkpoints · drills (+detail, filters) · model-bundle · references                                                                         | TESTED (references: IMPLEMENTED)                                                           |
| Shots           | POST /v1/shots:sync (idempotent, version-validated) · GET /v1/shots/:id (+drill recommendation) · POST /v1/shots/:id/rating                              | TESTED (rating: IMPLEMENTED)                                                               |
| Sessions        | POST /v1/sessions · POST /v1/sessions/:id/shots:batch · PATCH · POST …/finalize (canonical summary + focus delta) · GET /v1/sessions/:id                 | TESTED                                                                                     |
| Library         | GET /v1/library/shots (filters+cursor) · GET /v1/library/sessions · POST …/favorite                                                                      | TESTED                                                                                     |
| Progress        | GET /v1/progress (model-version-aware series, improving/needs-attention) · GET /v1/progress/checkpoints/:slug · GET /v1/weekly-reports/latest (+history) | TESTED                                                                                     |
| Media           | POST /v1/media/uploads (consent-gated presign) · POST …/complete · GET /v1/media/:id (signed URL) · DELETE                                               | TESTED (consent gate + typed unconfigured-storage; presign path exercised without live S3) |
| Analysis        | POST /v1/analyses (free-quota-gated cloud deep, queued) · GET · POST …/cancel                                                                            | TESTED                                                                                     |
| Social          | POST /v1/friends/requests (handle-only, enumeration-safe) · accept · DELETE · GET /v1/friends · GET /v1/leaderboards/friends (visibility-aware)          | TESTED                                                                                     |
| Billing         | GET /v1/billing/offerings (DB-configured pricing) · apple/google sync + webhooks                                                                         | Offerings TESTED · store validation typed-501 until credentials (never faked)              |
| Privacy         | PUT /v1/me/ml-training-consent · POST /v1/me/export · DELETE /v1/me (workflow §58)                                                                       | TESTED                                                                                     |
| Flags           | GET /v1/flags (stable rollout hash)                                                                                                                      | TESTED                                                                                     |
| Achievements    | GET /v1/achievements                                                                                                                                     | IMPLEMENTED                                                                                |
| Share cards     | POST /v1/share-cards · GET /v1/share-cards/:id                                                                                                           | IMPLEMENTED (render job visibly queued; worker declines without ffmpeg)                    |
| Admin           | GET users/:id (audited) · PUT drills/:slug · PUT flags/:key · PUT model-bundles/:version · PUT users/:id/entitlements                                    | TESTED (drill/bundle upsert: IMPLEMENTED; entitlement grant TESTED)                        |

## Enforced invariants (tested)

- Server persists client scores verbatim with the full version vector; unknown scoring-model versions are rejected, never guessed.
- Idempotent everything offline-first touches: replayed sync batches accept without duplicates; session create by client UUID.
- Ownership: stranger with a valid token + your UUID gets 404.
- Cloud upload impossible without cloud-sync consent (403 before any storage code runs).
- Deleted account: access revoked immediately; re-bootstrap returns 410.
- Free tier: 3 cloud deep analyses/month; premium entitlement lifts it; deep jobs actually enqueue.
