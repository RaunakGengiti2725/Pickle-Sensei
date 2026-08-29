# DRAFT DECISIONS D-044+ (Wave F f28 — decisions backlog)

DRAFT ONLY — integrator-owned docs/DECISIONS.md is NOT modified by this workstream. Each
entry below is written in DECISIONS.md format (date, decision, why, alternatives/reversibility)
and cross-referenced to committed artifacts, ready to append verbatim. DECISIONS.md currently
ends at D-043 (2026-08-28); everything below covers behavior changes shipped by waves
C / D / D2 / D3 / D4 / E (2026-08-29, Linux integration; measurement boundary per
docs/STATUS_BOARD.md — no Mac/Apple Vision/iPhone numbers claimed).

---

## 2026-08-29 — D-044: Detector timestamps are absolute-CFR-pts labeled; the -ss frame-boundary/start_time defects are fixed at the source

Two compounding defects in tools/paddle-lab/detect_paddle.py made every paddle-detection tMs
sub-frame-to-one-frame EARLY: (1) frame_iter labeled the first emitted frame `start_ms` although
ffmpeg `-ss` emits the first frame whose pts >= target; (2) container start_time was ignored
(afn-sasebo-rally1 carries a one-frame 33.367ms start_time), which also silently dropped the true
first window frame. Fix: plan_window_seek computes the absolute first frame index and labels
tMs = start_time_ms + (first_index + i·stride)/fps·1000 (the frame's true CFR pts), shared by the
one-shot, --serve, --legacy-decode, and stride paths; pixel decode untouched. Measured pre-fix
shifts: wm-volley-02 23.0ms early, afn-sasebo-rally1 50.05ms early. Guarded by
tools/paddle-lab/test_timestamp_alignment.py. Cascade effect deliberately NOT claimed (Mac
re-measure required).
Evidence: datasets/experiments/wave-c/c01-summary.json. Reversibility: revertible commit; the
regression test pins the corrected labeling model so a revert fails loudly.

## 2026-08-29 — D-045: Warm paddle worker is DEFAULT ON in analyzeVideo, with proven bit-equality and a supervised crash/fallback contract

C07 wired detect_paddle.py --serve into runPaddleStage via PaddleServeWorker
(paddle-serve-v1 JSONL protocol: ready handshake, id-matched requests, timeouts, dispose = stdin
EOF + 3s SIGKILL backstop); analyzeVideo spawns it at arg parse so startup overlaps pose
extraction. Default ON because the frames payload is byte-for-byte equal to the one-shot path on
both committed dev clips (wm-volley-02 10975/10975 bit-equal pairs, afn-sasebo-rally1 5627/5627;
minIoU 1.0, score delta 0.0, Linux CPU); --no-paddle-worker restores the one-shot path;
timings.paddleDetectViaWorker records provenance; ANY worker failure falls back to the legacy
execFileSync path. D09 hardened it: EPIPE/broken-stdin rejects instead of hanging,
PaddleWorkerSupervisor respawns crashed workers (bounded, default maxRestarts=2), dispose rejects
in-flight requests and leaves no process; crash-mid-request fallback output verified
timing-stripped-identical; 12-request RSS stays in a 660–712MB band with no monotonic growth.
e18 added a committed soak harness with real/fake soak reports (LINUX-CPU NOT-MAC labeled).
The ~11.9s Mac E2E projection from D-041 remains UNVERIFIED (Mac re-measure pending).
Evidence: datasets/experiments/wave-c/c07-summary.json,
datasets/experiments/wave-d/d09-warm-worker-hardening-summary.json,
datasets/experiments/wave-e/e18-warm-worker-soak-summary.json (+ e18-soak-report-real.json).
Reversibility: one flag (--no-paddle-worker) or revert; bit-equality means no artifact drift
either way.

## 2026-08-29 — D-046: Edge-on crop recovery is productionized behind --crop-recovery, OFF by default, with FP-family admission gates

W12's wrist-conditioned multi-scale crop re-detect strategy is now production code
(crop-recovery-v1): crops planned on BOTH wrists (Apple Vision swaps L/R on rear views) only for
paddle-lost frames; crop-sourced candidates may EXTEND an existing track but never seed a new
one; measured W12 FP families (court-line slivers aspect >3.5, boxes ≥0.06 below every wrist) are
rejected at admission; ≤2-frame holes bridged as source='tracked_estimate' with detectorScore 0
(estimates never presented as detections); detector version labeled '<base>+crop-recovery-v1'.
OFF by default because the held-out/cascade effect is unmeasured on this fleet (Mac required).
Evidence: datasets/experiments/wave-c/c02-edgeon-crop-production-summary.json. Reversibility:
flag-gated; default behavior unchanged.

## 2026-08-29 — D-047: Paddle∥ball prep runs concurrently by default; adaptive two-pass detector schedule ships OFF behind --two-pass

analyzeVideo now runs the paddle detector and ball candidate generator subprocesses concurrently
(tracking stays sequential — ball gating consumes the selected paddle track), with per-stage
status unions so one stage's failure becomes its own honest 'unavailable' reason and never
poisons the other; sequential artifacts verified byte-identical after the refactor. The D-041
follow-up adaptive two-pass (stride-3 sparse scan + planTwoPassSchedule stride-1 densification
around event peaks / uncertainty / coverage holes, dense copy wins collisions) is implemented
and unit-tested but OFF by default pending full-pipeline validation (D-032/D-041 lesson: static
stride was invalidated downstream).
Evidence: datasets/experiments/wave-c/c08-concurrency-twopass-summary.json. Reversibility:
concurrency refactor is byte-identical (safe revert); two-pass is flag-gated.

## 2026-08-29 — D-048: First-party consent is an append-only pseudonymous ledger with independent analyze/train scopes and a verifiable export envelope

Migration 0015 creates consent_subject (user→pseudonym uuid) and consent_record (append-only —
UPDATE/DELETE rejected by trigger; withdrawal is a new row, never a mutation; monotonic seq).
Scopes video_analysis and model_training are independent; no record ⇒ inactive; latest action by
seq decides state. API (grant/withdraw/status) exposes only the pseudonym;
model_training withdrawal flags active user-sourced ml_dataset_item rows and queues removal
review; services/media-worker/src/trainingConsent.ts is the mandatory hook for any future
training selection. Mobile toggle defaults OFF and never holds optimistic state. e21 proved the
full lifecycle on real PostgreSQL 16 (migrations 0001–0016, appended-only enforcement verified
via rejected mutations; version bump model-training-v1→v2 exercised) and added
consent-ledger-export-v1 (GET /v1/me/consent/export: sha256 over canonical records, seq
monotonicity, maxSeq, recordCount) — added as a NEW version; legacy bare-array intake still
accepted, nothing softened in place.
Evidence: datasets/experiments/wave-c/c10-consent-architecture-summary.json,
datasets/experiments/wave-e/e21-consent-e2e-summary.json, migrations/0015_consent_records.sql.
Reversibility: additive schema + endpoints; ledger semantics deliberately hard to reverse
(append-only by design).

## 2026-08-29 — D-049: Capture-envelope thresholds are versioned provisional hypotheses; corpus validation returned a preserved SCIENTIFIC NEGATIVE (v0.3)

C12 shipped packages/capture-envelope: per-dimension SUPPORTED/DEGRADED/UNSUPPORTED/NOT_MEASURED
verdicts (overall = worst MEASURED dimension; unmeasured signals surfaced, never hidden), every
band stamped capture-envelope-thresholds-v0.1-provisional with per-dimension thresholdIds —
explicitly NOT validated. Its premise correction is disclosed in-artifact: only 3 bundle clips
are committed, not 13. e15 then tried to validate against the real corpus (71 units, 50 labeled)
and PROVED the negative: 51/57 failure-queue kinds on failed units are content/scene failures
(CROWDED_SCENE 32, TRACK_FRAGMENTATION 17) no capture-quality dimension measures; v0.2 flagged
9/9 downstream-GOOD units (frame_rate min 29 flagged all completing 24fps footage; camera_motion
supported-max 6 vs measured 7.8–32.7 on every good unit). Recalibrated v0.3-provisional
(frame_rate 24/15, camera_motion 33/46 — evidence-bounded, n=9 good units) fixes specificity but
envelope sensitivity to downstream failure stays 8/41 (20%). Decision: the envelope is a
capture-quality surface, NOT a downstream-failure predictor; thresholds change only via
versioned, evidence-cited recalibration.
Evidence: datasets/experiments/wave-c/c12-summary.json (+ c12-envelope-measurements.json),
datasets/experiments/wave-e/e15-envelope-thresholds-summary.json (+
e15-envelope-corpus-measurements-v0.2.json / v0.3.json, e15-media-rederivation.json).
Reversibility: thresholds are data (re-version to change); the negative finding is preserved,
not deleted.

## 2026-08-29 — D-050: OOD policy — real rights-cleared negative corpus + derived probes, gated by versioned pose-free frame analyzability (frame-analyzability-3 / pre-analysis-gate-1)

C15 built the pose-free gate (frameAnalyzability over decoded frame stats; preAnalysisGate
combines it with the pose-conditioned contract; typed abstentions via the existing Result
taxonomy; nulls recorded notEvaluated, never pass/fail) plus artifact/corpus invariant checkers
(fuzz found and fixed 1 real bug; 299 corpus files, 0 violations). D08 grew a REAL (non-synthetic)
rights-cleared negatives corpus (9 clips, 7 categories, ~70MB, per-item quoted licenses +
SHA-256 in datasets/ood/registry.json; 3 quarantined) and locked measured verdicts as tests
(5 rejected pose-free, 4 documented pass-throughs). e11 expanded to 11 real + 9 derived probes
and versioned the gate frame-analyzability-2 → frame-analyzability-3 (new reason codes
implausible_aspect_ratio / undecodable_media / decoded_frame_deficit; maxAspectRatio 4,
minDecodedFrameFraction 0.9) — gaps fixed by ADDING signals under a new version, nothing
weakened; 0 confident pickleball analyses on any OOD item (pose-gated scope stated). Policy:
OOD negatives are real, rights-cleared, registry-tracked, append-only; gate changes are
re-versioned; pass-throughs are documented findings, not silently tolerated.
Evidence: datasets/experiments/wave-c/c15-ood-property-tests-summary.json,
datasets/experiments/wave-d/d08-summary.json (+ d08-ood-measurements.json),
datasets/experiments/wave-e/e11-ood-expansion-summary.json (+ e11-ood-gate-measurements.json),
datasets/ood/registry.json. Reversibility: additive gate versions; registry append-only.

## 2026-08-29 — D-051: stroke-heuristic-4 — absence-of-measurement gates; near-profile now abstains instead of guessing

On the enlarged stroke gold (29 labels; 18 evaluable on Linux — the 11 without committed pose are
BLOCKED_EXTERNAL, not fabricated; grouped by corpus session, never random frames),
stroke-heuristic-4 vs -3: L1 wrong 2→0 with correct 8→9 (abstained 7→8), confidently-wrong 4→3;
L2 unchanged (4 correct / 3 wrong). It resolved red-team finding E10-F3 (near-profile view now
abstains; the pin was flipped to an abstention regression in the integration fixups). Decision:
absence of measurement gates classification — the classifier may not claim what the evidence
window cannot support; remaining L2 wrongs are recorded, not tuned against held-out.
Evidence: datasets/experiments/wave-e/e03-stroke-l1l2-summary.json,
datasets/experiments/wave-e/e10-rt-stroke-ambiguous-summary.json,
datasets/paddle-bench/stroke-gold.json. Reversibility: heuristic versioned (v3 remains in
history); bench (strokeHeuristicBench.ts) makes any revert a measurement.

## 2026-08-29 — D-052: phases v2.3 — rest-separated margin peaks no longer contest apex ownership (anchor-free coverage 8/18 → 12/18)

Forensics on the 10 anchor-free abstentions showed 5 were rival/ownership gate failures where the
contesting sample in the ±300ms margin is REST-SEPARATED from the in-event apex (series drops
below 0.25× min(apex, contender) between them) — i.e. the NEIGHBORING stroke of a dense rally,
not this event's apex. v2.3 exempts exactly those; in-event samples always contest (the D3-05 B2
wheelchair multi-push fixture still abstains); motion-connected margin peaks still abstain.
Nothing weakened: no threshold/floor/denominator/sample-count change; anchored path byte-identical
(pinned tests; committed-gold anchored 15/17 unchanged); version bumped v2.2→v2.3 BECAUSE
abstention semantics changed. Measured with the unmodified D3-05 script: anchor-free 8/18→12/18;
D3-05 corruption fuzz identical before/after (147 segmented, all 10 B2 abstentions preserved);
new 300-seed two-burst fuzz passes ordering invariants.
Evidence: datasets/experiments/wave-e/e04-phase-anchorfree-summary.json (+ e04-forensics.ts,
wave-d3/d3-05-rt-phase-summary.json, d3-05-measure-gold.ts). Reversibility: versioned semantics;
revert = restore v2.2 constant + gates, fuzz pins detect drift.

