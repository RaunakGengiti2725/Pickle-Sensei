import XCTest
@testable import PickleVisionCore

/// Adversarial round 11 (cluster `native-vision-core`) against e0369e84.
/// Every test is deterministic; the property campaign is seeded with SplitMix64
/// (`Attack11Rng`). Tests named `testAttack…` encode the EXPECTED behaviour of
/// the candidate claims — a red `testAttack…` test is an observed break, a
/// green one is a confirmed claim. Linux shadow evidence only: nothing here
/// says anything about Apple Vision / iOS runtime behaviour.
final class AttackFix11NativeTests: XCTestCase {
  // MARK: - Claim 1: `PoseFrame.init` domain boundary

  /// The closed ranges are inclusive at every edge: -1, 2, 0 and 1 are kept,
  /// the next representable value past each edge is dropped, and the funny
  /// doubles (-0.0, subnormals, the last value below 2) are ordinary members.
  func testAttackDomainEdgesAreInclusiveAndTheNextRepresentableValueIsDropped() {
    let kept: [PoseLandmark] = [
      PoseLandmark(name: "a", x: -1, y: 2, visibility: 0),
      PoseLandmark(name: "b", x: 2, y: -1, visibility: 1),
      PoseLandmark(name: "c", x: 1.9999999, y: -0.9999999, visibility: 0.5),
      PoseLandmark(name: "d", x: -0.0, y: -0.0, visibility: -0.0),
      PoseLandmark(name: "e", x: Double.leastNonzeroMagnitude, y: -Double.leastNonzeroMagnitude, visibility: Double.leastNonzeroMagnitude),
      PoseLandmark(name: "f", x: Double.leastNormalMagnitude, y: 2.0.nextDown, visibility: 1.0.nextDown),
      PoseLandmark(name: "g", x: (-1.0).nextUp, y: 0.5, visibility: 0.0.nextUp),
    ]
    let dropped: [PoseLandmark] = [
      PoseLandmark(name: "h", x: 2.0000001, y: 0.5, visibility: 0.5),
      PoseLandmark(name: "i", x: 2.0.nextUp, y: 0.5, visibility: 0.5),
      PoseLandmark(name: "j", x: -1.0000001, y: 0.5, visibility: 0.5),
      PoseLandmark(name: "k", x: (-1.0).nextDown, y: 0.5, visibility: 0.5),
      PoseLandmark(name: "l", x: 0.5, y: 2.0.nextUp, visibility: 0.5),
      PoseLandmark(name: "m", x: 0.5, y: 0.5, visibility: 1.0.nextUp),
      PoseLandmark(name: "n", x: 0.5, y: 0.5, visibility: -Double.leastNonzeroMagnitude),
      PoseLandmark(name: "o", x: .nan, y: 0.5, visibility: 0.5),
      PoseLandmark(name: "p", x: 0.5, y: -.infinity, visibility: 0.5),
      PoseLandmark(name: "q", x: 0.5, y: 0.5, visibility: .nan),
      PoseLandmark(name: "r", x: 0.5, y: 0.5, visibility: .infinity),
      PoseLandmark(name: "s", x: .signalingNaN, y: 0.5, visibility: 0.5),
    ]
    let frame = PoseFrame(timestampMs: 0, landmarks: dropped + kept, confidence: 0.9)
    XCTAssertEqual(frame.landmarks.map(\.name), kept.map(\.name))
    XCTAssertEqual(frame.landmarks.map(\.x), kept.map(\.x))
    XCTAssertEqual(frame.landmarks.map(\.y), kept.map(\.y))
    XCTAssertEqual(frame.landmarks.map(\.visibility), kept.map(\.visibility))

    // Non-finite confidence → 0; finite confidence is passed through untouched.
    XCTAssertEqual(PoseFrame(timestampMs: 0, landmarks: [], confidence: .nan).confidence, 0)
    XCTAssertEqual(PoseFrame(timestampMs: 0, landmarks: [], confidence: -.infinity).confidence, 0)
    XCTAssertEqual(PoseFrame(timestampMs: 0, landmarks: [], confidence: -0.0).confidence, 0)
    XCTAssertEqual(PoseFrame(timestampMs: 0, landmarks: [], confidence: 0.95).confidence, 0.95)
  }

  /// ORDER OF OPERATIONS: the domain filter runs before the dedupe, so a
  /// later, more visible but out-of-domain duplicate can neither replace an
  /// in-domain first sample nor erase the joint by being filtered "after"
  /// winning the dedupe. Provider position of the surviving sample is that of
  /// its first in-domain occurrence.
  func testAttackOutOfDomainDuplicateIsDroppedBeforeDedupeInEitherOrder() {
    let inDomain = PoseLandmark(name: "left_wrist", x: 0.36, y: 0.50, visibility: 0.40)
    let corruptCoordinate = PoseLandmark(name: "left_wrist", x: 2.0.nextUp, y: 0.50, visibility: 0.99)
    let corruptVisibility = PoseLandmark(name: "left_wrist", x: 0.02, y: 0.02, visibility: 1.5)
    let nonFinite = PoseLandmark(name: "left_wrist", x: .infinity, y: 0.50, visibility: 1)
    let other = PoseLandmark(name: "right_wrist", x: 0.64, y: 0.50, visibility: 0.9)

    for order in [
      [inDomain, corruptCoordinate, corruptVisibility, nonFinite],
      [corruptCoordinate, inDomain, corruptVisibility, nonFinite],
      [corruptCoordinate, corruptVisibility, nonFinite, inDomain],
    ] {
      let frame = PoseFrame(timestampMs: 0, landmarks: [other] + order, confidence: 0.9)
      XCTAssertEqual(frame.landmarks.map(\.name), ["right_wrist", "left_wrist"])
      XCTAssertEqual(frame.landmarks[1].x, 0.36)
      XCTAssertEqual(frame.landmarks[1].visibility, 0.40)
    }
    // Provider order of the kept sample: the first IN-DOMAIN occurrence.
    let frame = PoseFrame(timestampMs: 0, landmarks: [corruptCoordinate, other, inDomain], confidence: 0.9)
    XCTAssertEqual(frame.landmarks.map(\.name), ["right_wrist", "left_wrist"])
  }

