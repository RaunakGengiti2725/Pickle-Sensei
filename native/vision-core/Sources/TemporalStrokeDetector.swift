import Foundation

/// Temporal stroke detector (spec p. 28): velocity-feature state machine over
/// wrist/paddle motion with minimum-confidence trigger and a refractory period
/// so paddle twirls and ball pickup never register as strokes. This is the
/// heuristic v0 the learned temporal classifier will replace behind the same
/// StrokeDetecting protocol.
public final class TemporalStrokeDetector: StrokeDetecting {
  public let modelVersion = "temporal-stroke-heuristic-1"

  private enum State { case idle, candidate, postStroke }

  public struct Config {
    public var triggerWristSpeed: Double // normalized units / second
    public var endWristSpeed: Double
    public var minStrokeMs: Int
    public var maxStrokeMs: Int
    public var refractoryMs: Int
    public var minPoseConfidence: Double

    public init(
      triggerWristSpeed: Double = 0.9,
      endWristSpeed: Double = 0.25,
      minStrokeMs: Int = 250,
      maxStrokeMs: Int = 2200,
      refractoryMs: Int = 700,
      minPoseConfidence: Double = 0.5
    ) {
      self.triggerWristSpeed = triggerWristSpeed
      self.endWristSpeed = endWristSpeed
      self.minStrokeMs = minStrokeMs
      self.maxStrokeMs = maxStrokeMs
      self.refractoryMs = refractoryMs
      self.minPoseConfidence = minPoseConfidence
    }
  }

  private let config: Config
  private var state: State = .idle
  private var lastWrist: (x: Double, y: Double, tMs: Int)?
  private var strokeStartMs = 0
  private var peakSpeedMs = 0
  private var peakSpeed = 0.0
  private var refractoryUntilMs = 0

  public init(config: Config = Config()) {
    self.config = config
  }

  public func ingest(pose: PoseFrame, paddle: PaddleFrame?) -> StrokeEvent? {
    guard pose.confidence >= config.minPoseConfidence else { return nil }
    // Prefer the paddle center when tracked; fall back to dominant wrist.
    let point: (x: Double, y: Double)
    if let center = paddle?.center, (paddle?.confidence ?? 0) > 0.5 {
      point = (Double(center.x), Double(center.y))
    } else if let wrist = pose.landmarks.first(where: { $0.name == "right_wrist" || $0.name == "left_wrist" }) {
      point = (wrist.x, wrist.y)
    } else {
      return nil
    }

    defer { lastWrist = (point.x, point.y, pose.timestampMs) }
    guard let previous = lastWrist, pose.timestampMs > previous.tMs else { return nil }
    let dt = Double(pose.timestampMs - previous.tMs) / 1000.0
    let speed = ((point.x - previous.x) * (point.x - previous.x) + (point.y - previous.y) * (point.y - previous.y)).squareRoot() / dt

    switch state {
    case .idle:
      guard pose.timestampMs >= refractoryUntilMs else { return nil }
      if speed >= config.triggerWristSpeed {
        state = .candidate
        strokeStartMs = previous.tMs
        peakSpeed = speed
        peakSpeedMs = pose.timestampMs
      }
      return nil

    case .candidate:
      if speed > peakSpeed {
        peakSpeed = speed
        peakSpeedMs = pose.timestampMs
      }
      let elapsed = pose.timestampMs - strokeStartMs
      if elapsed > config.maxStrokeMs {
        // Sustained motion (rally scramble, walking) — not a discrete stroke.
        state = .idle
        return nil
      }
      if speed <= config.endWristSpeed && elapsed >= config.minStrokeMs {
        state = .postStroke
        refractoryUntilMs = pose.timestampMs + config.refractoryMs
        let event = StrokeEvent(
          startMs: strokeStartMs,
          endMs: pose.timestampMs,
          // Contact neighborhood ≈ peak paddle/wrist speed (probabilistic, not exact).
          contactMs: peakSpeedMs,
          confidence: min(0.95, 0.5 + peakSpeed / (config.triggerWristSpeed * 4))
        )
        state = .idle
        return event
      }
      return nil

    case .postStroke:
      state = .idle
      return nil
    }
  }

  public func reset() {
    state = .idle
    lastWrist = nil
    refractoryUntilMs = 0
  }
}
