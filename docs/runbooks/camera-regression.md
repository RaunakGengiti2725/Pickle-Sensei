# Runbook — Camera / Capture Regression (P1)

A mobile release or model change breaks capture: setup guidance loops, capture
never locks, envelopes fail validation, or uploads are rejected. **P1** — new
sessions are blocked for affected users. Escalate to **P0** if bad captures
are being _accepted_ and scored confidently (that is confident-wrong-coaching
territory — switch to
[confident-wrong-coaching.md](./confident-wrong-coaching.md)).

## Detection signals

- Spike in capture-envelope validation failures
  (`packages/capture-envelope/src/f18ValidationCriteria.ts` criteria; tests in
  `packages/capture-envelope/test/`).
- Users stuck in camera setup states (`CAMERA_SETUP_STATES` in
  `packages/shared-types/src/states.ts` — e.g. `NO_PLAYER`, `BAD_CAMERA_ANGLE`,
  `CAMERA_INTERRUPTED`) at anomalous rates.
- Session creation succeeding but media upload/processing failing
  (`services/api/src/modules/media/routes.ts`, `services/api/src/modules/sessions`).

## 1. Preserve evidence (`evidence_preserved`)

- Capture the failing envelope payloads and their validation failure reasons.
- Record exact app version, OS version, and device model distribution of
  affected sessions.
- Snapshot current flag and bundle state, since capture behavior is gated:

  ```bash
  psql "$DATABASE_URL" -c "SELECT key, enabled, rollout_percent FROM feature_flag" > evidence/feature_flag.txt
  psql "$DATABASE_URL" -c "SELECT version, status, rollout_percent FROM model_bundle" > evidence/model_bundle.txt
  ```

## 2. Investigate (`investigating`)

- If the regression shipped behind a flag or model bundle, mitigate first:
  disable the flag (`PUT /v1/admin/flags/:key`, `{"enabled":false}`) or freeze
  the bundle (`PUT /v1/admin/model-bundles/:version` with `rolloutPercent: 0`).
  Note it in the incident timeline. If the regression is in a shipped app
  binary with no flag, mitigation requires an expedited store release —
  record that as an external dependency on the incident.
- Reproduce locally:

  ```bash
  cd apps/mobile && npx tsc --noEmit && npm test
  pnpm --filter @pickle/capture-envelope test
  pnpm --filter @pickle/vision-geometry test
  ```

- Bisect against the last known-good mobile commit; capture logic and setup
  states are documented in `docs/CAMERA_EXPERIENCE.md` and
  `docs/CAPTURE_EVIDENCE.md`.
- Physical-device behavior (thermals, specific camera modules) cannot be
  proven on this box — treat simulator/unit evidence as partial and say so in
  the incident record rather than claiming device coverage.

## 3–4. Fix and validate

```bash
export PATH=~/.npm-global/bin:$PATH && pnpm typecheck && pnpm lint && pnpm format:check
cd apps/mobile && npx tsc --noEmit && npm test
pnpm --filter @pickle/capture-envelope test && pnpm test
```

Add a regression test at the failing envelope/setup-state boundary before
declaring `validating` complete.

## 5. Postmortem (`postmortem`)

`docs/postmortems/<incident-id>.md`; must cover why device/OS coverage in
pre-release testing missed the regression and which capture-envelope
validation or CI gate is added so the same class is caught pre-rollout.
Attach with `attachPostmortem` before closing.
