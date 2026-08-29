import AVFoundation
import Foundation

/// Owns the real AVFoundation session used by guided capture. Pre-trigger video
/// is preserved by continuously spooling to a private temporary movie while
/// the athlete is framed; a completed stroke is trimmed to its requested
/// pre/post window by the bridge. This avoids retaining hundreds of megabytes
/// of raw pixel buffers in memory while providing the same rolling-window
/// guarantee.
public final class CameraEngine: NSObject, @unchecked Sendable {
  public enum EngineError: LocalizedError {
    case permissionDenied
    case configurationFailed(String)
    case sessionNotRunning
    case recordingAlreadyActive
    case recordingFailed(String)

    public var errorDescription: String? {
      switch self {
      case .permissionDenied:
        return "Camera access is required for guided capture."
      case .configurationFailed(let message), .recordingFailed(let message):
        return message
      case .sessionNotRunning:
        return "The camera session is not running."
      case .recordingAlreadyActive:
        return "A camera recording is already active."
      }
    }
  }

  public enum SessionEvent: Sendable {
    case configured
    case starting
    case running
    case stopped
    case interrupted(String)
    case interruptionEnded
    case failed(String)
  }

  public struct Config {
    public var preset: AVCaptureSession.Preset
    public var targetFps: Int
    public var maximumObservationSeconds: Double

    public init(
      preset: AVCaptureSession.Preset = .hd1280x720,
      targetFps: Int = 60,
      maximumObservationSeconds: Double = 60
    ) {
      self.preset = preset
      self.targetFps = targetFps
      self.maximumObservationSeconds = maximumObservationSeconds
    }
  }

  public struct RecordingArtifact: Sendable {
    public let url: URL
    /// Presentation timestamps from the video-data output, used to calculate a
    /// precise trim window relative to the automatically detected motion.
    public let firstFrameTimestampMs: Int
    public let lastFrameTimestampMs: Int
  }

  private let session = AVCaptureSession()
  private let videoOutput = AVCaptureVideoDataOutput()
  private let movieOutput = AVCaptureMovieFileOutput()
  private let sessionQueue = DispatchQueue(label: "pickle.camera.session", qos: .userInitiated)
  private let frameQueue = DispatchQueue(label: "pickle.camera.frames", qos: .userInteractive)
  private let recordingLock = NSLock()
  private let config: Config

  private var isConfigured = false
  private var recordingFirstFrameTimestampMs: Int?
  private var recordingLastFrameTimestampMs: Int?
  private var activeRecordingURL: URL?
  private var observersInstalled = false

  /// Real frames stay native. Consumers should sample them for inference rather
  /// than forwarding pixel data across the React Native bridge.
  public var onFrame: ((CVPixelBuffer, Int) -> Void)?
  public var onSessionEvent: ((SessionEvent) -> Void)?
  public var onRecordingStarted: ((URL) -> Void)?
  public var onRecordingFinished: ((Result<RecordingArtifact, Error>) -> Void)?

  public init(config: Config = Config()) {
    self.config = config
    super.init()
  }

  deinit {
    removeObservers()
  }

  public func requestPermissionAndConfigure() async throws {
    let granted: Bool
    switch AVCaptureDevice.authorizationStatus(for: .video) {
    case .authorized:
      granted = true
    case .notDetermined:
      granted = await withCheckedContinuation { continuation in
        AVCaptureDevice.requestAccess(for: .video) { continuation.resume(returning: $0) }
      }
    case .denied, .restricted:
      granted = false
    @unknown default:
      granted = false
    }
    guard granted else { throw EngineError.permissionDenied }
    try await configureAuthorizedSession()
  }

  public func configureAuthorizedSession() async throws {
    try await withCheckedThrowingContinuation { continuation in
      sessionQueue.async {
        do {
          try self.configureLocked()
          continuation.resume()
        } catch {
          continuation.resume(throwing: error)
        }
      }
    }
  }

  private func configureLocked() throws {
    guard !isConfigured else { return }
    session.beginConfiguration()
    defer { session.commitConfiguration() }

    if session.canSetSessionPreset(config.preset) {
      session.sessionPreset = config.preset
    }

    guard
      let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back),
      let input = try? AVCaptureDeviceInput(device: device),
      session.canAddInput(input)
    else {
      throw EngineError.configurationFailed("No usable rear camera is available.")
    }
    session.addInput(input)

