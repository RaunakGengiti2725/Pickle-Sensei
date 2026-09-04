import XCTest
@testable import PickleVisionCore

/// Adversarial pass 3 — state-integrity probes that assert the behaviour a
/// caller would reasonably expect and are RED on the commit under test
/// (4d812e1a). Each failing test is one finding in the pass-3 report; the
/// file exists so the coordinator can see exactly which expectation is not
/// met today and can flip it green with a production fix. None of these
/// traps — a failure here is an XCTest assertion, never a crash — so the file
/// is safe to run inside the normal suite.
///
/// Reachability caveat (INFERRED from GuidedCaptureViewController): live
/// frames come from `ApplePoseProvider` (normalized Vision points, no
/// NaN/∞ observed) with CMTime presentation timestamps (monotonic within a
/// capture session) and the detector/evaluator/accumulator are `reset()` at
/// every session start. The gaps below therefore need a non-Vision provider,
/// replayed pose JSON, or a clock anomaly to reach — they are robustness
/// gaps in the public `PoseFrame` contract, not observed field crashes.
final class AdversarialStateIntegrityGapTests: XCTestCase {
  private let cadenceMs = 40
  private let readyFrames = 11
  private let bodySpan = 0.4
  private let driveDeltas: [Double] = [0.06, 0.08, 0.07, 0.06, 0.05, 0.04, 0.03, 0.016, 0.008, 0.004, 0.004]

  // MARK: - G1 — a non-finite landmark poisons the body-scale EMA for good

  /// One frame whose right ankle y is +∞ (visibility 0.95) during the ready
  /// position. `measureBodyScale` returns ∞, the EMA becomes ∞ and on the next
  /// finite frame `∞ + 0.x × (0.4 − ∞)` is NaN — permanently. Every later
  /// speed is `distance / NaN`, so the detector never triggers again until
  /// `reset()`. Expected: the scale stays finite (the sample is ignored) and
  /// the drive that follows is detected.
  func testG1NonFiniteLandmarkDoesNotPoisonTheBodyScaleOrDeafenTheDetector() {
    for corrupt in [Double.infinity, -Double.infinity, Double.nan, 1e300] {
      let detector = TemporalStrokeDetector()
      var path = stillPath(readyFrames)
      path = hold(path, for: readyFrames) // a second full quiet run after the corrupt frame
      path = move(path, by: driveDeltas)
      path = hold(path, for: 5)
      var events: [StrokeEvent] = []
      for (index, offset) in path.enumerated() {
        let frame = fullBodyPose(at: index * cadenceMs, wristOffset: offset, rightAnkleY: index == 4 ? corrupt : nil)
        if let event = detector.ingest(pose: frame, paddle: nil) { events.append(event) }
        if index >= 6 {
          XCTAssertTrue(
            detector.lastBodyScale?.isFinite ?? false,
            "corrupt=\(corrupt) t=\(index * cadenceMs) lastBodyScale=\(String(describing: detector.lastBodyScale))"
          )
        }
      }
      XCTAssertEqual(events.count, 1, "corrupt=\(corrupt): the clean drive after the corrupt frame was not detected")
      XCTAssertTrue(events.allSatisfy { $0.confidence.isFinite }, "corrupt=\(corrupt)")
    }
  }

  // MARK: - G2 — SessionMotionStream emits non-finite speeds

  /// The session motion series is consumed by the JS session engine; a wrist
  /// with x = +∞ (or a magnitude whose square overflows) produces
  /// `value = ∞`. Expected: no sample, or a finite one.
  func testG2SessionMotionStreamNeverEmitsANonFiniteSpeed() {
    for corrupt in [Double.infinity, -Double.infinity, 1e300, -1e300] {
      let stream = SessionMotionStream()
      XCTAssertNil(stream.ingest(pose: fullBodyPose(at: 0)))
      let samples = [
        stream.ingest(pose: fullBodyPose(at: 40, rightWristX: corrupt)),
        stream.ingest(pose: fullBodyPose(at: 80)),
        stream.ingest(pose: fullBodyPose(at: 120)),
      ]
      for sample in samples.compactMap({ $0 }) {
        XCTAssertTrue(sample.value.isFinite, "corrupt=\(corrupt) t=\(sample.timestampMs) value=\(sample.value)")
      }
    }
  }

  // MARK: - G3 — clock restart without reset() emits an event spanning two clocks

