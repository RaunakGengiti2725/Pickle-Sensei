# DEPLOYMENT

## Pipeline (CI: .github/workflows/ci.yml)

PR: format → lint → typecheck → full test matrix (unit + DB integration against a Postgres service container, sequential to share it) → fresh-DB migrate+seed → ML validator tests → mobile typecheck+jest (ubuntu; iOS build requires a macOS runner — add when runner budget exists).

main: same verification, then Docker builds for `services/api` and `services/media-worker` (Dockerfiles in each service). ECR push + `terraform plan` + staging deploy activate once AWS repo secrets are configured — the workflow documents the gate instead of pretending.

## Environments

- Local: docker-compose (Postgres/Redis/MinIO/ElasticMQ) or homebrew Postgres; `pnpm dev:api`; Metro + simulator for mobile (docs/LOCAL_DEVELOPMENT.md).
- Staging/production: `infra/terraform/envs/*` (VPC, ALB+ECS Fargate, RDS, Redis, S3+SQS+KMS+Secrets). Images injected by CI as signed ECR digests. Production promotion is a protected manual step.

## Runtime configuration

All secrets via environment/Secrets Manager (.env.example is the catalog). Database access uses least-privilege role separation: Terraform provisions per-role connection-URL secrets (`db-url-app`, `db-url-worker`, `db-url-migrator`, `db-url-readonly`) and injects `DATABASE_URL_APP`/`DATABASE_URL_WORKER` into the ECS tasks; in-database role provisioning, credential rotation, and the migration procedure are in docs/RUNBOOK_CONSENT_DB_ROLES.md (migrations run as a deliberate operator step with the migrator credential, never from service tasks). Hard rules encoded in the binaries:

- Production binaries contain no deterministic/demo vision provider. The dev token verifier cannot construct outside development/test, and OIDC config is required at boot.
- Store billing endpoints stay typed-501 until credentials exist.
- Cloud deep analysis stays typed-501 until a validated worker/model is deployed; it releases the reserved analysis permit and never returns a sample result.

## Model release train (separate from app binary)

`PUT /v1/admin/model-bundles/:version` manages a signed bundle's staged rollout; devices poll `GET /v1/catalog/model-bundle`. A scoring model is a separate audited release at `PUT /v1/admin/scoring-models/:shotType/:version/release` and is eligible only when the SHA-256-verified bundle is 100% active and the dataset snapshot, locked evaluation-report hash, coach-validation reference, releasing admin, and exact shot-config version are recorded. Fresh databases have zero active scoring models. Rollback retires the regressed release; canonical sync rechecks release eligibility.

## Mobile release

RN 0.87 New Architecture app in `apps/mobile` (npm-managed). iOS: `pod install` (UTF-8 locale required — see LOCAL_DEVELOPMENT), `xcodebuild` verified green in this repo. TestFlight/Play internal lanes: add fastlane once signing assets exist.
