import XCTest
@testable import PickleVisionCore

/// Adversarial round 10 (cluster `native-vision-core`, NATIVE-1 + non-finite
/// pose hardening) against 5ad6f2c1. Every test is deterministic; the property
/// campaign is seeded with SplitMix64. Tests named `testAttack…` encode the
/// EXPECTED behaviour of the candidate claims — a red `testAttack…` test is an
/// observed break, a green one is a confirmed claim.
final class AttackFix10NativeTests: XCTestCase {
  // MARK: - Claim 1: anchor timing

  /// 10k seeds × random cadence 20–120 fps (jittered, rounded to whole ms like
  /// `CameraEngine`) × random camera drops (frame never delivered) × random
  /// Vision misses (`ingestMissing`). For a perfectly still body the anchor
  /// contract is exact: `isReady ⇔ t − firstStillObservedMs ≥ 450` on every
  /// delivered frame, and `stableForMs` is never reported below 450 while ready.
  func testAttackPropertyStillBodyReadinessIsExactlyTheAnchorContract() {
    let seeds: UInt64 = 10_000
    var readyFrames = 0
    var totalFrames = 0
    for seed in 0..<seeds {
      var rng = SplitMix64(seed: seed)
      let evaluator = PoseReadinessEvaluator()
      let fps = 20 + Double(rng.next() % 101)  // 20…120
      let periodMs = 1_000.0 / fps
      let dropRate = Double(rng.next() % 40) / 100.0  // 0…39 % camera drops
      let missRate = Double(rng.next() % 6) / 100.0  // 0…5 % Vision misses
      let frames = 60 + Int(rng.next() % 200)
      var clock = Double(rng.next() % 5_000)
      var firstStill: Int?
      var lastTimestamp = Int.min
      for _ in 0..<frames {
        let jitter = (Double(rng.next() % 1_000) / 1_000.0 - 0.5) * periodMs * 0.4
        clock += periodMs
        let t = max(lastTimestamp, Int((clock + jitter).rounded()))
        lastTimestamp = t
        let roll = Double(rng.next() % 10_000) / 10_000.0
        if roll < dropRate { continue }  // camera never delivered this frame
        if roll < dropRate + missRate {
          let snapshot = evaluator.ingestMissing(timestampMs: t)
          XCTAssertFalse(snapshot.isReady, "seed \(seed): ready on a missing frame")
          firstStill = nil
          continue
        }
        let snapshot = evaluator.ingest(pose: stillPose(timestampMs: t))
        if firstStill == nil { firstStill = t }
        let observed = t - firstStill!
        totalFrames += 1
        if snapshot.isReady {
          readyFrames += 1
          XCTAssertGreaterThanOrEqual(observed, 450, "seed \(seed): ready after only \(observed) ms at t=\(t)")
          XCTAssertGreaterThanOrEqual(snapshot.stableForMs, 450, "seed \(seed): stableForMs \(snapshot.stableForMs)")
          XCTAssertLessThanOrEqual(snapshot.stableForMs, observed, "seed \(seed): stableForMs exceeds observation")
        } else {
          XCTAssertEqual(snapshot.state, .holdStill, "seed \(seed): still body not holdStill at t=\(t)")
          XCTAssertLessThan(observed, 450, "seed \(seed): \(observed) ms observed but not ready at t=\(t)")
          XCTAssertEqual(snapshot.stableForMs, 0, "seed \(seed)")
        }
      }
    }
    XCTAssertGreaterThan(readyFrames, 0)
    XCTAssertGreaterThan(totalFrames, readyFrames)
  }

  func testAttackSampleExactlyAtCutoffIsTheAnchorAndOneMsLaterIsNot() {
    let atCutoff = PoseReadinessEvaluator()
    _ = atCutoff.ingest(pose: stillPose(timestampMs: 1_000))
    let ready = atCutoff.ingest(pose: stillPose(timestampMs: 1_450))
    XCTAssertEqual(ready.state, .ready)
    XCTAssertEqual(ready.stableForMs, 450)

    let oneMsShort = PoseReadinessEvaluator()
    _ = oneMsShort.ingest(pose: stillPose(timestampMs: 1_001))
    let held = oneMsShort.ingest(pose: stillPose(timestampMs: 1_450))
    XCTAssertEqual(held.state, .holdStill)
    XCTAssertEqual(held.stableForMs, 0)
    XCTAssertEqual(oneMsShort.ingest(pose: stillPose(timestampMs: 1_451)).state, .ready)

    let oneMsPast = PoseReadinessEvaluator()
    _ = oneMsPast.ingest(pose: stillPose(timestampMs: 999))
    let past = oneMsPast.ingest(pose: stillPose(timestampMs: 1_450))
    XCTAssertEqual(past.state, .ready)
    XCTAssertEqual(past.stableForMs, 451)
  }

