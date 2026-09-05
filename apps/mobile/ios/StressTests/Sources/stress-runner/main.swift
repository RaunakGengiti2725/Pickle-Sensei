import Foundation
import PickleNativeStressKit

// stress-runner — replayable seeded campaigns over the native bridge core.
//
//   stress-runner list
//   stress-runner run --scenario <name|all> [--seed-start N] [--count K] [--out results.jsonl]
//   stress-runner replay --scenario <name> --seed N
//   stress-runner repro --name <MinimalRepro name|list>
//
// `run` appends one JSON line per iteration: `{"event":"started",...}` BEFORE the
// iteration executes and the `StressOutcome` after it. A process trap therefore
// leaves a dangling `started` marker that scripts/campaign.py turns into a
// `crashed` row with the exact seed. An explicit --count is the exact number of
// seeds to run; without it STRESS_ITER (default 25) is the campaign size and
// heavy scenarios run their 1/25th share of it.

struct CLIError: Error, CustomStringConvertible {
  let description: String
}

func parseArguments(_ arguments: [String]) throws -> (command: String, options: [String: String]) {
  guard let command = arguments.first else { throw CLIError(description: "missing command (list|run|replay|repro)") }
  var options: [String: String] = [:]
  var index = 1
  while index < arguments.count {
    let flag = arguments[index]
    guard flag.hasPrefix("--") else { throw CLIError(description: "unexpected argument \(flag)") }
    guard index + 1 < arguments.count else { throw CLIError(description: "\(flag) needs a value") }
    options[String(flag.dropFirst(2))] = arguments[index + 1]
    index += 2
  }
  return (command, options)
}

func scenarios(named name: String?) throws -> [StressScenario] {
  guard let name, name != "all" else { return StressScenario.allCases }
  guard let scenario = StressScenario(rawValue: name) else {
    throw CLIError(description: "unknown scenario \(name); known: \(StressScenario.allCases.map(\.rawValue).joined(separator: ", "))")
  }
  return [scenario]
}

final class LineSink {
  private let handle: FileHandle?
  private let encoder: JSONEncoder = {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    return encoder
  }()

  init(path: String?) throws {
    guard let path else {
      handle = nil
      return
    }
    let url = URL(fileURLWithPath: path)
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    if !FileManager.default.fileExists(atPath: path),
       !FileManager.default.createFile(atPath: path, contents: nil) {
      throw CLIError(description: "cannot create \(path)")
    }
    let handle = try FileHandle(forWritingTo: url)
    handle.seekToEndOfFile()
    self.handle = handle
  }

  func write<T: Encodable>(_ value: T) throws {
    var data = try encoder.encode(value)
    data.append(0x0A)
    if let handle {
      handle.write(data)
      try handle.synchronize()
    } else {
      FileHandle.standardOutput.write(data)
    }
  }
}

struct StartedMarker: Encodable {
  let event = "started"
  let scenario: String
  let seed: UInt64
}

struct OutcomeRow: Encodable {
  let event = "outcome"
  let scenario: String
  let seed: UInt64
  let status: String
  let detail: String?
  let operations: Int
  let durationMs: Int
  let metrics: [String: Double]

  init(_ outcome: StressOutcome) {
    scenario = outcome.scenario
    seed = outcome.seed
    status = outcome.status.rawValue
    detail = outcome.detail
    operations = outcome.operations
    durationMs = outcome.durationMs
    metrics = outcome.metrics
  }
}

do {
  let (command, options) = try parseArguments(Array(CommandLine.arguments.dropFirst()))
  switch command {
  case "list":
    for scenario in StressScenario.allCases {
      print("\(scenario.rawValue)\(scenario.expectsProcessTrap ? "  [expects-process-trap]" : "")\(scenario.heavy ? "  [heavy]" : "")")
    }
  case "run":
    let selected = try scenarios(named: options["scenario"])
    let seedStart = UInt64(options["seed-start"] ?? "1") ?? 1
    let explicitCount = Int(options["count"] ?? "")
    let sink = try LineSink(path: options["out"])
    var violated = 0
    for scenario in selected {
      let iterations = explicitCount ?? scenario.campaignIterations()
      for offset in 0 ..< UInt64(iterations) {
        let seed = seedStart &+ offset
        try sink.write(StartedMarker(scenario: scenario.rawValue, seed: seed))
        let outcome = scenario.run(seed: seed)
        if !outcome.held { violated += 1 }
        try sink.write(OutcomeRow(outcome))
      }
    }
    exit(violated == 0 ? 0 : 3)
  case "replay":
    guard let name = options["scenario"], let scenario = StressScenario(rawValue: name) else {
      throw CLIError(description: "replay needs --scenario <name>")
    }
    guard let seed = UInt64(options["seed"] ?? "") else { throw CLIError(description: "replay needs --seed N") }
    let outcome = scenario.run(seed: seed)
    try LineSink(path: nil).write(OutcomeRow(outcome))
    exit(outcome.held ? 0 : 3)
  case "repro":
    guard let name = options["name"] else { throw CLIError(description: "repro needs --name <\(MinimalRepro.allCases.map(\.rawValue).joined(separator: "|"))>") }
    if name == "list" {
      for repro in MinimalRepro.allCases { print("\(repro.rawValue)\(repro.trapsProcess ? "  [traps-process]" : "")") }
      exit(0)
    }
    guard let repro = MinimalRepro(rawValue: name) else { throw CLIError(description: "unknown repro \(name)") }
    let held = repro.invariantHeld()
    print("\(repro.rawValue): \(held ? "held" : "violated")")
    exit(held ? 0 : 3)
  default:
    throw CLIError(description: "unknown command \(command)")
  }
} catch {
  FileHandle.standardError.write("stress-runner: \(error)\n".data(using: .utf8)!)
  exit(2)
}
