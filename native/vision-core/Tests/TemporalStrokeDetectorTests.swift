import XCTest
@testable import PickleVisionCore

/// Heuristic-4 semantics: wrist speed is measured RELATIVE TO THE HIPS and
/// normalized by the observed body scale (shoulder-mid → ankle-mid vertical
/// span), so thresholds are in body-heights per second of the athlete's own
/// motion — walking (body translation) and camera bumps read ≈ 0. A stroke
/// must grow out of a QUIET ONSET: a ≥ 350 ms run of samples ≤ 0.45 bh/s that
/// ended within 1.2 s of the trigger crossing; its last quiet sample is the
/// event's `startMs`. The event closes at the sample completing 160 ms
/// continuously ≤ 0.5 bh/s (`endMs`), and the swinging wrist must have covered
/// ≥ 0.3 bh since the trigger.
///
/// Fixtures express wrist paths in body-heights and let the pose builder scale
/// them into image coordinates. Every fixture opens with 400 ms of stillness —
/// the ready position — unless it is testing the absence of one.
final class TemporalStrokeDetectorTests: XCTestCase {
  /// Sample cadence used by every path fixture (25 fps keeps the arithmetic
  /// exact: 0.04 s intervals).
  private let cadenceMs = 40

  /// The ready position: 11 still samples at t = 0…400 ms. Their quiet run
  /// spans [0, 400] = 400 ms ≥ 350, so a swing starting at t = 440 has its
  /// onset — and `startMs` — at 400.
  private let readyFrames = 11

  /// Moderate forehand drive as per-interval deltas (body-heights per 40 ms):
  /// speeds 1.5, 2.0, 1.75, 1.5, 1.25, 1.0, 0.75, 0.4, 0.2, 0.1, 0.1 bh/s;
  /// path 0.422 bh. After the ready position: trigger at 440 (start = 400),
  /// peak at 480, settled (≤ 0.5) from 720, the 160 ms settle window
  /// completes at 840 → event(start 400, end 840, peak 480).
  private let driveDeltas: [Double] = [0.06, 0.08, 0.07, 0.06, 0.05, 0.04, 0.03, 0.016, 0.008, 0.004, 0.004]

  /// Dink / soft reset: ≈ 1.2 body-heights/s (≈ 2 m/s) for 280 ms then
  /// settling. Speeds 1.25, 1.2 ×6, 0.7, 0.3, 0.1, 0.1, 0.1; path 0.39 bh.
  /// After the ready position: trigger/peak at 440, settled from 760, closes
  /// at 880.
  private let dinkDeltas: [Double] = [0.05, 0.048, 0.048, 0.048, 0.048, 0.048, 0.048, 0.028, 0.012, 0.004, 0.004, 0.004]

  /// Soft dink at ≈ 0.9 body-heights/s: below the live trigger (1.15) but a
  /// deliberate arm movement. Speeds 1.0, 0.9 ×7, 0.4, 0.2, 0.1 ×3 (the first
  /// sample is the distinct peak); path 0.328 bh. After the ready position the
  /// samples run 440…920.
  private let softDinkDeltas: [Double] = [0.04, 0.036, 0.036, 0.036, 0.036, 0.036, 0.036, 0.036, 0.016, 0.008, 0.004, 0.004, 0.004]

  // MARK: - Version & tunables

  func testModelVersionIsHeuristic5() {
    XCTAssertEqual(TemporalStrokeDetector().modelVersion, "temporal-stroke-heuristic-5")
  }

  func testConfigDefaultsArePinned() {
    let config = TemporalStrokeDetector.Config()
    XCTAssertEqual(config.triggerWristSpeed, 1.15)
    XCTAssertEqual(config.endWristSpeed, 0.5)
    XCTAssertEqual(config.minStrokeMs, 250)
    XCTAssertEqual(config.maxStrokeMs, 2_200)
    XCTAssertEqual(config.refractoryMs, 700)
    XCTAssertEqual(config.minPoseConfidence, 0.5)
    XCTAssertEqual(config.quietWristSpeed, 0.45)
    XCTAssertEqual(config.minQuietBeforeMs, 350)
    XCTAssertEqual(config.maxOnsetToTriggerMs, 1_200)
    XCTAssertEqual(config.minWristPathBodyHeights, 0.3)
    XCTAssertNil(config.handedness)
    XCTAssertEqual(TemporalStrokeDetector.Handedness(rawValue: "left"), .left)
    XCTAssertEqual(TemporalStrokeDetector.Handedness(rawValue: "right"), .right)
    XCTAssertNil(TemporalStrokeDetector.Handedness(rawValue: "unknown"))
    XCTAssertEqual(TemporalStrokeDetector.settledWindowMs, 160)
    XCTAssertEqual(TemporalStrokeDetector.maximumSampleGapMs, 250)
    XCTAssertEqual(TemporalStrokeDetector.minimumLandmarkVisibility, 0.35)

    // The heuristic-3 initializer shape still compiles and picks up the new
    // defaults.
    let legacy = TemporalStrokeDetector.Config(
      triggerWristSpeed: 1.0,
      endWristSpeed: 0.4,
      minStrokeMs: 100,
      maxStrokeMs: 1_000,
      refractoryMs: 200,
      minPoseConfidence: 0.6
    )
    XCTAssertEqual(legacy.quietWristSpeed, 0.45)
    XCTAssertEqual(legacy.minQuietBeforeMs, 350)
    XCTAssertEqual(legacy.maxOnsetToTriggerMs, 1_200)
    XCTAssertEqual(legacy.minWristPathBodyHeights, 0.3)
    XCTAssertNil(legacy.handedness)
  }

  func testManualStopConfigIsPinned() {
    let config = TemporalStrokeDetector.manualStopConfig
    XCTAssertEqual(config.triggerWristSpeed, 0.8)
    XCTAssertEqual(config.endWristSpeed, 0.5)
    XCTAssertEqual(config.minStrokeMs, 200)
    XCTAssertEqual(config.maxStrokeMs, 2_500)
    XCTAssertEqual(config.refractoryMs, 300)
    XCTAssertEqual(config.minPoseConfidence, 0.5)
    XCTAssertEqual(config.quietWristSpeed, 0.45)
    XCTAssertEqual(config.minQuietBeforeMs, 250)
    XCTAssertEqual(config.maxOnsetToTriggerMs, 1_500)
    XCTAssertEqual(config.minWristPathBodyHeights, 0.25)
    XCTAssertNil(config.handedness)
  }

  // MARK: - Distance invariance & window semantics

  func testSameDriveEmitsIdenticalEventAtTwoBodyScales() {
    let path = ready(then: driveDeltas)
    let large = TemporalStrokeDetector()
    let small = TemporalStrokeDetector()
    let largeEvents = run(large, poses(bodySpan: 0.55, path: path))
    let smallEvents = run(small, poses(bodySpan: 0.35, path: path))

    XCTAssertEqual(largeEvents.count, 1)
    XCTAssertEqual(smallEvents.count, 1)
    guard let big = largeEvents.first, let little = smallEvents.first else { return }

    XCTAssertEqual(big.tMs, 840)
    XCTAssertEqual(little.tMs, 840)
    XCTAssertEqual(big.event.startMs, little.event.startMs)
    XCTAssertEqual(big.event.endMs, little.event.endMs)
    XCTAssertEqual(big.event.peakMotionMs, little.event.peakMotionMs)
    XCTAssertEqual(big.event.confidence, little.event.confidence, accuracy: 1e-9)

    // startMs is the ONSET — the last quiet sample (400) — not the trigger
    // crossing (440).
    XCTAssertEqual(big.event.startMs, 400)
    // endMs is the sample completing 160 ms continuously ≤ 0.5 bh/s: settled
    // samples at 720 (0.4), 760, 800, 840 → the run [680, 840] reaches 160 at
    // 840. The window therefore carries a settled tail, not just the swing.
    XCTAssertEqual(big.event.endMs, 840)
    // Fastest sample: 2.0 bh/s over 440 → 480.
    XCTAssertEqual(big.event.peakMotionMs, 480)
    // 0.5 + peakSpeed / (trigger × 4) with peak 2.0 bh/s, trigger 1.15 bh/s.
    XCTAssertEqual(big.event.confidence, 0.5 + 2.0 / (1.15 * 4), accuracy: 1e-9)

    // The body scale the speeds were normalized by is the shoulder→ankle span.
    XCTAssertEqual(large.lastBodyScale ?? -1, 0.55, accuracy: 1e-9)
    XCTAssertEqual(small.lastBodyScale ?? -1, 0.35, accuracy: 1e-9)
  }

  func testDetectedMotionDoesNotClaimAStrokeClass() {
    let events = run(TemporalStrokeDetector(), poses(bodySpan: 0.4, path: ready(then: driveDeltas)))
    XCTAssertEqual(events.count, 1)
    let event = events.first?.event
    XCTAssertEqual(event?.recognition.status, .unknown)
    XCTAssertEqual(event?.recognition.reason, "validated_classifier_unavailable")
    XCTAssertNil(event?.recognition.shotType)
  }

  func testDinkSpeedMotionTriggersAtAlignmentGuideFraming() {
    // At the alignment-guide framing (body span 0.4) 1.2 bh/s is only 0.48
    // image-units/s — heuristic-2's 0.9 trigger could never see it.
    let events = run(TemporalStrokeDetector(), poses(bodySpan: 0.4, path: ready(then: dinkDeltas)))
    XCTAssertEqual(events.count, 1)
    XCTAssertEqual(events.first?.tMs, 880)
    XCTAssertEqual(events.first?.event.startMs, 400)
    XCTAssertEqual(events.first?.event.endMs, 880)
    XCTAssertEqual(events.first?.event.peakMotionMs, 440)
  }

  func testNoisySampleRestartsTheSettleWindow() {
    // Drive, settled at 720 (0.4) and 760 (0.2), then one 0.7 bh/s sample at
    // 800 (above end 0.5, below trigger): the settle run restarts at 800 and
    // completes 160 ms later, at 960 — the window still ends on a settled tail.
    let deltas: [Double] = [0.06, 0.08, 0.07, 0.06, 0.05, 0.04, 0.03, 0.016, 0.008, 0.028, 0.008, 0.004, 0.004, 0.004]
    let events = run(TemporalStrokeDetector(), poses(bodySpan: 0.45, path: ready(then: deltas)))
    XCTAssertEqual(events.count, 1)
    XCTAssertEqual(events.first?.tMs, 960)
    XCTAssertEqual(events.first?.event.startMs, 400)
    XCTAssertEqual(events.first?.event.endMs, 960)
  }