  /// Samples at t−460 and t−450 are both ≤ cutoff; only the newest may anchor,
  /// so the reported span is exactly 450 and the older sample cannot keep a
  /// pre-window movement alive.
  func testAttackTwoCandidatesAtOrBeforeCutoffKeepOnlyTheNewestAnchor() {
    let evaluator = PoseReadinessEvaluator()
    _ = evaluator.ingest(pose: stillPose(timestampMs: 540, xOffset: 0.05))  // t−460, swayed
    _ = evaluator.ingest(pose: stillPose(timestampMs: 550))  // t−450
    let ready = evaluator.ingest(pose: stillPose(timestampMs: 1_000))
    XCTAssertEqual(ready.state, .ready)
    XCTAssertEqual(ready.stableForMs, 450)
    // The t−460 sample (offset 0.05) must be gone: a new sample offset −0.03
    // is 0.03 from the anchor but 0.08 from the dropped one.
    let next = evaluator.ingest(pose: stillPose(timestampMs: 1_010, xOffset: -0.03))
    XCTAssertEqual(next.state, .ready, "stale pre-anchor sample still counted in pairwise travel")
  }

  /// Ready → one-frame jerk → still again: the jerk must both drop `ready` and
  /// force a FRESH 450 ms; the anchor logic must not retain pre-jerk samples.
  func testAttackSingleFrameJerkRequiresAFreshWindow() {
    let evaluator = PoseReadinessEvaluator()
    var t = 0
    while t <= 1_000 {
      _ = evaluator.ingest(pose: stillPose(timestampMs: t))
      t += 33
    }
    XCTAssertEqual(evaluator.ingest(pose: stillPose(timestampMs: 1_023)).state, .ready)
    let jerk = evaluator.ingest(pose: stillPose(timestampMs: 1_056, xOffset: 0.2))
    XCTAssertEqual(jerk.state, .holdStill)
    XCTAssertEqual(jerk.stableForMs, 0)
    // Back to the ORIGINAL centre: pre-jerk samples must not shorten the wait.
    var backAt = 1_089
    var firstStillAfterJerk: Int?
    while backAt < 1_089 + 900 {
      let snapshot = evaluator.ingest(pose: stillPose(timestampMs: backAt))
      if firstStillAfterJerk == nil { firstStillAfterJerk = backAt }
      let observed = backAt - firstStillAfterJerk!
      if observed < 450 {
        XCTAssertEqual(snapshot.state, .holdStill, "ready after only \(observed) ms post-jerk")
      } else {
        XCTAssertEqual(snapshot.state, .ready, "not ready after \(observed) ms post-jerk")
      }
      backAt += 33
    }
  }

  /// Every non-ready exit path must clear the window: leaving the frame,
  /// losing confidence, losing a mandatory joint, moving closer/farther. Re-entry
  /// within 450 ms must never be instantly ready.
  func testAttackEveryExitPathClearsTheWindowSoReEntryNeedsAFreshWindow() {
    let exits: [(String, PoseFrame)] = [
      ("frame edge", stillPose(timestampMs: 1_100, xOffset: 0.4)),
      ("low confidence", stillPose(timestampMs: 1_100, confidence: 0.2)),
      ("mandatory joint gone", stillPose(timestampMs: 1_100, removing: ["left_ankle"])),
      ("too small", stillPose(timestampMs: 1_100, heightScale: 0.3)),
      ("too tall", stillPose(timestampMs: 1_100, heightScale: 1.45)),
    ]
    for (label, exit) in exits {
      let evaluator = PoseReadinessEvaluator()
      var t = 0
      while t <= 1_000 {
        _ = evaluator.ingest(pose: stillPose(timestampMs: t))
        t += 33
      }
      XCTAssertEqual(evaluator.ingest(pose: stillPose(timestampMs: 1_056)).state, .ready, label)
      let gone = evaluator.ingest(pose: exit)
      XCTAssertNotEqual(gone.state, .ready, label)
      XCTAssertEqual(gone.stableForMs, 0, label)
      let back = evaluator.ingest(pose: stillPose(timestampMs: 1_150))
      XCTAssertEqual(back.state, .holdStill, "\(label): instantly ready on re-entry")
      XCTAssertEqual(evaluator.ingest(pose: stillPose(timestampMs: 1_599)).state, .holdStill, label)
      XCTAssertEqual(evaluator.ingest(pose: stillPose(timestampMs: 1_600)).state, .ready, label)
    }
    // Vision miss path.
    let evaluator = PoseReadinessEvaluator()
    _ = evaluator.ingest(pose: stillPose(timestampMs: 0))
    XCTAssertEqual(evaluator.ingest(pose: stillPose(timestampMs: 500)).state, .ready)
    XCTAssertEqual(evaluator.ingestMissing(timestampMs: 533).state, .noPerson)
    XCTAssertEqual(evaluator.ingest(pose: stillPose(timestampMs: 566)).state, .holdStill)
    XCTAssertEqual(evaluator.ingest(pose: stillPose(timestampMs: 1_015)).state, .holdStill)
    XCTAssertEqual(evaluator.ingest(pose: stillPose(timestampMs: 1_016)).state, .ready)
  }

