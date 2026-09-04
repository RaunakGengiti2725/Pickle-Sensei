// Linux stand-ins for the handful of Vision / ImageIO symbols that
// `ApplePoseProvider.swift` names, so the PRODUCTION file compiles verbatim
// on the proxy plane (only its `import Vision` line is swapped by run.sh).
//
// No inference happens here: `VNImageRequestHandler.perform` always throws,
// so `extractPose` / `extractAllPoses` can never succeed on Linux. What the
// proxy CAN exercise is everything that does not touch a real observation:
// the primary-person anchor (`setPrimaryPersonSeed`, `resetPrimaryPersonAnchor`,
// `primaryPersonAnchorForTesting`) and `primaryPerson(in:anchor:)` on
// synthetic observations. Apple truth still comes from the M4 runner.
#if !canImport(Vision)
import Foundation

public enum CGImagePropertyOrientation: UInt32 {
  case up = 1, upMirrored, down, downMirrored, leftMirrored, right, rightMirrored, left
}

public struct VNRecognizedPoint {
  public let location: CGPoint
  public let confidence: Float
  public init(location: CGPoint, confidence: Float) {
    self.location = location
    self.confidence = confidence
  }
}

public enum VNStubError: Error {
  case noInferenceOnLinux
  case pointUnavailable
}

open class VNHumanBodyPoseObservation {
  public struct JointName: Hashable {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public static let nose = JointName(rawValue: "nose")
    public static let leftShoulder = JointName(rawValue: "left_shoulder")
    public static let rightShoulder = JointName(rawValue: "right_shoulder")
    public static let leftElbow = JointName(rawValue: "left_elbow")
    public static let rightElbow = JointName(rawValue: "right_elbow")
    public static let leftWrist = JointName(rawValue: "left_wrist")
    public static let rightWrist = JointName(rawValue: "right_wrist")
    public static let leftHip = JointName(rawValue: "left_hip")
    public static let rightHip = JointName(rawValue: "right_hip")
    public static let leftKnee = JointName(rawValue: "left_knee")
    public static let rightKnee = JointName(rawValue: "right_knee")
    public static let leftAnkle = JointName(rawValue: "left_ankle")
    public static let rightAnkle = JointName(rawValue: "right_ankle")
  }

  /// Synthetic joints (Vision's BOTTOM-left normalized space) for tests.
  public let points: [JointName: VNRecognizedPoint]

  public init(points: [JointName: VNRecognizedPoint] = [:]) {
    self.points = points
  }

  public func recognizedPoint(_ jointName: JointName) throws -> VNRecognizedPoint {
    guard let point = points[jointName] else { throw VNStubError.pointUnavailable }
    return point
  }
}

public final class VNDetectHumanBodyPoseRequest {
  public var results: [VNHumanBodyPoseObservation]?
  public init() {}
}

public final class VNImageRequestHandler {
  public init(cvPixelBuffer: CVPixelBuffer, orientation: CGImagePropertyOrientation, options: [String: Any]) {}
  public func perform(_ requests: [VNDetectHumanBodyPoseRequest]) throws {
    throw VNStubError.noInferenceOnLinux
  }
}
#endif
