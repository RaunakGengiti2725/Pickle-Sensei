import Dispatch
import Foundation
@testable import PickleNativeStressCore

/// Every scenario is a pure function of its seed. Scenarios marked
/// `expectsProcessTrap` document a reproduced runtime trap in production code;
/// the driver runs them in isolation and records the crash instead of a verdict.
public enum StressScenario: String, CaseIterable {
  /// Empty landmark lists, zero-confidence frames and a single frame through
  /// every Foundation-only component.
  case emptyAndSingleFrame
  /// Corrupt landmark values (NaN/∞/out-of-range/negative visibility/unknown
  /// names/thousands of ghost joints) mixed into an otherwise real stream.
  case hugeAndCorruptInputs
  /// Seeded realistic session through `TemporalStrokeDetector`: event shape,
  /// ordering and purity of the offline pass.
  case detectorRandomStream
  /// Random `reset()`/`ingest` interleaving — the guided controller's
  /// rapid start/stop path — must never surface an event with less history
  /// than the config requires.
  case detectorRapidReset
  /// Two people with identical stance alternating as the "primary" person:
  /// body-relative motion must cancel the identity jump.
  case twoPeopleAlternating
  /// `CaptureEvidenceAccumulator` retention/summaries against an independent
  /// model of the window.
  case evidenceRetentionExact
  /// `PoseReadinessEvaluator` state/coverage/stability invariants.
  case readinessRandom
  /// A landmark list carrying one duplicated joint name (visibility ≥ 0.35)
  /// through `PoseReadinessEvaluator.ingest` — `Dictionary(uniqueKeysWithValues:)`.
  case readinessDuplicateLandmark
  /// `SessionMotionStream` + `StrokeCompletionMonitor` fed the same stream:
  /// decision bounds, telemetry caps, JSON-safety of the payload.
  case motionStreamAndMonitor
  /// `StrokeCompletionMonitor` hammered from four threads at once, mirroring
  /// vision-queue ingest, frame-queue observe/decide, and finish telemetry.
  case monitorConcurrent
  /// `PoseMotionTrailBuffer` bounds and segment sanity.
  case motionTrailRandom
  /// Long loop through every component watching resident memory.
  case memoryPressureLoop
  /// Timestamps near `Int.max`/`Int.min` — arithmetic on camera clocks.
  case timestampExtremes
  /// Import extraction loop MODEL (`ImportExtractionModel`) fed seeded sample
  /// timelines (0–600 s, 1–240 fps, rewinds, non-numeric PTS) and a scripted
  /// provider that throws every `VisionFailure` — including `.cancelled` —
  /// mid-sequence: decimation/cap/progress arithmetic and gap semantics.
  case importExtractionModel

  public var expectsProcessTrap: Bool {
    switch self {
    case .readinessDuplicateLandmark, .timestampExtremes: return true
    default: return false
    }
  }

  /// Scenarios whose default campaign should be small (each iteration is heavy).
  public var heavy: Bool {
    switch self {
    case .memoryPressureLoop, .monitorConcurrent: return true
    default: return false
    }
  }

  /// Default campaign size (`STRESS_ITER`, 25 when unset/invalid).
  public static var defaultIterations: Int {
    if let raw = ProcessInfo.processInfo.environment["STRESS_ITER"], let value = Int(raw), value > 0 { return value }
    return 25
  }

  /// Iterations actually executed for a requested campaign size: heavy
  /// scenarios (60 000-frame memory loops, 4-thread hammering) run 1/25th.
  public func campaignIterations(requested: Int = StressScenario.defaultIterations) -> Int {
    heavy ? max(1, requested / 25) : requested
  }

  public func run(seed: UInt64) -> StressOutcome {
    let startedAt = Date()
    var log = InvariantLog()
    var rng = StressRNG(seed: seed)
    switch self {
    case .emptyAndSingleFrame: Self.emptyAndSingleFrame(&rng, &log)
    case .hugeAndCorruptInputs: Self.hugeAndCorruptInputs(seed: seed, &rng, &log)
    case .detectorRandomStream: Self.detectorRandomStream(seed: seed, &rng, &log)
    case .detectorRapidReset: Self.detectorRapidReset(seed: seed, &rng, &log)
    case .twoPeopleAlternating: Self.twoPeopleAlternating(&rng, &log)
    case .evidenceRetentionExact: Self.evidenceRetentionExact(seed: seed, &rng, &log)
    case .readinessRandom: Self.readinessRandom(seed: seed, &rng, &log)
    case .readinessDuplicateLandmark: Self.readinessDuplicateLandmark(&rng, &log)
    case .motionStreamAndMonitor: Self.motionStreamAndMonitor(seed: seed, &rng, &log)
    case .monitorConcurrent: Self.monitorConcurrent(seed: seed, &rng, &log)
    case .motionTrailRandom: Self.motionTrailRandom(seed: seed, &rng, &log)
    case .memoryPressureLoop: Self.memoryPressureLoop(seed: seed, &rng, &log)
    case .timestampExtremes: Self.timestampExtremes(&rng, &log)
    case .importExtractionModel: Self.importExtractionModel(seed: seed, &rng, &log)
    }
    return log.outcome(scenario: rawValue, seed: seed, startedAt: startedAt)
  }

  // MARK: - Shared checks

  static func check(_ event: StrokeEvent, config: TemporalStrokeDetector.Config, _ log: inout InvariantLog, context: String) {
    log.expect(event.startMs < event.endMs, "\(context): startMs \(event.startMs) !< endMs \(event.endMs)")
    if let peak = event.peakMotionMs {
      log.expect(peak > event.startMs && peak <= event.endMs,
                 "\(context): peakMotionMs \(peak) outside (\(event.startMs), \(event.endMs)]")
    } else {
      log.fail("\(context): live detector event without peakMotionMs")
    }
    log.expect(event.confidence.isFinite && event.confidence >= 0.75 && event.confidence <= 0.95,
               "\(context): confidence \(event.confidence) outside [0.75, 0.95]")
    // startMs is the quiet onset (≤ maxOnsetToTriggerMs before the trigger
    // crossing); the trigger→end span is capped by maxStrokeMs; the gap rule
    // bounds the trigger interval itself.
    let maxSpan = config.maxOnsetToTriggerMs + config.maxStrokeMs + TemporalStrokeDetector.maximumSampleGapMs
    log.expect(event.endMs - event.startMs <= maxSpan,
               "\(context): span \(event.endMs - event.startMs) > \(maxSpan)")
    log.expect(event.endMs - event.startMs >= config.minStrokeMs,
               "\(context): span \(event.endMs - event.startMs) < minStrokeMs \(config.minStrokeMs)")
  }