  /// Slow drift: 0.012 per frame at 30 fps stays far under 0.055 per adjacent
  /// pair but crosses it across the window. The pairwise maximum must catch it
  /// and the walker must never be `ready`.
  func testAttackSlowDriftUnderPerPairToleranceNeverBecomesReady() {
    let evaluator = PoseReadinessEvaluator()
    var t = 0
    var x = -0.25
    while x <= 0.25 {
      let snapshot = evaluator.ingest(pose: stillPose(timestampMs: t, xOffset: x))
      XCTAssertNotEqual(snapshot.state, .ready, "drifting body ready at t=\(t)")
      t += 33
      x += 0.012
    }
  }

  /// Scale breathing: centre fixed, height oscillating ±0.05 (0.10 swing >
  /// `maximumScaleChange` 0.08) must never be `ready`; ±0.03 (0.06) must be.
  func testAttackScaleBreathingIsGatedByMaximumScaleChange() {
    let breathing = PoseReadinessEvaluator()
    var t = 0
    var i = 0
    while t <= 2_000 {
      let scale = i % 2 == 0 ? 0.93 : 1.07
      XCTAssertNotEqual(
        breathing.ingest(pose: stillPose(timestampMs: t, heightScale: scale)).state, .ready,
        "0.10 scale swing ready at t=\(t)"
      )
      t += 33
      i += 1
    }
    let gentle = PoseReadinessEvaluator()
    t = 0
    i = 0
    var ready = false
    while t <= 2_000 {
      let scale = i % 2 == 0 ? 0.96 : 1.04
      let snapshot = gentle.ingest(pose: stillPose(timestampMs: t, heightScale: scale))
      if t >= 483 { XCTAssertEqual(snapshot.state, .ready, "gentle breathing not ready at t=\(t)") }
      ready = ready || snapshot.isReady
      t += 33
      i += 1
    }
    XCTAssertTrue(ready)
  }

  /// A tie between duplicates keeps the FIRST occurrence (`>` not `>=`), so the
  /// provider's ordering is the tie-break — deterministic for a fixed frame.
  func testAttackDuplicateLandmarksWithEqualVisibilityResolveDeterministically() {
    let makeFrame: (Int, Bool) -> PoseFrame = { t, farFirst in
      var landmarks = self.stillPose(timestampMs: t).landmarks
      let far = PoseLandmark(name: "left_wrist", x: 0.01, y: 0.5, visibility: 0.95)  // inside the 0.025 margin
      if farFirst { landmarks.insert(far, at: 0) } else { landmarks.append(far) }
      return PoseFrame(timestampMs: t, landmarks: landmarks, confidence: 0.95)
    }
    // Far duplicate listed LAST → first (in-frame) wins → framing passes.
    let last = PoseReadinessEvaluator()
    XCTAssertEqual(last.ingest(pose: makeFrame(0, false)).state, .holdStill)
    XCTAssertEqual(last.ingest(pose: makeFrame(450, false)).state, .ready)
    // Far duplicate listed FIRST → it wins → wrist outside the margin.
    let first = PoseReadinessEvaluator()
    XCTAssertEqual(first.ingest(pose: makeFrame(0, true)).state, .fullBodyRequired)
    XCTAssertEqual(first.ingest(pose: makeFrame(450, true)).state, .fullBodyRequired)
  }

  /// A duplicate wrist with LOWER visibility must lose regardless of order.
  func testAttackLessVisibleDuplicateLosesRegardlessOfOrder() {
    for farFirst in [true, false] {
      let evaluator = PoseReadinessEvaluator()
      for t in [0, 450] {
        var landmarks = stillPose(timestampMs: t).landmarks
        let far = PoseLandmark(name: "left_wrist", x: 0.01, y: 0.5, visibility: 0.5)
        if farFirst { landmarks.insert(far, at: 0) } else { landmarks.append(far) }
        let snapshot = evaluator.ingest(pose: PoseFrame(timestampMs: t, landmarks: landmarks, confidence: 0.95))
        XCTAssertEqual(snapshot.state, t == 0 ? .holdStill : .ready, "farFirst=\(farFirst) t=\(t)")
      }
    }
  }

