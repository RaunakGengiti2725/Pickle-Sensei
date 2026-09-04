// Scenario 4 — extract(...) error paths that must answer immediately.
//
// SessionCaptureCoordinator.swift:196-223: before the work is enqueued on
// `extractionQueue`, `extract` reads `stopped` / `sessionBaseMs` /
// `recordingURL` under `stateLock` and fails synchronously with
// `.alreadyStopped` (stopped), `.recordingNotStarted` (no base timestamp yet),
// or `.invalidBounds` (end <= start). None of those may touch the 10 s
// coverage poll at 281-321. No camera needed: a fresh coordinator never
// gets a frame on the Simulator, and `stop()` works without `start()`.
import Foundation
import XCTest

@testable import PickleCameraEngineUnderTest

final class S4ImmediateExtractErrorsTests: XCTestCase {
  private struct Outcome {
    let result: Result<[String: Any], Error>
    let elapsedMs: Double
    let onCallerThread: Bool
  }

  private func extract(
    _ coordinator: SessionCaptureCoordinator,
    start: Int = 1_000,
    end: Int = 2_000,
    file: StaticString = #filePath,
    line: UInt = #line
  ) -> Outcome? {
    let done = expectation(description: "extract completion")
    var captured: Outcome?
    let caller = Thread.current
    let t0 = attackNowMs()
    coordinator.extract(eventStartMs: start, eventEndMs: end, peakMs: nil, confidence: 0.9, detectionModelVersion: "attack-3") { result in
      captured = Outcome(result: result, elapsedMs: attackNowMs() - t0, onCallerThread: Thread.current === caller)
      done.fulfill()
    }
    wait(for: [done], timeout: 5)
    XCTAssertNotNil(captured, "extract never completed", file: file, line: line)
    return captured
  }

  private func assertCoordinatorError(
    _ outcome: Outcome?,
    matches predicate: (SessionCaptureCoordinator.CoordinatorError) -> Bool,
    named name: String,
    file: StaticString = #filePath,
    line: UInt = #line
  ) {
    guard let outcome else { return }
    guard case .failure(let error) = outcome.result else {
      return XCTFail("expected .\(name), got success", file: file, line: line)
    }
    guard let coordinatorError = error as? SessionCaptureCoordinator.CoordinatorError, predicate(coordinatorError) else {
      return XCTFail("expected .\(name), got \(error)", file: file, line: line)
    }
    XCTAssertLessThan(outcome.elapsedMs, 500, ".\(name) must not wait for the coverage timeout", file: file, line: line)
  }

  func testExtractAfterStopFailsImmediatelyWithAlreadyStopped() {
    let coordinator = SessionCaptureCoordinator()
    coordinator.stop()
    let outcome = extract(coordinator)
    assertCoordinatorError(outcome, matches: { if case .alreadyStopped = $0 { return true }; return false }, named: "alreadyStopped")
    XCTAssertEqual(outcome?.onCallerThread, true, "the guard answers synchronously on the caller's thread")
    XCTAssertEqual(outcome?.result.attackFailureDescription, "The session capture has already stopped.")
  }

  func testExtractOnFreshCoordinatorFailsImmediatelyWithRecordingNotStarted() {
    let coordinator = SessionCaptureCoordinator()
    let outcome = extract(coordinator)
    assertCoordinatorError(outcome, matches: { if case .recordingNotStarted = $0 { return true }; return false }, named: "recordingNotStarted")
    XCTAssertEqual(outcome?.onCallerThread, true)
    XCTAssertEqual(outcome?.result.attackFailureDescription, "The session recording has not produced any frames yet.")
    XCTAssertNotNil(SessionCaptureCoordinator.active(withId: coordinator.captureId), "a refused extract must not unregister the session")
  }

