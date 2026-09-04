// Scenario 3 — startContinuousRecording(to:) before start().
//
// CameraEngine.swift:527-552: the session-queue block guards
// `session.isRunning` FIRST and reports `.failure(EngineError.sessionNotRunning)`
// before the file-system step (538-540) and before touching the movie output,
// so no file may appear at the URL. Runs on any destination — an unconfigured
// engine is never running.
import AVFoundation
import Foundation
import XCTest

@testable import PickleCameraEngineUnderTest

final class S3RecordingBeforeStartTests: XCTestCase {
  private func assertSessionNotRunning(
    _ result: Result<CameraEngine.RecordingArtifact, Error>?,
    file: StaticString = #filePath,
    line: UInt = #line
  ) {
    guard let result, case .failure(let error) = result else {
      return XCTFail("expected a failure, got \(String(describing: result))", file: file, line: line)
    }
    guard case .sessionNotRunning = error as? CameraEngine.EngineError else {
      return XCTFail("expected EngineError.sessionNotRunning, got \(error)", file: file, line: line)
    }
    XCTAssertEqual(error.localizedDescription, "The camera session is not running.", file: file, line: line)
  }

  func testRecordingBeforeStartFailsWithSessionNotRunningAndCreatesNoFile() {
    let engine = CameraEngine()
    let recorder = EngineCallbackRecorder()
    recorder.attach(to: engine)
    let url = AttackFiles.temporaryURL("never-started")
    defer { AttackFiles.removeParent(of: url) }

    let reported = expectation(description: "onRecordingFinished")
    recorder.onAnyRecordingResult = { reported.fulfill() }
    let t0 = attackNowMs()
    engine.startContinuousRecording(to: url)
    wait(for: [reported], timeout: 5)
    let elapsedMs = attackNowMs() - t0

    XCTAssertEqual(recorder.results.count, 1)
    assertSessionNotRunning(recorder.results.first)
    XCTAssertLessThan(elapsedMs, 1_000, "the failure must be immediate, not a recording timeout")
    engine.attackDrainSessionQueue()
    XCTAssertFalse(FileManager.default.fileExists(atPath: url.path), "no file may be created at the URL")
    XCTAssertTrue(recorder.startedURLs.isEmpty, "onRecordingStarted must not fire")
    XCTAssertTrue(recorder.events.isEmpty, "a refused recording emits no session event")
  }

  /// A pre-existing file at the URL must survive: the running-session guard
  /// precedes the delete step, so a refused start has no file-system side
  /// effect at all.
  func testRefusedRecordingLeavesAnExistingFileUntouched() throws {
    let engine = CameraEngine()
    let recorder = EngineCallbackRecorder()
    recorder.attach(to: engine)
    let url = AttackFiles.temporaryURL("pre-existing")
    defer { AttackFiles.removeParent(of: url) }
    let payload = Data("not a movie — \u{1F952}".utf8)
    try payload.write(to: url)

    let reported = expectation(description: "onRecordingFinished")
    recorder.onAnyRecordingResult = { reported.fulfill() }
    engine.startContinuousRecording(to: url)
    wait(for: [reported], timeout: 5)
    engine.attackDrainSessionQueue()

    assertSessionNotRunning(recorder.results.first)
    XCTAssertEqual(try Data(contentsOf: url), payload, "the existing file must be byte-identical")
  }

  /// Hostile URLs (missing parent directory, unicode + spaces, a directory
  /// path, an empty path) all take the same early exit; nothing is created.
  func testHostileURLsAreRefusedWithoutFileSystemSideEffects() {
    let engine = CameraEngine()
    let recorder = EngineCallbackRecorder()
    recorder.attach(to: engine)
    let base = FileManager.default.temporaryDirectory
      .appendingPathComponent("camera-engine-attack-hostile-\(UUID().uuidString.lowercased())", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: base) }
    let urls: [URL] = [
      base.appendingPathComponent("missing/parents/deep/clip.mov"),
      base.appendingPathComponent("🥒 pickle sensei — \u{0301}clip.mov"),
      base,  // a directory, not a file
      URL(fileURLWithPath: "/"),
      URL(fileURLWithPath: String(repeating: "a", count: 4_096) + ".mov"),
    ]

    let reported = expectation(description: "every refusal reported")
    reported.expectedFulfillmentCount = urls.count
    recorder.onAnyRecordingResult = { reported.fulfill() }
    for url in urls { engine.startContinuousRecording(to: url) }
    wait(for: [reported], timeout: 5)
    engine.attackDrainSessionQueue()

    XCTAssertEqual(recorder.results.count, urls.count)
    for result in recorder.results { assertSessionNotRunning(result) }
    XCTAssertFalse(FileManager.default.fileExists(atPath: base.path), "no parent directory may be created")
    XCTAssertTrue(recorder.startedURLs.isEmpty)
  }

  /// Rapid interleaving: 100 recording requests racing 100 stop requests on
  /// an unconfigured engine — every request is answered exactly once with
  /// sessionNotRunning and nothing else leaks (no .starting, no file).
  func testRapidInterleavedRecordAndStopRequestsAreEachRefusedOnce() {
    let engine = CameraEngine()
    let recorder = EngineCallbackRecorder()
    recorder.attach(to: engine)
    let url = AttackFiles.temporaryURL("interleaved")
    defer { AttackFiles.removeParent(of: url) }
    var rng = SeededGenerator()
    let ops = (0..<200).map { $0 % 2 == 0 ? "record" : "stop" }.shuffled(using: &rng)

    let reported = expectation(description: "100 refusals")
    reported.expectedFulfillmentCount = 100
    recorder.onAnyRecordingResult = { reported.fulfill() }
    for op in ops {
      if op == "record" { engine.startContinuousRecording(to: url) } else { engine.stopContinuousRecording() }
    }
    wait(for: [reported], timeout: 10)
    engine.attackDrainSessionQueue()

    XCTAssertEqual(recorder.results.count, 100)
    for result in recorder.results { assertSessionNotRunning(result) }
    XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
    XCTAssertTrue(recorder.events.isEmpty)
  }
}