  /// A visibility tie with different coordinates has exactly one deterministic
  /// winner (the first), and every consumer sees that same point: the frame
  /// with duplicates must be indistinguishable from the frame carrying only the
  /// winner for readiness, the detector's body scale, the motion stream and
  /// the evidence accumulator.
  func testAttackVisibilityTieWinnerIsTheSamePointForEveryConsumer() {
    func duplicated(_ t: Int, farFirst: Bool) -> PoseFrame {
      var landmarks = body(t: t).landmarks
      let far = PoseLandmark(name: "left_hip", x: 0.10, y: 0.10, visibility: 0.95)
      let farWrist = PoseLandmark(name: "left_wrist", x: 0.05, y: 0.95, visibility: 0.95)
      if farFirst {
        landmarks.insert(far, at: 0)
        landmarks.insert(farWrist, at: 0)
      } else {
        landmarks.append(far)
        landmarks.append(farWrist)
      }
      return PoseFrame(timestampMs: t, landmarks: landmarks, confidence: 0.95)
    }
    let firstWins = duplicated(0, farFirst: false)
    let farWins = duplicated(0, farFirst: true)
    XCTAssertEqual(firstWins.landmarks.first { $0.name == "left_hip" }?.x, 0.45)
    XCTAssertEqual(farWins.landmarks.first { $0.name == "left_hip" }?.x, 0.10)
    XCTAssertEqual(firstWins.landmarks.map(\.name).count, Set(firstWins.landmarks.map(\.name)).count)

    // Same winner ⇒ same downstream state as the duplicate-free frame.
    let reference = PoseReadinessEvaluator()
    let duplicatesEvaluator = PoseReadinessEvaluator()
    let referenceDetector = TemporalStrokeDetector()
    let duplicatesDetector = TemporalStrokeDetector()
    let referenceStream = SessionMotionStream()
    let duplicatesStream = SessionMotionStream()
    let referenceAccumulator = CaptureEvidenceAccumulator(retentionMs: 60_000)
    let duplicatesAccumulator = CaptureEvidenceAccumulator(retentionMs: 60_000)
    var t = 0
    while t <= 1_000 {
      let clean = body(t: t)
      let dup = duplicated(t, farFirst: false)
      XCTAssertEqual(reference.ingest(pose: clean).state, duplicatesEvaluator.ingest(pose: dup).state, "t=\(t)")
      _ = referenceDetector.ingest(pose: clean, paddle: nil)
      _ = duplicatesDetector.ingest(pose: dup, paddle: nil)
      XCTAssertEqual(referenceDetector.lastBodyScale, duplicatesDetector.lastBodyScale, "t=\(t)")
      XCTAssertEqual(referenceStream.ingest(pose: clean)?.value, duplicatesStream.ingest(pose: dup)?.value, "t=\(t)")
      referenceAccumulator.ingest(pose: clean)
      duplicatesAccumulator.ingest(pose: dup)
      t += 33
    }
    XCTAssertEqual(
      referenceAccumulator.summary(startMs: 0, endMs: 1_000, poseSource: "x", poseModelVersion: "y", triggerAlgorithmVersion: "z"),
      duplicatesAccumulator.summary(startMs: 0, endMs: 1_000, poseSource: "x", poseModelVersion: "y", triggerAlgorithmVersion: "z")
    )
  }

