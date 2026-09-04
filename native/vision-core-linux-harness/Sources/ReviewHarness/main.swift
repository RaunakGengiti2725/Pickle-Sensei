// Linux adversarial harness for the Foundation-only vision-core logic.
//
// Every scenario is deterministic (SplitMix64, seed printed with every row) so
// any failure replays with the exact same `--seed`. Scenarios that may trap
// run each seed in a CHILD process so a Swift runtime trap (precondition,
// overflow, duplicate dictionary key) is recorded as a row instead of taking
// the table down with it.
//
//   ReviewHarness fuzz      --seeds N --frames M --out DIR   (child per seed)
//   ReviewHarness scale     --frames M --out DIR             (RSS soak, in-proc)
//   ReviewHarness traps     --out DIR                        (dup keys / Int extremes, child per case)
//   ReviewHarness threads   --iterations N --out DIR         (run under --sanitize=thread)
//   ReviewHarness child <scenario> <args…>                   (internal)
import Foundation
@testable import PickleVisionCoreLinux

// MARK: - Deterministic PRNG

struct SplitMix64 {
  var state: UInt64
  init(seed: UInt64) { state = seed }
  mutating func next() -> UInt64 {
    state &+= 0x9E37_79B9_7F4A_7C15
    var z = state
    z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
    z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
    return z ^ (z >> 31)
  }
  mutating func unit() -> Double { Double(next() >> 11) / Double(1 << 53) }
  mutating func int(_ range: ClosedRange<Int>) -> Int {
    range.lowerBound + Int(next() % UInt64(range.upperBound - range.lowerBound + 1))
  }
  mutating func chance(_ p: Double) -> Bool { unit() < p }
}

// MARK: - Pose generation

let allJoints = [
  "head",
  "left_shoulder", "right_shoulder",
  "left_elbow", "right_elbow",
  "left_wrist", "right_wrist",
  "left_hip", "right_hip",
  "left_knee", "right_knee",
  "left_ankle", "right_ankle",
]

/// Canonical upright body, normalized top-left image coordinates.
let bodyTemplate: [String: (x: Double, y: Double)] = [
  "head": (0.50, 0.18),
  "left_shoulder": (0.42, 0.30), "right_shoulder": (0.58, 0.30),
  "left_elbow": (0.38, 0.42), "right_elbow": (0.62, 0.42),
  "left_wrist": (0.36, 0.53), "right_wrist": (0.64, 0.53),
  "left_hip": (0.45, 0.55), "right_hip": (0.55, 0.55),
  "left_knee": (0.45, 0.72), "right_knee": (0.55, 0.72),
  "left_ankle": (0.45, 0.88), "right_ankle": (0.55, 0.88),
]

enum InputMode: String, CaseIterable {
  /// 60 fps-ish monotonic camera stream, plausible body, occasional dropouts
  /// and swings. What Apple Vision plausibly emits.
  case realistic
  /// Every field hostile: NaN/±inf/huge/negative coordinates, visibility and
  /// confidence, repeated/regressing/gapped timestamps, missing joints.
  case hostile
  /// Realistic body but a broken clock: repeated, regressing and huge-gap
  /// timestamps.
  case clock
}

struct FrameInput {
  let index: Int
  let timestampMs: Int
  let pose: PoseFrame?  // nil = pose miss
  let duplicateLandmarks: Bool
}

struct StreamGenerator {
  var rng: SplitMix64
  let mode: InputMode
  let allowDuplicateNames: Bool
  var timestampMs = 1_000
  var driftX = 0.0
  /// Scripted athlete: rests (quiet wrists) for `restUntilMs`, then swings the
  /// paddle wrist along an arc for ~300 ms, then rests again. Realistic and
  /// clock modes use it so the detector's candidate/complete paths and the
  /// completion monitor's decisions actually run; hostile mode randomizes.
  var restUntilMs = 1_600
  var swingStartMs: Int? = nil
  var swingHand = "right_wrist"
  var swingDurationMs = 300
  var swingAmplitude = 0.4

  init(seed: UInt64, mode: InputMode, allowDuplicateNames: Bool) {
    rng = SplitMix64(seed: seed)
    self.mode = mode
    self.allowDuplicateNames = allowDuplicateNames
  }

  mutating func hostileDouble() -> Double {
    switch rng.int(0...11) {
    case 0: return .nan
    case 1: return .infinity
    case 2: return -.infinity
    case 3: return .greatestFiniteMagnitude
    case 4: return -.greatestFiniteMagnitude
    case 5: return .leastNonzeroMagnitude
    case 6: return -rng.unit()
    case 7: return 1 + rng.unit() * 1e6
    default: return rng.unit()
    }
  }

  mutating func nextTimestamp() -> Int {
    switch mode {
    case .realistic:
      timestampMs += rng.chance(0.03) ? rng.int(34...120) : rng.int(15...18)
    case .hostile:
      switch rng.int(0...9) {
      case 0: break  // repeat
      case 1: timestampMs -= rng.int(1...5_000)  // regress
      case 2: timestampMs += rng.int(250...60_000)  // huge gap
      case 3: timestampMs = rng.int(-100_000...100_000)  // jump anywhere
      default: timestampMs += rng.int(1...40)
      }
    case .clock:
      switch rng.int(0...29) {
      case 0: break
      case 1: timestampMs -= rng.int(1...400)
      case 2: timestampMs += rng.int(250...5_000)
      default: timestampMs += rng.int(15...18)
      }
    }
    return timestampMs
  }