  // MARK: - Claim 1 attacks on unusual clocks

  /// Camera clocks never repeat a millisecond, but the evaluator is a public
  /// API: a stalled timestamp must not grow state without bound. Every frame
  /// at the same `t` appends a sample no anchor ever trims, and the pairwise
  /// travel scan is O(n²) per frame — n stalled frames cost O(n³) work (2 000
  /// frames measured at ~98 s in a debug build). Expected: bounded state ⇒ 600
  /// ingests complete in well under 0.5 s.
  func testAttackStalledTimestampDoesNotGrowStateOrWorkWithoutBound() {
    let evaluator = PoseReadinessEvaluator()
    let start = Date()
    for _ in 0..<600 {
      let snapshot = evaluator.ingest(pose: stillPose(timestampMs: 1_000))
      XCTAssertEqual(snapshot.state, .holdStill)
    }
    let elapsed = Date().timeIntervalSince(start)
    XCTAssertLessThan(elapsed, 0.5, "600 same-timestamp frames took \(elapsed)s — window grows without bound")
  }

  /// `cutoff = timestampMs - stableDurationMs` and `timestampMs - first` are
  /// unchecked `Int` subtractions: a timestamp within 450 of `Int.min` traps the
  /// process. Opt-in (`ATTACK_FIX10_TRAP=1`) because a trap aborts the whole
  /// XCTest run; no production clock produces such a value (P3).
  func testAttackIntMinTimestampDoesNotTrap() throws {
    try XCTSkipUnless(ProcessInfo.processInfo.environment["ATTACK_FIX10_TRAP"] == "1", "opt-in trap repro")
    let evaluator = PoseReadinessEvaluator()
    let snapshot = evaluator.ingest(pose: stillPose(timestampMs: Int.min + 100))
    XCTAssertEqual(snapshot.state, .holdStill)
  }

  /// A clock hiccup backwards must not make a still body ready EARLIER than a
  /// real 450 ms of observation counted on the new clock, and must not trap.
  func testAttackBackwardsClockNeverShortensTheWindow() {
    let evaluator = PoseReadinessEvaluator()
    var t = 0
    while t <= 1_000 {
      _ = evaluator.ingest(pose: stillPose(timestampMs: t))
      t += 33
    }
    XCTAssertEqual(evaluator.ingest(pose: stillPose(timestampMs: 1_023)).state, .ready)
    // Clock jumps back 1 s. Whatever the evaluator decides, it must not claim
    // more observed stillness than exists on either clock.
    var back = 23
    while back <= 1_500 {
      let snapshot = evaluator.ingest(pose: stillPose(timestampMs: back))
      if snapshot.isReady {
        XCTAssertGreaterThanOrEqual(snapshot.stableForMs, 450)
        XCTAssertLessThanOrEqual(snapshot.stableForMs, back - 23 + 1_023, "stableForMs exceeds total observation")
      }
      back += 33
    }
    XCTAssertEqual(evaluator.ingest(pose: stillPose(timestampMs: 1_533)).state, .ready)
  }

  /// Negative timestamps (a rebased clock) must behave exactly like positive ones.
  func testAttackNegativeTimestampsBehaveLikePositiveOnes() {
    let evaluator = PoseReadinessEvaluator()
    XCTAssertEqual(evaluator.ingest(pose: stillPose(timestampMs: -10_000)).state, .holdStill)
    XCTAssertEqual(evaluator.ingest(pose: stillPose(timestampMs: -9_551)).state, .holdStill)
    let ready = evaluator.ingest(pose: stillPose(timestampMs: -9_550))
    XCTAssertEqual(ready.state, .ready)
    XCTAssertEqual(ready.stableForMs, 450)
  }

  /// Two frames 100 s apart with no observation between them (no camera frame,
  /// no `ingestMissing`) is not "450 ms of observed stillness" — the athlete
  /// could have walked a lap. Expected: a gap wider than the window cannot by
  /// itself satisfy the window (cf. `PoseMotionTrail`'s bounded sample gap).
  func testAttackHugeUnobservedGapDoesNotCountAsObservedStillness() {
    let evaluator = PoseReadinessEvaluator()
    XCTAssertEqual(evaluator.ingest(pose: stillPose(timestampMs: 0)).state, .holdStill)
    let afterGap = evaluator.ingest(pose: stillPose(timestampMs: 100_000))
    XCTAssertNotEqual(afterGap.state, .ready, "ready from two samples 100 s apart with nothing observed between")
  }

