# First-party consented capture protocol (v1)

Status: **executable protocol, zero sessions recorded.** This document makes the
consent-first collection contract in [`README.md`](./README.md) operational: what
to record in a session, which consent records must exist before a clip may be
ingested, and which quality gates a clip must pass. It creates no data by
itself. The gaps that block real capture are listed at the end and in
`datasets/experiments/wave-d2/d2-12-summary.json` as BLOCKED_EXTERNAL items.

Companions:

- Consent-first collection contract and eligibility rules: [`README.md`](./README.md)
- Record schema every ingested clip must eventually satisfy:
  [`collection_manifest.schema.json`](./collection_manifest.schema.json)
- Consent domain model (C10): `packages/shared-types/src/consent.ts`
- Quality gates (C12 capture envelope): `packages/capture-envelope`
- Intake validator: `packages/first-party-intake` (`pnpm --filter
@pickle/first-party-intake intake -- --help`)

## 1. Session script

One session = one athlete group, one court, one operator, one signed release
set. The atomic recorded unit is ONE clip containing ONE target athlete and one
stroke burst (2–90 s, per the envelope duration gate). Never record continuous
multi-game footage as a single asset.

### 1.1 Stroke coverage per session

Techniques come from the canonical taxonomy
(`packages/shared-types/src/pickleballTaxonomy.ts`, 61 techniques, 9 families).
A full-coverage session is unrealistic in one visit; the per-session script
below covers the families the current perception stack is weakest on first
(contact + stroke identity, per HANDOFF_V3 §2). Each block is 5 repetitions
minimum per side the athlete actually plays; `no_stroke`, aborted, and mishit
attempts are kept and labeled as such — never re-recorded to look clean.

| Block | Family (taxonomy slugs)                                                   | Reps           | Notes                                                      |
| ----- | ------------------------------------------------------------------------- | -------------- | ---------------------------------------------------------- |
| B1    | dink (`dink_straight_*`, `dink_crosscourt_*`)                             | 5 × FH, 5 × BH | held-out failure family (wm-dink-01 class)                 |
| B2    | volley (`punch_volley_*`, `block_volley_*`)                               | 5 × FH, 5 × BH | fast-exchange contact anchor cases                         |
| B3    | groundstroke (`drive_*`, `topspin_*`)                                     | 5 × FH, 5 × BH | stroke-identity confusion family (vic-rally1 class)        |
| B4    | overhead_lob (`overhead_smash`, `defensive_lob_*`)                        | 5 smash, 3 lob | overhead-blur S0 blind slice (W12)                         |
| B5    | serve + return (`volley_serve_*`, `return_drive_*`)                       | 5 × each       | longest full-body motion arcs                              |
| B6    | drop_reset (`third_shot_drop_*`, `reset_volley_*`)                        | 5 × FH, 5 × BH | low-speed contact discrimination                           |
| B7    | negatives: walking, paddle carry, practice swings, ball bounce w/o stroke | ≥10 clips      | realistic `no_stroke` negatives, never staged frozen poses |

### 1.2 Camera angles and distances

Every block is recorded from the angles below across the session (rotate the
phone position between blocks; do not re-shoot the same block from all angles
unless time allows). Angles map to the manifest `capture.cameraView` enum.

| Angle              | `cameraView`       | Distance from athlete | Rationale                                                                                                                                  |
| ------------------ | ------------------ | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Rear baseline      | `rear`             | 6–9 m                 | product default; NOTE Apple Vision swaps L/R wrists on rear views (HANDOFF_V3 §3) — record handedness on the session sheet, never infer it |
| Dominant side      | `dominant_side`    | 4–7 m                 | paddle-face and swing-plane visibility                                                                                                     |
| Non-dominant side  | `nondominant_side` | 4–7 m                 | edge-on paddle blindness slice (W12 recovery target)                                                                                       |
| Diagonal corner    | `diagonal`         | 5–8 m                 | closest to real user placement variance                                                                                                    |
| Front (across net) | `front`            | 8–12 m                | ball-approach visibility                                                                                                                   |

Distance rule of thumb: the athlete's full body must occupy ≥25% of frame
height (envelope `player_pixel_height` supported band ≥0.25). Verify with a
test clip through the intake CLI before recording a block.

Phone mount: tripod or fence mount, locked exposure/focus if the device allows.
Handheld capture is out of protocol (envelope `camera_motion` gate exists to
catch it, not to excuse it).

### 1.3 Lighting variations

Record the session's lighting condition per clip on the session sheet using the
manifest `capture.lighting` enum. Coverage targets across the program (not per
session):

- `daylight` outdoor — no shadows across the athlete where avoidable; also
  capture at least one deliberately harsh-shadow block and mark it.