  mutating func next(index: Int) -> FrameInput {
    let t = nextTimestamp()
    let missChance = mode == .realistic ? 0.01 : 0.15
    if rng.chance(missChance) {
      return FrameInput(index: index, timestampMs: t, pose: nil, duplicateLandmarks: false)
    }
    let scripted = mode != .hostile
    // Slow whole-body drift (weight shift), never a step.
    driftX += (rng.unit() - 0.5) * (scripted ? 0.0006 : 0.004)
    driftX = max(-0.2, min(0.2, driftX))
    var swingProgress: Double? = nil
    if scripted {
      if let start = swingStartMs {
        let elapsed = t - start
        if elapsed < 0 || elapsed > swingDurationMs {
          swingStartMs = nil
          restUntilMs = t + rng.int(600...2_200)
        } else {
          swingProgress = Double(elapsed) / Double(swingDurationMs)
        }
      } else if t >= restUntilMs {
        swingStartMs = t
        swingHand = rng.chance(0.5) ? "right_wrist" : "left_wrist"
        swingDurationMs = rng.int(220...420)
        swingAmplitude = 0.25 + rng.unit() * 0.3
        swingProgress = 0
      }
    }
    let randomSwing = !scripted && rng.chance(0.08)
    var landmarks: [PoseLandmark] = []
    var duplicated = false
    for name in allJoints {
      let base = bodyTemplate[name]!
      let jitter = scripted ? 0.0015 : 0.01
      var x = base.x + driftX + (rng.unit() - 0.5) * jitter
      var y = base.y + (rng.unit() - 0.5) * jitter
      if let progress = swingProgress, name == swingHand {
        // Arc from the hip forward and up, then back toward rest.
        let sweep = sin(progress * .pi)
        x += (name == "right_wrist" ? 1 : -1) * swingAmplitude * sweep
        y -= swingAmplitude * 0.6 * sweep
      }
      if randomSwing, name.hasSuffix("wrist") {
        x += (rng.unit() - 0.5) * 0.5
        y += (rng.unit() - 0.5) * 0.5
      }
      var visibility = 0.55 + rng.unit() * 0.45
      if rng.chance(mode == .realistic ? 0.005 : 0.3) { visibility = rng.unit() * 0.35 }
      if mode == .hostile {
        if rng.chance(0.25) { x = hostileDouble() }
        if rng.chance(0.25) { y = hostileDouble() }
        if rng.chance(0.25) { visibility = hostileDouble() }
        if rng.chance(0.15) { continue }  // missing joint
      } else if rng.chance(0.002) {
        continue
      }
      landmarks.append(PoseLandmark(name: name, x: x, y: y, visibility: visibility))
      if allowDuplicateNames, rng.chance(0.05) {
        landmarks.append(PoseLandmark(name: name, x: x, y: y, visibility: visibility))
        duplicated = true
      }
    }
    var confidence = 0.55 + rng.unit() * 0.45
    if mode == .hostile, rng.chance(0.3) { confidence = hostileDouble() }
    if mode == .realistic, rng.chance(0.02) { confidence = rng.unit() * 0.5 }
    return FrameInput(
      index: index,
      timestampMs: t,
      pose: PoseFrame(timestampMs: t, landmarks: landmarks, confidence: confidence),
      duplicateLandmarks: duplicated
    )
  }
}

// MARK: - Introspection of private retained state (Mirror reads stored properties)

func storedCount(_ subject: Any, _ label: String) -> Int? {
  for child in Mirror(reflecting: subject).children where child.label == label {
    if let array = child.value as? [Any] { return array.count }
    let m = Mirror(reflecting: child.value)
    if m.displayStyle == .dictionary || m.displayStyle == .collection { return m.children.count }
  }
  return nil
}

func residentSetKB() -> Int {
  guard let status = try? String(contentsOfFile: "/proc/self/status", encoding: .utf8) else { return -1 }
  for line in status.split(separator: "\n") where line.hasPrefix("VmRSS:") {
    let digits = line.split(separator: " ").compactMap { Int($0) }
    return digits.first ?? -1
  }
  return -1
}

// MARK: - Component bundle exercised per frame

final class Bundle_ {
  let detector = TemporalStrokeDetector()
  let readiness = PoseReadinessEvaluator()
  let evidence = CaptureEvidenceAccumulator(retentionMs: 15_000)
  let motion = SessionMotionStream()
  /// The controller allocates one monitor per capture and never resets it;
  /// a fresh instance after each decision mirrors that lifecycle.
  var monitor = StrokeCompletionMonitor()
  var trail = PoseMotionTrailBuffer()

  var violations: [[String: Any]] = []
  var detectorEvents = 0
  var readyFrames = 0
  var motionSamples = 0
  var summaries = 0
  var nilSummaries = 0
  var trailSegments = 0
  var monitorDecisions = 0
  var monitorArms = 0
  var invalidJSONPayloads = 0
  var maxEvidenceAttempts = 0
  var maxStableSamples = 0
  var maxMonitorBuffer = 0
  var maxTrailSamples = 0
  var maxDetectorLastPoints = 0
  var maxMotionLastPoints = 0
  var lastEventEnd = Int.min

