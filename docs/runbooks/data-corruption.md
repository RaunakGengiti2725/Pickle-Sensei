# Runbook — Data Corruption (P0)

Stored data (session records, shot scores, consent state, labels, model
metadata) is wrong, inconsistent, or being destructively rewritten. **P0**
while corruption is spreading or irreversible — every write can widen the
blast radius, so mitigation comes before diagnosis.

## Detection signals

- Integrity check failures in DB integration tests:
  `pnpm --filter @pickle/database test`.
- Migration failures or partial application: `pnpm db:migrate` output and the
  `schema_migrations` table.
- Impossible values surfacing in the API or benches (e.g.
  `pnpm lab:dataset-report` on datasets, `pnpm lab:score-stability` on scores).

## 1. Halt rollout (`rollout_halted`)

Stop any deployment/migration in progress. Do not run `pnpm db:migrate` again
until the corruption mechanism is understood.

## 2. Disable the writing feature (`feature_disabled`)

Disable the feature flag for the surface performing the corrupting writes
(`PUT /v1/admin/flags/:key`, `{"enabled":false}`). If the writer is the media
worker, stop it (it is the `services/media-worker` process, started with
`pnpm --filter @pickle/media-worker start`). Jobs remain safely queued — the
queue requires explicit acks (`packages/queue/src/index.ts`), so unprocessed
work is not lost while the worker is down.

## 3. Roll back (`rolled_back`)

Roll back the deploy that introduced the corrupting write path. For schema
damage, restore from the most recent database backup/snapshot into a separate
instance first — never in place — then plan the repair as a forward migration
in `packages/database/migrations/` applied via `pnpm db:migrate`.

## 4. Preserve evidence (`evidence_preserved`)

Before any repair writes:

```bash
pg_dump "$DATABASE_URL" --format=custom --file=evidence/pre-repair.dump
psql "$DATABASE_URL" -c "SELECT * FROM schema_migrations ORDER BY 1" > evidence/schema_migrations.txt
psql "$DATABASE_URL" -c "SELECT * FROM audit_log ORDER BY 1 DESC LIMIT 500" > evidence/audit.txt
```

Snapshot a sample of corrupted rows alongside their expected values.

## 5. Investigate (`investigating`)

- Identify the corrupting writer via `audit_log` and application logs.
- Determine the corruption window and whether backups inside it are clean.
- Check downstream contamination: datasets exported from corrupted rows
  (`pnpm lab:dataset-report`), and any labels or training data derived from
  them. Corrupted machine output must never be promoted to gold labels.

## 6–7. Fix and validate

Repair via a forward migration with a row-count/consistency check inside the
same transaction. Validate:

```bash
export PATH=~/.npm-global/bin:$PATH && pnpm typecheck && pnpm lint && pnpm format:check
pnpm --filter @pickle/database test
pnpm test
```

Re-run `pnpm db:migrate` and `pnpm db:seed` against a fresh local database
(`docker-compose.yml` provides Postgres) to prove migrations replay cleanly.

## 8. Postmortem (`postmortem`)

`docs/postmortems/<incident-id>.md`; must enumerate every downstream artifact
(dataset versions, model bundles, evaluation reports) touched by the corrupt
window and their disposition. Attach with `attachPostmortem` before closing.
