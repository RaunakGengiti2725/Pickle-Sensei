import AVFoundation
import Foundation
import XCTest

@testable import CameraEngineUnderTest

/// Scenarios 4, 6, 9 — `startContinuousRecording` and the recording delegate.
///
/// [sim] tests pin what a camera-less destination can prove: guard order
/// (session not running → NO file-system side effects, CameraEngine.swift:
/// 529-544), and the recording-delegate classification logic, which is public
/// (`fileOutput(_:didFinishRecordingTo:from:error:)`, lines 695-750) and can be
/// driven directly with synthesized errors.
/// [device] tests need frames: file removed before recording starts, second
/// start refused while the first keeps recording, max-duration success path.
final class S4S6S9RecordingTests: XCTestCase {
  private func writeSentinel(_ url: URL) throws {
    try AttackSupport.sentinelBytes.write(to: url)
    XCTAssertTrue(AttackSupport.fileIsSentinel(url))
  }

  // MARK: [sim] scenario 4 — guard order, no side effects when not running

  func test_sim_notRunning_preExistingFileIsLeftUntouched() throws {
    let engine = CameraEngine()
    let recorder = RecordingRecorder()
    recorder.attach(to: engine)
    let url = try AttackSupport.movieURL("s4-sim")
    try writeSentinel(url)

    engine.startContinuousRecording(to: url)
    XCTAssertTrue(AttackSupport.waitUntil(2) { !recorder.outcomes.isEmpty })
    XCTAssertEqual(recorder.outcomes.count, 1)
    XCTAssertTrue(recorder.outcomes[0].isSessionNotRunning, "got \(recorder.outcomes[0])")
    XCTAssertTrue(
      AttackSupport.fileIsSentinel(url),
      "the session-not-running guard (line 529) precedes file removal (line 538); the file must survive"
    )
  }

  /// Unicode + long file names and a URL whose parent does not exist: all
  /// must short-circuit identically (sessionNotRunning, no I/O) when the
  /// session is not running.
  func test_sim_notRunning_hostileURLs_allReportSessionNotRunning() throws {
    let engine = CameraEngine()
    let recorder = RecordingRecorder()
    recorder.attach(to: engine)
    let directory = try AttackSupport.scratchDirectory("s4-hostile")
    let urls = [
      directory.appendingPathComponent("日本語-\u{1F3D3}-clip.mov"),
      directory.appendingPathComponent(String(repeating: "a", count: 250) + ".mov"),
      directory.appendingPathComponent("missing-parent", isDirectory: true).appendingPathComponent("x.mov"),
      URL(fileURLWithPath: "/dev/null/impossible.mov"),
    ]
    for url in urls { engine.startContinuousRecording(to: url) }
    XCTAssertTrue(AttackSupport.waitUntil(3) { recorder.outcomes.count >= urls.count })
    XCTAssertEqual(recorder.outcomes.count, urls.count)
    XCTAssertTrue(recorder.outcomes.allSatisfy(\.isSessionNotRunning), "\(recorder.outcomes)")
    XCTAssertFalse(FileManager.default.fileExists(atPath: urls[0].path))
  }

  // MARK: [sim] scenario 9 — double start without a running session

  func test_sim_doubleStart_notRunning_reportsSessionNotRunningTwice_notAlreadyActive() throws {
    let engine = CameraEngine()
    let recorder = RecordingRecorder()
    recorder.attach(to: engine)
    let first = try AttackSupport.movieURL("s9-sim")
    let second = try AttackSupport.movieURL("s9-sim")
    engine.startContinuousRecording(to: first)
    engine.startContinuousRecording(to: second)
    XCTAssertTrue(AttackSupport.waitUntil(2) { recorder.outcomes.count >= 2 })
    XCTAssertEqual(recorder.outcomes.count, 2)
    XCTAssertTrue(recorder.outcomes.allSatisfy(\.isSessionNotRunning), "\(recorder.outcomes)")
    XCTAssertFalse(recorder.outcomes.contains(where: \.isRecordingAlreadyActive))
    XCTAssertTrue(recorder.startedURLs.isEmpty)
  }

  // MARK: [sim] scenario 6 — delegate classification without frames

  private func finishDirectly(_ engine: CameraEngine, url: URL, error: Error?) {
    engine.fileOutput(AVCaptureMovieFileOutput(), didFinishRecordingTo: url, from: [], error: error)
  }

