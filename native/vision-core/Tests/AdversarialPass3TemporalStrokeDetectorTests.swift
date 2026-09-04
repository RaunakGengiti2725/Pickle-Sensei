import Foundation
import XCTest
@testable import PickleVisionCore

/// Adversarial pass 3 (S15 / S16 / S21) against `TemporalStrokeDetector`.
///
/// S15 — cadence invariance. One continuous, piecewise-linear wrist
///       trajectory (the moderate forehand drive of `TemporalStrokeDetectorTests`
///       expressed as a function of time) is sampled at 40 ms (baseline),
///       8 ms (120 fps) and 66 ms (15 fps), at every sample phase, with
///       seeded timestamp jitter and with the 66/67 ms alternation a real
///       15 fps clock produces. Each run must emit exactly one event whose
///       `startMs` (and `peakMotionMs`) sit within one cadence of the
///       baseline's. FINDING (pass 3, measured on 4d812e1a): `endMs` is NOT
///       one-cadence invariant at 15 fps — the settled run's first interval
///       is recognised up to one cadence late (a 66 ms interval straddling
///       the 0.75→0.4 bh/s drop averages 0.52 > `endWristSpeed`) and the 160 ms
///       settle window is then quantised to the sample grid, so `endMs` lands
///       up to TWO cadences after the 40 ms baseline (observed 1307…1323 vs
///       1240; 1326 with ±8 ms jitter). It is never early, and the window
///       always still starts on the ready position and ends on a settled
///       tail. The assertions below pin the measured bound; the one-cadence
///       attack log is `s15-one-cadence-hypothesis-FAILS/swift-test.log`.
/// S16 — reset mid-candidate. A candidate is opened, `reset()` is called,
///       and the settled tail is fed immediately: nothing may be emitted.
///       `refractoryUntilMs` is private, so it is observed behaviourally: a
///       fresh ready position + drive fed straight after the reset — inside
///       what would have been the refractory window had one leaked — must
///       trigger; and a fast tail fed straight after the reset — with no new
///       quiet run — must NOT trigger (no stale onset).
/// S21 — two queues calling `ingest` concurrently. The detector documents
///       (and `GuidedCaptureViewController.visionQueue` implements) a
///       single-queue contract that nothing inside the class enforces. This
///       test performs the race so a Thread Sanitizer build reports it. It is
///       opt-in (`PICKLE_VISION_CORE_RACE_ATTACK=1`) because a deliberate data
///       race must never run inside the default suite: it DOES crash the
///       process (SEGV in `_NativeDictionary.lookup` on the Linux proxy).
///       Every production caller (`GuidedCaptureViewController`: `ingest` at
///       :1802 and all four `detector.reset()` sites) goes through
///       `visionQueue` / `onVisionQueue`, so the contract holds by convention.
///
///   Mac:   PICKLE_VISION_CORE_RACE_ATTACK=1 xcodebuild test -scheme PickleVisionCore \
///            -destination 'platform=macOS,arch=arm64' -enableThreadSanitizer YES \
///            -only-testing:PickleVisionCoreTests/AdversarialPass3TemporalStrokeDetectorTests
///   Linux: PICKLE_VISION_CORE_RACE_ATTACK=1 tools/linux-swift-proxy/vision-core/run.sh --tsan \
///            --filter AdversarialPass3TemporalStrokeDetectorTests/testS21
final class AdversarialPass3TemporalStrokeDetectorTests: XCTestCase {
  /// The baseline fixture cadence used by `TemporalStrokeDetectorTests`.
  private let baselineCadenceMs = 40
  /// Body span used for every frame (alignment-guide framing).
  private let bodySpan = 0.45
  /// The drive's motion begins here; before it the athlete is still. 800 ms
  /// of stillness (not the 400 ms of the baseline fixtures) so that at every
  /// sample phase of a 66 ms cadence the quiet run still clears 350 ms.
  private let motionStartMs = 800
  /// Moderate forehand drive as per-40 ms deltas in body-heights (identical to
  /// `TemporalStrokeDetectorTests.driveDeltas`): speeds 1.5, 2.0, 1.75, 1.5,
  /// 1.25, 1.0, 0.75, 0.4, 0.2, 0.1, 0.1 bh/s; path 0.422 bh.
  private let driveDeltas: [Double] = [0.06, 0.08, 0.07, 0.06, 0.05, 0.04, 0.03, 0.016, 0.008, 0.004, 0.004]
  /// Frames continue this long past the end of the motion so the settled
  /// window can close at any cadence.
  private let tailMs = 800

