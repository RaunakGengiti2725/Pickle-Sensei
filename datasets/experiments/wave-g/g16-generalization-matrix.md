# g16 GENERALIZATION_MATRIX (Wave G, Linux, commit 104ea0f)

Machine-readable version: `g16-generalization-matrix.json` (same directory).

**Hold-out:** Held-out cases wm-dink-01 and afn-vic-rally1 were never read; every row derived from them (in committed Mac artifacts and c12) was excluded by caseId before any metric was computed. The fresh-candidate pool was untouched.

**Boundary:** TARGET and PADDLE(detector) tables reuse COMMITTED Mac artifacts (not re-run); EVENT/OWNERSHIP/BALL/CONTACT/PHASE/STROKE were re-replayed on Linux at this commit; CAPTURE_ENVELOPE reuses committed wave-c measurements; AUTO_DETECT has no replayable measured data. Nothing here is the canonical Mac strict cascade; cross-stage survival conditioning is NOT measured.

**Slices not available (honest gaps):** player identity — no cross-bundle player IDs exist; 'owner' (target/other) is the only player-level split; player apparent scale — pose-derived pixel height is Mac-only (c12 reports it NOT_MEASURED); free-text registry descriptions were not converted into invented categories; lighting — only free-text registry/annotation descriptions; no committed categorical labels; number of players — free-text only; paddle visibility / ball visibility as capture-level slices — free-text registry descriptions only; frame-level visibility IS covered via ball occlusion buckets and paddle visibleFrames counts


## TARGET

- provenance: COMMITTED Mac ta-bench replay (ta-bench-1787969692752.json, shipped D-027 variant, 2026-08-29); NOT re-run on Linux (run dirs absent — f16 TARGET coverage proof).
- harness: ta-replay-2, scope: 54 verified dev cases (locked_test excluded by the bench; held-out bundles not part of ta-bench)
- grouping: independent unit = recordingId/sessionKey; slices join datasets/ta-bench/cases.json
- overall: `{"n": 54, "success_lockCorrect": 37, "coverage_locked": 54, "abstention_noLock": 0, "silentFailure_lockedWrong": 17}`
- calibration: TA ECE .121 (n=12, agreement proxy, wave-c/c11-coverage-risk.json — proxy, not true-label calibration)
- **worst meaningful slice**: `{"dimension": "session", "slice": "afn-sigonella-2025", "n": 4, "success": 1, "coverage": 4, "abstention": 0, "silentFailure": 3}`

| dimension | slice | n | success | coverage | abstention | silentFailure |
|---|---|---|---|---|---|---|
| session | afn-sasebo-2025-06 | 7 | 3 | 7 | 0 | 4 |
| session | afn-sigonella-2025 | 4 | 1 | 4 | 0 | 3 |
| session | dvids-marne-2024 | 17 | 11 | 17 | 0 | 6 |
| session | dvids-warriorgames-2026 | 15 | 14 | 15 | 0 | 1 |
| session | wm-tournament-2014 | 11 | 8 | 11 | 0 | 3 |
| situation | contested_region | 36 | 23 | 36 | 0 | 13 |
| situation | multi_player | 50 | 34 | 50 | 0 | 16 |
| situation | small_target | 6 | 5 | 6 | 0 | 1 |
| situation | solo | 2 | 2 | 2 | 0 | 0 |
| situation | target_loss_periods | 27 | 17 | 27 | 0 | 10 |
| situation | two_players | 2 | 1 | 2 | 0 | 1 |


## EVENT

- provenance: Linux replay at HEAD (104ea0f), eventRecallBench.ts (e01/f06 harness) — g16-event-recall-replay.json
- harness: proposal recall on committed dev gold event spans; false-proposal check over explicit non-event spans
- grouping: independent unit = bundle -> source/session (BUNDLE_META from committed artifacts)
- overall: `{"n": 16, "success_proposedOk": 13, "silentFailure_misBounded": 1, "missed": 2, "falseProposalsInNonEventSpans": 0, "nonEventSpans": 5}`
- calibration: not applicable (proposals carry no calibrated confidence)
- **worst meaningful slice**: `{"dimension": "bundle", "slice": "wavea-sasebo-volleys", "n": 3, "success": 1, "silentFailure_misBounded": 1, "missed": 1}`