  func testOtherWristCannotCloseTheStrokeWhenTheSwingingWristIsHidden() {
    // The right wrist drives through its first settled sample (720, 0.4 bh/s)
    // and then disappears; the still left wrist cannot prove it has settled.
    // The window waits for the same right wrist's fresh observed settled run
    // [880, 1040]. Path (0.406 bh) had already cleared the gate.
    let path = ready(then: Array(driveDeltas.prefix(8)))
    var frames = poses(bodySpan: 0.45, path: path)
    let hiddenFrom = frames.count
    for index in 0..<3 {
      frames.append(fullBodyPose(
        at: (hiddenFrom + index) * cadenceMs,
        bodySpan: 0.45,
        wristOffset: path.last!,
        removing: ["right_wrist"]
      ))
    }
    let detector = TemporalStrokeDetector()
    XCTAssertTrue(run(detector, frames).isEmpty, "a still off hand cannot finish the hidden wrist's stroke")
    let observedAgain = stride(from: 880, through: 1_040, by: cadenceMs).map {
      fullBodyPose(at: $0, bodySpan: 0.45, wristOffset: path.last!)
    }
    let events = run(detector, observedAgain)
    XCTAssertEqual(events.count, 1)
    XCTAssertEqual(events.first?.tMs, 1_040)
    XCTAssertEqual(events.first?.event.startMs, 400)
    XCTAssertEqual(events.first?.event.endMs, 1_040)
    XCTAssertEqual(events.first?.event.peakMotionMs, 480)
  }

  // MARK: - Walking (heuristic-3's false positive)

  func testWalkingWithBodyTranslationNeverTriggers() {
    // Ready position, then 3 s of walking across the frame: the whole body
    // translates at 0.8 bh/s while the arm swings as a ±0.5 bh/s triangle wave
    // (amplitude 0.2 bh, 800 ms period).
    var path = stillPath(readyFrames)
    var body = stillPath(readyFrames)
    for step in 1...75 {
      let phase = step % 20
      path.append(0.02 * Double(phase <= 10 ? phase : 20 - phase))
      body.append(0.032 * Double(step))
    }
    let frames = poses(bodySpan: 0.4, path: path, bodyPath: body)
    XCTAssertTrue(run(TemporalStrokeDetector(), frames).isEmpty)

    // What heuristic-3 saw — ABSOLUTE image motion: 0.8 + 0.5 = 1.3 bh/s on
    // the forward arm swing (over the 1.15 trigger) and 0.8 − 0.5 = 0.3 on the
    // backward swing (under its 0.35 end speed): a bogus event every stride.
    let absolute = absoluteRightWristSpeeds(frames, bodySpan: 0.4)
    XCTAssertEqual(absolute.max() ?? 0, 1.3, accuracy: 1e-6)
    guard let firstFast = absolute.firstIndex(where: { $0 >= 1.15 }) else {
      return XCTFail("fixture must cross the heuristic-3 trigger")
    }
    XCTAssertTrue(absolute[firstFast...].contains { $0 <= 0.35 })

    // What heuristic-4 sees — motion RELATIVE to the hips: only the arm swing,
    // a constant 0.5 bh/s that never reaches the trigger and, being above the
    // 0.45 quiet speed, never rests long enough to be a stroke onset either.
    let relative = relativeRightWristSpeeds(frames, bodySpan: 0.4)
    XCTAssertEqual(relative.dropFirst(readyFrames - 1).max() ?? 0, 0.5, accuracy: 1e-6)
    XCTAssertEqual(relative.dropFirst(readyFrames - 1).min() ?? 0, 0.5, accuracy: 1e-6)
  }

  func testWalkingInPlaceArmSwingNeverTriggers() {
    // Triangle wave: 0.024 bh per 40 ms = 0.6 bh/s sustained, amplitude 0.24 bh,
    // 800 ms period, held for 3 s after the ready position. Never quiet, never
    // over the trigger.
    var path = stillPath(readyFrames)
    for step in 1...75 {
      let phase = step % 20
      path.append(0.024 * Double(phase <= 10 ? phase : 20 - phase))
    }
    XCTAssertTrue(run(TemporalStrokeDetector(), poses(bodySpan: 0.35, path: path)).isEmpty)
    XCTAssertTrue(run(TemporalStrokeDetector(), poses(bodySpan: 0.55, path: path)).isEmpty)
  }

  func testContinuousFidgetingHidesASwingBecauseItsPausesAreTooShort() {
    // A sinusoidal arm swing (peak 0.7 bh/s, 800 ms period) dips under the
    // 0.45 quiet speed for ~160 ms around every reversal — the "150–250 ms"
    // walking pattern. A 2.0 bh/s burst launched straight out of one of those
    // reversals has no ≥ 350 ms quiet run behind it, so it never opens.
    let periodS = 0.8
    let amplitude = 0.7 * periodS / (2 * Double.pi)
    var path = stillPath(readyFrames)
    for step in 1...47 { // t' = 40 … 1880 ms; 1880 is 80 ms past a reversal
      path.append(amplitude * sin(2 * Double.pi * Double(step * cadenceMs) / 1_000 / periodS))
    }
    let burst: [Double] = [0.08, 0.08, 0.08, 0.08, 0.08, 0.016, 0.008, 0.004, 0.004, 0.004, 0.004]
    path = move(path, by: burst)
    let frames = poses(bodySpan: 0.4, path: path)

    // Document the fixture: the longest quiet run inside the fidgeting is
    // ≥ 120 ms (the dips are real) and < 350 ms.
    let speeds = relativeRightWristSpeeds(frames, bodySpan: 0.4)
    let fidget = Array(speeds[(readyFrames - 1)..<(readyFrames - 1 + 47)])
    let longestQuietRunMs = longestRun(in: fidget, where: { $0 <= 0.45 }) * cadenceMs
    XCTAssertGreaterThanOrEqual(longestQuietRunMs, 120)
    XCTAssertLessThan(longestQuietRunMs, 350)
    XCTAssertLessThan(fidget.max() ?? 0, 1.15)

    XCTAssertTrue(run(TemporalStrokeDetector(), frames).isEmpty)

    // Control: a detector that accepts 120 ms pauses as onsets opens on the
    // burst, with startMs = the last sample of the pause before it (2280).
    let lenient = TemporalStrokeDetector(config: .init(minQuietBeforeMs: 120))
    let events = run(lenient, frames)
    XCTAssertEqual(events.count, 1)
    XCTAssertEqual(events.first?.event.startMs, 2_280)
    XCTAssertEqual(events.first?.event.endMs, 2_640)
  }

  // MARK: - Quiet onset

  func testSwingWithoutQuietOnsetIsIgnoredAndTheSameSwingAfterStillnessIsDetected() {
    // Motion from the very first interval: no quiet run exists, so the drive
    // never opens a candidate.
    let abrupt = poses(bodySpan: 0.4, path: [0] + cumulative(driveDeltas))
    XCTAssertTrue(run(TemporalStrokeDetector(), abrupt).isEmpty)

    // The same drive preceded by 400 ms of stillness is detected, starting at
    // the last still sample.
    let events = run(TemporalStrokeDetector(), poses(bodySpan: 0.4, path: ready(then: driveDeltas)))
    XCTAssertEqual(events.count, 1)
    XCTAssertEqual(events.first?.event.startMs, 400)

    // The abrupt drive's own settled tail (0.4, 0.2, 0.1, 0.1 from 280) plus a
    // hold builds a fresh quiet run, so a SECOND drive after it is detected —
    // the detector was not stuck, it just had no ready position to start from.
    let abruptThenReady = move(hold([0] + cumulative(driveDeltas), for: 8), by: driveDeltas)
    let later = run(TemporalStrokeDetector(), poses(bodySpan: 0.4, path: abruptThenReady))
    XCTAssertEqual(later.count, 1)
    // Quiet run: 0.4 at 280 through the hold's last sample at 760 → onset 760.
    XCTAssertEqual(later.first?.event.startMs, 760)
  }

  func testQuietRunMustLastAtLeastMinQuietBeforeMs() {
    // 9 still samples: run [0, 320] = 320 ms < 350 → the drive at 360 cannot open.
    let tooShort = move(stillPath(9), by: driveDeltas)
    XCTAssertTrue(run(TemporalStrokeDetector(), poses(bodySpan: 0.4, path: tooShort)).isEmpty)

    // 10 still samples: run [0, 360] = 360 ms ≥ 350 → detected, start = 360.
    let longEnough = move(stillPath(10), by: driveDeltas)
    let events = run(TemporalStrokeDetector(), poses(bodySpan: 0.4, path: longEnough))
    XCTAssertEqual(events.count, 1)
    XCTAssertEqual(events.first?.event.startMs, 360)
    XCTAssertEqual(events.first?.event.endMs, 800)
  }

  func testQuietRunTooLongBeforeTheTriggerDoesNotQualify() {
    // Ready position, then 0.7 bh/s of moderate motion (a triangle wave, never
    // quiet, never over the trigger) for 1.52 s, then the drive. The quiet run
    // ended at 400 and the trigger crossing comes at 1960: 1560 ms later, past
    // the 1200 ms onset horizon → no event.
    let moderate = (1...38).map { step -> Double in
      let phase = step % 20
      return 0.028 * Double(phase <= 10 ? phase : 20 - phase)
    }
    let stale = move(stillPath(readyFrames) + moderate, by: driveDeltas)
    XCTAssertTrue(run(TemporalStrokeDetector(), poses(bodySpan: 0.4, path: stale)).isEmpty)

    // Control: 0.72 s of the same moderate motion keeps the trigger (at 1160)
    // within the horizon of the onset at 400, which becomes startMs — the
    // window includes the moderate lead-in as the backswing.
    let fresh = move(stillPath(readyFrames) + Array(moderate.prefix(18)), by: driveDeltas)
    let events = run(TemporalStrokeDetector(), poses(bodySpan: 0.4, path: fresh))
    XCTAssertEqual(events.count, 1)
    XCTAssertEqual(events.first?.event.startMs, 400)
    XCTAssertEqual(events.first?.event.peakMotionMs, 1_200)
    XCTAssertEqual(events.first?.event.endMs, 1_560)
  }

  // MARK: - Path gate

  func testTinyFastFlickIsDroppedByThePathGate() {
    // Two 1.4 bh/s samples (440, 480) then still through 720: peak well over
    // the trigger, but the wrist covers only 0.12 bh (< 0.3). The candidate
    // reaches minStrokeMs and the settle window at 680 and is dropped there,
    // silently.
    let flick: [Double] = [0.056, 0.056, 0.008, 0, 0, 0, 0, 0]
    let flickOnly = ready(then: flick)
    XCTAssertTrue(run(TemporalStrokeDetector(), poses(bodySpan: 0.4, path: flickOnly)).isEmpty)

    // A dropped flick leaves no refractory; a fresh quiet run (680 → 1080) and
    // a real drive right after it (trigger 1120) are detected normally.
    let flickThenDrive = move(hold(flickOnly, for: 9), by: driveDeltas)
    let events = run(TemporalStrokeDetector(), poses(bodySpan: 0.4, path: flickThenDrive))
    XCTAssertEqual(events.count, 1)
    XCTAssertEqual(events.first?.event.startMs, 1_080)
    XCTAssertEqual(events.first?.event.endMs, 1_520)
  }