  func violation(_ kind: String, _ frame: FrameInput, _ detail: [String: Any]) {
    guard violations.count < 200 else { return }
    var row: [String: Any] = ["kind": kind, "frameIndex": frame.index, "timestampMs": frame.timestampMs]
    if let pose = frame.pose {
      row["confidence"] = pose.confidence.isFinite ? pose.confidence : "\(pose.confidence)"
      row["landmarks"] = pose.landmarks.map {
        ["n": $0.name, "x": "\($0.x)", "y": "\($0.y)", "v": "\($0.visibility)"]
      }
    }
    for (k, v) in detail { row[k] = v }
    violations.append(row)
  }

  func feed(_ frame: FrameInput, summaryEvery: Int) {
    if let pose = frame.pose {
      // TemporalStrokeDetector
      if let event = detector.ingest(pose: pose, paddle: nil) {
        detectorEvents += 1
        if !(event.startMs <= event.endMs) {
          violation("detector.reversed_event", frame, ["startMs": event.startMs, "endMs": event.endMs])
        }
        if let peak = event.peakMotionMs, !(peak >= event.startMs && peak <= event.endMs) {
          violation("detector.peak_outside_event", frame, ["startMs": event.startMs, "endMs": event.endMs, "peak": peak])
        }
        if !event.confidence.isFinite || event.confidence < 0 || event.confidence > 1 {
          violation("detector.confidence_range", frame, ["confidence": "\(event.confidence)"])
        }
        let duration = event.endMs - event.startMs
        if duration > TemporalStrokeDetector.Config().maxStrokeMs + TemporalStrokeDetector.Config().maxOnsetToTriggerMs {
          violation("detector.duration_exceeds_config", frame, ["durationMs": duration])
        }
        if event.startMs < lastEventEnd {
          violation("detector.overlapping_events", frame, ["startMs": event.startMs, "previousEndMs": lastEventEnd])
        }
        lastEventEnd = event.endMs
        monitor.arm(eventStartMs: event.startMs, eventEndMs: event.endMs, peakMotionMs: event.peakMotionMs)
        monitorArms += 1
      }
      // PoseReadinessEvaluator
      let snapshot = readiness.ingest(pose: pose)
      if snapshot.isReady { readyFrames += 1 }
      if snapshot.stableForMs < 0 { violation("readiness.negative_stable", frame, ["stableForMs": snapshot.stableForMs]) }
      if !snapshot.jointCoverage.isFinite || snapshot.jointCoverage < 0 || snapshot.jointCoverage > 1 {
        violation("readiness.coverage_range", frame, ["coverage": "\(snapshot.jointCoverage)"])
      }
      if snapshot.isReady, !snapshot.poseConfidence.isFinite {
        violation("readiness.ready_with_nonfinite_confidence", frame, [:])
      }
      // CaptureEvidenceAccumulator
      evidence.ingest(pose: pose)
      // SessionMotionStream
      if let sample = motion.ingest(pose: pose) {
        motionSamples += 1
        if !sample.value.isFinite || sample.value < 0 {
          violation("motion.nonfinite_or_negative_speed", frame, ["value": "\(sample.value)"])
        }
        if sample.timestampMs != pose.timestampMs {
          violation("motion.timestamp_mismatch", frame, ["sampleTs": sample.timestampMs])
        }
      }
      // StrokeCompletionMonitor
      monitor.ingest(pose: pose)
      // PoseMotionTrail
      trail.ingest(landmarks: pose.landmarks, timestampMs: pose.timestampMs)
      let segments = trail.segments(at: pose.timestampMs)
      trailSegments += segments.count
      for segment in segments {
        if !segment.normalizedSpeedPerSecond.isFinite || segment.normalizedSpeedPerSecond < 0 {
          violation("trail.nonfinite_speed", frame, ["joint": segment.joint, "speed": "\(segment.normalizedSpeedPerSecond)"])
        }
        if !segment.ageFraction.isFinite || segment.ageFraction < 0 || segment.ageFraction > 1 {
          violation("trail.age_fraction_range", frame, ["joint": segment.joint, "age": "\(segment.ageFraction)"])
        }
        for v in [segment.startX, segment.startY, segment.endX, segment.endY] where !v.isFinite {
          violation("trail.nonfinite_coordinate", frame, ["joint": segment.joint])
        }
      }
      let trailCap = PoseMotionTrailBuffer.Config().trackedJoints.count * PoseMotionTrailBuffer.Config().maximumSamplesPerJoint
      if trail.storedSampleCount > trailCap {
        violation("trail.over_capacity", frame, ["stored": trail.storedSampleCount, "cap": trailCap])
      }
    } else {
      _ = readiness.ingestMissing(timestampMs: frame.timestampMs)
      evidence.ingestMissing(timestampMs: frame.timestampMs)
    }
    monitor.observeFrame(timestampMs: frame.timestampMs)
    if monitor.adaptiveDecision() != nil {
      monitorDecisions += 1
      let telemetry = monitor.telemetry(strategy: .fixed, finalizeMs: frame.timestampMs)
      if telemetry.samples.count > StrokeCompletionMonitor.recordedSampleCap {
        violation("monitor.samples_over_cap", frame, ["count": telemetry.samples.count])
      }
      let payload = StrokeCompletionMonitor.payload(for: telemetry, rebasedTo: telemetry.anchorMs)
      if !JSONSerialization.isValidJSONObject(payload) {
        invalidJSONPayloads += 1
        violation("monitor.payload_not_json_serializable", frame, [
          "peakMotionValue": "\(telemetry.peakMotionValue)",
          "sampleValues": telemetry.samples.map { "\($0.value)" },
        ])
      }
      monitor = StrokeCompletionMonitor()
    }

    if summaryEvery > 0, frame.index % summaryEvery == 0 {
      let summary = evidence.summary(
        startMs: frame.timestampMs - 2_000, endMs: frame.timestampMs,
        poseSource: "harness", poseModelVersion: "harness", triggerAlgorithmVersion: "harness"
      )
      if let summary {
        summaries += 1
        let unit = [summary.meanCanonicalJointVisibility, summary.meanJointCoverage, summary.minimumJointCoverage]
        for value in unit where !value.isFinite || value < 0 || value > 1 {
          violation("evidence.summary_unit_range", frame, ["value": "\(value)"])
        }
        if summary.poseMissingFrameCount < 0 || summary.trackedDurationMs < 0 || summary.poseFrameCount <= 0 {
          violation("evidence.summary_counts", frame, ["missing": summary.poseMissingFrameCount, "tracked": summary.trackedDurationMs])
        }
        for motion in summary.jointMotion where !motion.meanNormalizedPerSecond.isFinite || !motion.peakNormalizedPerSecond.isFinite {
          violation("evidence.motion_nonfinite", frame, ["joint": motion.joint])
        }
      } else {
        nilSummaries += 1
      }
    }

    maxEvidenceAttempts = max(maxEvidenceAttempts, storedCount(evidence, "attempts") ?? -1)
    maxStableSamples = max(maxStableSamples, storedCount(readiness, "stableSamples") ?? -1)
    maxMonitorBuffer = max(maxMonitorBuffer, storedCount(monitor, "buffer") ?? -1)
    maxTrailSamples = max(maxTrailSamples, trail.storedSampleCount)
    maxDetectorLastPoints = max(maxDetectorLastPoints, storedCount(detector, "lastPoints") ?? -1)
    maxMotionLastPoints = max(maxMotionLastPoints, storedCount(motion, "lastPoints") ?? -1)
  }

