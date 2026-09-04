import AVFoundation
import Foundation
import PickleCameraEngine
import XCTest

/// Rapid start/stop, recording-before-running, zoom/camera fuzz, release
/// loops and concurrent accessor reads against the real CameraEngine on the
/// Simulator (no camera hardware). Every public entry point must remain safe
/// to call in any order, from any thread, before configuration succeeded —
/// GuidedCaptureViewController and SessionCaptureCoordinator both rely on
/// that during permission prompts, backgrounding and teardown.
///
/// `STRESS_ITER` scales the loops (default 3); `STRESS_SEED` re-bases seeds.
final class CameraEngineLifecycleStressTests: XCTestCase {
  // SplitMix64, duplicated from StressSupport so this package stays standalone.
  private struct SeededRNG: RandomNumberGenerator {
    var state: UInt64
    mutating func next() -> UInt64 {
      state &+= 0x9E37_79B9_7F4A_7C15
      var z = state
      z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
      z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
      return z ^ (z >> 31)
    }
    mutating func double() -> Double { Double(next() >> 11) / Double(1 << 53) }
    mutating func int(in range: ClosedRange<Int>) -> Int { Int.random(in: range, using: &self) }
    mutating func bool() -> Bool { next() & 1 == 1 }
  }

  private static var iterations: Int {
    guard let raw = ProcessInfo.processInfo.environment["STRESS_ITER"], let value = Int(raw), value > 0 else { return 3 }
    return value
  }

  private static var baseSeed: UInt64 {
    guard let raw = ProcessInfo.processInfo.environment["STRESS_SEED"], let value = UInt64(raw) else { return 0x5EED_0000_0001 }
    return value
  }

  /// Thread-safe event sink; the engine emits from its private session queue.
  private final class EventSink {
    private let lock = NSLock()
    private var events: [String] = []
    private var recordingResults: [String] = []

    func attach(to engine: CameraEngine) {
      engine.onSessionEvent = { [weak self] event in
        self?.append(Self.label(event))
      }
      engine.onRecordingFinished = { [weak self] result in
        switch result {
        case .success: self?.appendRecording("success")
        case .failure(let error): self?.appendRecording("failure:\(error.localizedDescription)")
        }
      }
    }

    private static func label(_ event: CameraEngine.SessionEvent) -> String {
      switch event {
      case .configured: return "configured"
      case .starting: return "starting"
      case .running: return "running"
      case .stopped: return "stopped"
      case .interrupted: return "interrupted"
      case .interruptionEnded: return "interruptionEnded"
      case .failed: return "failed"
      }
    }

    private func append(_ label: String) {
      lock.lock(); events.append(label); lock.unlock()
    }

    private func appendRecording(_ label: String) {
      lock.lock(); recordingResults.append(label); lock.unlock()
    }

    var snapshot: [String] {
      lock.lock(); defer { lock.unlock() }; return events
    }

    var recordings: [String] {
      lock.lock(); defer { lock.unlock() }; return recordingResults
    }
  }

  /// The engine's session queue is serial; a `readZoomState` completion
  /// therefore observes every previously enqueued call.
  private func drainSessionQueue(_ engine: CameraEngine, file: StaticString = #filePath, line: UInt = #line) {
    let drained = expectation(description: "session queue drained")
    engine.readZoomState { _ in drained.fulfill() }
    wait(for: [drained], timeout: 30)
  }

  private func scratchURL(_ name: String) -> URL {
    let url = URL(fileURLWithPath: NSTemporaryDirectory())
      .appendingPathComponent("pickle-camera-stress-\(UUID().uuidString)-\(name).mov")
    addTeardownBlock { try? FileManager.default.removeItem(at: url) }
    return url
  }

  // MARK: - Configuration

  func testConfigureWithoutCameraThrowsConfigurationFailedInsteadOfTrapping() async throws {
    let engine = CameraEngine()
    do {
      try await engine.configureAuthorizedSession()
    } catch let error as CameraEngine.EngineError {
      guard case .configurationFailed(let message) = error else {
        return XCTFail("unexpected engine error \(error)")
      }
      XCTAssertFalse(message.isEmpty)
      XCTAssertEqual(error.errorDescription, message)
      return
    } catch {
      return XCTFail("unexpected error type \(type(of: error))")
    }
    // A host with a camera configures successfully; that path is covered by
    // the Mac workflow's app launch, not by this Simulator run.
    throw XCTSkip("host has a camera; configuration succeeded")
  }