  func testServeTossOnOffHandDoesNotStarveThePathGate() {
    // A serve: the OFF hand's ball toss crosses the trigger first (one fast
    // 1.5 bh/s sample, 0.06 bh of path, then it stops), and the paddle hand
    // swings a full drive 80 ms later. The candidate opened on the off hand;
    // the path gate must read the paddle hand's 0.42 bh, not the toss's 0.06.
    let bodySpan = 0.4
    var frames: [PoseFrame] = []
    var t = 0
    for _ in 0..<readyFrames {
      frames.append(fullBodyPose(at: t, bodySpan: bodySpan))
      t += cadenceMs
    }
    // Toss: left wrist jumps 0.06 bh (1.5 bh/s) then holds.
    let leftOffset = 0.06
    frames.append(fullBodyPose(at: t, bodySpan: bodySpan, leftWristOffset: leftOffset))
    t += cadenceMs
    frames.append(fullBodyPose(at: t, bodySpan: bodySpan, leftWristOffset: leftOffset))
    t += cadenceMs
    // Paddle hand drive while the off hand holds still.
    var rightOffset = 0.0
    for delta in driveDeltas {
      rightOffset += delta
      frames.append(fullBodyPose(at: t, bodySpan: bodySpan, wristOffset: rightOffset, leftWristOffset: leftOffset))
      t += cadenceMs
    }
    let detector = TemporalStrokeDetector()
    let events = frames.compactMap { detector.ingest(pose: $0, paddle: nil) }
    XCTAssertEqual(events.count, 1, "the serve must be emitted even though the toss opened the candidate")
    XCTAssertEqual(events.first?.startMs, 400)
  }

  // MARK: - Camera bump

  func testCameraBumpReadsAsNoMotion() {
    // Ready position, then the whole body — hips and wrists together — jumps
    // 0.3 of the frame in one interval (the phone was knocked), then stillness,
    // then a drive from 840.
    let bodySpan = 0.4
    let jump = 0.3 / bodySpan // body-heights
    let path = ready(then: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] + driveDeltas)
    let body = stillPath(readyFrames) + Array(repeating: jump, count: path.count - readyFrames)
    let frames = poses(bodySpan: bodySpan, path: path, bodyPath: body)

    // Heuristic-3 read the bump as an 18.75 bh/s wrist.
    XCTAssertGreaterThan(absoluteRightWristSpeeds(frames, bodySpan: bodySpan)[readyFrames - 1], 1.15)

