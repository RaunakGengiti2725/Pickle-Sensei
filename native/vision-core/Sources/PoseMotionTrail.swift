import Foundation

/// One measured movement segment in normalized-image coordinates. Segments
/// exist only when two consecutive, sufficiently visible observations were
/// produced for the same real joint.
public struct PoseMotionTrailSegment: Equatable, Sendable {
  public let joint: String
  public let startX: Double
  public let startY: Double
  public let endX: Double
  public let endY: Double
  public let normalizedSpeedPerSecond: Double
  /// Zero is the newest possible segment and one is the configured expiry.
  public let ageFraction: Double

  public init(
    joint: String,
    startX: Double,
    startY: Double,
    endX: Double,
    endY: Double,
    normalizedSpeedPerSecond: Double,
    ageFraction: Double
  ) {
    self.joint = joint
    self.startX = startX
    self.startY = startY
    self.endX = endX
    self.endY = endY
    self.normalizedSpeedPerSecond = normalizedSpeedPerSecond
    self.ageFraction = ageFraction
  }
}

/// A deliberately small, timestamp-bounded history used by live camera
/// overlays. It never interpolates missing joints and never invents samples;
/// every returned segment is backed by two observed `PoseLandmark` values.
public struct PoseMotionTrailBuffer: Sendable {
  public struct Config: Sendable {
    public var trackedJoints: [String]
    public var minimumVisibility: Double
    public var maximumAgeMs: Int
    public var maximumSampleGapMs: Int
    public var maximumSamplesPerJoint: Int

    public init(
      trackedJoints: [String] = [
        "left_wrist", "right_wrist",
        "left_elbow", "right_elbow",
        "left_hip", "right_hip",
        "left_ankle", "right_ankle",
      ],
      minimumVisibility: Double = 0.35,
      maximumAgeMs: Int = 320,
      maximumSampleGapMs: Int = 250,
      maximumSamplesPerJoint: Int = 8
    ) {
      self.trackedJoints = trackedJoints
      self.minimumVisibility = minimumVisibility
      self.maximumAgeMs = max(1, maximumAgeMs)
      self.maximumSampleGapMs = max(1, maximumSampleGapMs)
      self.maximumSamplesPerJoint = max(2, maximumSamplesPerJoint)
    }
  }

  private struct Sample: Sendable {
    let timestampMs: Int
    let x: Double
    let y: Double
  }

  private let config: Config
  private let trackedJointSet: Set<String>
  private var samplesByJoint: [String: [Sample]] = [:]

  public init(config: Config = Config()) {
    self.config = config
    trackedJointSet = Set(config.trackedJoints)
  }

  public mutating func ingest(landmarks: [PoseLandmark], timestampMs: Int) {
    prune(at: timestampMs)

    var observedByJoint: [String: PoseLandmark] = [:]
    for landmark in landmarks {
      guard trackedJointSet.contains(landmark.name),
            landmark.visibility >= config.minimumVisibility,
            landmark.x.isFinite, landmark.y.isFinite,
            (0 ... 1).contains(landmark.x), (0 ... 1).contains(landmark.y)
      else { continue }
      observedByJoint[landmark.name] = landmark
    }

    for joint in config.trackedJoints {
      // A missing or low-confidence observation breaks that joint's path. A
      // later reappearance must begin a new measured trail, never bridge the
      // unobserved interval.
      guard let landmark = observedByJoint[joint] else {
        samplesByJoint.removeValue(forKey: joint)
        continue
      }
      var samples = samplesByJoint[landmark.name] ?? []
      // Camera timestamps are monotonic. Ignoring repeated or regressed input
      // prevents a zero/negative interval from becoming a fabricated speed.
      guard (samples.last?.timestampMs ?? Int.min) < timestampMs else { continue }
      if let previousTimestampMs = samples.last?.timestampMs,
         timestampMs - previousTimestampMs > config.maximumSampleGapMs {
        samples.removeAll(keepingCapacity: true)
      }
      samples.append(Sample(timestampMs: timestampMs, x: landmark.x, y: landmark.y))
      if samples.count > config.maximumSamplesPerJoint {
        samples.removeFirst(samples.count - config.maximumSamplesPerJoint)
      }
      samplesByJoint[landmark.name] = samples
    }
  }

  public mutating func clear() {
    samplesByJoint.removeAll(keepingCapacity: true)
  }

  public func segments(at timestampMs: Int) -> [PoseMotionTrailSegment] {
    var result: [PoseMotionTrailSegment] = []
    result.reserveCapacity(config.trackedJoints.count * (config.maximumSamplesPerJoint - 1))

    for joint in config.trackedJoints {
      guard let samples = samplesByJoint[joint], samples.count > 1 else { continue }
      for index in 1 ..< samples.count {
        let start = samples[index - 1]
        let end = samples[index]
        let elapsedMs = end.timestampMs - start.timestampMs
        let ageMs = timestampMs - end.timestampMs
        guard elapsedMs > 0, ageMs >= 0, ageMs <= config.maximumAgeMs else { continue }

        let distance = hypot(end.x - start.x, end.y - start.y)
        result.append(
          PoseMotionTrailSegment(
            joint: joint,
            startX: start.x,
            startY: start.y,
            endX: end.x,
            endY: end.y,
            normalizedSpeedPerSecond: distance / (Double(elapsedMs) / 1_000),
            ageFraction: Double(ageMs) / Double(config.maximumAgeMs)
          )
        )
      }
    }
    return result
  }

  public var storedSampleCount: Int {
    samplesByJoint.values.reduce(0) { $0 + $1.count }
  }

  private mutating func prune(at timestampMs: Int) {
    let cutoff = timestampMs - config.maximumAgeMs
    for joint in config.trackedJoints {
      guard var samples = samplesByJoint[joint] else { continue }
      samples.removeAll { $0.timestampMs < cutoff }
      if samples.isEmpty { samplesByJoint.removeValue(forKey: joint) }
      else { samplesByJoint[joint] = samples }
    }
  }
}
