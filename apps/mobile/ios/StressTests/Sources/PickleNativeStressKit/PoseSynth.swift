import Foundation
import PickleNativeStressCore

/// Deterministic synthetic pose streams. Coordinates are normalized image
/// space, top-left origin (the contract `ApplePoseProvider` emits).
public enum PoseSynth {
  public static let joints = CaptureEvidenceAccumulator.canonicalJoints

  /// One standing athlete: body centre, height (shoulder→ankle span) and the
  /// wrist offsets that drive the stroke detector.
  public struct Athlete: Sendable {
    public var centerX: Double
    public var centerY: Double
    public var height: Double
    public var mirrored: Bool

    public init(centerX: Double, centerY: Double, height: Double, mirrored: Bool = false) {
      self.centerX = centerX
      self.centerY = centerY
      self.height = height
      self.mirrored = mirrored
    }

    /// A framing that satisfies `PoseReadinessEvaluator` defaults: inside the
    /// 2.5% margins, 0.32–0.88 tall, ≤ 0.8 wide.
    public static func readyFraming(_ rng: inout StressRNG) -> Athlete {
      Athlete(
        centerX: rng.double(in: 0.35 ... 0.65),
        centerY: rng.double(in: 0.45 ... 0.55),
        height: rng.double(in: 0.45 ... 0.75),
        mirrored: rng.chance(0.5)
      )
    }
  }

  /// Wrist state relative to the body: `swing` moves the dominant wrist along
  /// an arc of `amplitude` body-heights over the phase 0…1.
  public enum Arm: Sendable {
    case still
    case swing(phase: Double, amplitude: Double)
  }

  public static func landmarks(
    _ athlete: Athlete,
    arm: Arm,
    visibility: Double = 0.9,
    jitter: Double = 0,
    rng: inout StressRNG
  ) -> [PoseLandmark] {
    let h = athlete.height
    let shoulderY = athlete.centerY - h * 0.5
    let hipY = shoulderY + h * 0.45
    let kneeY = shoulderY + h * 0.75
    let ankleY = shoulderY + h
    let halfShoulder = h * 0.16
    let halfHip = h * 0.12
    let sign: Double = athlete.mirrored ? -1 : 1

    func j(_ dx: Double, _ y: Double) -> (Double, Double) {
      (athlete.centerX + sign * dx + rng.gaussian(sigma: jitter),
       y + rng.gaussian(sigma: jitter))
    }

    var wristOffset = (x: halfShoulder * 1.4, y: hipY - shoulderY)
    switch arm {
    case .still:
      break
    case .swing(let phase, let amplitude):
      // Backswing → contact → follow-through as a half circle in front of the
      // hip, scaled by amplitude (body-heights).
      let angle = Double.pi * phase
      wristOffset = (
        x: halfShoulder * 1.4 + cos(angle) * amplitude * h * 0.5 * sign,
        y: (hipY - shoulderY) - sin(angle) * amplitude * h * 0.5
      )
    }
    let elbowOffset = (x: halfShoulder * 1.2 + wristOffset.x * 0.4, y: (wristOffset.y) * 0.5)

    var result: [PoseLandmark] = []
    func add(_ name: String, _ point: (Double, Double), _ v: Double = visibility) {
      result.append(PoseLandmark(name: name, x: point.0, y: point.1, visibility: v))
    }
    add("left_shoulder", j(-halfShoulder, shoulderY))
    add("right_shoulder", j(halfShoulder, shoulderY))
    add("left_elbow", j(-halfShoulder * 1.2, shoulderY + (hipY - shoulderY) * 0.5))
    add("right_elbow", j(elbowOffset.x, shoulderY + elbowOffset.y))
    add("left_wrist", j(-halfShoulder * 1.4, hipY))
    add("right_wrist", j(wristOffset.x, shoulderY + wristOffset.y))
    add("left_hip", j(-halfHip, hipY))
    add("right_hip", j(halfHip, hipY))
    add("left_knee", j(-halfHip, kneeY))
    add("right_knee", j(halfHip, kneeY))
    add("left_ankle", j(-halfHip * 1.1, ankleY))
    add("right_ankle", j(halfHip * 1.1, ankleY))
    return result
  }