    // Heuristic-4: the bump interval is 0 bh/s relative to the hips, so the
    // quiet run continues straight through it and the drive's onset is the
    // last still sample, 800. Exactly one event, and it is the drive.
    let events = run(TemporalStrokeDetector(), frames)
    XCTAssertEqual(events.count, 1)
    XCTAssertEqual(events.first?.event.startMs, 800)
    XCTAssertEqual(events.first?.event.endMs, 1_240)
    XCTAssertEqual(events.first?.event.peakMotionMs, 880)
  }

  // MARK: - Sample-gap gate

  func testWristSamplesMoreThan250MsApartYieldNoSpeed() {
    let detector = TemporalStrokeDetector()
    for frame in poses(bodySpan: 0.5, path: stillPath(readyFrames)) {
      XCTAssertNil(detector.ingest(pose: frame, paddle: nil))
    }
    // 0.6 bh in 300 ms would be 2.0 bh/s, but the 300 ms gap exceeds the gate.
    XCTAssertNil(detector.ingest(pose: fullBodyPose(at: 700, bodySpan: 0.5, wristOffset: 0.6), paddle: nil))
    // A settled wrist afterwards never completes anything: no candidate opened.
    for tMs in stride(from: 740, through: 1_100, by: cadenceMs) {
      XCTAssertNil(detector.ingest(pose: fullBodyPose(at: tMs, bodySpan: 0.5, wristOffset: 0.6), paddle: nil))
    }
  }

  func testWristSamplesExactly250MsApartStillCount() {
    let detector = TemporalStrokeDetector()
    for frame in poses(bodySpan: 0.5, path: stillPath(readyFrames)) {
      XCTAssertNil(detector.ingest(pose: frame, paddle: nil))
    }
    // 0.4 bh in 250 ms = 1.6 bh/s ≥ trigger: candidate opens; onset 400.
    XCTAssertNil(detector.ingest(pose: fullBodyPose(at: 650, bodySpan: 0.5, wristOffset: 0.4), paddle: nil))
    // Settled samples: the run starts at 650 and reaches 160 ms at 810, past
    // minStrokeMs from the trigger interval's start (400); path 0.4 ≥ 0.3.
    var emitted: [(tMs: Int, event: StrokeEvent)] = []
    for tMs in stride(from: 690, through: 810, by: cadenceMs) {
      if let event = detector.ingest(pose: fullBodyPose(at: tMs, bodySpan: 0.5, wristOffset: 0.4), paddle: nil) {
        emitted.append((tMs, event))
      }
    }
    XCTAssertEqual(emitted.count, 1)
    XCTAssertEqual(emitted.first?.tMs, 810)
    XCTAssertEqual(emitted.first?.event.startMs, 400)
    XCTAssertEqual(emitted.first?.event.endMs, 810)
  }

  // MARK: - Duration, refractory, re-arming

  func testCandidateExceedingMaxStrokeMsIsDroppedNotEmitted() {
    let detector = TemporalStrokeDetector(config: .init(maxStrokeMs: 500))
    // 2.0 bh/s sustained from 440 to 920: elapsed from the trigger interval's
    // start (400) passes 500 at 920 and the candidate is dropped. The
    // stillness after it must not emit anything...
    let sustained = ready(then: Array(repeating: 0.08, count: 13))
    XCTAssertTrue(run(detector, poses(bodySpan: 0.5, path: sustained)).isEmpty)

    // ...and a dropped candidate leaves no refractory: after a fresh quiet run
    // (920 → 1360) a discrete drive is detected normally, starting at 1360.
    let recovery = move(hold(sustained, for: 11), by: driveDeltas)
    let events = run(detector, poses(bodySpan: 0.5, path: recovery))
    XCTAssertEqual(events.count, 1)
    XCTAssertEqual(events.first?.event.startMs, 1_360)
    XCTAssertEqual(events.first?.event.endMs, 1_800)
  }

  func testRefractoryBlocksRetriggerUntilItExpires() {
    // Drive (event ends 840, refractory to 1540), a 360 ms quiet run
    // (840 → 1200) that WOULD qualify as an onset, a second drive at 1240 —
    // blocked by the refractory alone — then a quiet run and a third drive at
    // 2080, detected with its own onset (2040).
    var path = ready(then: driveDeltas)
    path = move(hold(path, for: 9), by: driveDeltas)
    path = move(hold(path, for: 10), by: driveDeltas)
    let events = run(TemporalStrokeDetector(), poses(bodySpan: 0.5, path: path))
    XCTAssertEqual(events.map(\.tMs), [840, 2_480])
    XCTAssertEqual(events.first?.event.startMs, 400)
    XCTAssertEqual(events.last?.event.startMs, 2_040)
    XCTAssertEqual(events.last?.event.endMs, 2_480)
  }

  func testANewQuietRunIsRequiredAfterAnEmittedEvent() {
    // Drive (event ends 840), then 0.7 bh/s of continuous moderate motion until
    // well past the refractory (880 → 1640; never quiet), then a drive at 1680:
    // no onset since the event → no second event. Only after a real pause
    // (2080 → 2480) does the next drive register.
    let moderate = (1...20).map { step -> Double in
      let phase = step % 20
      return 0.028 * Double(phase <= 10 ? phase : 20 - phase)
    }
    var path = ready(then: driveDeltas)
    path = move(path + moderate.map { path.last! + $0 }, by: driveDeltas)
    let restless = run(TemporalStrokeDetector(), poses(bodySpan: 0.5, path: path))
    XCTAssertEqual(restless.map(\.tMs), [840])

    path = move(hold(path, for: 10), by: driveDeltas)
    let rested = run(TemporalStrokeDetector(), poses(bodySpan: 0.5, path: path))
    XCTAssertEqual(rested.map(\.tMs), [840, 2_920])
    XCTAssertEqual(rested.last?.event.startMs, 2_480)
  }

  // MARK: - Body anchor & scale fallbacks

  func testWristOnlyPoseYieldsNoSpeedSamples() {
    // No hips anywhere: the wrist cannot be placed relative to the body, so no
    // frame yields a speed — not a quiet one, not a fast one — and nothing can
    // ever trigger (heuristic-3 fell back to absolute image speed here).
    let detector = TemporalStrokeDetector()
    for tMs in stride(from: 0, through: 400, by: cadenceMs) {
      XCTAssertNil(detector.ingest(pose: wristOnlyPose(at: tMs, rightWristX: 0.25), paddle: nil))
    }
    XCTAssertNil(detector.ingest(pose: wristOnlyPose(at: 440, rightWristX: 0.40), paddle: nil))
    XCTAssertNil(detector.ingest(pose: wristOnlyPose(at: 480, rightWristX: 0.58), paddle: nil))
    for tMs in stride(from: 520, through: 900, by: cadenceMs) {
      XCTAssertNil(detector.ingest(pose: wristOnlyPose(at: tMs, rightWristX: 0.59), paddle: nil))
    }
    XCTAssertNil(detector.lastBodyScale)
  }

  func testMissingAnklesFallBackToHipSpan() {
    let detector = TemporalStrokeDetector()
    let pose = fullBodyPose(at: 0, bodySpan: 0.5, removing: ["left_ankle", "right_ankle"])
    _ = detector.ingest(pose: pose, paddle: nil)
    // Shoulder-mid → hip-mid is 0.42 of the span; × 2.2 ≈ the full span.
    XCTAssertEqual(detector.lastBodyScale ?? -1, 0.42 * 0.5 * 2.2, accuracy: 1e-9)
  }

  func testMissingAnklesAndHipsKeepLastKnownScale() {
    let detector = TemporalStrokeDetector()
    _ = detector.ingest(pose: fullBodyPose(at: 0, bodySpan: 0.5), paddle: nil)
    XCTAssertEqual(detector.lastBodyScale ?? -1, 0.5, accuracy: 1e-9)

    let torsoless = fullBodyPose(
      at: 40,
      bodySpan: 0.5,
      removing: ["left_ankle", "right_ankle", "left_hip", "right_hip", "left_knee", "right_knee"]
    )
    _ = detector.ingest(pose: torsoless, paddle: nil)
    XCTAssertEqual(detector.lastBodyScale ?? -1, 0.5, accuracy: 1e-9)
  }

  func testBodyScaleIsSmoothedSoOneNoisyFrameCannotSpikeSpeed() {
    // Ready position, then an arm swing at 0.7 bh/s (Δ 0.028 bh per 40 ms) —
    // below trigger, with a valid onset at 400. On the third moving frame the
    // ankles are mis-detected halfway up the body, so the raw span reads 0.25
    // instead of 0.5: unsmoothed, the speed would double to 1.4 bh/s and
    // trigger. The EMA moves the scale to 0.425 (speed 0.82) instead.
    let detector = TemporalStrokeDetector()
    for frame in poses(bodySpan: 0.5, path: stillPath(readyFrames)) {
      XCTAssertNil(detector.ingest(pose: frame, paddle: nil))
    }
    for step in 1...2 {
      let pose = fullBodyPose(at: 400 + step * cadenceMs, bodySpan: 0.5, wristOffset: 0.028 * Double(step))
      XCTAssertNil(detector.ingest(pose: pose, paddle: nil))
    }
    let noisy = fullBodyPose(at: 520, bodySpan: 0.5, wristOffset: 0.028 * 3, ankleBodyY: 0.5)
    XCTAssertNil(detector.ingest(pose: noisy, paddle: nil))
    XCTAssertEqual(detector.lastBodyScale ?? -1, 0.5 + 0.3 * (0.25 - 0.5), accuracy: 1e-9)

    // Continued swing after the glitch still never triggers, and the scale
    // recovers toward the true span.
    for step in 4...8 {
      let pose = fullBodyPose(at: 400 + step * cadenceMs, bodySpan: 0.5, wristOffset: 0.028 * Double(step))
      XCTAssertNil(detector.ingest(pose: pose, paddle: nil))
    }
    XCTAssertGreaterThan(detector.lastBodyScale ?? -1, 0.425)
    XCTAssertLessThan(detector.lastBodyScale ?? -1, 0.5)
  }

  func testResetClearsCandidateQuietRunAndBodyScale() {
    // Open a candidate (ready position + the first two drive samples), reset,
    // and feed the rest of the drive: the candidate is gone, the swing that
    // continues has no quiet run behind it, and the scale is re-seeded.
    let detector = TemporalStrokeDetector()
    let frames = poses(bodySpan: 0.5, path: ready(then: driveDeltas))
    for frame in frames.prefix(readyFrames + 2) {
      XCTAssertNil(detector.ingest(pose: frame, paddle: nil))
    }
    XCTAssertNotNil(detector.lastBodyScale)
    detector.reset()
    XCTAssertNil(detector.lastBodyScale)
    for frame in frames.dropFirst(readyFrames + 2) {
      XCTAssertNil(detector.ingest(pose: frame, paddle: nil))
    }
    XCTAssertEqual(detector.lastBodyScale ?? -1, 0.5, accuracy: 1e-9)

    // A completed quiet run does not survive a reset either: ready position,
    // reset, drive → nothing. The drive's tail plus a hold (720 → 1200) is the
    // first quiet run the reset detector knows, so the NEXT drive is detected.
    let fresh = TemporalStrokeDetector()
    for frame in poses(bodySpan: 0.5, path: stillPath(readyFrames)) {
      XCTAssertNil(fresh.ingest(pose: frame, paddle: nil))
    }
    fresh.reset()
    let afterReset = move(hold([0] + cumulative(driveDeltas), for: 9), by: driveDeltas)
    let events = run(fresh, poses(bodySpan: 0.5, path: afterReset, startMs: 400))
    XCTAssertEqual(events.count, 1)
    XCTAssertEqual(events.first?.event.startMs, 1_200)
  }

  func testLowConfidencePoseIsIgnored() {
    let detector = TemporalStrokeDetector()
    let events = run(detector, poses(bodySpan: 0.5, path: ready(then: driveDeltas), confidence: 0.4))
    XCTAssertTrue(events.isEmpty)
    XCTAssertNil(detector.lastBodyScale)
  }

  // MARK: - Paddle centre

  func testPaddleCentreIsPreferredAndMeasuredRelativeToTheHips() {
    // With a validated paddle the paddle centre is the tracked point. Ready
    // position, a camera bump at 440 (body AND paddle jump together: 0 bh/s
    // relative), stillness, then the paddle moves like the drive from 840
    // while both wrists stay still.
    let bodySpan = 0.4
    let jump = 0.3 / bodySpan
    let path = ready(then: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] + driveDeltas)
    let body = stillPath(readyFrames) + Array(repeating: jump, count: path.count - readyFrames)
    let detector = TemporalStrokeDetector()
    var events: [(tMs: Int, event: StrokeEvent)] = []
    for (index, offset) in path.enumerated() {
      let tMs = index * cadenceMs
      let pose = fullBodyPose(at: tMs, bodySpan: bodySpan, bodyOffsetX: body[index])
      let paddle = paddleFrame(at: tMs, bodySpan: bodySpan, offset: offset, bodyOffsetX: body[index])
      if let event = detector.ingest(pose: pose, paddle: paddle) { events.append((tMs, event)) }
    }
    XCTAssertEqual(events.count, 1)
    XCTAssertEqual(events.first?.event.startMs, 800)
    XCTAssertEqual(events.first?.event.endMs, 1_240)
    XCTAssertEqual(events.first?.event.peakMotionMs, 880)

    // While a validated paddle is present the wrists are not consulted: a
    // wrist drive under a still paddle is nothing.
    let wristOnly = TemporalStrokeDetector()
    for (index, offset) in ready(then: driveDeltas).enumerated() {
      let tMs = index * cadenceMs
      let pose = fullBodyPose(at: tMs, bodySpan: bodySpan, wristOffset: offset)
      let paddle = paddleFrame(at: tMs, bodySpan: bodySpan, offset: 0, bodyOffsetX: 0)
      XCTAssertNil(wristOnly.ingest(pose: pose, paddle: paddle))
    }
  }

  // MARK: - Offline pass (STOP & ANALYZE)

  func testStrongestEventFindsASoftSwingTheLiveTriggerMissed() {
    let frames = poses(bodySpan: 0.4, path: ready(then: softDinkDeltas))
    // Live config: nothing (0.9 < 1.15).
    XCTAssertTrue(run(TemporalStrokeDetector(), frames).isEmpty)
    // Offline permissive pass: trigger at 440 (1.0 ≥ 0.8), onset 400, settled
    // from 760 (0.4), 160 ms of tail completes at 880; path 0.328 ≥ 0.25.
    let event = TemporalStrokeDetector.strongestEvent(in: frames)
    XCTAssertNotNil(event)
    XCTAssertEqual(event?.startMs, 400)
    XCTAssertEqual(event?.endMs, 880)
    XCTAssertEqual(event?.peakMotionMs, 440)
    XCTAssertEqual(event?.confidence ?? 0, 0.5 + 1.0 / (0.8 * 4), accuracy: 1e-9)
    XCTAssertEqual(event?.recognition.status, .unknown)
  }

  func testStrongestEventReturnsNilForWalkingAndEmptyInput() {
    // Walking across the frame (0.8 bh/s translation + ±0.5 bh/s arm swing):
    // relative to the hips the arm swing stays under even the permissive 0.8
    // trigger and never rests, so the offline pass finds nothing.
    var path = stillPath(readyFrames)
    var body = stillPath(readyFrames)
    for step in 1...60 {
      let phase = step % 20
      path.append(0.02 * Double(phase <= 10 ? phase : 20 - phase))
      body.append(0.032 * Double(step))
    }
    XCTAssertNil(TemporalStrokeDetector.strongestEvent(in: poses(bodySpan: 0.4, path: path, bodyPath: body)))
    XCTAssertNil(TemporalStrokeDetector.strongestEvent(in: []))
  }

  func testStrongestEventPicksTheHighestConfidenceOfSeveral() {
    // A soft dink (confidence 0.8125, closes at 880), a hold long enough for
    // the 300 ms refractory and a fresh 250 ms quiet run (880 → 1360), then a
    // drive (trigger 1400, capped 0.95). The drive wins.
    var path = ready(then: softDinkDeltas)
    path = move(hold(path, for: 11), by: driveDeltas)
    let event = TemporalStrokeDetector.strongestEvent(in: poses(bodySpan: 0.4, path: path))
    XCTAssertEqual(event?.startMs, 1_360)
    XCTAssertEqual(event?.peakMotionMs, 1_440)
    XCTAssertEqual(event?.confidence ?? 0, 0.95, accuracy: 1e-9)
  }

  func testMovingOffHandDoesNotEraseSwingingHandQuietOnset() {
    for swingOnLeft in [false, true] {
      for offHandDelta in [0.028, 0.1] {
        let path = ready(then: driveDeltas)
        let frames = path.enumerated().map { index, offset in
          let phase = index % 20
          let offHand = offHandDelta * Double(phase <= 10 ? phase : 20 - phase)
          return fullBodyPose(
            at: index * cadenceMs,
            bodySpan: 0.4,
            wristOffset: swingOnLeft ? offHand : offset,
            leftWristOffset: swingOnLeft ? offset : offHand
          )
        }
        let events = run(TemporalStrokeDetector(), frames)
        XCTAssertEqual(events.count, 1, "left=\(swingOnLeft), off-hand delta=\(offHandDelta)")
        XCTAssertEqual(events.first?.event.startMs, 400)
        XCTAssertEqual(events.first?.event.endMs, 840)
        XCTAssertEqual(events.first?.event.peakMotionMs, 480)
      }
    }
  }

  func testMovingOffHandDoesNotDelayFirstSwingCompletion() {
    for swingOnLeft in [false, true] {
      let path = hold(ready(then: driveDeltas), for: 70)
      let frames = path.enumerated().map { index, offset in
        let phase = max(0, index - readyFrames + 1) % 20
        let offHand = 0.028 * Double(phase <= 10 ? phase : 20 - phase)
        return fullBodyPose(
          at: index * cadenceMs,
          bodySpan: 0.4,
          wristOffset: swingOnLeft ? offHand : offset,
          leftWristOffset: swingOnLeft ? offset : offHand
        )
      }
      let events = run(TemporalStrokeDetector(), frames)
      XCTAssertEqual(events.map(\.tMs), [840])
      XCTAssertEqual(events.first?.event.startMs, 400)
      XCTAssertEqual(events.first?.event.endMs, 840)
    }
  }

  func testDroppedFlickKeepsSubsequentObservedQuietForFirstFullSwing() {
    let flick = [0.056, 0.056, 0.008] + Array(repeating: 0.0, count: 9)
    let path = move(ready(then: flick), by: driveDeltas)
    let events = run(TemporalStrokeDetector(), poses(bodySpan: 0.4, path: path))
    XCTAssertEqual(events.map(\.tMs), [1_320])
    XCTAssertEqual(events.first?.event.startMs, 880)
    XCTAssertEqual(events.first?.event.endMs, 1_320)
    XCTAssertEqual(events.first?.event.peakMotionMs, 960)
  }

  func testOffHandPathCannotTurnAShortFlickIntoASwing() {
    let path = hold(ready(then: [0.056, 0.056, 0.008]), for: 30)
    let frames = path.enumerated().map { index, offset in
      let phase = min(index, 21) % 20
      let offHand = 0.028 * Double(phase <= 10 ? phase : 20 - phase)
      return fullBodyPose(
        at: index * cadenceMs, bodySpan: 0.4,
        wristOffset: offset, leftWristOffset: offHand
      )
    }
    XCTAssertTrue(run(TemporalStrokeDetector(), frames).isEmpty)
  }

  func testSparseStillSamplesDoNotCreateQuietOnset() {
    let sparseReady = [0, 200, 400].map { fullBodyPose(at: $0, bodySpan: 0.4) }
    let swing = poses(bodySpan: 0.4, path: ready(then: driveDeltas)).dropFirst(readyFrames)
    XCTAssertTrue(run(TemporalStrokeDetector(), sparseReady + swing).isEmpty)
  }

  func testSparseStillSampleDoesNotSupplyEntireSettledTail() {
    let path = ready(then: Array(driveDeltas.prefix(7)))
    var frames = poses(bodySpan: 0.4, path: path)
    for timestamp in stride(from: 880, through: 1_040, by: cadenceMs) {
      frames.append(fullBodyPose(at: timestamp, bodySpan: 0.4, wristOffset: path.last!))
    }
    let events = run(TemporalStrokeDetector(), frames)
    XCTAssertEqual(events.map(\.tMs), [1_040])
    XCTAssertEqual(events.first?.event.startMs, 400)
    XCTAssertEqual(events.first?.event.endMs, 1_040)
  }

  func testInterruptedQuietRunsDoNotJoinAcrossUntrustedPoses() {
    for dropout in SyntheticDropout.allCases {
      var frames = poses(bodySpan: 0.4, path: ready(then: driveDeltas))
      frames[4] = missingEvidence(in: frames[4], dropout: dropout)
      XCTAssertTrue(run(TemporalStrokeDetector(), frames).isEmpty, "\(dropout)")
    }
  }

  func testInterruptedSettledTailRequiresFreshObservedStillness() {
    for dropout in SyntheticDropout.allCases {
      let path = ready(then: Array(driveDeltas.prefix(8)))
      var frames = poses(bodySpan: 0.4, path: path)
      for timestamp in stride(from: 760, through: 1_040, by: cadenceMs) {
        let frame = fullBodyPose(at: timestamp, bodySpan: 0.4, wristOffset: path.last!)
        frames.append(timestamp < 880 ? missingEvidence(in: frame, dropout: dropout) : frame)
      }
      let events = run(TemporalStrokeDetector(), frames)
      XCTAssertEqual(events.map(\.tMs), [1_040], "\(dropout)")
      XCTAssertEqual(events.first?.event.startMs, 400)
      XCTAssertEqual(events.first?.event.endMs, 1_040)
    }
  }

  func testHiddenMovingWristCannotBeSettledByTheOtherHand() {
    for swingOnLeft in [false, true] {
      let path = ready(then: Array(driveDeltas.prefix(7)))
      var frames = path.enumerated().map { index, offset in
        fullBodyPose(
          at: index * cadenceMs, bodySpan: 0.4,
          wristOffset: swingOnLeft ? 0 : offset,
          leftWristOffset: swingOnLeft ? offset : 0
        )
      }
      for timestamp in stride(from: 720, through: 1_080, by: cadenceMs) {
        frames.append(fullBodyPose(
          at: timestamp, bodySpan: 0.4,
          wristOffset: swingOnLeft ? 0 : path.last!,
          leftWristOffset: swingOnLeft ? path.last! : 0,
          removing: timestamp < 920 ? [swingOnLeft ? "left_wrist" : "right_wrist"] : []
        ))
      }
      let events = run(TemporalStrokeDetector(), frames)
      XCTAssertEqual(events.map(\.tMs), [1_080])
      XCTAssertEqual(events.first?.event.startMs, 400)
      XCTAssertEqual(events.first?.event.endMs, 1_080)
    }
  }

  func testLongSampleGapRestartsTheSettledEvidence() {
    let path = ready(then: Array(driveDeltas.prefix(9)))
    var frames = poses(bodySpan: 0.4, path: path)
    for timestamp in stride(from: 1_040, through: 1_200, by: cadenceMs) {
      frames.append(fullBodyPose(at: timestamp, bodySpan: 0.4, wristOffset: path.last!))
    }
    let events = run(TemporalStrokeDetector(), frames)
    XCTAssertEqual(events.map(\.tMs), [1_200])
    XCTAssertEqual(events.first?.event.startMs, 400)
    XCTAssertEqual(events.first?.event.endMs, 1_200)
  }

  func testDroppedTossPreservesTheOtherHandsObservedBackswingOnset() {
    for swingOnLeft in [false, true] {
      let path = ready(then: Array(repeating: -0.028, count: 12) + driveDeltas)
      let frames = path.enumerated().map { index, offset in
        let toss = index < readyFrames ? 0.0 : 0.06
        return fullBodyPose(
          at: index * cadenceMs, bodySpan: 0.4,
          wristOffset: swingOnLeft ? toss : offset,
          leftWristOffset: swingOnLeft ? offset : toss
        )
      }
      let events = run(TemporalStrokeDetector(), frames)
      XCTAssertEqual(events.map(\.tMs), [1_320])
      XCTAssertEqual(events.first?.event.startMs, 400)
      XCTAssertEqual(events.first?.event.peakMotionMs, 960)
    }
  }

  func testSimultaneousTriggersKeepTheEarliestQualifiedBackswing() {
    for swingOnLeft in [false, true] {
      let path = ready(then: Array(repeating: -0.028, count: 4) + driveDeltas)
      let frames = path.enumerated().map { index, offset in
        let toss = 0.1 * Double(min(2, max(0, index - readyFrames - 3)))
        return fullBodyPose(
          at: index * cadenceMs, bodySpan: 0.4,
          wristOffset: swingOnLeft ? toss : offset,
          leftWristOffset: swingOnLeft ? offset : toss
        )
      }
      let events = run(TemporalStrokeDetector(), frames)
      XCTAssertEqual(events.map(\.tMs), [1_000])
      XCTAssertEqual(events.first?.event.startMs, 400)
      for emitted in events { assertObservedMotionEvent(emitted, in: frames) }
    }
  }

  func testSyntheticFirstSwingAfterWalkingAcrossCadencesHandsScalesAndJitter() {
    for fps in [10, 15, 30, 60] {
      for bodySpan in [0.32, 0.4, 0.55] {
        for swingOnLeft in [false, true] {
          for jitter in [0.0, 0.004] {
            let frames = syntheticFrames(
              fps: fps, bodySpan: bodySpan, swingOnLeft: swingOnLeft,
              jitter: jitter, durationMs: 3_200
            ) { time in
              let walking = time < 1 ? 0.6 / (2 * Double.pi) * sin(2 * Double.pi * time) : 0
              return (
                walking + self.syntheticSwingOffset(time - 1.6),
                self.syntheticFidgetOffset(time),
                0.4 * min(time, 1)
              )
            }
            let events = run(TemporalStrokeDetector(), frames)
            let context = "fps=\(fps), span=\(bodySpan), left=\(swingOnLeft), jitter=\(jitter)"
            XCTAssertEqual(events.count, 1, context)
            guard let emitted = events.first else { continue }
            XCTAssertEqual(emitted.event.startMs, 1_600, context)
            XCTAssertGreaterThanOrEqual(emitted.tMs, 2_360, context)
            XCTAssertLessThanOrEqual(emitted.tMs, 2_400, context)
            assertObservedMotionEvent(emitted, in: frames)
          }
        }
      }
    }
  }

  func testSyntheticServeTossHandsOffToSwingAcrossCadences() {
    for fps in [15, 30, 60] {
      for bodySpan in [0.35, 0.55] {
        for swingOnLeft in [false, true] {
          let frames = syntheticFrames(
            fps: fps, bodySpan: bodySpan, swingOnLeft: swingOnLeft,
            jitter: 0.004, durationMs: 2_400
          ) { time in
            let toss = self.syntheticOffset(time, knots: [(0, 0), (0.6, 0), (0.7, 0.18)])
            let offHand = toss + self.syntheticFidgetOffset(max(0, time - 0.7), speed: 0.65)
            return (self.syntheticSwingOffset(time - 0.6), offHand, 0)
          }
          let events = run(TemporalStrokeDetector(), frames)
          XCTAssertEqual(events.count, 1, "fps=\(fps), span=\(bodySpan), left=\(swingOnLeft)")
          guard let emitted = events.first else { continue }
          XCTAssertEqual(emitted.event.startMs, 600)
          XCTAssertGreaterThanOrEqual(emitted.tMs, 1_360)
          XCTAssertLessThanOrEqual(emitted.tMs, 1_400)
          assertObservedMotionEvent(emitted, in: frames)
        }
      }
    }
  }

  func testSyntheticLongTossPauseStillCapturesFirstPaddleMotion() {
    for fps in [15, 30, 60] {
      for swingOnLeft in [false, true] {
        let frames = syntheticFrames(fps: fps, swingOnLeft: swingOnLeft) { time in
          let toss = self.syntheticOffset(time, knots: [(0, 0), (0.6, 0), (0.66, 0.09)])
          return (self.syntheticSwingOffset(time - 1), toss, 0)
        }
        let events = run(TemporalStrokeDetector(), frames)
        XCTAssertEqual(events.count, 1, "fps=\(fps), left=\(swingOnLeft)")
        guard let emitted = events.first else { continue }
        XCTAssertEqual(emitted.event.startMs, 1_000)
        XCTAssertGreaterThanOrEqual(emitted.tMs, 1_760)
        XCTAssertLessThanOrEqual(emitted.tMs, 1_800)
        assertObservedMotionEvent(emitted, in: frames)
      }
    }
  }

  func testSyntheticBriefOcclusionRetainsFirstCandidateButWaitsForObservedTail() {
    for fps in [15, 30, 60] {
      for swingOnLeft in [false, true] {
        for dropout in SyntheticDropout.allCases {
          for duringTail in [false, true] {
            let clean = syntheticFrames(fps: fps, swingOnLeft: swingOnLeft, jitter: 0.004) { time in
              (self.syntheticSwingOffset(time - 0.6), 0, 0)
            }
            let gap = duringTail ? 1_240...1_320 : 880...960
            let frames = clean.map { frame in
              gap.contains(frame.timestampMs) ? missingEvidence(in: frame, dropout: dropout) : frame
            }
            let events = run(TemporalStrokeDetector(), frames)
            let context = "fps=\(fps), left=\(swingOnLeft), dropout=\(dropout), tail=\(duringTail)"
            XCTAssertEqual(events.count, 1, context)
            guard let emitted = events.first else { continue }
            XCTAssertEqual(emitted.event.startMs, 600, context)
            if duringTail {
              let resumedAt = frames.first { $0.timestampMs > gap.upperBound }!.timestampMs
              XCTAssertGreaterThanOrEqual(emitted.tMs, resumedAt + 160, context)
              XCTAssertLessThanOrEqual(emitted.tMs, resumedAt + 160 + Int(ceil(1_000 / Double(fps))), context)
            } else {
              XCTAssertGreaterThanOrEqual(emitted.tMs, 1_360, context)
              XCTAssertLessThanOrEqual(emitted.tMs, 1_400, context)
            }
            assertObservedMotionEvent(emitted, in: frames)
          }
        }
      }
    }
  }

  func testSyntheticWalkingReachingFidgetingFlicksAndCameraBumpsRemainNegative() {
    for fps in [10, 15, 30, 60] {
      for bodySpan in [0.35, 0.55] {
        for swingOnLeft in [false, true] {
          for motion in SyntheticNonStroke.allCases {
            let frames = syntheticFrames(
              fps: fps, bodySpan: bodySpan, swingOnLeft: swingOnLeft,
              jitter: 0.004, durationMs: 3_400
            ) { time in
              switch motion {
              case .walking:
                let elapsed = max(0, time - 0.6)
                let arm = 0.6 * 0.8 / (2 * Double.pi) * sin(2 * Double.pi * elapsed / 0.8)
                return (arm, -arm, self.syntheticFidgetOffset(elapsed, speed: 0.8, period: 1.6))
              case .reaching:
                let reach = self.syntheticOffset(time, knots: [(0, 0), (0.6, 0), (1.3, 0.45), (1.8, 0.45), (2.5, 0)])
                return (reach, 0, 0.02 * sin(time))
              case .fidgeting:
                let fidget = 0.7 * 0.8 / (2 * Double.pi) * sin(2 * Double.pi * time / 0.8)
                return (fidget + self.syntheticSwingOffset(time - 2), 0, 0)
              case .flick:
                let flick = self.syntheticOffset(time, knots: [(0, 0), (0.6, 0), (0.65, 0.06), (0.7, 0.12)])
                return (flick, self.syntheticFidgetOffset(time), 0)
              case .cameraBump:
                return (0, 0, time >= 0.6 && time < 1.2 ? 0.5 : 0)
              }
            }
            XCTAssertTrue(
              run(TemporalStrokeDetector(), frames).isEmpty,
              "fps=\(fps), span=\(bodySpan), left=\(swingOnLeft), motion=\(motion)"
            )
          }
        }
      }
    }
  }

  func testSyntheticLiveDetectionEmitsFirstWindowBeforeLaterStrongerMotion() {
    for fps in [15, 30, 60] {
      for swingOnLeft in [false, true] {
        let frames = syntheticFrames(fps: fps, swingOnLeft: swingOnLeft, durationMs: 4_000) { time in
          let first = 0.7 * self.syntheticSwingOffset(time - 0.6)
          let second = 1.2 * self.syntheticSwingOffset(time - 2.6)
          return (first + second, self.syntheticFidgetOffset(time), 0)
        }
        let events = run(TemporalStrokeDetector(), frames)
        XCTAssertEqual(events.map { $0.event.startMs }, [600, 2_600])
        guard let first = events.first, let last = events.last else { continue }
        XCTAssertLessThan(first.event.confidence, last.event.confidence)
        XCTAssertGreaterThanOrEqual(first.tMs, 1_360)
        XCTAssertLessThanOrEqual(first.tMs, 1_400)
        XCTAssertGreaterThanOrEqual(last.tMs, 3_360)
        XCTAssertLessThanOrEqual(last.tMs, 3_400)
        for emitted in events { assertObservedMotionEvent(emitted, in: frames) }
      }
    }
  }

  func testDuplicateAndOlderFramesCannotRewriteAnObservedWindow() {
    let clean = poses(bodySpan: 0.4, path: ready(then: driveDeltas))
    var frames: [PoseFrame] = []
    for frame in clean {
      frames.append(frame)
      frames.append(fullBodyPose(at: frame.timestampMs, bodySpan: 0.4, wristOffset: 1))
      frames.append(fullBodyPose(at: frame.timestampMs - 20, bodySpan: 0.4, wristOffset: -1))
    }
    let events = run(TemporalStrokeDetector(), frames)
    XCTAssertEqual(events.map(\.tMs), [840])
    XCTAssertEqual(events.first?.event.startMs, 400)
    XCTAssertEqual(events.first?.event.peakMotionMs, 480)
  }

  // MARK: - Independent adversarial review (synthetic, not field accuracy)

  func testIndependentBriskOffHandReachDoesNotPreemptFirstIntendedSwing() {
    // A 0.36 bh off-hand reach in 240 ms (1.5 bh/s), then a hold: e.g. handing
    // over a ball, not swinging the paddle. The intended paddle motion does
    // not begin until 1400. Unlike the existing slow-reaching negative, this
    // plausible reach crosses the speed AND path gates from an observed rest.
    for swingOnLeft in [false, true] {
      let frames = syntheticFrames(fps: 25, swingOnLeft: swingOnLeft, durationMs: 2_800) { time in
        let reach = self.syntheticOffset(time, knots: [(0, 0), (0.6, 0), (0.84, 0.36)])
        return (self.syntheticSwingOffset(time - 1.4), reach, 0)
      }
      let control = syntheticFrames(fps: 25, swingOnLeft: swingOnLeft, durationMs: 2_800) { time in
        (self.syntheticSwingOffset(time - 1.4), 0, 0)
      }
      let config = TemporalStrokeDetector.Config(handedness: swingOnLeft ? .left : .right)
      XCTAssertEqual(run(TemporalStrokeDetector(config: config), control).first?.event.startMs, 1_400)
      let events = run(TemporalStrokeDetector(config: config), frames)
      XCTAssertEqual(events.count, 1)
      XCTAssertEqual(
        events.first?.event.startMs, 1_400,
        "left=\(swingOnLeft): an unrelated reach must not win first capture; emitted \(events.map { ($0.event.startMs, $0.event.endMs) })"
      )
    }
  }

  func testIndependentHiddenWristResumingMotionCannotBorrowOtherHandsSettledTail() {
    // Only ONE slow interval of the swinging wrist is observed at 720.
    // It then resumes moving at 2 bh/s for 160 ms, but is hidden for the first
    // 120 ms. A still off hand cannot prove that the swinging wrist settled.
    // The fully observed control cannot close until the real tail at 1040.
    let path = hold(ready(then: Array(driveDeltas.prefix(8)) + Array(repeating: 0.08, count: 4)), for: 4)
    for swingOnLeft in [false, true] {
      let clean = path.enumerated().map { index, offset in
        fullBodyPose(
          at: index * cadenceMs, bodySpan: 0.4,
          wristOffset: swingOnLeft ? 0 : offset,
          leftWristOffset: swingOnLeft ? offset : 0
        )
      }
      XCTAssertEqual(run(TemporalStrokeDetector(), clean).map(\.tMs), [1_040])
      let hidden = clean.map { frame in
        PoseFrame(
          timestampMs: frame.timestampMs,
          landmarks: frame.landmarks.filter {
            !(760...840).contains(frame.timestampMs)
              || $0.name != (swingOnLeft ? "left_wrist" : "right_wrist")
          },
          confidence: frame.confidence
        )
      }
      XCTAssertEqual(
        run(TemporalStrokeDetector(), hidden).map(\.tMs), [1_040],
        "left=\(swingOnLeft): missing swinging-wrist motion is not a settled tail"
      )
    }
  }

  func testIndependentFullyObservedTenFpsSwingIsNotSilentlyLost() {
    // Identical physical path and high-confidence full-body observations.
    // 80 ms is the exact inclusive 12.5 fps boundary; 100 ms is 10 fps, NOT
    // a missing landmark or the 200 ms sparse observations of the negatives.
    for intervalMs in [40, 80, 100] {
      let frames = stride(from: 0, through: 2_400, by: intervalMs).map { timestamp in
        fullBodyPose(
          at: timestamp, bodySpan: 0.4,
          wristOffset: syntheticSwingOffset(Double(timestamp) / 1_000 - 0.6)
        )
      }
      let events = run(TemporalStrokeDetector(), frames)
      XCTAssertEqual(events.count, 1, "fully observed cadence \(intervalMs) ms must not silently lose the only swing")
      XCTAssertNotNil(
        TemporalStrokeDetector.strongestEvent(in: frames),
        "manual stop cannot rescue the same \(intervalMs) ms stream if its stillness also uses the hard cap"
      )
    }
  }

  func testIndependentTenFpsReadyRunQualifiesBeforeDenseSwingSamples() {
    // Isolate the onset gate: seven consecutive valid, still poses at 10 fps
    // span 600 ms, followed by the unchanged 25 fps drive and settled tail.
    let still = stride(from: 0, through: 600, by: 100).map { fullBodyPose(at: $0, bodySpan: 0.4) }
    let swing = poses(bodySpan: 0.4, path: [0] + cumulative(driveDeltas), startMs: 600).dropFirst()
    let events = run(TemporalStrokeDetector(), still + swing)
    XCTAssertEqual(events.map(\.tMs), [1_040], "valid low-cadence stillness must not be discarded as absent evidence")
  }

  func testIndependentTenFpsTailDoesNotWaitForDenseSamplingToReturn() {
    // Isolate the settle gate: the quiet onset and moving path are unchanged
    // 25 fps observations through 680. Five genuinely observed still poses
    // at 10 fps then cover 500 ms. A dense tail is appended ONLY as a control
    // showing that the candidate was alive, not too short or under the path gate.
    let path = ready(then: Array(driveDeltas.prefix(7)))
    let moving = poses(bodySpan: 0.4, path: path)
    let tail = stride(from: 780, through: 1_180, by: 100).map {
      fullBodyPose(at: $0, bodySpan: 0.4, wristOffset: path.last!)
    }
    let recovery = stride(from: 1_220, through: 1_340, by: cadenceMs).map {
      fullBodyPose(at: $0, bodySpan: 0.4, wristOffset: path.last!)
    }
    let recovered = run(TemporalStrokeDetector(), moving + tail + recovery)
    XCTAssertEqual(recovered.count, 1, "the candidate and its observed path are sufficient")
    XCTAssertEqual(
      run(TemporalStrokeDetector(), moving + tail).count, 1,
      "500 ms of fully observed 10 fps stillness must finish without waiting for the 25 fps control tail; recovered at \(recovered.map(\.tMs))"
    )
  }

  func testIndependentLateBackfillCannotRepairUnobservedQuietOrSettledRuns() {
    // Backfilled observations arrive after t=400 and must not retroactively
    // turn the sparse 0,200,400 ready poses into an observed continuous run.
    let sparseReady = [0, 200, 400].map { fullBodyPose(at: $0, bodySpan: 0.4) }
    let lateReady = [40, 80, 120, 160, 240, 280, 320, 360].map { fullBodyPose(at: $0, bodySpan: 0.4) }
    let swing = poses(bodySpan: 0.4, path: ready(then: driveDeltas)).dropFirst(readyFrames)
    XCTAssertTrue(run(TemporalStrokeDetector(), sparseReady + lateReady + swing).isEmpty)

    // Likewise, a 200 ms hole after a real moving candidate cannot be filled
    // by late still poses. Only the fresh observed run [880,1040] may close it.
    let detector = TemporalStrokeDetector()
    let path = ready(then: Array(driveDeltas.prefix(7)))
    XCTAssertTrue(run(detector, poses(bodySpan: 0.4, path: path)).isEmpty)
    for timestamp in [880, 720, 760, 800, 840, 920, 960, 1_000] {
      XCTAssertNil(detector.ingest(
        pose: fullBodyPose(at: timestamp, bodySpan: 0.4, wristOffset: path.last!), paddle: nil
      ), "late still samples cannot close the candidate at \(timestamp)")
    }
    let event = detector.ingest(
      pose: fullBodyPose(at: 1_040, bodySpan: 0.4, wristOffset: path.last!), paddle: nil
    )
    XCTAssertEqual(event?.startMs, 400)
    XCTAssertEqual(event?.endMs, 1_040)
  }

  func testStillnessSupportsEightFpsButNotSlowerSparseObservations() {
    for intervalMs in [125, 126, 200, 400] {
      let frames = stride(from: 0, through: 3_000, by: intervalMs).map { timestamp in
        fullBodyPose(
          at: timestamp, bodySpan: 0.4,
          wristOffset: syntheticSwingOffset(Double(timestamp) / 1_000 - 0.75)
        )
      }
      let detector = TemporalStrokeDetector()
      let events = run(detector, frames)
      if intervalMs == 125 {
        XCTAssertEqual(events.count, 1)
        XCTAssertFalse(detector.isTrackingLimited)
        XCTAssertNotNil(TemporalStrokeDetector.strongestEvent(in: frames))
        for event in events { assertObservedMotionEvent(event, in: frames) }
      } else {
        XCTAssertTrue(events.isEmpty, "unsupported interval \(intervalMs) ms")
        XCTAssertTrue(detector.isTrackingLimited, "unsupported interval \(intervalMs) ms")
        XCTAssertNil(TemporalStrokeDetector.strongestEvent(in: frames))
      }
    }
  }

  func testQuietOnsetRequiresAtLeastTwoObservedIntervals() {
    for intervalCount in [1, 2] {
      let endOfReadyMs = intervalCount * 100
      let still = stride(from: 0, through: endOfReadyMs, by: 100).map {
        fullBodyPose(at: $0, bodySpan: 0.4)
      }
      let swing = poses(
        bodySpan: 0.4, path: [0] + cumulative(driveDeltas), startMs: endOfReadyMs
      ).dropFirst()
      let detector = TemporalStrokeDetector(config: .init(minQuietBeforeMs: 80))
      let events = run(detector, still + swing)
      XCTAssertEqual(events.map(\.tMs), intervalCount == 2 ? [640] : [])
    }
  }

  func testTrackingLimitedReportsSlowCadenceEvenWithoutUsableSamples() {
    let dropouts: [SyntheticDropout?] = [nil, .lowConfidence, .wrists, .hips, .wristVisibility]
    for intervalMs in [126, 200, 400, 1_000] {
      for dropout in dropouts {
        let detector = TemporalStrokeDetector()
        XCTAssertFalse(detector.isTrackingLimited)
        for index in 0...8 {
          let pose = fullBodyPose(at: index * intervalMs, bodySpan: 0.4)
          let frame = dropout.map { missingEvidence(in: pose, dropout: $0) } ?? pose
          XCTAssertNil(detector.ingest(pose: frame, paddle: nil))
          if index >= 3 {
            XCTAssertTrue(detector.isTrackingLimited, "interval=\(intervalMs), dropout=\(String(describing: dropout))")
          }
        }
      }
    }
  }

  func testTrackingLimitedReportsRepeatedUnsupportedIntervalsBetweenFastFrames() {
    let detector = TemporalStrokeDetector()
    var timestamp = 0
    XCTAssertNil(detector.ingest(pose: fullBodyPose(at: timestamp, bodySpan: 0.4), paddle: nil))
    for index in 1...40 {
      timestamp += index.isMultiple(of: 2) ? 150 : 100
      XCTAssertNil(detector.ingest(pose: fullBodyPose(at: timestamp, bodySpan: 0.4), paddle: nil))
      if index >= 6 { XCTAssertTrue(detector.isTrackingLimited) }
    }
  }

  func testTrackingLimitedRecoversWithHysteresisIgnoresLateFramesAndResets() {
    for intervalMs in [17, 40, 100, 125] {
      let detector = TemporalStrokeDetector()
      for timestamp in [0, 200, 400, 600] {
        XCTAssertNil(detector.ingest(pose: fullBodyPose(at: timestamp, bodySpan: 0.4), paddle: nil))
      }
      XCTAssertTrue(detector.isTrackingLimited)
      for timestamp in stride(from: 0, through: 600, by: cadenceMs) {
        XCTAssertNil(detector.ingest(pose: fullBodyPose(at: timestamp, bodySpan: 0.4), paddle: nil))
        XCTAssertTrue(detector.isTrackingLimited, "late frames cannot repair cadence")
      }
      let recoveryIntervals = max(8, Int(ceil(750.0 / Double(intervalMs))))
      for index in 1...recoveryIntervals {
        let frame = fullBodyPose(at: 600 + index * intervalMs, bodySpan: 0.4)
        XCTAssertNil(detector.ingest(pose: frame, paddle: nil))
        XCTAssertEqual(detector.isTrackingLimited, index < recoveryIntervals, "interval=\(intervalMs), index=\(index)")
      }
      let recoveredAt = 600 + recoveryIntervals * intervalMs
      for index in 1...3 {
        let frame = fullBodyPose(at: recoveredAt + index * 200, bodySpan: 0.4)
        XCTAssertNil(detector.ingest(pose: frame, paddle: nil))
        XCTAssertEqual(detector.isTrackingLimited, index == 3, "one cadence outlier must not toggle the advice")
      }
      detector.reset()
      XCTAssertFalse(detector.isTrackingLimited)
      for timestamp in [0, 200, 400] {
        XCTAssertNil(detector.ingest(pose: fullBodyPose(at: timestamp, bodySpan: 0.4), paddle: nil))
        XCTAssertFalse(detector.isTrackingLimited, "reset must clear old cadence evidence")
      }
    }
  }

  func testTrackingLimitedIsAdviceAndDoesNotGateAnObservedSwing() {
    let detector = TemporalStrokeDetector()
    for timestamp in [0, 200, 400, 600] {
      XCTAssertNil(detector.ingest(pose: fullBodyPose(at: timestamp, bodySpan: 0.4), paddle: nil))
    }
    XCTAssertTrue(detector.isTrackingLimited)
    let observations: [(timestamp: Int, offset: Double)] = [
      (725, 0), (850, 0), (975, 0), (1_100, 0.2), (1_225, 0.4), (1_350, 0.4), (1_475, 0.4),
    ]
    let frames = observations.map { fullBodyPose(at: $0.timestamp, bodySpan: 0.4, wristOffset: $0.offset) }
    let events = run(detector, frames)
    XCTAssertEqual(events.map(\.tMs), [1_475])
    XCTAssertEqual(events.first?.event.startMs, 975)
    XCTAssertTrue(detector.isTrackingLimited, "the event completes before the advisory recovery window")
  }

  func testDeclaredHandednessDoesNotFallBackWhenSelectedWristIsMissingOrHidden() {
    for handedness in [TemporalStrokeDetector.Handedness.left, .right] {
      let selectedWrist = "\(handedness.rawValue)_wrist"
      let offHandSwing = syntheticFrames(fps: 25, swingOnLeft: handedness == .left) { time in
        (0, self.syntheticSwingOffset(time - 0.6), 0)
      }
      for lowVisibility in [false, true] {
        let frames = offHandSwing.map { frame in
          PoseFrame(
            timestampMs: frame.timestampMs,
            landmarks: frame.landmarks.compactMap { point in
              guard point.name == selectedWrist else { return point }
              guard lowVisibility else { return nil }
              return PoseLandmark(name: point.name, x: point.x, y: point.y, visibility: 0.2)
            },
            confidence: frame.confidence
          )
        }
        XCTAssertEqual(run(TemporalStrokeDetector(), frames).count, 1)
        let detector = TemporalStrokeDetector(config: .init(handedness: handedness))
        XCTAssertTrue(run(detector, frames).isEmpty)
        XCTAssertNil(TemporalStrokeDetector.strongestEvent(in: frames, handedness: handedness))
        let observedAgain = syntheticFrames(fps: 25, swingOnLeft: handedness == .left) { time in
          (self.syntheticSwingOffset(time - 0.6), 0, 0)
        }.map { PoseFrame(timestampMs: $0.timestampMs + 3_000, landmarks: $0.landmarks, confidence: $0.confidence) }
        let recovered = run(detector, observedAgain)
        XCTAssertEqual(recovered.count, 1)
        XCTAssertEqual(recovered.first?.event.startMs, 3_600)
      }
    }
  }

  func testDeclaredHandednessAndNilBothSupportTwoHandedSwings() {
    for fps in [10, 15, 30, 60] {
      for handedness in [TemporalStrokeDetector.Handedness.left, .right] {
        let frames = syntheticFrames(fps: fps, swingOnLeft: handedness == .left, jitter: 0.004) { time in
          let swing = self.syntheticSwingOffset(time - 0.6)
          return (swing, -swing, 0.1 * time)
        }
        let selections: [TemporalStrokeDetector.Handedness?] = [nil, handedness]
        for selection in selections {
          let detector = TemporalStrokeDetector(config: .init(handedness: selection))
          let events = run(detector, frames)
          XCTAssertEqual(events.count, 1, "fps=\(fps), hand=\(String(describing: selection))")
          XCTAssertEqual(events.first?.event.startMs, 600)
          XCTAssertFalse(detector.isTrackingLimited)
          for event in events { assertObservedMotionEvent(event, in: frames) }
        }
      }
    }
  }

  func testNilHandednessRetainsMotionOnlyBehaviorIncludingAmbiguousReaches() {
    for swingOnLeft in [false, true] {
      let frames = syntheticFrames(fps: 25, swingOnLeft: swingOnLeft) { time in
        (self.syntheticOffset(time, knots: [(0, 0), (0.6, 0), (0.84, 0.36)]), 0, 0)
      }
      let defaultEvents = run(TemporalStrokeDetector(), frames)
      let nilEvents = run(TemporalStrokeDetector(config: .init(handedness: nil)), frames)
      XCTAssertEqual(defaultEvents.map(\.tMs), [1_000])
      XCTAssertEqual(nilEvents.map(\.tMs), defaultEvents.map(\.tMs))
      XCTAssertEqual(nilEvents.first?.event.startMs, 600)
      XCTAssertEqual(TemporalStrokeDetector.strongestEvent(in: frames, handedness: nil)?.startMs, 600)
    }
  }

  func testStrongestEventSharesDeclaredHandednessAndPreservesCustomConfig() {
    for handedness in [TemporalStrokeDetector.Handedness.left, .right] {
      let path = hold(move(stillPath(36), by: softDinkDeltas), for: 20)
      let frames = path.enumerated().map { index, offset in
        let timestamp = index * cadenceMs
        let reach = syntheticOffset(Double(timestamp) / 1_000, knots: [(0, 0), (0.6, 0), (0.84, 0.36)])
        return fullBodyPose(
          at: timestamp, bodySpan: 0.4,
          wristOffset: handedness == .right ? offset : reach,
          leftWristOffset: handedness == .left ? offset : reach
        )
      }
      XCTAssertTrue(run(TemporalStrokeDetector(config: .init(handedness: handedness)), frames).isEmpty)
      XCTAssertEqual(TemporalStrokeDetector.strongestEvent(in: frames)?.startMs, 600)
      let event = TemporalStrokeDetector.strongestEvent(in: frames, handedness: handedness)
      XCTAssertEqual(event?.startMs, 1_400)
      XCTAssertEqual(event?.endMs, 1_880)
      var config = TemporalStrokeDetector.manualStopConfig
      config.handedness = handedness
      XCTAssertEqual(TemporalStrokeDetector.strongestEvent(in: frames, config: config)?.startMs, 1_400)
      config.handedness = handedness == .left ? .right : .left
      XCTAssertEqual(TemporalStrokeDetector.strongestEvent(in: frames, config: config)?.startMs, 600)
      XCTAssertEqual(TemporalStrokeDetector.strongestEvent(in: frames, config: config, handedness: handedness)?.startMs, 1_400)
    }
  }

  private enum SyntheticNonStroke: CaseIterable {
    case walking, reaching, fidgeting, flick, cameraBump
  }

  private func syntheticFrames(
    fps: Int,
    bodySpan: Double = 0.4,
    swingOnLeft: Bool = false,
    jitter: Double = 0,
    durationMs: Int = 2_400,
    motion: (Double) -> (swing: Double, offHand: Double, body: Double)
  ) -> [PoseFrame] {
    (0...(durationMs * fps / 1_000)).map { index in
      let timestamp = Int((Double(index) * 1_000 / Double(fps)).rounded())
      let time = Double(timestamp) / 1_000
      let offsets = motion(time)
      let pose = fullBodyPose(
        at: timestamp, bodySpan: bodySpan,
        wristOffset: swingOnLeft ? offsets.offHand : offsets.swing,
        leftWristOffset: swingOnLeft ? offsets.swing : offsets.offHand,
        bodyOffsetX: offsets.body
      )
      return PoseFrame(
        timestampMs: timestamp,
        landmarks: pose.landmarks.enumerated().map { pointIndex, point in
          let phase = Double(pointIndex) * 0.9
          return PoseLandmark(
            name: point.name,
            x: point.x + jitter * bodySpan * sin(2 * Double.pi * 2.3 * time + phase),
            y: point.y + jitter * bodySpan * cos(2 * Double.pi * 1.7 * time + phase),
            visibility: point.visibility
          )
        },
        confidence: pose.confidence
      )
    }
  }

  private func syntheticSwingOffset(_ time: Double) -> Double {
    syntheticOffset(time, knots: [
      (0, 0), (0.2, -0.14), (0.3, -0.02), (0.4, 0.2),
      (0.5, 0.38), (0.6, 0.47), (0.7, 0.49),
    ])
  }

  private func syntheticFidgetOffset(_ time: Double, speed: Double = 0.7, period: Double = 0.8) -> Double {
    let phase = time.truncatingRemainder(dividingBy: period)
    return speed * min(phase, period - phase)
  }

  private func syntheticOffset(_ time: Double, knots: [(time: Double, offset: Double)]) -> Double {
    guard let first = knots.first, let last = knots.last else { return 0 }
    if time <= first.time { return first.offset }
    for (start, end) in zip(knots, knots.dropFirst()) where time <= end.time {
      return start.offset + (end.offset - start.offset) * (time - start.time) / (end.time - start.time)
    }
    return last.offset
  }

  private func assertObservedMotionEvent(
    _ emitted: (tMs: Int, event: StrokeEvent),
    in frames: [PoseFrame],
    file: StaticString = #filePath,
    line: UInt = #line
  ) {
    guard let peak = emitted.event.peakMotionMs else {
      return XCTFail("motion peak must come from an observed sample", file: file, line: line)
    }
    let observed = Set(frames.filter { frame in
      frame.confidence >= 0.5
        && frame.landmarks.contains { $0.name.hasSuffix("_wrist") && $0.visibility >= 0.35 }
        && frame.landmarks.contains { $0.name.hasSuffix("_hip") && $0.visibility >= 0.35 }
    }.map(\.timestampMs))
    XCTAssertTrue(observed.contains(emitted.event.startMs), file: file, line: line)
    XCTAssertTrue(observed.contains(peak), file: file, line: line)
    XCTAssertTrue(observed.contains(emitted.event.endMs), file: file, line: line)
    XCTAssertEqual(emitted.event.endMs, emitted.tMs, file: file, line: line)
    XCTAssertLessThan(emitted.event.startMs, peak, file: file, line: line)
    XCTAssertLessThan(peak, emitted.event.endMs, file: file, line: line)
    XCTAssertEqual(emitted.event.recognition.status, .unknown, file: file, line: line)
    XCTAssertEqual(emitted.event.recognition.reason, "validated_classifier_unavailable", file: file, line: line)
    XCTAssertNil(emitted.event.recognition.shotType, file: file, line: line)
  }

  private enum SyntheticDropout: CaseIterable {
    case lowConfidence, wrists, hips, wristVisibility
  }

  private func missingEvidence(in frame: PoseFrame, dropout: SyntheticDropout) -> PoseFrame {
    PoseFrame(
      timestampMs: frame.timestampMs,
      landmarks: frame.landmarks.compactMap { point in
        if dropout == .wrists && point.name.hasSuffix("_wrist") { return nil }
        if dropout == .hips && point.name.hasSuffix("_hip") { return nil }
        if dropout == .wristVisibility && point.name.hasSuffix("_wrist") {
          return PoseLandmark(name: point.name, x: point.x, y: point.y, visibility: 0.2)
        }
        return point
      },
      confidence: dropout == .lowConfidence ? 0.4 : frame.confidence
    )
  }

  // MARK: - Path helpers (cumulative right-wrist offsets, body-heights)

  /// `count` samples at rest.
  private func stillPath(_ count: Int, at offset: Double = 0) -> [Double] {
    Array(repeating: offset, count: count)
  }

  /// Cumulative offsets for `deltas`, starting after `start` (exclusive).
  private func cumulative(_ deltas: [Double], from start: Double = 0) -> [Double] {
    var offset = start
    return deltas.map { delta in
      offset += delta
      return offset
    }
  }

  /// The ready position (11 still samples, t = 0…400) followed by `deltas`.
  private func ready(then deltas: [Double]) -> [Double] {
    move(stillPath(readyFrames), by: deltas)
  }

  /// Appends one sample per delta, continuing from the path's last offset.
  private func move(_ path: [Double], by deltas: [Double]) -> [Double] {
    path + cumulative(deltas, from: path.last ?? 0)
  }

  /// Appends `count` still samples at the path's last offset.
  private func hold(_ path: [Double], for count: Int) -> [Double] {
    path + stillPath(count, at: path.last ?? 0)
  }

  // MARK: - Fixtures

  /// Feeds `frames` and returns every emitted event with the timestamp of the
  /// sample that emitted it.
  private func run(_ detector: TemporalStrokeDetector, _ frames: [PoseFrame]) -> [(tMs: Int, event: StrokeEvent)] {
    var events: [(tMs: Int, event: StrokeEvent)] = []
    for frame in frames {
      if let event = detector.ingest(pose: frame, paddle: nil) {
        events.append((frame.timestampMs, event))
      }
    }
    return events
  }

  /// Full-body frames at `cadenceMs` from `startMs`: `path` is the right
  /// wrist's cumulative offset and `bodyPath` (same length; default still) the
  /// whole body's translation along x, both in body-heights.
  private func poses(
    bodySpan: Double,
    path: [Double],
    bodyPath: [Double]? = nil,
    startMs: Int = 0,
    confidence: Double = 0.95
  ) -> [PoseFrame] {
    path.enumerated().map { index, offset in
      fullBodyPose(
        at: startMs + index * cadenceMs,
        bodySpan: bodySpan,
        wristOffset: offset,
        bodyOffsetX: bodyPath?[index] ?? 0,
        confidence: confidence
      )
    }
  }

  /// Full body centred in the frame whose shoulder-mid → ankle-mid vertical
  /// span is `bodySpan` of the frame height. Landmark positions are a fixed
  /// template in body-heights (shoulder line = 0, ankles = 1) scaled by
  /// `bodySpan`, so `wristOffset` (body-heights, along x, applied to the right
  /// wrist) describes the same physical motion at every span. `bodyOffsetX`
  /// (body-heights) translates the whole body — walking, a camera bump.
  private func fullBodyPose(
    at timestampMs: Int,
    bodySpan: Double,
    wristOffset: Double = 0,
    leftWristOffset: Double = 0,
    bodyOffsetX: Double = 0,
    removing names: Set<String> = [],
    ankleBodyY: Double = 1.0,
    confidence: Double = 0.95
  ) -> PoseFrame {
    let template: [(name: String, x: Double, y: Double)] = [
      ("left_shoulder", -0.12, 0.0), ("right_shoulder", 0.12, 0.0),
      ("left_elbow", -0.16, 0.22), ("right_elbow", 0.16, 0.22),
      ("left_wrist", -0.18 + leftWristOffset, 0.42), ("right_wrist", 0.18 - wristOffset, 0.42),
      ("left_hip", -0.08, 0.42), ("right_hip", 0.08, 0.42),
      ("left_knee", -0.08, 0.72), ("right_knee", 0.08, 0.72),
      ("left_ankle", -0.09, ankleBodyY), ("right_ankle", 0.09, ankleBodyY),
    ]
    let shoulderY = 0.5 - bodySpan / 2
    return PoseFrame(
      timestampMs: timestampMs,
      landmarks: template.compactMap { name, x, y in
        guard !names.contains(name) else { return nil }
        return PoseLandmark(
          name: name,
          x: 0.5 + (x + bodyOffsetX) * bodySpan,
          y: shoulderY + y * bodySpan,
          visibility: 0.95
        )
      },
      confidence: confidence
    )
  }

  /// A validated paddle whose centre sits `offset` body-heights along x from
  /// its rest position beside the right wrist, translated with the body.
  private func paddleFrame(at timestampMs: Int, bodySpan: Double, offset: Double, bodyOffsetX: Double) -> PaddleFrame {
    let shoulderY = 0.5 - bodySpan / 2
    return PaddleFrame(
      timestampMs: timestampMs,
      bbox: nil,
      handleEnd: nil,
      throat: nil,
      center: CGPoint(x: 0.5 + (0.3 - offset + bodyOffsetX) * bodySpan, y: shoulderY + 0.5 * bodySpan),
      tip: nil,
      confidence: 0.9
    )
  }

  /// Heuristic-2-era fixture: only the two wrists, no body to anchor or scale.
  private func wristOnlyPose(at timestampMs: Int, rightWristX: Double) -> PoseFrame {
    PoseFrame(
      timestampMs: timestampMs,
      landmarks: [
        PoseLandmark(name: "left_wrist", x: 0.35, y: 0.5, visibility: 0.95),
        PoseLandmark(name: "right_wrist", x: rightWristX, y: 0.5, visibility: 0.95),
      ],
      confidence: 0.95
    )
  }

  // MARK: - Feature probes (document what each heuristic measured)

  private func landmark(_ name: String, in frame: PoseFrame) -> PoseLandmark? {
    frame.landmarks.first { $0.name == name }
  }

  /// Heuristic-3's feature: the right wrist's ABSOLUTE image displacement per
  /// second in body-heights (÷ `bodySpan`), one value per consecutive pair.
  private func absoluteRightWristSpeeds(_ frames: [PoseFrame], bodySpan: Double) -> [Double] {
    zip(frames, frames.dropFirst()).compactMap { previous, current in
      guard let a = landmark("right_wrist", in: previous), let b = landmark("right_wrist", in: current) else {
        return nil
      }
      let dt = Double(current.timestampMs - previous.timestampMs) / 1_000
      return hypot(b.x - a.x, b.y - a.y) / dt / bodySpan
    }
  }

  /// Heuristic-4's feature: the right wrist's displacement RELATIVE to the hip
  /// midpoint per second in body-heights, one value per consecutive pair.
  private func relativeRightWristSpeeds(_ frames: [PoseFrame], bodySpan: Double) -> [Double] {
    func relative(_ frame: PoseFrame) -> (x: Double, y: Double)? {
      guard let wrist = landmark("right_wrist", in: frame),
            let left = landmark("left_hip", in: frame),
            let right = landmark("right_hip", in: frame) else { return nil }
      return (wrist.x - (left.x + right.x) / 2, wrist.y - (left.y + right.y) / 2)
    }
    return zip(frames, frames.dropFirst()).compactMap { previous, current in
      guard let a = relative(previous), let b = relative(current) else { return nil }
      let dt = Double(current.timestampMs - previous.timestampMs) / 1_000
      return hypot(b.x - a.x, b.y - a.y) / dt / bodySpan
    }
  }

  /// Length (in samples) of the longest run of consecutive values satisfying
  /// `predicate`.
  private func longestRun(in values: [Double], where predicate: (Double) -> Bool) -> Int {
    var longest = 0
    var current = 0
    for value in values {
      current = predicate(value) ? current + 1 : 0
      longest = max(longest, current)
    }
    return longest
  }
}
