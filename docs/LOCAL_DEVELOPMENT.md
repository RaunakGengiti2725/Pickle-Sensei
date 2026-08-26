# LOCAL DEVELOPMENT

## Prerequisites

- Node.js 20.x (`.nvmrc`-equivalent: `engines` in root package.json)
- pnpm 10.x (`corepack enable` or `npm i -g pnpm@10`)
- Docker Desktop (for PostgreSQL/Redis/MinIO/ElasticMQ) — optional for pure-package work

## Bootstrap

```bash
pnpm install
cp .env.example .env
```

## Local infrastructure

```bash
docker compose up -d postgres redis minio elasticmq
pnpm db:migrate
pnpm db:seed
```

`pnpm db:migrate` applies `packages/database/migrations/*.sql` transactionally with checksum verification. `pnpm db:seed` loads the catalog (8 shot types, 11 checkpoints), scoring model sm-v1 generated from `packages/scoring/src/config/v1.ts`, and clearly-labeled dev fixture drills. Both are idempotent.

## Everyday commands

```bash
pnpm lint          # eslint across the monorepo
pnpm format        # prettier write
pnpm typecheck     # strict tsc in every package
pnpm test          # vitest in every package
pnpm build         # currently typecheck (packages are consumed from source; see DECISIONS)
pnpm dev:api       # Fastify API on :3001 (tsx watch)
```

Smoke check the API:

```bash
curl -s localhost:3001/v1/health
```

## Database-backed tests

Integration tests are **skipped, visibly, never green-washed** unless a test database is provided:

```bash
docker compose up -d postgres_test
DATABASE_URL_TEST=postgres://pickle:pickle_test_password@localhost:5433/pickle_test pnpm --filter @pickle/database test
```

CI always runs them against a service container (`.github/workflows/ci.yml`).

## Environment conventions

- `PICKLE_ENV`: development | test | staging | production. The FixtureVisionProvider refuses to construct when this is `production`.
- Secrets: never committed; `.env.example` holds placeholders and non-secret local defaults only. Production secrets live in AWS Secrets Manager (infra stage).

## Repo layout

See `docs/ARCHITECTURE.md`. Packages export TypeScript source directly (internal-only); nothing here is published to npm.
