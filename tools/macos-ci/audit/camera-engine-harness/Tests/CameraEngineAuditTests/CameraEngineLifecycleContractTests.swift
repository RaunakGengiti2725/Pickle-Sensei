import AVFoundation
import XCTest
@testable import CameraEngineAudit

/// Lifecycle contracts of `CameraEngine` that hold WITHOUT a camera and
/// WITHOUT touching TCC (no `requestPermissionAndConfigure()` — the xctest
/// host has no NSCameraUsageDescription, and the simulator has no capture
/// device anyway). Every expectation below is asserted against the engine's
/// documented behaviour at the cited line of CameraEngine.swift.
///
/// Plane: iOS Simulator via xcodebuild (see Package.swift). Not runnable on
/// Linux; the audit that added this file did not execute it.
final class CameraEngineLifecycleContractTests: XCTestCase {
  private func scratchURL() -> URL {
    FileManager.default.temporaryDirectory
      .appendingPathComponent("camera-engine-audit-\(UUID().uuidString.lowercased()).mov")
  }

  // CameraEngine.swift:309-318 — start() on an unconfigured engine must emit
  // exactly one .failed with the documented message and never .starting/.running.
  func testStartBeforeConfigureEmitsSingleFailedEvent() {
    let engine = CameraEngine()
    let done = expectation(description: "session event")
    var events: [CameraEngine.SessionEvent] = []
    engine.onSessionEvent = { event in
      events.append(event)
      done.fulfill()
    }
    engine.start()
    wait(for: [done], timeout: 5)
    XCTAssertEqual(events.count, 1)
    guard case .failed(let message)? = events.first else {
      return XCTFail("expected .failed, got \(events)")
    }
    XCTAssertEqual(message, "The camera session is not configured.")
  }

  // CameraEngine.swift:527-531 — recording before the session runs must be
  // reported as EngineError.sessionNotRunning through onRecordingFinished
  // and must not create the destination file.
  func testStartContinuousRecordingBeforeRunningReportsSessionNotRunning() {
    let engine = CameraEngine()
    let url = scratchURL()
    let done = expectation(description: "recording result")
    var received: Result<CameraEngine.RecordingArtifact, Error>?
    engine.onRecordingFinished = { result in
      received = result
      done.fulfill()
    }
    engine.startContinuousRecording(to: url)
    wait(for: [done], timeout: 5)
    guard case .failure(let error)? = received else {
      return XCTFail("expected failure, got \(String(describing: received))")
    }
    guard case CameraEngine.EngineError.sessionNotRunning = error else {
      return XCTFail("expected sessionNotRunning, got \(error)")
    }
    XCTAssertEqual(error.localizedDescription, "The camera session is not running.")
    XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
    XCTAssertNil(engine.currentRecordingFirstFrameTimestampMs)
    XCTAssertNil(engine.currentRecordingLastFrameTimestampMs)
  }

  // CameraEngine.swift:529-546 — the isRunning/isRecording guards precede the
  // destination cleanup, so a rejected start must leave a caller's file alone.
  func testStartContinuousRecordingBeforeRunningLeavesExistingFileUntouched() throws {
    let engine = CameraEngine()
    let url = scratchURL()
    try Data("sentinel".utf8).write(to: url)
    defer { try? FileManager.default.removeItem(at: url) }
    let done = expectation(description: "recording result")
    engine.onRecordingFinished = { _ in done.fulfill() }
    engine.startContinuousRecording(to: url)
    wait(for: [done], timeout: 5)
    XCTAssertEqual(try String(contentsOf: url), "sentinel")
  }

  // CameraEngine.swift:321-331 — stop() on an idle engine emits .stopped and
  // leaves the recording timestamps cleared.
  func testStopOnIdleEngineEmitsStoppedAndClearsTimestamps() {
    let engine = CameraEngine()
    let done = expectation(description: "stopped")
    var events: [CameraEngine.SessionEvent] = []
    engine.onSessionEvent = { event in
      events.append(event)
      done.fulfill()
    }
    engine.stop()
    wait(for: [done], timeout: 5)
    XCTAssertEqual(events.count, 1)
    guard case .stopped? = events.first else { return XCTFail("expected .stopped, got \(events)") }
    XCTAssertNil(engine.currentRecordingFirstFrameTimestampMs)
    XCTAssertNil(engine.currentRecordingLastFrameTimestampMs)
  }

