import XCTest
@testable import PickleVisionCore

/// Adversarial pass 3, tester #2 (scenarios S08–S14) against 4d812e1a.
///
/// Every test here PINS the behaviour the code exhibits today so the suite is
/// green; the ones whose pinned behaviour is a gap say so in their doc comment
/// and have a red twin in `AdversarialPass3Tester2GapTests` that asserts the
/// behaviour we would want. Integer-overflow traps (S09 family) cannot share a
/// process with anything else and live in
/// `AdversarialPass3Tester2TrapTests`. Both of those suites are harness-only
/// (tools/attack/native-vision-core-linux-proxy-2/tests) so this package's
/// test target — and the Mac gate — stays green.
///
/// Private state (`PoseReadinessEvaluator.stableSamples`,
/// `CaptureEvidenceAccumulator.attempts`) is read through `Mirror`; a test
/// FAILS (never skips) if the property cannot be found, so a rename shows up
/// here rather than silently weakening the assertion.
final class AdversarialPass3Tester2Tests: XCTestCase {
  private let cadenceMs = 40
  private let readyFrames = 11
  /// Same drive as `TemporalStrokeDetectorTests.driveDeltas` (peak 2.0 bh/s).
  private let driveDeltas: [Double] = [0.06, 0.08, 0.07, 0.06, 0.05, 0.04, 0.03, 0.016, 0.008, 0.004, 0.004]

  // MARK: - S08 · degenerate full body (12 joints on one coordinate)

  func testS08_pointBodyIsMoveCloserAndNeverAccumulatesStableEvidence() {
    let evaluator = PoseReadinessEvaluator()
    for step in 0...30 {
      let snapshot = evaluator.ingest(pose: pointBody(at: step * 30, x: 0.5, y: 0.5))
      XCTAssertEqual(snapshot.state, .moveCloser, "t=\(step * 30)")
      XCTAssertEqual(snapshot.stableForMs, 0, "t=\(step * 30)")
      XCTAssertEqual(snapshot.jointCoverage, 1.0, accuracy: 1e-12)
      XCTAssertTrue(snapshot.missingJoints.isEmpty)
      XCTAssertEqual(stableSampleCount(evaluator), 0, "stableSamples must not accumulate for a zero-height body")
    }
  }

  func testS08_pointBodyOnTheFrameEdgeIsFullBodyRequiredNotReady() {
    // (0,0) and (1,1) fail the frame-margin gate before the height gate; a
    // point exactly on the margin is still "outside" (strict comparison).
    let evaluator = PoseReadinessEvaluator()
    let margin = PoseReadinessEvaluator.Config().frameMargin
    for (x, y) in [(0.0, 0.0), (1.0, 1.0), (margin, 0.5), (0.5, 1 - margin)] {
      for step in 0...20 {
        let snapshot = evaluator.ingest(pose: pointBody(at: step * 30, x: x, y: y))
        XCTAssertEqual(snapshot.state, .fullBodyRequired, "point (\(x), \(y)) t=\(step * 30)")
        XCTAssertEqual(snapshot.stableForMs, 0)
      }
      XCTAssertEqual(stableSampleCount(evaluator), 0)
    }
  }

  func testS08_pointBodyClearsAnEarnedReadyStateAndTheNextRealFrameStartsOver() {
    let evaluator = PoseReadinessEvaluator()
    for t in stride(from: 0, through: 450, by: 150) { _ = evaluator.ingest(pose: realBody(at: t)) }
    XCTAssertEqual(evaluator.ingest(pose: realBody(at: 600)).state, .ready)
    XCTAssertGreaterThan(stableSampleCount(evaluator), 0)

    XCTAssertEqual(evaluator.ingest(pose: pointBody(at: 630, x: 0.5, y: 0.5)).state, .moveCloser)
    XCTAssertEqual(stableSampleCount(evaluator), 0)

    // Evidence restarts from the next real frame: 1 sample, holdStill, 0 ms.
    let restarted = evaluator.ingest(pose: realBody(at: 660))
    XCTAssertEqual(restarted.state, .holdStill)
    XCTAssertEqual(restarted.stableForMs, 0)
    XCTAssertEqual(stableSampleCount(evaluator), 1)
    // …and needs the full window again even though 450 ms of ready evidence
    // existed 60 ms ago.
    XCTAssertEqual(evaluator.ingest(pose: realBody(at: 1_050)).state, .holdStill)
    XCTAssertEqual(evaluator.ingest(pose: realBody(at: 1_110)).state, .ready)
  }