  /// A first frame whose shoulders sit on its ankles (span 0) must not seed a
  /// zero body scale: the detector keeps the fallback, every speed stays
  /// finite, and the first real span seeds the EMA directly.
  func testAttackZeroSpanFirstFrameNeverDividesByZero() {
    let detector = TemporalStrokeDetector()
    let stream = SessionMotionStream()
    let evaluator = PoseReadinessEvaluator()
    func flat(_ t: Int, wristX: Double) -> PoseFrame {
      PoseFrame(
        timestampMs: t,
        landmarks: [
          PoseLandmark(name: "left_shoulder", x: 0.43, y: 0.60, visibility: 0.95),
          PoseLandmark(name: "right_shoulder", x: 0.57, y: 0.60, visibility: 0.95),
          PoseLandmark(name: "left_elbow", x: 0.39, y: 0.60, visibility: 0.95),
          PoseLandmark(name: "right_elbow", x: 0.61, y: 0.60, visibility: 0.95),
          PoseLandmark(name: "left_wrist", x: wristX, y: 0.60, visibility: 0.95),
          PoseLandmark(name: "right_wrist", x: 0.64, y: 0.60, visibility: 0.95),
          PoseLandmark(name: "left_hip", x: 0.45, y: 0.60, visibility: 0.95),
          PoseLandmark(name: "right_hip", x: 0.55, y: 0.60, visibility: 0.95),
          PoseLandmark(name: "left_knee", x: 0.45, y: 0.60, visibility: 0.95),
          PoseLandmark(name: "right_knee", x: 0.55, y: 0.60, visibility: 0.95),
          PoseLandmark(name: "left_ankle", x: 0.43, y: 0.60, visibility: 0.95),
          PoseLandmark(name: "right_ankle", x: 0.57, y: 0.60, visibility: 0.95),
        ],
        confidence: 0.95
      )
    }
    for index in 0 ..< 30 {
      let frame = flat(index * 33, wristX: index % 2 == 0 ? 0.30 : 0.40)
      XCTAssertNil(detector.ingest(pose: frame, paddle: nil))
      XCTAssertNil(detector.lastBodyScale, "span 0 must not seed the EMA")
      if let sample = stream.ingest(pose: frame) {
        XCTAssertTrue(sample.value.isFinite)
      }
      let snapshot = evaluator.ingest(pose: frame)
      XCTAssertEqual(snapshot.state, .moveCloser)
      XCTAssertEqual(snapshot.stableForMs, 0)
    }
    _ = detector.ingest(pose: body(t: 1_000), paddle: nil)
    XCTAssertEqual(detector.lastBodyScale ?? -1, 0.65, accuracy: 1e-9, "first real span seeds directly")
    // A collapsed span below the measurable minimum never seeds either.
    let tiny = TemporalStrokeDetector()
    _ = tiny.ingest(pose: body(t: 0, heightScale: 0.04 / 0.65), paddle: nil)
    XCTAssertNil(tiny.lastBodyScale)
    _ = tiny.ingest(pose: body(t: 33, heightScale: 0.06 / 0.65), paddle: nil)
    XCTAssertEqual(tiny.lastBodyScale ?? -1, 0.06, accuracy: 1e-9)
  }

  /// dt = 1 ms with dx = 3 (the whole -1…2 domain) is finite: the motion
  /// stream reports ≈ 3000 u/s and the detector's speeds stay finite. Neither
  /// consumer clamps. Whether that ONE-FRAME teleport may complete as a stroke
  /// is recorded by `testAttackSingleFrameTeleportIsNotAStroke`.
  func testAttackDomainWideTeleportInOneMillisecondIsFiniteAndUnclamped() {
    let stream = SessionMotionStream()
    let detector = TemporalStrokeDetector()
    _ = stream.ingest(pose: body(t: 0, leftWristX: -1))
    _ = detector.ingest(pose: body(t: 0, leftWristX: -1), paddle: nil)
    let sample = stream.ingest(pose: body(t: 1, leftWristX: 2))
    XCTAssertNotNil(sample)
    XCTAssertTrue(sample?.value.isFinite ?? false)
    XCTAssertEqual(sample?.value ?? -1, 3_000, accuracy: 1e-6, "no clamp: 3 units in 1 ms")
    XCTAssertNil(detector.ingest(pose: body(t: 1, leftWristX: 2), paddle: nil))
    XCTAssertTrue(detector.lastBodyScale?.isFinite ?? false)
  }

  /// A wrist that jumps across the whole domain between two consecutive frames
  /// and then holds still is a detector glitch (a joint swap / misdetection),
  /// not a swing: nothing else on the body moved. The claim says no consumer
  /// reaches an "absurd" state from any landmark input; a StrokeEvent produced
  /// by a single displaced sample is one. dx = 3 needs the full -1…2 domain
  /// (unreachable from Vision's 0…1 output); dx = 1 at 33 ms is reachable
  /// (a left/right wrist swap). Pre-existing detector heuristic, not
  /// introduced by e0369e84.
  func testAttackSingleFrameTeleportIsNotAStroke() {
    for (dx, dtMs) in [(3.0, 1), (1.0, 33)] {
      let detector = TemporalStrokeDetector()
      var t = 0
      var events: [StrokeEvent] = []
      // 1 s of quiet ready position.
      while t < 1_000 {
        if let event = detector.ingest(pose: body(t: t, leftWristX: 0.36), paddle: nil) { events.append(event) }
        t += 33
      }
      // One frame later the wrist is dx away; from then on it holds there.
      let jumpT = t - 33 + dtMs
      if let event = detector.ingest(pose: body(t: jumpT, leftWristX: min(2, 0.36 + dx)), paddle: nil) { events.append(event) }
      t = jumpT
      while t < jumpT + 1_500 {
        t += 33
        if let event = detector.ingest(pose: body(t: t, leftWristX: min(2, 0.36 + dx)), paddle: nil) { events.append(event) }
      }
      XCTAssertEqual(events.count, 0, "dx=\(dx) over \(dtMs) ms emitted \(events.map { "[\($0.startMs)…\($0.endMs) conf \($0.confidence)]" })")
    }
  }

  // MARK: - Claim 2: readiness timing

  private struct OracleSample {
    let t: Int
    let position: Int
  }