  func testRepeatedConfigureFailuresAreIdempotent() async {
    let engine = CameraEngine()
    let sink = EventSink()
    sink.attach(to: engine)
    var failures = 0
    for _ in 0..<(Self.iterations * 5) {
      do {
        try await engine.configureAuthorizedSession()
      } catch {
        failures += 1
      }
    }
    if failures == 0 { return } // camera present: nothing to assert here
    XCTAssertEqual(failures, Self.iterations * 5, "configuration must fail consistently without a camera")
    XCTAssertFalse(sink.snapshot.contains("configured"), "a failed configure must not emit .configured")
  }

  // MARK: - Rapid start/stop

  func testRapidStartStopBeforeConfigurationEmitsBalancedEvents() {
    let engine = CameraEngine()
    let sink = EventSink()
    sink.attach(to: engine)
    let cycles = Self.iterations * 50
    var rng = SeededRNG(state: Self.baseSeed)
    var starts = 0
    var stops = 0
    for _ in 0..<cycles {
      switch rng.int(in: 0...3) {
      case 0: engine.start(); starts += 1
      case 1: engine.stop(); stops += 1
      case 2: engine.start(); engine.stop(); starts += 1; stops += 1
      default: engine.stop(); engine.start(); starts += 1; stops += 1
      }
    }
    drainSessionQueue(engine)
    let events = sink.snapshot
    XCTAssertEqual(events.filter { $0 == "failed" }.count, starts, "every start() before configure must fail exactly once")
    XCTAssertEqual(events.filter { $0 == "stopped" }.count, stops, "every stop() must emit exactly one .stopped")
    XCTAssertFalse(events.contains("running"), "an unconfigured session can never report .running")
    XCTAssertFalse(events.contains("starting"), "start() must bail before .starting when unconfigured")
    XCTAssertNil(engine.currentRecordingFirstFrameTimestampMs)
    XCTAssertNil(engine.currentRecordingLastFrameTimestampMs)
  }

  func testStartStopFromManyThreadsConcurrently() {
    let engine = CameraEngine()
    let sink = EventSink()
    sink.attach(to: engine)
    let workers = 6
    let perWorker = Self.iterations * 20
    let group = DispatchGroup()
    for worker in 0..<workers {
      group.enter()
      DispatchQueue.global(qos: worker % 2 == 0 ? .userInteractive : .background).async {
        var rng = SeededRNG(state: Self.baseSeed &+ UInt64(worker))
        for _ in 0..<perWorker {
          if rng.bool() { engine.start() } else { engine.stop() }
          _ = engine.currentRecordingFirstFrameTimestampMs
          _ = engine.currentRecordingLastFrameTimestampMs
        }
        group.leave()
      }
    }
    XCTAssertEqual(group.wait(timeout: .now() + 60), .success)
    drainSessionQueue(engine)
    XCTAssertEqual(sink.snapshot.count, workers * perWorker, "one event per start()/stop() call")
  }

  // MARK: - Recording without a running session

  func testRecordingBeforeRunningFailsOncePerCallAndLeavesNoFile() {
    let engine = CameraEngine()
    let sink = EventSink()
    sink.attach(to: engine)
    let attempts = Self.iterations * 10
    var urls: [URL] = []
    for index in 0..<attempts {
      let url = scratchURL("rec-\(index)")
      urls.append(url)
      engine.startContinuousRecording(to: url)
      if index % 3 == 0 { engine.stopContinuousRecording() }
      if index % 4 == 0 { engine.discardActiveRecording() }
    }
    drainSessionQueue(engine)
    let results = sink.recordings
    XCTAssertEqual(results.count, attempts, "exactly one failure callback per startContinuousRecording")
    XCTAssertTrue(results.allSatisfy { $0.hasPrefix("failure:") }, "\(results.prefix(3))")
    XCTAssertTrue(results.allSatisfy { $0.contains(CameraEngine.EngineError.sessionNotRunning.errorDescription ?? "") })
    for url in urls {
      XCTAssertFalse(FileManager.default.fileExists(atPath: url.path), "no movie file may be created when the session is not running")
    }
    XCTAssertNil(engine.currentRecordingFirstFrameTimestampMs)
  }