  func testS08_pointBodyAlternatingWithRealFramesNeverReachesReady() {
    // Corrupt state probe: every other frame collapses to a point. The real
    // frames alone would be ready after 450 ms; the collapses keep wiping the
    // evidence so the evaluator must never say ready.
    let evaluator = PoseReadinessEvaluator()
    for step in 0..<200 {
      let t = step * 30
      let pose = step.isMultiple(of: 2) ? realBody(at: t) : pointBody(at: t, x: 0.5, y: 0.5)
      let snapshot = evaluator.ingest(pose: pose)
      XCTAssertNotEqual(snapshot.state, .ready, "t=\(t)")
      XCTAssertLessThanOrEqual(stableSampleCount(evaluator), 1, "t=\(t)")
    }
  }

  func testS08_zeroWidthBodyWithRealHeightIsAcceptedAsReady() {
    // Documented observation (NOT a finding): only the height gate exists.
    // Twelve joints on ONE vertical line (width = 0, height 0.65) pass framing
    // and become ready after 450 ms — a real edge-on athlete has a small but
    // non-zero width, so the evaluator treats width as uninformative.
    let evaluator = PoseReadinessEvaluator()
    for t in stride(from: 0, to: 450, by: 150) {
      XCTAssertEqual(evaluator.ingest(pose: verticalLineBody(at: t)).state, .holdStill)
    }
    XCTAssertEqual(evaluator.ingest(pose: verticalLineBody(at: 450)).state, .ready)
  }

  // MARK: - S11 · CaptureEvidenceAccumulator retention at one timestamp

  /// Pins today's behaviour: retention is purely temporal (`timestampMs <
  /// latest - retentionMs`), so attempts that never advance the clock are
  /// never pruned. The red twin in the gap suite asserts a count bound. 20 000
  /// (not 100 000) keeps the -Onone proxy run under a minute — every `append`
  /// re-scans the whole array, O(n²) overall; the 100 000-call variant is the
  /// gap test with a wall-clock budget.
  func testS11_sameTimestampIngestMissingIsRetainedUnboundedByRetention() {
    let accumulator = CaptureEvidenceAccumulator(retentionMs: 4_000)
    let calls = 20_000
    for _ in 0..<calls { accumulator.ingestMissing(timestampMs: 1_000) }
    XCTAssertEqual(attemptCount(accumulator), calls)

    // One later frame past retention prunes them all at once.
    accumulator.ingestMissing(timestampMs: 1_000 + 4_000 + 1)
    XCTAssertEqual(attemptCount(accumulator), 1)
  }

  func testS11_sameTimestampAttemptsAreAllCountedByTheWindowSummary() {
    // The retained duplicates are not inert: they all land in
    // `analysisInputFrameCount` / `poseMissingFrameCount` of any window that
    // contains the timestamp, so a stuck clock inflates evidence counts.
    let accumulator = CaptureEvidenceAccumulator(retentionMs: 4_000)
    accumulator.ingest(pose: realBody(at: 1_000))
    for _ in 0..<500 { accumulator.ingestMissing(timestampMs: 1_000) }
    accumulator.ingest(pose: realBody(at: 1_040))
    let summary = accumulator.summary(
      startMs: 900, endMs: 1_100, poseSource: "t", poseModelVersion: "t", triggerAlgorithmVersion: "t"
    )
    XCTAssertEqual(summary?.analysisInputFrameCount, 502)
    XCTAssertEqual(summary?.poseMissingFrameCount, 500)
    XCTAssertEqual(summary?.poseFrameCount, 2)
    // Duplicates at one timestamp sort into the middle of the two poses and
    // reset `previous`, so the motion between the two real frames is lost.
    XCTAssertEqual(summary?.jointMotion.count, 0)
  }

  func testS11_advancingClockKeepsAttemptsBoundedByRetention() {
    // Control: a clock that advances (even by 1 ms per call) is pruned to the
    // retention window — 4 001 attempts for retention 4 000 (inclusive
    // cutoff), no matter how many calls.
    let accumulator = CaptureEvidenceAccumulator(retentionMs: 4_000)
    for t in 0..<20_000 { accumulator.ingestMissing(timestampMs: t) }
    XCTAssertEqual(attemptCount(accumulator), 4_001)
  }

