# Runbook — Privacy Breach (P0)

Personal data, video, or consent state exposed to unauthorized parties, or
data used beyond its consent scope (e.g. analysis-consented video used for
training). **P0** — consent for analysis is separate from consent for
training, and any crossing of that boundary is a breach even with no external
exposure.

## Detection signals

- Failed assertions in the consent boundary tests:
  `pnpm --filter @pickle/database test` (role-separation integration tests
  `packages/database/test/roles.integration.test.ts` and
  `roles.destructive.integration.test.ts`).
- Red-team findings (`services/api/test/h27.redteam.integration.test.ts`).
- Reports of exported/leaked media URLs, or audit-log anomalies.

## 1. Halt rollout (`rollout_halted`)

Freeze all in-flight rollouts touching data paths: set `rolloutPercent` to the
current frozen value (or 0) on relevant flags via `PUT /v1/admin/flags/:key`
and hold any model bundle promotion (`PUT /v1/admin/model-bundles/:version`).

## 2. Disable the feature (`feature_disabled`)

Disable the leaking surface with its feature flag (`{"enabled":false}`). If
the leak is in media export/sharing, that includes the endpoints in
`services/api/src/modules/media/routes.ts` and
`services/api/src/modules/privacy/routes.ts` (`POST /v1/me/export`). If a
credential is implicated, rotate it immediately — see
`docs/RUNBOOK_CONSENT_DB_ROLES.md` §rotation for the database roles
(`pickle_app`, `pickle_worker`, `pickle_migrator`, `pickle_ro`).

## 3. Roll back (`rolled_back`)

Roll back the deployment or migration that introduced the exposure. Database
migrations live in `packages/database/migrations/` and are applied with
`pnpm db:migrate`; write a forward remediation migration rather than editing
applied migrations.

## 4. Preserve evidence (`evidence_preserved`)

```bash
psql "$DATABASE_URL" -c "SELECT * FROM audit_log ORDER BY 1 DESC LIMIT 500" > evidence/audit.txt
psql "$DATABASE_URL" -c "SELECT * FROM consent_record ORDER BY 1 DESC LIMIT 500" > evidence/consent_record.txt
```

Preserve API access logs for the exposure window and the exact object
keys/URLs exposed. Do NOT delete the exposed objects before capturing what
they were and who could access them.

## 5. Investigate (`investigating`)

- Establish scope: which users, which consent scopes, what data, what window.
- Verify the consent boundary still holds:
  `pnpm --filter @pickle/database test` and
  `pnpm --filter @pickle/capture-envelope test` (consent/envelope validation).
- Check whether any machine output or analysis-only data entered a training
  set; if so the affected training data must be quarantined and any model
  trained on it rolled back (see step 3).

## 6–7. Fix and validate

Fix the access-control or consent-scope defect, add a regression test at the
breached boundary, then run:

```bash
export PATH=~/.npm-global/bin:$PATH && pnpm typecheck && pnpm lint && pnpm format:check && pnpm test
```

## 8. Postmortem (`postmortem`)

`docs/postmortems/<incident-id>.md` must include the user-notification and
regulatory-notification decision with its justification, plus the scope
analysis. Attach with `attachPostmortem` before closing. User notification
and any regulatory reporting are external actions owned by whoever holds the
production credentials — the incident cannot be closed until the postmortem
records what was decided and done.