| dimension | slice | n | success | silentFailure_misBounded | missed |
|---|---|---|---|---|---|
| bundle | afn-sasebo-rally1 | 5 | 5 | 0 | 0 |
| bundle | wavea-944403-dink | 1 | 1 | 0 | 0 |
| bundle | wavea-944403-smash | 1 | 1 | 0 | 0 |
| bundle | wavea-faead-feed | 1 | 1 | 0 | 0 |
| bundle | wavea-faead-rally | 2 | 1 | 0 | 1 |
| bundle | wavea-marne-dig | 1 | 1 | 0 | 0 |
| bundle | wavea-marne-serve | 1 | 1 | 0 | 0 |
| bundle | wavea-sasebo-volleys | 3 | 1 | 1 | 1 |
| bundle | wavea-wgm-wheelchair | 1 | 1 | 0 | 0 |
| session | afn-sasebo-2025-06 | 8 | 6 | 1 | 1 |
| session | dvids-marne-2024 | 7 | 6 | 0 | 1 |
| session | dvids-warriorgames-2026 | 1 | 1 | 0 | 0 |
| source | afn-sasebo-indoor | 5 | 5 | 0 | 0 |
| source | dvids-944403 | 2 | 2 | 0 | 0 |
| source | dvids-faead | 3 | 2 | 0 | 1 |
| source | dvids-marne | 2 | 2 | 0 | 0 |
| source | dvids-sasebo | 3 | 1 | 1 | 1 |
| source | dvids-wgm | 1 | 1 | 0 | 0 |


## PADDLE

- provenance: COMMITTED Mac paddle-bench result (paddle-bench-1787968828222.json); paddle detection NOT replayable on Linux (runs/ gitignored, Mac-only — f16 forensics). Held-out rows present in the committed file were EXCLUDED unread beyond caseId.
- harness: paddle-bench frame-level detector scoring on human center-point gold
- grouping: independent unit = bundle (5 dev bundles from 2 sources)
- overall: `{"n_labeledFrames": 48, "n_visibleFrames": 40, "success_hits": 17, "misses": 19, "silentFailure_wrongLocation": 4, "falsePositives": 6}`
- calibration: not available in this artifact
- **worst meaningful slice**: `{"dimension": "bundle", "slice": "afn-sasebo-rally2", "session": "afn-sasebo-2025-06", "n_labeledFrames": 5, "n_visibleFrames": 3, "success_hits": 1, "misses": 0, "silentFailure_wrongLocation": 2, "falsePositives": 2}`

| dimension | slice | session | n_labeledFrames | n_visibleFrames | success_hits | misses | silentFailure_wrongLocation | falsePositives |
|---|---|---|---|---|---|---|---|---|
| bundle | wm-volley-02 | wm-tournament-2014 | 23 | 17 | 7 | 8 | 2 | 4 |
| bundle | afn-sasebo-rally1 | afn-sasebo-2025-06 | 20 | 20 | 9 | 11 | 0 | 0 |
| bundle | afn-sasebo-rally2 | afn-sasebo-2025-06 | 5 | 3 | 1 | 0 | 2 | 2 |


### PADDLE ownership proxy (Linux replay)

- overall: `{"n": 39, "success": 13, "abstention": 22, "silentFailure_wrongAnswer": 4}` · pose subset: `{"n": 18, "success": 13, "abstention": 1}`
- calibration: ownership ECE .098 (n=31, agreement proxy, wave-c/c11-coverage-risk.json)
- **worst meaningful slice**: `{"dimension": "difficultyBucket", "slice": "blur", "n": 4, "success": 1, "abstention": 3, "silentFailure_wrongAnswer": 0}`

| dimension | slice | n | success | abstention | silentFailure_wrongAnswer |
|---|---|---|---|---|---|
| difficultyBucket | blur | 4 | 1 | 3 | 0 |
| difficultyBucket | clean | 10 | 0 | 10 | 0 |
| difficultyBucket | dark_on_dark | 26 | 12 | 10 | 4 |
| difficultyBucket | edge_on | 10 | 7 | 1 | 2 |
| difficultyBucket | multi_paddle | 16 | 10 | 3 | 3 |
| difficultyBucket | net_post_occlusion | 12 | 6 | 6 | 0 |
| sessionGroup | afn-sasebo-2025-06 | 14 | 0 | 14 | 0 |
| sessionGroup | dvids-944403 | 15 | 9 | 2 | 4 |
| sessionGroup | dvids-faead | 3 | 3 | 0 | 0 |
| sessionGroup | dvids-marne-2024 | 1 | 1 | 0 | 0 |
| sessionGroup | wm-tournament-2014 | 6 | 0 | 6 | 0 |


## BALL