  /// One arm point may go missing "briefly during a valid swing" (coverage
  /// gate ≥ 0.83), but a wrist that is the bounding-box extreme flickering
  /// below `minimumJointVisibility` shifts the centre by more than 0.055 and
  /// restarts the window on every flicker — a perfectly still athlete with an
  /// arm out and a noisy wrist can never become ready.
  func testAttackFlickeringExtremeWristDoesNotRestartTheWindow() {
    let evaluator = PoseReadinessEvaluator()
    var t = 0
    var frame = 0
    var everReady = false
    while t <= 3_000 {
      // Left arm extended: wrist at x=0.10 is the bounding-box minimum.
      var landmarks = stillPose(timestampMs: t).landmarks.filter { $0.name != "left_wrist" && $0.name != "left_elbow" }
      landmarks.append(PoseLandmark(name: "left_elbow", x: 0.25, y: 0.30, visibility: 0.95))
      let wristVisibility = frame % 6 == 5 ? 0.20 : 0.95  // every 6th frame the wrist dips
      landmarks.append(PoseLandmark(name: "left_wrist", x: 0.10, y: 0.30, visibility: wristVisibility))
      let snapshot = evaluator.ingest(pose: PoseFrame(timestampMs: t, landmarks: landmarks, confidence: 0.95))
      XCTAssertNotEqual(snapshot.state, .fullBodyRequired, "coverage gate should tolerate one wrist")
      everReady = everReady || snapshot.isReady
      t += 33
      frame += 1
    }
    XCTAssertTrue(everReady, "still athlete with one flickering wrist never became ready in 3 s")
  }

  // MARK: - Claim 3: non-finite and extreme values

  func testAttackEveryNonFiniteFieldIsDroppedIndividually() {
    let bad: [Double] = [.nan, .infinity, -.infinity]
    for value in bad {
      let x = PoseFrame(timestampMs: 0, landmarks: [PoseLandmark(name: "a", x: value, y: 0.5, visibility: 0.9)], confidence: 0.9)
      let y = PoseFrame(timestampMs: 0, landmarks: [PoseLandmark(name: "a", x: 0.5, y: value, visibility: 0.9)], confidence: 0.9)
      let v = PoseFrame(timestampMs: 0, landmarks: [PoseLandmark(name: "a", x: 0.5, y: 0.5, visibility: value)], confidence: 0.9)
      XCTAssertTrue(x.landmarks.isEmpty, "x=\(value)")
      XCTAssertTrue(y.landmarks.isEmpty, "y=\(value)")
      XCTAssertTrue(v.landmarks.isEmpty, "visibility=\(value)")
      let c = PoseFrame(timestampMs: 0, landmarks: [], confidence: value)
      XCTAssertEqual(c.confidence, 0, "confidence=\(value)")
    }
    // -0.0 and subnormals are finite and must be kept verbatim.
    let tiny = PoseFrame(
      timestampMs: 0,
      landmarks: [PoseLandmark(name: "a", x: -0.0, y: Double.leastNonzeroMagnitude, visibility: Double.leastNormalMagnitude)],
      confidence: -0.0
    )
    XCTAssertEqual(tiny.landmarks.count, 1)
    XCTAssertEqual(tiny.landmarks[0].x.sign, .minus)
    XCTAssertEqual(tiny.landmarks[0].y, Double.leastNonzeroMagnitude)
    XCTAssertEqual(tiny.confidence, 0)
  }

  /// A NaN/±inf/±1e308 frame fed to the readiness evaluator must never yield
  /// `ready`, must never poison a later real frame, and must not trap.
  func testAttackReadinessSurvivesNonFiniteAndExtremeFrames() {
    for value in [Double.nan, .infinity, -.infinity, 1e308, -1e308, Double.leastNonzeroMagnitude] {
      let evaluator = PoseReadinessEvaluator()
      _ = evaluator.ingest(pose: stillPose(timestampMs: 0))
      var landmarks = stillPose(timestampMs: 33).landmarks.filter { $0.name != "right_hip" }
      landmarks.append(PoseLandmark(name: "right_hip", x: value, y: 0.52, visibility: 0.95))
      let corrupt = evaluator.ingest(pose: PoseFrame(timestampMs: 33, landmarks: landmarks, confidence: 0.95))
      XCTAssertNotEqual(corrupt.state, .ready, "\(value)")
      XCTAssertTrue(Double(corrupt.stableForMs).isFinite)
      // Real frames afterwards: a fresh window must complete normally.
      _ = evaluator.ingest(pose: stillPose(timestampMs: 66))
      let ready = evaluator.ingest(pose: stillPose(timestampMs: 516))
      XCTAssertEqual(ready.state, .ready, "\(value): evaluator poisoned after one extreme frame")
    }
  }

