# Incident Runbooks

Operational runbooks for the top failure classes. The severity taxonomy,
typed incident records, and required-response state machines they refer to
live in `packages/incident-response` (tests:
`packages/incident-response/test/stateMachine.test.ts`, run with
`pnpm --filter @pickle/incident-response test`).

## Severity taxonomy

| Severity | Meaning                                                                                                 | Ack within | Mitigate within | Postmortem |
| -------- | ------------------------------------------------------------------------------------------------------- | ---------- | --------------- | ---------- |
| P0       | Active harm: confidently wrong coaching at scale, privacy/consent breach, spreading data corruption     | 15 min     | 1 h             | Required   |
| P1       | Core workflow down or badly degraded (queue stall, capture regression, broken release gate)             | 1 h        | 4 h             | Required   |
| P2       | Contained degradation: narrow-slice quality regression, internal tooling, issue with a known workaround | 24 h       | 1 week          | Optional   |

Machine-readable source of truth: `packages/incident-response/src/severity.ts`.

## Required response sequences

Enforced by `packages/incident-response/src/stateMachine.ts` — steps cannot be
skipped or reordered, every step needs a note recording what was actually done,
and P0/P1 incidents cannot close without an attached postmortem document.

- **P0:** declared → rollout_halted → feature_disabled → rolled_back →
  evidence_preserved → investigating → fix_in_progress → validating →
  postmortem → closed
- **P1:** declared → evidence_preserved → investigating → fix_in_progress →
  validating → postmortem → closed
- **P2:** declared → investigating → fix_in_progress → validating → closed

Severity can only be escalated (P2 → P1 → P0), never lowered mid-incident.
Escalation preserves the timeline but re-derives the remaining required steps,
so mitigations skipped at the lower severity still have to happen.

## Runbooks

| Failure class                     | Runbook                                                      |
| --------------------------------- | ------------------------------------------------------------ |
| Confident wrong coaching at scale | [confident-wrong-coaching.md](./confident-wrong-coaching.md) |
| Privacy breach                    | [privacy-breach.md](./privacy-breach.md)                     |
| Data corruption                   | [data-corruption.md](./data-corruption.md)                   |
| Analysis queue stall              | [queue-stall.md](./queue-stall.md)                           |
| Camera / capture regression       | [camera-regression.md](./camera-regression.md)               |

## Conventions used in every runbook

- Root gates before declaring a fix validated:
  `export PATH=~/.npm-global/bin:$PATH && pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`
- Admin API calls require an admin session (`app.requireAdmin`); all mutations
  are recorded in the audit log by `audit()` in `services/api/src/lib/db.ts`.
- Evidence preservation means copying raw artifacts (DB rows, logs, queue
  messages, model manifests) to durable storage _before_ mitigation mutates
  them, and logging each artifact in the incident's evidence log
  (`addEvidence` in `packages/incident-response/src/incident.ts`).
- Postmortems live in `docs/postmortems/` and are referenced from the incident
  record via `attachPostmortem` before the incident can close.