  // MARK: - S15 cadence invariance

  /// Baseline: sampling the trajectory at 40 ms reproduces the documented
  /// event exactly (start = last quiet sample = 800, end = 800 + 440).
  func testS15BaselineAt40MsReproducesTheDocumentedDrive() {
    let events = run(frames(cadenceMs: 40, phaseMs: 0))
    XCTAssertEqual(events.count, 1)
    XCTAssertEqual(events.first?.event.startMs, motionStartMs)
    XCTAssertEqual(events.first?.event.endMs, motionStartMs + 440)
    XCTAssertEqual(events.first?.event.peakMotionMs, motionStartMs + 80)
  }

  func testS15At120FpsEveryPhaseEmitsOneEventWithinOneCadenceOfBaseline() {
    assertCadenceInvariance(cadenceMs: 8)
  }

  /// startMs/peak within one cadence; endMs within two (see the finding above).
  func testS15At15FpsEveryPhaseEmitsOneEventStartWithinOneCadenceEndWithinTwo() {
    assertCadenceInvariance(cadenceMs: 66)
  }

  /// A real 15 fps clock is 66.67 ms: alternate 66/67 so the sample grid never
  /// re-aligns with the 40 ms knots.
  func testS15At15FpsWithAlternating66And67MsIntervalsStartWithinOneCadenceEndWithinTwo() {
    let baseline = baselineEvent()
    for phase in 0 ..< 67 {
      var timestamps: [Int] = []
      var t = phase
      var index = 0
      while t <= motionEndMs + tailMs {
        timestamps.append(t)
        t += index % 3 == 2 ? 67 : 66
        index += 1
      }
      let events = run(frames(at: timestamps))
      XCTAssertEqual(events.count, 1, "phase \(phase): expected exactly one event, got \(events.map { describe($0) })")
      guard let event = events.first?.event else { continue }
      XCTAssertLessThanOrEqual(abs(event.startMs - baseline.startMs), 67, "phase \(phase): startMs \(event.startMs) vs baseline \(baseline.startMs)")
      assertEndMs(event.endMs, baseline: baseline, cadenceMs: 67, extraMs: 0, label: "phase \(phase)")
    }
  }

  /// Seeded timestamp jitter (±2 ms at 120 fps, ±8 ms at 15 fps — camera
  /// presentation-timestamp noise) on top of the nominal cadence. Seeds are
  /// recorded in the failure message so a break is reproducible.
  func testS15SeededTimestampJitterKeepsStartWithinOneCadenceEndWithinTwo() {
    let baseline = baselineEvent()
    for (cadenceMs, jitterMs) in [(8, 2), (66, 8)] {
      for seed: UInt64 in [0x5EED_0001, 0x5EED_0002, 0x5EED_0003, 0xC0FF_EE42, 0xDEAD_BEEF] {
        var rng = SplitMix64(seed: seed)
        var timestamps: [Int] = []
        var nominal = 0
        while nominal <= motionEndMs + tailMs {
          let jitter = Int(rng.next() % UInt64(2 * jitterMs + 1)) - jitterMs
          let t = max(timestamps.last.map { $0 + 1 } ?? 0, nominal + jitter)
          timestamps.append(t)
          nominal += cadenceMs
        }
        let events = run(frames(at: timestamps))
        let label = "cadence \(cadenceMs) ms, jitter ±\(jitterMs) ms, seed 0x\(String(seed, radix: 16))"
        XCTAssertEqual(events.count, 1, "\(label): expected exactly one event, got \(events.map { describe($0) })")
        guard let event = events.first?.event else { continue }
        // One cadence plus the jitter bound: the sample grid itself moved.
        let tolerance = max(cadenceMs, baselineCadenceMs) + jitterMs
        XCTAssertLessThanOrEqual(abs(event.startMs - baseline.startMs), tolerance, "\(label): startMs \(event.startMs) vs baseline \(baseline.startMs)")
        assertEndMs(event.endMs, baseline: baseline, cadenceMs: cadenceMs, extraMs: jitterMs, label: label)
      }
    }
  }

