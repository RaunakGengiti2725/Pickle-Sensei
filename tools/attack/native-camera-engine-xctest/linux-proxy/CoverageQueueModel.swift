// LINUX MODEL PROXY for scenario 7 — NOT Apple runtime truth.
//
// Reproduces the scheduling skeleton of
// SessionCaptureCoordinator.extract → extractionQueue.async →
// awaitCoverageAndExport (native/camera-engine/Sources/SessionCaptureCoordinator.swift
// lines 216-223 and 281-321) with Foundation + Dispatch only:
//   • one SERIAL DispatchQueue per coordinator,
//   • a polling loop that `Thread.sleep`s `pollMs` until `timeoutMs` elapses
//     when coverage never arrives,
//   • N requests submitted within a few ms.
// The production constants (10 000 ms / 250 ms) are scaled down by `scale`
// so the model runs in seconds; the SHAPE of the result (completions at
// 1×, 2×, …, N× timeout) is what is being demonstrated. AVFoundation, the
// readable-edge computation and the export step are replaced by "never
// covered" — the worst case the scenario asks about.
//
// usage: CoverageQueueModel <requests> <timeoutMs> <pollMs> <scale> <mode>
//   mode = serial      (production shape: one serial queue)
//        | concurrent  (reference: a concurrent queue, same loop)
import Dispatch
import Foundation

let args = CommandLine.arguments.dropFirst().map { $0 }
guard args.count == 5,
      let requests = Int(args[0]), let timeoutMs = Int(args[1]), let pollMs = Int(args[2]),
      let scale = Double(args[3]), ["serial", "concurrent"].contains(args[4])
else {
  FileHandle.standardError.write(Data("usage: CoverageQueueModel <requests> <timeoutMs> <pollMs> <scale> serial|concurrent\n".utf8))
  exit(64)
}
let mode = args[4]
let scaledTimeout = Double(timeoutMs) / 1_000 / scale
let scaledPoll = Double(pollMs) / 1_000 / scale

let queue = mode == "serial"
  ? DispatchQueue(label: "pickle.session.extract.model", qos: .userInitiated)
  : DispatchQueue(label: "pickle.session.extract.model", qos: .userInitiated, attributes: .concurrent)

/// Mirrors awaitCoverageAndExport's wait loop when the window is never
/// covered: poll until the deadline, then fail with windowNotCovered.
func awaitCoverageNeverCovered() -> String {
  let deadline = Date().addingTimeInterval(scaledTimeout)
  var polls = 0
  while Date() < deadline {
    polls += 1
    Thread.sleep(forTimeInterval: scaledPoll)
  }
  return "windowNotCovered(after \(polls) polls)"
}

let group = DispatchGroup()
let lock = NSLock()
var completions: [(index: Int, offsetMs: Double, error: String)] = []
let t0 = DispatchTime.now().uptimeNanoseconds
func nowMs() -> Double { Double(DispatchTime.now().uptimeNanoseconds - t0) / 1_000_000 }

for i in 0..<requests {
  group.enter()
  queue.async {
    let error = awaitCoverageNeverCovered()
    lock.lock()
    completions.append((i, nowMs(), error))
    lock.unlock()
    group.leave()
  }
}
let issueSpanMs = nowMs()
group.wait()
let totalMs = nowMs()

let offsets = completions.sorted { $0.index < $1.index }.map { $0.offsetMs }
let unscaledOffsets = offsets.map { $0 * scale }
let unscaledTotal = totalMs * scale
let oneTimeout = Double(timeoutMs)
let serializedShape = unscaledOffsets.enumerated().allSatisfy { index, offset in
  offset >= oneTimeout * Double(index + 1) * 0.9
}
let boundedByOneTimeout = unscaledTotal < oneTimeout * 1.5

let report: [String: Any] = [
  "tool": "camera-engine-attack-3/coverage-queue-model",
  "truth": "LINUX MODEL PROXY — Foundation/Dispatch skeleton of SessionCaptureCoordinator.extract; not Apple runtime",
  "mode": mode,
  "requests": requests,
  "issue_span_ms": Int(issueSpanMs.rounded()),
  "production_constants": ["coverageTimeoutMs": timeoutMs, "coveragePollMs": pollMs],
  "scale": scale,
  "measured_offsets_ms_scaled": offsets.map { Int($0.rounded()) },
  "completion_offsets_ms_unscaled": unscaledOffsets.map { Int($0.rounded()) },
  "total_ms_unscaled": Int(unscaledTotal.rounded()),
  "one_timeout_bound_ms": Int(oneTimeout * 1.5),
  "serialized_shape_detected": serializedShape,
  "bounded_by_one_timeout": boundedByOneTimeout,
]
let json = try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
print(String(decoding: json, as: UTF8.self))