  var stats: [String: Any] {
    [
      "detectorEvents": detectorEvents,
      "readyFrames": readyFrames,
      "motionSamples": motionSamples,
      "evidenceSummaries": summaries,
      "evidenceNilSummaries": nilSummaries,
      "trailSegments": trailSegments,
      "monitorArms": monitorArms,
      "monitorDecisions": monitorDecisions,
      "monitorInvalidJSONPayloads": invalidJSONPayloads,
      "maxRetained": [
        "evidence.attempts": maxEvidenceAttempts,
        "readiness.stableSamples": maxStableSamples,
        "monitor.buffer": maxMonitorBuffer,
        "trail.storedSamples": maxTrailSamples,
        "detector.lastPoints": maxDetectorLastPoints,
        "motion.lastPoints": maxMotionLastPoints,
      ],
      "violations": violations.count,
    ]
  }
}

// MARK: - CLI plumbing

let args = Array(CommandLine.arguments.dropFirst())
func flag(_ name: String) -> String? {
  guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
  return args[i + 1]
}
func intFlag(_ name: String, _ fallback: Int) -> Int { flag(name).flatMap { Int($0) } ?? fallback }

func writeJSON(_ object: Any, to path: String) throws {
  let data = try JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys])
  try data.write(to: URL(fileURLWithPath: path))
}

func selfPath() -> String { CommandLine.arguments[0] }

struct ChildResult {
  let exitCode: Int32
  let signal: Int32?
  let stdout: String
  let stderr: String
}

func runChild(_ arguments: [String], timeoutSeconds: Double = 600) -> ChildResult {
  let process = Process()
  process.executableURL = URL(fileURLWithPath: selfPath())
  process.arguments = ["child"] + arguments
  let out = Pipe()
  let err = Pipe()
  process.standardOutput = out
  process.standardError = err
  final class Box { var data = Data() }
  let outBox = Box()
  let errBox = Box()
  let group = DispatchGroup()
  group.enter()
  DispatchQueue.global().async { outBox.data = out.fileHandleForReading.readDataToEndOfFile(); group.leave() }
  group.enter()
  DispatchQueue.global().async { errBox.data = err.fileHandleForReading.readDataToEndOfFile(); group.leave() }
  do { try process.run() } catch {
    return ChildResult(exitCode: -1, signal: nil, stdout: "", stderr: "spawn failed: \(error)")
  }
  let deadline = DispatchTime.now() + timeoutSeconds
  let waiter = DispatchGroup()
  waiter.enter()
  DispatchQueue.global().async { process.waitUntilExit(); waiter.leave() }
  if waiter.wait(timeout: deadline) == .timedOut {
    process.terminate()
    process.waitUntilExit()
  }
  group.wait()
  let signal: Int32? = process.terminationReason == .uncaughtSignal ? process.terminationStatus : nil
  return ChildResult(
    exitCode: process.terminationStatus,
    signal: signal,
    stdout: String(decoding: outBox.data, as: UTF8.self),
    stderr: String(decoding: errBox.data, as: UTF8.self)
  )
}

func firstLine(_ s: String, max: Int = 400) -> String {
  let trimmed = s.split(separator: "\n").first.map(String.init) ?? ""
  return trimmed.count > max ? String(trimmed.prefix(max)) + "…" : trimmed
}

// MARK: - Child scenarios (run in isolation; a trap here is a recorded row)