  /// 240 fps (4 ms): sub-pixel wrist displacement per interval must not lose
  /// the event to floating-point noise or to the `pose.timestampMs > previous`
  /// guard.
  func testS15At240FpsStillEmitsOneEventWithinOneBaselineCadence() {
    assertCadenceInvariance(cadenceMs: 4)
  }

  private func assertCadenceInvariance(cadenceMs: Int) {
    let baseline = baselineEvent()
    let tolerance = max(cadenceMs, baselineCadenceMs)
    for phase in 0 ..< cadenceMs {
      let events = run(frames(cadenceMs: cadenceMs, phaseMs: phase))
      XCTAssertEqual(events.count, 1, "cadence \(cadenceMs) phase \(phase): expected exactly one event, got \(events.map { describe($0) })")
      guard let event = events.first?.event else { continue }
      XCTAssertLessThanOrEqual(abs(event.startMs - baseline.startMs), tolerance, "cadence \(cadenceMs) phase \(phase): startMs \(event.startMs) vs baseline \(baseline.startMs)")
      assertEndMs(event.endMs, baseline: baseline, cadenceMs: cadenceMs, extraMs: 0, label: "cadence \(cadenceMs) phase \(phase)")
      let peakMotionMs = event.peakMotionMs ?? Int.min
      XCTAssertLessThanOrEqual(abs(peakMotionMs - baseline.peakMotionMs), tolerance, "cadence \(cadenceMs) phase \(phase): peakMotionMs \(peakMotionMs) vs baseline \(baseline.peakMotionMs)")
      // The window must still start on the settled ready position and end on
      // a settled tail, never inside the swing.
      XCTAssertLessThanOrEqual(event.startMs, motionStartMs + cadenceMs, "cadence \(cadenceMs) phase \(phase): startMs \(event.startMs) is inside the swing")
      XCTAssertGreaterThanOrEqual(event.endMs, motionStartMs + 7 * baselineCadenceMs, "cadence \(cadenceMs) phase \(phase): endMs \(event.endMs) closed before the wrist settled")
    }
  }

  /// `endMs` may never close EARLIER than one cadence before the baseline
  /// (that would cut the settled tail) and, per the measured finding above,
  /// closes at most two cadences after it (sample grid + one late settled
  /// interval). At cadences finer than the baseline the bound is one baseline
  /// cadence each way.
  private func assertEndMs(_ endMs: Int, baseline: Baseline, cadenceMs: Int, extraMs: Int, label: String) {
    let early = max(cadenceMs, baselineCadenceMs) + extraMs
    let late = cadenceMs > baselineCadenceMs ? 2 * cadenceMs + extraMs : baselineCadenceMs + extraMs
    XCTAssertGreaterThanOrEqual(endMs, baseline.endMs - early, "\(label): endMs \(endMs) closed early vs baseline \(baseline.endMs)")
    XCTAssertLessThanOrEqual(endMs, baseline.endMs + late, "\(label): endMs \(endMs) more than two cadences after baseline \(baseline.endMs)")
  }

  // MARK: - S16 reset mid-candidate

