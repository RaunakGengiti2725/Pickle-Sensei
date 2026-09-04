import AVFoundation
import Foundation
import XCTest

@testable import CameraEngineUnderTest

/// Shared plumbing for the adversarial camera-engine tests.
///
/// PLANES. Every test in this target is one of:
///  - `[sim]`    deterministic on an iOS Simulator (no camera needed);
///  - `[device]` needs a real camera — `requireCamera` converts the engine's
///               honest `configurationFailed` / `permissionDenied` into an
///               `XCTSkip` so the suite reports UNTESTED (never PASS) on a
///               camera-less destination. A skip is NOT a pass.
///
/// PRIVATE STATE. `CameraEngine.session`, `movieOutput` and
/// `SessionCaptureCoordinator.engine` / `extractionQueue` are `private`; the
/// scenarios need the real objects (notification `object:` scoping, queue
/// occupancy), so they are read through `Mirror`, which reflects stored
/// properties regardless of access level. Reflection is read-only: nothing
/// here mutates production state behind the API.
enum AttackSupport {
  // MARK: Reflection

  static func storedProperty<T>(_ subject: Any, named name: String, as _: T.Type) -> T? {
    var mirror: Mirror? = Mirror(reflecting: subject)
    while let current = mirror {
      for child in current.children where child.label == name {
        return child.value as? T
      }
      mirror = current.superclassMirror
    }
    return nil
  }

  static func session(of engine: CameraEngine) throws -> AVCaptureSession {
    try XCTUnwrap(
      storedProperty(engine, named: "session", as: AVCaptureSession.self),
      "CameraEngine.session stored property not found via Mirror"
    )
  }

  static func movieOutput(of engine: CameraEngine) throws -> AVCaptureMovieFileOutput {
    try XCTUnwrap(
      storedProperty(engine, named: "movieOutput", as: AVCaptureMovieFileOutput.self),
      "CameraEngine.movieOutput stored property not found via Mirror"
    )
  }

  static func engine(of coordinator: SessionCaptureCoordinator) throws -> CameraEngine {
    try XCTUnwrap(
      storedProperty(coordinator, named: "engine", as: CameraEngine.self),
      "SessionCaptureCoordinator.engine stored property not found via Mirror"
    )
  }

  static func extractionQueue(of coordinator: SessionCaptureCoordinator) throws -> DispatchQueue {
    try XCTUnwrap(
      storedProperty(coordinator, named: "extractionQueue", as: DispatchQueue.self),
      "SessionCaptureCoordinator.extractionQueue stored property not found via Mirror"
    )
  }

  // MARK: Camera gating

  /// `AVCaptureDevice.requestAccess` from a process whose Info.plist lacks
  /// `NSCameraUsageDescription` is terminated by TCC (not a thrown error). The
  /// generic xctest host has no such key, so a permission prompt is only
  /// attempted when the status is already decided or the host declares the
  /// key; otherwise the test skips with the exact remedy.
  static func guardCameraPermissionPrompt(file: StaticString = #filePath, line: UInt = #line) throws {
    guard AVCaptureDevice.authorizationStatus(for: .video) == .notDetermined else { return }
    let usage = Bundle.main.object(forInfoDictionaryKey: "NSCameraUsageDescription") as? String
    if usage == nil || usage?.isEmpty == true {
      throw XCTSkip(
        "[device] camera permission is undetermined and the test host has no NSCameraUsageDescription — "
          + "pre-grant camera access to the xctest runner (or host the bundle in an app with the key) and re-run",
        file: file, line: line
      )
    }
  }

