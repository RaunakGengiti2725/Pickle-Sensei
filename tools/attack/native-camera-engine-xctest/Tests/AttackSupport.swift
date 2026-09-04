// Shared helpers for the camera-engine attack suite. Every probe that needs
// randomness draws from `AttackSeed.value` (recorded in README.md) so a red
// run is replayable bit-for-bit.
import AVFoundation
import Foundation
import XCTest

@testable import PickleCameraEngineUnderTest

enum AttackSeed {
  /// SplitMix64 seed shared by every randomized probe in this bundle.
  static let value: UInt64 = 0x5EED_CA3E_4D81_2E1A
}

/// SplitMix64 — tiny, deterministic, good enough for shuffles and ids.
struct SeededGenerator: RandomNumberGenerator {
  private var state: UInt64

  init(seed: UInt64 = AttackSeed.value) {
    state = seed
  }

  mutating func next() -> UInt64 {
    state &+= 0x9E37_79B9_7F4A_7C15
    var z = state
    z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
    z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
    return z ^ (z >> 31)
  }
}

extension CameraEngine.SessionEvent {
  /// Stable textual form (the enum is not Equatable in production).
  var attackLabel: String {
    switch self {
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

/// Thread-safe recorder for `onSessionEvent` / `onRecordingFinished`.
final class EngineCallbackRecorder: @unchecked Sendable {
  private let lock = NSLock()
  private var sessionEvents: [CameraEngine.SessionEvent] = []
  private var recordingResults: [Result<CameraEngine.RecordingArtifact, Error>] = []
  private var recordingStartedURLs: [URL] = []
  private var zoomStates: [CameraEngine.ZoomState] = []

  /// Fulfilled once per session event so tests can await the FIRST one
  /// without sleeping; further events keep accumulating in `events`.
  var onAnySessionEvent: (() -> Void)?
  var onAnyRecordingResult: (() -> Void)?

  func attach(to engine: CameraEngine) {
    engine.onSessionEvent = { [weak self] event in
      guard let self else { return }
      self.lock.lock()
      self.sessionEvents.append(event)
      self.lock.unlock()
      self.onAnySessionEvent?()
    }
    engine.onRecordingFinished = { [weak self] result in
      guard let self else { return }
      self.lock.lock()
      self.recordingResults.append(result)
      self.lock.unlock()
      self.onAnyRecordingResult?()
    }
    engine.onRecordingStarted = { [weak self] url in
      guard let self else { return }
      self.lock.lock()
      self.recordingStartedURLs.append(url)
      self.lock.unlock()
    }
    engine.onZoomStateChanged = { [weak self] state in
      guard let self else { return }
      self.lock.lock()
      self.zoomStates.append(state)
      self.lock.unlock()
    }
  }

  var events: [CameraEngine.SessionEvent] {
    lock.lock()
    defer { lock.unlock() }
    return sessionEvents
  }

  var eventLabels: [String] { events.map(\.attackLabel) }

  var results: [Result<CameraEngine.RecordingArtifact, Error>] {
    lock.lock()
    defer { lock.unlock() }
    return recordingResults
  }

  var startedURLs: [URL] {
    lock.lock()
    defer { lock.unlock() }
    return recordingStartedURLs
  }

  var zoomStateCount: Int {
    lock.lock()
    defer { lock.unlock() }
    return zoomStates.count
  }
}

extension CameraEngine {
  /// Session-queue barrier. Every public entry point of the engine hops to
  /// the SAME serial `sessionQueue`; `readZoomState` does too, so once its
  /// completion has fired every block enqueued before it has finished. This
  /// is how the suite asserts "exactly N events, nothing else" without
  /// sleeping.
  func attackDrainSessionQueue(
    timeout: TimeInterval = 5,
    file: StaticString = #filePath,
    line: UInt = #line
  ) {
    let drained = XCTestExpectation(description: "session queue drained")
    readZoomState { _ in drained.fulfill() }
    let outcome = XCTWaiter().wait(for: [drained], timeout: timeout)
    XCTAssertEqual(outcome, .completed, "session queue did not drain in \(timeout)s", file: file, line: line)
  }
}

enum CameraPlane {
  static var hasRearCamera: Bool {
    AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back) != nil
  }

  static var isAuthorized: Bool {
    AVCaptureDevice.authorizationStatus(for: .video) == .authorized
  }

  /// Device-plane gate. The iOS Simulator has no capture devices, so every
  /// test that needs a CONFIGURED engine (a real AVCaptureDeviceInput) is
  /// skipped there — XCTSkip, never a silent pass. On a device the run must
  /// already hold camera permission (the test bundle cannot answer the TCC
  /// prompt).
  static func skipUnlessCameraAvailable(
    file: StaticString = #filePath,
    line: UInt = #line
  ) throws {
    guard hasRearCamera else {
      throw XCTSkip(
        "DEVICE-PLANE ONLY: no rear capture device on this destination (iOS Simulator) — "
          + "run on an iPhone to execute", file: file, line: line
      )
    }
    guard isAuthorized else {
      throw XCTSkip(
        "DEVICE-PLANE ONLY: camera permission is not .authorized for the test host "
          + "(status \(AVCaptureDevice.authorizationStatus(for: .video).rawValue))",
        file: file, line: line
      )
    }
  }

  /// Configures a fresh engine on the device plane (skips elsewhere).
  static func configuredEngine(
    config: CameraEngine.Config = CameraEngine.Config(),
    recorder: EngineCallbackRecorder? = nil,
    file: StaticString = #filePath,
    line: UInt = #line
  ) async throws -> CameraEngine {
    try skipUnlessCameraAvailable(file: file, line: line)
    let engine = CameraEngine(config: config)
    recorder?.attach(to: engine)
    try await engine.configureAuthorizedSession()
    return engine
  }
}

enum AttackFiles {
  static func temporaryURL(_ name: String, ext: String = "mov") -> URL {
    let dir = FileManager.default.temporaryDirectory
      .appendingPathComponent("camera-engine-attack-\(UUID().uuidString.lowercased())", isDirectory: true)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir.appendingPathComponent("\(name).\(ext)")
  }

  static func removeParent(of url: URL) {
    try? FileManager.default.removeItem(at: url.deletingLastPathComponent())
  }
}

/// Milliseconds since an arbitrary monotonic origin.
func attackNowMs() -> Double {
  Double(DispatchTime.now().uptimeNanoseconds) / 1_000_000
}