func childFuzz(seed: UInt64, mode: InputMode, frames: Int, allowDuplicateNames: Bool) throws {
  var generator = StreamGenerator(seed: seed, mode: mode, allowDuplicateNames: allowDuplicateNames)
  let bundle = Bundle_()
  let started = Date()
  for index in 0..<frames {
    let input = generator.next(index: index)
    // Progress on stderr: a trap leaves the last reached index behind, and
    // `child replay-frame --index` reproduces the exact offending input.
    if index % 5_000 == 0 { FileHandle.standardError.write(Data("progress \(index)\n".utf8)) }
    bundle.feed(input, summaryEvery: 500)
  }
  var row = bundle.stats
  row["seed"] = seed
  row["mode"] = mode.rawValue
  row["frames"] = frames
  row["wallMs"] = Int(Date().timeIntervalSince(started) * 1000)
  row["violationRows"] = bundle.violations
  print(String(decoding: try JSONSerialization.data(withJSONObject: row, options: [.sortedKeys]), as: UTF8.self))
}

/// Replays a seed and prints the exact frame at `index` (for a trap repro).
func childReplayFrame(seed: UInt64, mode: InputMode, index: Int, allowDuplicateNames: Bool) throws {
  var generator = StreamGenerator(seed: seed, mode: mode, allowDuplicateNames: allowDuplicateNames)
  var input: FrameInput?
  for i in 0...index { input = generator.next(index: i) }
  guard let input else { return }
  var row: [String: Any] = ["index": input.index, "timestampMs": input.timestampMs, "duplicates": input.duplicateLandmarks]
  if let pose = input.pose {
    row["confidence"] = "\(pose.confidence)"
    row["landmarks"] = pose.landmarks.map { ["n": $0.name, "x": "\($0.x)", "y": "\($0.y)", "v": "\($0.visibility)"] }
  }
  print(String(decoding: try JSONSerialization.data(withJSONObject: row, options: [.sortedKeys]), as: UTF8.self))
}

func fullPose(timestampMs: Int, xOffset: Double = 0, visibility: Double = 0.9, confidence: Double = 0.9) -> PoseFrame {
  PoseFrame(
    timestampMs: timestampMs,
    landmarks: allJoints.map {
      let b = bodyTemplate[$0]!
      return PoseLandmark(name: $0, x: b.x + xOffset, y: b.y, visibility: visibility)
    },
    confidence: confidence
  )
}

/// One trap probe per (component, case). Prints "ok <detail>" on survival.
func childTrap(component: String, caseName: String) {
  func dupPose(_ t: Int) -> PoseFrame {
    let base = fullPose(timestampMs: t)
    // Vision-shaped frame with ONE landmark name repeated (e.g. a provider
    // that appends both a raw and a smoothed wrist under the same name).
    return PoseFrame(timestampMs: t, landmarks: base.landmarks + [base.landmarks[5]], confidence: 0.9)
  }
  func posesFor(_ caseName: String) -> [PoseFrame] {
    switch caseName {
    case "duplicate_landmark_name": return [dupPose(1_000), dupPose(1_016)]
    case "int_max_timestamp": return [fullPose(timestampMs: 1_000), fullPose(timestampMs: Int.max)]
    case "int_min_timestamp": return [fullPose(timestampMs: Int.min), fullPose(timestampMs: 1_000)]
    case "int_max_then_regress": return [fullPose(timestampMs: Int.max), fullPose(timestampMs: 0)]
    case "nan_everything":
      return [PoseFrame(timestampMs: 1_000, landmarks: allJoints.map { PoseLandmark(name: $0, x: .nan, y: .nan, visibility: .nan) }, confidence: .nan),
              PoseFrame(timestampMs: 1_016, landmarks: allJoints.map { PoseLandmark(name: $0, x: .nan, y: .nan, visibility: .nan) }, confidence: .nan)]
    case "infinite_coordinates":
      return [fullPose(timestampMs: 1_000),
              PoseFrame(timestampMs: 1_016, landmarks: allJoints.map { PoseLandmark(name: $0, x: .infinity, y: -.infinity, visibility: 1) }, confidence: 1)]
    case "empty_landmarks":
      return [PoseFrame(timestampMs: 1_000, landmarks: [], confidence: 1), PoseFrame(timestampMs: 1_016, landmarks: [], confidence: 1)]
    default: return []
    }
  }
  let poses = posesFor(caseName)
  switch component {
  case "PoseReadinessEvaluator":
    let e = PoseReadinessEvaluator()
    var last: PoseReadinessEvaluator.Snapshot?
    for p in poses { last = e.ingest(pose: p) }
    print("ok state=\(last?.state.rawValue ?? "nil") stableForMs=\(last?.stableForMs ?? -1)")
  case "CaptureEvidenceAccumulator":
    let a = CaptureEvidenceAccumulator(retentionMs: 15_000)
    for p in poses { a.ingest(pose: p) }
    let s = a.summary(startMs: Int.min, endMs: Int.max, poseSource: "h", poseModelVersion: "h", triggerAlgorithmVersion: "h")
    print("ok summary=\(s.map { "poses=\($0.poseFrameCount) vis=\($0.meanCanonicalJointVisibility)" } ?? "nil")")
  case "TemporalStrokeDetector":
    let d = TemporalStrokeDetector()
    var events = 0
    for p in poses where d.ingest(pose: p, paddle: nil) != nil { events += 1 }
    print("ok events=\(events)")
  case "SessionMotionStream":
    let m = SessionMotionStream()
    var values: [String] = []
    for p in poses { if let s = m.ingest(pose: p) { values.append("\(s.value)") } }
    print("ok samples=\(values)")
  case "StrokeCompletionMonitor":
    let m = StrokeCompletionMonitor()
    for p in poses { m.ingest(pose: p) }
    m.arm(eventStartMs: poses.first?.timestampMs ?? 0, eventEndMs: poses.last?.timestampMs ?? 0, peakMotionMs: nil)
    for p in poses { m.observeFrame(timestampMs: p.timestampMs) }
    let t = m.telemetry(strategy: .fixed, finalizeMs: poses.last?.timestampMs ?? 0)
    let payload = StrokeCompletionMonitor.payload(for: t, rebasedTo: t.anchorMs)
    print("ok peak=\(t.peakMotionValue) samples=\(t.samples.count) jsonValid=\(JSONSerialization.isValidJSONObject(payload))")
  case "PoseMotionTrailBuffer":
    var b = PoseMotionTrailBuffer()
    for p in poses { b.ingest(landmarks: p.landmarks, timestampMs: p.timestampMs) }
    let segs = b.segments(at: poses.last?.timestampMs ?? 0)
    print("ok stored=\(b.storedSampleCount) segments=\(segs.count)")
  default:
    print("unknown component")
  }
}

