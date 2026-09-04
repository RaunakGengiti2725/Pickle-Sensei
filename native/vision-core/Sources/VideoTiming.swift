import Foundation

/// Frame cadence measured from sample presentation timestamps, independent of
/// whatever the container DECLARES. A track's `nominalFrameRate` is metadata
/// the demuxer chooses to believe (an AV1 fresh-candidate clip declared 12 fps
/// and a 2× duration for a 24 fps / 60.9 s source); the sample timestamps are
/// what the decoder actually delivered, so every writer of `video.fps` /
/// `durationMs` derives them here and records the declared value beside them.
public struct VideoCadence: Equatable, Sendable {
  /// Typical interval between consecutive samples, in milliseconds: the mean
  /// of the intervals within ±1 ms of the median (integer-ms stamps of a
  /// 59.94 fps capture alternate 16/17 ms; their mean is the true 16.68).
  public let intervalMs: Double
  /// `1000 / intervalMs`.
  public let fps: Double
  /// Number of intervals the median was taken over.
  public let intervalCount: Int

  public init(intervalMs: Double, intervalCount: Int) {
    self.intervalMs = intervalMs
    self.fps = 1000 / intervalMs
    self.intervalCount = intervalCount
  }
}

/// Wire-level provenance of a `video.fps` value (mirrors
/// `PoseFpsSource` in `@pickle/swing-domain`).
public enum VideoFpsSource: String, Sendable {
  case observedSampleCadence = "observed_sample_cadence"
  case nominalFrameRate = "nominal_frame_rate"
}

/// Effective frame rate + duration for a clip, resolved from the observed
/// sample cadence with the declared values kept for the record.
public struct ResolvedVideoTiming: Equatable, Sendable {
  /// Effective sample rate — the observed cadence when it could be measured,
  /// otherwise the declared nominal rate.
  public let fps: Double
  public let fpsSource: VideoFpsSource
  /// The container's declared `nominalFrameRate` (0 when the track has none).
  public let nominalFps: Double
  /// True when the declared rate and the observed cadence disagree by more
  /// than `VideoTiming.fpsTolerance`.
  public let fpsMismatch: Bool
  /// Effective duration — the observed sample span when it contradicts the
  /// declared asset duration, otherwise the declared duration.
  public let durationMs: Int
  /// The container's declared duration (nil when unknown).
  public let assetDurationMs: Int?
  public let durationMismatch: Bool
  public let cadence: VideoCadence?

  /// The `video` object of `pickle.pose-sequence.v1` / people.json documents:
  /// `fps` is always present; the provenance keys are additive and only
  /// written when the cadence was actually measured, so readers that predate
  /// them keep parsing the same bytes for the same inputs.
  public func videoMetadata(width: Int, height: Int) -> [String: Any] {
    var video: [String: Any] = ["w": width, "h": height, "fps": fps]
    if cadence != nil {
      video["nominalFps"] = nominalFps
      video["fpsSource"] = fpsSource.rawValue
      video["fpsMismatch"] = fpsMismatch
    }
    return video
  }
}

public enum VideoTiming {
  /// Fewer intervals than this and the median is not trusted as a cadence.
  public static let minimumIntervals = 8
  /// Intervals longer than this are dropped frames / gaps, not cadence.
  public static let maxIntervalMs = 500
  /// Declared vs observed fps may differ by the larger of 0.5 fps and 5 %
  /// (integer-ms stamps of a 24 fps clip read as 23.8; 59.94 reads as 60).
  public static func fpsTolerance(observedFps: Double) -> Double {
    max(0.5, observedFps * 0.05)
  }
  /// Declared vs observed duration may differ by two frames plus 100 ms
  /// (the last sample's own display time is not a timestamp delta).
  public static func durationToleranceMs(intervalMs: Double) -> Int {
    Int((2 * intervalMs).rounded(.up)) + 100
  }

  /// Typical inter-sample interval of strictly increasing timestamps (see
  /// `VideoCadence.intervalMs`). Gaps longer than `maxIntervalMs` and
  /// non-increasing pairs are ignored, so a pose history with detection
  /// dropouts still measures the camera cadence.
  public static func observedCadence(sampleTimestampsMs: [Int]) -> VideoCadence? {
    var intervals: [Int] = []
    intervals.reserveCapacity(max(0, sampleTimestampsMs.count - 1))
    var index = 1
    while index < sampleTimestampsMs.count {
      let interval = sampleTimestampsMs[index] - sampleTimestampsMs[index - 1]
      if interval > 0, interval <= maxIntervalMs { intervals.append(interval) }
      index += 1
    }
    guard intervals.count >= minimumIntervals else { return nil }
    intervals.sort()
    let middle = intervals.count / 2
    let median: Double = intervals.count % 2 == 0
      ? Double(intervals[middle - 1] + intervals[middle]) / 2
      : Double(intervals[middle])
    guard median > 0 else { return nil }
    var total = 0
    var count = 0
    for interval in intervals where abs(Double(interval) - median) <= 1 {
      total += interval
      count += 1
    }
    return VideoCadence(intervalMs: Double(total) / Double(count), intervalCount: intervals.count)
  }

  /// Resolves the effective fps/duration for a clip. `sampleTimestampsMs`
  /// are the presentation timestamps the decoder delivered (or the pose
  /// frames' timestamps when that is all a writer has); `assetDurationMs` is
  /// the container's declared duration, if known.
  public static func resolve(
    nominalFps: Double,
    sampleTimestampsMs: [Int],
    assetDurationMs: Int?
  ) -> ResolvedVideoTiming {
    let declaredFps = nominalFps.isFinite && nominalFps > 0 ? nominalFps : 0
    guard let cadence = observedCadence(sampleTimestampsMs: sampleTimestampsMs) else {
      return ResolvedVideoTiming(
        fps: declaredFps,
        fpsSource: .nominalFrameRate,
        nominalFps: declaredFps,
        fpsMismatch: false,
        durationMs: assetDurationMs ?? 0,
        assetDurationMs: assetDurationMs,
        durationMismatch: false,
        cadence: nil
      )
    }
    let fpsMismatch = declaredFps > 0
      && abs(declaredFps - cadence.fps) > fpsTolerance(observedFps: cadence.fps)

    var durationMs = assetDurationMs ?? 0
    var durationMismatch = false
    if let first = sampleTimestampsMs.first, let last = sampleTimestampsMs.last, last > first {
      let observedDurationMs = last - first + Int(cadence.intervalMs.rounded())
      if let declared = assetDurationMs,
         abs(declared - observedDurationMs) <= durationToleranceMs(intervalMs: cadence.intervalMs) {
        durationMs = declared
      } else {
        durationMs = observedDurationMs
        durationMismatch = assetDurationMs != nil
      }
    }
    return ResolvedVideoTiming(
      fps: cadence.fps,
      fpsSource: .observedSampleCadence,
      nominalFps: declaredFps,
      fpsMismatch: fpsMismatch,
      durationMs: durationMs,
      assetDurationMs: assetDurationMs,
      durationMismatch: durationMismatch,
      cadence: cadence
    )
  }
}