  /// 10k seeds × random cadence 20–120 fps (jittered, whole ms) × camera drops
  /// ≤ 450 ms × occasional silences > 450 ms × stalled clocks (equal
  /// timestamps, sometimes carrying a different position) × 1 ms clock
  /// regressions × Vision misses × real steps (centre travel 0.2) × natural
  /// sway (≤ ±0.02, never a step). The oracle implements the CLAIM, not the
  /// code: a run is the newest maximal sequence of framed poses at one
  /// position with every inter-frame gap in 0 < gap ≤ 450 (an equal timestamp
  /// replaces the run's newest sample); ready ⇔ run spans ≥ 450, and then
  /// stableForMs = t − (newest run sample ≤ t − 450). Never ready otherwise.
  func testAttackPropertyReadinessMatchesTheClaimUnderMixedEvents() {
    let seeds: UInt64 = 10_000
    let window = PoseReadinessEvaluator.Config().stableDurationMs
    let maximumGap = PoseReadinessEvaluator.Config().maximumSampleGapMs
    var readyFrames = 0
    var movedFrames = 0
    var totalFrames = 0
    for seed in 0 ..< seeds {
      var rng = Attack11Rng(seed: seed)
      let evaluator = PoseReadinessEvaluator()
      let fps = 20 + Double(rng.next() % 101)
      let periodMs = 1_000.0 / fps
      let dropRate = Double(rng.next() % 40) / 100.0
      let missRate = Double(rng.next() % 6) / 100.0
      let stallRate = Double(rng.next() % 15) / 100.0
      let stepRate = Double(rng.next() % 8) / 100.0
      let frames = 80 + Int(rng.next() % 220)
      var clock = Double(rng.next() % 5_000)
      var lastT = -1
      var run: [OracleSample] = []
      var position = 0
      var stepFramesLeft = 0
      for _ in 0 ..< frames {
        var t: Int
        let roll = rng.next() % 1_000
        if roll < 5, lastT > 0 {
          // Clock regressed by exactly 1 ms.
          t = lastT - 1
          clock = Double(t)
        } else if roll < 5 + UInt64(stallRate * 1_000), lastT >= 0 {
          t = lastT
        } else if roll < 20 + UInt64(stallRate * 1_000) {
          // Silence longer than the window (app suspended / inference stalled).
          clock += Double(maximumGap + 1 + Int(rng.next() % 1_500))
          t = Int(clock.rounded())
        } else {
          let jitter = (Double(rng.next() % 1_000) / 1_000.0 - 0.5) * periodMs * 0.4
          clock += periodMs
          t = max(lastT, Int((clock + jitter).rounded()))
        }
        lastT = t

        if Double(rng.next() % 1_000) / 1_000.0 < dropRate { continue }  // camera drop
        totalFrames += 1
        if Double(rng.next() % 1_000) / 1_000.0 < missRate {
          let snapshot = evaluator.ingestMissing(timestampMs: t)
          run.removeAll()
          XCTAssertEqual(snapshot.state, .noPerson)
          XCTAssertEqual(snapshot.stableForMs, 0)
          continue
        }
        if stepFramesLeft > 0 {
          stepFramesLeft -= 1
        } else if Double(rng.next() % 1_000) / 1_000.0 < stepRate {
          position = (position + 1) % 3  // three spots 0.2 apart, all inside the margins
          stepFramesLeft = Int(rng.next() % 40)
          movedFrames += 1
        }
        let sway = (Double(rng.next() % 41) - 20) / 1_000.0  // ±0.020
        let pose = body(t: t, xOffset: Double(position - 1) * 0.2 + sway)
        let snapshot = evaluator.ingest(pose: pose)

        // Oracle.
        if let last = run.last {
          if last.t == t {
            run.removeLast()
          } else if t < last.t || t - last.t > maximumGap {
            run.removeAll()
          }
        }
        run.append(OracleSample(t: t, position: position))
        if run.contains(where: { $0.position != position }) {
          run = [OracleSample(t: t, position: position)]
        }
        let span = t - run[0].t
        let context = "seed \(seed) fps \(Int(fps)) t=\(t) position=\(position) run=\(run.map(\.t).suffix(6)) span=\(span)"
        let expectedState: PoseReadinessEvaluator.State
        let expectedStableForMs: Int
        if span >= window {
          let anchor = run.last { $0.t <= t - window }!
          expectedState = .ready
          expectedStableForMs = t - anchor.t
          readyFrames += 1
        } else {
          expectedState = .holdStill
          expectedStableForMs = 0
        }
        guard snapshot.state == expectedState, snapshot.stableForMs == expectedStableForMs else {
          // First divergence is the repro; stop so the log stays readable.
          XCTFail("expected \(expectedState)/\(expectedStableForMs) ms, observed \(snapshot.state)/\(snapshot.stableForMs) ms — \(context)")
          return
        }
      }
    }
    XCTAssertGreaterThan(readyFrames, 100_000)
    XCTAssertGreaterThan(movedFrames, 5_000)
    XCTAssertGreaterThan(totalFrames, 1_000_000)
  }

