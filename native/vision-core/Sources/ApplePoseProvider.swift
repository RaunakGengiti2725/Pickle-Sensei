import Foundation
import Vision

/// On-device pose baseline via Apple Vision body-pose detection.
/// This is a REAL inference provider (not a fixture): landmarks come from
/// VNDetectHumanBodyPoseRequest. It is the MVP baseline the blueprint allows
/// (spec p. 26) pending the pickleball-tuned model; accuracy must still be
/// validated per checkpoint before any metric relies on it.
public final class ApplePoseProvider: PoseProviding, @unchecked Sendable {
  public let modelVersion = "apple-vision-bodypose-1"

  /// Torso midpoint of the previously selected person, for temporal
  /// stickiness in multi-person scenes (guarded by `stateLock`).
  private var previousTorsoMid: CGPoint?
  private let stateLock = NSLock()

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

  /// PoseProviding witness: live capture vends upright buffers.
  public func extractPose(pixelBuffer: CVPixelBuffer, timestampMs: Int) throws -> PoseFrame {
    try extractPose(pixelBuffer: pixelBuffer, timestampMs: timestampMs, orientation: .up)
  }

  /// `orientation` maps sensor/buffer space to display space. Live capture
  /// vends upright buffers (.up); IMPORTED videos carry a rotation in their
  /// track's preferredTransform and must pass it here so landmarks land in
  /// display-normalized coordinates (the space taps and width/height use).
  public func extractPose(
    pixelBuffer: CVPixelBuffer,
    timestampMs: Int,
    orientation: CGImagePropertyOrientation
  ) throws -> PoseFrame {
    let request = VNDetectHumanBodyPoseRequest()
    let handler = VNImageRequestHandler(cvPixelBuffer: pixelBuffer, orientation: orientation, options: [:])
    try handler.perform([request])
    // Multi-person scenes: the PRIMARY subject is the largest person in
    // frame (max shoulder-to-hip span), with temporal stickiness so the
    // selection cannot flip-flop between similarly sized people mid-swing.
    // `.first` is detection-order and silently locks onto bystanders.
    stateLock.lock()
    let anchor = previousTorsoMid
    stateLock.unlock()
    guard let observation = Self.primaryPerson(in: request.results ?? [], anchor: anchor) else {
      throw VisionFailure.lowConfidence("no person detected")
    }
    if let torsoMid = Self.torsoMid(observation) {
      stateLock.lock()
      previousTorsoMid = torsoMid
      stateLock.unlock()
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

  /// All detected people in a frame (up to `maxPeople`, largest torso first).
  /// Used by research tooling to build temporal PLAYER tracks; the phone
  /// capture path keeps using the single-primary `extractPose`.
  public func extractAllPoses(
    pixelBuffer: CVPixelBuffer,
    timestampMs: Int,
    maxPeople: Int = 6
  ) throws -> [PoseFrame] {
    let request = VNDetectHumanBodyPoseRequest()
    let handler = VNImageRequestHandler(cvPixelBuffer: pixelBuffer, orientation: .up, options: [:])
    try handler.perform([request])
    let observations = (request.results ?? [])
      .sorted { Self.torsoSpanPublic($0) > Self.torsoSpanPublic($1) }
      .prefix(maxPeople)
    var frames: [PoseFrame] = []
    for observation in observations {
      var landmarks: [PoseLandmark] = []
      var confidenceSum = 0.0
      for (joint, name) in Self.jointMap {
        guard let point = try? observation.recognizedPoint(joint) else { continue }
        landmarks.append(
          PoseLandmark(name: name, x: Double(point.location.x), y: 1.0 - Double(point.location.y), visibility: Double(point.confidence))
        )
        confidenceSum += Double(point.confidence)
      }
      guard !landmarks.isEmpty else { continue }
      frames.append(
        PoseFrame(timestampMs: timestampMs, landmarks: landmarks, confidence: confidenceSum / Double(landmarks.count))
      )
    }
    return frames
  }

  static func torsoSpanPublic(_ observation: VNHumanBodyPoseObservation) -> Double {
    torsoSpan(observation)
  }

  /// PRODUCT-ASSISTED TARGET SELECTION: seed the primary-person anchor from a
  /// user tap ("tap yourself"). The tap initializes WHICH person is primary;
  /// the existing temporal anchor stickiness then follows that person as they
  /// move. The seed never re-decides identity later — it is initialization,
  /// not a spatial constraint.
  public func setPrimaryPersonSeed(x: Double, y: Double) {
    previousTorsoMid = CGPoint(x: x, y: y)
  }

  /// Reset the temporal primary-person anchor (new clip / new session).
  public func resetPrimaryPersonAnchor() {
    stateLock.lock()
    previousTorsoMid = nil
    stateLock.unlock()
  }

  /// Largest-torso selection across detected people, weighted toward the
  /// previously selected person's position. Torso span is the distance from
  /// the shoulder midpoint to the hip midpoint in normalized coordinates;
  /// people missing those joints fall back to a tiny score so a full-body
  /// detection always wins over a fragment. The stickiness penalty halves a
  /// candidate's score at ~0.33 image units from the previous subject.
  ///
  /// INCUMBENT HYSTERESIS (promoted 2026-08-28, D-027): distance decay alone
  /// measurably lost the locked athlete to decisively larger newcomers
  /// (post-lock on-target 0.54 → 0.61 across 36 verified replay cases with
  /// this fix). The candidate nearest the previous anchor keeps identity
  /// unless a challenger beats its score by the same margin the player
  /// tracker uses (1/0.7 ≈ 1.43×).
  static let incumbentRadius = 0.12
  static let incumbentAdvantage = 0.7

  static func primaryPerson(
    in observations: [VNHumanBodyPoseObservation],
    anchor: CGPoint? = nil
  ) -> VNHumanBodyPoseObservation? {
    func score(_ observation: VNHumanBodyPoseObservation) -> Double {
      let span = torsoSpan(observation)
      guard let anchor, let mid = torsoMid(observation) else { return span }
      let distance = Double(hypot(mid.x - anchor.x, mid.y - anchor.y))
      return span / (1.0 + 3.0 * distance)
    }
    let best = observations.max { score($0) < score($1) }
    guard let anchor else { return best }
    let incumbent = observations
      .filter { observation in
        guard let mid = torsoMid(observation) else { return false }
        return Double(hypot(mid.x - anchor.x, mid.y - anchor.y)) <= Self.incumbentRadius
      }
      .max { score($0) < score($1) }
    guard let incumbent else { return best }
    guard let best, score(best) > score(incumbent) / Self.incumbentAdvantage else { return incumbent }
    return best
  }

  private static func point(
    _ observation: VNHumanBodyPoseObservation,
    _ joint: VNHumanBodyPoseObservation.JointName
  ) -> CGPoint? {
    guard let recognized = try? observation.recognizedPoint(joint),
          recognized.confidence >= 0.2 else { return nil }
    return recognized.location
  }

  static func torsoMid(_ observation: VNHumanBodyPoseObservation) -> CGPoint? {
    guard let leftShoulder = point(observation, .leftShoulder),
          let rightShoulder = point(observation, .rightShoulder),
          let leftHip = point(observation, .leftHip),
          let rightHip = point(observation, .rightHip)
    else { return nil }
    return CGPoint(
      x: (leftShoulder.x + rightShoulder.x + leftHip.x + rightHip.x) / 4,
      y: (leftShoulder.y + rightShoulder.y + leftHip.y + rightHip.y) / 4
    )
  }

  private static func torsoSpan(_ observation: VNHumanBodyPoseObservation) -> Double {
    guard let leftShoulder = point(observation, .leftShoulder),
          let rightShoulder = point(observation, .rightShoulder),
          let leftHip = point(observation, .leftHip),
          let rightHip = point(observation, .rightHip)
    else { return 1e-6 }
    let shoulderMid = CGPoint(x: (leftShoulder.x + rightShoulder.x) / 2,
                              y: (leftShoulder.y + rightShoulder.y) / 2)
    let hipMid = CGPoint(x: (leftHip.x + rightHip.x) / 2, y: (leftHip.y + rightHip.y) / 2)
    return Double(hypot(shoulderMid.x - hipMid.x, shoulderMid.y - hipMid.y))
  }
}