  /// Ready position at 0…400, then the timestamps restart from 0 (a new
  /// capture session numbering from zero without `reset()`) and the drive
  /// runs 40…440. `pose.timestampMs − onset ≤ maxOnsetToTriggerMs` has no
  /// lower bound, so the onset from the OLD clock (400) is accepted for a
  /// trigger at NEW-clock 80 and the event reads start=400, peak=80,
  /// end=440 — a 40 ms clip window that misses the swing. Expected: no
  /// event, or one whose start ≤ peak ≤ end.
  func testG3TimestampRegressionWithoutResetDoesNotEmitAnEventWhosePeakPrecedesItsStart() {
    let detector = TemporalStrokeDetector()
    var path = stillPath(readyFrames)
    path = move(path, by: driveDeltas)
    path = hold(path, for: 5)
    var timestamps = (0 ..< readyFrames).map { $0 * cadenceMs }
    timestamps += (1 ... (path.count - readyFrames)).map { $0 * cadenceMs }

    var events: [StrokeEvent] = []
    for (index, offset) in path.enumerated() {
      if let event = detector.ingest(pose: fullBodyPose(at: timestamps[index], wristOffset: offset), paddle: nil) {
        events.append(event)
      }
    }
    for event in events {
      XCTAssertLessThanOrEqual(event.startMs, event.peakMotionMs ?? event.startMs, "\(event)")
      XCTAssertLessThanOrEqual(event.peakMotionMs ?? event.endMs, event.endMs, "\(event)")
      XCTAssertLessThanOrEqual(event.endMs - event.startMs, TemporalStrokeDetector.Config().maxStrokeMs, "\(event)")
    }
  }

  // MARK: - G4 — one far-future timestamp strands readiness and evidence until reset()

  /// A single frame stamped +1 h (clock glitch) between otherwise monotonic
  /// frames. Expected: the components recover on their own once normal
  /// frames resume. Observed today (VERIFIED on Linux proxy):
  ///  • PoseReadinessEvaluator — the glitch sample never ages out of the
  ///    450 ms window (`timestamp < now − 450` is false forever), so
  ///    `stableForMs = max(0, now − first)` is pinned at 0 and the state is
  ///    `holdStill` until `ingestMissing`/`reset`.
  ///  • CaptureEvidenceAccumulator — retention is measured from the LATEST
  ///    timestamp ever seen, so every later attempt is discarded on arrival
  ///    and `summary()` over the real window is nil.
  func testG4OneFarFutureFrameDoesNotStrandReadinessOrEvidence() {
    let glitchMs = 1_000 + 3_600_000
    let evaluator = PoseReadinessEvaluator()
    let accumulator = CaptureEvidenceAccumulator()

    // 150 ms steps: a grid on which the 450 ms window can complete (see G6).
    let stepMs = 150
    var states: [PoseReadinessEvaluator.State] = []
    for index in 0 ..< 4 { // 0 … 450: ready on the 4th frame
      let frame = fullBodyPose(at: index * stepMs)
      states.append(evaluator.ingest(pose: frame).state)
      accumulator.ingest(pose: frame)
    }
    XCTAssertEqual(states.last, .ready, "precondition: ready before the glitch")

    let glitch = fullBodyPose(at: glitchMs)
    states.append(evaluator.ingest(pose: glitch).state)
    accumulator.ingest(pose: glitch)

    // 30 normal still frames: 600 … 4 950.
    for index in 4 ..< 34 {
      let frame = fullBodyPose(at: index * stepMs)
      states.append(evaluator.ingest(pose: frame).state)
      accumulator.ingest(pose: frame)
    }
    XCTAssertEqual(states.last, .ready, "readiness never recovered: tail=\(Array(states.suffix(5)))")

    let summary = accumulator.summary(
      startMs: 600, endMs: 4_950, poseSource: "t", poseModelVersion: "t", triggerAlgorithmVersion: "t"
    )
    XCTAssertNotNil(summary, "30 real pose attempts inside the window yielded no evidence")
    XCTAssertEqual(summary?.poseFrameCount, 30)
  }

  // MARK: - G6 — `ready` needs a sample at EXACTLY now − 450 ms