## 2026-08-29 — D-053: session-scheduler-1 — bounded-concurrency FIFO over engine closures with honest failure semantics is the progressive-session execution model

packages/analysis-pipeline/src/sessionScheduler.ts schedules analyses as SessionEventEngine
events close while recording continues: bounded-concurrency FIFO, retryable failure REVERTS the
event to pending (never fabricated ready/abstained), retry exhaustion is a distinct terminal
state, suspend/resume + recoverPending survive interruption. Driven by the REAL engine (D-029
completion semantics), only the analysis executor is simulated (native clip extraction is a Mac
gap). Simulation (deterministic seeded, stream-time ms): steady rally 20/20 ready with zero queue
wait; 1-slot rapid rally saturates honestly (p95 wait 41.4s) while 2 slots eliminate the backlog
(p95 1.36s); flaky extraction 21 ready / 2 failed_final / 1 retry_exhausted with no loss;
abstain-mix and interruption-recovery preserve every event. 47 tests across scheduler + sim
(STATUS_BOARD e16 row).
Evidence: datasets/experiments/wave-e/e16-session-scheduler-summary.json (+
e16-session-scheduler-sim.json). Reversibility: new module behind the session engine seam;
mobile wiring unchanged until native gaps close.

## 2026-08-29 — D-054: Voice technique intent is a deterministic versioned grammar (voice-intent-v1 → v2); unknowns re-prompt, never silently mis-select

