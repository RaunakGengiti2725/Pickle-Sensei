# SPEC DIGEST — Pickleball AI Coaching App

Source of truth: "Pickleball AI Coaching App: Complete Product and Technical Blueprint" (Deep Research report, 62 pages). This digest converts it into an implementation checklist. Statuses live in `IMPLEMENTATION_STATUS.md`.

## Core product loop

```
Phone on fence/tripod → player hits → stroke auto-detected → body+paddle analyzed
→ phases identified → biomechanical features extracted → shot-specific checkpoints scored
→ 0–10 Technique Score → primary issue identified → cause explained → correction provided
→ drill recommended → Live Court practice → every rep detected → voice feedback → improvement tracked
```

Live Court Mode is the product. Single-shot analysis is the onboarding/diagnostic experience that makes Live Court understandable.

## Locked product decisions (spec pp. 59–60)

1. On-device Live Court from the beginning; cloud analysis supplements, never required.
2. Start with four strokes: `forehand_drive`, `dink`, `third_shot_drop`, `serve`. Data model supports all eight.
3. Support one or two camera views extremely well (side, rear-oblique). No arbitrary-video magic.
4. Paddle tracking is a core ML workstream from day one; pose-only insufficient.
5. Ball tracking delayed but architected for (confidence-gated `BallDetection`/`BallTrack`/`ContactHypothesis`/`Trajectory`).
6. Scores transparent and versioned; every result shows why.
7. Abstention is a feature: low confidence → `LOW_CONFIDENCE` + setup guidance, never fake precision.
8. Coaching rubric before scaling data team.
9. Multiple coaches (6–10) for rubric ground truth; ≥2 raters per validation clip.
10. LLM outside the measurement path: vision measures → scoring decides → LLM explains.
11. Privacy as product advantage: local video by default; cloud sync explicit opt-in.
12. Technique Score ≠ DUPR/skill rating, in copy and schema.
13. Second act (ball/court/rally/match intelligence) architected-for, not built first.

## Critical assumptions (spec p. 2)

- US/Canada consumer, English first; 13+ launch age (no COPPA program initially).
- One modern phone; fence mount/tripod; 720p60 Live Court, 1080p60 single-shot when supported.
- On-device first ML; freemium subscription; AWS us-west-2; original UI/branding with functional parity.

## Stroke families (8 total, 4 at MVP)

| Slug            | MVP   | Scope                                                        |
| --------------- | ----- | ------------------------------------------------------------ |
| serve           | ✅    | Volley + drop serve; legality checks separate from technique |
| return          | later | FH/BH return mechanics + recovery                            |
| forehand_drive  | ✅    | Groundstroke mechanics, contact, rotation, paddle path       |
| backhand_drive  | later | One-handed/generalized first                                 |
| third_shot_drop | ✅    | Baseline/transition-zone drop mechanics                      |
| dink            | ✅    | FH/BH crosscourt + straight fundamentals                     |
| volley          | later | Punch/block/counter                                          |
| overhead        | later | Prep, positioning, contact, recovery                         |

## Phases (six, UX-standardized)

`ready → prepare → accelerate → contact → follow_through → recover`
Contact is a probabilistic window internally (start/representative/end + confidence), never claimed exact at low confidence.

## Checkpoint framework (11 conceptual slots, shot-specific weights)

Ready Position, Athletic Base, Preparation, Paddle Set, Swing Length, Sequencing, Paddle Path, Contact Position, Face/Wrist Stability, Follow-Through, Recovery.

Initial shot weighting matrix (starting hypothesis for expert validation; per-shot columns sum to 100):

| Checkpoint           | Serve | Return | FH Drive | BH Drive | Third Drop | Dink | Volley | Overhead |
| -------------------- | ----- | ------ | -------- | -------- | ---------- | ---- | ------ | -------- |
| Ready Position       | 8     | 6      | 5        | 5        | 6          | 8    | 10     | 5        |
| Athletic Base        | 10    | 12     | 10       | 10       | 12         | 15   | 15     | 10       |
| Preparation          | 8     | 10     | 12       | 12       | 8          | 4    | 5      | 12       |
| Paddle Set           | 8     | 7      | 8        | 8        | 10         | 10   | 12     | 8        |
| Swing Length         | 8     | 7      | 8        | 8        | 8          | 5    | 2      | 10       |
| Sequencing           | 12    | 11     | 12       | 12       | 8          | 4    | 4      | 15       |
| Paddle Path          | 12    | 12     | 12       | 12       | 12         | 10   | 8      | 12       |
| Contact Position     | 16    | 16     | 15       | 15       | 16         | 18   | 18     | 13       |
| Face/Wrist Stability | 8     | 8      | 8        | 8        | 12         | 15   | 16     | 5        |
| Follow-Through       | 5     | 5      | 5        | 5        | 4          | 5    | 3      | 6        |
| Recovery             | 5     | 6      | 5        | 5        | 4          | 6    | 7      | 4        |