  /// `stableForMs = now − first kept sample`, and the window drops samples
  /// with `timestamp < now − 450`. So `stableForMs ≥ 450` holds only when a
  /// sample sits at exactly `now − 450`. The existing tests feed 0 / 225 / 450
  /// and so hit it by construction. A perfectly still athlete on a regular
  /// camera cadence whose frame grid never contains `now − 450` (25 fps = 40 ms,
  /// 30 fps = 33/34 ms, 60 fps capture with Vision processing every other
  /// frame) is `holdStill` for the WHOLE capture. `isReady` is presentation
  /// only since the un-gating ("BODY TRACKED" card + `armed` telemetry), so
  /// this is a UX/telemetry gap, not a trigger gate. Expected: a still, framed
  /// body reaches `ready` within ~500 ms on every cadence.
  func testG6StillBodyReachesReadyOnRegularCameraCadences() {
    let cadences: [(name: String, deltas: [Int])] = [
      ("25fps 40ms", [40]),
      ("30fps 33/34ms", [33, 34, 33]),
      ("60fps 16/17ms", [17, 16, 17]),
      ("60fps grid, every other frame", [33, 34, 33]), // same grid as 30 fps
      ("60fps, Vision drops 1 in 3", [33, 17]),
      ("24fps 41/42ms", [42, 41, 42]),
    ]
    for cadence in cadences {
      let evaluator = PoseReadinessEvaluator()
      var tMs = 0
      var readyAtMs: Int?
      var index = 0
      while tMs <= 3_000 {
        let snapshot = evaluator.ingest(pose: fullBodyPose(at: tMs))
        XCTAssertEqual(snapshot.jointCoverage, 1, cadence.name)
        if snapshot.isReady { readyAtMs = tMs; break }
        tMs += cadence.deltas[index % cadence.deltas.count]
        index += 1
      }
      XCTAssertNotNil(readyAtMs, "\(cadence.name): still, framed body never reached `ready` in 3 s")
      if let readyAtMs { XCTAssertLessThanOrEqual(readyAtMs, 550, cadence.name) }
    }
  }

  // MARK: - G5 — seeded fuzz across every consumer

  /// Deterministic fuzz (SplitMix64, seeds below): 400 frames per seed of
  /// random landmark counts with NaN / ±∞ / -0.0 / out-of-range / huge
  /// coordinates and visibilities, unknown names, duplicates (deduped only
  /// for `PoseReadinessEvaluator`, whose duplicate-name trap is S01 and would
  /// end the process), and mostly-monotonic timestamps with occasional
  /// regressions, repeats and long gaps. Invariants: no trap, every emitted
  /// number finite, every timestamp field ordered, every buffer bounded.
  /// On 4d812e1a the only failing assertions are G1 (`lastBodyScale`) and
  /// G2 (`SessionMotionStream` value) — see the run log.
  func testG5SeededFuzzNeverEmitsNonFiniteOutput() {
    let seeds: [UInt64] = [0x5EED_2026_0904_0001, 0x5EED_2026_0904_0002, 0xDEAD_BEEF_CAFE_F00D]
    let names = CaptureEvidenceAccumulator.canonicalJoints + ["head", "paddle", "", "🥒", "left_wrist "]
    for seed in seeds {
      var rng = SplitMix64(seed: seed)
      let detector = TemporalStrokeDetector()
      let stream = SessionMotionStream()
      let evaluator = PoseReadinessEvaluator()
      let accumulator = CaptureEvidenceAccumulator()
      var trails = PoseMotionTrailBuffer()
      var tMs = 0
      var eventCount = 0
      var bodyScaleFailures = 0
      var streamFailures = 0
      for step in 0 ..< 400 {
        switch rng.next() % 20 {
        case 0: tMs -= Int(rng.next() % 500) // regression
        case 1: break // repeat
        case 2: tMs += Int(rng.next() % 5_000) // long gap
        default: tMs += 33 + Int(rng.next() % 8)
        }
        let count = Int(rng.next() % 24)
        var landmarks: [PoseLandmark] = []
        for _ in 0 ..< count {
          landmarks.append(PoseLandmark(
            name: names[Int(rng.next() % UInt64(names.count))],
            x: rng.malformedUnit(), y: rng.malformedUnit(), visibility: rng.malformedUnit()
          ))
        }
        let confidence = rng.malformedUnit()
        let frame = PoseFrame(timestampMs: tMs, landmarks: landmarks, confidence: confidence)
        let context = "seed=\(String(seed, radix: 16)) step=\(step) t=\(tMs)"

        let paddle: PaddleFrame? = rng.next() % 3 == 0 ? PaddleFrame(
          timestampMs: tMs, bbox: nil, handleEnd: nil, throat: nil,
          center: rng.next() % 4 == 0 ? nil : CGPoint(x: rng.malformedUnit(), y: rng.malformedUnit()),
          tip: nil, confidence: rng.malformedUnit()
        ) : nil
        if let event = detector.ingest(pose: frame, paddle: paddle) {
          eventCount += 1
          XCTAssertTrue(event.confidence.isFinite && (0 ... 1).contains(event.confidence), "\(context) \(event)")
          XCTAssertLessThanOrEqual(event.startMs, event.endMs, context)
        }
        if let scale = detector.lastBodyScale, !scale.isFinite { bodyScaleFailures += 1 }
        if let sample = stream.ingest(pose: frame), !(sample.value.isFinite && sample.value >= 0) { streamFailures += 1 }
        accumulator.ingest(pose: frame)
        if rng.next() % 7 == 0 { accumulator.ingestMissing(timestampMs: tMs) }
        trails.ingest(landmarks: frame.landmarks, timestampMs: tMs)
        for segment in trails.segments(at: tMs) {
          XCTAssertTrue(segment.normalizedSpeedPerSecond.isFinite && segment.normalizedSpeedPerSecond >= 0, context)
          XCTAssertTrue((0 ... 1).contains(segment.ageFraction), context)
        }
        XCTAssertLessThanOrEqual(trails.storedSampleCount, 8 * 8, context)

        var seen = Set<String>()
        let deduped = landmarks.filter { seen.insert($0.name).inserted }
        let snapshot = evaluator.ingest(pose: PoseFrame(timestampMs: tMs, landmarks: deduped, confidence: confidence))
        XCTAssertTrue(snapshot.jointCoverage.isFinite && (0 ... 1).contains(snapshot.jointCoverage), context)
        XCTAssertGreaterThanOrEqual(snapshot.stableForMs, 0, context)
        if rng.next() % 11 == 0 { _ = evaluator.ingestMissing(timestampMs: tMs) }
      }
      // One assertion per gap per seed keeps the log readable; the counts
      // say how many of the 400 frames were affected.
      XCTAssertEqual(bodyScaleFailures, 0, "seed=\(String(seed, radix: 16)): frames with a non-finite lastBodyScale (G1)")
      XCTAssertEqual(streamFailures, 0, "seed=\(String(seed, radix: 16)): non-finite SessionMotionStream samples (G2)")

      if let summary = accumulator.summary(
        startMs: Int.min / 2, endMs: Int.max / 2, poseSource: "t", poseModelVersion: "t", triggerAlgorithmVersion: "t"
      ) {
        XCTAssertTrue(summary.meanCanonicalJointVisibility.isFinite, "seed=\(String(seed, radix: 16))")
        XCTAssertTrue(summary.meanJointCoverage.isFinite)
        XCTAssertTrue((0 ... 1).contains(summary.minimumJointCoverage))
        XCTAssertGreaterThanOrEqual(summary.trackedDurationMs, 0)
        for motion in summary.jointMotion {
          XCTAssertTrue(motion.meanNormalizedPerSecond.isFinite && motion.peakNormalizedPerSecond.isFinite)
        }
      }
      let replay = (0 ..< 50).map { index in
        PoseFrame(
          timestampMs: index * cadenceMs,
          landmarks: (0 ..< 12).map { _ in
            PoseLandmark(
              name: names[Int(rng.next() % UInt64(names.count))],
              x: rng.malformedUnit(), y: rng.malformedUnit(), visibility: rng.malformedUnit()
            )
          },
          confidence: rng.malformedUnit()
        )
      }
      if let strongest = TemporalStrokeDetector.strongestEvent(in: replay) {
        XCTAssertTrue(strongest.confidence.isFinite, "strongestEvent seed=\(String(seed, radix: 16))")
      }
      XCTAssertGreaterThanOrEqual(eventCount, 0)
    }
  }