- provenance: Linux replay at HEAD, ballHardSliceEval.ts over committed Linux-regenerated motion candidates, D2-06 hard-slice gold (g16-ball-hardslice-replay.json)
- harness: real tracker on hard-slice gold ONLY (43 labels); NOT the full 103-frame ball gold (most bundles lack committed motion candidates on Linux)
- grouping: independent unit = bundle (4 bundles, 3 sources)
- overall: `{"n": 43, "success_hits": 10, "missed": 18, "silentFailure_wrongLocation": 11, "abstention": 2, "abstentionViolations": 0}`
- calibration: not available (tracker observations carry no calibrated confidence in this harness)
- **worst meaningful slice**: `{"dimension": "hardSliceType", "slice": "fastBlur", "n": 6, "success": 0, "missed": 3, "silentFailure_wrongLocation": 3, "abstention": 0, "violations": 0, "excluded": 0}`

| dimension | slice | n | success | missed | silentFailure_wrongLocation | abstention | violations | excluded |
|---|---|---|---|---|---|---|---|---|
| occlusionBucket | OBSERVED | 35 | 9 | 16 | 10 | 0 | 0 |  |
| occlusionBucket | ENTERING_OCCLUSION | 3 | 1 | 1 | 1 | 0 | 0 |  |
| occlusionBucket | OCCLUDED | 2 | 0 | 0 | 0 | 2 | 0 |  |
| occlusionBucket | REACQUIRED | 1 | 0 | 1 | 0 | 0 | 0 |  |
| occlusionBucket | UNCERTAIN_EXCLUDED | 2 | 0 | 0 | 0 | 0 | 0 |  |
| hardSliceType | netCrossing | 4 | 3 | 0 | 1 | 0 | 0 | 0 |
| hardSliceType | paddleOcclusion | 3 | 1 | 1 | 1 | 0 | 0 | 0 |
| hardSliceType | multiBallBackground | 1 | 0 | 1 | 0 | 0 | 0 | 1 |
| hardSliceType | fastBlur | 6 | 0 | 3 | 3 | 0 | 0 | 0 |
| hardSliceType | occlusionCycle | 4 | 0 | 2 | 0 | 2 | 0 | 0 |
| bundle | wm-volley-02 | 5 | 4 | 0 | 0 | 0 | 0 |  |
| bundle | afn-sasebo-rally2 | 14 | 1 | 10 | 0 | 2 | 0 |  |
| bundle | wavea-wgm-wheelchair | 9 | 0 | 4 | 5 | 0 | 0 |  |
| bundle | wavea-sasebo-volleys | 15 | 5 | 4 | 6 | 0 | 0 |  |


## CONTACT

- provenance: Linux replay at HEAD, e02 contactGoldReplay via assertion-free wrapper (g16-contact-replay.json); estimator contact-evidence-4.3
- harness: committed windowed pose + ORACLE gold ball, paddle=null (production also sees paddle track) — NOT canonical cascade
- grouping: independent unit = bundle -> source ('session' field in rows is the source grouping)
- overall: `{"n": 15, "success_acceptable<=132ms": 8, "coverage_estimated": 11, "abstention": 4, "silentFailure_wrongMarker>132ms": 3, "medianErrorMsOfEstimated": 103}`
- calibration: {"note": "confidence-bin acceptable counts over estimated rows (tiny n \u2014 indicative only)", "bins": [{"confidenceBin": "[0.0,0.55)", "n": 3, "acceptable": 2}, {"confidenceBin": "[0.55,0.7)", "n": 6, "acceptable": 4}, {"confidenceBin": "[0.7,1.01)", "n": 2, "acceptable": 2}]}
- **worst meaningful slice**: `{"dimension": "strokeFamily", "slice": "volley", "n": 3, "success": 0, "coverage": 2, "abstention": 1, "silentFailure": 2}`

| dimension | slice | n | success | coverage | abstention | silentFailure |
|---|---|---|---|---|---|---|
| source | dvids-944403 | 5 | 4 | 5 | 0 | 1 |
| source | dvids-faead | 4 | 1 | 1 | 3 | 0 |
| source | dvids-marne | 2 | 1 | 1 | 1 | 0 |
| source | dvids-sasebo | 3 | 1 | 3 | 0 | 2 |
| source | dvids-wgm | 1 | 1 | 1 | 0 | 0 |
| bundle | wavea-944403-dink | 3 | 2 | 3 | 0 | 1 |
| bundle | wavea-944403-smash | 2 | 2 | 2 | 0 | 0 |
| bundle | wavea-faead-feed | 2 | 1 | 1 | 1 | 0 |
| bundle | wavea-faead-rally | 2 | 0 | 0 | 2 | 0 |
| bundle | wavea-marne-dig | 1 | 0 | 0 | 1 | 0 |
| bundle | wavea-marne-serve | 1 | 1 | 1 | 0 | 0 |
| bundle | wavea-sasebo-volleys | 3 | 1 | 3 | 0 | 2 |
| bundle | wavea-wgm-wheelchair | 1 | 1 | 1 | 0 | 0 |
| owner | other | 5 | 2 | 4 | 1 | 2 |
| owner | target | 10 | 6 | 7 | 3 | 1 |
| strokeFamily | dink | 2 | 2 | 2 | 0 | 0 |
| strokeFamily | drive | 1 | 1 | 1 | 0 | 0 |
| strokeFamily | overhead | 2 | 2 | 2 | 0 | 0 |
| strokeFamily | serve | 1 | 1 | 1 | 0 | 0 |
| strokeFamily | unknown | 6 | 2 | 3 | 3 | 1 |
| strokeFamily | volley | 3 | 0 | 2 | 1 | 2 |