  /// Finite-but-absurd coordinates pass the `isFinite` filter. ONE frame whose
  /// shoulders sit at −1e308 and ankles at +1e308 gives a body-scale span of
  /// `abs(1e308 − (−1e308))` = +inf; the EMA then computes `inf + 0.3 × (m − inf)`
  /// = NaN and `lastBodyScale` stays NaN for the rest of the session — every
  /// later speed is NaN and the detector is blind until `reset()`.
  /// Expected under claim 3: `lastBodyScale` finite after the next real frame.
  /// (Apple Vision emits normalized 0…1 coordinates; reaching this needs a
  /// bridge/provider bug, so it is a hardening gap, not a live-path crash.)
  func testAttackFiniteExtremeFrameCannotPoisonDetectorBodyScale() {
    let detector = TemporalStrokeDetector()
    _ = detector.ingest(pose: stillPose(timestampMs: 0), paddle: nil)
    let seeded = detector.lastBodyScale
    XCTAssertNotNil(seeded)
    var landmarks = stillPose(timestampMs: 33).landmarks.filter { !$0.name.hasSuffix("shoulder") && !$0.name.hasSuffix("ankle") }
    landmarks.append(PoseLandmark(name: "left_shoulder", x: 0.43, y: -1e308, visibility: 0.95))
    landmarks.append(PoseLandmark(name: "right_shoulder", x: 0.57, y: -1e308, visibility: 0.95))
    landmarks.append(PoseLandmark(name: "left_ankle", x: 0.44, y: 1e308, visibility: 0.95))
    landmarks.append(PoseLandmark(name: "right_ankle", x: 0.56, y: 1e308, visibility: 0.95))
    let corrupt = PoseFrame(timestampMs: 33, landmarks: landmarks, confidence: 0.95)
    XCTAssertEqual(corrupt.landmarks.count, 12, "±1e308 is finite and passes the filter")
    _ = detector.ingest(pose: corrupt, paddle: nil)
    var t = 66
    while t <= 66 + 33 * 300 {
      _ = detector.ingest(pose: stillPose(timestampMs: t), paddle: nil)
      t += 33
    }
    let scale = detector.lastBodyScale
    XCTAssertNotNil(scale)
    XCTAssertTrue(scale?.isFinite ?? false, "lastBodyScale = \(String(describing: scale)) 300 frames after one ±1e308 frame")
    if let scale, let seeded, scale.isFinite {
      XCTAssertEqual(scale, seeded, accuracy: seeded * 0.5, "scale still \(scale) vs true \(seeded)")
    }
  }

  /// A single +1e308 shoulder (span finite, 1e308) seeds the 30 % EMA with an
  /// absurd scale that takes ~2 000 frames (>60 s at 30 fps) to decay back to
  /// body size; meanwhile every hip-relative speed is ≈0 and no swing can
  /// trigger. Expected under claim 3: recovered within 300 frames (10 s).
  func testAttackFiniteHugeScaleRecoversWithinTenSeconds() {
    let detector = TemporalStrokeDetector()
    _ = detector.ingest(pose: stillPose(timestampMs: 0), paddle: nil)
    let seeded = detector.lastBodyScale!
    var landmarks = stillPose(timestampMs: 33).landmarks.filter { $0.name != "left_shoulder" }
    landmarks.append(PoseLandmark(name: "left_shoulder", x: 0.43, y: 1e308, visibility: 0.95))
    _ = detector.ingest(pose: PoseFrame(timestampMs: 33, landmarks: landmarks, confidence: 0.95), paddle: nil)
    var t = 66
    while t <= 66 + 33 * 300 {
      _ = detector.ingest(pose: stillPose(timestampMs: t), paddle: nil)
      t += 33
    }
    let scale = detector.lastBodyScale!
    XCTAssertTrue(scale.isFinite)
    XCTAssertEqual(scale, seeded, accuracy: seeded * 0.5, "scale still \(scale) vs true \(seeded) after 300 real frames")
  }

