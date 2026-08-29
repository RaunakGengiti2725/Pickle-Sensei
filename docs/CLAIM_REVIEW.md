# BEST-IN-CLASS CLAIM REVIEW — 2026-08-28

> Formal gate for the claim "Pickle Sensei is the best pickleball analyzer."
> Verdict below. This file must be re-run (not edited in place) at every
> release candidate; prior reviews stay in git history.

## Competitor landscape (public documentation only; no fabricated metrics)

| Product | Focus (per their public docs) | Notable public claims |
|---|---|---|
| SwingVision | Match stats: shot speed/depth/placement, line calls, highlights, Watch remote (tennis+pickleball) | speed within ~10%, ~97% close-call line accuracy (their numbers, their setup) |
| PB Vision | Upload gameplay → 3D reconstruction, shot-by-shot quality scores, 6-dimension skill ratings, shot filters | cloud post-processing of full games |
| SportsReflector | Per-technique 0–100 "form score" + cues (dink/drive/serve/volley) | no published expert-calibration evidence found |
| DinkAI / AI Pickleball Coach / Stroke Analyzer apps | LLM-style coaching, video feedback, drills | no published accuracy/validation evidence found |

Positioning notes (qualitative, honest): nobody in the set advertises
walk-away TARGET-IDENTITY capture on busy courts, declared-vs-predicted
separation, or abstention-first perception — those are Pickle Sensei's
architectural differentiators. Conversely, SwingVision ships real-time
on-device MATCH stats at scale and PB Vision ships full-session 3D analytics —
both far ahead of Pickle Sensei's session mode today. SportsReflector ships
the 0–100 technique score Pickle Sensei deliberately refuses to ship without
expert validation.

## Gate evaluation

| Gate | Requirement | Status | Evidence |
|---|---|---|---|
| A. Large verified data | substantial independent Gold | **FAIL** | 5 gold cascade events; 36 TA cases; 20 dual-paddle frames; learning curves prove instability at n=3 |
| B. Generalization | unseen session/player/source performance | **FAIL** | 1 locked_test session evaluated; val empty |
| C. Shadow set | untouched-data success | **FAIL** | shadow (40.1min) intentionally untouched — no release candidate has earned an evaluation yet |
| D. Full cascade | high end-to-end survival | **FAIL** | 1/5 gold strokes survive video→stroke |
| E. Hard slices | no catastrophic common condition | **FAIL** | ball body-overlap 0-recall slice; edge-on paddle slice; contact abstains on compact strokes |
| F. Physical devices | real-device latency | **FAIL** | iPhone latency NOT MEASURED; research path ~23s vs ≤5s target |
| G. Product flow | app completes the full experience | **PARTIAL** | live flow works end-to-end (lock→swing→Result) but Result withholds score/faults/drills by design |
| H. Technique validation | expert labels support scores | **FAIL** | qualified coach labels = 0 (schema + queue now exist) |
| I. Calibrated uncertainty | abstention appropriate | **PARTIAL** | abstention-first design measured (contact/phase/stroke abstain honestly); no calibration study |
| J. Competitor evidence | legitimate comparison supports claim | **FAIL** | qualitative feature comparison only; no comparable-case benchmark performed |

## VERDICT: **FAIL — the claim may not be used.**

Approved language: "Pickle Sensei is still being validated."

## What would flip the most gates fastest
1. Gold growth through the annotation queue (A, B, D, E move together).
2. Contact multimodal fusion fix — the current #1 cascade loss (D).
3. Physical iPhone latency harness + ROI/keyframe production point (F).
4. First coach cohort through datasets/coach-review/queue.json (H).