  // MARK: - S12 · PoseReadinessEvaluator pairwise travel is O(n²) per frame

  /// Pins the cost model: `maximumPairwiseTravel` visits n² pairs per ingest
  /// over the retained window, so the time to ingest k frames inside one
  /// 450 ms window grows ~k³. Measured on the same machine in the same
  /// process, 900 frames must cost at least 8× the 300-frame run (ideal
  /// cubic is 27×; linear would be 3×) — a generous floor that survives
  /// timer noise but fails if the loop ever becomes linear or the window
  /// starts dropping duplicates. The absolute numbers are printed for the
  /// artifact; the 5 000-frame variant with a wall-clock budget is the gap
  /// test.
  func testS12_ingestCostGrowsSuperlinearlyWithFramesInsideOneWindow() {
    let small = secondsToIngest(frames: 300, windowMs: 450)
    let large = secondsToIngest(frames: 900, windowMs: 450)
    print("S12 timing: 300 frames in one 450 ms window = \(small)s; 900 frames = \(large)s; ratio \(large / small)")
    XCTAssertGreaterThan(large, small * 8, "300 frames: \(small)s, 900 frames: \(large)s")
    XCTAssertEqual(stableSampleCountAfterBurst(frames: 900, windowMs: 450), 900)
  }

  func testS12_frameRateBoundedBurstStaysCheap() {
    // Control for realism: 240 fps over the 450 ms window is 108 frames, the
    // worst case a capture device can produce. Ingesting 5 000 frames at that
    // cadence (retention keeps ≤ 109) stays within a few seconds even at
    // -Onone (≈ 60 M pair visits).
    let evaluator = PoseReadinessEvaluator()
    let start = Date()
    var readyCount = 0
    for step in 0..<5_000 {
      let t = (step * 1_000) / 240
      if evaluator.ingest(pose: realBody(at: t)).state == .ready { readyCount += 1 }
    }
    let seconds = Date().timeIntervalSince(start)
    print("S12 timing: 5 000 frames at 240 fps = \(seconds)s")
    XCTAssertLessThan(seconds, 5.0, "5 000 frames at 240 fps took \(seconds)s")
    XCTAssertGreaterThan(readyCount, 4_800)
    XCTAssertLessThanOrEqual(stableSampleCount(evaluator), 110)
  }

  // MARK: - S13 · strongestEvent tie-break

  func testS13_strongestEventReturnsTheFirstOfTwoIdenticalDrives() {
    // Drive (closes 840, capped 0.95), hold through refractory (300) + a fresh
    // quiet run (250) — 11 still samples 880…1280 — then the identical drive
    // (trigger 1320, onset 1280). Confidence ties at the 0.95 cap and `>=`
    // keeps the FIRST event.
    let path = move(hold(ready(then: driveDeltas), for: 11), by: driveDeltas)
    let frames = poses(bodySpan: 0.5, path: path)

    let live = TemporalStrokeDetector(config: TemporalStrokeDetector.manualStopConfig)
    let events = frames.compactMap { live.ingest(pose: $0, paddle: nil) }
    XCTAssertEqual(events.count, 2, "fixture must produce two events")
    XCTAssertEqual(events.map(\.startMs), [400, 1_280])
    XCTAssertEqual(events[0].confidence, events[1].confidence, accuracy: 1e-12)
    XCTAssertEqual(events[0].confidence, 0.95, accuracy: 1e-12)

    let strongest = TemporalStrokeDetector.strongestEvent(in: frames)
    XCTAssertEqual(strongest?.startMs, 400)
    XCTAssertEqual(strongest?.endMs, 840)
  }