  static func drive(_ ticks: [StreamTick], detector: TemporalStrokeDetector, config: TemporalStrokeDetector.Config,
                    _ log: inout InvariantLog, context: String) -> [StrokeEvent] {
    var events: [StrokeEvent] = []
    for tick in ticks {
      guard case .pose(let frame) = tick else { continue }
      log.operations += 1
      guard let event = detector.ingest(pose: frame, paddle: nil) else { continue }
      check(event, config: config, &log, context: "\(context) event#\(events.count)")
      log.expect(event.endMs <= frame.timestampMs,
                 "\(context): event endMs \(event.endMs) after the frame that produced it \(frame.timestampMs)")
      if let previous = events.last {
        log.expect(event.startMs > previous.endMs,
                   "\(context): event#\(events.count) starts \(event.startMs) inside/before previous end \(previous.endMs)")
      }
      events.append(event)
    }
    return events
  }

  // MARK: - Scenarios

  static func emptyAndSingleFrame(_ rng: inout StressRNG, _ log: inout InvariantLog) {
    let t = rng.int(in: 0 ... 10_000_000)
    let empty = PoseFrame(timestampMs: t, landmarks: [], confidence: rng.double(in: 0 ... 1))
    let zeroConfidence = PoseSynth.frame(.readyFraming(&rng), arm: .still, timestampMs: t, confidence: 0, rng: &rng)
    let single = PoseSynth.frame(.readyFraming(&rng), arm: .still, timestampMs: t, rng: &rng)

    let detector = TemporalStrokeDetector()
    for frame in [empty, zeroConfidence, single] {
      log.operations += 1
      log.expect(detector.ingest(pose: frame, paddle: nil) == nil, "detector emitted from a degenerate frame")
    }
    log.expect(TemporalStrokeDetector.strongestEvent(in: []) == nil, "strongestEvent([]) != nil")
    log.expect(TemporalStrokeDetector.strongestEvent(in: [single]) == nil, "strongestEvent([1 frame]) != nil")

    let readiness = PoseReadinessEvaluator()
    let emptySnapshot = readiness.ingest(pose: empty)
    log.operations += 1
    log.expect(!emptySnapshot.isReady, "readiness ready on empty landmarks")
    log.expect(emptySnapshot.jointCoverage == 0, "coverage \(emptySnapshot.jointCoverage) on empty landmarks")
    let zeroSnapshot = readiness.ingest(pose: zeroConfidence)
    log.expect(zeroSnapshot.state == .noPerson, "zero-confidence frame is \(zeroSnapshot.state), not noPerson")
    let singleSnapshot = readiness.ingest(pose: single)
    log.expect(singleSnapshot.state == .holdStill, "one well-framed frame is \(singleSnapshot.state), not holdStill")
    log.expect(singleSnapshot.stableForMs == 0, "one frame reports stableForMs \(singleSnapshot.stableForMs)")

    let evidence = CaptureEvidenceAccumulator()
    log.expect(evidence.summary(startMs: t, endMs: t, poseSource: "s", poseModelVersion: "m", triggerAlgorithmVersion: "a") == nil,
               "summary over no attempts != nil")
    evidence.ingest(pose: empty)
    log.operations += 1
    let emptySummary = evidence.summary(startMs: t, endMs: t, poseSource: "s", poseModelVersion: "m", triggerAlgorithmVersion: "a")
    log.expect(emptySummary?.poseFrameCount == 1 && emptySummary?.meanJointCoverage == 0 && emptySummary?.jointMotion.isEmpty == true,
               "empty-landmark attempt summary \(String(describing: emptySummary))")
    let evidence2 = CaptureEvidenceAccumulator()
    evidence2.ingest(pose: single)
    let singleSummary = evidence2.summary(startMs: t, endMs: t, poseSource: "s", poseModelVersion: "m", triggerAlgorithmVersion: "a")
    log.expect(singleSummary?.poseFrameCount == 1 && singleSummary?.trackedDurationMs == 0 && singleSummary?.jointMotion.isEmpty == true
               && singleSummary?.fullBodyVisibleFrameCount == 1,
               "single-frame summary \(String(describing: singleSummary))")
    log.expect(evidence2.summary(startMs: t + 1, endMs: t, poseSource: "s", poseModelVersion: "m", triggerAlgorithmVersion: "a") == nil,
               "inverted window produced a summary")

    let stream = SessionMotionStream()
    log.expect(stream.ingest(pose: empty) == nil && stream.ingest(pose: single) == nil, "motion stream produced a sample from ≤1 frame")

    var trail = PoseMotionTrailBuffer()
    trail.ingest(landmarks: [], timestampMs: t)
    trail.ingest(landmarks: single.landmarks, timestampMs: t)
    log.expect(trail.segments(at: t).isEmpty, "trail segments from a single frame")
    log.expect(trail.storedSampleCount <= PoseMotionTrailBuffer.Config().trackedJoints.count, "trail stored \(trail.storedSampleCount) from one frame")

    let monitor = StrokeCompletionMonitor()
    monitor.ingest(pose: empty)
    monitor.ingest(pose: single)
    monitor.observeFrame(timestampMs: t)
    log.expect(monitor.adaptiveDecision() == nil, "unarmed monitor decided")
    monitor.arm(eventStartMs: t, eventEndMs: t, peakMotionMs: nil)
    let telemetry = monitor.telemetry(strategy: .fixed, finalizeMs: t)
    log.expect(telemetry.peakMotionValue == 0 && telemetry.samples.isEmpty && telemetry.observedSampleCount == 0,
               "armed-on-nothing telemetry peak=\(telemetry.peakMotionValue) samples=\(telemetry.samples.count)")
    log.expect(JSONSerialization.isValidJSONObject(StrokeCompletionMonitor.payload(for: telemetry, rebasedTo: t)),
               "empty telemetry payload is not valid JSON")
  }