## Scoring math (spec pp. 33–34)

- Metric distance outside acceptable interval `[Lm, Um]`: `d_m = max(Lm − x_m, 0, x_m − Um)`
- Metric score: `q_m = 100 · exp(−½ (d_m/σ_m)²)` — full credit inside range, smooth decay outside.
- Checkpoint score: `C_j = Σ(a_m·c_m·q_m) / Σ(a_m·c_m)` (importance a, confidence c).
- Overall: `S = 10 · ΣW_j·C_j / (100·ΣW_j)` over observable checkpoints only.
- Analysis confidence: `A = ΣW_j·c_j / ΣW_j`.
- Behavior: `A < 0.65` → no numeric grade, "Couldn't read this stroke clearly. Reposition the phone." `0.65 ≤ A < 0.80` → score + "Lower confidence" indicator. `A ≥ 0.80` → normal.
- Presentation bands: 80–100 green/strong, 65–79 yellow/improve, <65 red/priority.

## Coaching-priority engine (spec p. 35)

`P_j = Severity_j × Confidence_j × CoachPriority_j × Changeability_j × GoalRelevance_j`, then dependency rules (e.g. poor preparation → causes late path → causes late contact ⇒ primary fix = Preparation, not Contact). Not simply the lowest checkpoint.

## Score versioning (spec p. 22)

Every analysis records: app version, model bundle version, pose/paddle/stroke-detector/phase/scoring model versions, shot scoring-config version. Never silently rescore history. Backend never recomputes live scores because the client sent them; persists exact producing versions.

## ML system decomposition

```
frame → pose → paddle → optional ball → court calibration → stroke detection
→ phase segmentation → feature extraction → checkpoint scoring → coaching priority → feedback
```

- Pose: MediaPipe-class 33-landmark baseline; MVP landmarks: nose/head proxy, shoulders, elbows, wrists, hips, knees, ankles, heels/feet where reliable. Derived: shoulder/pelvis rotation proxies, torso tilt, separation, elbow flexion, wrist relative position, knee flexion, stance width, CoB translation, head stability, weight-transfer proxy, balance/recovery, hand/paddle-to-torso distance. Never label monocular CoM as force-plate measurement.
- Paddle model (not optional): bbox, handle-end, throat, head-center, tip, optional face corners/mask, confidence → paddle axis/height/path, backswing length, follow-through length, paddle-to-wrist, face-orientation proxy, angular-velocity proxy. Compact detector + keypoint head over segmentation for MVP.
- Ball: two Live Court capability levels — Mechanics mode (pose+paddle, no ball needed), Contact-enhanced mode (ball near impact). Pipeline: ROI → high-res small-object detector → temporal association → trajectory smoothing → paddle-proximity contact hypothesis → outgoing trajectory. Burst around probable contact only.
- Court calibration: line detection + planar homography → player x/y, kitchen distance, lateral displacement, recovery location, transition movement, ball landing estimate. Year-two strategic.
- Stroke detection: temporal classifier over wrist/paddle velocity, elbow angle, torso angular features, body translation, optional ball proximity. States: idle/ready/stroke-candidate/contact-neighborhood/post-stroke. Min confidence + refractory period (no paddle-twirl false triggers).
- Phase segmentation: TCN/small transformer on normalized pose/paddle trajectories; outputs labels + boundary confidence.
- 3D ambition levels: A normalized 2D (MVP), B pose-model world coords, C learned 2D→3D lifting, D world-grounded 3D. 3D NOT a launch dependency.

## Live Court runtime (spec pp. 35–37)

```
720p60 camera → rolling YUV buffer ~2.0s → pose sampling 15–30fps → paddle 30fps/adaptive
→ temporal stroke trigger → retain ~2s pre + ~1.5s post → phase refinement → mechanics → score → audio cue → persist local
```

Performance targets: stroke recall >95% supported setup; false strokes <1/10min; first score p50 <1.5s, p95 <2.5s; audio cue <3s; 30-min session no thermal failure; crash-free >99.5%; zero network dependency for core coaching.