  /// `SessionMotionStream` speed for a finite-but-huge wrist jump overflows
  /// `dx*dx` to +inf, and the sample is handed to `onMotionSample` (RN bridge)
  /// as an infinite Double. Expected under claim 3: emitted samples are finite.
  func testAttackMotionStreamNeverEmitsANonFiniteSample() {
    let stream = SessionMotionStream()
    XCTAssertNil(stream.ingest(pose: stillPose(timestampMs: 0)))
    var landmarks = stillPose(timestampMs: 33).landmarks.filter { $0.name != "left_wrist" }
    landmarks.append(PoseLandmark(name: "left_wrist", x: 1e308, y: 0.5, visibility: 0.95))
    let sample = stream.ingest(pose: PoseFrame(timestampMs: 33, landmarks: landmarks, confidence: 0.95))
    if let sample {
      XCTAssertTrue(sample.value.isFinite, "emitted speed \(sample.value)")
    }
    // The state is two points, so the next real frame recovers.
    let back = stream.ingest(pose: stillPose(timestampMs: 66))
    XCTAssertNotNil(back)
    XCTAssertTrue(back?.value.isFinite ?? false)
    XCTAssertGreaterThan(back?.value ?? 0, 1e300, "right wrist still; left wrist returns from 1e308")
    XCTAssertEqual(stream.ingest(pose: stillPose(timestampMs: 99))?.value ?? -1, 0, accuracy: 1e-9)
  }

  /// Wide timestamp gaps: the gap rule (≤ 250 ms) must silence both consumers
  /// and never produce a speed, and the readiness evaluator must not trap.
  func testAttackVeryLargeTimestampGapsProduceNoSpeedAndNoTrap() {
    let stream = SessionMotionStream()
    let detector = TemporalStrokeDetector()
    _ = stream.ingest(pose: stillPose(timestampMs: 0))
    _ = detector.ingest(pose: stillPose(timestampMs: 0), paddle: nil)
    let far = 1 << 60
    XCTAssertNil(stream.ingest(pose: stillPose(timestampMs: far, xOffset: 0.1)))
    XCTAssertNil(detector.ingest(pose: stillPose(timestampMs: far, xOffset: 0.1), paddle: nil))
    XCTAssertTrue(detector.lastBodyScale?.isFinite ?? false)
    let evaluator = PoseReadinessEvaluator()
    _ = evaluator.ingest(pose: stillPose(timestampMs: 0))
    let snapshot = evaluator.ingest(pose: stillPose(timestampMs: far))
    XCTAssertTrue(Double(snapshot.stableForMs).isFinite)
  }

  /// `CaptureEvidenceAccumulator` sums must stay finite through NaN, ±inf and
  /// ±1e308 joints (its own [0,1] filter is the second line of defence).
  func testAttackEvidenceAccumulatorStaysFiniteThroughExtremeJoints() {
    let accumulator = CaptureEvidenceAccumulator()
    var t = 0
    for value in [Double.nan, .infinity, -.infinity, 1e308, -1e308] {
      accumulator.ingest(pose: stillPose(timestampMs: t))
      var landmarks = stillPose(timestampMs: t + 33).landmarks.filter { $0.name != "right_wrist" }
      landmarks.append(PoseLandmark(name: "right_wrist", x: value, y: value, visibility: 0.95))
      accumulator.ingest(pose: PoseFrame(timestampMs: t + 33, landmarks: landmarks, confidence: 0.95))
      accumulator.ingest(pose: stillPose(timestampMs: t + 66, xOffset: 0.01))
      t += 99
    }
    guard let summary = accumulator.summary(
      startMs: 0, endMs: t, poseSource: "test", poseModelVersion: "test", triggerAlgorithmVersion: "test"
    ) else {
      return XCTFail("no summary")
    }
    XCTAssertTrue(summary.meanCanonicalJointVisibility.isFinite)
    XCTAssertTrue(summary.meanJointCoverage.isFinite)
    XCTAssertTrue(summary.minimumJointCoverage.isFinite)
    for motion in summary.jointMotion {
      XCTAssertTrue(motion.meanNormalizedPerSecond.isFinite, motion.joint)
      XCTAssertTrue(motion.peakNormalizedPerSecond.isFinite, motion.joint)
      XCTAssertGreaterThanOrEqual(motion.meanNormalizedPerSecond, 0, motion.joint)
    }
  }

  // MARK: - Claim 2: duplicates in downstream consumers