  func testS13_confidenceCapMakesAFasterSecondDriveLoseToTheFirst() {
    // Pinned GAP (see the gap suite): the cap at 0.95 (peak ≥ 1.44 bh/s under
    // manualStopConfig) erases ordering above it, so a second swing that is
    // 50 % faster than the first still ties and the first is returned. In the
    // product this is STOP & ANALYZE picking the OLDEST saturated swing in
    // the 15 s history, not the one the athlete just made.
    // The faster drive settles one sample later (0.3 at 1640), so a short
    // hold lets its 160 ms settle window close at 1760.
    let faster = driveDeltas.map { $0 * 1.5 }
    let path = hold(move(hold(ready(then: driveDeltas), for: 11), by: faster), for: 5)
    let frames = poses(bodySpan: 0.5, path: path)
    let pass = TemporalStrokeDetector(config: TemporalStrokeDetector.manualStopConfig)
    let events = frames.compactMap { pass.ingest(pose: $0, paddle: nil) }
    XCTAssertEqual(events.map(\.startMs), [400, 1_280])
    XCTAssertEqual(events.map(\.endMs), [840, 1_760])
    XCTAssertEqual(events.map(\.confidence), [0.95, 0.95])
    XCTAssertEqual(TemporalStrokeDetector.strongestEvent(in: frames)?.startMs, 400)
  }

  func testS13_strictlyStrongerLaterEventStillWins() {
    // Control: below the cap the comparison is a real ordering. First swing at
    // 0.7× (peak 1.4 → 0.9375, path 0.295 ≥ 0.25, closes 840), then the full
    // drive (capped 0.95) — the later, stronger one is returned.
    let path = move(hold(ready(then: driveDeltas.map { $0 * 0.7 }), for: 11), by: driveDeltas)
    let frames = poses(bodySpan: 0.5, path: path)
    let pass = TemporalStrokeDetector(config: TemporalStrokeDetector.manualStopConfig)
    let events = frames.compactMap { pass.ingest(pose: $0, paddle: nil) }
    XCTAssertEqual(events.map(\.startMs), [400, 1_280])
    XCTAssertEqual(events.first?.confidence ?? 0, 0.5 + 1.4 / 3.2, accuracy: 1e-9)
    let strongest = TemporalStrokeDetector.strongestEvent(in: frames)
    XCTAssertEqual(strongest?.startMs, 1_280)
    XCTAssertEqual(strongest?.confidence ?? 0, 0.95, accuracy: 1e-12)
  }

  // MARK: - S14 · body span below minimumMeasurableBodyScale

  func testS14_bodyBelowMinimumSpanUsesFallbackScaleAndLeavesLastBodyScaleNil() {
    let detector = TemporalStrokeDetector()
    // Span 0.04 from shoulders to ankles; hips at 0.42 × 0.04 = 0.0168 → × 2.2
    // = 0.037: both measurements are under 0.05 → nil, fallback 0.5.
    for t in stride(from: 0, through: 400, by: cadenceMs) {
      XCTAssertNil(detector.ingest(pose: tinyBody(at: t, span: 0.04, wristImageX: 0.55), paddle: nil))
      XCTAssertNil(detector.lastBodyScale, "t=\(t)")
    }
    // Speeds are normalized by 0.5: the drive expressed in IMAGE units as
    // 0.5 × driveDeltas reads exactly like the canonical drive (peak 2.0 bh/s,
    // confidence 0.5 + 2.0 / 4.6 — not capped under the live config).
    var x = 0.55
    var event: StrokeEvent?
    for (index, delta) in driveDeltas.enumerated() {
      x -= delta * TemporalStrokeDetector.fallbackBodyScale
      let t = 400 + (index + 1) * cadenceMs
      if let e = detector.ingest(pose: tinyBody(at: t, span: 0.04, wristImageX: x), paddle: nil) { event = e }
      XCTAssertNil(detector.lastBodyScale, "t=\(t)")
    }
    XCTAssertNotNil(event, "drive scaled by the fallback must trigger exactly like the canonical drive")
    XCTAssertEqual(event?.startMs, 400)
    XCTAssertEqual(event?.endMs, 840)
    XCTAssertEqual(event?.peakMotionMs, 480)
    XCTAssertEqual(event?.confidence ?? 0, 0.5 + 2.0 / (1.15 * 4), accuracy: 1e-9)
  }

  func testS14_sameImageMotionAtTheTinyBodysOwnScaleDoesNotTrigger() {
    // Control: had the 0.04 span been used as the scale, the same image motion
    // would read 12.5× faster. Conversely, motion that IS a drive for a 0.04
    // body (0.04 × driveDeltas in image units) is 0.16 bh/s under the fallback
    // and never triggers.
    let detector = TemporalStrokeDetector()
    for t in stride(from: 0, through: 400, by: cadenceMs) {
      _ = detector.ingest(pose: tinyBody(at: t, span: 0.04, wristImageX: 0.55), paddle: nil)
    }
    var x = 0.55
    for (index, delta) in driveDeltas.enumerated() {
      x -= delta * 0.04
      XCTAssertNil(detector.ingest(pose: tinyBody(at: 400 + (index + 1) * cadenceMs, span: 0.04, wristImageX: x), paddle: nil))
    }
    for t in stride(from: 880, through: 1_400, by: cadenceMs) {
      XCTAssertNil(detector.ingest(pose: tinyBody(at: t, span: 0.04, wristImageX: x), paddle: nil))
    }
    XCTAssertNil(detector.lastBodyScale)
  }

