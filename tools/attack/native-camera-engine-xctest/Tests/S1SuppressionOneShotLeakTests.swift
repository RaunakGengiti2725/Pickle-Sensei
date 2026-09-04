// Scenario 1 — one-shot recording-finish suppression must not leak.
//
// CameraEngine keeps a one-shot `suppressNextRecordingFinish` flag
// (CameraEngine.swift:562) consumed by the movie-output delegate
// (CameraEngine.swift:709-725): when set, the NEXT finished recording is
// deleted and `onRecordingFinished` is never invoked. Two public entry points
// arm it:
//   • `discardActiveRecording()` (CameraEngine.swift:580-588) — decided on the
//     session queue against `movieOutput.isRecording`, a no-op when idle. Its
//     doc comment (574-579) states the invariant: the suppression "can never
//     be armed while nothing records and swallow a later, real capture's
//     finish".
//   • `suppressNextRecordingFinishAndDiscard()` (CameraEngine.swift:568-572) —
//     arms the flag UNCONDITIONALLY, with no recording-state check.
// The attack arms the unconditional entry point while idle, calls the guarded
// one (a no-op), then completes a real recording and checks that its finish
// still reaches the owner.
import AVFoundation
import Foundation
import XCTest

@testable import PickleCameraEngineUnderTest

final class S1SuppressionOneShotLeakTests: XCTestCase {
  /// ANY destination. Drives the production delegate method directly with a
  /// scratch `AVCaptureMovieFileOutput` (the engine never inspects `output`),
  /// so the state machine is exercised without a camera. On 4d812e1a this is
  /// EXPECTED RED: the stale one-shot from
  /// `suppressNextRecordingFinishAndDiscard()` swallows the later recording's
  /// finish (0 callbacks instead of 1). The second delivery then fires,
  /// proving the flag was consumed exactly once — a real caller loses exactly
  /// one capture, silently.
  func testArmedWhileIdleThenDiscardNoOpSwallowsTheNextRealFinish() {
    let engine = CameraEngine()
    let recorder = EngineCallbackRecorder()
    recorder.attach(to: engine)

    engine.suppressNextRecordingFinishAndDiscard()
    engine.discardActiveRecording()  // nothing records → must stay a no-op
    engine.attackDrainSessionQueue()
    XCTAssertEqual(recorder.results.count, 0, "no finish may be reported before any recording ends")

    // The finish of a later, REAL recording (what AVCaptureMovieFileOutput
    // would deliver after startContinuousRecording + stopContinuousRecording).
    let realRecording = AttackFiles.temporaryURL("real-recording")
    defer { AttackFiles.removeParent(of: realRecording) }
    XCTAssertTrue(FileManager.default.createFile(atPath: realRecording.path, contents: Data([0x00, 0x00, 0x00, 0x14])))
    engine.fileOutput(AVCaptureMovieFileOutput(), didFinishRecordingTo: realRecording, from: [], error: nil)

    XCTAssertEqual(
      recorder.results.count, 1,
      "one-shot suppression armed with nothing recording leaked into the next real recording: "
        + "its finish callback was swallowed (results=\(recorder.results.count))"
    )
    // Without recorded frame timestamps the honest outcome is recordingFailed;
    // what matters here is that the OWNER hears about it at all.
    if let first = recorder.results.first, case .failure(let error) = first {
      guard case .recordingFailed = error as? CameraEngine.EngineError else {
        return XCTFail("unexpected error \(error)")
      }
    }

    // A second delivery shows the flag is consumed on first use (one-shot):
    // the leak costs exactly one capture, never every later one.
    let secondRecording = AttackFiles.temporaryURL("second-recording")
    defer { AttackFiles.removeParent(of: secondRecording) }
    XCTAssertTrue(FileManager.default.createFile(atPath: secondRecording.path, contents: Data([0x01])))
    engine.fileOutput(AVCaptureMovieFileOutput(), didFinishRecordingTo: secondRecording, from: [], error: nil)
    XCTAssertGreaterThanOrEqual(recorder.results.count, 1, "the suppression must be one-shot")
    XCTAssertFalse(FileManager.default.fileExists(atPath: secondRecording.path), "frame-less finishes remove their file")
  }