- `court_lighting` indoor — verify a test clip passes the brightness gate
  (mean luma 60–200 supported, 40–220 degraded) before the session proceeds.
- `mixed` (indoor with window light, dusk outdoor) — capture, expect DEGRADED.
- `low_light` — capture a small deliberate sample; expect UNSUPPORTED; these
  clips are kept only as envelope-negative evidence, never as training footage
  unless the envelope verdict says otherwise.

### 1.4 Device and settings

- Record settings per clip: device model (`capture.deviceClass`), resolution,
  frame rate. Minimum: 1080p (short side ≥720 px supported) at ≥29 fps
  (supported band); 60 fps preferred for contact-neighborhood labeling.
- CFR export where the device allows; VFR sources must be noted — all frame
  indexing downstream is absolute CFR indexing (HANDOFF_V3 W12 finding (a)).
- Audio is stripped at ingest (`rawAsset.audioRemoved` is `const true` in the
  manifest schema); do not rely on audio cues for anything.

## 2. Per-modality consent checklist (wired to C10)

C10 (`packages/shared-types/src/consent.ts`) defines two independent scopes:
`video_analysis` and `model_training`. Model-training use is an explicit
opt-in, never a default; status is derived by folding the append-only ledger
(`deriveConsentStatus`). The intake CLI enforces the machine-checkable rows.

Before any recording starts, for EVERY person who may appear:

| #   | Check                                                                                                                                                      | Modality                      | Enforced by                                                                 |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | --------------------------------------------------------------------------- |
| 1   | Signed participant release referencing `MODEL_TRAINING_CONSENT_VERSION` (`model-training-v1`)                                                              | video, pose, derived features | intake CLI: active `model_training` grant required in the referenced ledger |
| 2   | `video_analysis` grant active for the same subject pseudonym                                                                                               | video                         | intake CLI                                                                  |
| 3   | Minor athletes: guardian release on file (`consent.guardianReleaseId` non-null)                                                                            | all                           | manifest schema `allOf` (minor ⇒ guardian id)                               |
| 4   | Release covers commercial model training, product evaluation, derived features, internal human review (manifest `consent.scopes` are `const true`)         | all                           | manifest schema at snapshot time                                            |
| 5   | Withdrawal + purge process explained; pseudonymous athlete ID issued (`subjectPseudonym`)                                                                  | all                           | operator checklist (human)                                                  |
| 6   | Bystanders: court cleared, or every visible bystander released, or capture plan guarantees irreversible redaction before ingest (`capture.bystanderState`) | video                         | operator checklist + rights review                                          |
| 7   | No third-party media in frame or audio: no broadcast screens, no music (audio is stripped anyway), no branded coaching material requiring clearance        | video                         | rights review (`rights.thirdPartyMediaPresent` `const false`)               |
| 8   | Capture rights: Pickle Sensei or contracted recorder owns the capture (`rights.captureRightsHolderId`, `rights.commercialTrainingGrantId`)                 | all                           | rights review record                                                        |

Modality notes:

- **Video** (raw clip): checks 1–8.
- **Pose / derived features** (extracted from video): covered by the same
  release only because `derivedFeatures` is an explicit release scope (check
  4); a release lacking it blocks pose extraction, not just training.
- **Audio**: not collected. `rawAsset.audioRemoved` is `const true`; strip at
  ingest before the asset gets a SHA-256 digest.