d4-10 established voice-intent-v1 as a deterministic parsing contract over the D-031 technique
registry (no speech engine claims — parsing only). e20 versioned it to v2 for
misspelling/ASR-variant lexicon, fillers, multi-intent phrases, and idioms reusing technique
words, with the explicit constraint that v2 strictly REDUCES silent accepts and never adds them;
a 73-utterance bounded eval measured v2 accuracy 100% with 0% false activation (bounded scope
stated in-artifact — no real user speech). Ambiguity narrows options; garbage returns unknown;
nothing outside the registry can become a route (D-031 preserved).
Evidence: datasets/experiments/wave-d4/d4-10-voice-intent-summary.json,
datasets/experiments/wave-e/e20-voice-robustness-summary.json. Reversibility: versioned grammar;
v1 semantics remain replayable.

## 2026-08-29 — D-055: Footage acquisition policy — lawful-only, quoted-license registries, quarantine-by-default, and a label-blind fresh-candidate holdout pool

Waves C/D2/E operationalized supply against external blocker 3: C16 committed 6 CC BY 3.0 clips
(181.08MB, 360s, verbatim-quoted YouTube license fields, SHA-256, full provenance) under
datasets/pickleball/fresh-candidates/ registered role=fresh_candidate — deliberately LABEL-BLIND
holdout-candidate material (no labels created; nobody tunes against it); 4 pickleball-relevant
unknown-rights items quarantined, not downloaded. D2-01/02/03 extended lawful acquisition to
NARA/Commons/.mil-gov (2 VOA clips accepted; unknown-rights quarantined). e22 added 7 more usable
clips (5 YouTube CC BY, 2 VA public-domain federal works, 193.7MB; AP-watermarked footage
EXCLUDED; 1 new quarantine/exclusion record, 2 quarantines resolved), bringing fresh candidates
to 15 items / 521MB. Policy: unknown rights = quarantine; provenance recorded verbatim;
registries append-only; fresh candidates stay label-blind until an explicit mission says
otherwise.
Evidence: datasets/experiments/wave-c/c16-data-acquisition-summary.json,
datasets/experiments/wave-d2/d2-01-acq-nara-summary.json / d2-02-acq-commons-summary.json /
d2-03-acq-milgov-summary.json, datasets/experiments/wave-e/e22-acquisition-wave2-summary.json,
datasets/pickleball/registry.json. Reversibility: append-only registries; exclusions/quarantines
are records, not deletions.

