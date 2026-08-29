# Fresh-User Evidence Loop

The improvement loop for on-device analysis quality:

**build → fresh users → failures → label/review → root cause → improve →
frozen test → NEW fresh users**

Every cycle uses this exact order. The non-negotiable property: users who
have already seen the app are never reused as "fresh" evidence, and no
device-side verdict is ever treated as Gold.

## 1. build

Ship a TestFlight internal build (`docs/DISTRIBUTION.md`, Mac-only). Record
`appVersion` / model bundle versions — every trial carries them
(`packages/shared-types/src/evaluationTrial.ts`).

## 2. fresh users

Recruit users who have NEVER used the app. On first run they choose whether
to grant `evaluation_telemetry` consent (append-only server ledger, inactive
by default, separate from `model_training`). No consent → no telemetry; the
app works identically either way.

With consent, every analysis attempt — scored, quality-blocked, unavailable
— becomes one trial record: CLAIMS and abstentions only (target lock, event
selection, stroke label, contact marker, phase render, result score), never
correctness verdicts, never raw video. Trials queue in the device outbox and
upload to `POST /v1/me/evaluation/trials`, which re-verifies consent
server-side and stores them append-only.

## 3. failures

Export accepted trials and count what the device claimed vs. what humans
find. The six silent-failure event kinds are counted **explicitly, per
kind — never hidden behind an aggregate accuracy**:

| Event                          | Meaning                                                                       |
| ------------------------------ | ----------------------------------------------------------------------------- |
| `WRONG_TARGET`                 | locked onto the wrong player                                                  |
| `WRONG_EVENT`                  | analyzed the wrong swing/segment                                              |
| `WRONG_STROKE`                 | presented an incorrect stroke label                                           |
| `FALSE_CONTACT`                | presented a contact marker at a non-contact moment                            |
| `IMPOSSIBLE_PHASE`             | rendered a physically impossible phase sequence                               |
| `FALSE_HIGH_CONFIDENCE_RESULT` | presented a normal-confidence Result on a trial with a materially wrong claim |

User flags (`looks_wrong`, `wrong_player`, `wrong_stroke`, `wrong_moment`)
are triage hints, not labels.

## 4. label/review

Humans label each presented claim against the captured evidence:
`correct` / `wrong` / `abstained` / `unverifiable`. Labels carry a
`labelerId`; anonymous labels are rejected. Engineers may label mechanical
claims (target, event, contact, phase, stroke identity). **Technique
quality, fault diagnosis, and drill fit are GATE A territory: only real
qualified coaches, never engineers, never an LLM.** Machine-proposed labels
are Tier-C, never Gold.

Run the report:

```bash
pnpm lab:fresh-user-report trials.json labels.json report.json
```

(`packages/swing-lab/src/freshUserTrials.ts` — explicit per-event counts,
per-claim denominators, unlabeled counts, independence coverage.)

## 5. root cause

For every silent-failure event, identify the mechanism (tracking loss,
segmentation, classifier confusion, phase model, calibration). A failure
without a root cause is still open.

## 6. improve

Fix the mechanism. Prefer widening honest abstention over widening claims.
Never tune against the held-out cases (`wm-dink-01`, `afn-vic-rally1`).

## 7. frozen test

Re-run the frozen evaluation suites (swing-lab benches, silent-failure gold
evaluation) on the fixed build. Regressions block the next cycle.

## 8. NEW fresh users

Validate the fix with users who have never used the app — the previous
cohort is contaminated by exposure. Then the loop restarts.

## Learning-curve tracking

Claims of improvement are only as strong as the independence of the
evidence. `independenceCoverage` tracks distinct **users / sessions /
courts / devices / events** per cycle from each trial's pseudonymous dims
(`userPseudonym`, `sessionId`, `courtId`, `deviceModel`). Unknown
identifiers are counted as unknown — never merged into one pseudo-identity,
never inferred. A cycle whose trials come from one user on one court on one
device supports only a claim about that user, court, and device.