  /// Ordering of the guards: stopped beats not-started beats invalid bounds,
  /// and none of them waits. Bounds abuse (negative, equal, reversed, Int
  /// extremes) on a fresh coordinator still reports recordingNotStarted.
  func testGuardOrderingAndHostileBoundsNeverWait() {
    let fresh = SessionCaptureCoordinator()
    let hostileBounds: [(Int, Int)] = [(0, 0), (5, 5), (2_000, 1_000), (-10, -20), (Int.max, Int.min), (Int.min, Int.max)]
    for (start, end) in hostileBounds {
      let outcome = extract(fresh, start: start, end: end)
      assertCoordinatorError(outcome, matches: { if case .recordingNotStarted = $0 { return true }; return false }, named: "recordingNotStarted(\(start),\(end))")
    }

    let stopped = SessionCaptureCoordinator()
    stopped.stop()
    for (start, end) in hostileBounds {
      let outcome = extract(stopped, start: start, end: end)
      assertCoordinatorError(outcome, matches: { if case .alreadyStopped = $0 { return true }; return false }, named: "alreadyStopped(\(start),\(end))")
    }
  }

  /// 200 concurrent extracts from 8 threads against a stopped coordinator:
  /// every one answers with alreadyStopped, aggregate well under one coverage
  /// timeout (nothing reaches the serial extraction queue).
  func testRapidConcurrentExtractsOnStoppedCoordinatorAllAnswerImmediately() {
    let coordinator = SessionCaptureCoordinator()
    coordinator.stop()
    let total = 200
    let done = expectation(description: "all extracts answered")
    done.expectedFulfillmentCount = total
    let lock = NSLock()
    var failures = 0
    var wrongErrors: [String] = []
    let t0 = attackNowMs()
    DispatchQueue.concurrentPerform(iterations: 8) { lane in
      for i in 0..<(total / 8) {
        let start = lane * 1_000 + i
        coordinator.extract(eventStartMs: start, eventEndMs: start + 250, peakMs: start + 100, confidence: 0.5, detectionModelVersion: "attack-3") { result in
          lock.lock()
          if case .failure(let error) = result {
            if case .alreadyStopped = error as? SessionCaptureCoordinator.CoordinatorError { failures += 1 } else { wrongErrors.append("\(error)") }
          }
          lock.unlock()
          done.fulfill()
        }
      }
    }
    wait(for: [done], timeout: 10)
    let elapsedMs = attackNowMs() - t0
    XCTAssertEqual(failures, total)
    XCTAssertTrue(wrongErrors.isEmpty, "unexpected errors: \(wrongErrors.prefix(3))")
    XCTAssertLessThan(elapsedMs, 2_000, "200 refused extracts must not serialize behind any coverage wait")
  }

  /// Stop racing extract: whichever wins, the answer is one of the two
  /// immediate errors — never a hang, never a success without frames.
  func testStopRacingExtractStaysImmediate() {
    var rng = SeededGenerator()
    for round in 0..<20 {
      let coordinator = SessionCaptureCoordinator()
      let done = expectation(description: "round \(round)")
      var elapsedMs = Double.infinity
      var errorName = "none"
      let t0 = attackNowMs()
      let stopFirst = Bool.random(using: &rng)
      let group = DispatchGroup()
      group.enter()
      DispatchQueue.global().async {
        if stopFirst { coordinator.stop() }
        coordinator.extract(eventStartMs: 100, eventEndMs: 900, peakMs: nil, confidence: 1, detectionModelVersion: "attack-3") { result in
          elapsedMs = attackNowMs() - t0
          if case .failure(let error) = result, let coordinatorError = error as? SessionCaptureCoordinator.CoordinatorError {
            switch coordinatorError {
            case .alreadyStopped: errorName = "alreadyStopped"
            case .recordingNotStarted: errorName = "recordingNotStarted"
            default: errorName = "\(coordinatorError)"
            }
          } else {
            errorName = "success-or-foreign"
          }
          done.fulfill()
        }
        if !stopFirst { coordinator.stop() }
        group.leave()
      }
      group.wait()
      wait(for: [done], timeout: 5)
      XCTAssertTrue(["alreadyStopped", "recordingNotStarted"].contains(errorName), "round \(round) (stopFirst=\(stopFirst)): \(errorName)")
      XCTAssertLessThan(elapsedMs, 500, "round \(round) waited \(elapsedMs) ms")
      if stopFirst { XCTAssertEqual(errorName, "alreadyStopped") }
    }
  }
}

extension Result where Success == [String: Any], Failure == Error {
  var attackFailureDescription: String? {
    guard case .failure(let error) = self else { return nil }
    return error.localizedDescription
  }
}