  private func maxDurationError(successfullyFinished: Any?) -> NSError {
    var userInfo: [String: Any] = [NSLocalizedDescriptionKey: "Recording Stopped"]
    if let successfullyFinished { userInfo[AVErrorRecordingSuccessfullyFinishedKey] = successfullyFinished }
    return NSError(domain: AVFoundationErrorDomain, code: AVError.Code.maximumDurationReached.rawValue, userInfo: userInfo)
  }

  func test_sim_delegate_successfullyFinishedTrue_butNoFrames_deletesFile_recordingFailed() throws {
    let engine = CameraEngine()
    let recorder = RecordingRecorder()
    recorder.attach(to: engine)
    let url = try AttackSupport.movieURL("s6-sim")
    try writeSentinel(url)
    finishDirectly(engine, url: url, error: maxDurationError(successfullyFinished: true))
    XCTAssertTrue(AttackSupport.waitUntil(2) { !recorder.outcomes.isEmpty })
    XCTAssertTrue(recorder.outcomes[0].isRecordingFailed,
                  "with no frame timestamps the success-key path still hits the `last > first` guard (line 738): \(recorder.outcomes[0])")
    XCTAssertFalse(FileManager.default.fileExists(atPath: url.path), "a frameless file is removed (line 739)")
  }

  func test_sim_delegate_successfullyFinishedAsNSNumberOne_isTreatedAsTrue() throws {
    // AVFoundation hands the key over as an NSNumber; `as? Bool` must bridge it.
    let engine = CameraEngine()
    let recorder = RecordingRecorder()
    recorder.attach(to: engine)
    let url = try AttackSupport.movieURL("s6-sim")
    try writeSentinel(url)
    finishDirectly(engine, url: url, error: maxDurationError(successfullyFinished: NSNumber(value: 1)))
    XCTAssertTrue(AttackSupport.waitUntil(2) { !recorder.outcomes.isEmpty })
    // If bridging failed the failure would carry the AVFoundation error, not recordingFailed.
    XCTAssertTrue(recorder.outcomes[0].isRecordingFailed, "\(recorder.outcomes[0])")
  }

  func test_sim_delegate_errorWithoutKey_deletesFile_forwardsError() throws {
    let engine = CameraEngine()
    let recorder = RecordingRecorder()
    recorder.attach(to: engine)
    let url = try AttackSupport.movieURL("s6-sim")
    try writeSentinel(url)
    let error = NSError(domain: AVFoundationErrorDomain, code: AVError.Code.diskFull.rawValue,
                        userInfo: [NSLocalizedDescriptionKey: "disk full"])
    finishDirectly(engine, url: url, error: error)
    XCTAssertTrue(AttackSupport.waitUntil(2) { !recorder.outcomes.isEmpty })
    guard case .otherError(let forwarded) = recorder.outcomes[0] else {
      return XCTFail("expected the AVFoundation error to be forwarded, got \(recorder.outcomes[0])")
    }
    XCTAssertEqual((forwarded as NSError).code, AVError.Code.diskFull.rawValue)
    XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
  }

  func test_sim_delegate_successfullyFinishedFalse_deletesFile_forwardsError() throws {
    let engine = CameraEngine()
    let recorder = RecordingRecorder()
    recorder.attach(to: engine)
    let url = try AttackSupport.movieURL("s6-sim")
    try writeSentinel(url)
    finishDirectly(engine, url: url, error: maxDurationError(successfullyFinished: false))
    XCTAssertTrue(AttackSupport.waitUntil(2) { !recorder.outcomes.isEmpty })
    guard case .otherError = recorder.outcomes[0] else {
      return XCTFail("expected forwarded error, got \(recorder.outcomes[0])")
    }
    XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
  }

  func test_sim_delegate_nilError_noFrames_deletesFile_recordingFailed() throws {
    let engine = CameraEngine()
    let recorder = RecordingRecorder()
    recorder.attach(to: engine)
    let url = try AttackSupport.movieURL("s6-sim")
    try writeSentinel(url)
    finishDirectly(engine, url: url, error: nil)
    XCTAssertTrue(AttackSupport.waitUntil(2) { !recorder.outcomes.isEmpty })
    XCTAssertTrue(recorder.outcomes[0].isRecordingFailed, "\(recorder.outcomes[0])")
    XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
  }