  func testS14_minimumMeasurableSpanBoundaryIsInclusiveAt0_05() {
    let atMinimum = TemporalStrokeDetector()
    _ = atMinimum.ingest(pose: tinyBody(at: 0, span: 0.05, wristImageX: 0.55), paddle: nil)
    XCTAssertEqual(atMinimum.lastBodyScale ?? -1, 0.05, accuracy: 1e-12)

    let justUnder = TemporalStrokeDetector()
    _ = justUnder.ingest(pose: tinyBody(at: 0, span: 0.05 - 1e-9, wristImageX: 0.55), paddle: nil)
    XCTAssertNil(justUnder.lastBodyScale)

    // Hips-only path: ankles hidden, hip span 0.0228 × 2.2 = 0.05016 ≥ 0.05.
    let hipsOnly = TemporalStrokeDetector()
    _ = hipsOnly.ingest(pose: tinyBody(at: 0, span: 0.0228 / 0.42, wristImageX: 0.55, removing: ["left_ankle", "right_ankle"]), paddle: nil)
    XCTAssertEqual(hipsOnly.lastBodyScale ?? -1, 0.0228 * 2.2, accuracy: 1e-9)
  }

  func testS14_tinyBodyAfterARealScaleKeepsTheRealScale() {
    let detector = TemporalStrokeDetector()
    _ = detector.ingest(pose: tinyBody(at: 0, span: 0.5, wristImageX: 0.55), paddle: nil)
    XCTAssertEqual(detector.lastBodyScale ?? -1, 0.5, accuracy: 1e-12)
    for t in stride(from: 40, through: 2_000, by: cadenceMs) {
      _ = detector.ingest(pose: tinyBody(at: t, span: 0.04, wristImageX: 0.55), paddle: nil)
      XCTAssertEqual(detector.lastBodyScale ?? -1, 0.5, accuracy: 1e-12, "collapsed frames must not blend into the EMA")
    }
    detector.reset()
    XCTAssertNil(detector.lastBodyScale)
    _ = detector.ingest(pose: tinyBody(at: 2_040, span: 0.04, wristImageX: 0.55), paddle: nil)
    XCTAssertNil(detector.lastBodyScale)
  }

  // MARK: - S09 · in-range near-Int.max timestamps (no overflow in this window)

  func testS09_driveEndingBeforeIntMaxMinus700DoesNotTrap() {
    // Timestamps Int.max-5000 … Int.max-1000 as assigned: the drive closes at
    // start+840 = Int.max-4160, so `endMs + 700` fits. The trap for
    // endMs > Int.max-700 is in AdversarialPass3Tester2TrapTests.
    let start = Int.max - 5_000
    let path = hold(ready(then: driveDeltas), for: 79) // 22 + 79 frames → last at start+4000
    let frames = poses(bodySpan: 0.5, path: path, startMs: start)
    XCTAssertEqual(frames.last?.timestampMs, Int.max - 1_000)
    let detector = TemporalStrokeDetector()
    let events = frames.compactMap { detector.ingest(pose: $0, paddle: nil) }
    XCTAssertEqual(events.count, 1)
    XCTAssertEqual(events.first?.startMs, start + 400)
    XCTAssertEqual(events.first?.endMs, start + 840)
    XCTAssertEqual(events.first?.peakMotionMs, start + 480)

    // Readiness over the same window: `timestampMs - 450` is fine up here.
    let evaluator = PoseReadinessEvaluator()
    var sawReady = false
    for t in stride(from: start, through: Int.max - 1_000, by: 150) {
      if evaluator.ingest(pose: realBody(at: t)).state == .ready { sawReady = true }
    }
    XCTAssertTrue(sawReady)

    // Evidence accumulator over the same window.
    let accumulator = CaptureEvidenceAccumulator()
    for frame in frames { accumulator.ingest(pose: frame) }
    let summary = accumulator.summary(
      startMs: start + 400, endMs: start + 840, poseSource: "t", poseModelVersion: "t", triggerAlgorithmVersion: "t"
    )
    XCTAssertEqual(summary?.poseFrameCount, 12)
  }