## PHASE

- provenance: Linux replay at HEAD, d3-05-measure-gold.ts unmodified (g16-phase-gold-replay.txt)
- harness: anchored + anchor-free segmentation over committed wave-a gold phase events
- grouping: independent unit = bundle -> session
- overall: `"see anchored/overall and anchor-free/overall slice rows (segmentation coverage only \u2014 per-boundary correctness vs gold is NOT scored by this harness, so success/silent-failure are NOT measurable here; disclosed)"`
- calibration: not applicable
- **worst meaningful slice**: `{"dimension": "anchor-free/bundle", "slice": "wavea-sasebo-volleys", "n": 5, "coverage_segmented": 3, "abstention": 2}`

| dimension | slice | n | coverage_segmented | abstention |
|---|---|---|---|---|
| anchored/bundle | wavea-944403-dink | 5 | 4 | 1 |
| anchored/bundle | wavea-944403-smash | 2 | 2 | 0 |
| anchored/bundle | wavea-faead-feed | 1 | 1 | 0 |
| anchored/bundle | wavea-faead-rally | 1 | 1 | 0 |
| anchored/bundle | wavea-marne-dig | 1 | 1 | 0 |
| anchored/bundle | wavea-marne-serve | 1 | 1 | 0 |
| anchored/bundle | wavea-sasebo-volleys | 5 | 4 | 1 |
| anchored/bundle | wavea-wgm-wheelchair | 1 | 1 | 0 |
| anchored/session | afn-sasebo-2025-06 | 5 | 4 | 1 |
| anchored/session | dvids-marne-2024 | 11 | 10 | 1 |
| anchored/session | dvids-warriorgames-2026 | 1 | 1 | 0 |
| anchored/overall | all | 17 | 15 | 2 |
| anchor-free/bundle | wavea-944403-dink | 5 | 4 | 1 |
| anchor-free/bundle | wavea-944403-smash | 2 | 2 | 0 |
| anchor-free/bundle | wavea-faead-feed | 1 | 1 | 0 |
| anchor-free/bundle | wavea-faead-rally | 2 | 1 | 1 |
| anchor-free/bundle | wavea-marne-dig | 1 | 1 | 0 |
| anchor-free/bundle | wavea-marne-serve | 1 | 1 | 0 |
| anchor-free/bundle | wavea-sasebo-volleys | 5 | 3 | 2 |
| anchor-free/bundle | wavea-wgm-wheelchair | 1 | 0 | 1 |
| anchor-free/session | afn-sasebo-2025-06 | 5 | 3 | 2 |
| anchor-free/session | dvids-marne-2024 | 12 | 10 | 2 |
| anchor-free/session | dvids-warriorgames-2026 | 1 | 0 | 1 |
| anchor-free/overall | all | 18 | 13 | 5 |


## STROKE

- provenance: Linux replay at HEAD (stroke-heuristic-6 at 104ea0f), strokeHeuristicBench (g16-stroke-bench-replay.json). NOTE: differs from f16 (heuristic-4): L1 correct 9->5, abstained 8->12, confidentlyWrong 3->2 — the post-Wave-F abstention gates' coverage cost, measured.
- harness: committed stroke gold (29 labels / evaluable 18 on this box); L1 = OVERHEAD-vs-SWING claimable class
- grouping: independent unit = corpus sessionKey (all dvids-marne recordings share one group — harness disclosure)
- overall: `{"n": 18, "success_l1": 5, "wrong_l1": 0, "abstention_l1": 12, "goldUnknown_l1": 1, "silentFailure_confidentlyWrong": 2, "success_l2": 2, "wrong_l2": 2}`
- calibration: not available (bench rows carry labels, not calibrated probabilities)
- **worst meaningful slice**: `{"dimension": "sessionGroup", "slice": "afn-sasebo-2025-06", "n": 5, "success_l1": 0, "wrong_l1": 0, "abstention_l1": 5, "goldUnknown_l1": 0, "silentFailure_confidentlyWrong": 0, "success_l2": 0, "wrong_l2": 0}`

