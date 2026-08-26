# PRIVACY

Architecture, not a settings page (directive §34, spec pp. 39–40).

## Positioning

"Your court video stays on your phone unless you choose to sync it." Local-first is the default media path; it reduces breach exposure and cloud cost.

## Separated consents (implemented)

| Consent                  | Mechanism                                                                                                                                                                                                  |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Terms/privacy acceptance | `user_consent` rows (type, version, granted, source, timestamp)                                                                                                                                            |
| Cloud video sync         | `user_setting.cloud_sync_enabled`; every toggle also writes a `user_consent` row; **`POST /v1/media/uploads` refuses (403) without it — enforced and integration-tested**                                  |
| Analytics                | `user_setting.analytics_opt_out`                                                                                                                                                                           |
| ML training              | `ml_training_consent` (granted/terms version/granted_at/revoked_at) via `PUT /v1/me/ml-training-consent`; revocation flags all the user's `ml_dataset_item` rows and queues a dataset review task (tested) |
| Social visibility        | `user_setting.social_visibility` (private excludes user from leaderboards — enforced in the leaderboard query)                                                                                             |

## User rights (implemented)

- Export: `POST /v1/me/export` — full structured bundle (profile, settings, consent history, goals, sessions, shots incl. version vectors, achievements), audited. Tested.
- Deletion: `DELETE /v1/me` — workflow per directive §58: access revoked immediately (tested), social rows removed, media marked + purge queued, ML dataset review queued, IdP revocation queued (visibly blocked until credentials configured), final hard delete only after prior tasks complete (worker-tested). Deleted accounts cannot re-bootstrap (410, tested). Only `audit_log`/billing records retained.
- Individual video deletion: `DELETE /v1/media/:id` → queued object purge (worker-tested).

## Prohibitions (architecture-level)

No face recognition. No identity from gait/body geometry. No ad profiles from video. No third-party ad SDKs in the camera experience. No default training-data reuse. Raw video/body-motion data treated as sensitive regardless of jurisdictional classification. No sale/share of video or body-motion data for cross-context advertising.

## Teen defaults (13+ launch)

Private profile default (`profile_public=false`), friends-only social visibility default, no public location, no precise court location in shares, discovery by handle only (no phone/email lookup; friend-request endpoint responds identically for missing handles to block enumeration).

## Retention

Spec p. 39 table implemented as S3 lifecycle rules (30-day raw clips w/ keep-tag override, 14-day share intermediates) + `media_asset.expires_at` + deletion workflow. Local device clips: user-controlled indefinitely.