  func testS09_refractoryComparisonHoldsRightUpToTheBoundary() {
    // A drive ending at exactly Int.max-700 sets refractoryUntilMs = Int.max
    // without trapping and the comparison `timestampMs >= refractoryUntilMs`
    // stays false for every later representable frame.
    let start = Int.max - 700 - 840
    let frames = poses(bodySpan: 0.5, path: hold(ready(then: driveDeltas), for: 17), startMs: start)
    XCTAssertEqual(frames.last?.timestampMs, Int.max - 20)
    let detector = TemporalStrokeDetector()
    let events = frames.compactMap { detector.ingest(pose: $0, paddle: nil) }
    XCTAssertEqual(events.map(\.endMs), [Int.max - 700])
  }

  // MARK: - S10 · timestamps regress 2000 ms mid-candidate (pinned behaviour)

  /// Pins today's behaviour so the gap is visible: after the clock jumps back
  /// the candidate is NOT dropped — `elapsed` is negative, which neither the
  /// maxStrokeMs nor the minStrokeMs gate treats as an error — and it survives
  /// until the regressed clock climbs back past triggerMs + minStrokeMs, where
  /// it completes with `startMs` from the OLD clock and `endMs` from the NEW
  /// one. The red twin in the gap suite asserts a drop-or-reset instead.
  func testS10_clockRegressionMidCandidateKeepsTheCandidateOpenUntilTheClockCatchesUp() {
    let detector = TemporalStrokeDetector()
    let drive = poses(bodySpan: 0.5, path: ready(then: driveDeltas))
    // Ready position + 3 drive samples: trigger crossed at 440 (triggerMs 400),
    // candidate open at t = 520.
    for frame in drive.prefix(readyFrames + 3) { XCTAssertNil(detector.ingest(pose: frame, paddle: nil)) }

    // Re-send the SAME frames 2000 ms earlier, then keep holding still on the
    // regressed clock. Record every emission.
    let regressed = drive.map { shift($0, by: -2_000) }
    var emitted: [(atMs: Int, event: StrokeEvent)] = []
    for frame in regressed {
      if let event = detector.ingest(pose: frame, paddle: nil) { emitted.append((frame.timestampMs, event)) }
    }
    XCTAssertTrue(emitted.isEmpty, "no event while elapsed is negative")
    let lastRegressed = regressed.last!
    let restX = lastRegressed.landmarks.first { $0.name == "right_wrist" }!.x
    var t = lastRegressed.timestampMs
    for _ in 0..<120 {
      t += cadenceMs
      if let event = detector.ingest(pose: stillBody(at: t, rightWristX: restX), paddle: nil) { emitted.append((t, event)) }
    }
    XCTAssertEqual(emitted.count, 1)
    let (atMs, event) = emitted[0]
    // Completes on the first regressed-clock sample with elapsed ≥ 250 and a
    // settled run ≥ 160: t = 680 (frames run -2000 + 40k).
    XCTAssertEqual(atMs, 680)
    XCTAssertEqual(event.startMs, 400, "onset from the pre-regression clock")
    XCTAssertEqual(event.endMs, 680, "end from the post-regression clock")
    XCTAssertEqual(event.peakMotionMs, 480)
    // The re-sent drive (regressed -1560…-1160) lies OUTSIDE the emitted
    // window, which contains no motion at all.
    XCTAssertFalse((event.startMs...event.endMs).contains(-1_560))
  }