  func testS16ResetMidCandidateThenSettledTailEmitsNothing() {
    let detector = TemporalStrokeDetector()
    let all = frames(cadenceMs: 40, phaseMs: 0)
    // Frames up to and including the peak interval (t = 800…880): the trigger
    // crossed at 840 and the candidate is open.
    let openCandidate = all.filter { $0.timestampMs <= motionStartMs + 80 }
    let settledTail = all.filter { $0.timestampMs > motionStartMs + 80 }
    XCTAssertTrue(run(detector, openCandidate).isEmpty)

    detector.reset()
    XCTAssertNil(detector.lastBodyScale, "reset must drop the body scale")

    for frame in settledTail {
      XCTAssertNil(detector.ingest(pose: frame, paddle: nil), "settled tail after reset emitted at \(frame.timestampMs)")
    }
  }

  /// No stale onset: straight after the reset the detector sees only fast
  /// motion (a second drive with no ready position in between). The onset that
  /// existed before the reset must not let it trigger.
  func testS16ResetMidCandidateThenFastMotionWithoutQuietRunNeverTriggers() {
    let detector = TemporalStrokeDetector()
    let all = frames(cadenceMs: 40, phaseMs: 0)
    XCTAssertTrue(run(detector, all.filter { $0.timestampMs <= motionStartMs + 80 }).isEmpty)
    detector.reset()

    // A whole second drive with no stillness in front of it, timestamps
    // continuing from where the first left off.
    let path = cumulative(driveDeltas + driveDeltas + driveDeltas)
    let fast = path.enumerated().map { index, offset in
      fullBodyPose(at: motionStartMs + 120 + index * 40, wristOffset: offset)
    }
    for frame in fast {
      XCTAssertNil(detector.ingest(pose: frame, paddle: nil), "fast motion after reset triggered at \(frame.timestampMs) — stale onset survived reset()")
    }
  }

  /// refractoryUntilMs == 0 after reset, observed behaviourally: complete an
  /// event (refractory = endMs + 700), reset, then feed a fresh ready position
  /// + drive that ends inside what would have been the refractory window. It
  /// must trigger.
  func testS16ResetAfterCompletionClearsTheRefractoryWindow() {
    let detector = TemporalStrokeDetector()
    let first = run(detector, frames(cadenceMs: 40, phaseMs: 0).filter { $0.timestampMs <= motionStartMs + 440 })
    XCTAssertEqual(first.count, 1)
    guard let completed = first.first?.event else { return }
    let refractoryEndMs = completed.endMs + TemporalStrokeDetector.Config().refractoryMs
    XCTAssertEqual(refractoryEndMs, motionStartMs + 440 + 700)

    detector.reset()

    // Second attempt starts 40 ms later: 10 still frames (the first yields no
    // sample after the reset, so the quiet run spans 9 intervals = 360 ms ≥
    // 350), then the drive; the trigger lands at completed.endMs + 440 <
    // refractoryEndMs.
    let restartMs = completed.endMs + 40
    let lastStillMs = restartMs + 9 * 40
    let path = cumulative(Array(repeating: 0.0, count: 10) + driveDeltas)
    let second = path.enumerated().map { index, offset in
      fullBodyPose(at: restartMs + index * 40, wristOffset: offset)
    }
    let triggerMs = lastStillMs + 40
    XCTAssertLessThan(triggerMs, refractoryEndMs, "fixture must trigger inside the would-be refractory window")
    let events = run(detector, second)
    XCTAssertEqual(events.count, 1, "drive after reset() did not emit — a refractory survived the reset")
    XCTAssertEqual(events.first?.event.startMs, lastStillMs)
    XCTAssertEqual(events.first?.event.endMs, lastStillMs + 440)
  }

