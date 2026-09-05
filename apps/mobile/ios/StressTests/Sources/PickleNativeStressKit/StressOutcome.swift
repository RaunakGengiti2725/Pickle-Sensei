import Foundation

/// One replayable stress iteration's verdict. `held` means every invariant the
/// scenario asserts survived; `violated` carries the first broken invariant.
/// A process trap (Swift runtime `fatalError`/overflow/precondition) never
/// produces an outcome — the driver script records the seed as `crashed`
/// from the `started` marker it wrote before running.
public struct StressOutcome: Codable, Equatable {
  public enum Status: String, Codable {
    case held
    case violated
  }

  public let scenario: String
  public let seed: UInt64
  public let status: Status
  public let detail: String?
  /// Frames/operations actually pushed through production code.
  public let operations: Int
  public let durationMs: Int
  public let metrics: [String: Double]

  public var held: Bool { status == .held }
}

/// Collects invariant checks for one iteration; the first failure wins so the
/// replay points at exactly one broken statement.
public struct InvariantLog {
  public private(set) var firstViolation: String?
  public private(set) var checks = 0
  public var operations = 0
  public var metrics: [String: Double] = [:]

  public init() {}

  public mutating func expect(_ condition: Bool, _ message: @autoclosure () -> String) {
    checks += 1
    guard firstViolation == nil, !condition else { return }
    firstViolation = message()
  }

  public mutating func fail(_ message: String) {
    checks += 1
    if firstViolation == nil { firstViolation = message }
  }

  public func outcome(scenario: String, seed: UInt64, startedAt: Date) -> StressOutcome {
    StressOutcome(
      scenario: scenario,
      seed: seed,
      status: firstViolation == nil ? .held : .violated,
      detail: firstViolation,
      operations: operations,
      durationMs: Int(Date().timeIntervalSince(startedAt) * 1000),
      metrics: metrics
    )
  }
}

public enum ProcessMemory {
  /// Resident set size in bytes, or nil when the platform offers no cheap
  /// reading. Linux: /proc/self/statm; Darwin: mach task_info.
  public static func residentBytes() -> Int? {
    #if canImport(Darwin)
    var info = mach_task_basic_info()
    var count = mach_msg_type_number_t(MemoryLayout<mach_task_basic_info>.size / MemoryLayout<natural_t>.size)
    let result = withUnsafeMutablePointer(to: &info) { pointer in
      pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { raw in
        task_info(mach_task_self_, task_flavor_t(MACH_TASK_BASIC_INFO), raw, &count)
      }
    }
    return result == KERN_SUCCESS ? Int(info.resident_size) : nil
    #else
    guard let text = try? String(contentsOfFile: "/proc/self/statm", encoding: .utf8) else { return nil }
    let fields = text.split(separator: " ")
    guard fields.count > 1, let residentPages = Int(fields[1]) else { return nil }
    return residentPages * Int(sysconf(Int32(_SC_PAGESIZE)))
    #endif
  }
}