  /// Pinned GAP: `reset()` (and `init`) leave `refractoryUntilMs = 0`, and the
  /// trigger guard is `timestampMs >= refractoryUntilMs`, so a clock that is
  /// negative after the reset can never trigger — the regressed drive is
  /// silently lost even though the reset was the correct recovery. The same
  /// frames on a non-negative clock are detected. Both feeders in the app
  /// (CameraEngine host-clock ms, PickleVideoCapture elapsed-from-anchor ms)
  /// produce ≥ 0, so this is unreachable from a device today.
  func testS10_resetDuringTheRegressionLeavesANegativeClockUnableToTrigger() {
    let detector = TemporalStrokeDetector()
    let drive = poses(bodySpan: 0.5, path: ready(then: driveDeltas))
    for frame in drive.prefix(readyFrames + 3) { XCTAssertNil(detector.ingest(pose: frame, paddle: nil)) }
    detector.reset()
    let negative = drive.map { shift($0, by: -2_000) }.compactMap { detector.ingest(pose: $0, paddle: nil) }
    XCTAssertEqual(negative.map(\.startMs), [], "refractoryUntilMs = 0 blocks every trigger on a negative clock")

    let fresh = TemporalStrokeDetector()
    XCTAssertEqual(drive.map { shift($0, by: -2_000) }.compactMap { fresh.ingest(pose: $0, paddle: nil) }.count, 0)

    // Control: reset, then the same regressed drive re-based at t ≥ 0.
    detector.reset()
    let positive = drive.map { shift($0, by: 3_000) }.compactMap { detector.ingest(pose: $0, paddle: nil) }
    XCTAssertEqual(positive.map(\.startMs), [3_400])
    XCTAssertEqual(positive.map(\.endMs), [3_840])
  }

  func testS10_equalTimestampRepeatsMidCandidateAreIgnoredButOverwriteTheAnchor() {
    // Rapid repeat: the same frame delivered 50× with an identical timestamp
    // inside a candidate produces no samples (strict `>`), and the candidate
    // continues normally once time advances.
    let detector = TemporalStrokeDetector()
    let drive = poses(bodySpan: 0.5, path: ready(then: driveDeltas))
    for frame in drive.prefix(readyFrames + 3) { XCTAssertNil(detector.ingest(pose: frame, paddle: nil)) }
    for _ in 0..<50 { XCTAssertNil(detector.ingest(pose: drive[readyFrames + 2], paddle: nil)) }
    let events = drive.dropFirst(readyFrames + 3).compactMap { detector.ingest(pose: $0, paddle: nil) }
    XCTAssertEqual(events.map(\.startMs), [400])
    XCTAssertEqual(events.map(\.endMs), [840])
  }

  // MARK: - Reflection helpers

  private func stableSampleCount(_ evaluator: PoseReadinessEvaluator) -> Int {
    guard let samples = Mirror(reflecting: evaluator).descendant("stableSamples") else {
      XCTFail("PoseReadinessEvaluator.stableSamples not found via Mirror")
      return -1
    }
    return Mirror(reflecting: samples).children.count
  }

  private func attemptCount(_ accumulator: CaptureEvidenceAccumulator) -> Int {
    guard let attempts = Mirror(reflecting: accumulator).descendant("attempts") else {
      XCTFail("CaptureEvidenceAccumulator.attempts not found via Mirror")
      return -1
    }
    return Mirror(reflecting: attempts).children.count
  }

  // MARK: - Timing helpers

  private func secondsToIngest(frames: Int, windowMs: Int) -> TimeInterval {
    let evaluator = PoseReadinessEvaluator()
    let start = Date()
    for step in 0..<frames {
      _ = evaluator.ingest(pose: realBody(at: (step * windowMs) / frames))
    }
    return Date().timeIntervalSince(start)
  }

  private func stableSampleCountAfterBurst(frames: Int, windowMs: Int) -> Int {
    let evaluator = PoseReadinessEvaluator()
    for step in 0..<frames { _ = evaluator.ingest(pose: realBody(at: (step * windowMs) / frames)) }
    return stableSampleCount(evaluator)
  }

  // MARK: - Pose fixtures

  private static let jointNames = [
    "left_shoulder", "right_shoulder", "left_elbow", "right_elbow", "left_wrist", "right_wrist",
    "left_hip", "right_hip", "left_knee", "right_knee", "left_ankle", "right_ankle",
  ]

  /// All 12 required joints on one coordinate.
  private func pointBody(at timestampMs: Int, x: Double, y: Double) -> PoseFrame {
    PoseFrame(
      timestampMs: timestampMs,
      landmarks: Self.jointNames.map { PoseLandmark(name: $0, x: x, y: y, visibility: 0.95) },
      confidence: 0.95
    )
  }