## 2026-08-29 — D-056: Retired denominators — evidence-pack reconciliation replaces folklore counts with recounted, artifact-cited bases

e25 (with D4-12's programmatic recount) reconciled every circulating count against committed
artifacts and applied corrections to STATUS_BOARD: the bare "34 event labels" from Wave B is
RETIRED (head recount: 62 annotation records — 39 target, 59 with contactMs, 57 excluding the 2
held-out cases' 5 pre-existing records; unique contact events are a SEPARATE denominator, 28 per
c05 reconciliation + D04); the old ownership "78/83" matches no committed artifact and is retired
(current bases: 102 target / 142 other annotation records; 85/140 visible points README basis;
100 sidecar verdicts; 50 dual frames); ball gold is 103 frames (86 visible / 6 uncertain / 5 not
visible / 6 occluded; 78 with occlusionState). Decision: every published count must name its
counting basis and cite the artifact it was recounted from; stale counts are retired explicitly,
never silently overwritten.
Evidence: datasets/experiments/wave-e/e25-docs-evidence-pack-summary.json (+
e25-docs-evidence-pack.json), datasets/experiments/wave-d4/d4-12-summary.json,
docs/STATUS_BOARD.md (Waves D–E addendum, commit 8588ddd). Reversibility: documentation policy;
each retirement cites what replaced it.

## 2026-08-29 — D-057: Blind audits and adjudication protocol — disputes are preserved records that reference what they adjudicate

C06 closed all 5 W14 adjudications and shipped
ml/annotations/ta-ownership-annotation-guide-v1.md (34/34 QA, 1 flag). D2-04 ran a blind
ownership audit and D2-05 a blind contact audit (6/7 re-derivable labels within 0.5 frame, median
Δ 0.1 frame; 4 disputes PRESERVED, not deleted). e05 applied the auditor-upheld ownership
corrections as VERSIONED APPENDS. D2-09/e24 data-integrity audits are committed with their audit
scripts. Protocol now in force: audits are blind; corrections are appended records referencing
the original (datasets stay append-only; adjudication records are the sole sanctioned exception
per the wave ground rules); disputed originals remain visible.
Evidence: datasets/experiments/wave-c/C06-adjudications.json (+ C06-summary.json),
datasets/experiments/wave-d2/d2-04-ownership-audit-summary.json /
d2-05-contact-audit-summary.json / d2-09-integrity-report.json (+ d2-09-audit.py),
datasets/experiments/wave-e/e05-ownership-adjudication-summary.json,
datasets/experiments/wave-e/e24-integrity-report.json (+ e24-data-integrity-audit.py).
Reversibility: append-only by construction — reversal itself would be a new appended record.

## 2026-08-29 — D-058: Pose-derivative computation is cached once per run (byte-equal), not rederived per stage

D4-05 audited analyzeVideo and found the same pose derivations recomputed up to 7× per run
(toLegacyPoseFrames materialized independently by the pre-pass, paddle stage, event isolation,
contact, stroke classification, and ball tracking; dominantWristSpeeds and paddleSpeedSeries
recomputed on identical inputs). The reuse contract computes each derivative once and shares it,
with byte-equality of all downstream artifacts asserted against the pre-change pipeline —
a pure-performance change with zero semantic drift permitted.
Evidence: datasets/experiments/wave-d4/d4-05-pose-reuse-summary.json. Reversibility: byte-equal
by proof; revert changes performance only.

## 2026-08-29 — D-059: Red-team findings become pinned regression tests; the fresh-candidate pool gets an explicit tuning guard

Wave D3 ran red teams across target, ownership, phase, session, OOD gate, and API errors; the
protocol outcome is that every finding is preserved as a pinned test (e.g. D3-05's B2 wheelchair
multi-push abstention pinned and re-verified through the v2.3 change; e10's 5 confidently-wrong
stroke findings pinned, with the RESOLVED F3 pin flipped to an abstention regression rather than
deleted). e08 attacked target acquisition with fresh material, found no new break
(SCIENTIFIC_NEGATIVE — a valid outcome), and added a fresh-holdout GUARD so the label-blind
fresh-candidate pool (D-055) cannot be silently used for tuning. Decision: red-team findings are
never fixed-and-forgotten — they are pinned; resolved pins are inverted to guard the fix.
Evidence: datasets/experiments/wave-d3/*.json (d3-01, d3-03, d3-05, d3-06, d3-11, d3-12),
datasets/experiments/wave-e/e08-rt-target-fresh-summary.json,
datasets/experiments/wave-e/e10-rt-stroke-ambiguous-summary.json. Reversibility: tests are
additive; removing a pin is a reviewable act.
