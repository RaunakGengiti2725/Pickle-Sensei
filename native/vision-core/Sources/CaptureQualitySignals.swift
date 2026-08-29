import Foundation

/// CaptureQualitySignalsV1 — native mirror of the typed capture-quality
/// contract in apps/mobile/src/camera/capture.ts (CaptureQualitySignalsV1,
/// emitted over the `capture_quality` camera event).
///
/// STATUS: CONTRACT-ONLY, UNVERIFIED-ON-DEVICE. No emitter is wired in this
/// build: this file defines the shape and the measurement obligations, and
/// has never been compiled against a device camera session or validated on
/// hardware. Wiring it up requires a Mac + physical device.
///
/// Measurement obligations for a future emitter:
/// - `frameWidthPx` / `frameHeightPx` / `avgFrameRateFps` come from the
///   configured AVCaptureDevice format — real configuration values, never
///   assumed defaults.
/// - `brightnessMeanLuma`, `laplacianVarianceMedian` and `meanAbsFrameDiff`
///   are computed over sampled preview frames normalized EXACTLY like the
///   offline prober (grayscale, 320px-wide downscale) so the shared
///   `capture-envelope-thresholds-v0.1-provisional` thresholds apply.
/// - Any signal the emitter cannot compute MUST be nil; the JS envelope
///   checker reports that dimension NOT_MEASURED. Fabricating a value here
///   would silently turn poor input into a supported verdict.
public struct CaptureQualitySignalsV1: Sendable {
  public let schemaVersion: Int
  /// Configured capture format, physical pixels.
  public let frameWidthPx: Int?
  public let frameHeightPx: Int?
  /// Configured (or measured over the sample window) capture frame rate.
  public let avgFrameRateFps: Double?
  /// Mean luma (0–255) over sampled normalized preview frames.
  public let brightnessMeanLuma: Double?
  /// Median Laplacian variance over sampled normalized preview frames.
  public let laplacianVarianceMedian: Double?
  /// Mean abs per-pixel luma diff between consecutive sampled frames.
  public let meanAbsFrameDiff: Double?
  /// Number of preview frames the proxies were computed over.
  public let sampledFrameCount: Int

  public init(
    frameWidthPx: Int?,
    frameHeightPx: Int?,
    avgFrameRateFps: Double?,
    brightnessMeanLuma: Double?,
    laplacianVarianceMedian: Double?,
    meanAbsFrameDiff: Double?,
    sampledFrameCount: Int
  ) {
    self.schemaVersion = 1
    self.frameWidthPx = frameWidthPx
    self.frameHeightPx = frameHeightPx
    self.avgFrameRateFps = avgFrameRateFps
    self.brightnessMeanLuma = brightnessMeanLuma
    self.laplacianVarianceMedian = laplacianVarianceMedian
    self.meanAbsFrameDiff = meanAbsFrameDiff
    self.sampledFrameCount = sampledFrameCount
  }
}