  static func hugeAndCorruptInputs(seed: UInt64, _ rng: inout StressRNG, _ log: inout InvariantLog) {
    var options = StreamGenerator.Options.random(&rng)
    options.corruptionRate = rng.pick([0.25, 0.5, 1.0])
    options.durationMs = rng.int(in: 1_000 ... 6_000)
    let monotonicClock = options.clockFaultRate == 0
    let generated = StreamGenerator(seed: seed, options: options).generate()
    log.metrics["corruptedFrames"] = Double(generated.corrupted)
    let config = TemporalStrokeDetector.Config()
    let detector = TemporalStrokeDetector(config: config)
    let readiness = PoseReadinessEvaluator()
    let evidence = CaptureEvidenceAccumulator()
    let stream = SessionMotionStream()
    var trail = PoseMotionTrailBuffer()
    let monitor = StrokeCompletionMonitor()
    var armed = false
    var events = 0
    var nonFiniteSpeedSamples = 0
    var previousEnd: Int?
    for tick in generated.ticks {
      log.operations += 1
      switch tick {
      case .missing(let ts):
        _ = readiness.ingestMissing(timestampMs: ts)
        evidence.ingestMissing(timestampMs: ts)
        monitor.observeFrame(timestampMs: ts)
      case .pose(let frame):
        if let event = detector.ingest(pose: frame, paddle: nil) {
          events += 1
          check(event, config: config, &log, context: "corrupt-stream")
          if let previousEnd, monotonicClock { log.expect(event.startMs > previousEnd, "events overlap under corruption") }
          previousEnd = event.endMs
          if !armed {
            monitor.arm(eventStartMs: event.startMs, eventEndMs: event.endMs, peakMotionMs: event.peakMotionMs)
            armed = true
          }
        }
        let snapshot = readiness.ingest(pose: frame)
        log.expect(snapshot.jointCoverage >= 0 && snapshot.jointCoverage <= 1, "coverage \(snapshot.jointCoverage)")
        log.expect(snapshot.stableForMs >= 0, "negative stableForMs")
        evidence.ingest(pose: frame)
        if let sample = stream.ingest(pose: frame), !sample.value.isFinite { nonFiniteSpeedSamples += 1 }
        trail.ingest(landmarks: frame.landmarks, timestampMs: frame.timestampMs)
        for segment in trail.segments(at: frame.timestampMs) {
          log.expect(segment.normalizedSpeedPerSecond.isFinite && segment.normalizedSpeedPerSecond >= 0,
                     "trail speed \(segment.normalizedSpeedPerSecond) from corrupt input")
          log.expect(segment.ageFraction >= 0 && segment.ageFraction <= 1, "trail ageFraction \(segment.ageFraction)")
        }
        monitor.ingest(pose: frame)
        monitor.observeFrame(timestampMs: frame.timestampMs)
      }
    }
    let first = generated.ticks.first?.timestampMs ?? 0
    let last = generated.ticks.last?.timestampMs ?? 0
    if let summary = evidence.summary(startMs: min(first, last), endMs: max(first, last), poseSource: "s", poseModelVersion: "m", triggerAlgorithmVersion: "a") {
      log.expect(summary.meanCanonicalJointVisibility >= 0 && summary.meanCanonicalJointVisibility <= 1,
                 "meanCanonicalJointVisibility \(summary.meanCanonicalJointVisibility) — corrupt visibility leaked")
      log.expect(summary.meanJointCoverage >= 0 && summary.meanJointCoverage <= 1, "meanJointCoverage \(summary.meanJointCoverage)")
      log.expect(summary.minimumJointCoverage >= 0 && summary.minimumJointCoverage <= 1, "minimumJointCoverage \(summary.minimumJointCoverage)")
      for motion in summary.jointMotion {
        log.expect(motion.meanNormalizedPerSecond.isFinite && motion.peakNormalizedPerSecond.isFinite
                   && motion.meanNormalizedPerSecond >= 0 && motion.meanNormalizedPerSecond <= motion.peakNormalizedPerSecond,
                   "joint motion \(motion) not finite/ordered")
      }
      log.expect(summary.poseFrameCount + summary.poseMissingFrameCount == summary.analysisInputFrameCount, "frame counts disagree")
    }
    let telemetry = monitor.telemetry(strategy: .adaptive, finalizeMs: last)
    log.metrics["events"] = Double(events)
    log.metrics["armed"] = armed ? 1 : 0
    log.metrics["nonFiniteSpeedSamples"] = Double(nonFiniteSpeedSamples)
    log.metrics["observedSampleCount"] = Double(telemetry.observedSampleCount)
    log.expect(telemetry.samples.count <= StrokeCompletionMonitor.recordedSampleCap, "telemetry samples \(telemetry.samples.count) > cap")
    let payload = StrokeCompletionMonitor.payload(for: telemetry, rebasedTo: first)
    // Corrupt coordinates can only reach the payload as a non-finite speed —
    // a number JSON cannot represent, handed to the JS side as the clip's
    // `completion` telemetry.
    let payloadValid = JSONSerialization.isValidJSONObject(payload)
    log.metrics["payloadValidJSON"] = payloadValid ? 1 : 0
    log.expect(telemetry.peakMotionValue.isFinite, "peakMotionValue \(telemetry.peakMotionValue) not finite — non-JSON number in the completion payload")
    log.expect(payloadValid, "completion payload carries a non-finite postCompletionMotion sample (isValidJSONObject == false)")
  }

  static func detectorRandomStream(seed: UInt64, _ rng: inout StressRNG, _ log: inout InvariantLog) {
    // The detector's ordering contract assumes the monotonic camera clock
    // AVFoundation provides; regressions are exercised in the other scenarios.
    var options = StreamGenerator.Options.random(&rng)
    options.clockFaultRate = 0
    let generated = StreamGenerator(seed: seed, options: options).generate()
    log.metrics["frames"] = Double(generated.ticks.count)
    log.metrics["swingSegments"] = Double(generated.swings)
    log.metrics["corruptedFrames"] = Double(generated.corrupted)
    log.metrics["nonFiniteFrames"] = Double(generated.ticks.filter { tick in
      if case .pose(let frame) = tick {
        return frame.landmarks.contains { !$0.x.isFinite || !$0.y.isFinite }
      }
      return false
    }.count)
    let config = rng.chance(0.3) ? TemporalStrokeDetector.manualStopConfig : TemporalStrokeDetector.Config()
    let detector = TemporalStrokeDetector(config: config)
    let events = drive(generated.ticks, detector: detector, config: config, &log, context: "live")
    log.metrics["events"] = Double(events.count)
    // Refractory: the next event cannot END inside the previous refractory
    // window and every event needs its own quiet onset (start > previous end).
    for (index, event) in events.dropFirst().enumerated() {
      let previous = events[index]
      log.expect(event.endMs >= previous.endMs + config.refractoryMs,
                 "event#\(index + 1) ends \(event.endMs) inside refractory of \(previous.endMs)")
    }
    // Idle-state determinism: the same stream through a fresh detector is identical.
    let replay = TemporalStrokeDetector(config: config)
    var replayLog = InvariantLog()
    let replayed = drive(generated.ticks, detector: replay, config: config, &replayLog, context: "replay")
    log.expect(replayed.count == events.count
               && zip(replayed, events).allSatisfy { $0.startMs == $1.startMs && $0.endMs == $1.endMs && $0.confidence == $1.confidence },
               "detector is not deterministic for the same stream")
    // Offline pass purity: calling it must not disturb the live detector and
    // must return the best of its own events.
    let poses = generated.ticks.compactMap { tick -> PoseFrame? in
      if case .pose(let frame) = tick { return frame }
      return nil
    }
    let strongest = TemporalStrokeDetector.strongestEvent(in: poses)
    let strongestAgain = TemporalStrokeDetector.strongestEvent(in: poses)
    log.expect((strongest == nil) == (strongestAgain == nil)
               && strongest?.startMs == strongestAgain?.startMs && strongest?.endMs == strongestAgain?.endMs,
               "strongestEvent is not pure")
    if let strongest {
      check(strongest, config: TemporalStrokeDetector.manualStopConfig, &log, context: "strongest")
      let offlinePass = TemporalStrokeDetector(config: TemporalStrokeDetector.manualStopConfig)
      var offlineLog = InvariantLog()
      let offline = drive(generated.ticks, detector: offlinePass, config: TemporalStrokeDetector.manualStopConfig, &offlineLog, context: "offline")
      log.expect(offline.contains { $0.startMs == strongest.startMs && $0.endMs == strongest.endMs },
                 "strongestEvent is not one of the offline pass events")
      log.expect(offline.allSatisfy { $0.confidence <= strongest.confidence }, "strongestEvent is not the max-confidence event")
    }
  }