  // CameraEngine.swift:580-588 — discardActiveRecording is a no-op when
  // nothing records: no callback, no event, and a following
  // startContinuousRecording still reports its real precondition failure
  // (nothing was swallowed).
  func testDiscardActiveRecordingIsNoOpWhenIdle() {
    let engine = CameraEngine()
    let noEvent = expectation(description: "no session event")
    noEvent.isInverted = true
    engine.onSessionEvent = { _ in noEvent.fulfill() }
    var results: [Result<CameraEngine.RecordingArtifact, Error>] = []
    let recordingResult = expectation(description: "recording result")
    engine.onRecordingFinished = { result in
      results.append(result)
      recordingResult.fulfill()
    }
    engine.discardActiveRecording()
    engine.stopContinuousRecording()
    engine.startContinuousRecording(to: scratchURL())
    wait(for: [noEvent, recordingResult], timeout: 2)
    XCTAssertEqual(results.count, 1)
    guard case .failure(let error)? = results.first,
          case CameraEngine.EngineError.sessionNotRunning = error
    else { return XCTFail("expected sessionNotRunning, got \(results)") }
  }

  // CameraEngine.swift:417-423,454-455 — switchCamera on an unconfigured
  // engine must not emit a session event; it still reports the neutral zoom
  // state for the requested side because emitZoomState() runs unconditionally.
  func testSwitchCameraBeforeConfigureEmitsNoSessionEventButReportsZoomState() {
    let engine = CameraEngine()
    let noEvent = expectation(description: "no session event")
    noEvent.isInverted = true
    engine.onSessionEvent = { _ in noEvent.fulfill() }
    let zoom = expectation(description: "zoom state")
    var state: CameraEngine.ZoomState?
    engine.onZoomStateChanged = { received in
      state = received
      zoom.fulfill()
    }
    engine.switchCamera(to: .front)
    wait(for: [noEvent, zoom], timeout: 2)
    XCTAssertEqual(state?.position, .back, "an unconfigured engine cannot have switched")
    XCTAssertEqual(state?.minDisplayZoom, 1)
    XCTAssertEqual(state?.maxDisplayZoom, 1)
    XCTAssertEqual(state?.displayZoom, 1)
    XCTAssertEqual(state?.centerStageSupported, false)
    XCTAssertEqual(state?.centerStageEnabled, false)
  }

  // CameraEngine.swift:346-356,379-381 — readZoomState with no active device
  // returns the neutral 1×/1×/1× state.
  func testReadZoomStateWithoutDeviceIsNeutral() {
    let engine = CameraEngine()
    let done = expectation(description: "zoom state")
    var state: CameraEngine.ZoomState?
    engine.readZoomState { received in
      state = received
      done.fulfill()
    }
    wait(for: [done], timeout: 5)
    XCTAssertEqual(state?.position, .back)
    XCTAssertEqual(state?.minDisplayZoom, 1)
    XCTAssertEqual(state?.maxDisplayZoom, 1)
    XCTAssertEqual(state?.displayZoom, 1)
    XCTAssertEqual(state?.centerStageSupported, false)
    XCTAssertEqual(state?.centerStageEnabled, false)
  }

  // CameraEngine.swift:386-393 — setDisplayZoom without a device is ignored
  // (no zoom-state emission, no crash).
  func testSetDisplayZoomWithoutDeviceIsIgnored() {
    let engine = CameraEngine()
    let noEmit = expectation(description: "no zoom emission")
    noEmit.isInverted = true
    engine.onZoomStateChanged = { _ in noEmit.fulfill() }
    engine.setDisplayZoom(2, animated: false)
    wait(for: [noEmit], timeout: 1)
  }

  // CameraEngine.swift:53-63 — Config defaults are the guided-capture policy.
  func testConfigDefaults() {
    let config = CameraEngine.Config()
    XCTAssertEqual(config.preset, .hd1280x720)
    XCTAssertEqual(config.targetFps, 60)
    XCTAssertEqual(config.maximumObservationSeconds, 60)
    XCTAssertNil(config.movieFragmentSeconds)
  }

  // CameraEngine.swift:18-29 — user-facing error copy.
  func testEngineErrorDescriptions() {
    XCTAssertEqual(
      CameraEngine.EngineError.permissionDenied.errorDescription,
      "Camera access is required for guided capture."
    )
    XCTAssertEqual(CameraEngine.EngineError.configurationFailed("x").errorDescription, "x")
    XCTAssertEqual(CameraEngine.EngineError.recordingFailed("y").errorDescription, "y")
    XCTAssertEqual(
      CameraEngine.EngineError.sessionNotRunning.errorDescription,
      "The camera session is not running."
    )
    XCTAssertEqual(
      CameraEngine.EngineError.recordingAlreadyActive.errorDescription,
      "A camera recording is already active."
    )
  }

  // CameraEngine.swift:130-132,610-637 — an engine that was never configured
  // installed no observers; deallocating it must not crash on removeObservers().
  func testUnconfiguredEngineDeallocatesCleanly() {
    var engine: CameraEngine? = CameraEngine()
    weak var weakEngine = engine
    engine?.stop()
    let drained = expectation(description: "session queue drained")
    engine?.readZoomState { _ in drained.fulfill() }
    wait(for: [drained], timeout: 5)
    engine = nil
    XCTAssertNil(weakEngine, "no retain cycle keeps an idle engine alive")
  }
}
