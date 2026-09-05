import Foundation

/// SplitMix64: a tiny, portable, deterministic generator. Every stress
/// iteration derives all of its input from one `UInt64` seed so any outcome
/// can be replayed bit-for-bit with `stress-runner --scenario X --seed N`.
public struct StressRNG: RandomNumberGenerator {
  private var state: UInt64

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

  /// Uniform in [0, 1).
  public mutating func unit() -> Double {
    Double(next() >> 11) / Double(1 << 53)
  }

  public mutating func double(in range: ClosedRange<Double>) -> Double {
    range.lowerBound + unit() * (range.upperBound - range.lowerBound)
  }

  public mutating func int(in range: ClosedRange<Int>) -> Int {
    Int.random(in: range, using: &self)
  }

  public mutating func chance(_ probability: Double) -> Bool {
    unit() < probability
  }

  public mutating func pick<T>(_ options: [T]) -> T {
    options[int(in: 0 ... options.count - 1)]
  }

  /// Approximately normal via the sum of uniforms (deterministic, no
  /// transcendental functions whose rounding could differ across platforms).
  public mutating func gaussian(sigma: Double) -> Double {
    var sum = 0.0
    for _ in 0 ..< 12 { sum += unit() }
    return (sum - 6.0) * sigma
  }
}