  static func detectorRapidReset(seed: UInt64, _ rng: inout StressRNG, _ log: inout InvariantLog) {
    var options = StreamGenerator.Options.random(&rng)
    options.corruptionRate = 0
    options.clockFaultRate = 0
    let generated = StreamGenerator(seed: seed, options: options).generate()
    let config = TemporalStrokeDetector.Config()
    let detector = TemporalStrokeDetector(config: config)
    let resetEvery = rng.int(in: 1 ... 400)
    var framesSinceReset = 0
    var firstTimestampSinceReset: Int?
    var resets = 0
    for tick in generated.ticks {
      guard case .pose(let frame) = tick else { continue }
      log.operations += 1
      if framesSinceReset >= resetEvery || rng.chance(0.002) {
        detector.reset()
        resets += 1
        framesSinceReset = 0
        firstTimestampSinceReset = nil
        log.expect(detector.lastBodyScale == nil, "lastBodyScale survived reset()")
      }
      framesSinceReset += 1
      if firstTimestampSinceReset == nil { firstTimestampSinceReset = frame.timestampMs }
      if let event = detector.ingest(pose: frame, paddle: nil) {
        check(event, config: config, &log, context: "rapid-reset")
        let sinceReset = frame.timestampMs - (firstTimestampSinceReset ?? frame.timestampMs)
        log.expect(sinceReset >= config.minQuietBeforeMs + config.minStrokeMs,
                   "event emitted \(sinceReset) ms after reset() — less than quiet+stroke minimum")
        log.expect(event.startMs >= (firstTimestampSinceReset ?? Int.min),
                   "event start \(event.startMs) predates the reset at \(firstTimestampSinceReset ?? -1)")
      }
    }
    log.metrics["resets"] = Double(resets)
    log.expect(detector.lastBodyScale.map { $0.isFinite && $0 > 0 } ?? true,
               "lastBodyScale \(String(describing: detector.lastBodyScale)) not finite/positive")
  }

  static func twoPeopleAlternating(_ rng: inout StressRNG, _ log: inout InvariantLog) {
    var stanceRNG = StressRNG(seed: rng.next())
    let a = PoseSynth.Athlete.readyFraming(&stanceRNG)
    var b = a
    b.centerX = a.centerX < 0.5 ? min(0.9, a.centerX + rng.double(in: 0.2 ... 0.4)) : max(0.1, a.centerX - rng.double(in: 0.2 ... 0.4))
    b.centerY = min(0.9, max(0.1, a.centerY + rng.double(in: -0.1 ... 0.1)))
    let fps = rng.pick([30, 60])
    let frameMs = 1000 / fps
    let flipEvery = rng.int(in: 1 ... 20)
    let frames = rng.int(in: 120 ... 1_200)
    let config = TemporalStrokeDetector.Config()
    let detector = TemporalStrokeDetector(config: config)
    let stream = SessionMotionStream()
    var t = rng.int(in: 0 ... 1_000_000)
    var flips = 0
    var absoluteSpikes = 0
    for index in 0 ..< frames {
      t += frameMs
      let subject = (index / flipEvery) % 2 == 0 ? a : b
      if index > 0, index % flipEvery == 0 { flips += 1 }
      let frame = PoseSynth.frame(subject, arm: .still, timestampMs: t, jitter: 0.001, rng: &rng)
      log.operations += 1
      if let event = detector.ingest(pose: frame, paddle: nil) {
        log.fail("identity flip between two still athletes produced a stroke event \(event.startMs)-\(event.endMs)")
      }
      if let sample = stream.ingest(pose: frame), sample.value > 2 { absoluteSpikes += 1 }
    }
    log.metrics["flips"] = Double(flips)
    // The session motion stream is ABSOLUTE image speed by contract, so the
    // flips must show up there — the anchor stickiness in ApplePoseProvider is
    // what prevents this upstream. Recorded, not asserted, as a property.
    log.metrics["absoluteSpikesFromFlips"] = Double(absoluteSpikes)
    log.expect(flips == 0 || absoluteSpikes > 0, "flips did not register in the absolute motion stream")

    // Now both people are in ONE frame as duplicate-free landmarks is not
    // representable (one PoseFrame = one person); instead check the readiness
    // evaluator tolerates the alternation without ever reporting `ready` while
    // the centre jumps by ≥ 0.2.
    let readiness = PoseReadinessEvaluator()
    var readyDuringFlips = 0
    t += 1_000
    for index in 0 ..< frames {
      t += frameMs
      let subject = (index / flipEvery) % 2 == 0 ? a : b
      let snapshot = readiness.ingest(pose: PoseSynth.frame(subject, arm: .still, timestampMs: t, jitter: 0.001, rng: &rng))
      log.operations += 1
      if snapshot.isReady, flipEvery * frameMs < PoseReadinessEvaluator.Config().stableDurationMs { readyDuringFlips += 1 }
    }
    log.expect(readyDuringFlips == 0, "readiness reported ready \(readyDuringFlips)× while the person flipped every \(flipEvery * frameMs) ms")
  }

  static func evidenceRetentionExact(seed: UInt64, _ rng: inout StressRNG, _ log: inout InvariantLog) {
    let retention = rng.pick([1, 250, 4_000, 15_000])
    let evidence = CaptureEvidenceAccumulator(retentionMs: retention)
    var options = StreamGenerator.Options.random(&rng)
    options.allowDuplicateJointCorruption = false
    let generated = StreamGenerator(seed: seed, options: options).generate()
    var model: [(ts: Int, hasPose: Bool)] = []
    var latest = Int.min
    for tick in generated.ticks {
      log.operations += 1
      switch tick {
      case .pose(let frame):
        evidence.ingest(pose: frame)
        model.append((frame.timestampMs, true))
      case .missing(let ts):
        evidence.ingestMissing(timestampMs: ts)
        model.append((ts, false))
      }
      latest = max(latest, tick.timestampMs)
      model.removeAll { $0.ts < latest - retention }
    }
    let lo = model.map(\.ts).min() ?? 0
    let hi = model.map(\.ts).max() ?? 0
    let summary = evidence.summary(startMs: lo, endMs: hi, poseSource: "s", poseModelVersion: "m", triggerAlgorithmVersion: "a")
    let expectedPoses = model.filter(\.hasPose).count
    if expectedPoses == 0 {
      log.expect(summary == nil, "summary without usable poses")
    } else {
      guard let summary else { return log.fail("summary nil with \(expectedPoses) retained poses") }
      log.expect(summary.analysisInputFrameCount == model.count,
                 "retained attempts \(summary.analysisInputFrameCount) != model \(model.count) (retention \(retention))")
      log.expect(summary.poseFrameCount == expectedPoses, "pose frames \(summary.poseFrameCount) != \(expectedPoses)")
      log.expect(summary.poseMissingFrameCount == model.count - expectedPoses, "missing count mismatch")
      log.expect(summary.trackedDurationMs >= 0 && summary.trackedDurationMs <= hi - lo, "trackedDurationMs \(summary.trackedDurationMs)")
      log.expect(summary.fullBodyVisibleFrameCount <= summary.poseFrameCount, "fullBody > poses")
      log.expect(summary.minimumJointCoverage <= summary.meanJointCoverage, "min coverage > mean")
    }
    // Sub-window: a summary over [x, y] must only count attempts inside it.
    if model.count > 2 {
      let i = rng.int(in: 0 ... model.count - 1)
      let j = rng.int(in: 0 ... model.count - 1)
      let (s, e) = (min(model[i].ts, model[j].ts), max(model[i].ts, model[j].ts))
      let inside = model.filter { $0.ts >= s && $0.ts <= e }
      let sub = evidence.summary(startMs: s, endMs: e, poseSource: "s", poseModelVersion: "m", triggerAlgorithmVersion: "a")
      if inside.contains(where: \.hasPose) {
        log.expect(sub?.analysisInputFrameCount == inside.count, "sub-window attempts \(sub?.analysisInputFrameCount ?? -1) != \(inside.count)")
      } else {
        log.expect(sub == nil, "sub-window without poses produced evidence")
      }
    }
    evidence.reset()
    log.expect(evidence.summary(startMs: lo, endMs: hi, poseSource: "s", poseModelVersion: "m", triggerAlgorithmVersion: "a") == nil,
               "reset() left evidence behind")
  }

