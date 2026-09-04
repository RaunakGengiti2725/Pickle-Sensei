import Foundation

/// Continuous wrist-motion series for session capture (D-040 Gap 1).
///
/// Computes the SAME per-frame wrist-speed sampling the guided-capture
/// instruments use (the D-029 `StrokeCompletionMonitor` shadow, and the
/// sampling of `TemporalStrokeDetector.ingest`): per pose frame, each wrist
/// with visibility ≥ 0.35 and finite x/y/visibility is compared against its
/// own prior observation (elapsed > 0 and ≤ 250 ms), speed is
/// normalized-image units/second, the fastest wrist wins the frame, and
/// frames with pose confidence < 0.5 yield nothing. A wrist carrying ±inf /
/// NaN is treated like a hidden one — neither measured nor remembered — so
/// the series never contains a non-finite value. (The live trigger itself has
/// since moved to HIP-RELATIVE wrist speed in body-heights/second —
/// temporal-stroke-heuristic-4; this stream's schema stays in absolute image
/// units.) State is two prior wrist points — bounded by construction; the
/// stream never buffers, so a session of any length is safe to run through it.
///
/// The value is camera-relative image-space motion. It is never a physical
/// speed, power estimate, paddle measurement, or ball measurement.
public final class SessionMotionStream {
  public struct Sample: Sendable, Equatable {
    /// Camera-clock (presentation) timestamp of the pose frame.
    public let timestampMs: Int
    /// Fastest wrist speed this frame, normalized-image units/second.
    public let value: Double

    public init(timestampMs: Int, value: Double) {
      self.timestampMs = timestampMs
      self.value = value
    }
  }

  /// Series constants mirrored from `TemporalStrokeDetector`. Version any
  /// change — the JS session engine consumed this exact series when its
  /// thresholds were validated against recorded rallies.
  public static let minWristVisibility = 0.35
  public static let maximumSampleGapMs = 250
  public static let minPoseConfidence = 0.5
  public static let motionUnit = "normalized_image_units_per_second"

  private var lastPoints: [String: (x: Double, y: Double, tMs: Int)] = [:]

  public init() {}

  /// Feed one pose frame; returns a sample when at least one wrist produced a
  /// measurable displacement. Not thread-safe — call from one queue.
  public func ingest(pose: PoseFrame) -> Sample? {
    guard pose.confidence.isFinite, pose.confidence >= Self.minPoseConfidence else { return nil }
    let wrists = pose.landmarks.filter {
      ($0.name == "right_wrist" || $0.name == "left_wrist")
        && $0.x.isFinite && $0.y.isFinite && $0.visibility.isFinite
        && $0.visibility >= Self.minWristVisibility
    }
    guard !wrists.isEmpty else { return nil }

    var fastest: Double?
    for wrist in wrists {
      if let previous = lastPoints[wrist.name], pose.timestampMs > previous.tMs {
        let elapsedMs = pose.timestampMs - previous.tMs
        if elapsedMs <= Self.maximumSampleGapMs {
          let dt = Double(elapsedMs) / 1_000.0
          let dx = wrist.x - previous.x
          let dy = wrist.y - previous.y
          let speed = (dx * dx + dy * dy).squareRoot() / dt
          fastest = max(fastest ?? 0, speed)
        }
      }
      lastPoints[wrist.name] = (wrist.x, wrist.y, pose.timestampMs)
    }
    guard let speed = fastest else { return nil }
    return Sample(timestampMs: pose.timestampMs, value: speed)
  }

  public func reset() {
    lastPoints.removeAll(keepingCapacity: true)
  }
}