  /// (t, t, t+33, t+33, …): replace-on-equal never touches the anchor, the
  /// window becomes ready exactly at the first delivered t ≥ 450 and reports
  /// the anchor contract on both the original and the repeated frame.
  func testAttackEqualTimestampsInterleavedWithProgressKeepTheAnchor() {
    let evaluator = PoseReadinessEvaluator()
    var delivered: [Int] = []
    var t = 0
    while t <= 1_500 {
      delivered.append(t)
      for repetition in 0 ..< 2 {
        let snapshot = evaluator.ingest(pose: body(t: t))
        if t >= 450 {
          let anchor = delivered.last { $0 <= t - 450 }!
          XCTAssertEqual(snapshot.state, .ready, "t=\(t) rep \(repetition)")
          XCTAssertEqual(snapshot.stableForMs, t - anchor, "t=\(t) rep \(repetition)")
        } else {
          XCTAssertEqual(snapshot.state, .holdStill, "t=\(t) rep \(repetition)")
          XCTAssertEqual(snapshot.stableForMs, 0)
        }
      }
      t += 33
    }
    // A repeated timestamp carrying a step restarts the window; the still
    // frame that follows on the SAME timestamp cannot resurrect it.
    let stepped = evaluator.ingest(pose: body(t: t, xOffset: 0.2))
    XCTAssertEqual(stepped.state, .holdStill)
    XCTAssertEqual(stepped.stableForMs, 0)
    XCTAssertEqual(evaluator.ingest(pose: body(t: t)).state, .holdStill)
    XCTAssertEqual(evaluator.ingest(pose: body(t: t + 449)).state, .holdStill)
    let fresh = evaluator.ingest(pose: body(t: t + 450))
    XCTAssertEqual(fresh.state, .ready)
    XCTAssertEqual(fresh.stableForMs, 450)
  }

  func testAttackClockRegressionByOneMillisecondRestartsTheWindow() {
    let evaluator = PoseReadinessEvaluator()
    _ = evaluator.ingest(pose: body(t: 1_000))
    _ = evaluator.ingest(pose: body(t: 1_225))
    XCTAssertEqual(evaluator.ingest(pose: body(t: 1_450)).state, .ready)
    let regressed = evaluator.ingest(pose: body(t: 1_449))
    XCTAssertEqual(regressed.state, .holdStill)
    XCTAssertEqual(regressed.stableForMs, 0)
    XCTAssertEqual(evaluator.ingest(pose: body(t: 1_898)).state, .holdStill)
    let ready = evaluator.ingest(pose: body(t: 1_899))
    XCTAssertEqual(ready.state, .ready)
    XCTAssertEqual(ready.stableForMs, 450)
  }

  /// Gap boundaries measured on both ends of the window: a 450 ms silence
  /// right after the anchor, right before the newest sample, and a 451 ms one
  /// in either place.
  func testAttackGapOfExactlyTheMaximumIsContinuousAndOneMoreIsNot() {
    for (gaps, expectReady) in [
      ([450, 33, 33, 33, 33], true),  // gap right after the anchor
      ([33, 33, 33, 33, 450], true),  // gap right before the newest
      ([451, 33, 33, 33, 33], false),
      ([33, 33, 33, 33, 451], false),
    ] as [([Int], Bool)] {
      let evaluator = PoseReadinessEvaluator()
      var t = 0
      var snapshot = evaluator.ingest(pose: body(t: t))
      for gap in gaps {
        t += gap
        snapshot = evaluator.ingest(pose: body(t: t))
      }
      XCTAssertEqual(snapshot.state, expectReady ? .ready : .holdStill, "gaps \(gaps)")
      if expectReady {
        XCTAssertGreaterThanOrEqual(snapshot.stableForMs, 450, "gaps \(gaps)")
      } else {
        XCTAssertEqual(snapshot.stableForMs, 0, "gaps \(gaps)")
      }
    }
  }

  /// HISTORY CAP vs MOVEMENT. `remove(at: 1)` evicts the oldest non-anchor
  /// samples. Two sub-tolerance excursions in opposite directions (+0.03 then
  /// −0.03, pairwise 0.06 > 0.055) inside ONE 450 ms window are a step the
  /// claim says restarts the window — and at 100 fps they do. At ≈ 667 fps
  /// (300 frames per window) and 1000 fps the +0.03 samples are evicted by the
  /// cap before the −0.03 samples arrive, so the pairwise scan never sees the
  /// 0.06 and the athlete is reported ready.
  func testAttackHistoryCapEvictionCannotHideAStepInsideTheWindow() {
    for periodMs in [10.0, 1.5, 1.0] {
      let evaluator = PoseReadinessEvaluator()
      var readyAt: Int?
      var frames = 0
      var k = 0
      var t = 0
      while t <= 450 {
        let offset: Double
        switch t {
        case 0: offset = 0
        case 1 ... 30: offset = 0.03
        case 31 ... 420: offset = 0
        default: offset = -0.03
        }
        let snapshot = evaluator.ingest(pose: body(t: t, xOffset: offset))
        frames += 1
        if snapshot.state == .ready, readyAt == nil { readyAt = t }
        k += 1
        t = Int((Double(k) * periodMs).rounded())
      }
      XCTAssertNil(
        readyAt,
        "\(Int((1_000 / periodMs).rounded())) fps (\(frames) frames in the window): ready at \(readyAt ?? -1) although the centre travelled 0.06 inside the window"
      )
    }
  }