  static func readinessRandom(seed: UInt64, _ rng: inout StressRNG, _ log: inout InvariantLog) {
    let config = PoseReadinessEvaluator.Config()
    let readiness = PoseReadinessEvaluator(config: config)
    let options = StreamGenerator.Options.random(&rng)
    let generated = StreamGenerator(seed: seed, options: options).generate()
    var previousMissing = false
    var readyCount = 0
    for tick in generated.ticks {
      log.operations += 1
      let snapshot: PoseReadinessEvaluator.Snapshot
      switch tick {
      case .missing(let ts):
        snapshot = readiness.ingestMissing(timestampMs: ts)
        log.expect(snapshot.state == .noPerson && snapshot.missingJoints.count == 12, "missing frame snapshot \(snapshot.state)")
        previousMissing = true
        continue
      case .pose(let frame):
        snapshot = readiness.ingest(pose: frame)
        log.expect(snapshot.timestampMs == frame.timestampMs, "snapshot timestamp drifted")
        if frame.confidence < config.minimumPoseConfidence || frame.confidence.isNaN {
          log.expect(snapshot.state == .noPerson, "low-confidence frame is \(snapshot.state)")
        }
      }
      log.expect(snapshot.jointCoverage >= 0 && snapshot.jointCoverage <= 1, "coverage \(snapshot.jointCoverage)")
      log.expect(Set(snapshot.missingJoints).isSubset(of: Set(PoseSynth.joints)), "unknown missing joint \(snapshot.missingJoints)")
      if snapshot.isReady {
        readyCount += 1
        log.expect(snapshot.stableForMs >= config.stableDurationMs, "ready with stableForMs \(snapshot.stableForMs)")
        log.expect(!previousMissing, "ready on the first frame after a missing frame")
        log.expect(snapshot.jointCoverage >= 0.83, "ready with coverage \(snapshot.jointCoverage)")
      } else {
        log.expect(snapshot.stableForMs == 0, "not ready but stableForMs \(snapshot.stableForMs)")
      }
      previousMissing = false
    }
    log.metrics["readyFrames"] = Double(readyCount)
    readiness.reset()
    var quiet = StressRNG(seed: seed)
    let after = readiness.ingest(pose: PoseSynth.frame(.readyFraming(&quiet), arm: .still, timestampMs: 1, rng: &quiet))
    log.expect(!after.isReady, "ready immediately after reset()")
  }

  static func readinessDuplicateLandmark(_ rng: inout StressRNG, _ log: inout InvariantLog) {
    let athlete = PoseSynth.Athlete.readyFraming(&rng)
    let frame = PoseSynth.frame(athlete, arm: .still, timestampMs: rng.int(in: 0 ... 1_000_000), rng: &rng)
    let duplicated = PoseSynth.corrupt(frame, with: .duplicateJoint, rng: &rng)
    log.operations += 1
    // Sibling consumers tolerate the same input:
    let evidence = CaptureEvidenceAccumulator()
    evidence.ingest(pose: duplicated)
    _ = TemporalStrokeDetector().ingest(pose: duplicated, paddle: nil)
    var trail = PoseMotionTrailBuffer()
    trail.ingest(landmarks: duplicated.landmarks, timestampMs: duplicated.timestampMs)
    _ = SessionMotionStream().ingest(pose: duplicated)
    StrokeCompletionMonitor().ingest(pose: duplicated)
    // PoseReadinessEvaluator.ingest builds `Dictionary(uniqueKeysWithValues:)`
    // from visible landmarks — a duplicate visible name traps the process.
    let snapshot = PoseReadinessEvaluator().ingest(pose: duplicated)
    log.expect(snapshot.jointCoverage <= 1, "coverage \(snapshot.jointCoverage)")
  }

