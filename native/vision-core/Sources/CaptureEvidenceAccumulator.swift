import Foundation

/// Retains a bounded window of real pose-inference attempts and produces a
/// compact evidence summary for an automatically detected motion window.
///
/// Motion is measured only in normalized 2D image coordinates. It is not a
/// physical speed, power estimate, paddle measurement, contact measurement, or
/// ball speed.
public final class CaptureEvidenceAccumulator {
  public static let canonicalJoints = [
    "left_shoulder", "right_shoulder",
    "left_elbow", "right_elbow",
    "left_wrist", "right_wrist",
    "left_hip", "right_hip",
    "left_knee", "right_knee",
    "left_ankle", "right_ankle",
  ]

  public static let visibilityThreshold = 0.35
  public static let maximumMotionGapMs = 250
  public static let motionUnit = "normalized_image_units_per_second"

  public struct JointMotion: Sendable, Equatable {
    public let joint: String
    public let sampleCount: Int
    public let meanNormalizedPerSecond: Double
    public let peakNormalizedPerSecond: Double
  }

  public struct Summary: Sendable, Equatable {
    public let schemaVersion: Int
    public let window: String
    public let poseSource: String
    public let poseModelVersion: String
    public let triggerAlgorithmVersion: String
    public let motionUnit: String
    public let analysisInputFrameCount: Int
    public let poseFrameCount: Int
    public let poseMissingFrameCount: Int
    public let trackedDurationMs: Int
    public let meanCanonicalJointVisibility: Double
    public let meanJointCoverage: Double
    public let minimumJointCoverage: Double
    public let fullBodyVisibleFrameCount: Int
    public let jointMotion: [JointMotion]
  }

  private struct JointObservation {
    let x: Double
    let y: Double
    let visibility: Double

    var isVisible: Bool { visibility >= CaptureEvidenceAccumulator.visibilityThreshold }
  }

  private struct PoseObservation {
    let joints: [JointObservation?]
  }

  private struct Attempt {
    let timestampMs: Int
    let pose: PoseObservation?
  }

  private struct MotionAggregate {
    var sampleCount = 0
    var sum = 0.0
    var peak = 0.0

    mutating func add(_ value: Double) {
      guard value.isFinite, value >= 0 else { return }
      sampleCount += 1
      sum += value
      peak = max(peak, value)
    }
  }

  private let retentionMs: Int
  private var attempts: [Attempt] = []
  private var latestTimestampMs: Int?

  public init(retentionMs: Int = 4_000) {
    self.retentionMs = max(1, retentionMs)
  }

  /// Records one pose-inference attempt that yielded a usable pose.
  public func ingest(pose: PoseFrame) {
    var byName: [String: PoseLandmark] = [:]
    for landmark in pose.landmarks where Self.canonicalJoints.contains(landmark.name) {
      guard
        landmark.visibility.isFinite,
        landmark.x.isFinite, (0...1).contains(landmark.x),
        landmark.y.isFinite, (0...1).contains(landmark.y)
      else { continue }
      if let existing = byName[landmark.name], existing.visibility >= landmark.visibility {
        continue
      }
      byName[landmark.name] = landmark
    }

    let joints = Self.canonicalJoints.map { name -> JointObservation? in
      guard let landmark = byName[name] else { return nil }
      return JointObservation(
        x: landmark.x,
        y: landmark.y,
        visibility: min(1, max(0, landmark.visibility))
      )
    }
    append(Attempt(timestampMs: pose.timestampMs, pose: PoseObservation(joints: joints)))
  }

  /// Records one pose-inference attempt that did not yield a usable pose.
  public func ingestMissing(timestampMs: Int) {
    append(Attempt(timestampMs: timestampMs, pose: nil))
  }