    if device.activeFormat.videoSupportedFrameRateRanges.contains(where: {
      Double(config.targetFps) >= $0.minFrameRate && Double(config.targetFps) <= $0.maxFrameRate
    }) {
      do {
        try device.lockForConfiguration()
        device.activeVideoMinFrameDuration = CMTime(value: 1, timescale: CMTimeScale(config.targetFps))
        device.activeVideoMaxFrameDuration = CMTime(value: 1, timescale: CMTimeScale(config.targetFps))
        if device.isFocusModeSupported(.continuousAutoFocus) {
          device.focusMode = .continuousAutoFocus
        }
        if device.isExposureModeSupported(.continuousAutoExposure) {
          device.exposureMode = .continuousAutoExposure
        }
        device.unlockForConfiguration()
      } catch {
        // A supported preset remains usable even if this device refuses an FPS
        // lock. Measured FPS is returned with the final media.
      }
    }

    videoOutput.videoSettings = [
      kCVPixelBufferPixelFormatTypeKey as String:
        kCVPixelFormatType_420YpCbCr8BiPlanarFullRange,
    ]
    videoOutput.alwaysDiscardsLateVideoFrames = true
    videoOutput.setSampleBufferDelegate(self, queue: frameQueue)
    guard session.canAddOutput(videoOutput) else {
      throw EngineError.configurationFailed("The camera cannot provide analysis frames.")
    }
    session.addOutput(videoOutput)

    guard session.canAddOutput(movieOutput) else {
      throw EngineError.configurationFailed("The camera cannot record guided video.")
    }
    session.addOutput(movieOutput)
    movieOutput.maxRecordedDuration = CMTime(
      seconds: config.maximumObservationSeconds,
      preferredTimescale: 600
    )

    if let dataConnection = videoOutput.connection(with: .video), dataConnection.isVideoOrientationSupported {
      dataConnection.videoOrientation = .portrait
    }
    if let movieConnection = movieOutput.connection(with: .video) {
      if movieConnection.isVideoOrientationSupported {
        movieConnection.videoOrientation = .portrait
      }
      if movieConnection.isVideoStabilizationSupported {
        movieConnection.preferredVideoStabilizationMode = .standard
      }
    }

    isConfigured = true
    installObservers()
    emit(.configured)
  }

  public func makePreviewLayer() -> AVCaptureVideoPreviewLayer {
    let layer = AVCaptureVideoPreviewLayer(session: session)
    layer.videoGravity = .resizeAspectFill
    if let connection = layer.connection, connection.isVideoOrientationSupported {
      connection.videoOrientation = .portrait
    }
    return layer
  }

  public func start() {
    sessionQueue.async {
      guard self.isConfigured else {
        self.emit(.failed("The camera session is not configured."))
        return
      }
      self.emit(.starting)
      if !self.session.isRunning { self.session.startRunning() }
      self.emit(self.session.isRunning ? .running : .failed("The camera session could not start."))
    }
  }

  public func stop() {
    sessionQueue.async {
      let wasRecording = self.movieOutput.isRecording
      if wasRecording { self.movieOutput.stopRecording() }
      if self.session.isRunning { self.session.stopRunning() }
      self.emit(.stopped)
      // A recording delegate still needs the timestamps after stopRecording.
      // It owns cleanup when a movie was active.
      if !wasRecording { self.clearRecordingTimestamps() }
    }
  }

  public func startContinuousRecording(to url: URL) {
    sessionQueue.async {
      guard self.session.isRunning else {
        self.onRecordingFinished?(.failure(EngineError.sessionNotRunning))
        return
      }
      guard !self.movieOutput.isRecording else {
        self.onRecordingFinished?(.failure(EngineError.recordingAlreadyActive))
        return
      }
      do {
        if FileManager.default.fileExists(atPath: url.path) {
          try FileManager.default.removeItem(at: url)
        }
      } catch {
        self.onRecordingFinished?(.failure(error))
        return
      }
      self.recordingLock.lock()
      self.recordingFirstFrameTimestampMs = nil
      self.recordingLastFrameTimestampMs = nil
      self.activeRecordingURL = url
      self.recordingLock.unlock()
      self.movieOutput.startRecording(to: url, recordingDelegate: self)
    }
  }

  public func stopContinuousRecording() {
    sessionQueue.async {
      if self.movieOutput.isRecording { self.movieOutput.stopRecording() }
    }
  }

  public var currentRecordingFirstFrameTimestampMs: Int? {
    recordingLock.lock()
    defer { recordingLock.unlock() }
    return recordingFirstFrameTimestampMs
  }

  private func clearRecordingTimestamps() {
    recordingLock.lock()
    recordingFirstFrameTimestampMs = nil
    recordingLastFrameTimestampMs = nil
    activeRecordingURL = nil
    recordingLock.unlock()
  }

  private func installObservers() {
    guard !observersInstalled else { return }
    observersInstalled = true
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(sessionWasInterrupted(_:)),
      name: .AVCaptureSessionWasInterrupted,
      object: session
    )
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(sessionInterruptionEnded(_:)),
      name: .AVCaptureSessionInterruptionEnded,
      object: session
    )
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(sessionRuntimeError(_:)),
      name: .AVCaptureSessionRuntimeError,
      object: session
    )
  }

  private func removeObservers() {
    guard observersInstalled else { return }
    NotificationCenter.default.removeObserver(self)
    observersInstalled = false
  }

  @objc private func sessionWasInterrupted(_ notification: Notification) {
    let reason: String
    if let raw = notification.userInfo?[AVCaptureSessionInterruptionReasonKey] as? NSNumber,
       let interruption = AVCaptureSession.InterruptionReason(rawValue: raw.intValue) {
      reason = String(describing: interruption)
    } else {
      reason = "unknown"
    }
    emit(.interrupted(reason))
  }

  @objc private func sessionInterruptionEnded(_ notification: Notification) {
    emit(.interruptionEnded)
  }

  @objc private func sessionRuntimeError(_ notification: Notification) {
    let message = (notification.userInfo?[AVCaptureSessionErrorKey] as? Error)?.localizedDescription
      ?? "The camera session failed."
    emit(.failed(message))
  }

  private func emit(_ event: SessionEvent) {
    onSessionEvent?(event)
  }
}