No consent record in the ledger ⇒ NOT consented (C10's default-off rule). The
intake CLI refuses clips whose ledger reference is missing, malformed, or
whose `model_training` scope is not currently active — including after a
withdrawal, since status is derived from the latest ledger action.

**No fake consent records.** Test fixtures for the intake CLI live only under
`packages/first-party-intake/test/` and are marked `SYNTHETIC-TEST-FIXTURE` in
their subject pseudonyms; nothing under `datasets/` may contain example
consent rows (see README: "examples with plausible people or clips are too
easy to mistake for collected data").

## 3. Quality gates (C12 capture envelope)

Every incoming clip is measured on CPU by `packages/capture-envelope`
(`measureClip` → `evaluateCaptureEnvelope`, thresholds
`capture-envelope-thresholds-v0.1-provisional`). The overall verdict is the
WORST measured dimension; pose-derived dimensions are honestly `NOT_MEASURED`
at intake (no pose pass on Linux intake hosts) and are re-checked when a pose
sidecar exists.

| Dimension                         | Supported | Degraded | Intake action                             |
| --------------------------------- | --------- | -------- | ----------------------------------------- |
| resolution (short side)           | ≥720 px   | ≥480 px  | UNSUPPORTED ⇒ reject clip                 |
| frame_rate                        | ≥29 fps   | ≥24 fps  | UNSUPPORTED ⇒ reject clip                 |
| brightness (mean luma)            | 60–200    | 40–220   | UNSUPPORTED ⇒ reject clip                 |
| motion_blur (laplacian var @320w) | ≥100      | ≥30      | UNSUPPORTED ⇒ reject clip                 |
| camera_motion (frame diff @320w)  | ≤6        | ≤14      | UNSUPPORTED ⇒ reject clip                 |
| clip_duration                     | 2–90 s    | 1–180 s  | UNSUPPORTED ⇒ reject clip                 |
| player_pixel_height               | ≥0.25     | ≥0.12    | NOT_MEASURED at intake; gate at pose pass |
| player_visibility                 | ≥0.5      | ≥0.3     | NOT_MEASURED at intake; gate at pose pass |

Verdict handling:

- `SUPPORTED` → clip proceeds to annotation queue.
- `DEGRADED` → clip proceeds, flagged; DEGRADED clips are deliberately kept
  (the envelope thresholds are provisional and must be re-learned from labeled
  evidence — rejecting all DEGRADED footage would bias the corpus toward easy
  conditions).
- `UNSUPPORTED` → clip rejected from the training path; retained only if the
  session lead explicitly marks it as envelope-negative evidence.

The thresholds are PROVISIONAL (v0.1). Changing them requires re-versioning in
`packages/capture-envelope/src/thresholds.ts`, never in-place softening (rule
16, HANDOFF_V3 §4).

## 4. Intake procedure (per clip)

1. Transfer the raw clip from the capture device; strip audio
   (`ffmpeg -i in.mp4 -c copy -an raw.mp4`).
2. Fill the per-clip capture metadata JSON (see
   `packages/first-party-intake/README.md` for the exact shape — camera view,
   environment, lighting, device class, handedness from the session sheet,
   skill band, age band, adaptive play, bystander state).
3. Run the intake CLI:

   ```
   pnpm --filter @pickle/first-party-intake intake -- \
     --clip raw.mp4 \
     --consent-ledger <ledger.json> \
     --subject <subjectPseudonym> \
     --capture-meta <capture-meta.json> \
     --operator <operatorId> \
     --out <intake-record.json> \
     --signing-key <hmacKey> \
     --min-max-seq <n>
   ```

   `--signing-key` is the consent export contract v2 HMAC key: an intake
   host that has been issued the key MUST pass it on every run, so that an
   unsigned (v1 or bare-array) or wrongly signed ledger is rejected instead of
   trusted on its recomputable hash. `--min-max-seq` is the highest export
   `maxSeq` already accepted for this subject; a signed but older export is a
   stale replay (it may predate a withdrawal) and is rejected. Record the
   accepted `maxSeq` per subject and carry it forward. An unrecognised flag
   exits 2 with the usage line — a mistyped `--signing-key` never runs
   unsigned.

4. The CLI computes the SHA-256 digest, probes the stream, evaluates the
   envelope, verifies the consent reference (ledger integrity, signature and
   watermark when configured, then the subject's active grants), and writes
   an intake record containing a draft manifest entry. Exit code 0 = accepted
   (SUPPORTED or DEGRADED), 1 = rejected (including a ledger that fails
   verification), 2 = invalid invocation/inputs.
5. The intake record is a DRAFT: its `pendingBeforeSnapshot` list names every
   manifest requirement intake cannot honestly satisfy (annotation, two-person
   review + coach adjudication, quality flags, split assignment, eligibility
   approval). A clip enters a training snapshot only when a full
   `collection_manifest.schema.json` record validates — intake never claims
   `approved_for_snapshot`.

## 5. What blocks real capture today (BLOCKED_EXTERNAL)

1. **Consented participants**: zero signed releases exist. Recruiting athletes
   (adults across skill bands; minors need guardian releases) is a human task.
2. **Legal release document**: `model-training-v1` names a consent version;
   the signable release text itself (commercial training, withdrawal, purge
   terms) needs counsel review before anyone can sign it.
3. **Capture hardware + court time**: phones (≥1080p60), tripod/fence mounts,
   and booked court sessions (indoor + outdoor for lighting coverage) do not
   exist in any environment Devin controls.
4. **Recording operator**: a human must run the session script, keep the
   session sheet (handedness, device, lighting per clip), and manage consent
   paperwork on site.
5. **Pose pass for the two pose-gated envelope dimensions**: pose extraction
   is macOS-only today; Linux intake leaves `player_pixel_height` /
   `player_visibility` NOT_MEASURED until a Mac (or ported pose stage) runs.
6. **Coach adjudication**: manifest review requires a qualified coach;
   recruitment is already BLOCKED_EXTERNAL (docs/COACHING.md).
