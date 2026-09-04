import Foundation
import XCTest

@testable import PickleVisionCore

// Shared support for the seeded stress campaigns (Stress*Tests.swift).
//
// Every campaign iteration is driven by ONE 64-bit seed; the seed alone
// reproduces the iteration. Environment knobs:
//   STRESS_ITER     iterations per campaign (default `StressCampaign.defaultIterations`)
//   STRESS_SEED     base seed; iteration i uses base + i (default 0x5EED_0001)
//   STRESS_RESULTS  when set, every iteration appends one JSON row
//                   {campaign, seed, outcome, detail} to this file (JSON lines)
//   STRESS_ONLY_SEED replay exactly one seed (ignores STRESS_ITER)

/// SplitMix64 — deterministic, platform-independent, replayable from a seed.
struct SeededRNG: RandomNumberGenerator {
  private var state: UInt64

  init(seed: UInt64) {
    state = seed
  }

  mutating func next() -> UInt64 {
    state &+= 0x9E37_79B9_7F4A_7C15
    var z = state
    z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
    z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
    return z ^ (z >> 31)
  }

  mutating func unit() -> Double {
    Double(next() >> 11) / Double(1 << 53)
  }

  mutating func double(in range: ClosedRange<Double>) -> Double {
    range.lowerBound + (range.upperBound - range.lowerBound) * unit()
  }

  mutating func int(in range: ClosedRange<Int>) -> Int {
    Int.random(in: range, using: &self)
  }

  mutating func chance(_ probability: Double) -> Bool {
    unit() < probability
  }

  mutating func pick<T>(_ items: [T]) -> T {
    items[int(in: 0 ... (items.count - 1))]
  }
}

enum StressCampaign {
  static let defaultIterations = 48
  static let defaultBaseSeed: UInt64 = 0x5EED_0001

  static var iterations: Int {
    guard let raw = ProcessInfo.processInfo.environment["STRESS_ITER"], let value = Int(raw), value > 0
    else { return defaultIterations }
    return value
  }

  static var baseSeed: UInt64 {
    guard let raw = ProcessInfo.processInfo.environment["STRESS_SEED"], let value = UInt64(raw)
    else { return defaultBaseSeed }
    return value
  }

  static var onlySeed: UInt64? {
    guard let raw = ProcessInfo.processInfo.environment["STRESS_ONLY_SEED"] else { return nil }
    return UInt64(raw)
  }

  /// Seeds for one campaign: `campaignIndex` offsets campaigns so two
  /// campaigns never share a seed stream while staying replayable.
  static func seeds(campaignIndex: UInt64) -> [UInt64] {
    if let only = onlySeed { return [only] }
    let start = baseSeed &+ (campaignIndex &* 1_000_003)
    return (0 ..< iterations).map { start &+ UInt64($0) }
  }

  /// Runs `body` for every seed, recording a held/broken row per seed. `body`
  /// returns a list of violated invariants (empty = held). Any thrown error
  /// or violation fails the test with the seed in the message so it can be
  /// replayed with STRESS_ONLY_SEED=<seed>.
  static func run(
    _ name: String,
    campaignIndex: UInt64,
    file: StaticString = #filePath,
    line: UInt = #line,
    _ body: (inout SeededRNG, UInt64) throws -> [String]
  ) {
    var failures = 0
    for seed in seeds(campaignIndex: campaignIndex) {
      var rng = SeededRNG(seed: seed)
      var violations: [String]
      do {
        violations = try body(&rng, seed)
      } catch {
        violations = ["threw \(error)"]
      }
      StressResults.record(campaign: name, seed: seed, violations: violations)
      if !violations.isEmpty {
        failures += 1
        XCTFail(
          "[\(name)] seed \(seed) BROKEN: \(violations.joined(separator: "; ")) "
            + "(replay: STRESS_ONLY_SEED=\(seed))",
          file: file,
          line: line
        )
      }
    }
    XCTAssertEqual(failures, 0, "[\(name)] \(failures) broken seed(s)", file: file, line: line)
  }
}

enum StressResults {
  private static let lock = NSLock()

  /// Appends one `seed → outcome` row. `violations` empty ⇒ "held", otherwise
  /// "broken" (an asserted invariant failed). Characterisation rows that are
  /// reported but never asserted pass an explicit `outcome` label instead.
  static func record(campaign: String, seed: UInt64, violations: [String], outcome: String? = nil) {
    guard let path = ProcessInfo.processInfo.environment["STRESS_RESULTS"], !path.isEmpty else { return }
    let row: [String: Any] = [
      "campaign": campaign,
      "seed": String(seed),
      "outcome": outcome ?? (violations.isEmpty ? "held" : "broken"),
      "detail": violations.joined(separator: "; "),
    ]
    guard let data = try? JSONSerialization.data(withJSONObject: row, options: [.sortedKeys]) else { return }
    lock.lock()
    defer { lock.unlock() }
    if !FileManager.default.fileExists(atPath: path) {
      _ = FileManager.default.createFile(atPath: path, contents: nil)
    }
    guard let handle = FileHandle(forWritingAtPath: path) else { return }
    defer { try? handle.close() }
    handle.seekToEndOfFile()
    handle.write(data)
    handle.write(Data("\n".utf8))
  }
}

// MARK: - Pose fixtures

