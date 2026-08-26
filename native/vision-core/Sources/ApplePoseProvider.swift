import Foundation
import Vision

/// On-device pose baseline via Apple Vision body-pose detection.
/// This is a REAL inference provider (not a fixture): landmarks come from
/// VNDetectHumanBodyPoseRequest. It is the MVP baseline the blueprint allows
/// (spec p. 26) pending the pickleball-tuned model; accuracy must still be
/// validated per checkpoint before any metric relies on it.
public final class ApplePoseProvider: PoseProviding, @unchecked Sendable {
  public let modelVersion = "apple-vision-bodypose-1"

  private static let jointMap: [(VNHumanBodyPoseObservation.JointName, String)] = [
    (.nose, "head"),
    (.leftShoulder, "left_shoulder"),
    (.rightShoulder, "right_shoulder"),
    (.leftElbow, "left_elbow"),
    (.rightElbow, "right_elbow"),
    (.leftWrist, "left_wrist"),
    (.rightWrist, "right_wrist"),
    (.leftHip, "left_hip"),
    (.rightHip, "right_hip"),
    (.leftKnee, "left_knee"),
    (.rightKnee, "right_knee"),
    (.leftAnkle, "left_ankle"),
    (.rightAnkle, "right_ankle"),
  ]

  public init() {}

  public func extractPose(pixelBuffer: CVPixelBuffer, timestampMs: Int) throws -> PoseFrame {
    let request = VNDetectHumanBodyPoseRequest()
    let handler = VNImageRequestHandler(cvPixelBuffer: pixelBuffer, orientation: .up, options: [:])
    try handler.perform([request])
    guard let observation = request.results?.first else {
      throw VisionFailure.lowConfidence("no person detected")
    }
    var landmarks: [PoseLandmark] = []
    var confidenceSum = 0.0
    for (joint, name) in Self.jointMap {
      guard let point = try? observation.recognizedPoint(joint) else { continue }
      // Vision uses lower-left origin; convert to normalized-image (top-left).
      landmarks.append(
        PoseLandmark(name: name, x: Double(point.location.x), y: 1.0 - Double(point.location.y), visibility: Double(point.confidence))
      )
      confidenceSum += Double(point.confidence)
    }
    guard !landmarks.isEmpty else {
      throw VisionFailure.lowConfidence("no landmarks resolved")
    }
    return PoseFrame(
      timestampMs: timestampMs,
      landmarks: landmarks,
      confidence: confidenceSum / Double(landmarks.count)
    )
  }
}