| dimension | slice | n | success_l1 | wrong_l1 | abstention_l1 | goldUnknown_l1 | silentFailure_confidentlyWrong | success_l2 | wrong_l2 |
|---|---|---|---|---|---|---|---|---|---|
| sessionGroup | afn-sasebo-2025-06 | 5 | 0 | 0 | 5 | 0 | 0 | 0 | 0 |
| sessionGroup | dvids-marne-2024 | 12 | 4 | 0 | 7 | 1 | 1 | 2 | 1 |
| sessionGroup | dvids-warriorgames-2026 | 1 | 1 | 0 | 0 | 0 | 1 | 0 | 1 |
| owner | other | 7 | 2 | 0 | 5 | 0 | 0 | 1 | 0 |
| owner | target | 11 | 3 | 0 | 7 | 1 | 2 | 1 | 2 |
| goldStrokeFamily | dink | 4 | 2 | 0 | 2 | 0 | 1 | 0 | 1 |
| goldStrokeFamily | groundstroke | 2 | 1 | 0 | 1 | 0 | 1 | 0 | 1 |
| goldStrokeFamily | overhead_lob | 3 | 1 | 0 | 2 | 0 | 0 | 1 | 0 |
| goldStrokeFamily | serve | 1 | 1 | 0 | 0 | 0 | 0 | 1 | 0 |
| goldStrokeFamily | unknown | 1 | 0 | 0 | 0 | 1 | 0 | 0 | 0 |
| goldStrokeFamily | volley | 7 | 0 | 0 | 7 | 0 | 0 | 0 | 0 |
| case | wavea-944403-dink | 5 | 1 | 0 | 4 | 0 | 0 | 0 | 0 |
| case | wavea-944403-smash | 2 | 1 | 0 | 1 | 0 | 0 | 1 | 0 |
| case | wavea-faead-feed | 1 | 0 | 0 | 0 | 1 | 0 | 0 | 0 |
| case | wavea-faead-rally | 2 | 1 | 0 | 1 | 0 | 1 | 0 | 1 |
| case | wavea-marne-dig | 1 | 0 | 0 | 1 | 0 | 0 | 0 | 0 |
| case | wavea-marne-serve | 1 | 1 | 0 | 0 | 0 | 0 | 1 | 0 |
| case | wavea-sasebo-volleys | 5 | 0 | 0 | 5 | 0 | 0 | 0 | 0 |
| case | wavea-wgm-wheelchair | 1 | 1 | 0 | 0 | 0 | 1 | 0 | 1 |


## CAPTURE_ENVELOPE

- provenance: COMMITTED wave-c c12-envelope-measurements.json (Linux, ffprobe/ffmpeg proxies); thresholds capture-envelope-thresholds-v0.1-provisional
- harness: envelope checker over committed bundle clips — only 2 non-held-out clip(s) have committed media; 10 bundles have annotations only
- grouping: independent unit = clip
- overall: `{"n_clipsMeasurable": 2, "n_bundlesWithoutCommittedMedia": 10}`
- calibration: NOT VALID: threshold validation failed twice (e15, f18 — preserved scientific negatives); f22 pinned 8 KNOWN-GAP bypasses. Verdict columns are v0.1-provisional hypotheses, not truth.
- **worst meaningful slice**: `{"note": "no meaningful slice: n=2 clips with no validated ground truth \u2014 the envelope subsystem's generalization is UNMEASURED; this row is a coverage gap, not a pass"}`

| dimension | slice | n_dimensionsChecked | supported | unsupported | notMeasured |
|---|---|---|---|---|---|
| clip | afn-sasebo-rally1 | 8 | 5 | 1 | 2 |
| clip | wm-volley-02 | 8 | 4 | 2 | 2 |


## AUTO_DETECT

- provenance: wave-a D-summary.json / wave-b W4 (fixture-level); no replayable per-slice measured dataset exists on this box
- harness: NONE REPLAYABLE: AUTO DETECT (declaredStroke=null routing) is validated by fixture tests only; end-to-end runs require Mac run dirs
- grouping: n/a
- overall: `{"n": 0}`
- calibration: not applicable
- **worst meaningful slice**: `{"note": "N=0 measured slices \u2014 AUTO DETECT generalization is UNMEASURED on existing labeled/replayable data. This is the honest answer, not a pass."}`

_no measurable slices_