  /// `SessionMotionStream` iterates `landmarks` directly: with two `left_wrist`
  /// entries the FIRST produces the speed and the LAST overwrites `lastPoints`,
  /// so the stored point is whichever duplicate the provider listed last — not
  /// the more visible one. Expected under claim 2: the more-visible duplicate
  /// wins, so a barely-visible duplicate at the frame edge must not become the
  /// reference for the next frame's speed.
  func testAttackMotionStreamDuplicateWristMoreVisibleWins() {
    let stream = SessionMotionStream()
    _ = stream.ingest(pose: stillPose(timestampMs: 0))
    var landmarks = stillPose(timestampMs: 33).landmarks
    landmarks.append(PoseLandmark(name: "left_wrist", x: 0.02, y: 0.02, visibility: 0.36))  // ghost duplicate, listed last
    let dup = stream.ingest(pose: PoseFrame(timestampMs: 33, landmarks: landmarks, confidence: 0.95))
    XCTAssertEqual(dup?.value ?? -1, 0, accuracy: 1e-9, "duplicate frame speed should come from the visible wrist")
    // Next real frame: the still wrist is where it always was → speed ≈ 0.
    let next = stream.ingest(pose: stillPose(timestampMs: 66))
    XCTAssertEqual(next?.value ?? -1, 0, accuracy: 1e-6, "speed measured against the ghost duplicate: \(String(describing: next?.value))")
  }

  /// Same shape in `TemporalStrokeDetector`: a ghost duplicate hip listed last
  /// becomes the hip anchor and a ghost wrist becomes `lastPoints` — the next
  /// real frame reads a body-relative jump that can cross the trigger.
  func testAttackDetectorDuplicateWristAndHipMoreVisibleWins() {
    let detector = TemporalStrokeDetector()
    var t = 0
    // Quiet run so a trigger is even possible.
    while t <= 600 {
      _ = detector.ingest(pose: stillPose(timestampMs: t), paddle: nil)
      t += 33
    }
    var landmarks = stillPose(timestampMs: t).landmarks
    landmarks.append(PoseLandmark(name: "right_wrist", x: 0.03, y: 0.03, visibility: 0.36))
    landmarks.append(PoseLandmark(name: "left_hip", x: 0.97, y: 0.97, visibility: 0.36))
    XCTAssertNil(detector.ingest(pose: PoseFrame(timestampMs: t, landmarks: landmarks, confidence: 0.95), paddle: nil))
    t += 33
    // Body perfectly still; an event or candidate here comes only from the ghost.
    var events = 0
    while t <= 2_000 {
      if detector.ingest(pose: stillPose(timestampMs: t), paddle: nil) != nil { events += 1 }
      t += 33
    }
    XCTAssertEqual(events, 0, "still body produced a stroke event after one ghost-duplicate frame")
  }

  /// Duplicates do not double-count: the same wrist listed twice with identical
  /// coordinates must produce exactly the same speed as listed once.
  func testAttackIdenticalDuplicateDoesNotDoubleCountSpeed() {
    let once = SessionMotionStream()
    let twice = SessionMotionStream()
    _ = once.ingest(pose: stillPose(timestampMs: 0))
    _ = twice.ingest(pose: stillPose(timestampMs: 0))
    let moved = stillPose(timestampMs: 33, xOffset: 0.1)
    let doubled = PoseFrame(timestampMs: 33, landmarks: moved.landmarks + moved.landmarks, confidence: 0.95)
    XCTAssertEqual(once.ingest(pose: moved)?.value, twice.ingest(pose: doubled)?.value)
  }

  // MARK: - Helpers

  private func stillPose(
    timestampMs: Int,
    xOffset: Double = 0,
    heightScale: Double = 1,
    confidence: Double = 0.95,
    removing names: Set<String> = []
  ) -> PoseFrame {
    let points: [(String, Double, Double)] = [
      ("left_shoulder", 0.43, 0.25), ("right_shoulder", 0.57, 0.25),
      ("left_elbow", 0.39, 0.38), ("right_elbow", 0.61, 0.38),
      ("left_wrist", 0.36, 0.50), ("right_wrist", 0.64, 0.50),
      ("left_hip", 0.45, 0.52), ("right_hip", 0.55, 0.52),
      ("left_knee", 0.45, 0.70), ("right_knee", 0.55, 0.70),
      ("left_ankle", 0.44, 0.90), ("right_ankle", 0.56, 0.90),
    ]
    let centerY = 0.575
    return PoseFrame(
      timestampMs: timestampMs,
      landmarks: points.compactMap { name, x, y in
        guard !names.contains(name) else { return nil }
        return PoseLandmark(name: name, x: x + xOffset, y: centerY + (y - centerY) * heightScale, visibility: 0.95)
      },
      confidence: confidence
    )
  }
}

private struct SplitMix64 {
  private var state: UInt64
  init(seed: UInt64) { state = seed }
  mutating func next() -> UInt64 {
    state &+= 0x9E37_79B9_7F4A_7C15
    var z = state
    z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
    z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
    return z ^ (z >> 31)
  }
}
