import Foundation

/// SplitMix64 — deterministic, allocation-free, replayable from a single seed.
public struct SeededRNG: RandomNumberGenerator {
  public private(set) var state: UInt64

  public init(seed: UInt64) {
    state = seed
  }

  public mutating func next() -> UInt64 {
    state &+= 0x9E37_79B9_7F4A_7C15
    var z = state
    z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
    z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
    return z ^ (z >> 31)
  }

  public mutating func double() -> Double {
    Double(next() >> 11) / Double(1 << 53)
  }

  public mutating func double(in range: ClosedRange<Double>) -> Double {
    range.lowerBound + (range.upperBound - range.lowerBound) * double()
  }

  public mutating func int(in range: ClosedRange<Int>) -> Int {
    Int.random(in: range, using: &self)
  }

  public mutating func bool(probability: Double = 0.5) -> Bool {
    double() < probability
  }
}

/// Campaign sizing. `STRESS_ITER` scales every seeded loop (default is small so
/// the suite stays fast). `STRESS_SEED=<seed>` replays exactly that one
/// iteration (the seed printed in a failure message / results row);
/// `STRESS_BASE_SEED` re-bases the whole derived sequence instead.
public enum StressCampaign {
  public static let defaultIterations = 3
  public static let defaultBaseSeed: UInt64 = 0x5EED_0000_0001

  public static var iterations: Int {
    guard let raw = ProcessInfo.processInfo.environment["STRESS_ITER"],
          let value = Int(raw), value > 0
    else { return defaultIterations }
    return value
  }

  public static var baseSeed: UInt64 {
    guard let raw = ProcessInfo.processInfo.environment["STRESS_BASE_SEED"],
          let value = UInt64(raw)
    else { return defaultBaseSeed }
    return value
  }

  /// The single seed to replay, when `STRESS_SEED` is set.
  public static var replaySeed: UInt64? {
    guard let raw = ProcessInfo.processInfo.environment["STRESS_SEED"] else { return nil }
    return UInt64(raw)
  }

  /// Seeds are derived from the base seed so iteration k is stable across
  /// runs and independent of how many iterations precede it. A replay seed
  /// short-circuits the sequence to that one value.
  public static func seeds(count: Int = iterations) -> [UInt64] {
    if let replay = replaySeed { return [replay] }
    var rng = SeededRNG(seed: baseSeed)
    return (0..<count).map { _ in rng.next() | 1 }
  }
}

/// Seed → outcome table. Every test appends rows and flushes a JSON file to
/// `STRESS_RESULTS_DIR` (default: <tmp>/pickle-stress) so a run leaves an
/// artifact even when everything holds.
public final class StressResultTable {
  public struct Row: Codable {
    public let suite: String
    public let test: String
    public let seed: String
    public let outcome: String
    public let detail: String
  }

  private let lock = NSLock()
  private var rows: [Row] = []
  private let suite: String

  public init(suite: String) {
    self.suite = suite
  }

  public func record(test: String, seed: UInt64?, outcome: String, detail: String) {
    lock.lock()
    rows.append(Row(
      suite: suite,
      test: test,
      seed: seed.map { String($0) } ?? "-",
      outcome: outcome,
      detail: detail
    ))
    lock.unlock()
  }

  public var snapshot: [Row] {
    lock.lock()
    defer { lock.unlock() }
    return rows
  }

  public var failedSeeds: [String] {
    snapshot.filter { $0.outcome != "HELD" && $0.outcome != "SKIPPED" }.map(\.seed)
  }

  @discardableResult
  public func flush() -> URL? {
    let environment = ProcessInfo.processInfo.environment
    let directory = environment["STRESS_RESULTS_DIR"].map { URL(fileURLWithPath: $0) }
      ?? URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("pickle-stress")
    do {
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      let url = directory.appendingPathComponent("\(suite).json")
      let encoder = JSONEncoder()
      encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
      let payload = try encoder.encode([
        "suite": AnyEncodable(suite),
        "iterations": AnyEncodable(StressCampaign.iterations),
        "baseSeed": AnyEncodable(String(StressCampaign.baseSeed)),
        "replaySeed": AnyEncodable(StressCampaign.replaySeed.map(String.init)),
        "rows": AnyEncodable(snapshot),
      ])
      try payload.write(to: url, options: .atomic)
      return url
    } catch {
      return nil
    }
  }
}

struct AnyEncodable: Encodable {
  private let encodeClosure: (Encoder) throws -> Void

  init<T: Encodable>(_ value: T) {
    encodeClosure = { encoder in try value.encode(to: encoder) }
  }

  func encode(to encoder: Encoder) throws {
    try encodeClosure(encoder)
  }
}


/// Synthetic pose frames in the PickleVisionCore wire shape (normalized
/// top-left coordinates, 13 joints). Kept free of any PickleVisionCore import
/// so this support module compiles on its own.
public enum SyntheticPose {
  public static let jointNames = [
    "head",
    "left_shoulder", "right_shoulder",
    "left_elbow", "right_elbow",
    "left_wrist", "right_wrist",
    "left_hip", "right_hip",
    "left_knee", "right_knee",
    "left_ankle", "right_ankle",
  ]

  public struct Landmark {
    public let name: String
    public let x: Double
    public let y: Double
    public let visibility: Double
  }

  /// Upright standing figure centred at (cx, cy) with body height `scale`
  /// (normalized). `armSwing` in [-1, 1] moves the right wrist horizontally so
  /// two consecutive frames with different swing values produce wrist motion.
  public static func person(
    centerX cx: Double,
    centerY cy: Double,
    scale: Double,
    visibility: Double,
    armSwing: Double = 0
  ) -> [Landmark] {
    let half = scale / 2
    let shoulderY = cy - half * 0.6
    let hipY = cy
    let kneeY = cy + half * 0.5
    let ankleY = cy + half * 0.95
    let shoulderHalf = scale * 0.18
    let hipHalf = scale * 0.12
    func mark(_ name: String, _ x: Double, _ y: Double) -> Landmark {
      Landmark(name: name, x: clamp(x), y: clamp(y), visibility: visibility)
    }
    return [
      mark("head", cx, cy - half * 0.9),
      mark("left_shoulder", cx - shoulderHalf, shoulderY),
      mark("right_shoulder", cx + shoulderHalf, shoulderY),
      mark("left_elbow", cx - shoulderHalf * 1.3, shoulderY + scale * 0.2),
      mark("right_elbow", cx + shoulderHalf * 1.3 + armSwing * scale * 0.1, shoulderY + scale * 0.2),
      mark("left_wrist", cx - shoulderHalf * 1.4, shoulderY + scale * 0.4),
      mark("right_wrist", cx + shoulderHalf * 1.4 + armSwing * scale * 0.35, shoulderY + scale * 0.3),
      mark("left_hip", cx - hipHalf, hipY),
      mark("right_hip", cx + hipHalf, hipY),
      mark("left_knee", cx - hipHalf, kneeY),
      mark("right_knee", cx + hipHalf, kneeY),
      mark("left_ankle", cx - hipHalf, ankleY),
      mark("right_ankle", cx + hipHalf, ankleY),
    ]
  }

  private static func clamp(_ value: Double) -> Double {
    min(1, max(0, value))
  }
}
