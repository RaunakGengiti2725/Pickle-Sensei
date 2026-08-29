# NO-GO — NOT_SAFE_TO_RELEASE

Pickle Sensei production-operations certification, 2026-08-29.
Integration head: `devin/1787988068-wave-c-integration` @ 92fbdf7 (PR #1).
Evidence basis: Waves A–I (196 completed workstreams), all artifact-backed under
`datasets/experiments/`. Environment for everything below: Linux (Node 20, CPU).
Nothing in this report is physical-iPhone, real-coach, fresh-user, or
production-traffic evidence; those gates remain open and are the reason for NO-GO.

# PRODUCTION CONTROL PLANE

Implemented and exercised in-repo (Wave I, i01–i35, all merged): release pipeline
stages, model registry, provenance, shadow/canary/rollback, SLO monitors,
silent-failure triage, hard-case queue, active learning, consent flywheel, drift
detection, incident runbooks, feature flags, cost reporting, media lifecycle,
support diagnostics, quality dashboard, recurring health review, and
no-self-confirmation guards. All root gates green at head: typecheck, tests
(swing-lab 887 passed | 4 skipped), lint, format:check, `git diff --check`,
mobile tsc 0 errors, mobile jest 55 suites / 513 tests.

# RELEASE PIPELINE

Canonical staged pipeline encoded (i01) with the required stage order
(DEVELOPMENT → … → FULL RELEASE); release records carry commit SHA, mobile build,
backend release, schema, model versions, TechniqueAnalysisProfile versions, score
version, fault-taxonomy version, drill-library version, capture-envelope version,
and feature flags. h25 produced the pinned RC record
(`datasets/experiments/wave-h/h25-release-candidate-record.json`) and
`docs/RELEASE_PLAN_V1.md`. No tags, deploys, TestFlight, or store actions performed.

# MODEL REGISTRY

`@pickle/model-registry`: immutable versioned entries (no anonymous "latest"), each
with id/version/task/runtime, commit, splits, metrics, supported capture envelope,
supported strokes, calibration version, runtime requirements, promotion date, and
rollback predecessor. Dataset-lineage audit (`auditModelDatasetLineage`) ties every
entry to an exact immutable dataset release; `pickle-sensei-datasets@v2` cut this
session (v1 preserved untouched).

# ANALYSIS PROVENANCE

Every AnalysisRun preserves app/pipeline/provider/model versions, score version,
taxonomy version, drill-mapping version, capture-envelope version, and timestamp
(i03). Reprocessing creates a NEW AnalysisRun; historical output is never
overwritten (immutable ledger tests). f26 fixed 4 fabricated-provenance Result
defects with regression tests.

# SHADOW / CANARY / ROLLBACK

Shadow evaluation harness (i04) keeps candidate output out of user Results and
compares against the incumbent. Canary rollout controller (i05) supports staged
percentages with health-gated promotion and pause-on-missing-health. Rollback
drills (i06) were actually exercised: detect → disable → rollback → confirm
timings measured with known-good version registry; rollback covers backend, model
bundle, scoring, fault, drill mappings, envelope, Auto Detect, and flags.
Clock made portable this session (Date.now).

# PRODUCTION TELEMETRY

Latency SLO tracking with P50/P75/P90/P95 sliced by device/OS/stroke/model/
capture/cold-warm (i17); crash/stability SLO (i18); backend/queue SLO with backlog,
oldest-job age, worker restarts, stall detection surfaced from the media worker's
`runOnce` (i19/i30). All numbers producible today are Linux-CPU; they are NOT
iPhone latency.

# SILENT-FAILURE MONITORING

Triage-signal detectors implemented and tested (i07 + Wave C c11): contradictory
modalities at high confidence, declared/predicted mismatch, target instability,
contact outside event bounds, contact without target-owned paddle evidence,
impossible phase relationships, classifier oscillation, degraded capture with high
confidence, impossible session density, rapid retries, user reports, coach
disagreement. These feed triage only — never auto-Gold.

# USER FEEDBACK

Optional "WAS THIS ANALYSIS ACCURATE? YES / NOT QUITE" with the five failure
categories (i08), plus a structured bad-analysis report path (i09) storing
analysisId, versions, category, safe diagnostics. Feedback is failure mining, not
expert Gold; footage becomes review-eligible only under explicit model-improvement
consent.

# HARD-CASE PIPELINE

Structured queue (i10) populated from feedback, shadow/model disagreement, high
uncertainty, unexpected abstention, envelope failures, coach disagreement, red
team, fresh-user testing, and anomalies; routed into
TARGET/EVENT/PADDLE/OWNERSHIP/BALL/CONTACT/PHASE/STROKE/AUTO/CAPTURE/SESSION/
COACHING/OTHER.

# ACTIVE LEARNING

Priority scorer (i11, artifact `wave-i/i11-active-learning-priority.json`)
prioritizes disagreement, uncertainty, rare strokes, new
environments/players/devices, target/ownership/contact ambiguity, envelope
boundaries, and new OOD. Label-queue execution history: f12, e23. Stroke remains
the most label-starved subsystem (f15).

# CONSENTED DATA FLYWHEEL

Analysis consent and model-training consent are separate scopes with version,
timestamp, analysis/session ID, withdrawal state, and dataset eligibility (c10,
e21 full-Postgres lifecycle, i12). Append-only consent ledger enforcement verified
by rejected mutations; least-privilege DB roles destructively proven (Wave G
g10–g12, 63 denials). Zero real consent records exist — no first-party footage yet.

# DRIFT DETECTION

Aggregate drift monitors (i15) over device model, iOS, FPS, resolution, apparent
player size, envelope verdict, stroke distribution, coverage, abstention, latency,
lock success, event density, paddle visibility. No production traffic exists, so
no real drift measurements — infrastructure only.

# IPHONE / IOS COMPATIBILITY

New-device/iOS validation process encoded (i16): camera, permissions, frame
timing, Vision, thermal, memory, runtime, envelope, lock, trigger, Result, Try
Again, Session, import; new combinations stay Yellow until physically validated.
PHYSICAL_IPHONE = BLOCKED_EXTERNAL — no supported physical iPhone has ever run
either flow. This alone forces NO-GO.

# LATENCY / CRASH SLOS

Targets frozen (≤2s ideal / ≤3s strong / ≤5s normal, movement-completion →
result-interactive). h22 perf cert: warm-worker soak, decode bench, scheduler sim —
Linux-CPU only. Best Mac-measured E2E historical figure 17.25s (pre-worker-wiring
projection ~11.9s); no iPhone measurement exists. Crash SLOs have no production
data.

# SESSION OPERATIONS

Session health metrics (i20): events/session, clips, analyses completed, backlog,
dropped events, latency, completion, summary generation. Session engine
replay-validated (Δ=0ms) with honest per-event states; scheduler red-teamed
(f21, e16: 47 tests). Native motion stream + per-event clips (C09 Swift sources)
still cannot be compiled here — needs Mac.

# REAL COACH CONTINUOUS VALIDATION

Infrastructure complete (coach portal, review schema, agreement stats, frozen
coach gates, drill library schema — g2 h01–h05, i21, i22 adjudication). Real
coaches: 0. Fault taxonomy (46 draft faults) and drill mappings remain UNVALIDATED
engineering drafts. Coaching/scoring remains NO-GO until qualified coaches
participate. BLOCKED_EXTERNAL.

# SCORE / DRILL VERSIONING

Score version governance (i24 ×2 parallel modules): every score carries
scoringModelVersion; comparability declarations gate progress lines; incomparable
transitions render as version breaks, never fabricated progress. Drill governance
(i23): versioned fault→drill mappings with endorsements, agreement, validation
version, media rights; safe disable path. No real drill videos or coach-endorsed
mappings exist yet.

# SECURITY MONITORING

Monitors (i25): auth anomalies, authorization denials, admin behavior, upload
abuse, rate limits, media-access failures, DB privilege anomalies, consent
mutation, training-eligibility changes. h19 security cert + f23/g10–g12 DB role
separation destructively verified. Residual: cloud superuser can bypass
in-database boundaries (documented in RUNBOOK_CONSENT_DB_ROLES.md) —
BLOCKED_EXTERNAL to a real cloud environment.

# INCIDENT RESPONSE

Severity levels P0/P1/P2 with runbooks written before incidents (i26): P0 =
contain → preserve evidence → disable/rollback → patch → verify → postmortem.
Rollback drills exercised (i06). No real incident has occurred (no production).

# MEDIA / PRIVACY

Media lifecycle (i30): retention policy v1, deletion propagation, retention
expiry, sweep — all exercised in the media worker with tests. Training eligibility
separate from analysis permission; deletion/withdrawal propagation implemented.
No production media exists.

# COST PER ANALYSIS

Cost model + report (i29, `wave-i/i29-cost-report.json`): per Stroke Analysis, per
Game Session, per video minute, per coach-reviewed event, across device compute,
server CPU, storage, bandwidth, media processing, coach review. Estimates are
parameterized from Linux measurements — not production actuals.

# RELEASE OPERATIONS

i32 + h25: version/build numbering, release notes, privacy disclosures,
camera/mic/photos usage descriptions, TestFlight pipeline plan, environment
separation, signing checklist, flags, monitoring, rollback. Nothing irreversible
executed. Feature-flag seed list unified (18 flags, versioned, safe defaults,
observable).

# PRODUCTION DASHBOARD

Quality dashboard (i33) aggregates attempts, completion, usable-Result rate,
abstention, envelope rejection, lock success, stroke distribution, latency
percentiles, crash-free rate, session completion, backend errors, queue health,
model-version distribution, user-reported wrong Results, coach-review queue, and
silent-failure queue. Recurring model-health review generator (i34) produced the
first review (`datasets/reports/model-health/`). All values today come from lab
artifacts — no production traffic.

# REMAINING BLOCKERS

All are external; none can be closed from this Linux environment, and none were
faked:

1. PHYSICAL_IPHONE = BLOCKED_EXTERNAL — no supported iPhone has run either flow;
   all latency/thermal/battery/camera evidence requirements unmet.
2. Mac / Apple Vision — canonical strict cascade last measured 2/5 usable (n=5);
   Linux proxy replays show no regression but cannot re-measure it. Swift session
   sources (C09) cannot be compiled here.
3. Real qualified coaches — 0 reviews; scores, fault taxonomy, severity, drill
   mappings, and drill media all unvalidated; coaching remains NO-GO.
4. Fresh-user / fresh-footage generalization — h16 incomplete; held-out negatives
   (wm-dink-01, afn-vic-rally1 transfer failures) preserved, not resolved.
5. Production traffic, credentials, and observability — no cloud environment; all
   SLO/drift/dashboard/cost systems are exercised on lab data only.
6. Known open technical residuals, preserved: F09 contact residual (1 known-wrong
   marker), F22 envelope gaps (upscaled 240p; sharp low-texture as blur), f20
   heuristic-7 lacking fresh-footage evidence, ball hard-slice weakness (9/35),
   plus preserved scientific negatives (f10, f18, f25).

Verdict: NO-GO — NOT_SAFE_TO_RELEASE.