  static func motionStreamAndMonitor(seed: UInt64, _ rng: inout StressRNG, _ log: inout InvariantLog) {
    let options = StreamGenerator.Options.random(&rng)
    let generated = StreamGenerator(seed: seed, options: options).generate()
    let stream = SessionMotionStream()
    let monitor = StrokeCompletionMonitor()
    let detector = TemporalStrokeDetector()
    var armedAt: (anchor: Int, start: Int, end: Int)?
    var lastSampleTs: Int?
    var decisionSeenAt: Int?
    var samples = 0
    for tick in generated.ticks {
      log.operations += 1
      switch tick {
      case .missing(let ts):
        monitor.observeFrame(timestampMs: ts)
      case .pose(let frame):
        if let sample = stream.ingest(pose: frame) {
          samples += 1
          log.expect((sample.value.isFinite && sample.value >= 0) || options.corruptionRate > 0,
                     "motion sample \(sample.value) from clean input")
          log.expect(sample.timestampMs == frame.timestampMs, "sample timestamp drifted")
          if let last = lastSampleTs, options.clockFaultRate == 0 {
            log.expect(sample.timestampMs > last, "motion samples not strictly increasing \(last) → \(sample.timestampMs)")
          }
          lastSampleTs = sample.timestampMs
        }
        monitor.ingest(pose: frame)
        monitor.observeFrame(timestampMs: frame.timestampMs)
        if armedAt == nil, let event = detector.ingest(pose: frame, paddle: nil) {
          monitor.arm(eventStartMs: event.startMs, eventEndMs: event.endMs, peakMotionMs: event.peakMotionMs)
          armedAt = (event.peakMotionMs ?? event.endMs, event.startMs, event.endMs)
          // Re-arming is a no-op by contract.
          monitor.arm(eventStartMs: 0, eventEndMs: 0, peakMotionMs: 0)
        }
      }
      if let armed = armedAt, decisionSeenAt == nil, let decision = monitor.adaptiveDecision() {
        decisionSeenAt = tick.timestampMs
        log.expect(decision.endMs >= armed.anchor && decision.endMs <= armed.anchor + StrokeCompletionMonitor.Params.safetyMaxMs,
                   "decision end \(decision.endMs) outside [anchor, anchor+2500] (\(armed.anchor))")
        log.expect(decision.decidedAtMs >= decision.endMs || decision.reason == .safetyMax,
                   "decided \(decision.decidedAtMs) before its own end \(decision.endMs) (\(decision.reason))")
        switch decision.reason {
        case .settle:
          log.expect(decision.endMs >= armed.anchor + StrokeCompletionMonitor.Params.minFollowThroughMs
                     + StrokeCompletionMonitor.Params.settleHoldMs,
                     "settle decided at \(decision.endMs) before follow-through+hold after anchor \(armed.anchor)")
        case .valley:
          log.expect(decision.decidedAtMs > decision.endMs + StrokeCompletionMonitor.Params.valleyRiseMinGapMs,
                     "valley rise gap violated")
        case .safetyMax:
          log.expect(decision.endMs == armed.anchor + StrokeCompletionMonitor.Params.safetyMaxMs, "safety end is not anchor+2500")
        }
      }
    }
    log.metrics["motionSamples"] = Double(samples)
    log.metrics["armed"] = armedAt == nil ? 0 : 1
    log.metrics["decided"] = decisionSeenAt == nil ? 0 : 1
    if let armed = armedAt {
      let lastTs = generated.ticks.last?.timestampMs ?? armed.end
      if lastTs >= armed.anchor + StrokeCompletionMonitor.Params.safetyMaxMs, options.clockFaultRate == 0 {
        log.expect(monitor.adaptiveDecision() != nil, "no decision although the safety window elapsed")
      }
      let finalize = max(lastTs, armed.end)
      let telemetry = monitor.telemetry(strategy: .adaptive, finalizeMs: finalize)
      log.expect(telemetry.anchorMs == armed.anchor && telemetry.movementCompleteMs == armed.end, "telemetry anchors drifted")
      log.expect(telemetry.samples.count <= StrokeCompletionMonitor.recordedSampleCap, "samples \(telemetry.samples.count) > 50")
      log.expect(telemetry.observedSampleCount <= 512, "observedSampleCount \(telemetry.observedSampleCount) > buffer cap")
      log.expect(telemetry.observedUntilMs >= armed.end, "observedUntilMs before event end")
      log.expect(telemetry.samples.allSatisfy { $0.timestampMs >= armed.anchor }, "pre-anchor sample in telemetry")
      if let lastRecorded = telemetry.samples.last {
        log.expect(telemetry.samples.dropLast().allSatisfy { $0.timestampMs < lastRecorded.timestampMs }
                   || options.clockFaultRate > 0, "downsample did not keep the final sample last")
      }
      let payload = StrokeCompletionMonitor.payload(for: telemetry, rebasedTo: armed.start - 500)
      log.expect(JSONSerialization.isValidJSONObject(payload) || options.corruptionRate > 0, "telemetry payload is not JSON-safe")
      log.expect((payload["anchorMs"] as? Int ?? -1) >= 0 && (payload["finalizeMs"] as? Int ?? -1) >= 0, "rebased payload negative")
    }
  }

  static func monitorConcurrent(seed: UInt64, _ rng: inout StressRNG, _ log: inout InvariantLog) {
    let iterations = rng.int(in: 500 ... 3_000)
    let monitor = StrokeCompletionMonitor()
    let athlete = PoseSynth.Athlete.readyFraming(&rng)
    var t = rng.int(in: 0 ... 1_000_000)
    var frameRNG = StressRNG(seed: seed ^ 0xF00D)
    let frames: [PoseFrame] = (0 ..< iterations).map { index in
      t += 16
      let arm: PoseSynth.Arm = index % 200 < 60 ? .swing(phase: Double(index % 200) / 60, amplitude: 0.9) : .still
      return PoseSynth.frame(athlete, arm: arm, timestampMs: t, rng: &frameRNG)
    }
    let base = frames.first?.timestampMs ?? 0
    let group = DispatchGroup()
    let queue = DispatchQueue(label: "stress.monitor", attributes: .concurrent)
    let decisions = ThreadSafeCounter()
    queue.async(group: group) {
      for frame in frames { monitor.ingest(pose: frame) }
    }
    queue.async(group: group) {
      for frame in frames {
        monitor.observeFrame(timestampMs: frame.timestampMs)
        if monitor.adaptiveDecision() != nil { decisions.increment() }
      }
    }
    queue.async(group: group) {
      for (index, frame) in frames.enumerated() where index % 50 == 0 {
        monitor.arm(eventStartMs: base, eventEndMs: base + 600, peakMotionMs: base + 300)
        _ = monitor.telemetry(strategy: .fixed, finalizeMs: frame.timestampMs)
      }
    }
    queue.async(group: group) {
      for frame in frames where frame.timestampMs % 5 == 0 {
        _ = StrokeCompletionMonitor.payload(
          for: monitor.telemetry(strategy: .adaptive, finalizeMs: frame.timestampMs),
          rebasedTo: base
        )
      }
    }
    let waited = group.wait(timeout: .now() + 60)
    log.expect(waited == .success, "concurrent monitor work did not finish within 60 s (deadlock?)")
    log.operations += iterations * 4
    let telemetry = monitor.telemetry(strategy: .adaptive, finalizeMs: t)
    log.expect(telemetry.anchorMs == base + 300, "anchor changed by a re-arm")
    log.expect(telemetry.observedUntilMs <= t, "observedUntilMs \(telemetry.observedUntilMs) beyond the last frame \(t)")
    log.expect(telemetry.samples.count <= StrokeCompletionMonitor.recordedSampleCap, "sample cap")
    if let decision = monitor.adaptiveDecision() {
      log.expect(decision.endMs >= base + 300 && decision.endMs <= base + 300 + StrokeCompletionMonitor.Params.safetyMaxMs,
                 "decision \(decision.endMs) outside window")
    } else {
      log.expect(t < base + 300 + StrokeCompletionMonitor.Params.safetyMaxMs, "no decision although frames passed the safety max")
    }
    log.metrics["decisionObservations"] = Double(decisions.value)
  }

