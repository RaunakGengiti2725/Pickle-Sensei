// Extra probes beyond the seven assigned scenarios (any destination).
import AVFoundation
import Foundation
import XCTest

@testable import PickleCameraEngineUnderTest

final class ExtraAdversarialTests: XCTestCase {
  /// Registry hygiene: released coordinators vanish from `anyActive()` and
  /// lookups; ids are lower-case UUIDs; a burst of registrations does not
  /// leak entries (register() compacts dead weak entries).
  func testRegistryForgetsReleasedCoordinatorsAndUsesLowercaseUUIDs() {
    var ids: [String] = []
    weak var survivorWeak: SessionCaptureCoordinator?
    var survivorId = ""
    var survivor: SessionCaptureCoordinator? = nil

    autoreleasepool {
      var batch: [SessionCaptureCoordinator] = []
      for _ in 0..<50 { batch.append(SessionCaptureCoordinator()) }
      ids = batch.map(\.captureId)
      survivor = batch.removeLast()
      survivorWeak = survivor
      survivorId = survivor!.captureId
      XCTAssertEqual(Set(ids).count, 50, "ids are unique")
      for id in ids {
        XCTAssertEqual(id.count, 36)
        XCTAssertEqual(id, id.lowercased(), "ids are lower-cased")
        XCTAssertNotNil(UUID(uuidString: id))
        XCTAssertNotNil(SessionCaptureCoordinator.active(withId: id))
      }
      batch.removeAll()
    }

    XCTAssertTrue(SessionCaptureCoordinator.anyActive(), "the survivor keeps anyActive() true")
    for id in ids where id != survivorId {
      XCTAssertNil(SessionCaptureCoordinator.active(withId: id), "released coordinators are not resolvable")
    }
    XCTAssertTrue(SessionCaptureCoordinator.active(withId: survivorId) === survivor)
    survivor = nil
    XCTAssertNil(survivorWeak)
    XCTAssertFalse(SessionCaptureCoordinator.anyActive(), "no coordinator → anyActive() false")
    XCTAssertNil(SessionCaptureCoordinator.active(withId: survivorId))
  }

  /// The movie-output start callback relays the URL verbatim (unicode,
  /// spaces, percent escapes untouched) and the finish paths delete the file
  /// on every failure branch.
  func testDelegateStartRelaysURLAndFailureBranchesRemoveTheFile() {
    let engine = CameraEngine()
    let recorder = EngineCallbackRecorder()
    recorder.attach(to: engine)
    let url = AttackFiles.temporaryURL("🥒 clip %20 with spaces")
    defer { AttackFiles.removeParent(of: url) }

    engine.fileOutput(AVCaptureMovieFileOutput(), didStartRecordingTo: url, from: [])
    XCTAssertEqual(recorder.startedURLs, [url])

    // error WITHOUT the successfully-finished marker → failure(error), file removed
    XCTAssertTrue(FileManager.default.createFile(atPath: url.path, contents: Data([0x05])))
    let hardError = NSError(domain: AVFoundationErrorDomain, code: AVError.Code.diskFull.rawValue)
    engine.fileOutput(AVCaptureMovieFileOutput(), didFinishRecordingTo: url, from: [], error: hardError)
    XCTAssertEqual(recorder.results.count, 1)
    if case .failure(let error)? = recorder.results.last {
      XCTAssertEqual((error as NSError).code, AVError.Code.diskFull.rawValue)
    } else {
      XCTFail("expected the movie output's error to surface")
    }
    XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))

    // error WITH the marker (max-duration completion) but no frames →
    // recordingFailed, file removed
    XCTAssertTrue(FileManager.default.createFile(atPath: url.path, contents: Data([0x06])))
    let softError = NSError(
      domain: AVFoundationErrorDomain, code: AVError.Code.maximumDurationReached.rawValue,
      userInfo: [AVErrorRecordingSuccessfullyFinishedKey: true]
    )
    engine.fileOutput(AVCaptureMovieFileOutput(), didFinishRecordingTo: url, from: [], error: softError)
    XCTAssertEqual(recorder.results.count, 2)
    if case .failure(let error)? = recorder.results.last, case .recordingFailed(let message)? = error as? CameraEngine.EngineError {
      XCTAssertEqual(message, "No valid camera frames were recorded.")
    } else {
      XCTFail("a frame-less max-duration completion must be recordingFailed")
    }
    XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))

    // a finish for a URL that does not exist at all must not crash
    engine.fileOutput(AVCaptureMovieFileOutput(), didFinishRecordingTo: url, from: [], error: nil)
    XCTAssertEqual(recorder.results.count, 3)
  }

  /// Suppression armed while idle with a pending spool restart is impossible
  /// through the public API (flip only sets it while recording), but a
  /// suppressed finish on an unconfigured engine must still stay silent and
  /// remove the file — and must NOT report anything through the owner
  /// callbacks afterwards.
  func testSuppressedFinishOnUnconfiguredEngineIsSilentAndRemovesFile() {
    let engine = CameraEngine()
    let recorder = EngineCallbackRecorder()
    recorder.attach(to: engine)
    let url = AttackFiles.temporaryURL("suppressed")
    defer { AttackFiles.removeParent(of: url) }
    XCTAssertTrue(FileManager.default.createFile(atPath: url.path, contents: Data([0x07])))

    engine.suppressNextRecordingFinishAndDiscard()
    engine.fileOutput(AVCaptureMovieFileOutput(), didFinishRecordingTo: url, from: [], error: nil)
    engine.attackDrainSessionQueue()

    XCTAssertTrue(recorder.results.isEmpty)
    XCTAssertTrue(recorder.events.isEmpty)
    XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
  }

  /// Zoom-state snapshot on an unconfigured engine is well-formed and
  /// deterministic; 100 concurrent readers all get the same answer without
  /// touching a device.
  func testUnconfiguredZoomStateSnapshotIsStableUnderConcurrency() {
    let engine = CameraEngine()
    let done = expectation(description: "100 zoom snapshots")
    done.expectedFulfillmentCount = 100
    let lock = NSLock()
    var snapshots: [String] = []
    DispatchQueue.concurrentPerform(iterations: 100) { _ in
      engine.readZoomState { state in
        lock.lock()
        snapshots.append(
          "\(state.position.rawValue)|\(state.minDisplayZoom)|\(state.maxDisplayZoom)|\(state.displayZoom)|"
            + "\(state.centerStageSupported)|\(state.centerStageEnabled)")
        lock.unlock()
        done.fulfill()
      }
    }
    wait(for: [done], timeout: 5)
    XCTAssertEqual(snapshots.count, 100)
    XCTAssertEqual(Set(snapshots), ["\(AVCaptureDevice.Position.back.rawValue)|1.0|1.0|1.0|false|false"],
                   "unconfigured engines report the neutral 1× back-camera snapshot")
  }
}