  public static func frame(
    _ athlete: Athlete,
    arm: Arm,
    timestampMs: Int,
    confidence: Double = 0.9,
    visibility: Double = 0.9,
    jitter: Double = 0.002,
    rng: inout StressRNG
  ) -> PoseFrame {
    PoseFrame(
      timestampMs: timestampMs,
      landmarks: landmarks(athlete, arm: arm, visibility: visibility, jitter: jitter, rng: &rng),
      confidence: confidence
    )
  }

  // MARK: - Corruption

  public enum Corruption: String, CaseIterable, Sendable {
    case nanCoordinate
    case infiniteCoordinate
    case outOfRangeCoordinate
    case negativeVisibility
    case visibilityAboveOne
    case nanVisibility
    case emptyName
    case unknownJointName
    case duplicateJoint
    case dropRandomJoints
    case zeroConfidence
    case nanConfidence
    case hugeLandmarkList

    /// Corruptions that add a second landmark with an already-present name.
    public var duplicatesJointNames: Bool { self == .duplicateJoint }
  }

  /// Applies one corruption to a well-formed landmark list.
  public static func corrupt(
    _ frame: PoseFrame,
    with corruption: Corruption,
    rng: inout StressRNG
  ) -> PoseFrame {
    var marks = frame.landmarks
    var confidence = frame.confidence
    guard !marks.isEmpty else { return frame }
    let index = rng.int(in: 0 ... marks.count - 1)
    let victim = marks[index]
    func replace(x: Double? = nil, y: Double? = nil, visibility: Double? = nil, name: String? = nil) {
      marks[index] = PoseLandmark(
        name: name ?? victim.name,
        x: x ?? victim.x,
        y: y ?? victim.y,
        visibility: visibility ?? victim.visibility
      )
    }
    switch corruption {
    case .nanCoordinate:
      if rng.chance(0.5) { replace(x: .nan) } else { replace(y: .nan) }
    case .infiniteCoordinate:
      replace(x: rng.chance(0.5) ? .infinity : -.infinity)
    case .outOfRangeCoordinate:
      replace(x: rng.double(in: -5 ... -0.01), y: rng.double(in: 1.01 ... 40))
    case .negativeVisibility:
      replace(visibility: rng.double(in: -3 ... -0.001))
    case .visibilityAboveOne:
      replace(visibility: rng.double(in: 1.001 ... 1e6))
    case .nanVisibility:
      replace(visibility: .nan)
    case .emptyName:
      replace(name: "")
    case .unknownJointName:
      replace(name: rng.pick(["nose", "neck", "root", "left_eye", "paddle_tip", "🥒"]))
    case .duplicateJoint:
      marks.append(PoseLandmark(
        name: victim.name,
        x: rng.double(in: 0 ... 1),
        y: rng.double(in: 0 ... 1),
        visibility: rng.double(in: 0.35 ... 1)
      ))
    case .dropRandomJoints:
      let keep = rng.int(in: 0 ... marks.count)
      marks = Array(marks.shuffled(using: &rng).prefix(keep))
    case .zeroConfidence:
      confidence = 0
    case .nanConfidence:
      confidence = .nan
    case .hugeLandmarkList:
      let extra = rng.int(in: 1_000 ... 5_000)
      for i in 0 ..< extra {
        marks.append(PoseLandmark(
          name: "ghost_\(i)",
          x: rng.double(in: 0 ... 1),
          y: rng.double(in: 0 ... 1),
          visibility: rng.double(in: 0 ... 1)
        ))
      }
    }
    return PoseFrame(timestampMs: frame.timestampMs, landmarks: marks, confidence: confidence)
  }

  /// Corruptions that a well-behaved consumer must survive (no duplicate-name
  /// variant: see `StressScenario.readinessDuplicateLandmark`).
  public static let nonDuplicatingCorruptions = Corruption.allCases.filter { !$0.duplicatesJointNames }
}