  /// Returns evidence only when the inclusive window contains at least one
  /// usable pose. A temporal trigger cannot truthfully complete without that
  /// minimum evidence.
  public func summary(
    startMs: Int,
    endMs: Int,
    poseSource: String,
    poseModelVersion: String,
    triggerAlgorithmVersion: String
  ) -> Summary? {
    guard endMs >= startMs else { return nil }
    let windowAttempts =
      attempts
      .filter { $0.timestampMs >= startMs && $0.timestampMs <= endMs }
      .sorted { $0.timestampMs < $1.timestampMs }
    let poses = windowAttempts.compactMap { attempt -> (Int, PoseObservation)? in
      guard let pose = attempt.pose else { return nil }
      return (attempt.timestampMs, pose)
    }
    guard let firstPoseTimestamp = poses.first?.0, let lastPoseTimestamp = poses.last?.0 else {
      return nil
    }

    var canonicalVisibilitySum = 0.0
    var coverageSum = 0.0
    var minimumCoverage = 1.0
    var fullBodyVisibleFrameCount = 0
    for (_, pose) in poses {
      var visibleCount = 0
      for joint in pose.joints {
        canonicalVisibilitySum += joint?.visibility ?? 0
        if joint?.isVisible == true { visibleCount += 1 }
      }
      let coverage = Double(visibleCount) / Double(Self.canonicalJoints.count)
      coverageSum += coverage
      minimumCoverage = min(minimumCoverage, coverage)
      if visibleCount == Self.canonicalJoints.count { fullBodyVisibleFrameCount += 1 }
    }

    var motion = Array(repeating: MotionAggregate(), count: Self.canonicalJoints.count)
    var previous = [(timestampMs: Int, joint: JointObservation)?](
      repeating: nil,
      count: Self.canonicalJoints.count
    )
    for attempt in windowAttempts {
      guard let pose = attempt.pose else {
        previous = Array(repeating: nil, count: Self.canonicalJoints.count)
        continue
      }
      for index in Self.canonicalJoints.indices {
        guard let joint = pose.joints[index], joint.isVisible else {
          previous[index] = nil
          continue
        }
        if let prior = previous[index] {
          let elapsedMs = attempt.timestampMs - prior.timestampMs
          if elapsedMs > 0, elapsedMs <= Self.maximumMotionGapMs {
            let dx = joint.x - prior.joint.x
            let dy = joint.y - prior.joint.y
            let seconds = Double(elapsedMs) / 1_000
            motion[index].add((dx * dx + dy * dy).squareRoot() / seconds)
          }
        }
        previous[index] = (attempt.timestampMs, joint)
      }
    }

    let jointMotion = Self.canonicalJoints.indices.compactMap { index -> JointMotion? in
      let aggregate = motion[index]
      guard aggregate.sampleCount > 0 else { return nil }
      return JointMotion(
        joint: Self.canonicalJoints[index],
        sampleCount: aggregate.sampleCount,
        meanNormalizedPerSecond: aggregate.sum / Double(aggregate.sampleCount),
        peakNormalizedPerSecond: aggregate.peak
      )
    }
    let poseFrameCount = poses.count
    return Summary(
      schemaVersion: 1,
      window: "detected_motion",
      poseSource: poseSource,
      poseModelVersion: poseModelVersion,
      triggerAlgorithmVersion: triggerAlgorithmVersion,
      motionUnit: Self.motionUnit,
      analysisInputFrameCount: windowAttempts.count,
      poseFrameCount: poseFrameCount,
      poseMissingFrameCount: windowAttempts.count - poseFrameCount,
      trackedDurationMs: max(0, lastPoseTimestamp - firstPoseTimestamp),
      meanCanonicalJointVisibility: canonicalVisibilitySum
        / Double(poseFrameCount * Self.canonicalJoints.count),
      meanJointCoverage: coverageSum / Double(poseFrameCount),
      minimumJointCoverage: minimumCoverage,
      fullBodyVisibleFrameCount: fullBodyVisibleFrameCount,
      jointMotion: jointMotion
    )
  }

  public func reset() {
    attempts.removeAll(keepingCapacity: true)
    latestTimestampMs = nil
  }

  private func append(_ attempt: Attempt) {
    latestTimestampMs = max(latestTimestampMs ?? attempt.timestampMs, attempt.timestampMs)
    attempts.append(attempt)
    guard let latestTimestampMs else { return }
    let cutoff = latestTimestampMs - retentionMs
    attempts.removeAll { $0.timestampMs < cutoff }
  }
}