// MARK: - Parent scenarios

func runFuzz() throws {
  let seeds = intFlag("--seeds", 64)
  let frames = intFlag("--frames", 20_000)
  let seedBase = UInt64(intFlag("--seed-base", 1))
  let out = flag("--out") ?? "artifacts/native-static-review"
  let allowDuplicates = args.contains("--allow-duplicate-names")
  try FileManager.default.createDirectory(atPath: out, withIntermediateDirectories: true)
  let modes = InputMode.allCases
  var rows: [[String: Any]] = []
  let lock = NSLock()
  let jobs: [(UInt64, InputMode)] = (0..<seeds).flatMap { i in modes.map { (seedBase + UInt64(i), $0) } }
  let started = Date()
  DispatchQueue.concurrentPerform(iterations: jobs.count) { jobIndex in
    let (seed, mode) = jobs[jobIndex]
    var childArgs = ["fuzz", "--seed", "\(seed)", "--mode", mode.rawValue, "--frames", "\(frames)"]
    if allowDuplicates { childArgs.append("--allow-duplicate-names") }
    let result = runChild(childArgs)
    var row: [String: Any] = ["seed": seed, "mode": mode.rawValue, "frames": frames, "exitCode": result.exitCode]
    if let signal = result.signal { row["signal"] = signal }
    if result.exitCode == 0,
       let data = result.stdout.data(using: .utf8),
       let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
      for (k, v) in parsed { row[k] = v }
      row["status"] = (parsed["violations"] as? Int ?? 0) == 0 ? "pass" : "invariant_violation"
    } else {
      row["status"] = "crash"
      let progress = result.stderr.split(separator: "\n").filter { $0.hasPrefix("progress") }.last.map(String.init) ?? ""
      row["lastProgress"] = progress
      row["stderrTail"] = result.stderr.split(separator: "\n").filter { !$0.hasPrefix("progress") }.suffix(6).joined(separator: "\n")
      row["replay"] = "ReviewHarness child fuzz --seed \(seed) --mode \(mode.rawValue) --frames \(frames)\(allowDuplicates ? " --allow-duplicate-names" : "")"
    }
    lock.lock(); rows.append(row); lock.unlock()
  }
  rows.sort { (($0["seed"] as? UInt64) ?? 0, ($0["mode"] as? String) ?? "") < (($1["seed"] as? UInt64) ?? 0, ($1["mode"] as? String) ?? "") }
  let crashes = rows.filter { $0["status"] as? String == "crash" }
  let violations = rows.filter { $0["status"] as? String == "invariant_violation" }
  func statusCount(_ group: [[String: Any]], _ status: String) -> Int {
    group.filter { ($0["status"] as? String) == status }.count
  }
  func sumInt(_ group: [[String: Any]], _ key: String) -> Int {
    var total = 0
    for row in group { total += (row[key] as? Int) ?? 0 }
    return total
  }
  func maxRetained(_ group: [[String: Any]]) -> [String: Int] {
    var acc: [String: Int] = [:]
    for row in group {
      let retained = (row["maxRetained"] as? [String: Int]) ?? [:]
      for (k, v) in retained { acc[k] = max(acc[k] ?? Int.min, v) }
    }
    return acc
  }
  var byMode: [String: Any] = [:]
  for mode in modes {
    let group = rows.filter { ($0["mode"] as? String) == mode.rawValue }
    var entry: [String: Any] = [:]
    entry["pass"] = statusCount(group, "pass")
    entry["crash"] = statusCount(group, "crash")
    entry["invariantViolation"] = statusCount(group, "invariant_violation")
    entry["detectorEvents"] = sumInt(group, "detectorEvents")
    entry["monitorDecisions"] = sumInt(group, "monitorDecisions")
    entry["monitorInvalidJSONPayloads"] = sumInt(group, "monitorInvalidJSONPayloads")
    entry["readyFrames"] = sumInt(group, "readyFrames")
    entry["maxRetained"] = maxRetained(group)
    byMode[mode.rawValue] = entry
  }
  var summary: [String: Any] = [:]
  summary["scenario"] = "fuzz"
  summary["seeds"] = seeds
  summary["seedBase"] = seedBase
  summary["framesPerSeed"] = frames
  summary["modes"] = modes.map(\.rawValue)
  summary["totalFramesFed"] = seeds * frames * modes.count
  summary["allowDuplicateNames"] = allowDuplicates
  summary["rows"] = rows.count
  summary["pass"] = rows.count - crashes.count - violations.count
  summary["crash"] = crashes.count
  summary["invariantViolation"] = violations.count
  summary["wallSeconds"] = Int(Date().timeIntervalSince(started))
  summary["byMode"] = byMode
  try writeJSON(["summary": summary, "rows": rows], to: "\(out)/fuzz.json")
  print(String(decoding: try JSONSerialization.data(withJSONObject: summary, options: [.prettyPrinted, .sortedKeys]), as: UTF8.self))
}

