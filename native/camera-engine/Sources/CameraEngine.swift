import AVFoundation
import Foundation

/// CameraEngine (directive §13, spec pp. 35–36): owns the capture session and
/// a rolling frame buffer so a detected stroke can preserve ~2.0s of
/// pre-trigger context without ever crossing the JS boundary.
public final class CameraEngine: NSObject {
  public enum EngineError: Error {
    case permissionDenied
    case configurationFailed(String)
  }

  public struct Config {
    public var preset: AVCaptureSession.Preset
    public var targetFps: Int
    public var rollingBufferSeconds: Double

    public init(preset: AVCaptureSession.Preset = .hd1280x720, targetFps: Int = 60, rollingBufferSeconds: Double = 2.0) {
      self.preset = preset
      self.targetFps = targetFps
      self.rollingBufferSeconds = rollingBufferSeconds
    }
  }

  private let session = AVCaptureSession()
  private let videoOutput = AVCaptureVideoDataOutput()
  private let processingQueue = DispatchQueue(label: "pickle.camera.frames", qos: .userInteractive)
  private let config: Config

  /// Ring buffer of retained recent frames (timestampMs, buffer).
  private var ring: [(timestampMs: Int, buffer: CVPixelBuffer)] = []
  private let ringLock = NSLock()

  /// Downstream consumer — VisionCore's frame loop.
  public var onFrame: ((CVPixelBuffer, Int) -> Void)?

  public init(config: Config = Config()) {
    self.config = config
    super.init()
  }

  public func requestPermissionAndConfigure() async throws {
    let granted = await AVCaptureDevice.requestAccess(for: .video)
    guard granted else { throw EngineError.permissionDenied }
    try configure()
  }

  private func configure() throws {
    session.beginConfiguration()
    session.sessionPreset = config.preset
    guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back),
          let input = try? AVCaptureDeviceInput(device: device),
          session.canAddInput(input) else {
      session.commitConfiguration()
      throw EngineError.configurationFailed("no usable back camera")
    }
    session.addInput(input)

    // Lock frame duration to the target FPS when the format supports it.
    if let range = device.activeFormat.videoSupportedFrameRateRanges.first,
       Double(config.targetFps) <= range.maxFrameRate {
      try? device.lockForConfiguration()
      device.activeVideoMinFrameDuration = CMTime(value: 1, timescale: CMTimeScale(config.targetFps))
      device.activeVideoMaxFrameDuration = CMTime(value: 1, timescale: CMTimeScale(config.targetFps))
      device.unlockForConfiguration()
    }

    videoOutput.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange]
    videoOutput.alwaysDiscardsLateVideoFrames = true
    videoOutput.setSampleBufferDelegate(self, queue: processingQueue)
    guard session.canAddOutput(videoOutput) else {
      session.commitConfiguration()
      throw EngineError.configurationFailed("cannot add video output")
    }
    session.addOutput(videoOutput)
    session.commitConfiguration()
  }

  public func start() {
    processingQueue.async { [session] in
      if !session.isRunning { session.startRunning() }
    }
  }

  public func stop() {
    processingQueue.async { [session] in
      if session.isRunning { session.stopRunning() }
    }
  }

  /// Frames covering [nowMs - pre, nowMs + 0] for a triggered stroke window.
  public func snapshotWindow(fromMs: Int, toMs: Int) -> [(timestampMs: Int, buffer: CVPixelBuffer)] {
    ringLock.lock()
    defer { ringLock.unlock() }
    return ring.filter { $0.timestampMs >= fromMs && $0.timestampMs <= toMs }
  }
}

extension CameraEngine: AVCaptureVideoDataOutputSampleBufferDelegate {
  public func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
    guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
    let timestampMs = Int(CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sampleBuffer)) * 1000)

    ringLock.lock()
    ring.append((timestampMs, pixelBuffer))
    let cutoff = timestampMs - Int(config.rollingBufferSeconds * 1000)
    while let first = ring.first, first.timestampMs < cutoff {
      ring.removeFirst()
    }
    ringLock.unlock()

    onFrame?(pixelBuffer, timestampMs)
  }
}