  /// Configures the engine or skips the test when this destination has no
  /// usable camera / no permission. Any OTHER error is a real failure.
  static func requireCamera(_ engine: CameraEngine, file: StaticString = #filePath, line: UInt = #line) async throws {
    guard hasAnyVideoDevice() else {
      throw XCTSkip("[device] no video capture device on this destination (iOS Simulator) — run on an attached iPhone", file: file, line: line)
    }
    try guardCameraPermissionPrompt(file: file, line: line)
    do {
      try await engine.requestPermissionAndConfigure()
    } catch let error as CameraEngine.EngineError {
      switch error {
      case .configurationFailed(let message):
        throw XCTSkip("[device] no usable camera on this destination (\(message)) — run on an attached iPhone", file: file, line: line)
      case .permissionDenied:
        throw XCTSkip("[device] camera permission denied on this destination — grant it in Settings and re-run", file: file, line: line)
      case .sessionNotRunning, .recordingAlreadyActive, .recordingFailed:
        XCTFail("unexpected engine error during configuration: \(error)", file: file, line: line)
        throw error
      }
    }
  }

  /// True when `requestPermissionAndConfigure` would fail for lack of a camera
  /// — used by `[sim]` tests that must assert the camera-less code path.
  static func hasAnyVideoDevice() -> Bool {
    AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back) != nil
      || AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .front) != nil
  }

  // MARK: Files

  static let sentinelBytes = Data("PICKLE-ATTACK-SENTINEL-\u{1F3D3}".utf8)

  static func scratchDirectory(_ tag: String) throws -> URL {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("camera-engine-attack-4", isDirectory: true)
      .appendingPathComponent(tag, isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    return directory
  }

  static func movieURL(_ tag: String, name: String = UUID().uuidString.lowercased()) throws -> URL {
    try scratchDirectory(tag).appendingPathComponent("\(name).mov")
  }

  static func fileIsSentinel(_ url: URL) -> Bool {
    guard let data = try? Data(contentsOf: url) else { return false }
    return data == sentinelBytes
  }

  // MARK: Waiting

  /// Polls `condition` until it holds or `timeout` elapses. Returns whether it
  /// held. Callbacks under test arrive on private AVFoundation / GCD queues;
  /// the recorder classes below publish them under a lock, so polling from the
  /// test thread is race-free. On the main thread the run loop is pumped so
  /// main-queue work (e.g. `sessionQueue` → main hops) can progress; off the
  /// main thread (async tests) a run loop with no sources would return
  /// immediately, so sleep instead of spinning.
  @discardableResult
  static func waitUntil(_ timeout: TimeInterval, _ condition: () -> Bool) -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
      if condition() { return true }
      if Thread.isMainThread {
        RunLoop.current.run(until: Date().addingTimeInterval(0.02))
      } else {
        Thread.sleep(forTimeInterval: 0.02)
      }
    }
    return condition()
  }

  /// Async variant for `async throws` tests.
  @discardableResult
  static func waitUntilAsync(_ timeout: TimeInterval, _ condition: @escaping () -> Bool) async -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
      if condition() { return true }
      try? await Task.sleep(nanoseconds: 20_000_000)
    }
    return condition()
  }

  // MARK: Seeded randomness

  /// SplitMix64 — deterministic across runs; the seed is printed by tests that
  /// use it so a failure can be replayed exactly.
  struct SeededGenerator: RandomNumberGenerator {
    private var state: UInt64
    init(seed: UInt64) { state = seed }
    mutating func next() -> UInt64 {
      state &+= 0x9E37_79B9_7F4A_7C15
      var z = state
      z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
      z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
      return z ^ (z >> 31)
    }
  }
}

/// Thread-safe recorder for `CameraEngine.onSessionEvent`.
final class SessionEventRecorder: @unchecked Sendable {
  private let lock = NSLock()
  private var storage: [CameraEngine.SessionEvent] = []

  var events: [CameraEngine.SessionEvent] {
    lock.lock()
    defer { lock.unlock() }
    return storage
  }

  func attach(to engine: CameraEngine) {
    engine.onSessionEvent = { [weak self] event in
      guard let self else { return }
      self.lock.lock()
      self.storage.append(event)
      self.lock.unlock()
    }
  }

  /// Compact, order-preserving description used in assertions/diagnostics.
  var descriptions: [String] { events.map(SessionEventRecorder.describe) }

  static func describe(_ event: CameraEngine.SessionEvent) -> String {
    switch event {
    case .configured: return "configured"
    case .starting: return "starting"
    case .running: return "running"
    case .stopped: return "stopped"
    case .interrupted(let reason): return "interrupted(\(reason))"
    case .interruptionEnded: return "interruptionEnded"
    case .failed(let message): return "failed(\(message))"
    }
  }
}

