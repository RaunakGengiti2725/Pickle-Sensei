# Runbook — Confident Wrong Coaching at Scale (P0)

High-confidence, incorrect coaching advice reaching a non-trivial share of
active users. Every extra minute of operation delivers more wrong advice, so
this is **P0**: the full mitigation chain (halt → disable → rollback →
preserve → investigate → fix → validate → postmortem) is mandatory and
order-enforced by `packages/incident-response/src/stateMachine.ts`.

## Detection signals

- Coach reports or user reports of wrong advice delivered with high confidence.
- Release-gate or bench regression discovered after a rollout:
  `pnpm lab:stroke-bench`, `pnpm lab:coach-gates`, `pnpm lab:score-stability`.
- Monitoring on scoring/coaching endpoints (`services/api/src/modules/shots`,
  `services/api/src/modules/analysis`).

## 1. Halt rollout (`rollout_halted`)

Freeze the model bundle rollout at its current percentage (or drop it) via the
admin API — `PUT /v1/admin/model-bundles/:version` in
`services/api/src/modules/admin/routes.ts`:

```bash
curl -X PUT "$API_URL/v1/admin/model-bundles/<version>" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"manifestSha256":"<existing sha>","status":"canary","rolloutPercent":0}'
```

Also freeze any feature-flag rollout that gates the coaching surface:

```bash
curl -X PUT "$API_URL/v1/admin/flags/<flag_key>" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"rolloutPercent":0}'
```

## 2. Disable the feature/model (`feature_disabled`)

Disable the coaching feature flag entirely (`PUT /v1/admin/flags/:key` with
`{"enabled":false}`). Flag evaluation is server-side
(`services/api/src/modules/flags/routes.ts`), so clients stop receiving the
feature on their next `/v1/flags` fetch without an app release.

## 3. Roll back (`rolled_back`)

Set the offending model bundle to `retired` and restore the previous bundle to
`status:"active", rolloutPercent:100` via `PUT /v1/admin/model-bundles/:version`.
Scoring model releases are pinned to bundles
(`PUT /v1/admin/scoring-models/:shotType/:version/release`); re-release the
previous known-good scoring model version if it was advanced.

## 4. Preserve evidence (`evidence_preserved`)

Before anything else mutates state, capture:

```bash
psql "$DATABASE_URL" -c "SELECT version, status, rollout_percent FROM model_bundle" > evidence/model_bundle.txt
psql "$DATABASE_URL" -c "SELECT key, enabled, rollout_percent FROM feature_flag" > evidence/feature_flag.txt
psql "$DATABASE_URL" -c "SELECT * FROM audit_log WHERE action LIKE 'admin.model_bundle%' OR action LIKE 'scoring_model%' ORDER BY 1 DESC LIMIT 200" > evidence/audit.txt
```

Keep the offending model artifact and manifest (hashes are in
`model_bundle.manifest_sha256`) and a sample of affected sessions/shot scores.
Record each artifact with `addEvidence`.

## 5. Investigate (`investigating`)

- Reproduce on the bench: `pnpm lab:stroke-bench`, `pnpm lab:coach-gates`,
  `pnpm lab:silent-retro` against the offending version.
- Diff the model registry state (`packages/model-registry/src/registry.ts`)
  and the release audit trail to find what changed and when.

## 6–7. Fix and validate (`fix_in_progress`, `validating`)

Fix forward or keep the rollback. Validation requires the root gates plus the
coaching benches:

```bash
export PATH=~/.npm-global/bin:$PATH && pnpm typecheck && pnpm lint && pnpm format:check && pnpm test
pnpm lab:stroke-bench && pnpm lab:coach-gates && pnpm lab:score-stability
```

Do not weaken or retune any frozen gate or locked holdout to make validation
pass.

## 8. Postmortem (`postmortem`)

Write `docs/postmortems/<incident-id>.md`, attach it with `attachPostmortem`,
then close. Must answer: why did the release gates not catch this before
rollout, and which gate is being added/strengthened so they do next time.
