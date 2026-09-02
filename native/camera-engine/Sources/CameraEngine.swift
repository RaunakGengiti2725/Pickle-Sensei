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
    /// When set, the movie output writes QuickTime fragments at this interval
    /// so an IN-PROGRESS recording stays readable up to its last fragment
    /// boundary. Session capture needs this to cut per-event clips from the
    /// rolling recording without stopping it; guided capture leaves it nil
    /// (the default single-moov file, finalized on stop).
    public var movieFragmentSeconds: Double?

    public init(
      preset: AVCaptureSession.Preset = .hd1280x720,
      targetFps: Int = 60,
      maximumObservationSeconds: Double = 60,
      movieFragmentSeconds: Double? = nil
    ) {
      self.preset = preset
      self.targetFps = targetFps
      self.maximumObservationSeconds = maximumObservationSeconds
      self.movieFragmentSeconds = movieFragmentSeconds
    }
  }

  public struct RecordingArtifact: Sendable {
    public let url: URL
    /// Presentation timestamps from the video-data output, used to calculate a
    /// precise trim window relative to the automatically detected motion.
    public let firstFrameTimestampMs: Int
    public let lastFrameTimestampMs: Int
  }

  /// User-facing camera-control state for the ACTIVE camera. `displayZoom` is
  /// the familiar 0.5×/1×/2× scale (1× = the wide lens field of view)
  /// regardless of the virtual device's raw videoZoomFactor mapping.
  public struct ZoomState: Sendable {
    public let position: AVCaptureDevice.Position
    public let minDisplayZoom: CGFloat
    public let maxDisplayZoom: CGFloat
    public let displayZoom: CGFloat
    /// Apple Center Stage (FaceTime-style auto-framing). Supported is a
    /// hardware/format fact for the ACTIVE camera; enabled is the user's
    /// current choice. When active, the system owns framing and manual zoom
    /// is suspended.
    public let centerStageSupported: Bool
    public let centerStageEnabled: Bool
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

  private var activeInput: AVCaptureDeviceInput?
  private var activeDevice: AVCaptureDevice?
  private var cameraPosition: AVCaptureDevice.Position = .back
  /// videoZoomFactor that renders the wide (1×) field of view. On virtual
  /// dual-wide devices the ultra-wide is factor 1.0 and the wide sits at the
  /// first switch-over factor (typically 2.0); on plain devices it is 1.0.
  private var wideBaselineZoomFactor: CGFloat = 1
  /// Upper display-zoom cap: generous freedom without the unusable far tail
  /// of digital zoom (analysis needs pixels on the athlete, not mush).
  private static let maxDisplayZoomCap: CGFloat = 6

  /// Real frames stay native. Consumers should sample them for inference rather
  /// than forwarding pixel data across the React Native bridge.
  public var onFrame: ((CVPixelBuffer, Int) -> Void)?
  public var onSessionEvent: ((SessionEvent) -> Void)?
  public var onRecordingStarted: ((URL) -> Void)?
  public var onRecordingFinished: ((Result<RecordingArtifact, Error>) -> Void)?
  /// Fired on camera flips and zoom changes (main-thread hop is the caller's
  /// responsibility) so control surfaces can re-render their zoom clusters.
  public var onZoomStateChanged: ((ZoomState) -> Void)?

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

  /// Best available device for a position. The back prefers the dual-wide
  /// VIRTUAL device so zooming out to 0.5× (ultra-wide) is possible; both
  /// positions fall back to the plain wide camera.
  private static func bestDevice(for position: AVCaptureDevice.Position) -> AVCaptureDevice? {
    if position == .back,
       let dualWide = AVCaptureDevice.default(.builtInDualWideCamera, for: .video, position: .back) {
      return dualWide
    }
    return AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: position)
  }

  private func attachDeviceLocked(position: AVCaptureDevice.Position) throws {
    guard
      let device = Self.bestDevice(for: position),
      let input = try? AVCaptureDeviceInput(device: device),
      session.canAddInput(input)
    else {
      throw EngineError.configurationFailed(
        position == .back
          ? "No usable rear camera is available."
          : "No usable front camera is available."
      )
    }
    session.addInput(input)
    activeInput = input
    activeDevice = device
    cameraPosition = position
    wideBaselineZoomFactor = device.virtualDeviceSwitchOverVideoZoomFactors.first
      .map { CGFloat(truncating: $0) } ?? 1

    configureDeviceLocked(device)
    // Land on the 1× (wide) field of view, never the raw factor floor.
    applyZoomFactorLocked(wideBaselineZoomFactor, animated: false)
    applyCenterStagePreferenceLocked()
  }

  private func configureDeviceLocked(_ device: AVCaptureDevice) {
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
  }

  private func configureLocked() throws {
    guard !isConfigured else { return }
    session.beginConfiguration()
    defer { session.commitConfiguration() }

    if session.canSetSessionPreset(config.preset) {
      session.sessionPreset = config.preset
    }

    try attachDeviceLocked(position: .back)

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
    if let fragmentSeconds = config.movieFragmentSeconds, fragmentSeconds > 0 {
      movieOutput.movieFragmentInterval = CMTime(
        seconds: fragmentSeconds,
        preferredTimescale: 600
      )
    }

    applyConnectionPoliciesLocked()

    isConfigured = true
    installObservers()
    emit(.configured)
    // Control surfaces bind before configuration completes; publish the real
    // zoom bounds as soon as they exist so the cluster never renders from the
    // placeholder state.
    emitZoomState()
  }

  /// Orientation/stabilization/mirroring on the CURRENT connections. Must be
  /// re-applied after every input change: connections are recreated when the
  /// camera flips. Recorded media and analysis frames are NEVER mirrored —
  /// front-camera clips keep true left/right so handedness evidence stays
  /// honest (the preview layer alone mirrors, matching what users expect).
  private func applyConnectionPoliciesLocked() {
    if let dataConnection = videoOutput.connection(with: .video) {
      if dataConnection.isVideoOrientationSupported {
        dataConnection.videoOrientation = .portrait
      }
      if dataConnection.isVideoMirroringSupported {
        dataConnection.automaticallyAdjustsVideoMirroring = false
        dataConnection.isVideoMirrored = false
      }
    }
    if let movieConnection = movieOutput.connection(with: .video) {
      if movieConnection.isVideoOrientationSupported {
        movieConnection.videoOrientation = .portrait
      }
      if movieConnection.isVideoStabilizationSupported {
        movieConnection.preferredVideoStabilizationMode = .standard
      }
      if movieConnection.isVideoMirroringSupported {
        movieConnection.automaticallyAdjustsVideoMirroring = false
        movieConnection.isVideoMirrored = false
      }
    }
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

  // ── User camera controls (zoom / flip / Center Stage) ────────────────────
  // All control paths hop to the session queue; every change re-emits
  // onZoomStateChanged so control surfaces render from engine truth only.

  /// User preference for Apple Center Stage (FaceTime-style auto framing),
  /// persisted across sessions. Applied whenever a supporting camera is
  /// attached; hardware support is reported per active camera/format.
  private static let centerStagePreferenceKey = "pickle.camera.centerStagePreference"
  private static var centerStagePreferred: Bool {
    get { UserDefaults.standard.bool(forKey: centerStagePreferenceKey) }
    set { UserDefaults.standard.set(newValue, forKey: centerStagePreferenceKey) }
  }

  private func zoomStateLocked() -> ZoomState {
    guard let device = activeDevice else {
      return ZoomState(
        position: cameraPosition,
        minDisplayZoom: 1,
        maxDisplayZoom: 1,
        displayZoom: 1,
        centerStageSupported: false,
        centerStageEnabled: false
      )
    }
    let baseline = wideBaselineZoomFactor
    return ZoomState(
      position: cameraPosition,
      minDisplayZoom: device.minAvailableVideoZoomFactor / baseline,
      maxDisplayZoom: min(device.maxAvailableVideoZoomFactor / baseline, Self.maxDisplayZoomCap),
      displayZoom: device.videoZoomFactor / baseline,
      centerStageSupported: device.activeFormat.isCenterStageSupported
        || Self.deviceHasAnyCenterStageFormat(device),
      centerStageEnabled: AVCaptureDevice.isCenterStageEnabled && device.isCenterStageActive
    )
  }

  private static func deviceHasAnyCenterStageFormat(_ device: AVCaptureDevice) -> Bool {
    device.formats.contains { $0.isCenterStageSupported }
  }

  private func emitZoomState() {
    let state = zoomStateLocked()
    onZoomStateChanged?(state)
  }

  /// Snapshot for control-surface setup (dispatches to the session queue).
  public func readZoomState(_ completion: @escaping (ZoomState) -> Void) {
    sessionQueue.async { completion(self.zoomStateLocked()) }
  }

  /// Sets zoom on the familiar display scale (1× = wide field of view;
  /// 0.5× = ultra-wide when the hardware has it). Clamped to real bounds.
  /// Ignored while Center Stage actively owns framing.
  public func setDisplayZoom(_ displayZoom: CGFloat, animated: Bool) {
    sessionQueue.async {
      guard let device = self.activeDevice else { return }
      if AVCaptureDevice.isCenterStageEnabled && device.isCenterStageActive { return }
      self.applyZoomFactorLocked(displayZoom * self.wideBaselineZoomFactor, animated: animated)
      self.emitZoomState()
    }
  }

  private func applyZoomFactorLocked(_ rawFactor: CGFloat, animated: Bool) {
    guard let device = activeDevice else { return }
    let clamped = max(
      device.minAvailableVideoZoomFactor,
      min(rawFactor, min(device.maxAvailableVideoZoomFactor, Self.maxDisplayZoomCap * wideBaselineZoomFactor))
    )
    do {
      try device.lockForConfiguration()
      if animated {
        device.ramp(toVideoZoomFactor: clamped, withRate: 6)
      } else {
        device.videoZoomFactor = clamped
      }
      device.unlockForConfiguration()
    } catch {
      // Zoom is a convenience; a refused configuration lock never fails capture.
    }
  }

  /// Flips between the rear and front cameras. REFUSED while a movie is
  /// recording — a lens switch mid-file invalidates the evidence chain; use
  /// `flipCameraRestartingSpool` when a rolling observation is active.
  public func switchCamera(to position: AVCaptureDevice.Position) {
    sessionQueue.async {
      guard !self.movieOutput.isRecording else { return }
      self.performCameraSwitchLocked(to: position)
      self.emitZoomState()
    }
  }

  /// Guarded by `recordingLock`: a camera flip requested while the rolling
  /// spool records. The suppressed recording-finish callback performs the
  /// switch and restarts the spool at `url`, so the evidence chain contains
  /// only whole single-camera files.
  private var pendingSpoolRestart: (position: AVCaptureDevice.Position, url: URL)?

  /// One call flips the camera even mid-spool: stops the current rolling
  /// recording (suppressing its finish callback and discarding its file),
  /// switches the camera, and restarts the spool into `nextRecordingURL`.
  /// When no recording is active it degrades to a plain switch + restart.
  public func flipCameraRestartingSpool(
    to position: AVCaptureDevice.Position,
    nextRecordingURL: URL
  ) {
    sessionQueue.async {
      if self.movieOutput.isRecording {
        self.recordingLock.lock()
        self.suppressNextRecordingFinish = true
        self.pendingSpoolRestart = (position, nextRecordingURL)
        self.recordingLock.unlock()
        self.movieOutput.stopRecording()
      } else {
        self.performCameraSwitchLocked(to: position)
        self.emitZoomState()
        self.startContinuousRecording(to: nextRecordingURL)
      }
    }
  }

  private func performCameraSwitchLocked(to position: AVCaptureDevice.Position) {
    guard isConfigured, position != cameraPosition, let previousInput = activeInput else { return }

    session.beginConfiguration()
    session.removeInput(previousInput)
    do {
      try attachDeviceLocked(position: position)
    } catch {
      // Restore the previous camera rather than dying half-configured.
      if session.canAddInput(previousInput) {
        session.addInput(previousInput)
        activeInput = previousInput
        activeDevice = previousInput.device
        cameraPosition = previousInput.device.position
      }
      session.commitConfiguration()
      emit(.failed("The \(position == .front ? "front" : "rear") camera is unavailable."))
      return
    }
    applyConnectionPoliciesLocked()
    session.commitConfiguration()
  }

  /// Enables/disables Center Stage (user choice, persisted). When the active
  /// camera's current format cannot run it, a compatible format is adopted
  /// (the user explicitly chose follow-me framing over the locked default);
  /// disabling restores the configured fps policy on the default format path.
  public func setCenterStageEnabled(_ enabled: Bool) {
    sessionQueue.async {
      Self.centerStagePreferred = enabled
      self.applyCenterStagePreferenceLocked()
      self.emitZoomState()
    }
  }

  private func applyCenterStagePreferenceLocked() {
    guard let device = activeDevice else { return }
    AVCaptureDevice.centerStageControlMode = .app
    let wantsCenterStage = Self.centerStagePreferred

    if wantsCenterStage, !device.activeFormat.isCenterStageSupported {
      // Adopt the best Center-Stage-capable format: prefer ≥60 fps, then the
      // highest supported rate, at 720p-or-better dimensions when available.
      let candidates = device.formats.filter { $0.isCenterStageSupported }
      let best = candidates.max { lhs, rhs in
        func score(_ format: AVCaptureDevice.Format) -> (Double, Int32) {
          let maxRate = format.videoSupportedFrameRateRanges.map(\.maxFrameRate).max() ?? 0
          let dims = CMVideoFormatDescriptionGetDimensions(format.formatDescription)
          return (min(maxRate, Double(self.config.targetFps)), dims.height)
        }
        return score(lhs) < score(rhs)
      }
      if let best {
        do {
          try device.lockForConfiguration()
          device.activeFormat = best
          let rate = min(
            Double(config.targetFps),
            best.videoSupportedFrameRateRanges.map(\.maxFrameRate).max() ?? 30
          )
          device.activeVideoMinFrameDuration = CMTime(value: 1, timescale: CMTimeScale(rate))
          device.activeVideoMaxFrameDuration = CMTime(value: 1, timescale: CMTimeScale(rate))
          device.unlockForConfiguration()
        } catch {
          // Format adoption is best-effort; support is re-reported below.
        }
      }
    }

    AVCaptureDevice.isCenterStageEnabled =
      wantsCenterStage && device.activeFormat.isCenterStageSupported
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

  /// Guarded by `recordingLock` (the delegate fires on the movie output's
  /// private queue, not the session queue).
  private var suppressNextRecordingFinish = false

  /// Arms a one-shot suppression of the NEXT recording-finished callback and
  /// deletes its file: used when a camera flip intentionally restarts the
  /// rolling observation spool. Without this, the controller would read the
  /// stop as a finished capture and fail with "no stroke detected".
  public func suppressNextRecordingFinishAndDiscard() {
    recordingLock.lock()
    suppressNextRecordingFinish = true
    recordingLock.unlock()
  }

  /// Stops the rolling spool IF one is active and discards its file without
  /// invoking `onRecordingFinished` (the shutter's stop / an observation
  /// timeout: the user simply wants another go). Decided on the session
  /// queue against the movie output's real state, so the one-shot
  /// suppression can never be armed while nothing records and swallow a
  /// later, real capture's finish. A no-op when nothing is recording.
  public func discardActiveRecording() {
    sessionQueue.async {
      guard self.movieOutput.isRecording else { return }
      self.recordingLock.lock()
      self.suppressNextRecordingFinish = true
      self.recordingLock.unlock()
      self.movieOutput.stopRecording()
    }
  }

  public var currentRecordingFirstFrameTimestampMs: Int? {
    recordingLock.lock()
    defer { recordingLock.unlock() }
    return recordingFirstFrameTimestampMs
  }

  public var currentRecordingLastFrameTimestampMs: Int? {
    recordingLock.lock()
    defer { recordingLock.unlock() }
    return recordingLastFrameTimestampMs
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

    recordingLock.lock()
    let suppressed = suppressNextRecordingFinish
    let spoolRestart = pendingSpoolRestart
    suppressNextRecordingFinish = false
    pendingSpoolRestart = nil
    recordingLock.unlock()
    if suppressed {
      try? FileManager.default.removeItem(at: outputFileURL)
      if let spoolRestart {
        sessionQueue.async {
          self.performCameraSwitchLocked(to: spoolRestart.position)
          self.emitZoomState()
        }
        startContinuousRecording(to: spoolRestart.url)
      }
      return
    }

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