  /// ANY destination. The guarded entry point alone honours its contract:
  /// `discardActiveRecording()` while idle arms nothing, so the next real
  /// finish is reported. Expected GREEN on 4d812e1a.
  func testDiscardActiveRecordingWhileIdleDoesNotArmSuppression() {
    let engine = CameraEngine()
    let recorder = EngineCallbackRecorder()
    recorder.attach(to: engine)

    for _ in 0..<25 { engine.discardActiveRecording() }  // rapid repeats
    engine.attackDrainSessionQueue()

    let url = AttackFiles.temporaryURL("after-idle-discard")
    defer { AttackFiles.removeParent(of: url) }
    XCTAssertTrue(FileManager.default.createFile(atPath: url.path, contents: Data([0x02])))
    engine.fileOutput(AVCaptureMovieFileOutput(), didFinishRecordingTo: url, from: [], error: nil)

    XCTAssertEqual(recorder.results.count, 1, "an idle discard must never suppress a later finish")
    guard let result = recorder.results.first, case .failure(let error) = result,
          case .recordingFailed(let message) = error as? CameraEngine.EngineError
    else {
      return XCTFail("expected recordingFailed for a frame-less finish, got \(String(describing: recorder.results.first))")
    }
    XCTAssertEqual(message, "No valid camera frames were recorded.")
    XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
  }

  /// ANY destination. A suppressed finish must still consume ONLY one shot
  /// even when the movie output reports an error; the error is swallowed too
  /// (by design: a flip restart discards the file regardless of why it
  /// ended) and the following finish is reported normally.
  func testSuppressedFinishWithErrorIsAlsoOneShot() {
    let engine = CameraEngine()
    let recorder = EngineCallbackRecorder()
    recorder.attach(to: engine)

    engine.suppressNextRecordingFinishAndDiscard()
    let url = AttackFiles.temporaryURL("errored")
    defer { AttackFiles.removeParent(of: url) }
    XCTAssertTrue(FileManager.default.createFile(atPath: url.path, contents: Data([0x03])))
    let error = NSError(domain: AVFoundationErrorDomain, code: AVError.Code.sessionWasInterrupted.rawValue)
    engine.fileOutput(AVCaptureMovieFileOutput(), didFinishRecordingTo: url, from: [], error: error)
    XCTAssertEqual(recorder.results.count, 0, "a suppressed finish reports nothing, even on error")
    XCTAssertFalse(FileManager.default.fileExists(atPath: url.path), "a suppressed finish deletes its file")

    let next = AttackFiles.temporaryURL("next")
    defer { AttackFiles.removeParent(of: next) }
    XCTAssertTrue(FileManager.default.createFile(atPath: next.path, contents: Data([0x04])))
    engine.fileOutput(AVCaptureMovieFileOutput(), didFinishRecordingTo: next, from: [], error: error)
    XCTAssertEqual(recorder.results.count, 1)
    if let result = recorder.results.first, case .failure(let reported) = result {
      XCTAssertEqual((reported as NSError).code, AVError.Code.sessionWasInterrupted.rawValue)
    } else {
      XCTFail("an unsuppressed errored finish must surface the error")
    }
  }

  /// DEVICE PLANE (skips on the Simulator). The literal scenario with a real
  /// camera: arm while idle, guarded discard (no-op), then a real recording
  /// is started and stopped — its finish must reach `onRecordingFinished`.
  /// Expected RED on 4d812e1a (the callback never fires and the file is
  /// deleted).
  func testRealRecordingFinishIsNotSwallowedAfterIdleArm() async throws {
    let recorder = EngineCallbackRecorder()
    let engine = try await CameraPlane.configuredEngine(
      config: CameraEngine.Config(maximumObservationSeconds: 30),
      recorder: recorder
    )
    engine.start()
    engine.attackDrainSessionQueue()
    guard recorder.eventLabels.contains("running") else {
      throw XCTSkip("camera session did not reach .running on this device: \(recorder.eventLabels)")
    }

    engine.suppressNextRecordingFinishAndDiscard()
    engine.discardActiveRecording()
    engine.attackDrainSessionQueue()

    let url = AttackFiles.temporaryURL("device-real-recording")
    defer { AttackFiles.removeParent(of: url) }
    let finished = expectation(description: "real recording finish reported")
    finished.assertForOverFulfill = false
    recorder.onAnyRecordingResult = { finished.fulfill() }
    engine.startContinuousRecording(to: url)
    try await Task.sleep(nanoseconds: 1_500_000_000)
    XCTAssertEqual(recorder.startedURLs, [url], "the recording must actually have started")
    engine.stopContinuousRecording()

    let outcome = await XCTWaiter().fulfillment(of: [finished], timeout: 8)
    XCTAssertEqual(
      outcome, .completed,
      "the real recording's finish was swallowed by a one-shot suppression armed while nothing recorded"
    )
    engine.stop()
    engine.attackDrainSessionQueue()
  }
}
