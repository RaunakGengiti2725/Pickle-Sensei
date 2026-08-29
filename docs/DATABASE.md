# DATABASE

PostgreSQL 16. Current migration head: `0014`. Migrations live in `packages/database/migrations/*.sql` and are applied by the in-repo runner (`src/migrate.ts`) — ordered files, one transaction each, checksum-locked history (edit-after-apply fails loudly; write a new migration).

## ERD (ownership view)

```
app_user 1─1 user_profile / user_setting / ml_training_consent
app_user 1─n user_device, user_consent, user_goal, practice_session, shot,
             analysis_job, media_asset, weekly_report, notification,
             billing_subscription, entitlement, user_achievement, share_card

catalog:   shot_type, checkpoint_definition, drill ─ drill_checkpoint_map,
           pro_reference, achievement
scoring:   model_bundle ─ scoring_model ─ scoring_model_checkpoint
                                        └ scoring_target
per-shot:  shot ─ shot_phase (6 phases)
                ─ shot_metric (raw measurements + confidence + source)
                ─ shot_checkpoint_score (score/band/direction/severity)
sessions:  practice_session ─ shot; practice_session 1─1 session_summary
progress:  progress_daily (PK user/day/shot_type/checkpoint/scoring_model)
social:    friendship (requester/addressee + status), share_card
ml data:   ml_dataset_item (consent_version, provenance, split)
ops:       idempotency_record, audit_log, schema_migrations
```

## Key design rules

- **UUID PKs**; `shot.id` and `practice_session.id` are **client-generated** for offline-first sync; server upserts idempotently.
- **Version integrity**: `shot.version_vector` (JSONB, validated at API boundary) + `shot.scoring_model_id` + `shot.model_bundle_version` columns. Historical scores are never rescored in place (spec p. 22). `progress_daily` and `weekly_report` are scoring-model-version aware — no cross-version trend math without explicit normalization.
- **Release integrity (migration 0013)**: seeded scoring configs remain validating hypotheses, and a fresh database has zero active scoring models. Release requires an audited admin action at `PUT /v1/admin/scoring-models/:shotType/:version/release` with a 100%-active model bundle whose manifest passes SHA-256 validation, a dataset snapshot, locked evaluation-report hash, coach-validation reference, releasing admin, and the exact shot-config version. Canonical score sync rejects anything else.
- **Replay integrity (migration 0014)**: every newly accepted shot stores the server-computed SHA-256 of its schema-normalized sync payload. A durable outbox may replay that exact payload after its model retires; a reused shot id with changed analysis data is rejected. Pre-0014 rows remain canonical but cannot claim an unprovable retry is exact.
- **Honest results**: `CHECK (result_kind='scored' AND overall_score IS NOT NULL OR result_kind='low_confidence' AND overall_score IS NULL)`. `shot.source` retains a legacy `fixture` enum value for migration/test compatibility, but production runtime and seeds create no fixture shots or UI content; release data is `real` only.
- **Frame data stays out of Postgres**: per-frame landmark tensors go to object storage as `media_asset(kind='features')`, referenced by `shot.feature_asset_id` (spec p. 13).
- JSONB only where flexibility is genuine: version vectors, report payloads, billing raw events, annotation metadata.

## Authorization & deletion

- Row-level authorization enforced in the service layer; possession of a UUID never grants access (spec p. 23).
- Account deletion is a **workflow** (directive §58), not one cascade: revoke access → mark `app_user.status='deleted'`/`deleted_at` → queue media purge (`media_asset.deleted_at`) → remove derived features → drop social rows → handle `ml_dataset_item` per `consent_version` provenance → revoke IdP account → retain only narrowly justified `audit_log`/billing records. FK `ON DELETE CASCADE` exists as a final guarantee for hard-delete, but the workflow runs first.

## Retention (spec p. 39)

Raw cloud clips 30 days unless kept; derived analysis while account exists; share intermediates 7–30 days (`share_card.expires_at`, `media_asset.expires_at`); training data only with documented consent; local device clips user-controlled.

The mobile SQLite `local_capture.payload` stores the schema-validated native clip result, including its bounded pose-evidence summary and typed ball-speed availability. It is owner-scoped and deleted/exported with the local clip. The column is nullable only for captures created by older app versions; the UI labels those rows as legacy and never reconstructs evidence from neighboring metadata.

## Indexes

Hot paths indexed: shots by user/time and user/type/time, sessions by user/time, queue-state partial indexes on `analysis_job(status)`, consent lookup by user/type/time, friendship by addressee/status, audit by actor and action. Add indexes with query evidence, not speculation.

## Migration policy

Never edit an applied migration (checksum enforced). Forward-only; rollbacks are new migrations. Separate application vs migration DB roles in staging/production (infra stage). CI applies the full chain + seeds on a fresh database on every PR.