  /// Without the reset the same second drive IS blocked — proves the S16
  /// fixture actually lands inside the refractory window.
  func testS16ControlWithoutResetTheSameDriveIsBlockedByRefractory() {
    let detector = TemporalStrokeDetector()
    let first = run(detector, frames(cadenceMs: 40, phaseMs: 0).filter { $0.timestampMs <= motionStartMs + 440 })
    XCTAssertEqual(first.count, 1)
    guard let completed = first.first?.event else { return }
    let restartMs = completed.endMs + 40
    let path = cumulative(Array(repeating: 0.0, count: 10) + driveDeltas)
    let second = path.enumerated().map { index, offset in
      fullBodyPose(at: restartMs + index * 40, wristOffset: offset)
    }
    XCTAssertTrue(run(detector, second).isEmpty, "control: refractory should have blocked the second drive")
  }

  /// reset() is idempotent and safe before any frame, between every frame, and
  /// many times in a row.
  func testS16RepeatedResetsAreIdempotent() {
    let detector = TemporalStrokeDetector()
    for _ in 0 ..< 1_000 { detector.reset() }
    XCTAssertNil(detector.lastBodyScale)
    for frame in frames(cadenceMs: 40, phaseMs: 0) {
      XCTAssertNil(detector.ingest(pose: frame, paddle: nil))
      detector.reset()
      XCTAssertNil(detector.lastBodyScale)
    }
  }

  // MARK: - S21 concurrent ingest (opt-in; Thread Sanitizer evidence)

  func testS21ConcurrentIngestFromTwoQueuesRacesWithoutInternalSynchronization() throws {
    guard ProcessInfo.processInfo.environment["PICKLE_VISION_CORE_RACE_ATTACK"] == "1" else {
      throw XCTSkip("deliberate data race; run with PICKLE_VISION_CORE_RACE_ATTACK=1 under Thread Sanitizer")
    }
    let detector = TemporalStrokeDetector()
    let drive = frames(cadenceMs: 8, phaseMs: 0)
    let queueA = DispatchQueue(label: "pickle.attack.vision.a", qos: .userInteractive)
    let queueB = DispatchQueue(label: "pickle.attack.vision.b", qos: .userInteractive)
    let group = DispatchGroup()
    let counter = Counter()
    for queue in [queueA, queueB] {
      group.enter()
      queue.async {
        for _ in 0 ..< 200 {
          for frame in drive {
            if detector.ingest(pose: frame, paddle: nil) != nil { counter.increment() }
          }
          detector.reset()
        }
        group.leave()
      }
    }
    XCTAssertEqual(group.wait(timeout: .now() + 120), .success, "concurrent ingest did not finish in 120 s")
    // No functional assertion is possible: the point of this test is the TSan
    // report. OBSERVED on the Linux proxy (swift 5.10.1, --sanitize=thread,
    // 4d812e1a): "Swift access race" in `TemporalStrokeDetector.ingest`,
    // "data race" in `updateBodyScale` (`lastBodyScale`), then SEGV inside
    // `_NativeDictionary.lookup` (`wristPaths`) — the process dies before this
    // line. Artifact: s21-tsan-linux-proxy/tsan-report.<pid>.
    _ = counter.value
  }

  // MARK: - Fixtures

  private var motionEndMs: Int { motionStartMs + driveDeltas.count * baselineCadenceMs }

  private struct Baseline {
    let startMs: Int
    let endMs: Int
    let peakMotionMs: Int
  }

  private func baselineEvent() -> Baseline {
    let events = run(frames(cadenceMs: baselineCadenceMs, phaseMs: 0))
    XCTAssertEqual(events.count, 1, "baseline drive must emit exactly one event")
    let event = events.first?.event
    return Baseline(
      startMs: event?.startMs ?? motionStartMs,
      endMs: event?.endMs ?? motionStartMs + 440,
      peakMotionMs: event?.peakMotionMs ?? Int.min
    )
  }

