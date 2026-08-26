# API

Base: `/v1`. Contract source: `packages/api-contracts` (Zod → OpenAPI 3.1 at `GET /v1/openapi.json`). Headers (spec p. 17): `Authorization: Bearer <OIDC>`, `X-Client-Version`, `X-Model-Bundle-Version`, `X-Request-Id`, `Idempotency-Key` on mutating creations.

Errors: every failure is a typed envelope `{error: {kind, code, message, retryable, requestId}}`.

## Endpoint status

| Endpoint                                                                                                                                                                                                                                                                                                          | Status                                              |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| GET /v1/health                                                                                                                                                                                                                                                                                                    | IMPLEMENTED+TESTED                                  |
| GET /v1/openapi.json                                                                                                                                                                                                                                                                                              | IMPLEMENTED+TESTED                                  |
| GET /v1/catalog/shot-types                                                                                                                                                                                                                                                                                        | IMPLEMENTED (DB-backed; typed 503 without DB)       |
| GET /v1/catalog/checkpoints                                                                                                                                                                                                                                                                                       | IMPLEMENTED (DB-backed; typed 503 without DB)       |
| POST /v1/account/bootstrap                                                                                                                                                                                                                                                                                        | 501 typed (schema ready)                            |
| GET /v1/me                                                                                                                                                                                                                                                                                                        | 501 typed                                           |
| POST /v1/shots:sync                                                                                                                                                                                                                                                                                               | 501 typed (canonical payload schema ready + tested) |
| POST /v1/sessions                                                                                                                                                                                                                                                                                                 | 501 typed (schema ready)                            |
| Everything else in spec pp. 17–21 (goals, drills catalog, model-bundle, media uploads/complete/get/delete, analyses, sessions batch/finalize/detail, library, progress, weekly-reports, references, share-cards, friends, leaderboards, billing sync + webhooks, ml-training-consent, export, delete me, devices) | NOT_STARTED — tracked in IMPLEMENTATION_STATUS      |

## Rules already enforced in contracts

- Shot sync carries the full version vector; the server persists client scores verbatim and never recomputes them (spec p. 22).
- `resultKind: low_confidence` ⇒ `overallScore: null` representable end-to-end.
- Batch cap 200 shots per sync call.
- `source: real|fixture` travels with every shot.

## Auth plan (Stage 6)

OIDC access token verification via provider JWKS; stable `auth_subject` mapping to `app_user`; ownership checks on every private resource; admin routes on a separate privileged role + MFA. No dev-mode auth bypass will exist in production builds.