Thermal capability tiers: A (60fps capture, 30fps pose/paddle, contact burst, full overlays), B (60fps capture, 15fps inference, interpolation, reduced overlays), C (30fps capture, lightweight models, limited scoring set). Downgrade before OS throttles.

## Audio coach (spec p. 37)

No synchronous LLM. Deterministic: structured diagnosis + fault direction + severity + previous 3 shots + current focus → template cue → TTS. Cue categories: CORRECTION, IMPROVEMENT, PERSONAL_BEST, REPEAT, STABLE, SILENCE. Cooldowns + silence rules; sparse for sound-but-unremarkable reps.

## Complete screen inventory (spec pp. 5–7)

Launch, Account (OIDC: Apple/Google/Email), Onboarding (level→handedness→goal→problem→plan reveal), Permissions education, Home (Technique Score, monthly trend, Analyze Shot, Live Court, Today's Focus, weekly, recent), Shot selector, View selector, Camera setup w/ CV checklist, Single-shot capture (rolling buffer, auto-detect), Import video, Processing (honest status), Analysis result (asymmetric hierarchy: score → priority → why → next cue → drill), Priority fix, Checkpoint list (score+confidence, green/yellow/red), Checkpoint detail (What happened/Why it matters/What good looks like/Your next cue), Replay (0.25×/0.5×/1×, phase scrubber, overlays), Phase viewer, Compare (licensed references, body-size normalization), Drill detail, Training plan, Drill library, Live Court setup/active/paused, Session summary, Session replay, Library (Shots/Sessions/Favorites), Progress (model-version aware), Skill map (per-stroke, no single opaque number), Weekly review, Achievements, Friends (opt-in), Leaderboard (friends-only default), Share creator (hide face/name toggles), Coach chat (later; LLM gets structured context), Profile, Settings, Subscription, Privacy center, Help/calibration.

## UI states — first-class (directive §10)

Screens: INITIAL, LOADING, SUCCESS, EMPTY, ERROR, RETRY, OFFLINE, UNAUTHORIZED, AUTH_EXPIRED, PERMISSION_DENIED, PAYWALLED, UNSUPPORTED_DEVICE, MODEL_UNAVAILABLE, LOW_CONFIDENCE, CORRUPT_DATA.
Camera: NO_PLAYER, BODY_CROPPED, PLAYER_TOO_SMALL, PLAYER_TOO_LARGE, PADDLE_NOT_VISIBLE, MULTIPLE_PEOPLE, BAD_CAMERA_ANGLE, LOW_LIGHT, CAMERA_MOVED, THERMAL_LIMIT, BATTERY_LOW, CAMERA_INTERRUPTED.

## Database (spec pp. 13–17)

PostgreSQL, pgcrypto/gen_random_uuid, UUIDs for offline sync. Tables: app_user, user_profile, user_setting, user_device, user_consent, shot_type, checkpoint_definition, model_bundle, scoring_model, scoring_model_checkpoint, scoring_target, drill, drill_checkpoint_map, media_asset, pro_reference, user_goal, practice_session, analysis_job, shot, shot_phase, shot_metric, shot_checkpoint_score, session_summary, progress_daily, weekly_report, achievement, user_achievement, friendship, share_card, notification, billing_subscription, entitlement, ml_training_consent, ml_dataset_item, idempotency_record, audit_log. Real FKs/constraints/indexes; JSONB only where flexibility appropriate. Per-frame tensors in object storage, referenced via media_asset. Row-level authorization in service layer. Deletion is a workflow, not one cascade.

## API `/v1` (spec pp. 17–21)

Headers: `Authorization: Bearer <OIDC>`, `X-Client-Version`, `X-Model-Bundle-Version`, `X-Request-Id`, `Idempotency-Key` (mutating creation), JSON.
Endpoints: account/bootstrap, me, me/profile, me/settings, me/onboarding, me/goals CRUD, catalog/shot-types, catalog/checkpoints, catalog/drills(+detail), catalog/model-bundle, media/uploads (presigned multipart), media/{id}/complete, media/{id} (signed playback), DELETE media/{id}, analyses (create/status/cancel), shots:sync (offline batch upsert), shots/{id}, shots/{id}/rating, sessions (create/batch-shots/patch/finalize/detail), library/shots, library/sessions, progress, progress/checkpoints/{id}, weekly-reports/latest+history, references, share-cards (+status), friends/requests/accept/delete, leaderboards/friends, billing/offerings, billing/apple/sync, billing/google/sync, webhooks/apple, webhooks/google, me/ml-training-consent, me/export, DELETE me, devices, health.
Canonical shot-sync payload includes: client UUID, sessionId, shotType, scoringModelVersion, modelBundleVersion, timestamps (startMs/contactMs/endMs), overallScore, confidence, cameraView, phases[], checkpoints[] (key, score, confidence, band, direction, severity).
Backend validates version known; does NOT recompute client scores.

## Auth (spec pp. 22–23)

OIDC/OAuth; store stable `auth_subject`; no raw passwords with managed IdP. Access token ~15min; refresh via identity SDK; Keychain/Keystore for secrets; short-lived signed media URLs; presigned multipart uploads; admin = separate privileged role + MFA + audit. Ownership checks always; UUID possession ≠ access.

## Offline-first (directive §32)

SQLite + local video + client UUIDs + durable outbox + retry. Create/analyze/save/progress/end-session offline; idempotent sync on reconnect.

## Media (spec p. 38)

Local-first path: camera → local clip → native inference → score → encrypted local metadata DB → local video dir → structured cloud sync only. Cloud path: presigned multipart → S3 → SQS media job → normalize/transcode/thumbnail → optional cloud ML. Never proxy video through API. Formats: MP4/MOV master, H.264 normalized, HLS long clips, JPEG/WebP thumbs, zstd protobuf/FlatBuffers pose features, signed model bundles. Retention: raw cloud clips 30d unless kept; derived analysis while account exists; share intermediates 7–30d; deleted account → queued purge; training data only with separate consent. Local clips keepable indefinitely.

## Privacy (spec pp. 39–40)

Separate: account consent ≠ cloud-sync consent ≠ analytics ≠ ML-training consent ≠ social visibility. No face recognition, no gait identity, no ad profiles from video, no third-party ad SDKs in camera experience, no default training reuse. GDPR-ready mechanisms (access/correction/erasure/restriction/portability/objection/withdrawal); CCPA/CPRA: no sale/share of video/body-motion for cross-context ads. Teen defaults: private profile, friends-only leaderboards, no public location, no precise court location in shares, no phone/email discoverability without opt-in.

## Security (spec pp. 41–42)

OIDC, MFA admin, short-lived tokens, least-privilege IAM, no AWS creds in mobile binaries, separate prod/staging accounts. Private S3 + SSE-KMS + TLS + signed URLs + random keys + malware checks + size limits. Input validation from generated schemas, rate limiting, idempotency, dependency/SAST/secret scanning, signed model bundles + SHA-256 manifest + rollback + per-model kill switch. DB: private subnets, encryption, backups, PITR, separate app/migration roles, audit privileged reads. Never log raw tokens/media URLs/frames/face imagery/user email in model logs.

## Observability (spec p. 42)

OpenTelemetry logs/metrics/traces; request/job/analysis IDs + model versions. Track: API latency/errors, DB saturation, queue age, media duration, GPU util, upload failure, model download failure, native crashes, camera init failures, thermal downgrades, shot-detection FP feedback, confidence distribution, scoring distribution by model version.

## Analytics events (spec p. 43)

app_opened, onboarding_started/completed, goal_selected, shot_type_selected, camera_preflight_started/passed, capture_started, shot_detected, analysis_started/completed/low_confidence/failed, score_viewed, checkpoint_opened, drill_opened/started/completed, live_court_started, live_shot_scored, voice_cue_played, live_session_completed, weekly_review_viewed, share_created, friend_request_sent, paywall_viewed, trial_started, subscription_started/renewed/cancelled, cloud_sync_enabled, ml_training_consent_changed, account_export_requested, account_delete_requested.
KPIs: install→onboarding, onboarding→first valid scored stroke, preflight success, %analyses ≥ confidence threshold, first score→checkpoint→drill, drill→second analysis, live setup→≥10 valid strokes, D1/D7/D30, checkpoint improvement, crash-free, free→trial→paid→renewal, helpfulness by checkpoint/model, score distribution + coach agreement by model version. No cross-model-version improvement without normalization.

## ML data plan (spec pp. 29–31)

Targets: 2–5k reviewed clips feasibility; 20–50k labeled strokes 4-stroke MVP; 80–150k 8-stroke production; 0.5–2M paddle/ball frames (auto-label + QC); 1–5k multiview/3D; 2k+ expert holdout. 200–500 athletes, broad skill/handedness/body/conditions/devices. Annotation ontology: shot type/subtype, handedness, camera view, stroke start/end, phase boundaries, contact frame/range, player bbox, pose landmarks, paddle bbox/keypoints, ball coords, court keypoints, checkpoint labels, fault direction, fault severity, primary coaching priority, acceptable alternative mechanics, video quality flags, occlusion flags, annotator/revision/adjudication.

## Model evaluation (spec p. 31)

Per-subsystem metrics: pose PCK/OKS + 3D MPJPE; paddle mAP50–95/recall/FP; keypoint error + axis angular error; ball precision/recall/track/trajectory; shot macro-F1 + confusion; detection event P/R + FP-per-hour; phase boundary MAE; contact MAE ±1/2/3 frames; checkpoint macro-F1/AUROC; continuous MAE/RMSE vs expert consensus + rank correlation; overall Spearman + calibration vs coach consensus; test/retest variance; camera-perturbation drift; fairness gaps (age, skin tone, gender presentation, body size, handedness); live runtime p50/p95, FPS, memory, battery, thermal. Most important metric: when experts agree a stroke got better, does the app score it better, across reasonable camera changes.

## Release gates (spec p. 49, forehand example)

shot detection recall ≥95%; false event rate ≤ target; phase contact MAE ≤ threshold; checkpoint coach agreement ≥ threshold; camera perturbation drift ≤ threshold; left/right parity within tolerance; p95 scoring latency ≤2.5s; 30-min thermal pass; crash-free Live Court ≥99.5%. Thresholds frozen before final holdout.

## Golden regression sets

`golden/forehand/side`, `golden/forehand/rear_oblique`, `golden/dink`, `golden/drop`, `golden/serve`, `golden/left_handed`, `golden/low_light`, `golden/indoor`, `golden/body_diversity`, `golden/camera_perturbation`, `golden/paddle_variants`. Every release: shot F1, phase error, checkpoint metrics, score delta vs production, coach disagreement, subgroup deltas, runtime by device. No ship on aggregate gain with subgroup regression.

## MLOps (spec pp. 44–45)

Model release train separate from app binary: offline eval → golden regression → coach validation → sign → canary cohort → metric comparison → staged rollout (staff → 1% → 10% → 50% → 100%) with automatic rollback on low-confidence rate, crashes, latency, score-distribution shift, helpfulness, detection failure. Server manifest can roll clients back without App Store release.

## CI/CD (spec p. 44)

PR: lint/typecheck, unit tests, API schema compat, native unit tests, model metadata validation, security/dependency scans, affected mobile build. Merge main: Docker build, sign, ECR, Terraform plan, deploy staging, integration tests, protected production promotion. Mobile: native/RN tests, signed archives, TestFlight/Play internal, phased rollout.

## Infrastructure (spec pp. 45–46)

AWS org: security/logging, development, staging, production accounts. Production VPC: public ALB; private app subnets (ECS API, media workers, Redis, GPU workers when needed); private data subnets (RDS PostgreSQL). Outside VPC: S3 private media, CloudFront, SQS, Cognito, CloudWatch, KMS, WAF. Autoscaling: API CPU+requests+p95; media worker queue depth/oldest; ML queue+GPU util scale-to-near-zero; DB vertical first. Cost envelopes: alpha $800–2.5k/mo → 10k MAU $3–12k → 100k MAU $15–60k.

## Billing (spec p. 55)

Free: 3 single-shot analyses/mo, limited library, one Live Court trial, basic progress. Premium $11.99/mo, $79.99/yr (7-day trial), founder lifetime $169–199 launch-only. Premium: unlimited analyses + Live Court, full checkpoint detail, all drills, replay/overlays, trends, weekly report, cloud sync, pro compare, plans, share, social. Pricing remote-configurable. Canonical backend entitlements, not UI checks. StoreKit/Play Billing + server notifications + restore + grace/trial/cancel.

## Team/roadmap context (spec pp. 46–54)

7–8-month production MVP; roadmap: 0–2 prototype+rubric, 2–4 single-shot alpha, 4–6 drills/replay/progress/subscription, 6–8 Live Court beta, 8–10 public MVP, 10–12 eight strokes, 12–14 social, 14–16 advanced progress, 16–18 match beta. Milestones gate on measured model quality (coach agreement, recall, drift), never "model trained".

## Positioning

Launch line: "Put your phone on the fence. Hit. Your coach watches every rep." Demo: three strokes, three spoken scores, visible focus improvement. First product: AI analyzes your stroke. Stronger: AI coaches every repetition. Long-term: AI understands how you play pickleball.