  /// All 12 joints on x = 0.5 with the real body's y layout (height 0.65).
  private func verticalLineBody(at timestampMs: Int) -> PoseFrame {
    let ys = [0.25, 0.25, 0.38, 0.38, 0.50, 0.50, 0.52, 0.52, 0.70, 0.70, 0.90, 0.90]
    return PoseFrame(
      timestampMs: timestampMs,
      landmarks: zip(Self.jointNames, ys).map { PoseLandmark(name: $0, x: 0.5, y: $1, visibility: 0.95) },
      confidence: 0.95
    )
  }

  /// The readiness suite's well-framed body (height 0.65, width 0.28).
  private func realBody(at timestampMs: Int) -> PoseFrame {
    let points: [(Double, Double)] = [
      (0.43, 0.25), (0.57, 0.25), (0.39, 0.38), (0.61, 0.38), (0.36, 0.50), (0.64, 0.50),
      (0.45, 0.52), (0.55, 0.52), (0.45, 0.70), (0.55, 0.70), (0.44, 0.90), (0.56, 0.90),
    ]
    return PoseFrame(
      timestampMs: timestampMs,
      landmarks: zip(Self.jointNames, points).map { PoseLandmark(name: $0, x: $1.0, y: $1.1, visibility: 0.95) },
      confidence: 0.95
    )
  }

  /// A body of vertical span `span` centred in the frame whose right wrist sits
  /// at absolute image x `wristImageX` (so image-space motion can be dialled
  /// independently of the body's own scale).
  private func tinyBody(
    at timestampMs: Int,
    span: Double,
    wristImageX: Double,
    removing names: Set<String> = []
  ) -> PoseFrame {
    let template: [(name: String, x: Double, y: Double)] = [
      ("left_shoulder", -0.12, 0.0), ("right_shoulder", 0.12, 0.0),
      ("left_elbow", -0.16, 0.22), ("right_elbow", 0.16, 0.22),
      ("left_wrist", -0.18, 0.42), ("right_wrist", 0.18, 0.42),
      ("left_hip", -0.08, 0.42), ("right_hip", 0.08, 0.42),
      ("left_knee", -0.08, 0.72), ("right_knee", 0.08, 0.72),
      ("left_ankle", -0.09, 1.0), ("right_ankle", 0.09, 1.0),
    ]
    let shoulderY = 0.5 - span / 2
    return PoseFrame(
      timestampMs: timestampMs,
      landmarks: template.compactMap { name, x, y in
        guard !names.contains(name) else { return nil }
        return PoseLandmark(
          name: name,
          x: name == "right_wrist" ? wristImageX : 0.5 + x * span,
          y: shoulderY + y * span,
          visibility: 0.95
        )
      },
      confidence: 0.95
    )
  }

  /// The detector suite's full body at `bodySpan`, right wrist displaced by
  /// `wristOffset` body-heights.
  private func fullBodyPose(at timestampMs: Int, bodySpan: Double, wristOffset: Double) -> PoseFrame {
    tinyBody(at: timestampMs, span: bodySpan, wristImageX: 0.5 + (0.18 - wristOffset) * bodySpan)
  }

  private func stillBody(at timestampMs: Int, rightWristX: Double) -> PoseFrame {
    tinyBody(at: timestampMs, span: 0.5, wristImageX: rightWristX)
  }

  private func shift(_ frame: PoseFrame, by deltaMs: Int) -> PoseFrame {
    PoseFrame(timestampMs: frame.timestampMs + deltaMs, landmarks: frame.landmarks, confidence: frame.confidence)
  }

  private func poses(bodySpan: Double, path: [Double], startMs: Int = 0) -> [PoseFrame] {
    path.enumerated().map { index, offset in
      fullBodyPose(at: startMs + index * cadenceMs, bodySpan: bodySpan, wristOffset: offset)
    }
  }

  private func stillPath(_ count: Int, at offset: Double = 0) -> [Double] {
    Array(repeating: offset, count: count)
  }

  private func cumulative(_ deltas: [Double], from start: Double = 0) -> [Double] {
    var offset = start
    return deltas.map { delta in
      offset += delta
      return offset
    }
  }

  private func ready(then deltas: [Double]) -> [Double] {
    move(stillPath(readyFrames), by: deltas)
  }

  private func move(_ path: [Double], by deltas: [Double]) -> [Double] {
    path + cumulative(deltas, from: path.last ?? 0)
  }

  private func hold(_ path: [Double], for count: Int) -> [Double] {
    path + stillPath(count, at: path.last ?? 0)
  }
}
