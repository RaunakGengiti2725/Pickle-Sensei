# SECURITY

Spec pp. 41–42 controls and their current state.

## Identity & access

- OIDC/OAuth only; API stores stable `auth_subject`, never passwords. Access tokens verified against provider JWKS (`OidcTokenVerifier`).
- Dev HS256 issuer exists strictly for development/test: constructor throws elsewhere; staging/production refuse to boot without real OIDC config (`buildVerifier` guard). Same guard philosophy as the fixture provider.
- Admin: separate `pickle_role=admin` claim; all admin reads/writes audited (`audit_log`); MFA enforcement belongs to the IdP configuration.
- Ownership checks on every private resource (`WHERE user_id = $me`); UUID possession grants nothing — integration-tested.
- No AWS credentials in mobile binaries; media access via short-lived signed URLs (300s downloads, 900s uploads).

## Application

- Input validation: Zod on every mutating route; unknown scoring-model versions rejected at sync.
- Idempotency: client-generated UUID PKs + `ON CONFLICT DO NOTHING` upserts; `idempotency_record` table for header-keyed replays (wire-up per route as mutations grow).
- Rate limiting: Redis infrastructure provisioned; limiter middleware pending (tracked NOT_STARTED — not silently assumed).
- Typed error envelopes everywhere; unhandled errors log server-side, return opaque 500.
- No secrets/tokens/signed URLs in logs (worker/api log lines carry ids only).

## Media

- Private S3, all public access blocked, SSE-KMS, TLS, random 48-hex object keys, MIME allowlist, 500MB cap, sha256 recorded at upload. Malware scanning: pending (tracked).

## Data

- RDS in private subnets, storage encrypted (KMS), 14-day backups + PITR, deletion protection (terraform). Separate app/migration roles: staging bootstrap task.
- Checksum-locked migrations — applied history cannot be silently edited.

## Model security

- `model_bundle.manifest_sha256` + status lifecycle + rollout percent + audited admin mutation = signed manifests, staged rollout, rollback, kill switch (set rollout 0 / status retired).

## Supply chain / CI

- ECR scan-on-push; CI: format/lint/typecheck/tests/migration checks. Dependency + secret scanning jobs: pending additions to CI (tracked).

## Billing honesty

- Store receipt validation returns typed 501 until Apple/Google server credentials exist. Entitlements only via verified store events or audited admin grants — never client-asserted.