  func testRecordingBeforeRunningLeavesCallersExistingFileUntouched() throws {
    let engine = CameraEngine()
    let sink = EventSink()
    sink.attach(to: engine)
    let url = scratchURL("stale")
    try Data([0x00, 0x01]).write(to: url)
    engine.startContinuousRecording(to: url)
    drainSessionQueue(engine)
    XCTAssertEqual(sink.recordings.count, 1)
    XCTAssertTrue(FileManager.default.fileExists(atPath: url.path), "sessionNotRunning must be reported before touching the caller's file")
  }

  func testDiscardSuppressAndStopAreNoOpsWhenIdle() {
    let engine = CameraEngine()
    let sink = EventSink()
    sink.attach(to: engine)
    for _ in 0..<(Self.iterations * 20) {
      engine.discardActiveRecording()
      engine.stopContinuousRecording()
      engine.suppressNextRecordingFinishAndDiscard()
    }
    drainSessionQueue(engine)
    XCTAssertTrue(sink.recordings.isEmpty, "idle discard/stop must not report recording results")
    XCTAssertTrue(sink.snapshot.isEmpty, "idle discard/stop must not emit session events")
  }

  // MARK: - Camera controls without a device

  func testZoomFuzzWithoutDeviceIsIgnored() {
    // setCenterStageEnabled persists through UserDefaults; restore the host's value.
    let defaultsKey = "pickle.camera.centerStagePreference"
    let previous = UserDefaults.standard.object(forKey: defaultsKey)
    addTeardownBlock {
      if let previous { UserDefaults.standard.set(previous, forKey: defaultsKey) } else { UserDefaults.standard.removeObject(forKey: defaultsKey) }
    }
    let engine = CameraEngine()
    var zoomEvents = 0
    let lock = NSLock()
    engine.onZoomStateChanged = { _ in lock.lock(); zoomEvents += 1; lock.unlock() }
    var rng = SeededRNG(state: Self.baseSeed ^ 0x2004)
    let specials: [CGFloat] = [.nan, .infinity, -.infinity, -1, 0, 0.5, 1, 2, 1e9, .leastNonzeroMagnitude, .greatestFiniteMagnitude]
    for _ in 0..<(Self.iterations * 30) {
      let value = rng.bool() ? specials[rng.int(in: 0...(specials.count - 1))] : CGFloat(rng.double() * 20 - 5)
      engine.setDisplayZoom(value, animated: rng.bool())
      engine.setCenterStageEnabled(rng.bool())
      engine.switchCamera(to: rng.bool() ? .front : .back)
    }
    let state = expectation(description: "zoom state")
    engine.readZoomState { zoom in
      XCTAssertEqual(zoom.displayZoom, 1, "placeholder zoom state without a device")
      XCTAssertEqual(zoom.minDisplayZoom, 1)
      XCTAssertEqual(zoom.maxDisplayZoom, 1)
      XCTAssertFalse(zoom.centerStageSupported)
      state.fulfill()
    }
    wait(for: [state], timeout: 30)
    lock.lock(); let observed = zoomEvents; lock.unlock()
    // setCenterStageEnabled always re-emits zoom state; the others bail
    // without a device. Only assert nothing crashed and events are bounded.
    XCTAssertLessThanOrEqual(observed, Self.iterations * 30 * 3)
  }

  func testFlipCameraRestartingSpoolWithoutSessionReportsFailurePerCall() {
    let engine = CameraEngine()
    let sink = EventSink()
    sink.attach(to: engine)
    let flips = Self.iterations * 10
    for index in 0..<flips {
      engine.flipCameraRestartingSpool(to: index % 2 == 0 ? .front : .back, nextRecordingURL: scratchURL("flip-\(index)"))
    }
    drainSessionQueue(engine)
    // The nested startContinuousRecording is dispatched again; drain twice.
    drainSessionQueue(engine)
    let results = sink.recordings
    XCTAssertEqual(results.count, flips, "each flip without a running session must surface sessionNotRunning")
    XCTAssertTrue(results.allSatisfy { $0.hasPrefix("failure:") })
  }