  /// Suppression arming: `discardActiveRecording()` while nothing records must
  /// NOT arm the one-shot suppression (lines 580-588), so a later finish is
  /// still reported; `suppressNextRecordingFinishAndDiscard()` arms it
  /// unconditionally (lines 568-572), so the next finish is swallowed and its
  /// file deleted — exactly once.
  func test_sim_discardActiveRecording_whenIdle_doesNotArmSuppression() throws {
    let engine = CameraEngine()
    let recorder = RecordingRecorder()
    recorder.attach(to: engine)
    engine.discardActiveRecording()
    AttackSupport.waitUntil(0.3) { false }
    let url = try AttackSupport.movieURL("s6-suppress")
    try writeSentinel(url)
    finishDirectly(engine, url: url, error: nil)
    XCTAssertTrue(AttackSupport.waitUntil(2) { !recorder.outcomes.isEmpty }, "finish must still be reported")
  }

  func test_sim_suppressNextRecordingFinish_swallowsExactlyOneFinish() throws {
    let engine = CameraEngine()
    let recorder = RecordingRecorder()
    recorder.attach(to: engine)
    engine.suppressNextRecordingFinishAndDiscard()
    let first = try AttackSupport.movieURL("s6-suppress")
    try writeSentinel(first)
    finishDirectly(engine, url: first, error: nil)
    AttackSupport.waitUntil(0.3) { false }
    XCTAssertTrue(recorder.outcomes.isEmpty, "suppressed finish must not be reported")
    XCTAssertFalse(FileManager.default.fileExists(atPath: first.path), "suppressed file is discarded (line 716)")

    let second = try AttackSupport.movieURL("s6-suppress")
    try writeSentinel(second)
    finishDirectly(engine, url: second, error: nil)
    XCTAssertTrue(AttackSupport.waitUntil(2) { recorder.outcomes.count == 1 }, "suppression is one-shot")
  }

  // MARK: [device]

  private func runningEngine(_ config: CameraEngine.Config = CameraEngine.Config())
    async throws -> (CameraEngine, RecordingRecorder, SessionEventRecorder) {
    let engine = CameraEngine(config: config)
    let recording = RecordingRecorder()
    let events = SessionEventRecorder()
    recording.attach(to: engine)
    events.attach(to: engine)
    try await AttackSupport.requireCamera(engine)
    engine.start()
    let running = await AttackSupport.waitUntilAsync(5) { events.descriptions.contains("running") }
    guard running else { throw XCTSkip("[device] session did not reach .running: \(events.descriptions)") }
    addTeardownBlock { engine.stop() }
    return (engine, recording, events)
  }

  /// Scenario 4: a pre-existing file at the destination is removed BEFORE the
  /// movie output starts. Observed at `didStartRecording`: the file must no
  /// longer hold the sentinel bytes.
  func test_device_preExistingFile_removedBeforeRecordingStarts() async throws {
    let (engine, recorder, _) = try await runningEngine()
    let url = try AttackSupport.movieURL("s4-device")
    try writeSentinel(url)
    engine.startContinuousRecording(to: url)
    let started = await AttackSupport.waitUntilAsync(5) { !recorder.startedURLs.isEmpty }
    XCTAssertTrue(started, "didStartRecording never fired: \(recorder.outcomes)")
    XCTAssertEqual(recorder.startedURLs.first, url)
    XCTAssertEqual(recorder.sentinelSurvivedToStart, [false], "sentinel must be gone by the time recording starts")
    engine.stopContinuousRecording()
    let finished = await AttackSupport.waitUntilAsync(5) { !recorder.outcomes.isEmpty }
    XCTAssertTrue(finished)
    if case .success(let artifact)? = recorder.outcomes.first {
      XCTAssertFalse(AttackSupport.fileIsSentinel(artifact.url))
    }
  }

