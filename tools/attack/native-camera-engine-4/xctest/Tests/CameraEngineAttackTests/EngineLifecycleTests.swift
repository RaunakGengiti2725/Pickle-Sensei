import AVFoundation
import Foundation
import XCTest

@testable import CameraEngineUnderTest

/// Extra attacks on `CameraEngine` lifecycle ordering that need no camera.
/// All `[sim]`; every expected string is the literal production copy.
final class EngineLifecycleTests: XCTestCase {
  func test_sim_startBeforeConfigure_emitsNotConfiguredFailure_only() {
    let engine = CameraEngine()
    let recorder = SessionEventRecorder()
    recorder.attach(to: engine)
    engine.start()
    XCTAssertTrue(AttackSupport.waitUntil(2) { !recorder.events.isEmpty })
    XCTAssertEqual(recorder.descriptions, ["failed(The camera session is not configured.)"])
  }

  func test_sim_stopBeforeStart_emitsStopped_andNoRecordingCallback() {
    let engine = CameraEngine()
    let events = SessionEventRecorder()
    let recording = RecordingRecorder()
    events.attach(to: engine)
    recording.attach(to: engine)
    engine.stop()
    XCTAssertTrue(AttackSupport.waitUntil(2) { !events.events.isEmpty })
    XCTAssertEqual(events.descriptions, ["stopped"])
    AttackSupport.waitUntil(0.3) { false }
    XCTAssertTrue(recording.outcomes.isEmpty)
    XCTAssertNil(engine.currentRecordingFirstFrameTimestampMs)
    XCTAssertNil(engine.currentRecordingLastFrameTimestampMs)
  }

  /// Rapid start/stop interleaving on an unconfigured engine: every start
  /// reports the not-configured failure and every stop reports stopped, in
  /// call order (single serial session queue).
  func test_sim_rapidStartStopInterleaving_unconfigured_isOrderedAndComplete() {
    let engine = CameraEngine()
    let recorder = SessionEventRecorder()
    recorder.attach(to: engine)
    var expected: [String] = []
    for index in 0..<40 {
      if index % 3 == 0 {
        engine.stop()
        expected.append("stopped")
      } else {
        engine.start()
        expected.append("failed(The camera session is not configured.)")
      }
    }
    XCTAssertTrue(AttackSupport.waitUntil(5) { recorder.events.count >= 40 })
    XCTAssertEqual(recorder.descriptions, expected)
  }

  /// `configureAuthorizedSession()` bypasses the permission check, so on a
  /// camera-less destination it deterministically reaches
  /// `attachDeviceLocked` and throws the rear-camera message; because that
  /// throw happens BEFORE `installObservers()` (line 232 vs 263) no
  /// `.configured` event is emitted and notifications stay unobserved.
  func test_sim_configureWithoutCamera_throwsRearCameraMessage_installsNoObservers() async throws {
    guard !AttackSupport.hasAnyVideoDevice() else {
      throw XCTSkip("[sim-only] destination has a camera")
    }
    let engine = CameraEngine()
    let recorder = SessionEventRecorder()
    recorder.attach(to: engine)
    do {
      try await engine.configureAuthorizedSession()
      XCTFail("configure must fail without a camera")
    } catch let error as CameraEngine.EngineError {
      guard case .configurationFailed(let message) = error else {
        return XCTFail("unexpected \(error)")
      }
      XCTAssertEqual(message, "No usable rear camera is available.")
      XCTAssertEqual(error.localizedDescription, "No usable rear camera is available.")
    }
    XCTAssertEqual(recorder.descriptions, [], "no .configured after a failed configure")

    let session = try AttackSupport.session(of: engine)
    NotificationCenter.default.post(name: .AVCaptureSessionRuntimeError, object: session)
    AttackSupport.waitUntil(0.3) { false }
    XCTAssertEqual(recorder.descriptions, [], "observers are not installed when configuration fails")

    // A failed configure leaves the engine unconfigured: start() still reports it.
    engine.start()
    XCTAssertTrue(AttackSupport.waitUntil(2) { !recorder.events.isEmpty })
    XCTAssertEqual(recorder.descriptions, ["failed(The camera session is not configured.)"])
  }

  /// Repeated failed configures must not accumulate partial session state
  /// (`beginConfiguration`/`commitConfiguration` are balanced by `defer`).
  func test_sim_repeatedFailedConfigure_isIdempotent() async throws {
    guard !AttackSupport.hasAnyVideoDevice() else {
      throw XCTSkip("[sim-only] destination has a camera")
    }
    let engine = CameraEngine()
    let session = try AttackSupport.session(of: engine)
    for _ in 0..<10 {
      do {
        try await engine.configureAuthorizedSession()
        XCTFail("must throw")
      } catch let error as CameraEngine.EngineError {
        guard case .configurationFailed = error else { return XCTFail("unexpected \(error)") }
      }
    }
    XCTAssertTrue(session.inputs.isEmpty, "no input may be left attached after failed configures")
    XCTAssertTrue(session.outputs.isEmpty, "outputs are added only after a device attaches (line 243/248)")
    XCTAssertFalse(session.isRunning)
  }

  func test_sim_errorDescriptions_areTheProductionStrings() {
    XCTAssertEqual(CameraEngine.EngineError.permissionDenied.localizedDescription,
                   "Camera access is required for guided capture.")
    XCTAssertEqual(CameraEngine.EngineError.sessionNotRunning.localizedDescription,
                   "The camera session is not running.")
    XCTAssertEqual(CameraEngine.EngineError.recordingAlreadyActive.localizedDescription,
                   "A camera recording is already active.")
    XCTAssertEqual(CameraEngine.EngineError.recordingFailed("x").localizedDescription, "x")
    XCTAssertEqual(SessionCaptureCoordinator.CoordinatorError.invalidBounds.localizedDescription,
                   "The requested event window is empty or reversed.")
    XCTAssertEqual(SessionCaptureCoordinator.CoordinatorError.recordingNotStarted.localizedDescription,
                   "The session recording has not produced any frames yet.")
    XCTAssertEqual(SessionCaptureCoordinator.CoordinatorError.alreadyStopped.localizedDescription,
                   "The session capture has already stopped.")
  }

  /// `makePreviewLayer()` before configuration must return a layer bound to
  /// the engine's own session (the RN preview binds before configure).
  func test_sim_previewLayerBeforeConfigure_isBoundToEngineSession() throws {
    let engine = CameraEngine()
    let layer = engine.makePreviewLayer()
    XCTAssertTrue(layer.session === (try AttackSupport.session(of: engine)))
    XCTAssertEqual(layer.videoGravity, .resizeAspectFill)
  }
}