  func testPreviewLayerCanBeCreatedRepeatedlyBeforeConfiguration() {
    let engine = CameraEngine()
    for _ in 0..<(Self.iterations * 10) {
      let layer = engine.makePreviewLayer()
      XCTAssertNotNil(layer.session)
      XCTAssertEqual(layer.videoGravity, .resizeAspectFill)
    }
  }

  // MARK: - Memory pressure / release

  func testEngineReleaseLoopDoesNotLeakOrCrashInDeinit() {
    var weakRefs: [() -> CameraEngine?] = []
    for index in 0..<(Self.iterations * 20) {
      autoreleasepool {
        let engine = CameraEngine(config: .init(preset: .hd1280x720, targetFps: 30, maximumObservationSeconds: 5, movieFragmentSeconds: index % 2 == 0 ? 1 : nil))
        let sink = EventSink()
        sink.attach(to: engine)
        engine.start()
        engine.startContinuousRecording(to: scratchURL("release-\(index)"))
        engine.stop()
        _ = engine.makePreviewLayer()
        drainSessionQueue(engine)
        weak var weakEngine = engine
        weakRefs.append { weakEngine }
      }
    }
    // Give the session queue a beat to drop its captured self references.
    let settle = expectation(description: "settle")
    DispatchQueue.global().asyncAfter(deadline: .now() + 0.5) { settle.fulfill() }
    wait(for: [settle], timeout: 10)
    let alive = weakRefs.compactMap { $0() }.count
    XCTAssertEqual(alive, 0, "\(alive) CameraEngine instances still alive after release loop")
  }

  // MARK: - Device-gated recording race (skips without a camera)

  func testPreviousRecordingFinishMustNotClearNextRecordingTimestamps() async throws {
    // Static review of fileOutput(_:didFinishRecordingTo:) shows it clears
    // recordingFirst/LastFrameTimestampMs without checking that the finished
    // URL is still the active one. If a new spool starts before the previous
    // file finalizes (shutter stop → immediate restart), the late callback
    // wipes the NEW recording's first-frame timestamp. Only a real camera can
    // exercise this; the Simulator skips.
    let engine = CameraEngine(config: .init(preset: .hd1280x720, targetFps: 30, maximumObservationSeconds: 30, movieFragmentSeconds: 1))
    do {
      try await engine.configureAuthorizedSession()
    } catch {
      throw XCTSkip("needs a physical camera: \(error.localizedDescription)")
    }
    let sink = EventSink()
    sink.attach(to: engine)
    engine.start()
    let first = scratchURL("race-first")
    let second = scratchURL("race-second")
    engine.startContinuousRecording(to: first)
    // Wait for frames to flow into the first recording.
    let deadline = Date().addingTimeInterval(10)
    while engine.currentRecordingFirstFrameTimestampMs == nil, Date() < deadline {
      try await Task.sleep(nanoseconds: 50_000_000)
    }
    guard engine.currentRecordingFirstFrameTimestampMs != nil else {
      throw XCTSkip("camera produced no frames within 10s")
    }
    engine.discardActiveRecording()
    engine.startContinuousRecording(to: second)
    // Let the second spool collect frames while the first finalizes.
    try await Task.sleep(nanoseconds: 1_500_000_000)
    let firstFrameOfSecond = engine.currentRecordingFirstFrameTimestampMs
    let lastFrameOfSecond = engine.currentRecordingLastFrameTimestampMs
    engine.stopContinuousRecording()
    engine.stop()
    try await Task.sleep(nanoseconds: 1_000_000_000)
    let successes = sink.recordings.filter { $0 == "success" }
    XCTAssertEqual(successes.count, 1, "the discarded first spool must not surface; the second must: \(sink.recordings)")
    XCTAssertNotNil(firstFrameOfSecond)
    if let firstFrameOfSecond, let lastFrameOfSecond {
      // ~1.5s of frames at ≥24fps: the recorded first-frame timestamp must
      // sit near the start of that span, not have been reset mid-way.
      XCTAssertGreaterThan(lastFrameOfSecond - firstFrameOfSecond, 1_000,
                           "first-frame timestamp of the second recording was reset by the first recording's finish callback")
    }
  }
}