  static func motionTrailRandom(seed: UInt64, _ rng: inout StressRNG, _ log: inout InvariantLog) {
    let config = PoseMotionTrailBuffer.Config(
      maximumAgeMs: rng.pick([1, 320, 5_000]),
      maximumSampleGapMs: rng.pick([1, 250, 1_000]),
      maximumSamplesPerJoint: rng.pick([2, 8, 64])
    )
    var trail = PoseMotionTrailBuffer(config: config)
    let options = StreamGenerator.Options.random(&rng)
    let generated = StreamGenerator(seed: seed, options: options).generate()
    var clears = 0
    for tick in generated.ticks {
      log.operations += 1
      guard case .pose(let frame) = tick else {
        if rng.chance(0.05) { trail.clear(); clears += 1; log.expect(trail.storedSampleCount == 0, "clear() left samples") }
        continue
      }
      trail.ingest(landmarks: frame.landmarks, timestampMs: frame.timestampMs)
      log.expect(trail.storedSampleCount <= config.trackedJoints.count * config.maximumSamplesPerJoint,
                 "stored \(trail.storedSampleCount) > joints×cap")
      let probe = frame.timestampMs + rng.pick([0, 1, config.maximumAgeMs, config.maximumAgeMs + 1, -1])
      let segments = trail.segments(at: probe)
      log.expect(segments.count <= config.trackedJoints.count * (config.maximumSamplesPerJoint - 1), "too many segments")
      for segment in segments {
        log.expect(segment.ageFraction >= 0 && segment.ageFraction <= 1, "ageFraction \(segment.ageFraction) at probe \(probe)")
        log.expect(segment.normalizedSpeedPerSecond.isFinite && segment.normalizedSpeedPerSecond >= 0, "speed \(segment.normalizedSpeedPerSecond)")
        log.expect([segment.startX, segment.startY, segment.endX, segment.endY].allSatisfy { $0 >= 0 && $0 <= 1 },
                   "segment coordinate outside [0,1] — corrupt landmark leaked into the overlay")
        log.expect(config.trackedJoints.contains(segment.joint), "segment for untracked joint \(segment.joint)")
      }
    }
    log.metrics["clears"] = Double(clears)
  }

  static func memoryPressureLoop(seed: UInt64, _ rng: inout StressRNG, _ log: inout InvariantLog) {
    let frames = 60_000
    let detector = TemporalStrokeDetector()
    let readiness = PoseReadinessEvaluator()
    let evidence = CaptureEvidenceAccumulator()
    let stream = SessionMotionStream()
    let monitor = StrokeCompletionMonitor()
    var trail = PoseMotionTrailBuffer()
    let athlete = PoseSynth.Athlete.readyFraming(&rng)
    var t = rng.int(in: 0 ... 1_000_000)
    // Warm up allocator/caches before the baseline reading so growth reflects retention, not first-touch.
    var warm = StressRNG(seed: seed)
    for _ in 0 ..< 2_000 {
      t += 16
      let frame = PoseSynth.frame(athlete, arm: .still, timestampMs: t, rng: &warm)
      _ = detector.ingest(pose: frame, paddle: nil); _ = readiness.ingest(pose: frame); evidence.ingest(pose: frame)
      _ = stream.ingest(pose: frame); monitor.ingest(pose: frame); trail.ingest(landmarks: frame.landmarks, timestampMs: t)
    }
    guard let before = ProcessMemory.residentBytes() else { return log.fail("resident memory unavailable on this platform") }
    var events = 0
    for index in 0 ..< frames {
      t += rng.pick([8, 16, 33])
      let arm: PoseSynth.Arm = index % 300 < 45 ? .swing(phase: Double(index % 300) / 45, amplitude: 0.8) : .still
      var frame = PoseSynth.frame(athlete, arm: arm, timestampMs: t, rng: &rng)
      if rng.chance(0.01) { frame = PoseSynth.corrupt(frame, with: rng.pick(PoseSynth.nonDuplicatingCorruptions), rng: &rng) }
      log.operations += 1
      if detector.ingest(pose: frame, paddle: nil) != nil {
        events += 1
        monitor.arm(eventStartMs: t - 600, eventEndMs: t, peakMotionMs: t - 200)
      }
      _ = readiness.ingest(pose: frame)
      if index % 7 == 0 { evidence.ingestMissing(timestampMs: t) } else { evidence.ingest(pose: frame) }
      _ = stream.ingest(pose: frame)
      monitor.ingest(pose: frame)
      monitor.observeFrame(timestampMs: t)
      trail.ingest(landmarks: frame.landmarks, timestampMs: t)
      if index % 1_000 == 0 {
        _ = evidence.summary(startMs: t - 4_000, endMs: t, poseSource: "s", poseModelVersion: "m", triggerAlgorithmVersion: "a")
        _ = monitor.telemetry(strategy: .adaptive, finalizeMs: t)
        _ = trail.segments(at: t)
      }
    }
    guard let after = ProcessMemory.residentBytes() else { return log.fail("resident memory unavailable") }
    let growth = after - before
    log.metrics["rssBeforeBytes"] = Double(before)
    log.metrics["rssAfterBytes"] = Double(after)
    log.metrics["rssGrowthBytes"] = Double(growth)
    log.metrics["events"] = Double(events)
    log.expect(growth < 48 * 1024 * 1024, "resident memory grew \(growth) bytes over \(frames) frames — retention is not bounded")
    let summary = evidence.summary(startMs: t - 100_000, endMs: t, poseSource: "s", poseModelVersion: "m", triggerAlgorithmVersion: "a")
    log.expect((summary?.analysisInputFrameCount ?? 0) <= 4_000 / 8 + 1, "evidence retained \(summary?.analysisInputFrameCount ?? -1) attempts > 4 s window")
    log.expect(monitor.telemetry(strategy: .fixed, finalizeMs: t).observedSampleCount <= 512, "monitor buffer exceeded 512")
    log.expect(trail.storedSampleCount <= 8 * 8, "trail exceeded joints×cap")
  }

  static func timestampExtremes(_ rng: inout StressRNG, _ log: inout InvariantLog) {
    // Camera clocks are milliseconds since boot (~1e9). These values are not
    // reachable from AVFoundation; the scenario documents the arithmetic.
    let athlete = PoseSynth.Athlete.readyFraming(&rng)
    let extremes = [Int.max - 10, Int.max - 5_000, Int.min + 10, Int.min + 5_000]
    for base in extremes {
      log.operations += 1
      let evidence = CaptureEvidenceAccumulator()
      evidence.ingest(pose: PoseSynth.frame(athlete, arm: .still, timestampMs: base, rng: &rng))
      let readiness = PoseReadinessEvaluator()
      _ = readiness.ingest(pose: PoseSynth.frame(athlete, arm: .still, timestampMs: base, rng: &rng))
      var trail = PoseMotionTrailBuffer()
      trail.ingest(landmarks: PoseSynth.landmarks(athlete, arm: .still, rng: &rng), timestampMs: base)
      let monitor = StrokeCompletionMonitor()
      monitor.arm(eventStartMs: base, eventEndMs: base, peakMotionMs: base)
      monitor.observeFrame(timestampMs: base)
    }
  }

