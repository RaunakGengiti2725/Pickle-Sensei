# Runbook — Analysis Queue Stall (P1)

Sessions are accepted but analysis results are not produced: jobs pile up in
the queue or in `analysis_job` without progressing. **P1** — a core workflow
is down, but nothing is spreading harm, so the required response is
evidence → investigate → fix → validate → postmortem (no forced
disable/rollback step; escalate to P0 if jobs are being _lost_ rather than
delayed, since that is data loss).

## Detection signals

- `analysis_job` rows stuck in non-terminal status:

  ```bash
  psql "$DATABASE_URL" -c "SELECT status, count(*), min(requested_at) FROM analysis_job GROUP BY status"
  ```

- Queue depth growing without matching completions. The queue abstraction is
  `packages/queue/src/index.ts` (`IJobQueue.size()`; SQS in cloud, in-memory
  in tests). For SQS, check `ApproximateNumberOfMessages` /
  `ApproximateNumberOfMessagesNotVisible` on the queue.
- The media worker (`services/media-worker`) not logging progress.

## 1. Preserve evidence (`evidence_preserved`)

```bash
psql "$DATABASE_URL" -c "SELECT id, status, failure_code, requested_at, started_at, finished_at FROM analysis_job WHERE finished_at IS NULL ORDER BY requested_at LIMIT 200" > evidence/stuck_jobs.txt
```

Capture worker logs and queue metrics for the stall window. Do NOT purge the
queue — unacked messages redeliver after the visibility timeout by design.

## 2. Investigate (`investigating`)

- Is the worker running? Restart it: `pnpm --filter @pickle/media-worker start`
  (locally; in cloud, restart the `services/media-worker/Dockerfile` container).
- Is a poison message crashing the worker in a loop? Look for the same job id
  with a climbing `attempt` count (`JobEnvelope.attempt`).
- Is the stall in the DB layer instead — e.g. jobs never picked up because of
  the analysis route's permit logic
  (`services/api/src/modules/analysis/routes.ts`)?
- Reproduce queue semantics locally: `pnpm --filter @pickle/queue test`
  (`InMemoryJobQueue.expireInFlight()` models visibility-timeout expiry).

## 3–4. Fix and validate

For a poison message: fix the handler defect; quarantine the offending
payload as evidence rather than deleting it. For a crashed/hung worker: fix,
redeploy, and watch depth drain. Validate:

```bash
export PATH=~/.npm-global/bin:$PATH && pnpm typecheck && pnpm lint && pnpm format:check
pnpm --filter @pickle/queue test && pnpm --filter @pickle/media-worker test
pnpm test
```

Confirm recovery with the same `analysis_job` status query — stuck rows should
be draining and new jobs finishing.

## 5. Postmortem (`postmortem`)

`docs/postmortems/<incident-id>.md`; must state how long users waited, whether
any job was lost (if so, the incident was mis-classified and the postmortem
must say so), and what alerting change makes the next stall page within
minutes. Attach with `attachPostmortem` before closing.
