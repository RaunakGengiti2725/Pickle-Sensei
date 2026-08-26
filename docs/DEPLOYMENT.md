# DEPLOYMENT

## Pipeline (CI: .github/workflows/ci.yml)

PR: format → lint → typecheck → full test matrix (unit + DB integration against a Postgres service container, sequential to share it) → fresh-DB migrate+seed → ML validator tests → mobile typecheck+jest (ubuntu; iOS build requires a macOS runner — add when runner budget exists).

main: same verification, then Docker builds for `services/api` and `services/media-worker` (Dockerfiles in each service). ECR push + `terraform plan` + staging deploy activate once AWS repo secrets are configured — the workflow documents the gate instead of pretending.

## Environments

- Local: docker-compose (Postgres/Redis/MinIO/ElasticMQ) or homebrew Postgres; `pnpm dev:api`; Metro + simulator for mobile (docs/LOCAL_DEVELOPMENT.md).
- Staging/production: `infra/terraform/envs/*` (VPC, ALB+ECS Fargate, RDS, Redis, S3+SQS+KMS+Secrets). Images injected by CI as signed ECR digests. Production promotion is a protected manual step.

## Runtime configuration

All secrets via environment/Secrets Manager (.env.example is the catalog). Hard rules encoded in the binaries:

- `PICKLE_ENV=production` ⇒ fixture vision provider construction throws; dev token verifier construction throws; OIDC config required at boot.
- Store billing endpoints stay typed-501 until credentials exist.

## Model release train (separate from app binary)

`PUT /v1/admin/model-bundles/:version` (audited) moves a signed bundle draft → canary(1%) → active with rollout percent; devices poll `GET /v1/catalog/model-bundle`. Rollback = previous version to `active`, regressed one to `retired`. Automatic rollback triggers (low-confidence rate, crashes, latency, score-distribution shift) wire into alarms in the observability stage.

## Mobile release

RN 0.87 New Architecture app in `apps/mobile` (npm-managed). iOS: `pod install` (UTF-8 locale required — see LOCAL_DEVELOPMENT), `xcodebuild` verified green in this repo. TestFlight/Play internal lanes: add fastlane once signing assets exist.