  /// HISTORY CAP vs ANCHOR. With > 256 samples per window the evicted samples
  /// include the true anchor (newest ≤ t − 450), so `stableForMs` is measured
  /// from the oldest retained sample instead: at 1000 fps a still athlete at
  /// t = 705 reads 705 ms instead of 450.
  func testAttackHistoryCapEvictionKeepsTheAnchorContract() {
    let evaluator = PoseReadinessEvaluator()
    var worst = 0
    for t in 0 ... 705 {
      let snapshot = evaluator.ingest(pose: body(t: t))
      if t >= 450 {
        XCTAssertEqual(snapshot.state, .ready)
        worst = max(worst, snapshot.stableForMs - 450)
      }
    }
    XCTAssertEqual(worst, 0, "stableForMs exceeded the anchor contract by \(worst) ms")
  }

  /// A still→step→back-to-the-original-spot sequence at a cadence inside the
  /// cap (120 fps) is caught: the step itself is > 0.055 and restarts the
  /// window on the frame it happens; the return is > 0.055 from the step.
  func testAttackStepAndReturnInsideTheWindowRestartsTwice() {
    let evaluator = PoseReadinessEvaluator()
    var t = 0
    while t < 450 { _ = evaluator.ingest(pose: body(t: t)); t += 8 }
    XCTAssertEqual(evaluator.ingest(pose: body(t: 456)).state, .ready)
    let stepped = evaluator.ingest(pose: body(t: 464, xOffset: 0.1))
    XCTAssertEqual(stepped.state, .holdStill)
    let returned = evaluator.ingest(pose: body(t: 472))
    XCTAssertEqual(returned.state, .holdStill)
    t = 480
    while t < 472 + 450 {
      XCTAssertEqual(evaluator.ingest(pose: body(t: t)).state, .holdStill, "t=\(t)")
      t += 8
    }
    XCTAssertEqual(evaluator.ingest(pose: body(t: 472 + 450)).state, .ready)
  }

  /// Int.max on the newest side (no cutoff overflow, anchor exactly at the
  /// cutoff) and Int.min on the oldest side (cutoff overflows for the first
  /// 450 frames, nothing may be pruned, the cap still bounds the history).
  func testAttackExtremeTimestampsHonourTheWindowWithoutTrapping() {
    let top = PoseReadinessEvaluator()
    _ = top.ingest(pose: body(t: Int.max - 450))
    XCTAssertEqual(top.ingest(pose: body(t: Int.max - 225)).state, .holdStill)
    let ready = top.ingest(pose: body(t: Int.max))
    XCTAssertEqual(ready.state, .ready)
    XCTAssertEqual(ready.stableForMs, 450)
    let repeated = top.ingest(pose: body(t: Int.max))
    XCTAssertEqual(repeated.state, .ready)
    XCTAssertEqual(repeated.stableForMs, 450)
    XCTAssertEqual(top.ingest(pose: body(t: Int.max, xOffset: 0.2)).state, .holdStill)
    XCTAssertEqual(top.ingest(pose: body(t: Int.max)).stableForMs, 0)
    XCTAssertEqual(top.ingestMissing(timestampMs: Int.max).state, .noPerson)
    XCTAssertEqual(top.ingest(pose: body(t: Int.max)).state, .holdStill)

    let bottom = PoseReadinessEvaluator()
    for k in 0 ..< 450 {
      let snapshot = bottom.ingest(pose: body(t: Int.min + k))
      XCTAssertEqual(snapshot.state, .holdStill, "k=\(k)")
      XCTAssertEqual(snapshot.stableForMs, 0, "k=\(k)")
    }
    let first = bottom.ingest(pose: body(t: Int.min + 450))
    XCTAssertEqual(first.state, .ready)
    XCTAssertEqual(first.stableForMs, 450)
    // A step while the cutoff still cannot be computed must restart too.
    let low = PoseReadinessEvaluator()
    _ = low.ingest(pose: body(t: Int.min))
    _ = low.ingest(pose: body(t: Int.min + 200))
    XCTAssertEqual(low.ingest(pose: body(t: Int.min + 300, xOffset: 0.2)).state, .holdStill)
    XCTAssertEqual(low.ingest(pose: body(t: Int.min + 449)).state, .holdStill)
    XCTAssertEqual(low.ingest(pose: body(t: Int.min + 749)).state, .holdStill)
    XCTAssertEqual(low.ingest(pose: body(t: Int.min + 899)).state, .ready)
  }

  // MARK: - Core-joint geometry

  /// Torso and legs still, both arms swinging wildly inside the margins: the
  /// candidate claims `ready` (stillness is the core box). Recorded so the
  /// judge can weigh it against the product copy ("Set your feet, then
  /// swing" / "Swing when ready" — readiness is presentation only since
  /// DETECTION IS NEVER GATED ON FRAMING).
  func testAttackWildArmSwingWithStillCoreReachesReady() {
    let evaluator = PoseReadinessEvaluator()
    var t = 0
    var readyFrames = 0
    var index = 0
    while t <= 2_000 {
      let swing = index % 2 == 0
      let frame = PoseFrame(
        timestampMs: t,
        landmarks: body(t: t).landmarks.map {
          switch $0.name {
          case "left_wrist": return PoseLandmark(name: $0.name, x: swing ? 0.10 : 0.60, y: swing ? 0.10 : 0.80, visibility: 0.95)
          case "right_wrist": return PoseLandmark(name: $0.name, x: swing ? 0.88 : 0.40, y: swing ? 0.85 : 0.15, visibility: 0.95)
          case "left_elbow": return PoseLandmark(name: $0.name, x: swing ? 0.20 : 0.50, y: swing ? 0.20 : 0.60, visibility: 0.95)
          case "right_elbow": return PoseLandmark(name: $0.name, x: swing ? 0.80 : 0.50, y: swing ? 0.60 : 0.20, visibility: 0.95)
          default: return $0
          }
        },
        confidence: 0.95
      )
      let snapshot = evaluator.ingest(pose: frame)
      if t >= 450 {
        XCTAssertEqual(snapshot.state, .ready, "t=\(t)")
        readyFrames += 1
      } else {
        XCTAssertEqual(snapshot.state, .holdStill, "t=\(t)")
      }
      t += 33
      index += 1
    }
    XCTAssertGreaterThan(readyFrames, 40)
  }