extension CameraEngine: AVCaptureVideoDataOutputSampleBufferDelegate {
  public func captureOutput(
    _ output: AVCaptureOutput,
    didOutput sampleBuffer: CMSampleBuffer,
    from connection: AVCaptureConnection
  ) {
    guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
    let presentationTime = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
    guard presentationTime.isValid else { return }
    let timestampMs = Int((CMTimeGetSeconds(presentationTime) * 1000).rounded())

    if movieOutput.isRecording {
      recordingLock.lock()
      if recordingFirstFrameTimestampMs == nil { recordingFirstFrameTimestampMs = timestampMs }
      recordingLastFrameTimestampMs = timestampMs
      recordingLock.unlock()
    }
    onFrame?(pixelBuffer, timestampMs)
  }
}

extension CameraEngine: AVCaptureFileOutputRecordingDelegate {
  public func fileOutput(
    _ output: AVCaptureFileOutput,
    didStartRecordingTo fileURL: URL,
    from connections: [AVCaptureConnection]
  ) {
    onRecordingStarted?(fileURL)
  }

  public func fileOutput(
    _ output: AVCaptureFileOutput,
    didFinishRecordingTo outputFileURL: URL,
    from connections: [AVCaptureConnection],
    error: Error?
  ) {
    recordingLock.lock()
    let first = recordingFirstFrameTimestampMs
    let last = recordingLastFrameTimestampMs
    recordingFirstFrameTimestampMs = nil
    recordingLastFrameTimestampMs = nil
    activeRecordingURL = nil
    recordingLock.unlock()

    if let error {
      let nsError = error as NSError
      // AVCaptureMovieFileOutput reports a non-fatal max-duration completion as
      // an error carrying this key. The file is still valid and is handled as a
      // timeout by the guided coordinator.
      if (nsError.userInfo[AVErrorRecordingSuccessfullyFinishedKey] as? Bool) != true {
        try? FileManager.default.removeItem(at: outputFileURL)
        onRecordingFinished?(.failure(error))
        return
      }
    }
    guard let first, let last, last > first else {
      try? FileManager.default.removeItem(at: outputFileURL)
      onRecordingFinished?(.failure(EngineError.recordingFailed("No valid camera frames were recorded.")))
      return
    }
    onRecordingFinished?(.success(
      RecordingArtifact(
        url: outputFileURL,
        firstFrameTimestampMs: first,
        lastFrameTimestampMs: last
      )
    ))
  }
}