/// Thread-safe recorder for `CameraEngine.onRecordingFinished` /
/// `onRecordingStarted`.
final class RecordingRecorder: @unchecked Sendable {
  enum Outcome {
    case success(CameraEngine.RecordingArtifact)
    case engineError(CameraEngine.EngineError)
    case otherError(Error)

    var isRecordingAlreadyActive: Bool {
      if case .engineError(.recordingAlreadyActive) = self { return true }
      return false
    }

    var isSessionNotRunning: Bool {
      if case .engineError(.sessionNotRunning) = self { return true }
      return false
    }

    var isRecordingFailed: Bool {
      if case .engineError(.recordingFailed) = self { return true }
      return false
    }

    var isSuccess: Bool {
      if case .success = self { return true }
      return false
    }
  }

  private let lock = NSLock()
  private var finished: [Outcome] = []
  private var started: [URL] = []
  /// Snapshot of whether the file existed at each `didStartRecording` — the
  /// observation the pre-existing-file scenario needs at the exact moment
  /// recording begins.
  private var fileWasSentinelAtStart: [Bool] = []

  var outcomes: [Outcome] {
    lock.lock()
    defer { lock.unlock() }
    return finished
  }

  var startedURLs: [URL] {
    lock.lock()
    defer { lock.unlock() }
    return started
  }

  var sentinelSurvivedToStart: [Bool] {
    lock.lock()
    defer { lock.unlock() }
    return fileWasSentinelAtStart
  }

  func attach(to engine: CameraEngine) {
    engine.onRecordingStarted = { [weak self] url in
      guard let self else { return }
      let sentinel = AttackSupport.fileIsSentinel(url)
      self.lock.lock()
      self.started.append(url)
      self.fileWasSentinelAtStart.append(sentinel)
      self.lock.unlock()
    }
    engine.onRecordingFinished = { [weak self] result in
      guard let self else { return }
      let outcome: Outcome
      switch result {
      case .success(let artifact): outcome = .success(artifact)
      case .failure(let error as CameraEngine.EngineError): outcome = .engineError(error)
      case .failure(let error): outcome = .otherError(error)
      }
      self.lock.lock()
      self.finished.append(outcome)
      self.lock.unlock()
    }
  }
}

/// Captures a single `extract` completion together with WHEN it arrived
/// relative to the `extract` call returning — `invalidBounds` must be reported
/// synchronously (before dispatching anything), so `arrivedSynchronously`
/// distinguishes "rejected up front" from "accepted and later failed".
final class ExtractCompletionRecorder: @unchecked Sendable {
  private let lock = NSLock()
  private var result: Result<[String: Any], Error>?
  private var callReturned = false
  private var arrivedBeforeReturn = false

  var completion: (Result<[String: Any], Error>) -> Void {
    { [weak self] result in
      guard let self else { return }
      self.lock.lock()
      self.result = result
      self.arrivedBeforeReturn = !self.callReturned
      self.lock.unlock()
    }
  }

  func markCallReturned() {
    lock.lock()
    callReturned = true
    lock.unlock()
  }

  var received: Result<[String: Any], Error>? {
    lock.lock()
    defer { lock.unlock() }
    return result
  }

  var arrivedSynchronously: Bool {
    lock.lock()
    defer { lock.unlock() }
    return arrivedBeforeReturn
  }

  var coordinatorError: SessionCaptureCoordinator.CoordinatorError? {
    guard case .failure(let error)? = received else { return nil }
    return error as? SessionCaptureCoordinator.CoordinatorError
  }
}

extension SessionCaptureCoordinator.CoordinatorError {
  var isInvalidBounds: Bool {
    if case .invalidBounds = self { return true }
    return false
  }

  var isRecordingNotStarted: Bool {
    if case .recordingNotStarted = self { return true }
    return false
  }

  var isAlreadyStopped: Bool {
    if case .alreadyStopped = self { return true }
    return false
  }
}