  /// Framing is still judged on the FULL visible set: a wrist or an elbow at
  /// the frame edge blocks readiness with a still core, a raised wrist that
  /// makes the full box too tall says move farther, and each such frame
  /// restarts the window.
  func testAttackFrameMarginAndSizeStillUseTheFullVisibleSet() {
    for (name, transform, expected) in [
      ("left_wrist at x=0.02", { (l: PoseLandmark) in l.name == "left_wrist" ? PoseLandmark(name: l.name, x: 0.02, y: l.y, visibility: l.visibility) : l }, PoseReadinessEvaluator.State.fullBodyRequired),
      ("right_elbow at x=0.98", { (l: PoseLandmark) in l.name == "right_elbow" ? PoseLandmark(name: l.name, x: 0.98, y: l.y, visibility: l.visibility) : l }, .fullBodyRequired),
      ("left_wrist at y=0.976", { (l: PoseLandmark) in l.name == "left_wrist" ? PoseLandmark(name: l.name, x: l.x, y: 0.976, visibility: l.visibility) : l }, .fullBodyRequired),
      ("left_wrist raised to y=0.01", { (l: PoseLandmark) in l.name == "left_wrist" ? PoseLandmark(name: l.name, x: l.x, y: 0.01, visibility: l.visibility) : l }, .fullBodyRequired),
      ("left_wrist raised to y=0.03 (box 0.87 tall) keeps ready", { (l: PoseLandmark) in l.name == "left_wrist" ? PoseLandmark(name: l.name, x: l.x, y: 0.03, visibility: l.visibility) : l }, .ready),
      ("wrists spread to width 0.85", { (l: PoseLandmark) in
        l.name == "left_wrist" ? PoseLandmark(name: l.name, x: 0.05, y: l.y, visibility: l.visibility)
          : l.name == "right_wrist" ? PoseLandmark(name: l.name, x: 0.90, y: l.y, visibility: l.visibility) : l
      }, .moveFarther),
    ] as [(String, (PoseLandmark) -> PoseLandmark, PoseReadinessEvaluator.State)] {
      let evaluator = PoseReadinessEvaluator()
      _ = evaluator.ingest(pose: body(t: 0))
      _ = evaluator.ingest(pose: body(t: 225))
      XCTAssertEqual(evaluator.ingest(pose: body(t: 450)).state, .ready, name)
      let frame = PoseFrame(timestampMs: 483, landmarks: body(t: 483).landmarks.map(transform), confidence: 0.95)
      let snapshot = evaluator.ingest(pose: frame)
      XCTAssertEqual(snapshot.state, expected, name)
      if expected != .ready {
        XCTAssertEqual(snapshot.stableForMs, 0, name)
        XCTAssertEqual(evaluator.ingest(pose: body(t: 516)).state, .holdStill, name)
        XCTAssertEqual(evaluator.ingest(pose: body(t: 965)).state, .holdStill, name)
        XCTAssertEqual(evaluator.ingest(pose: body(t: 966)).state, .ready, name)
      }
    }
  }

  // MARK: - Reset-path completeness

