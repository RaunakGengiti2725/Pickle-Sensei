// Scenario 7 — five extract() calls past the readable edge must not
// serialize into 5 × 10 s.
//
// SessionCaptureCoordinator.swift:216-223 hops every extract onto
// `extractionQueue`, a SERIAL DispatchQueue (line 127), and 281-321
// (`awaitCoverageAndExport`) blocks that queue with `Thread.sleep` polls for
// up to `coverageTimeoutMs` (10 000 ms, line 63) when the window is not yet
// readable. Five requests whose windows can never be covered therefore
// complete at ~10 s, ~20 s, ~30 s, ~40 s, ~50 s. `sessionBaseMs` and
// `recordingURL` are private and set only by a live camera, so the literal
// scenario is DEVICE PLANE only; the serial-queue arithmetic itself is
// modelled with production constants in ../linux-proxy (runs on Linux).
import AVFoundation
import Foundation
import XCTest

@testable import PickleCameraEngineUnderTest

final class S7SerializedCoverageTimeoutTests: XCTestCase {
  /// Production values (SessionCaptureCoordinator.swift:63, 55). The bound
  /// allows one full coverage timeout plus generous scheduling slack.
  private let coverageTimeoutMs = 10_000.0
  private let oneTimeoutBoundMs = 15_000.0

  /// DEVICE PLANE (skips on the Simulator). Starts a real session, waits for
  /// the first measured frame (onPoseFrame fires only after `sessionBaseMs`
  /// is set) plus a couple of movie fragments, then fires 5 extracts within
  /// 50 ms whose event windows lie an hour past the readable edge. Every call
  /// must fail with windowNotCovered and ALL FIVE must be answered within one
  /// coverage timeout. Expected RED on 4d812e1a: completions land at
  /// ≈10/20/30/40/50 s.
  func testFiveExtractsPastReadableEdgeAreBoundedByOneCoverageTimeout() async throws {
    try CameraPlane.skipUnlessCameraAvailable()
    let coordinator = SessionCaptureCoordinator()
    defer { coordinator.stop() }

    let firstFrame = expectation(description: "first measured frame")
    firstFrame.assertForOverFulfill = false
    coordinator.onPoseFrame = { _ in firstFrame.fulfill() }
    try await coordinator.start()
    let started = await XCTWaiter().fulfillment(of: [firstFrame], timeout: 10)
    coordinator.onPoseFrame = nil
    guard started == .completed else {
      throw XCTSkip("the session camera produced no frames within 10 s on this device")
    }
    try await Task.sleep(nanoseconds: 2_500_000_000)  // ≥ 2 fragment boundaries readable

    let calls = 5
    let lock = NSLock()
    var completionOffsetsMs: [Int: Double] = [:]
    var errors: [Int: String] = [:]
    let allDone = expectation(description: "all extracts answered")
    allDone.expectedFulfillmentCount = calls
    let t0 = attackNowMs()
    for i in 0..<calls {
      let start = 3_600_000 + i * 5_000  // one hour past anything readable
      coordinator.extract(
        eventStartMs: start, eventEndMs: start + 800, peakMs: start + 400, confidence: 0.8,
        detectionModelVersion: "attack-3"
      ) { result in
        let offset = attackNowMs() - t0
        lock.lock()
        completionOffsetsMs[i] = offset
        if case .failure(let error) = result { errors[i] = "\(error)" } else { errors[i] = "success" }
        lock.unlock()
        allDone.fulfill()
      }
    }
    let issueSpanMs = attackNowMs() - t0
    XCTAssertLessThan(issueSpanMs, 50, "precondition: the five calls were issued within 50 ms")

    let outcome = await XCTWaiter().fulfillment(of: [allDone], timeout: 75)
    let totalMs = attackNowMs() - t0
    lock.lock()
    let offsets = (0..<calls).map { completionOffsetsMs[$0] ?? .nan }
    let errorList = (0..<calls).map { errors[$0] ?? "unanswered" }
    lock.unlock()
    let evidence = "completion offsets ms=\(offsets.map { $0.isNaN ? -1 : Int($0) }) errors=\(errorList)"

    XCTAssertEqual(outcome, .completed, "some extracts were still pending after 75 s — \(evidence)")
    for (i, error) in errorList.enumerated() {
      XCTAssertTrue(error.contains("windowNotCovered"), "call \(i) must report windowNotCovered, got \(error)")
    }
    XCTAssertLessThan(
      totalMs, oneTimeoutBoundMs,
      "5 extracts past the readable edge took \(Int(totalMs)) ms — serialized coverage waits "
        + "(≈\(calls)×\(Int(coverageTimeoutMs)) ms) instead of one shared timeout; \(evidence)"
    )
  }

  /// DEVICE PLANE. Cancellation mid-flight: stop() while extracts are queued
  /// behind a coverage wait. The queued ones must not each burn a full
  /// timeout after the session is gone (the loop re-reads `stopped` only to
  /// choose the error once a first frame is known — SessionCaptureCoordinator.swift:290-300).
  /// Expected RED on 4d812e1a for the same serialization reason.
  func testStopWhileExtractsAreQueuedReleasesThemPromptly() async throws {
    try CameraPlane.skipUnlessCameraAvailable()
    let coordinator = SessionCaptureCoordinator()

    let firstFrame = expectation(description: "first measured frame")
    firstFrame.assertForOverFulfill = false
    coordinator.onPoseFrame = { _ in firstFrame.fulfill() }
    try await coordinator.start()
    let started = await XCTWaiter().fulfillment(of: [firstFrame], timeout: 10)
    coordinator.onPoseFrame = nil
    guard started == .completed else {
      coordinator.stop()
      throw XCTSkip("the session camera produced no frames within 10 s on this device")
    }
    try await Task.sleep(nanoseconds: 2_500_000_000)

    let calls = 3
    let allDone = expectation(description: "queued extracts answered")
    allDone.expectedFulfillmentCount = calls
    let t0 = attackNowMs()
    for i in 0..<calls {
      let start = 7_200_000 + i * 5_000
      coordinator.extract(
        eventStartMs: start, eventEndMs: start + 800, peakMs: nil, confidence: 0.8,
        detectionModelVersion: "attack-3"
      ) { _ in allDone.fulfill() }
    }
    try await Task.sleep(nanoseconds: 500_000_000)
    coordinator.stop()
    let stoppedAtMs = attackNowMs() - t0

    let outcome = await XCTWaiter().fulfillment(of: [allDone], timeout: 45)
    let totalMs = attackNowMs() - t0
    XCTAssertEqual(outcome, .completed, "queued extracts never answered after stop()")
    XCTAssertLessThan(
      totalMs, stoppedAtMs + oneTimeoutBoundMs,
      "after stop() at \(Int(stoppedAtMs)) ms the queued extracts still took \(Int(totalMs)) ms in total"
    )
  }
}