  // MARK: - Helpers (same fixture as AdversarialMalformedInputTests)

  private func stillPath(_ count: Int, at offset: Double = 0) -> [Double] {
    Array(repeating: offset, count: count)
  }

  private func move(_ path: [Double], by deltas: [Double]) -> [Double] {
    var offset = path.last ?? 0
    return path + deltas.map { delta in
      offset += delta
      return offset
    }
  }

  private func hold(_ path: [Double], for count: Int) -> [Double] {
    path + stillPath(count, at: path.last ?? 0)
  }

  private func fullBodyPose(
    at timestampMs: Int,
    wristOffset: Double = 0,
    rightWristX: Double? = nil,
    rightAnkleY: Double? = nil,
    confidence: Double = 0.95
  ) -> PoseFrame {
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
        let imageX = 0.5 + x * bodySpan
        let imageY = shoulderY + y * bodySpan
        return PoseLandmark(
          name: name,
          x: name == "right_wrist" ? (rightWristX ?? imageX) : imageX,
          y: name == "right_ankle" ? (rightAnkleY ?? imageY) : imageY,
          visibility: 0.95
        )
      },
      confidence: confidence
    )
  }
}

/// SplitMix64 — tiny, deterministic, dependency-free PRNG for the fuzz test.
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

  /// Mostly a unit-interval Double, with a 7-in-24 chance of NaN, ±∞, -0.0,
  /// a value one ulp outside [0, 1], or a ±1e300 magnitude.
  mutating func malformedUnit() -> Double {
    switch next() % 24 {
    case 0: return .nan
    case 1: return .infinity
    case 2: return -.infinity
    case 3: return -0.0
    case 4: return 1.0.nextUp
    case 5: return 0.0.nextDown
    case 6: return next() % 2 == 0 ? 1e300 : -1e300
    default: return Double(next() >> 11) / Double(1 << 53)
    }
  }
}