func runScale() throws {
  let frames = intFlag("--frames", 2_000_000)
  let out = flag("--out") ?? "artifacts/native-static-review"
  let modeName = flag("--mode") ?? "realistic"
  let mode = InputMode(rawValue: modeName) ?? .realistic
  let seed = UInt64(intFlag("--seed", 7))
  try FileManager.default.createDirectory(atPath: out, withIntermediateDirectories: true)
  var generator = StreamGenerator(seed: seed, mode: mode, allowDuplicateNames: false)
  let bundle = Bundle_()
  var checkpoints: [[String: Any]] = []
  let started = Date()
  let baselineKB = residentSetKB()
  let every = max(1, frames / 40)
  for index in 0..<frames {
    let input = generator.next(index: index)
    bundle.feed(input, summaryEvery: 600)
    if index % every == 0 || index == frames - 1 {
      checkpoints.append([
        "frame": index,
        "streamTimestampMs": input.timestampMs,
        "rssKB": residentSetKB(),
        "retained": [
          "evidence.attempts": storedCount(bundle.evidence, "attempts") ?? -1,
          "readiness.stableSamples": storedCount(bundle.readiness, "stableSamples") ?? -1,
          "monitor.buffer": storedCount(bundle.monitor, "buffer") ?? -1,
          "trail.storedSamples": bundle.trail.storedSampleCount,
          "detector.lastPoints": storedCount(bundle.detector, "lastPoints") ?? -1,
          "detector.wristPaths": storedCount(bundle.detector, "wristPaths") ?? -1,
          "motion.lastPoints": storedCount(bundle.motion, "lastPoints") ?? -1,
        ],
        "elapsedMs": Int(Date().timeIntervalSince(started) * 1000),
      ])
    }
  }
  let rss = checkpoints.compactMap { $0["rssKB"] as? Int }
  var summary = bundle.stats
  summary["scenario"] = "scale"
  summary["mode"] = mode.rawValue
  summary["seed"] = seed
  summary["frames"] = frames
  summary["baselineRssKB"] = baselineKB
  summary["minRssKB"] = rss.min() ?? -1
  summary["maxRssKB"] = rss.max() ?? -1
  summary["finalRssKB"] = rss.last ?? -1
  summary["rssGrowthKB_firstToLastCheckpoint"] = (rss.last ?? 0) - (rss.first ?? 0)
  summary["wallSeconds"] = Int(Date().timeIntervalSince(started))
  summary["framesPerSecond"] = Int(Double(frames) / max(0.001, Date().timeIntervalSince(started)))
  try writeJSON(["summary": summary, "checkpoints": checkpoints, "violations": bundle.violations], to: "\(out)/scale-\(mode.rawValue).json")
  print(String(decoding: try JSONSerialization.data(withJSONObject: summary, options: [.prettyPrinted, .sortedKeys]), as: UTF8.self))
}

func runTraps() throws {
  let out = flag("--out") ?? "artifacts/native-static-review"
  try FileManager.default.createDirectory(atPath: out, withIntermediateDirectories: true)
  let components = ["PoseReadinessEvaluator", "CaptureEvidenceAccumulator", "TemporalStrokeDetector",
                    "SessionMotionStream", "StrokeCompletionMonitor", "PoseMotionTrailBuffer"]
  let cases = ["duplicate_landmark_name", "int_max_timestamp", "int_min_timestamp", "int_max_then_regress",
               "nan_everything", "infinite_coordinates", "empty_landmarks"]
  var rows: [[String: Any]] = []
  for component in components {
    for caseName in cases {
      let result = runChild(["trap", component, caseName])
      var row: [String: Any] = ["component": component, "case": caseName, "exitCode": result.exitCode]
      if let signal = result.signal { row["signal"] = signal }
      row["status"] = result.exitCode == 0 ? "survived" : "trapped"
      row["stdout"] = firstLine(result.stdout)
      row["stderr"] = result.stderr.split(separator: "\n").prefix(3).joined(separator: " | ")
      row["replay"] = "ReviewHarness child trap \(component) \(caseName)"
      rows.append(row)
    }
  }
  let trapped = rows.filter { $0["status"] as? String == "trapped" }
  let summary: [String: Any] = [
    "scenario": "traps", "rows": rows.count, "trapped": trapped.count,
    "trappedCases": trapped.map { "\($0["component"] ?? "")/\($0["case"] ?? "")" },
  ]
  try writeJSON(["summary": summary, "rows": rows], to: "\(out)/traps.json")
  print(String(decoding: try JSONSerialization.data(withJSONObject: ["summary": summary, "rows": rows], options: [.prettyPrinted, .sortedKeys]), as: UTF8.self))
}