/// A canonical full-body pose (normalized-image space, top-left origin) that
/// PoseReadinessEvaluator accepts as framed and TemporalStrokeDetector can
/// measure scale from (shoulder→ankle span 0.65).
enum PoseFixture {
  static let joints: [(name: String, x: Double, y: Double)] = [
    ("head", 0.50, 0.15),
    ("left_shoulder", 0.43, 0.25), ("right_shoulder", 0.57, 0.25),
    ("left_elbow", 0.39, 0.38), ("right_elbow", 0.61, 0.38),
    ("left_wrist", 0.36, 0.50), ("right_wrist", 0.64, 0.50),
    ("left_hip", 0.45, 0.52), ("right_hip", 0.55, 0.52),
    ("left_knee", 0.45, 0.70), ("right_knee", 0.55, 0.70),
    ("left_ankle", 0.44, 0.90), ("right_ankle", 0.56, 0.90),
  ]

  static let names: [String] = joints.map(\.name)

  /// Body scale the fixture yields (ankle-mid y − shoulder-mid y).
  static let bodyScale = 0.65

  static func frame(
    at timestampMs: Int,
    bodyOffsetX: Double = 0,
    bodyOffsetY: Double = 0,
    rightWristX: Double? = nil,
    rightWristY: Double? = nil,
    leftWristX: Double? = nil,
    visibility: Double = 0.95,
    confidence: Double = 0.95,
    removing: Set<String> = [],
    visibilityOverrides: [String: Double] = [:]
  ) -> PoseFrame {
    let landmarks = joints.compactMap { joint -> PoseLandmark? in
      guard !removing.contains(joint.name) else { return nil }
      var x = joint.x + bodyOffsetX
      var y = joint.y + bodyOffsetY
      if joint.name == "right_wrist" {
        if let rightWristX { x = rightWristX }
        if let rightWristY { y = rightWristY }
      }
      if joint.name == "left_wrist", let leftWristX { x = leftWristX }
      return PoseLandmark(
        name: joint.name,
        x: x,
        y: y,
        visibility: visibilityOverrides[joint.name] ?? visibility
      )
    }
    return PoseFrame(timestampMs: timestampMs, landmarks: landmarks, confidence: confidence)
  }

  /// A swing the default TemporalStrokeDetector config emits exactly one
  /// event for: `quietMs` of stillness (≥ minQuietBeforeMs 350), a forward
  /// wrist travel of `swingFrames` × `stepX` image units at `frameMs`
  /// cadence (≈ 2.3 body-heights/s with the defaults), then a settled tail.
  /// Frames start at `startMs`. Body (hips) never moves.
  static func swing(
    startMs: Int = 0,
    frameMs: Int = 33,
    quietMs: Int = 500,
    swingFrames: Int = 10,
    stepX: Double = 0.05,
    tailMs: Int = 700,
    bodyOffsetX: Double = 0
  ) -> [PoseFrame] {
    var frames: [PoseFrame] = []
    var t = startMs
    let restX = 0.30 + bodyOffsetX
    while t < startMs + quietMs {
      frames.append(frame(at: t, bodyOffsetX: bodyOffsetX, rightWristX: restX))
      t += frameMs
    }
    var x = restX
    for _ in 0 ..< swingFrames {
      x += stepX
      frames.append(frame(at: t, bodyOffsetX: bodyOffsetX, rightWristX: x))
      t += frameMs
    }
    let tailEnd = t + tailMs
    while t < tailEnd {
      frames.append(frame(at: t, bodyOffsetX: bodyOffsetX, rightWristX: x))
      t += frameMs
    }
    return frames
  }

  /// A frame whose every landmark is "corrupt" in one of several ways.
  /// `bounded` restricts the corruption to NaN and moderately out-of-range
  /// values (|v| ≤ 50); the default also draws ±inf and astronomically large
  /// finite coordinates (see StressFindingsReproTests.F2 for why that matters).
  static func corrupt(at timestampMs: Int, rng: inout SeededRNG, bounded: Bool = false) -> PoseFrame {
    let mode = rng.int(in: bounded ? 4 ... 5 : 0 ... 5)
    let landmarks = joints.map { joint -> PoseLandmark in
      let value: Double
      switch mode {
      case 0: value = .nan
      case 1: value = .infinity
      case 2: value = -.infinity
      case 3: value = rng.double(in: -1e300 ... 1e300)
      case 4: value = rng.double(in: -50 ... 50)
      default: value = rng.chance(0.5) ? .nan : rng.double(in: -50 ... 50)
      }
      return PoseLandmark(name: joint.name, x: value, y: value, visibility: rng.chance(0.3) ? .nan : 0.95)
    }
    return PoseFrame(
      timestampMs: timestampMs,
      landmarks: landmarks,
      confidence: rng.chance(0.2) ? .nan : 0.95
    )
  }

  /// A fully random frame: random landmark subset (possibly empty), random
  /// coordinates a little outside [0,1], random visibilities/confidence.
  /// Names are unique per frame.
  static func random(at timestampMs: Int, rng: inout SeededRNG) -> PoseFrame {
    var landmarks: [PoseLandmark] = []
    for joint in joints where rng.chance(0.85) {
      landmarks.append(
        PoseLandmark(
          name: joint.name,
          x: joint.x + rng.double(in: -0.6 ... 0.6),
          y: joint.y + rng.double(in: -0.6 ... 0.6),
          visibility: rng.double(in: 0 ... 1)
        )
      )
    }
    return PoseFrame(
      timestampMs: timestampMs,
      landmarks: landmarks,
      confidence: rng.double(in: 0 ... 1)
    )
  }
}

extension StrokeEvent {
  var stressSignature: String {
    "\(startMs)-\(endMs)-\(peakMotionMs.map(String.init) ?? "nil")-\(confidence)"
  }
}
