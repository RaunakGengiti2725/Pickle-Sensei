# P0 Security Incident Containment Runbook

Scope: a confirmed or strongly suspected P0 security incident against the
Pickle Sensei API or data stores — credential compromise, privilege
escalation, consent-ledger tampering, media exfiltration, or an admin
surface behaving unexpectedly.

Detection sources: the typed security events emitted by
`services/api/src/lib/securityEvents.ts` (`auth_anomaly`, `authz_denial`,
`admin_anomaly`, `upload_abuse`, `rate_limit_trip`, `media_access_failure`,
`db_privilege_anomaly`, `consent_mutation_denied`,
`training_eligibility_change`), the `api_failure` telemetry slice
(401/403/5xx), and the DB-role certification suite
(`docs/RUNBOOK_CONSENT_DB_ROLES.md`).

Order of operations is fixed: **contain → preserve evidence →
disable/rollback → patch → verify → postmortem**. Do not patch before
evidence is preserved — a redeploy destroys process state and log buffers
that attribution depends on.

## 1. Contain

Goal: stop the bleeding without destroying state.

- Identify the blast radius from the security events: which `kind`, which
  route templates, which time window, which request ids.
- Revoke or suspend the implicated credential at the identity provider
  (OIDC subject suspension), not by editing the database. The
  `requireAdmin` allowlist (`ADMIN_AUTH_SUBJECTS`) can be emptied to freeze
  all admin access immediately — admin routes then refuse every token.
- For upload abuse or media exfiltration: tighten the rate-limit budgets
  (`RateLimitConfig.expensiveLimit`) and/or disable presigned-URL issuance
  by unsetting the object-store configuration (`media.storage_unconfigured`
  is a typed, honest failure — clients degrade gracefully).
- For a suspected DB credential compromise (`db_privilege_anomaly` events):
  rotate the API role password and terminate existing sessions
  (`pg_terminate_backend`), in that order.
- Do NOT delete data, truncate tables, or "clean up" anything yet.

## 2. Preserve evidence

Goal: an immutable copy of everything attribution and scope analysis needs.

- Export the structured API logs (security events, `api_failure` telemetry,
  access logs keyed by `x-request-id`) for the incident window to
  write-once storage before any redeploy.
- Snapshot the database (point-in-time or `pg_dump`) BEFORE any schema or
  data remediation. The consent ledger is append-only by trigger; verify
  the trigger is still installed and include `consent_record`,
  `consent_subject`, `audit_log`, and `ml_training_consent` in the snapshot.
- Record object-store access logs for implicated media keys.
- Capture the running deploy's exact revision (image digest / git SHA) and
  environment configuration (minus secret values).
- Start an incident timeline document immediately; every action below gets
  a timestamped entry with the operator's name.

## 3. Disable / rollback

Goal: remove the attacker's foothold and return to a known-good state.

- Roll the API back to the last known-good revision if the incident
  involves a bad or compromised deploy.
- Disable the implicated feature flags or routes; prefer a typed 503/501
  envelope over silent removal so clients fail honestly.
- Rotate every secret the compromised surface could read: DB credentials,
  object-store keys, `DEV_AUTH_SECRET` (must never exist in production —
  its presence there is itself a finding), consent-export signing keys.
- If consent data was mutated by the attacker: do not rewrite ledger rows
  (the ledger is append-only). Append corrective entries and mark affected
  subjects' training eligibility as ineligible pending review. Any training
  artifacts derived from tainted consent are quarantined, not shipped.

## 4. Patch

Goal: fix the root cause, minimally and reviewably.

- Write a failing test that reproduces the exploit path first; the patch is
  not done until that test passes and the pre-existing security/consent
  suites (`consent.redteam`, `media-redteam`, `security-hardening`,
  `db-cert`) still pass.
- Patch on a fresh branch with review from someone who did not write the
  patch. No force-pushes, no history rewrites on the incident branch.
- Never weaken existing gates, redaction rules, or the append-only ledger
  trigger as part of the fix.

## 5. Verify

Goal: prove the hole is closed and nothing else regressed.

- Re-run the full API test suite plus the security/consent suites against
  the patched build.
- Replay the recorded exploit request (sanitized) against staging and
  confirm the typed failure envelope plus the expected security event.
- Confirm rotated credentials work and the old ones are dead (a login with
  a revoked credential must produce an `auth_anomaly` event, not a 200).
- Re-run the DB-role certification to confirm least-privilege grants are
  intact.
- Monitor the security-event stream for the incident's `kind`s at elevated
  attention for at least one week after the fix ships.

## 6. Postmortem

Goal: institutional memory, not blame.

- Blameless postmortem within 5 business days: timeline, root cause,
  detection gap (which event kind fired, which should have fired sooner),
  time-to-contain, and user/data impact.
- Every detection gap becomes a typed security event or test in the same PR
  as the postmortem, or a tracked issue with an owner.
- If user data was affected, the disclosure decision is made explicitly and
  recorded — silence is a decision and must be written down as one.
- File negative results honestly: if the root cause is unknown, the
  postmortem says so rather than inventing a narrative.