  /// Scenario 9: the second `startContinuousRecording` on a running engine
  /// yields `.recordingAlreadyActive`; the first keeps recording and its file
  /// survives, then finishes with `.success` on stop.
  func test_device_doubleStart_secondRefused_firstKeepsRecordingAndFile() async throws {
    let (engine, recorder, _) = try await runningEngine()
    let movieOutput = try AttackSupport.movieOutput(of: engine)
    let first = try AttackSupport.movieURL("s9-device", name: "first")
    let second = try AttackSupport.movieURL("s9-device", name: "second")

    engine.startContinuousRecording(to: first)
    let started = await AttackSupport.waitUntilAsync(5) { recorder.startedURLs.contains(first) }
    XCTAssertTrue(started, "first recording never started: \(recorder.outcomes)")
    let framed = await AttackSupport.waitUntilAsync(5) { engine.currentRecordingFirstFrameTimestampMs != nil }
    XCTAssertTrue(framed)

    engine.startContinuousRecording(to: second)
    let refused = await AttackSupport.waitUntilAsync(3) { recorder.outcomes.contains(where: \.isRecordingAlreadyActive) }
    XCTAssertTrue(refused, "second start must be refused with recordingAlreadyActive: \(recorder.outcomes)")
    XCTAssertEqual(recorder.outcomes.count, 1, "only the refusal has been reported so far")
    XCTAssertTrue(movieOutput.isRecording, "first recording still active")
    XCTAssertTrue(FileManager.default.fileExists(atPath: first.path), "first file must not be deleted")
    XCTAssertFalse(FileManager.default.fileExists(atPath: second.path), "second URL untouched")
    XCTAssertEqual(recorder.startedURLs, [first])
    let lastBefore = engine.currentRecordingLastFrameTimestampMs
    try await Task.sleep(nanoseconds: 700_000_000)
    XCTAssertNotEqual(engine.currentRecordingLastFrameTimestampMs, lastBefore, "frames keep flowing into the first recording")

    engine.stopContinuousRecording()
    let finished = await AttackSupport.waitUntilAsync(5) { recorder.outcomes.count >= 2 }
    XCTAssertTrue(finished)
    XCTAssertTrue(recorder.outcomes.last?.isSuccess == true, "\(recorder.outcomes)")
    XCTAssertTrue(FileManager.default.fileExists(atPath: first.path))
  }

  /// Rapid repeats: 20 back-to-back starts while one is active → exactly 19
  /// refusals, one live recording, one file.
  func test_device_twentyRapidStarts_exactlyOneRecording() async throws {
    let (engine, recorder, _) = try await runningEngine()
    let directory = try AttackSupport.scratchDirectory("s9-rapid")
    let urls = (0..<20).map { directory.appendingPathComponent("rapid-\($0).mov") }
    for url in urls { engine.startContinuousRecording(to: url) }
    let settled = await AttackSupport.waitUntilAsync(5) {
      recorder.outcomes.filter(\.isRecordingAlreadyActive).count == 19
    }
    XCTAssertTrue(settled, "\(recorder.outcomes)")
    XCTAssertEqual(recorder.startedURLs.count, 1)
    engine.stopContinuousRecording()
    let finished = await AttackSupport.waitUntilAsync(5) { recorder.outcomes.count == 20 }
    XCTAssertTrue(finished)
    let files = try FileManager.default.contentsOfDirectory(atPath: directory.path).filter { $0.hasPrefix("rapid-") }
    XCTAssertEqual(files.count, 1, "exactly one movie file: \(files)")
  }

  /// Scenario 6: maximumObservationSeconds = 2, record ≥ 3 s. AVFoundation
  /// stops the file at the cap and reports `maximumDurationReached` with
  /// `AVErrorRecordingSuccessfullyFinishedKey == true`; the engine must
  /// surface `.success` with an intact, readable ~2 s file.
  func test_device_maxDurationReached_isSuccessWithValidFile() async throws {
    let config = CameraEngine.Config(maximumObservationSeconds: 2)
    let (engine, recorder, _) = try await runningEngine(config)
    let url = try AttackSupport.movieURL("s6-device")
    engine.startContinuousRecording(to: url)
    let started = await AttackSupport.waitUntilAsync(5) { !recorder.startedURLs.isEmpty }
    XCTAssertTrue(started)
    // Do NOT stop: let the cap fire. 3 s of recording > 2 s cap.
    let finished = await AttackSupport.waitUntilAsync(8) { !recorder.outcomes.isEmpty }
    XCTAssertTrue(finished, "recording never finished after the 2 s cap")
    guard case .success(let artifact)? = recorder.outcomes.first else {
      return XCTFail("expected .success on the successfully-finished path, got \(recorder.outcomes)")
    }
    XCTAssertEqual(artifact.url, url)
    XCTAssertTrue(FileManager.default.fileExists(atPath: url.path), "file must NOT be deleted")
    XCTAssertGreaterThan(artifact.lastFrameTimestampMs, artifact.firstFrameTimestampMs)
    let duration = CMTimeGetSeconds(AVURLAsset(url: url).duration)
    XCTAssertTrue(duration.isFinite && duration > 1.5 && duration < 2.6, "readable duration \(duration)s should sit at the 2 s cap")
    let size = try XCTUnwrap(try FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber)
    XCTAssertGreaterThan(size.intValue, 10_000, "file must contain media")
  }
}
