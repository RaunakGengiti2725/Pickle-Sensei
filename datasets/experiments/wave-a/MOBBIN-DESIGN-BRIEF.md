# MOBBIN RESEARCH → PICKLE SENSEI UI BRIEF (Wave B implementation spec)

Researched via Mobbin MCP (2026-08-28). Interaction logic extracted; NO pixel copying, NO
proprietary branding reproduction. Each lesson cites the studied screen.

## 1. STROKE RESULT SCREEN (post-analysis, consumer)

Hierarchy (top → bottom), mapped to the product's honest-evidence contract:

1. **WHAT WAS THE STROKE** — large title = resolved technique ("Forehand Volley"), subtitle =
   honest source ("You chose this" / "Auto-detected · family-level" / "Predicted BACKHAND —
   differs from your declared Dink"). Declared vs predicted disagreement is a first-class,
   calm line — not an error toast.
   - Pattern: assessment-summary headline + honest sub-copy (Equinox+ physical assessment,
     https://mobbin.com/screens/be7ba465-da7b-4941-9054-8e709fb6e45e).
2. **REPLAY CARD** — video replay with scrubber; contact marker rendered ON the scrubber only
   when defensible (usable-result contract: ≤66ms strict, ≤132ms + confirmed shown with a
   visible uncertainty halo); phase-colored segments under the scrubber only when phases v2
   segmented with valid ordering.
   - Patterns: video + scrubber + metrics toggle (Fitbit,
     https://mobbin.com/screens/7dd53190-4cb4-45de-a7eb-f984f1cfe11f); timestamped moment
     markers anchored to video (Fabric,
     https://mobbin.com/screens/8794452b-215c-4c47-bc2a-2ea9ba3e329a); event markers on a
     replay scrubber (F1 Replay,
     https://mobbin.com/screens/3ef29843-5d3d-4895-8aa3-9b9fd55f5170); phase/step color
     coding (Garmin Connect drill steps,
     https://mobbin.com/screens/3dde9cf3-76ce-46bd-a926-3452a3af4c33).
3. **ONE INSIGHT CARD** — exactly one plain-language sentence derived from DEFENSIBLE evidence
   (e.g. "Contact confirmed by ball + paddle within 1 frame" or "We couldn't pin the exact
   contact moment — timeline shown without a marker"). Never a fabricated coaching tip.
   - Pattern: single-sentence intelligence card above metric rows (Strava Athlete Intelligence,
     https://mobbin.com/screens/12ea6918-c155-4c8b-8744-9e7c0c945a94).
4. **MEASURED ROWS** — only measured values, labeled by provenance (DETECTED / ESTIMATE);
   collapsed "See more" beyond 4 rows (Hevy's "See 3 more exercises",
   https://mobbin.com/screens/86d86ea3-72a7-4cab-816b-b42c3523ad26).
5. **RESERVED SLOT (hidden today): PRIMARY FOCUS + DRILL** — when coach-validated scoring
   unlocks, a single focus card enters between 3 and 4.
   - Pattern: "Focus on Your Key Area" single-focus framing (pliability,
     https://mobbin.com/screens/1570dc50-c3d9-443c-b0df-92f11c9ce4fb).
6. **CTA ROW** — primary: TRY AGAIN; secondary: Done. (Bevel's Done/secondary stack,
   https://mobbin.com/screens/5f7837bf-96da-4c5d-a614-655893f9cbf3; Equinox+ "Retake".)

States: ANALYZING (full-screen single-state arc + stage captions — Peloton "Movement
Completed" arc, https://mobbin.com/screens/ac807c8d-4235-4c9d-a71d-4bc639199de8) →
RESULT | HONEST-ABSTENTION (same layout, explicit "what we couldn't establish" copy, replay
still shown; retry CTA).

## 2. TRY AGAIN PRACTICE LOOP

- After Result: TRY AGAIN preserves TechniqueIntent + capture mode + camera config; re-arms
  straight to "Go to your spot" (skip picker + tap-start).
- Attempt chips (Attempt 1 · 2 · 3…) on the Result header; comparisons across attempts are
  DEFERRED until metrics are validated — chips navigate, never rank.
- Pattern: retake loop from assessment results (Equinox+,
  https://mobbin.com/screens/be7ba465-da7b-4941-9054-8e709fb6e45e).

## 3. SESSION SUMMARY + EVENT TIMELINE

1. Header stats: duration, stroke count, technique distribution chips (counts only — no
   universal form score; like-with-like comparisons only).
   - Patterns: summary header stat grid (Bevel; Gymshark workout summary,
     https://mobbin.com/screens/e6aed8cf-92c8-43c9-aef2-128aa6c598ea).
2. Horizontal event timeline strip: stroke-family-colored segments on the session time axis
   (Garmin color-coded steps; F1 scrubber markers); tap segment = jump to event card;
   filmstrip scrubbing for the session video (YouTube segment picker,
   https://mobbin.com/screens/98967d0c-ea67-4d11-96fa-1406fb813708).
3. Per-event cards (E1, E2, …): technique + state chip (pending / processing / ready /
   abstained) + chevron → the SAME canonical Stroke Result screen (one Result component,
   two entry points).
   - Patterns: per-exercise rows w/ chevrons (Strava weight training,
     https://mobbin.com/screens/d3c861da-4e6a-41db-8f76-4de55dbfc02f; Tonal per-set detail,
     https://mobbin.com/screens/65d7538d-e628-4c08-9cff-c99245270609).
4. Progressive arrival: cards appear as events close and are analyzed while recording
   continues; list is append-only, never reorders during recording.

## 4. UNCERTAINTY / ERROR PRESENTATION (all screens)

- Abstention is a designed state, not an error: neutral tone, explicit "what held / what we
  couldn't establish", one retry path. Confidence shown as visual weight (marker halo), not
  raw decimals to consumers.
- Pose-lock confirmation uses a positive overlay confirmation state (Noom pose-check
  checkmark, https://mobbin.com/screens/047026d6-2957-4053-b44b-a4cab362dfac) — matches the
  existing PLAYER LOCKED moment; reuse that vocabulary for "Analyzing" and "Result ready".

## IMPLEMENTATION NOTES FOR WAVE B AGENTS

- Respect the existing mobile design system (ink/inkSoft/surface tokens, chip grid patterns
  from TechniqueIntentPicker D-031). No new design language.
- Every element renders ONLY from report fields that exist today (strokePrediction,
  targetEvent, contact status/confidence/confirmations, temporalPhasesV2, declared intent);
  reserved slots stay hidden, not faked.
- Component unification: ONE StrokeResult component consumed by both Stroke Analysis and
  Session event cards.