  /// Every non-ready exit taken on the SAME timestamp as the ready frame
  /// clears the window: the still frame that follows on that timestamp is
  /// holdStill / 0 and readiness needs a fresh 450 ms.
  func testAttackEveryNonReadyExitOnTheSameTimestampRequiresAFreshWindow() {
    typealias Exit = (String, (PoseReadinessEvaluator, Int) -> PoseReadinessEvaluator.Snapshot, PoseReadinessEvaluator.State)
    let exits: [Exit] = [
      ("wrist at frame edge", { e, t in
        e.ingest(pose: PoseFrame(timestampMs: t, landmarks: self.body(t: t).landmarks.map {
          $0.name == "right_wrist" ? PoseLandmark(name: $0.name, x: 0.99, y: $0.y, visibility: 0.95) : $0
        }, confidence: 0.95))
      }, .fullBodyRequired),
      ("low confidence", { e, t in e.ingest(pose: self.body(t: t, confidence: 0.49)) }, .noPerson),
      ("missing core joint", { e, t in e.ingest(pose: self.body(t: t, removing: ["left_ankle"])) }, .fullBodyRequired),
      ("core joint below visibility", { e, t in
        e.ingest(pose: PoseFrame(timestampMs: t, landmarks: self.body(t: t).landmarks.map {
          $0.name == "right_hip" ? PoseLandmark(name: $0.name, x: $0.x, y: $0.y, visibility: 0.34) : $0
        }, confidence: 0.95))
      }, .fullBodyRequired),
      ("three missing arm joints", { e, t in e.ingest(pose: self.body(t: t, removing: ["left_wrist", "right_wrist", "left_elbow"])) }, .fullBodyRequired),
      ("too small", { e, t in e.ingest(pose: self.body(t: t, heightScale: 0.45)) }, .moveCloser),
      ("too tall", { e, t in e.ingest(pose: self.body(t: t, yOffset: -0.075, heightScale: 1.38)) }, .moveFarther),
      ("ingestMissing", { e, t in e.ingestMissing(timestampMs: t) }, .noPerson),
      ("step", { e, t in e.ingest(pose: self.body(t: t, xOffset: 0.2)) }, .holdStill),
      ("scale change", { e, t in e.ingest(pose: self.body(t: t, heightScale: 1.14)) }, .holdStill),
    ]
    for (name, exit, expected) in exits {
      let evaluator = PoseReadinessEvaluator()
      _ = evaluator.ingest(pose: body(t: 1_000))
      _ = evaluator.ingest(pose: body(t: 1_225))
      XCTAssertEqual(evaluator.ingest(pose: body(t: 1_450)).state, .ready, name)
      let exited = exit(evaluator, 1_450)
      XCTAssertEqual(exited.state, expected, name)
      XCTAssertEqual(exited.stableForMs, 0, name)
      let sameInstant = evaluator.ingest(pose: body(t: 1_450))
      XCTAssertEqual(sameInstant.state, .holdStill, "\(name): still frame on the exit's timestamp")
      XCTAssertEqual(sameInstant.stableForMs, 0, name)
      XCTAssertEqual(evaluator.ingest(pose: body(t: 1_675)).state, .holdStill, name)
      XCTAssertEqual(evaluator.ingest(pose: body(t: 1_899)).state, .holdStill, name)
      let fresh = evaluator.ingest(pose: body(t: 1_900))
      XCTAssertEqual(fresh.state, .ready, name)
      XCTAssertEqual(fresh.stableForMs, 450, name)
    }
  }

  // MARK: - Consumers: timestamp arithmetic (opt-in trap repros)

  /// `PoseFrame` guards every landmark, but the detector, the motion stream
  /// and the accumulator subtract raw timestamps. Opt-in because a trap kills
  /// the XCTest process. Pre-existing (not introduced by e0369e84).
  func testAttackDetectorTimestampSubtractionDoesNotTrap() throws {
    try XCTSkipUnless(ProcessInfo.processInfo.environment["ATTACK_FIX11_TRAP"] == "1", "opt-in trap repro")
    let detector = TemporalStrokeDetector()
    _ = detector.ingest(pose: body(t: Int.min + 1_000), paddle: nil)
    XCTAssertNil(detector.ingest(pose: body(t: Int.max), paddle: nil))
  }

  func testAttackMotionStreamTimestampSubtractionDoesNotTrap() throws {
    try XCTSkipUnless(ProcessInfo.processInfo.environment["ATTACK_FIX11_TRAP"] == "1", "opt-in trap repro")
    let stream = SessionMotionStream()
    _ = stream.ingest(pose: body(t: Int.min + 1_000))
    XCTAssertNil(stream.ingest(pose: body(t: Int.max)))
  }

  func testAttackAccumulatorRetentionCutoffDoesNotTrap() throws {
    try XCTSkipUnless(ProcessInfo.processInfo.environment["ATTACK_FIX11_TRAP"] == "1", "opt-in trap repro")
    let accumulator = CaptureEvidenceAccumulator(retentionMs: 15_000)
    accumulator.ingest(pose: body(t: Int.min))
    accumulator.ingest(pose: body(t: Int.min + 33))
    XCTAssertGreaterThanOrEqual(
      accumulator.summary(startMs: Int.min, endMs: Int.min + 33, poseSource: "x", poseModelVersion: "y", triggerAlgorithmVersion: "z")?.poseFrameCount ?? 0,
      0
    )
  }

  // MARK: - Fixtures

  /// A framed, still athlete (full box 0.28 × 0.65, core box 0.14 × 0.65).
  private func body(
    t: Int,
    xOffset: Double = 0,
    yOffset: Double = 0,
    heightScale: Double = 1,
    confidence: Double = 0.95,
    leftWristX: Double? = nil,
    removing names: Set<String> = []
  ) -> PoseFrame {
    let points: [(String, Double, Double)] = [
      ("left_shoulder", 0.43, 0.25), ("right_shoulder", 0.57, 0.25),
      ("left_elbow", 0.39, 0.38), ("right_elbow", 0.61, 0.38),
      ("left_wrist", leftWristX ?? 0.36, 0.50), ("right_wrist", 0.64, 0.50),
      ("left_hip", 0.45, 0.52), ("right_hip", 0.55, 0.52),
      ("left_knee", 0.45, 0.70), ("right_knee", 0.55, 0.70),
      ("left_ankle", 0.44, 0.90), ("right_ankle", 0.56, 0.90),
    ]
    let centerY = 0.575
    return PoseFrame(
      timestampMs: t,
      landmarks: points.compactMap { name, x, y in
        guard !names.contains(name) else { return nil }
        return PoseLandmark(name: name, x: x + xOffset, y: centerY + yOffset + (y - centerY) * heightScale, visibility: 0.95)
      },
      confidence: confidence
    )
  }
}

private struct Attack11Rng {
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
