import Foundation

/// Temporal stroke detector (spec p. 28): velocity-feature state machine over
/// wrist/paddle motion with minimum-confidence trigger and a refractory period
/// so paddle twirls and ball pickup never register as strokes. This is the
/// heuristic v0 the learned temporal classifier will replace behind the same
/// StrokeDetecting protocol.
public final class TemporalStrokeDetector: StrokeDetecting {
  public let modelVersion = "temporal-stroke-heuristic-2"

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
  private var lastPoints: [String: (x: Double, y: Double, tMs: Int)] = [:]
  private var strokeStartMs = 0
  private var peakSpeedMs = 0
  private var peakSpeed = 0.0
  private var refractoryUntilMs = 0

  public init(config: Config = Config()) {
    self.config = config
  }

  public func ingest(pose: PoseFrame, paddle: PaddleFrame?) -> StrokeEvent? {
    guard pose.confidence >= config.minPoseConfidence else { return nil }
    // Prefer a validated paddle center when available. Until then, evaluate
    // each wrist against its own prior location and use the faster wrist. This
    // avoids assuming handedness and avoids false speed spikes when the chosen
    // point switches sides.
    let points: [(key: String, x: Double, y: Double)]
    if let center = paddle?.center, (paddle?.confidence ?? 0) > 0.5 {
      points = [("paddle", Double(center.x), Double(center.y))]
    } else {
      points = pose.landmarks
        .filter { ($0.name == "right_wrist" || $0.name == "left_wrist") && $0.visibility >= 0.35 }
        .map { ($0.name, $0.x, $0.y) }
    }
    guard !points.isEmpty else { return nil }

    var speeds: [(speed: Double, previousTimestampMs: Int)] = []
    for point in points {
      if let previous = lastPoints[point.key], pose.timestampMs > previous.tMs {
        let elapsedMs = pose.timestampMs - previous.tMs
        if elapsedMs <= 250 {
          let dt = Double(elapsedMs) / 1000.0
          let dx = point.x - previous.x
          let dy = point.y - previous.y
          speeds.append(((dx * dx + dy * dy).squareRoot() / dt, previous.tMs))
        }
      }
      lastPoints[point.key] = (point.x, point.y, pose.timestampMs)
    }
    guard let fastest = speeds.max(by: { $0.speed < $1.speed }) else { return nil }
    let speed = fastest.speed

    switch state {
    case .idle:
      guard pose.timestampMs >= refractoryUntilMs else { return nil }
      if speed >= config.triggerWristSpeed {
        state = .candidate
        strokeStartMs = fastest.previousTimestampMs
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
          peakMotionMs: peakSpeedMs,
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
    lastPoints.removeAll(keepingCapacity: true)
    refractoryUntilMs = 0
  }
}