  /// The wrist's cumulative offset (body-heights) at absolute time `tMs`:
  /// still before `motionStartMs`, piecewise-linear through the 40 ms knots of
  /// `driveDeltas`, held at the final offset afterwards. This is the ONE
  /// physical motion every cadence samples.
  private func wristOffset(atMs tMs: Int) -> Double {
    let knots = cumulative(driveDeltas)
    let elapsed = tMs - motionStartMs
    guard elapsed > 0 else { return 0 }
    let segment = elapsed / baselineCadenceMs
    guard segment < knots.count else { return knots.last ?? 0 }
    let from = segment == 0 ? 0 : knots[segment - 1]
    let to = knots[segment]
    let fraction = Double(elapsed - segment * baselineCadenceMs) / Double(baselineCadenceMs)
    return from + (to - from) * fraction
  }

  private func cumulative(_ deltas: [Double]) -> [Double] {
    var total = 0.0
    return deltas.map { total += $0; return total }
  }

  private func frames(cadenceMs: Int, phaseMs: Int) -> [PoseFrame] {
    var timestamps: [Int] = []
    var t = phaseMs
    while t <= motionEndMs + tailMs {
      timestamps.append(t)
      t += cadenceMs
    }
    return frames(at: timestamps)
  }

  private func frames(at timestamps: [Int]) -> [PoseFrame] {
    timestamps.map { fullBodyPose(at: $0, wristOffset: wristOffset(atMs: $0)) }
  }

  private func run(_ frames: [PoseFrame]) -> [(tMs: Int, event: StrokeEvent)] {
    run(TemporalStrokeDetector(), frames)
  }

  private func run(_ detector: TemporalStrokeDetector, _ frames: [PoseFrame]) -> [(tMs: Int, event: StrokeEvent)] {
    var events: [(tMs: Int, event: StrokeEvent)] = []
    for frame in frames {
      if let event = detector.ingest(pose: frame, paddle: nil) {
        events.append((frame.timestampMs, event))
      }
    }
    return events
  }

  private func describe(_ entry: (tMs: Int, event: StrokeEvent)) -> String {
    "(t \(entry.tMs): start \(entry.event.startMs) end \(entry.event.endMs) peak \(String(describing: entry.event.peakMotionMs)))"
  }

  /// Same landmark template as `TemporalStrokeDetectorTests.fullBodyPose`:
  /// shoulder line = 0, ankles = 1 in body-heights, scaled by `bodySpan`;
  /// `wristOffset` moves the right wrist along x.
  private func fullBodyPose(at timestampMs: Int, wristOffset: Double) -> PoseFrame {
    let template: [(name: String, x: Double, y: Double)] = [
      ("left_shoulder", -0.12, 0.0), ("right_shoulder", 0.12, 0.0),
      ("left_elbow", -0.16, 0.22), ("right_elbow", 0.16, 0.22),
      ("left_wrist", -0.18, 0.42), ("right_wrist", 0.18 - wristOffset, 0.42),
      ("left_hip", -0.08, 0.42), ("right_hip", 0.08, 0.42),
      ("left_knee", -0.08, 0.72), ("right_knee", 0.08, 0.72),
      ("left_ankle", -0.09, 1.0), ("right_ankle", 0.09, 1.0),
    ]
    let shoulderY = 0.5 - bodySpan / 2
    return PoseFrame(
      timestampMs: timestampMs,
      landmarks: template.map { name, x, y in
        PoseLandmark(name: name, x: 0.5 + x * bodySpan, y: shoulderY + y * bodySpan, visibility: 0.95)
      },
      confidence: 0.95
    )
  }
}

/// Deterministic 64-bit generator (SplitMix64) so jitter fixtures replay from
/// a recorded seed on every platform.
struct SplitMix64 {
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

/// Lock-protected counter so the S21 harness itself introduces no race of its
/// own — every TSan report must come from the detector.
final class Counter: @unchecked Sendable {
  private let lock = NSLock()
  private var count = 0
  func increment() { lock.lock(); count += 1; lock.unlock() }
  var value: Int { lock.lock(); defer { lock.unlock() }; return count }
}