  static func importExtractionModel(seed: UInt64, _ rng: inout StressRNG, _ log: inout InvariantLog) {
    let fps = rng.pick([1.0, 24, 29.97, 30, 59.94, 60, 61, 120, 240, rng.double(in: 0.5 ... 300)])
    let durationSeconds = rng.pick([0.0, 0.001, 1.0 / fps, 5, 59.9, 60, 60.01, 61, 300, 600, rng.double(in: 0 ... 700)])
    let startPTS = rng.pick([0.0, 1.5, 3600, rng.double(in: 0 ... 100_000)])
    let rewindRate = rng.pick([0.0, 0.0, 0.01, 0.2])
    let nonNumericRate = rng.pick([0.0, 0.0, 0.02])
    let failureRate = rng.pick([0.0, 0.05, 0.3, 1.0])
    let sampleCount = min(Int(durationSeconds * fps), 150_000)
    var samples: [ImportExtractionModel.Sample] = []
    samples.reserveCapacity(sampleCount)
    var expectedRewinds = 0
    for index in 0 ..< sampleCount {
      let pts = startPTS + Double(index) / fps + (rng.chance(0.5) ? rng.double(in: -0.0004 ... 0.0004) : 0)
      if rng.chance(nonNumericRate) {
        samples.append(.init(presentationSeconds: nil))
      } else if index > 0, rng.chance(rewindRate) {
        expectedRewinds += 1
        samples.append(.init(presentationSeconds: startPTS - rng.double(in: 0.001 ... 10)))
      } else {
        samples.append(.init(presentationSeconds: pts))
      }
    }
    let athlete = PoseSynth.Athlete.readyFraming(&rng)
    var scriptRNG = StressRNG(seed: seed ^ 0xA11CE)
    let failures: [VisionFailure] = [.cancelled, .lowConfidence("no person"), .corruptedMedia("bad"), .notConfigured("x"), .unsupportedDevice("y")]
    var expectedGaps = 0
    let steps: [ScriptedPoseProvider.Step] = (0 ..< max(sampleCount, 1)).map { _ in
      if scriptRNG.chance(failureRate) {
        expectedGaps += 1
        return .failure(scriptRNG.pick(failures))
      }
      return .pose(PoseSynth.frame(athlete, arm: .still, timestampMs: 0, rng: &scriptRNG))
    }
    let cancelAtSample = rng.pick([Int.max, 0, 1, sampleCount / 2])
    var visited = 0
    let provider = ScriptedPoseProvider(steps: steps)
    let (result, trace) = ImportExtractionModel.run(samples: samples, durationSeconds: durationSeconds, provider: provider) {
      visited += 1
      return visited > cancelAtSample
    }
    log.operations += trace.providerCalls + samples.count
    // Determinism, and: cancellation changes NOTHING (the production loop has
    // no cancel check) — the uncancelled replay must be identical.
    let replay = ImportExtractionModel.run(samples: samples, durationSeconds: durationSeconds, provider: ScriptedPoseProvider(steps: steps))
    log.expect(replay.0 == result, "model is not deterministic / cancellation altered the result")
    log.expect(replay.1.providerCalls == trace.providerCalls, "cancellation altered the provider call count")
    log.expect(trace.ranPastCancellation == (visited > cancelAtSample), "cancellation bookkeeping")

    // Independent expectations from the raw timeline.
    let numericPTS = samples.compactMap(\.presentationSeconds)
    let expectInvalid = numericPTS.isEmpty
    let expectCap = numericPTS.first.map { first in numericPTS.contains { ($0 - first) * 1000 > 60_000 } } ?? false

    let maxKept = Int((ImportExtractionModel.importedPoseMaxDurationSeconds * 1000 / ImportExtractionModel.minimumIntervalMs).rounded(.up)) + 1
    log.expect(trace.providerCalls <= maxKept, "provider called \(trace.providerCalls) > \(maxKept) (decimation/cap failed)")
    log.expect(trace.progress.allSatisfy { $0 >= 0 && $0 <= 1 }, "progress outside [0,1]: \(trace.progress)")
    log.expect(zip(trace.progress, trace.progress.dropFirst()).allSatisfy { $0 <= $1 }, "progress not monotonic: \(trace.progress)")
    log.expect(trace.progress.count <= 13, "\(trace.progress.count) progress emissions (> 0 + 10 steps + completion + rounding)")
    let timestamps = trace.poses.map(\.timestampMs)
    log.expect(zip(timestamps, timestamps.dropFirst()).allSatisfy { $0 < $1 }, "pose timestamps not strictly increasing")
    log.expect(timestamps.allSatisfy { $0 >= 0 && $0 <= 60_000 }, "pose timestamp outside [0, 60000]")
    // The first numeric sample anchors the clock, so the first frame handed to
    // the provider is at 0 — even when that frame yields no pose (a scripted
    // failure), which is why this reads the kept timeline, not the poses.
    if let firstKept = trace.keptTimestampsMs.first {
      log.expect(firstKept == 0, "first kept frame rebased to \(firstKept), not 0")
    }
    let keptSorted = zip(trace.keptTimestampsMs, trace.keptTimestampsMs.dropFirst()).allSatisfy { $0 < $1 }
    log.expect(keptSorted, "kept timestamps not strictly increasing")
    log.expect(Set(timestamps).isSubset(of: Set(trace.keptTimestampsMs)), "a pose carries a timestamp that was never kept")
    switch result {
    case .invalidMedia:
      log.expect(trace.providerCalls == 0, "invalidMedia although \(trace.providerCalls) frames were processed")
      log.expect(expectInvalid, "invalidMedia with \(numericPTS.count) numeric samples")
    case .noPerson:
      log.expect(!expectInvalid && trace.providerCalls > 0 && trace.poses.isEmpty, "noPerson shape")
      log.expect(failureRate > 0, "noPerson although the provider never fails")
    case .sequence(let withPose, let total, let lastKept, let reachedCap):
      log.expect(!expectInvalid, "sequence from a timeline without numeric samples")
      log.expect(withPose == trace.poses.count && total == trace.providerCalls, "sequence counts drift from the trace")
      log.expect(withPose <= total && withPose > 0, "framesWithPose \(withPose) / framesTotal \(total)")
      log.expect(lastKept >= (timestamps.last ?? 0) && lastKept <= 60_000, "lastKeptTimestampMs \(lastKept) vs last pose \(timestamps.last ?? -1)")
      log.expect(reachedCap == expectCap, "reachedCap \(reachedCap) but timeline says \(expectCap)")
    }
    if failureRate == 0, !expectInvalid {
      log.expect(trace.poses.count == trace.providerCalls, "gap without a provider failure")
    }
    if failureRate == 1, !expectInvalid {
      log.expect(result == .noPerson, "every extraction failed (incl. .cancelled) yet result is \(result) — failures must be gaps")
    }
    log.metrics["providerCalls"] = Double(trace.providerCalls)
    log.metrics["poses"] = Double(trace.poses.count)
    log.metrics["rewinds"] = Double(expectedRewinds)
    log.metrics["scriptedGaps"] = Double(expectedGaps)
    log.metrics["ranPastCancellation"] = trace.ranPastCancellation ? 1 : 0
  }
}

final class ThreadSafeCounter: @unchecked Sendable {
  private let lock = NSLock()
  private var count = 0
  var value: Int { lock.lock(); defer { lock.unlock() }; return count }
  func increment() { lock.lock(); count += 1; lock.unlock() }
}
