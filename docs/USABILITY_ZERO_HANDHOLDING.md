# ZERO-HANDHOLDING USABILITY PROTOCOL — `zero-handholding-usability-v1`

Status: PROTOCOL READY · 0 sessions run (real users + physical iPhone are
BLOCKED_EXTERNAL — GATE B). Produced by Wave G2 workstream `h09-zero-handholding`.
Instrumentation counterpart: `apps/mobile/src/analysis/usabilityTelemetry.ts`
(same version string; the funnel steps and confusion codes below are the ones
the app records).

## 1. QUESTION UNDER TEST

Can a fresh user — no demo, no coaching, no one answering questions — complete
the guided Stroke Analysis loop end-to-end and correctly understand what the
app did and did not establish?

This protocol produces OBSERVATIONS, never scores of the user. A failed task
is a defect in the product, by definition. Nothing recorded here is coach
evidence (GATE A) and nothing here validates technique quality — those locks
are untouched.

## 2. PARTICIPANTS AND SETUP

- Participants: players who have never seen Pickle Sensei. Record pickleball
  experience level (never touch skill labels — self-reported play frequency
  only). Minimum n=5 for a first read; defects, not statistics, are the output.
- Device: physical iPhone with the build installed (BLOCKED_EXTERNAL today).
- Space: enough room to place a phone and swing a paddle at ~3–5m.
- Moderator stance: SILENT. The only permitted prompts are the fixed task
  card (§3) and "keep thinking aloud." Any other help = the task is coded
  FAILED_NEEDED_HELP with the help verbatim.
- Consent: session recording consent per `docs/PRIVACY.md`; analysis-only
  consent scope (`video-analysis-v1`), never training consent by default.

## 3. TASK CHAIN (the funnel; instrumentation step in parentheses)

Task card handed to the participant, verbatim:
"Use this app to get feedback on one pickleball stroke. Do everything
yourself. Think aloud as you go."

| #   | Task                              | Success criterion                                                                                      | Funnel step                                     |
| --- | --------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| T1  | Open Stroke Analysis              | Reaches the Auto Analyze surface unaided                                                               | `analyze_opened`                                |
| T2  | Choose a technique or Auto Detect | Makes an explicit choice and can say what it means                                                     | `intent_selected`                               |
| T3  | Place the phone                   | Positions the phone so their full body will be in frame                                                | `camera_opened`                                 |
| T4  | Select starting location          | Taps where they will start, then walks to that spot                                                    | `capture_saved` detail carries the lock outcome |
| T5  | Understand readiness              | Waits for Ready; can say when the camera will trigger                                                  | `readiness_state` → `ready`                     |
| T6  | Walk out and swing                | Performs one natural stroke after Ready                                                                | `stroke_captured`                               |
| T7  | Receive a Result                  | Reaches the Result screen or an honest outcome surface                                                 | `result_opened` / `intent_outcome_shown`        |
| T8  | Understand uncertainty            | States correctly, in their own words, what was and was NOT established (score, label, contact, phases) | observer-coded (§5)                             |
| T9  | Try Again                         | Repeats the attempt via TRY AGAIN without re-picking                                                   | `try_again_rearm`                               |

Per-task coding: PASS / PASS_WITH_CONFUSION (≥1 confusion event during the
task) / FAILED_SELF (gave up) / FAILED_NEEDED_HELP (moderator intervened).

## 4. MACHINE-DETECTED CONFUSION SIGNALS

Recorded by `usabilityTelemetry.ts`, thresholds frozen as
`CONFUSION_THRESHOLDS_V1`. Signals are adjudicated by the observer — a fired
signal is a flag, never a verdict on its own.

| Kind                       | Definition                                          |
| -------------------------- | --------------------------------------------------- |
| `intent_reselection_churn` | Intent re-picked ≥3 times before the camera opened  |
| `pre_ready_dwell_exceeded` | Camera open → first Ready took >20s                 |
| `readiness_oscillation`    | Ready lost (ready → non-ready) ≥2 times             |
| `repeated_error`           | The same error surface shown ≥2 times consecutively |
| `abandoned_before_capture` | Camera closed before any stroke was captured        |

## 5. OBSERVER-CODED CONFUSION EVENTS

One vocabulary, shared with `OBSERVER_CONFUSION_CODES_V1` in the app:

- `placement_uncertainty` — unsure where/how to place the phone (moves it ≥2 times or asks).
- `intent_choice_stall` — stalls >10s on the picker or asks what Auto Detect does.
- `start_tap_missed` — never taps the starting spot, or taps and does not walk to it.
- `readiness_misread` — swings before Ready, or waits >10s after Ready without swinging.
- `walkout_hesitation` — hesitates to leave the phone / checks the screen mid-walkout.
- `result_misread_score` — states a score/verdict the surface did not present.
- `uncertainty_misread` — reads a withheld element as their own failure, or invents a certainty the surface withheld.
- `abstention_unexplained` — cannot say why no score/label was given.
- `try_again_not_found` — cannot find or does not use Try Again.

Every observer code is logged with a timestamp and the participant's verbatim
words. Verbatims are the primary evidence; codes are the index.

## 6. T8 COMPREHENSION PROBES (asked after the Result, fixed wording)

1. "What did the app tell you about that swing?"
2. "Did you get a score? What does it mean?" (Correct answer when withheld:
   there is no score / it said it couldn't establish one.)
3. "Was there anything the app said it could NOT figure out?"
4. "What would you do differently on the next attempt, based only on what the
   screen said?"

Scoring: each probe is coded CORRECT / PARTIAL / WRONG against what the
Result surface actually rendered (screenshot archived per attempt). A WRONG
on probe 2 for a withheld score is a release-relevant honesty defect.

## 7. SESSION ARTIFACTS

Per participant: funnel event log (JSON from `usabilityFunnel.events()`),
derived confusion events, observer sheet (codes + verbatims), Result
screenshots, per-task codes. Committed under
`datasets/experiments/usability/<session-id>/` — machine logs and human
observations in separate files, never merged.

## 8. WHAT ONLY A LIVE USER CAN ANSWER (irreducibly external)

- Whether real users read Ready correctly under court conditions (glare,
  distance, noise) — component tests can only verify the copy exists.
- Whether the start-tap → walk-out choreography is discoverable without a
  demonstration.
- Whether withheld scores are experienced as honesty or as breakage
  (retention-relevant, unmeasurable in jest).
- Whether the Try Again loop matches the natural rhythm of drilling.
- Actual dwell-time distributions to calibrate `CONFUSION_THRESHOLDS_V1`
  (current thresholds are engineering estimates, marked v1 for that reason).

## 9. RELATION TO THE GATES

This protocol is GATE-B-adjacent instrumentation: it makes the real-user test
executable the day a physical iPhone and fresh users exist. It produces no
technique-quality evidence and does not touch GATE A. Technique score, fault
diagnosis, and drill recommendation remain BLOCKED_ON_VALIDATION regardless
of usability outcomes.