/// Concurrency probes. Meaningful under `swift build --sanitize=thread`.
/// (1) StrokeCompletionMonitor exactly as the controller uses it: ingest on
///     the vision queue, observeFrame/adaptiveDecision on the camera frame
///     queue, arm from the vision queue, telemetry from the finalize path.
/// (2) The unlocked single-queue classes driven from ONE serial queue
///     (the documented contract) — must be race-free.
/// (3) `closureVarRace`: a closure property assigned on one thread while
///     another thread invokes it — the shape of
///     SessionCaptureCoordinator.onPoseFrame (set by PickleSessionPreview on
///     main, read on the vision queue). Expected to be flagged; it exists to
///     show TSan sees that pattern, and is reported separately.
func runThreads() throws {
  let iterations = intFlag("--iterations", 200_000)
  let out = flag("--out") ?? "artifacts/native-static-review"
  let probe = flag("--probe") ?? "monitor"
  try FileManager.default.createDirectory(atPath: out, withIntermediateDirectories: true)
  let visionQueue = DispatchQueue(label: "harness.vision")
  let frameQueue = DispatchQueue(label: "harness.frame")
  let group = DispatchGroup()
  var generator = StreamGenerator(seed: 11, mode: .realistic, allowDuplicateNames: false)
  let inputs = (0..<iterations).map { generator.next(index: $0) }
  final class Counters {
    let lock = NSLock()
    var decisions = 0
    var telemetries = 0
    var sink = 0
    func bump(_ apply: (Counters) -> Void) { lock.lock(); apply(self); lock.unlock() }
  }
  let counters = Counters()

  switch probe {
  case "monitor":
    let monitor = StrokeCompletionMonitor()
    group.enter()
    visionQueue.async {
      for (i, input) in inputs.enumerated() {
        if let pose = input.pose { monitor.ingest(pose: pose) }
        if i % 400 == 0 {
          monitor.arm(eventStartMs: input.timestampMs - 600, eventEndMs: input.timestampMs, peakMotionMs: input.timestampMs - 300)
        }
      }
      group.leave()
    }
    group.enter()
    frameQueue.async {
      for input in inputs {
        monitor.observeFrame(timestampMs: input.timestampMs)
        if monitor.adaptiveDecision() != nil {
          counters.bump { $0.decisions += 1 }
        }
      }
      group.leave()
    }
    group.enter()
    DispatchQueue.global().async {
      for i in 0..<(iterations / 50) {
        let t = monitor.telemetry(strategy: .adaptive, finalizeMs: inputs[min(i * 50, inputs.count - 1)].timestampMs)
        _ = StrokeCompletionMonitor.payload(for: t, rebasedTo: t.anchorMs)
        counters.bump { $0.telemetries += 1 }
      }
      group.leave()
    }
  case "single-queue":
    let bundle = Bundle_()
    group.enter()
    visionQueue.async {
      for input in inputs { bundle.feed(input, summaryEvery: 300) }
      group.leave()
    }
    // A reader on another queue that hops THROUGH the vision queue (the
    // production pattern for summary reads) must also be clean.
    group.enter()
    DispatchQueue.global().async {
      for _ in 0..<50 {
        _ = visionQueue.sync {
          bundle.evidence.summary(startMs: 0, endMs: Int.max, poseSource: "h", poseModelVersion: "h", triggerAlgorithmVersion: "h")
        }
      }
      group.leave()
    }
  case "closure-var-race":
    final class Coordinator {
      var onPoseFrame: ((Int) -> Void)?
    }
    let coordinator = Coordinator()
    group.enter()
    visionQueue.async {
      for i in 0..<iterations { coordinator.onPoseFrame?(i) }
      group.leave()
    }
    group.enter()
    DispatchQueue.global().async {
      for i in 0..<iterations {
        coordinator.onPoseFrame = i % 2 == 0 ? { v in counters.bump { $0.sink &+= v } } : nil
      }
      group.leave()
    }
  default:
    print("unknown probe")
    exit(2)
  }
  group.wait()
  let summary: [String: Any] = [
    "scenario": "threads", "probe": probe, "iterations": iterations,
    "decisions": counters.decisions, "telemetries": counters.telemetries,
    "note": "Run under `swift build --sanitize=thread`; TSan reports go to stderr and exit code 66.",
  ]
  try writeJSON(summary, to: "\(out)/threads-\(probe).json")
  print(String(decoding: try JSONSerialization.data(withJSONObject: summary, options: [.prettyPrinted, .sortedKeys]), as: UTF8.self))
}

// MARK: - Dispatch

guard let command = args.first else {
  print("usage: ReviewHarness fuzz|scale|traps|threads|child …")
  exit(2)
}

do {
  switch command {
  case "fuzz": try runFuzz()
  case "scale": try runScale()
  case "traps": try runTraps()
  case "threads": try runThreads()
  case "child":
    guard args.count >= 2 else { exit(2) }
    switch args[1] {
    case "fuzz":
      try childFuzz(
        seed: UInt64(intFlag("--seed", 1)),
        mode: InputMode(rawValue: flag("--mode") ?? "realistic") ?? .realistic,
        frames: intFlag("--frames", 1_000),
        allowDuplicateNames: args.contains("--allow-duplicate-names")
      )
    case "replay-frame":
      try childReplayFrame(
        seed: UInt64(intFlag("--seed", 1)),
        mode: InputMode(rawValue: flag("--mode") ?? "realistic") ?? .realistic,
        index: intFlag("--index", 0),
        allowDuplicateNames: args.contains("--allow-duplicate-names")
      )
    case "trap":
      guard args.count >= 4 else { exit(2) }
      childTrap(component: args[2], caseName: args[3])
    default:
      exit(2)
    }
  default:
    print("unknown command \(command)")
    exit(2)
  }
} catch {
  FileHandle.standardError.write(Data("harness error: \(error)\n".utf8))
  exit(1)
}
