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
  ///
  /// COORDINATE SPACE: callers pass DISPLAY-normalized points (top-left
  /// origin) — the space `PoseFrame.landmarks`, taps, and `targetSeed` all
  /// use. The anchor is compared against `torsoMid`, which reads Vision's raw
  /// `recognizedPoint().location` in BOTTOM-left origin, so y is flipped on
  /// the way in to match. Without the flip a seed naming an athlete at y=0.7
  /// lands 0.4 away from them — far outside `incumbentRadius` (0.12) — so the
  /// tap is inert or mirrored onto a bystander on exactly the frame it exists
  /// to control. Guarded by `stateLock` like every other access: this is
  /// called from the main thread while the vision queue reads the anchor.
  public func setPrimaryPersonSeed(x: Double, y: Double) {
    stateLock.lock()
    previousTorsoMid = CGPoint(x: x, y: 1.0 - y)
    stateLock.unlock()
  }

  /// Reset the temporal primary-person anchor (new clip / new session).
  public func resetPrimaryPersonAnchor() {
    stateLock.lock()
    previousTorsoMid = nil
    stateLock.unlock()
  }

  /// The temporal anchor, in Vision's BOTTOM-left space — the same space
  /// `torsoMid` produces and `primaryPerson` compares against. Deliberately
  /// `internal`: production code never reads the anchor, but the seed's
  /// coordinate conversion is only observable here, and an untested flip is
  /// how it silently regressed once already.
  var primaryPersonAnchorForTesting: CGPoint? {
    stateLock.lock()
    defer { stateLock.unlock() }
    return previousTorsoMid
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

import AVFoundation
import CoreImage
import CryptoKit
import ImageIO
import simd

public enum Motion3DFailure: String, Error, Equatable, Sendable {
  case unavailable = "motion3d.unavailable"
  case invalidOptions = "motion3d.invalid_options"
  case invalidSource = "motion3d.invalid_source"
  case exceedsLimits = "motion3d.exceeds_limits"
  case decodingFailed = "motion3d.decoding_failed"
  case cancelled = "motion3d.cancelled"
  case busy = "motion3d.busy"
  case timeout = "motion3d.timeout"
}

public enum Motion3DLimits {
  public static let maxDurationMs = 60_000.0
  public static let maxVideoBytes = 512 * 1024 * 1024
  public static let maxFrames = 1800
  public static let maxJSONBytes = 8 * 1024 * 1024
  public static let maxSampleRate: Int32 = 30
  public static let maxWallTimeSeconds = 85.0
  static let maxContinuityGapMs = 250.0
  static let maxDecodedFrames = 14_401
  static let hashChunkBytes = 1024 * 1024

  public static func validIdentifier(_ value: String) -> Bool {
    !value.isEmpty && value.utf8.count <= 128 && value.utf8.allSatisfy {
      (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0)
        || $0 == 46 || $0 == 95 || $0 == 58 || $0 == 45
    }
  }

  public static func validStoredURI(_ value: String) -> Bool {
    guard value.hasPrefix("file://"), value.utf8.count <= 4096,
          let decoded = value.removingPercentEncoding, !decoded.utf8.contains(0),
          let url = URL(string: value), url.isFileURL, url.path.hasPrefix("/"),
          url.host == nil || url.host == "" || url.host == "localhost",
          url.user == nil, url.password == nil, url.port == nil,
          url.query == nil, url.fragment == nil else { return false }
    return !url.path.utf8.contains(0)
  }
}

public final class Motion3DCancellation: @unchecked Sendable {
  private let lock = NSLock()
  private var failure: Motion3DFailure?
  private var handlers: [UUID: () -> Void] = [:]
  private var timeoutWork: DispatchWorkItem?
  private let deadline: DispatchTime

  public init(timeoutSeconds: TimeInterval = Motion3DLimits.maxWallTimeSeconds) {
    let interval = timeoutSeconds.isFinite ? max(0, min(timeoutSeconds, Motion3DLimits.maxWallTimeSeconds)) : 0
    deadline = .now() + interval
    let work = DispatchWorkItem { [weak self] in self?.stop(with: .timeout) }
    timeoutWork = work
    DispatchQueue.global(qos: .utility).asyncAfter(deadline: deadline, execute: work)
  }

  deinit { timeoutWork?.cancel() }

  public var isCancelled: Bool {
    lock.lock()
    defer { lock.unlock() }
    return failure != nil
  }

  public func check() throws {
    if DispatchTime.now() >= deadline { stop(with: .timeout) }
    lock.lock()
    let reason = failure
    lock.unlock()
    if let reason { throw reason }
  }

  public func cancel() { stop(with: .cancelled) }

  private func stop(with reason: Motion3DFailure) {
    lock.lock()
    guard failure == nil else { lock.unlock(); return }
    failure = reason
    let actions = Array(handlers.values)
    handlers.removeAll()
    lock.unlock()
    actions.forEach { $0() }
  }

  @discardableResult
  func onCancel(_ action: @escaping () -> Void) throws -> UUID {
    if DispatchTime.now() >= deadline { stop(with: .timeout) }
    lock.lock()
    if let reason = failure {
      lock.unlock()
      action()
      throw reason
    }
    let id = UUID()
    handlers[id] = action
    lock.unlock()
    return id
  }

  func removeHandler(_ id: UUID) {
    lock.lock()
    handlers.removeValue(forKey: id)
    lock.unlock()
  }
}

final class Motion3DExclusiveGate: @unchecked Sendable {
  private let lock = NSLock()
  private var active: UUID?

  func acquire() throws -> UUID {
    lock.lock()
    defer { lock.unlock() }
    guard active == nil else { throw Motion3DFailure.busy }
    let id = UUID()
    active = id
    return id
  }

  func release(_ id: UUID) {
    lock.lock()
    if active == id { active = nil }
    lock.unlock()
  }
}

public enum Motion3DJointName: String, CaseIterable, Encodable, Sendable {
  case root, spine
  case centerShoulder = "center_shoulder"
  case centerHead = "center_head"
  case topHead = "top_head"
  case leftShoulder = "left_shoulder"
  case leftElbow = "left_elbow"
  case leftWrist = "left_wrist"
  case rightShoulder = "right_shoulder"
  case rightElbow = "right_elbow"
  case rightWrist = "right_wrist"
  case leftHip = "left_hip"
  case leftKnee = "left_knee"
  case leftAnkle = "left_ankle"
  case rightHip = "right_hip"
  case rightKnee = "right_knee"
  case rightAnkle = "right_ankle"
}

public enum Motion3DFrameStatus: String, Encodable, Sendable {
  case estimated
  case noPerson = "no_person"
  case multiplePeople = "multiple_people"
  case unavailable
}

public enum Motion3DPolicy: String, Sendable {
  case rawV1 = "raw-v1"
  case associatedV2 = "associated-v2"
  case associatedROIV3 = "associated-roi-v3"
}

public struct Motion3DTargetSeed: Encodable, Equatable, Sendable {
  public let x: Double
  public let y: Double
  public let timestampMs: Double

  public init(x: Double, y: Double, timestampMs: Double) throws {
    guard x.isFinite, y.isFinite, timestampMs.isFinite,
          (0...1).contains(x), (0...1).contains(y),
          (0...Motion3DLimits.maxDurationMs).contains(timestampMs) else { throw Motion3DFailure.invalidOptions }
    self.x = x
    self.y = y
    self.timestampMs = timestampMs
  }

  public static func parse(_ value: Any) throws -> Motion3DTargetSeed {
    guard let object = value as? NSDictionary, object.count == 3 else { throw Motion3DFailure.invalidOptions }
    func number(_ key: String) throws -> Double {
      guard let value = object[key] as? NSNumber,
            CFGetTypeID(value) != CFBooleanGetTypeID() else { throw Motion3DFailure.invalidOptions }
      return value.doubleValue
    }
    return try Motion3DTargetSeed(x: number("x"), y: number("y"), timestampMs: number("timestampMs"))
  }
}

enum Motion3DAssociationParameters {
  static let minimumVisibility = 0.2
  static let minimumTorsoSpan = 0.025
  static let prominenceRatio = 1.0 / 0.7
  static let matchRadius = 0.12
  static let maximumTorsoDisplacement = 0.6
  static let maximumScaleRatio = 1.6
  static let scaleCostWeight = 0.5
  static let contestCostRatio = 1.5
  static let contestCostMargin = 0.15
  static let seedMaximumDistance = 1.5
  static let seedCostRatio = 0.65
  static let seedCostMargin = 0.15
  static let minimumCommonJoints = 4
  static let minimumProjectionTorsoJoints = 2
  static let maximumReprojectionError = 0.35
  static let projectionMargin = 0.15
  static let projectionRatio = 1.5
  static let maximumCandidates = 64

  static let values: [String: Double] = [
    "minimumVisibility": minimumVisibility, "minimumTorsoSpan": minimumTorsoSpan,
    "prominenceRatio": prominenceRatio, "matchRadius": matchRadius,
    "maximumTorsoDisplacement": maximumTorsoDisplacement, "maximumScaleRatio": maximumScaleRatio,
    "scaleCostWeight": scaleCostWeight, "contestCostRatio": contestCostRatio, "contestCostMargin": contestCostMargin,
    "seedMaximumDistance": seedMaximumDistance, "seedCostRatio": seedCostRatio, "seedCostMargin": seedCostMargin,
    "minimumCommonJoints": Double(minimumCommonJoints), "minimumProjectionTorsoJoints": Double(minimumProjectionTorsoJoints),
    "maximumReprojectionError": maximumReprojectionError, "projectionMargin": projectionMargin, "projectionRatio": projectionRatio,
    "maximumContinuityGapMs": Motion3DLimits.maxContinuityGapMs, "maximumCandidates": Double(maximumCandidates),
  ]
}

enum Motion3DROIParameters {
  static let minimumContinuityJoints = 4
  static let minimumContinuityHips = 1
  static let minimumScaleBones = 2
  static let minimumScaleBoneSpan = 0.02
  static let minimumInitialBodyJoints = 8
  static let paddingTorsoSpans = 0.75
  static let minimumPixelSide = 32
  static let maximumPixelSide = 2048
  static let maximumPixels = 4_000_000
  static let maximumBuffers = 2

  static let values: [String: Double] = Motion3DAssociationParameters.values.merging([
    "minimumContinuityJoints": Double(minimumContinuityJoints), "minimumContinuityHips": Double(minimumContinuityHips),
    "minimumScaleBones": Double(minimumScaleBones), "minimumScaleBoneSpan": minimumScaleBoneSpan,
    "minimumInitialBodyJoints": Double(minimumInitialBodyJoints), "roiPaddingTorsoSpans": paddingTorsoSpans,
    "minimumROIPixelSide": Double(minimumPixelSide), "maximumROIPixelSide": Double(maximumPixelSide),
    "maximumROIPixelsInThousands": Double(maximumPixels / 1000), "maximumROIBuffers": Double(maximumBuffers),
  ]) { _, value in value }
}

struct Motion3DIdentityPolicy: Encodable, Sendable {
  let version: String
  let seed: Motion3DTargetSeed?
  let crossRecordIdentity = "unverified"
  let residualUnit = "torso_spans"
  let parameters: [String: Double]
  var selection: String { seed == nil ? "automatic_prominence" : "explicit_seed" }

  init(seed: Motion3DTargetSeed?, roi: Bool = false) {
    self.seed = seed
    version = roi ? "motion-target-association-2" : "motion-target-association-1"
    parameters = roi ? Motion3DROIParameters.values : Motion3DAssociationParameters.values
  }

  private enum CodingKeys: String, CodingKey {
    case version, selection, seed, crossRecordIdentity, residualUnit, parameters
  }

  func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(version, forKey: .version)
    try container.encode(selection, forKey: .selection)
    try container.encode(seed, forKey: .seed)
    try container.encode(crossRecordIdentity, forKey: .crossRecordIdentity)
    try container.encode(residualUnit, forKey: .residualUnit)
    try container.encode(parameters, forKey: .parameters)
  }
}

public enum Motion3DAssociationStatus: String, Encodable, Sendable {
  case matched, ambiguous
  case targetLost = "target_lost"
  case wrongPlayer = "wrong_player"
  case insufficientSupport = "insufficient_support"
  case noPerson = "no_person"
  case notSelected = "not_selected"
}

public enum Motion3DContinuity: String, Encodable, Sendable {
  case initial, continuous, broken
}

public struct Motion3DAssociation: Encodable, Sendable {
  public let status: Motion3DAssociationStatus
  public let trackId: Int?
  public let candidateCount: Int
  public let selectedCandidate: Int?
  public let commonJoints: Int
  public let reprojectionError: Double?
  public let runnerUpError: Double?
  public let continuity: Motion3DContinuity

  private enum CodingKeys: String, CodingKey {
    case status, trackId, candidateCount, selectedCandidate, commonJoints, reprojectionError, runnerUpError, continuity
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(status, forKey: .status)
    try container.encode(trackId, forKey: .trackId)
    try container.encode(candidateCount, forKey: .candidateCount)
    try container.encode(selectedCandidate, forKey: .selectedCandidate)
    try container.encode(commonJoints, forKey: .commonJoints)
    try container.encode(reprojectionError, forKey: .reprojectionError)
    try container.encode(runnerUpError, forKey: .runnerUpError)
    try container.encode(continuity, forKey: .continuity)
  }
}

public struct Motion3DJoint: Encodable, Sendable {
  public let name: Motion3DJointName
  public let x: Double
  public let y: Double
  public let z: Double
  public let imageX: Double
  public let imageY: Double
  public let visibility2D: Double?

  static func projected(
    name: Motion3DJointName,
    position: simd_float4x4,
    imagePoint: CGPoint?,
    visibility2D: Double?
  ) -> Motion3DJoint? {
    guard let imagePoint,
          imagePoint.x.isFinite, imagePoint.y.isFinite,
          (0...1).contains(imagePoint.x), (0...1).contains(imagePoint.y) else { return nil }
    let translation = position.columns.3
    let coordinates = [Double(translation.x), Double(translation.y), Double(translation.z)]
    guard coordinates.allSatisfy({ $0.isFinite && (-100...100).contains($0) }) else { return nil }
    let visibility = visibility2D.flatMap { $0.isFinite && (0...1).contains($0) ? $0 : nil }
    return Motion3DJoint(
      name: name, x: coordinates[0], y: coordinates[1], z: coordinates[2],
      imageX: Double(imagePoint.x), imageY: 1 - Double(imagePoint.y), visibility2D: visibility
    )
  }

  private enum CodingKeys: String, CodingKey {
    case name, x, y, z, imageX, imageY, confidence, visibility2D
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(name, forKey: .name)
    try container.encode(x, forKey: .x)
    try container.encode(y, forKey: .y)
    try container.encode(z, forKey: .z)
    try container.encode(imageX, forKey: .imageX)
    try container.encode(imageY, forKey: .imageY)
    try container.encodeNil(forKey: .confidence)
    try container.encode(visibility2D, forKey: .visibility2D)
  }
}

public struct Motion3DHeight: Encodable, Sendable {
  public enum Source: String, Encodable, Sendable {
    case reference, measured
  }

  public let meters: Double
  public let source: Source

  static func validated(meters: Double, source: Source) -> Motion3DHeight? {
    guard meters.isFinite, (0.01...100).contains(meters),
          source != .reference || abs(meters - 1.8) < 0.0001 else { return nil }
    return Motion3DHeight(meters: meters, source: source)
  }
}

public struct Motion3DObservationSample: Sendable {
  public let status: Motion3DFrameStatus
  public let observationConfidence: Double?
  public let height: Motion3DHeight?
  public let cameraOriginMatrix: [Double]?
  public let joints: [Motion3DJoint]
  public let association: Motion3DAssociation?

  init(
    status: Motion3DFrameStatus, observationConfidence: Double?, height: Motion3DHeight?,
    cameraOriginMatrix: [Double]?, joints: [Motion3DJoint], association: Motion3DAssociation? = nil
  ) {
    self.status = status
    self.observationConfidence = observationConfidence
    self.height = height
    self.cameraOriginMatrix = cameraOriginMatrix
    self.joints = joints
    self.association = association
  }

  static func missing(_ status: Motion3DFrameStatus) -> Motion3DObservationSample {
    Motion3DObservationSample(
      status: status == .estimated ? .unavailable : status,
      observationConfidence: nil, height: nil, cameraOriginMatrix: nil, joints: []
    )
  }
}

enum Motion3DSinglePersonGuard {
  static func evaluate<Person>(
    people: [Person],
    estimate: (Person) throws -> Motion3DObservationSample
  ) rethrows -> Motion3DObservationSample {
    guard people.count == 1 else {
      return .missing(people.isEmpty ? .noPerson : .multiplePeople)
    }
    return try estimate(people[0])
  }
}

public struct Motion3DFrame: Encodable, Sendable {
  public let frameIndex: Int
  public let timestampMs: Double
  public let ptsValue: Int64
  public let ptsTimescale: Int32
  public let segmentId: Int
  public let status: Motion3DFrameStatus
  public let observationConfidence: Double?
  public let height: Motion3DHeight?
  public let cameraOriginMatrix: [Double]?
  public let joints: [Motion3DJoint]
  public let association: Motion3DAssociation?

  init(stamp: Motion3DFrameStamp, segmentId: Int, sample: Motion3DObservationSample) {
    frameIndex = stamp.frameIndex
    timestampMs = stamp.timestampMs
    ptsValue = stamp.pts.value
    ptsTimescale = stamp.pts.timescale
    self.segmentId = segmentId
    status = sample.status
    observationConfidence = sample.observationConfidence
    height = sample.height
    cameraOriginMatrix = sample.cameraOriginMatrix
    joints = sample.joints
    association = sample.association
  }

  private enum CodingKeys: String, CodingKey {
    case frameIndex, timestampMs, ptsValue, ptsTimescale, segmentId, status
    case observationConfidence, height, cameraOriginMatrix, joints, association
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(frameIndex, forKey: .frameIndex)
    try container.encode(timestampMs, forKey: .timestampMs)
    try container.encode(ptsValue, forKey: .ptsValue)
    try container.encode(ptsTimescale, forKey: .ptsTimescale)
    try container.encode(segmentId, forKey: .segmentId)
    try container.encode(status, forKey: .status)
    try container.encode(observationConfidence, forKey: .observationConfidence)
    try container.encode(height, forKey: .height)
    try container.encode(cameraOriginMatrix, forKey: .cameraOriginMatrix)
    try container.encode(joints, forKey: .joints)
    if let association { try container.encode(association, forKey: .association) }
  }
}

struct Motion3DFrameStamp {
  let frameIndex: Int
  let pts: CMTime
  var resetsContinuity = false
  var timestampMs: Double { Double(pts.value) * 1000 / Double(pts.timescale) }
}

struct Motion3DSamplingTimeline {
  private(set) var decodedFrames = 0
  private(set) var sampledFrames = 0
  private var previousPTS: CMTime?
  private var previousSamplePTS: CMTime?

  mutating func consume(pts: CMTime, durationMs: Double) throws -> Motion3DFrameStamp? {
    guard decodedFrames < Motion3DLimits.maxDecodedFrames else { throw Motion3DFailure.exceedsLimits }
    var stamp = Motion3DFrameStamp(frameIndex: decodedFrames, pts: pts)
    decodedFrames += 1
    guard durationMs.isFinite, (1...Motion3DLimits.maxDurationMs).contains(durationMs),
          pts.isNumeric, pts.epoch == 0, (1...1_000_000_000).contains(pts.timescale),
          (0...9_007_199_254_740_991).contains(pts.value),
          stamp.timestampMs.isFinite, (0...durationMs).contains(stamp.timestampMs) else {
      throw Motion3DFailure.invalidSource
    }
    if let previousPTS, CMTimeCompare(pts, previousPTS) <= 0 { throw Motion3DFailure.invalidSource }
    previousPTS = pts
    if let previousSamplePTS {
      guard Self.isSampleDue(pts, after: previousSamplePTS) else { return nil }
      let previousMs = Double(previousSamplePTS.value) * 1000 / Double(previousSamplePTS.timescale)
      stamp.resetsContinuity = stamp.timestampMs - previousMs > Motion3DLimits.maxContinuityGapMs
    }
    guard sampledFrames < Motion3DLimits.maxFrames else { throw Motion3DFailure.exceedsLimits }
    previousSamplePTS = pts
    sampledFrames += 1
    return stamp
  }

  private static func isSampleDue(_ pts: CMTime, after previous: CMTime) -> Bool {
    let currentProduct = UInt64(pts.value).multipliedFullWidth(by: UInt64(previous.timescale))
    let previousProduct = UInt64(previous.value).multipliedFullWidth(by: UInt64(pts.timescale))
    let (low, borrowed) = currentProduct.low.subtractingReportingOverflow(previousProduct.low)
    let high = currentProduct.high - previousProduct.high - (borrowed ? 1 : 0)
    let denominator = UInt64(pts.timescale) * UInt64(previous.timescale)
    let rate = UInt64(Motion3DLimits.maxSampleRate)
    let minimumNumerator = denominator / rate + (denominator % rate == 0 ? 0 : 1)
    return high > 0 || low >= minimumNumerator
  }
}

struct Motion3DSegments {
  private var segmentId = 0
  private var gap = false

  mutating func breakContinuity() { gap = true }

  mutating func consume(_ status: Motion3DFrameStatus) -> Int {
    if status == .estimated {
      if gap { segmentId += 1 }
      gap = false
    } else {
      gap = true
    }
    return segmentId
  }
}

enum Motion3DTrackGeometry {
  static func orientation(for transform: CGAffineTransform) throws -> CGImagePropertyOrientation {
    let values = [transform.a, transform.b, transform.c, transform.d, transform.tx, transform.ty]
    guard values.allSatisfy({ $0.isFinite && abs($0) <= 1_000_000 }) else { throw Motion3DFailure.invalidSource }
    let linear = [transform.a, transform.b, transform.c, transform.d]
    let candidates: [([CGFloat], CGImagePropertyOrientation)] = [
      ([1, 0, 0, 1], .up), ([-1, 0, 0, 1], .upMirrored),
      ([-1, 0, 0, -1], .down), ([1, 0, 0, -1], .downMirrored),
      ([0, 1, 1, 0], .leftMirrored), ([0, 1, -1, 0], .right),
      ([0, -1, -1, 0], .rightMirrored), ([0, -1, 1, 0], .left),
    ]
    guard let match = candidates.first(where: { candidate in
      zip(linear, candidate.0).allSatisfy { abs($0.0 - $0.1) < 0.00001 }
    }) else { throw Motion3DFailure.invalidSource }
    return match.1
  }

  static func dimensions(naturalSize: CGSize, transform: CGAffineTransform) throws -> (width: Int, height: Int) {
    guard naturalSize.width.isFinite, naturalSize.height.isFinite,
          (1...8192).contains(naturalSize.width), (1...8192).contains(naturalSize.height),
          abs(naturalSize.width.rounded() - naturalSize.width) < 0.0001,
          abs(naturalSize.height.rounded() - naturalSize.height) < 0.0001 else { throw Motion3DFailure.invalidSource }
    _ = try orientation(for: transform)
    let size = CGRect(origin: .zero, size: naturalSize).applying(transform).size
    guard size.width.isFinite, size.height.isFinite,
          (1...8192).contains(size.width.rounded()), (1...8192).contains(size.height.rounded()) else {
      throw Motion3DFailure.invalidSource
    }
    return (Int(size.width.rounded()), Int(size.height.rounded()))
  }
}

public enum Motion3DCapability {
  public static let available: Bool = {
    if #available(iOS 17.0, macOS 14.0, tvOS 17.0, *) {
      guard VNDetectHumanBodyPose3DRequest.supportedRevisions.contains(VNDetectHumanBodyPose3DRequestRevision1) else { return false }
      let request = VNDetectHumanBodyPose3DRequest()
      request.revision = VNDetectHumanBodyPose3DRequestRevision1
      guard let stages = try? request.supportedComputeStageDevices, !stages.isEmpty else { return false }
      return stages.values.allSatisfy { !$0.isEmpty }
    }
    return false
  }()
}

@available(iOS 17.0, macOS 14.0, tvOS 17.0, *)
public final class ApplePose3DProvider {
  static let jointMap: [(VNHumanBodyPose3DObservation.JointName, Motion3DJointName, VNHumanBodyPoseObservation.JointName?)] = [
    (.root, .root, .root), (.spine, .spine, nil),
    (.centerShoulder, .centerShoulder, nil), (.centerHead, .centerHead, nil), (.topHead, .topHead, nil),
    (.leftShoulder, .leftShoulder, .leftShoulder), (.leftElbow, .leftElbow, .leftElbow),
    (.leftWrist, .leftWrist, .leftWrist), (.rightShoulder, .rightShoulder, .rightShoulder),
    (.rightElbow, .rightElbow, .rightElbow), (.rightWrist, .rightWrist, .rightWrist),
    (.leftHip, .leftHip, .leftHip), (.leftKnee, .leftKnee, .leftKnee), (.leftAnkle, .leftAnkle, .leftAnkle),
    (.rightHip, .rightHip, .rightHip), (.rightKnee, .rightKnee, .rightKnee), (.rightAnkle, .rightAnkle, .rightAnkle),
  ]

  private(set) var request3D = ApplePose3DProvider.makeRequest()

  public init() {}

  public func reset() { request3D = Self.makeRequest() }

  private static func makeRequest() -> VNDetectHumanBodyPose3DRequest {
    let request = VNDetectHumanBodyPose3DRequest()
    request.revision = VNDetectHumanBodyPose3DRequestRevision1
    return request
  }

  public func extract(
    sampleBuffer: CMSampleBuffer,
    orientation: CGImagePropertyOrientation,
    cancellation: Motion3DCancellation
  ) throws -> Motion3DObservationSample {
    try cancellation.check()
    let handler = VNImageRequestHandler(cmSampleBuffer: sampleBuffer, orientation: orientation, options: [:])
    let peopleRequest = VNDetectHumanBodyPoseRequest()
    peopleRequest.revision = VNDetectHumanBodyPoseRequestRevision1
    do {
      try perform(peopleRequest, handler: handler, cancellation: cancellation)
      let sample = try Motion3DSinglePersonGuard.evaluate(people: peopleRequest.results ?? []) { person2D in
        try perform(request3D, handler: handler, cancellation: cancellation)
        let observations = request3D.results ?? []
        guard observations.count == 1 else {
          return .missing(observations.isEmpty ? .unavailable : .multiplePeople)
        }
        let observation = observations[0]
        let heightSource: Motion3DHeight.Source
        switch observation.heightEstimation {
        case .reference: heightSource = .reference
        case .measured: heightSource = .measured
        @unknown default: return .missing(.unavailable)
        }
        guard let height = Motion3DHeight.validated(meters: Double(observation.bodyHeight), source: heightSource) else {
          return .missing(.unavailable)
        }
        let confidence = Double(observation.confidence)
        let cameraMatrix = (0..<4).flatMap { column in (0..<4).map { row in Double(observation.cameraOriginMatrix[column][row]) } }
        guard confidence.isFinite, (0...1).contains(confidence),
              cameraMatrix.allSatisfy({ $0.isFinite && abs($0) <= 1_000_000 }) else { return .missing(.unavailable) }
        var joints: [Motion3DJoint] = []
        for (visionName, name, name2D) in Self.jointMap {
          try cancellation.check()
          guard observation.availableJointNames.contains(visionName),
                let point = try? observation.recognizedPoint(visionName),
                let projection = try? observation.pointInImage(visionName) else { continue }
          let visibility = name2D.flatMap { try? person2D.recognizedPoint($0) }.map { Double($0.confidence) }
          if let joint = Motion3DJoint.projected(
            name: name, position: point.position,
            imagePoint: CGPoint(x: projection.x, y: projection.y), visibility2D: visibility
          ) {
            joints.append(joint)
          }
        }
        guard joints.contains(where: { $0.name == .root }) else { return .missing(.unavailable) }
        return Motion3DObservationSample(
          status: .estimated, observationConfidence: confidence, height: height,
          cameraOriginMatrix: cameraMatrix, joints: joints
        )
      }
      if sample.status != .estimated { reset() }
      return sample
    } catch {
      reset()
      try cancellation.check()
      return .missing(.unavailable)
    }
  }

  private func perform(_ request: VNRequest, handler: VNImageRequestHandler, cancellation: Motion3DCancellation) throws {
    let registration = try cancellation.onCancel { request.cancel() }
    defer { cancellation.removeHandler(registration) }
    try cancellation.check()
    try handler.perform([request])
    try cancellation.check()
  }
}

struct Motion3DImagePoint: Sendable {
  let x: Double
  let y: Double
  let visibility: Double

  var isSupported: Bool {
    x.isFinite && y.isFinite && visibility.isFinite && (0...1).contains(x) && (0...1).contains(y)
      && (Motion3DAssociationParameters.minimumVisibility...1).contains(visibility)
  }
}

struct Motion3DTorso: Sendable {
  let x: Double
  let y: Double
  let span: Double
}

struct Motion3DPerson2D: Sendable {
  static let torsoJoints: [Motion3DJointName] = [.leftShoulder, .rightShoulder, .leftHip, .rightHip]
  static let commonJoints: [Motion3DJointName] = [
    .leftShoulder, .rightShoulder, .leftElbow, .rightElbow, .leftWrist, .rightWrist,
    .leftHip, .rightHip, .leftKnee, .rightKnee, .leftAnkle, .rightAnkle,
  ]
  let points: [Motion3DJointName: Motion3DImagePoint]
  var extentPoints: [Motion3DImagePoint] = []

  func point(_ name: Motion3DJointName) -> Motion3DImagePoint? {
    guard let point = points[name], point.isSupported else { return nil }
    return point
  }

  func torso(aspectRatio: Double) -> Motion3DTorso? {
    let torso = Self.torsoJoints.compactMap { point($0) }
    guard torso.count == 4 else { return nil }
    let shoulderX = (torso[0].x + torso[1].x) / 2
    let shoulderY = (torso[0].y + torso[1].y) / 2
    let hipX = (torso[2].x + torso[3].x) / 2
    let hipY = (torso[2].y + torso[3].y) / 2
    let span = hypot((shoulderX - hipX) * aspectRatio, shoulderY - hipY)
    guard span >= Motion3DAssociationParameters.minimumTorsoSpan else { return nil }
    return Motion3DTorso(x: (shoulderX + hipX) / 2, y: (shoulderY + hipY) / 2, span: span)
  }

  static func canonicalOrder(_ people: [Motion3DPerson2D], aspectRatio: Double) -> [Motion3DPerson2D] {
    people.sorted { left, right in
      let leftSpan = left.torso(aspectRatio: aspectRatio)?.span ?? 0
      let rightSpan = right.torso(aspectRatio: aspectRatio)?.span ?? 0
      if leftSpan != rightSpan { return leftSpan > rightSpan }
      for name in Motion3DJointName.allCases {
        let a = left.point(name)
        let b = right.point(name)
        if (a == nil) != (b == nil) { return a != nil }
        if let a, let b {
          if a.x != b.x { return a.x < b.x }
          if a.y != b.y { return a.y < b.y }
          if a.visibility != b.visibility { return a.visibility > b.visibility }
        }
      }
      return false
    }
  }
}

struct Motion3DTargetSelection {
  let people: [Motion3DPerson2D]
  let selectedCandidate: Int?
  let trackId: Int?
  let continuity: Motion3DContinuity
  let failure: Motion3DAssociationStatus?
  let aspectRatio: Double
  var torsoNormalizationSpan: Double? = nil

  func association(
    status: Motion3DAssociationStatus, commonJoints: Int = 0,
    reprojectionError: Double? = nil, runnerUpError: Double? = nil
  ) -> Motion3DAssociation {
    Motion3DAssociation(
      status: status, trackId: trackId, candidateCount: people.count, selectedCandidate: selectedCandidate,
      commonJoints: commonJoints, reprojectionError: reprojectionError, runnerUpError: runnerUpError,
      continuity: status == .matched ? continuity : .broken
    )
  }

  func rejected(
    _ status: Motion3DAssociationStatus, commonJoints: Int = 0,
    reprojectionError: Double? = nil, runnerUpError: Double? = nil
  ) -> Motion3DObservationSample {
    let frameStatus: Motion3DFrameStatus
    if status == .noPerson || (status == .targetLost && people.isEmpty) { frameStatus = .noPerson }
    else if status == .ambiguous || (status == .wrongPlayer && people.count > 1) { frameStatus = .multiplePeople }
    else { frameStatus = .unavailable }
    return Motion3DObservationSample(
      status: frameStatus, observationConfidence: nil, height: nil, cameraOriginMatrix: nil, joints: [],
      association: association(status: status, commonJoints: commonJoints, reprojectionError: reprojectionError, runnerUpError: runnerUpError)
    )
  }
}

struct Motion3DTargetTracker {
  private let seed: Motion3DTargetSeed?
  private var seedConsumed = false
  private var incumbent: Motion3DTorso?
  private var rivals: [Motion3DTorso] = []
  private var terminal = false
  private var previousTimestampMs: Double?

  init(seed: Motion3DTargetSeed? = nil) { self.seed = seed }

  mutating func breakContinuity() {
    if incumbent != nil { terminal = true }
  }

  mutating func select(people input: [Motion3DPerson2D], timestampMs: Double, aspectRatio: Double) throws -> Motion3DTargetSelection {
    guard input.count <= Motion3DAssociationParameters.maximumCandidates else { throw Motion3DFailure.exceedsLimits }
    guard timestampMs.isFinite, timestampMs >= 0, aspectRatio.isFinite, aspectRatio > 0 else { throw Motion3DFailure.invalidSource }
    if let previousTimestampMs {
      guard timestampMs > previousTimestampMs else { throw Motion3DFailure.invalidSource }
      if timestampMs - previousTimestampMs > Motion3DLimits.maxContinuityGapMs { breakContinuity() }
    }
    previousTimestampMs = timestampMs
    let people = Motion3DPerson2D.canonicalOrder(input, aspectRatio: aspectRatio)
    func rejected(_ failure: Motion3DAssociationStatus) -> Motion3DTargetSelection {
      Motion3DTargetSelection(
        people: people, selectedCandidate: nil, trackId: incumbent == nil ? nil : 1,
        continuity: .broken, failure: failure, aspectRatio: aspectRatio
      )
    }
    if terminal { return rejected(incumbent == nil ? .notSelected : .targetLost) }
    if let seed, incumbent == nil {
      if timestampMs < seed.timestampMs { return rejected(.notSelected) }
      guard !seedConsumed, timestampMs == seed.timestampMs else {
        terminal = true
        return rejected(.notSelected)
      }
      seedConsumed = true
    }
    guard !people.isEmpty else {
      if incumbent != nil { terminal = true }
      return rejected(incumbent == nil ? .noPerson : .targetLost)
    }
    let torsos = people.compactMap { $0.torso(aspectRatio: aspectRatio) }
    guard torsos.count == people.count else {
      if incumbent != nil { terminal = true }
      return rejected(incumbent == nil ? .insufficientSupport : .targetLost)
    }
    let chosen: Int
    let continuity: Motion3DContinuity
    if let incumbent {
      let pairs = torsos.enumerated().compactMap { index, torso -> (index: Int, cost: Double)? in
        guard let cost = Self.cost(from: incumbent, to: torso, aspectRatio: aspectRatio) else { return nil }
        return (index, cost)
      }.sorted { $0.cost < $1.cost }
      guard let best = pairs.first else {
        terminal = true
        return rejected(.targetLost)
      }
      let contestLimit = max(
        best.cost * Motion3DAssociationParameters.contestCostRatio,
        best.cost + Motion3DAssociationParameters.contestCostMargin
      )
      let rivalTrackCost = rivals.compactMap { Self.cost(from: $0, to: torsos[best.index], aspectRatio: aspectRatio) }.min()
      if (pairs.count > 1 && pairs[1].cost <= contestLimit) || (rivalTrackCost.map { $0 <= contestLimit } ?? false) {
        terminal = true
        return rejected(.ambiguous)
      }
      chosen = best.index
      continuity = .continuous
    } else if let seed {
      let pairs = torsos.enumerated().map { index, torso in
        (index: index, cost: hypot((torso.x - seed.x) * aspectRatio, torso.y - seed.y) / torso.span)
      }.sorted { $0.cost < $1.cost }
      let best = pairs[0]
      guard best.cost <= Motion3DAssociationParameters.seedMaximumDistance else { return rejected(.notSelected) }
      if pairs.count > 1 && (best.cost >= pairs[1].cost * Motion3DAssociationParameters.seedCostRatio
        || pairs[1].cost - best.cost <= Motion3DAssociationParameters.seedCostMargin) { return rejected(.ambiguous) }
      chosen = best.index
      continuity = .initial
    } else {
      if torsos.count > 1 && torsos[0].span < torsos[1].span * Motion3DAssociationParameters.prominenceRatio {
        return rejected(.ambiguous)
      }
      chosen = 0
      continuity = .initial
    }
    incumbent = torsos[chosen]
    rivals = torsos.enumerated().filter { $0.offset != chosen }.map { $0.element }
    return Motion3DTargetSelection(
      people: people, selectedCandidate: chosen, trackId: 1, continuity: continuity, failure: nil, aspectRatio: aspectRatio
    )
  }

  private static func cost(from old: Motion3DTorso, to new: Motion3DTorso, aspectRatio: Double) -> Double? {
    let distance = hypot((old.x - new.x) * aspectRatio, old.y - new.y)
    let displacement = distance / old.span
    let scaleRatio = max(old.span, new.span) / min(old.span, new.span)
    guard distance <= Motion3DAssociationParameters.matchRadius,
          displacement <= Motion3DAssociationParameters.maximumTorsoDisplacement,
          scaleRatio <= Motion3DAssociationParameters.maximumScaleRatio else { return nil }
    return displacement + (scaleRatio - 1) * Motion3DAssociationParameters.scaleCostWeight
  }
}

struct Motion3DCommonContinuity {
  static let scaleBones: [(Motion3DJointName, Motion3DJointName)] = [
    (.leftShoulder, .rightShoulder), (.leftShoulder, .leftHip), (.rightShoulder, .rightHip),
    (.leftHip, .rightHip), (.leftHip, .leftKnee), (.rightHip, .rightKnee),
    (.leftKnee, .leftAnkle), (.rightKnee, .rightAnkle),
  ]
  let commonJoints: Int
  let commonHips: Int
  let scaleFactor: Double
  let hipDisplacement: Double
  let jointResidual: Double
  let cost: Double

  static func scale(from old: Motion3DPerson2D, to new: Motion3DPerson2D, aspectRatio: Double) -> Double? {
    let ratios = scaleBones.compactMap { first, second -> Double? in
      guard let a = old.point(first), let b = old.point(second), let c = new.point(first), let d = new.point(second) else { return nil }
      let before = hypot((a.x - b.x) * aspectRatio, a.y - b.y)
      let after = hypot((c.x - d.x) * aspectRatio, c.y - d.y)
      guard min(before, after) >= Motion3DROIParameters.minimumScaleBoneSpan else { return nil }
      return after / before
    }.sorted()
    guard ratios.count >= Motion3DROIParameters.minimumScaleBones else { return nil }
    let mid = ratios.count / 2
    return ratios.count % 2 == 0 ? (ratios[mid - 1] + ratios[mid]) / 2 : ratios[mid]
  }

  static func compare(
    from old: Motion3DPerson2D, to new: Motion3DPerson2D, aspectRatio: Double, normalizationSpan: Double
  ) -> Motion3DCommonContinuity? {
    let names = Motion3DPerson2D.commonJoints.filter { old.point($0) != nil && new.point($0) != nil }
    let hips = [Motion3DJointName.leftHip, .rightHip].filter { names.contains($0) }
    guard names.count >= Motion3DROIParameters.minimumContinuityJoints, hips.count >= Motion3DROIParameters.minimumContinuityHips,
          let scaleFactor = scale(from: old, to: new, aspectRatio: aspectRatio), normalizationSpan >= Motion3DAssociationParameters.minimumTorsoSpan else { return nil }
    let dx = hips.reduce(0.0) { $0 + (new.point($1)!.x - old.point($1)!.x) * aspectRatio } / Double(hips.count)
    let dy = hips.reduce(0.0) { $0 + new.point($1)!.y - old.point($1)!.y } / Double(hips.count)
    let displacement = hypot(dx, dy)
    let scaleRatio = max(scaleFactor, 1 / scaleFactor)
    let residual = sqrt(names.reduce(0.0) { total, name in
      let before = old.point(name)!
      let after = new.point(name)!
      let x = (after.x - before.x) * aspectRatio - dx
      let y = after.y - before.y - dy
      return total + x * x + y * y
    } / Double(names.count)) / normalizationSpan
    guard displacement <= Motion3DAssociationParameters.matchRadius,
          displacement / normalizationSpan <= Motion3DAssociationParameters.maximumTorsoDisplacement,
          residual <= Motion3DAssociationParameters.maximumTorsoDisplacement,
          scaleRatio <= Motion3DAssociationParameters.maximumScaleRatio else { return nil }
    return Motion3DCommonContinuity(
      commonJoints: names.count, commonHips: hips.count, scaleFactor: scaleFactor,
      hipDisplacement: displacement, jointResidual: residual,
      cost: displacement / normalizationSpan + residual + (scaleRatio - 1) * Motion3DAssociationParameters.scaleCostWeight
    )
  }
}

struct Motion3DROITargetTracker {
  private var initializer: Motion3DTargetTracker
  private var reference: Motion3DPerson2D?
  private var referenceSpan: Double?
  private var previous: Motion3DPerson2D?
  private var previousSpan: Double?
  private var rivals: [Motion3DPerson2D] = []
  private var previousTimestampMs: Double?
  private var terminal = false

  init(seed: Motion3DTargetSeed? = nil) { initializer = Motion3DTargetTracker(seed: seed) }

  mutating func breakContinuity() {
    initializer.breakContinuity()
    if previous != nil { terminal = true }
  }

  mutating func select(people input: [Motion3DPerson2D], timestampMs: Double, aspectRatio: Double) throws -> Motion3DTargetSelection {
    guard input.count <= Motion3DAssociationParameters.maximumCandidates else { throw Motion3DFailure.exceedsLimits }
    guard timestampMs.isFinite, timestampMs >= 0, aspectRatio.isFinite, aspectRatio > 0 else { throw Motion3DFailure.invalidSource }
    if let previousTimestampMs {
      guard timestampMs > previousTimestampMs else { throw Motion3DFailure.invalidSource }
      if timestampMs - previousTimestampMs > Motion3DLimits.maxContinuityGapMs { breakContinuity() }
    }
    previousTimestampMs = timestampMs
    let people = Motion3DPerson2D.canonicalOrder(input, aspectRatio: aspectRatio)
    func rejected(_ status: Motion3DAssociationStatus) -> Motion3DTargetSelection {
      Motion3DTargetSelection(people: people, selectedCandidate: nil, trackId: previous == nil ? nil : 1, continuity: .broken, failure: status, aspectRatio: aspectRatio)
    }
    if terminal { return rejected(.targetLost) }
    guard let previous, let previousSpan, let reference, let referenceSpan else {
      var selection = try initializer.select(people: people, timestampMs: timestampMs, aspectRatio: aspectRatio)
      if selection.failure == nil, let index = selection.selectedCandidate, let torso = people[index].torso(aspectRatio: aspectRatio) {
        self.reference = people[index]
        self.referenceSpan = torso.span
        self.previous = people[index]
        self.previousSpan = torso.span
        rivals = people.enumerated().filter { $0.offset != index }.map(\.element)
        selection.torsoNormalizationSpan = torso.span
      }
      return selection
    }
    guard !people.isEmpty else { terminal = true; return rejected(.targetLost) }
    let comparisons = people.map { Motion3DCommonContinuity.compare(from: previous, to: $0, aspectRatio: aspectRatio, normalizationSpan: previousSpan) }
    let scales = people.map { Motion3DCommonContinuity.scale(from: reference, to: $0, aspectRatio: aspectRatio) }
    let ranked = people.indices.filter { index in
      guard comparisons[index] != nil, let scale = scales[index] else { return false }
      return max(scale, 1 / scale) <= Motion3DAssociationParameters.maximumScaleRatio
    }.sorted { comparisons[$0]!.cost < comparisons[$1]!.cost }
    guard let chosen = ranked.first else { terminal = true; return rejected(.targetLost) }
    let limit = max(comparisons[chosen]!.cost * Motion3DAssociationParameters.contestCostRatio, comparisons[chosen]!.cost + Motion3DAssociationParameters.contestCostMargin)
    if ranked.count > 1 && comparisons[ranked[1]]!.cost <= limit { terminal = true; return rejected(.ambiguous) }
    let unknownCurrentRival = people.indices.contains { index in
      index != chosen && comparisons[index] == nil && Self.couldContest(people[index], target: previous, aspectRatio: aspectRatio)
    }
    let contestedPrevious = rivals.contains { rival in
      if let comparison = Motion3DCommonContinuity.compare(from: rival, to: people[chosen], aspectRatio: aspectRatio, normalizationSpan: previousSpan) {
        return comparison.cost <= limit
      }
      return Self.couldContest(rival, target: people[chosen], aspectRatio: aspectRatio)
    }
    if unknownCurrentRival || contestedPrevious { terminal = true; return rejected(.ambiguous) }
    let span = referenceSpan * scales[chosen]!
    guard span >= Motion3DAssociationParameters.minimumTorsoSpan else { terminal = true; return rejected(.targetLost) }
    self.previous = people[chosen]
    self.previousSpan = span
    rivals = people.enumerated().filter { $0.offset != chosen }.map(\.element)
    return Motion3DTargetSelection(
      people: people, selectedCandidate: chosen, trackId: 1, continuity: .continuous, failure: nil,
      aspectRatio: aspectRatio, torsoNormalizationSpan: span
    )
  }

  private static func couldContest(_ person: Motion3DPerson2D, target: Motion3DPerson2D, aspectRatio: Double) -> Bool {
    let common = Motion3DPerson2D.commonJoints.filter { person.point($0) != nil && target.point($0) != nil }
    let sharedHips = [Motion3DJointName.leftHip, .rightHip].filter { common.contains($0) }
    let scale = Motion3DCommonContinuity.scale(from: target, to: person, aspectRatio: aspectRatio)
    if let scale, max(scale, 1 / scale) > Motion3DAssociationParameters.maximumScaleRatio { return false }
    if common.count >= Motion3DROIParameters.minimumContinuityJoints, sharedHips.count >= Motion3DROIParameters.minimumContinuityHips, scale != nil { return false }
    let hips = [Motion3DJointName.leftHip, .rightHip].compactMap { target.point($0) }
    guard !hips.isEmpty else { return true }
    let x = hips.reduce(0.0) { $0 + $1.x } / Double(hips.count)
    let y = hips.reduce(0.0) { $0 + $1.y } / Double(hips.count)
    let points = Motion3DPerson2D.commonJoints.compactMap { person.point($0) }
    return points.isEmpty || points.contains { hypot(($0.x - x) * aspectRatio, $0.y - y) <= Motion3DAssociationParameters.matchRadius }
  }
}

enum Motion3DProjectionAssociation {
  private struct Comparison {
    let commonJoints: Int
    let error: Double?
  }

  static func associate(selection: Motion3DTargetSelection, estimates: [Motion3DObservationSample]) -> Motion3DObservationSample {
    if let failure = selection.failure { return selection.rejected(failure) }
    guard selection.trackId != nil, selection.continuity != .broken,
          let selected = selection.selectedCandidate, selection.people.indices.contains(selected),
          let torsoSpan = selection.torsoNormalizationSpan ?? selection.people[selected].torso(aspectRatio: selection.aspectRatio)?.span,
          torsoSpan.isFinite, torsoSpan >= Motion3DAssociationParameters.minimumTorsoSpan,
          !estimates.isEmpty, estimates.count <= Motion3DAssociationParameters.maximumCandidates,
          estimates.allSatisfy({ $0.status == .estimated }) else { return selection.rejected(.insufficientSupport) }
    let comparisons = estimates.map {
      compare($0, person: selection.people[selected], aspectRatio: selection.aspectRatio, torsoSpan: torsoSpan)
    }
    guard comparisons.allSatisfy({ $0.error != nil }) else {
      return selection.rejected(.insufficientSupport, commonJoints: comparisons.map(\.commonJoints).max() ?? 0)
    }
    let ranked = comparisons.indices.sorted { comparisons[$0].error! < comparisons[$1].error! }
    let chosen = ranked[0]
    let best = comparisons[chosen]
    let error = best.error!
    let rivalComparisons = selection.people.indices.filter { $0 != selected }.map {
      compare(estimates[chosen], person: selection.people[$0], aspectRatio: selection.aspectRatio, torsoSpan: torsoSpan)
    }
    let runnerUp = (rivalComparisons.compactMap(\.error) + ranked.dropFirst().compactMap { comparisons[$0].error }).min()
    if error > Motion3DAssociationParameters.maximumReprojectionError || (runnerUp.map { $0 < error } ?? false) {
      return selection.rejected(.wrongPlayer, commonJoints: best.commonJoints, reprojectionError: error, runnerUpError: runnerUp)
    }
    guard rivalComparisons.allSatisfy({ $0.error != nil }) else {
      return selection.rejected(.insufficientSupport, commonJoints: best.commonJoints, reprojectionError: error, runnerUpError: runnerUp)
    }
    if let runnerUp, runnerUp <= max(error * Motion3DAssociationParameters.projectionRatio, error + Motion3DAssociationParameters.projectionMargin) {
      return selection.rejected(.ambiguous, commonJoints: best.commonJoints, reprojectionError: error, runnerUpError: runnerUp)
    }
    let estimate = estimates[chosen]
    let joints = estimate.joints.map { joint in
      Motion3DJoint(
        name: joint.name, x: joint.x, y: joint.y, z: joint.z, imageX: joint.imageX, imageY: joint.imageY,
        visibility2D: selection.people[selected].points[joint.name].flatMap {
          $0.visibility.isFinite && (0...1).contains($0.visibility) ? $0.visibility : nil
        }
      )
    }
    return Motion3DObservationSample(
      status: .estimated, observationConfidence: estimate.observationConfidence, height: estimate.height,
      cameraOriginMatrix: estimate.cameraOriginMatrix, joints: joints,
      association: selection.association(status: .matched, commonJoints: best.commonJoints, reprojectionError: error, runnerUpError: runnerUp)
    )
  }

  private static func compare(
    _ estimate: Motion3DObservationSample, person: Motion3DPerson2D, aspectRatio: Double, torsoSpan: Double
  ) -> Comparison {
    guard Set(estimate.joints.map(\.name)).count == estimate.joints.count else { return Comparison(commonJoints: 0, error: nil) }
    let projected = Dictionary(uniqueKeysWithValues: estimate.joints.map { ($0.name, $0) })
    var squaredError = 0.0
    var count = 0
    var torsoCount = 0
    for name in Motion3DPerson2D.commonJoints {
      guard let point = person.point(name), let joint = projected[name],
            joint.imageX.isFinite, joint.imageY.isFinite,
            (0...1).contains(joint.imageX), (0...1).contains(joint.imageY) else { continue }
      let dx = (joint.imageX - point.x) * aspectRatio / torsoSpan
      let dy = (joint.imageY - point.y) / torsoSpan
      squaredError += dx * dx + dy * dy
      count += 1
      if Motion3DPerson2D.torsoJoints.contains(name) { torsoCount += 1 }
    }
    guard count >= Motion3DAssociationParameters.minimumCommonJoints,
          torsoCount >= Motion3DAssociationParameters.minimumProjectionTorsoJoints else { return Comparison(commonJoints: count, error: nil) }
    let error = sqrt(squaredError / Double(count))
    return Comparison(commonJoints: count, error: error.isFinite && error <= 1_000_000 ? error : nil)
  }
}

@available(iOS 17.0, macOS 14.0, tvOS 17.0, *)
public final class ApplePose3DAssociatedProvider {
  private(set) var request3D = ApplePose3DAssociatedProvider.makeRequest()
  private var tracker: Motion3DTargetTracker

  public init(targetSeed: Motion3DTargetSeed? = nil) { tracker = Motion3DTargetTracker(seed: targetSeed) }

  public func breakContinuity() {
    tracker.breakContinuity()
    resetRequest()
  }

  private func resetRequest() { request3D = Self.makeRequest() }

  private static func makeRequest() -> VNDetectHumanBodyPose3DRequest {
    let request = VNDetectHumanBodyPose3DRequest()
    request.revision = VNDetectHumanBodyPose3DRequestRevision1
    return request
  }

  static func aspectRatio(width: Int, height: Int, orientation: CGImagePropertyOrientation) throws -> Double {
    guard width > 0, height > 0 else { throw Motion3DFailure.invalidSource }
    switch orientation {
    case .left, .right, .leftMirrored, .rightMirrored: return Double(height) / Double(width)
    case .up, .down, .upMirrored, .downMirrored: return Double(width) / Double(height)
    @unknown default: throw Motion3DFailure.invalidSource
    }
  }

  public func extract(
    sampleBuffer: CMSampleBuffer, orientation: CGImagePropertyOrientation, cancellation: Motion3DCancellation
  ) throws -> Motion3DObservationSample {
    try cancellation.check()
    guard let pixels = CMSampleBufferGetImageBuffer(sampleBuffer) else { throw Motion3DFailure.decodingFailed }
    let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
    guard pts.isNumeric, pts.epoch == 0, pts.timescale > 0 else { throw Motion3DFailure.invalidSource }
    let timestampMs = Double(pts.value) * 1000 / Double(pts.timescale)
    let aspect = try Self.aspectRatio(width: CVPixelBufferGetWidth(pixels), height: CVPixelBufferGetHeight(pixels), orientation: orientation)
    let handler = VNImageRequestHandler(cmSampleBuffer: sampleBuffer, orientation: orientation, options: [:])
    let request2D = VNDetectHumanBodyPoseRequest()
    request2D.revision = VNDetectHumanBodyPoseRequestRevision1
    do { try perform(request2D, handler: handler, cancellation: cancellation) }
    catch {
      resetRequest()
      try cancellation.check()
      let selection = try tracker.select(people: [], timestampMs: timestampMs, aspectRatio: aspect)
      return selection.rejected(selection.trackId == nil ? .insufficientSupport : .targetLost)
    }
    let people = (request2D.results ?? []).map { observation in
      var points: [Motion3DJointName: Motion3DImagePoint] = [:]
      for (_, name, vision2D) in ApplePose3DProvider.jointMap {
        guard let vision2D, let point = try? observation.recognizedPoint(vision2D) else { continue }
        points[name] = Motion3DImagePoint(x: Double(point.x), y: 1 - Double(point.y), visibility: Double(point.confidence))
      }
      return Motion3DPerson2D(points: points)
    }
    let selection = try tracker.select(people: people, timestampMs: timestampMs, aspectRatio: aspect)
    if let failure = selection.failure {
      resetRequest()
      return selection.rejected(failure)
    }
    do {
      try perform(request3D, handler: handler, cancellation: cancellation)
      let observations = request3D.results ?? []
      guard observations.count <= Motion3DAssociationParameters.maximumCandidates else { throw Motion3DFailure.exceedsLimits }
      let estimates = try observations.map { try Self.sample($0, cancellation: cancellation) }
      return complete(selection: selection, estimates: estimates)
    } catch {
      resetRequest()
      try cancellation.check()
      if let failure = error as? Motion3DFailure { throw failure }
      return selection.rejected(.insufficientSupport)
    }
  }

  func complete(selection: Motion3DTargetSelection, estimates: [Motion3DObservationSample]) -> Motion3DObservationSample {
    let associated = Motion3DProjectionAssociation.associate(selection: selection, estimates: estimates)
    if associated.status != .estimated { resetRequest() }
    return associated
  }

  static func sample(_ observation: VNHumanBodyPose3DObservation, cancellation: Motion3DCancellation) throws -> Motion3DObservationSample {
    let heightSource: Motion3DHeight.Source
    switch observation.heightEstimation {
    case .reference: heightSource = .reference
    case .measured: heightSource = .measured
    @unknown default: return .missing(.unavailable)
    }
    guard let height = Motion3DHeight.validated(meters: Double(observation.bodyHeight), source: heightSource) else { return .missing(.unavailable) }
    let confidence = Double(observation.confidence)
    let cameraMatrix = (0..<4).flatMap { column in (0..<4).map { row in Double(observation.cameraOriginMatrix[column][row]) } }
    guard confidence.isFinite, (0...1).contains(confidence),
          cameraMatrix.allSatisfy({ $0.isFinite && abs($0) <= 1_000_000 }) else { return .missing(.unavailable) }
    var joints: [Motion3DJoint] = []
    for (visionName, name, _) in ApplePose3DProvider.jointMap {
      try cancellation.check()
      guard observation.availableJointNames.contains(visionName),
            let point = try? observation.recognizedPoint(visionName),
            let projection = try? observation.pointInImage(visionName) else { continue }
      if let joint = Motion3DJoint.projected(
        name: name, position: point.position, imagePoint: CGPoint(x: projection.x, y: projection.y), visibility2D: nil
      ) { joints.append(joint) }
    }
    guard joints.contains(where: { $0.name == .root }) else { return .missing(.unavailable) }
    return Motion3DObservationSample(
      status: .estimated, observationConfidence: confidence, height: height, cameraOriginMatrix: cameraMatrix, joints: joints
    )
  }

  private func perform(_ request: VNRequest, handler: VNImageRequestHandler, cancellation: Motion3DCancellation) throws {
    let registration = try cancellation.onCancel { request.cancel() }
    defer { cancellation.removeHandler(registration) }
    try cancellation.check()
    try handler.perform([request])
    try cancellation.check()
  }
}

struct Motion3DROIRegion: Encodable, Equatable, Sendable {
  let x: Double
  let y: Double
  let width: Double
  let height: Double
}

struct Motion3DInference: Encodable, Equatable, Sendable {
  let mode = "fixed_roi"
  let coordinateSystem = "normalized_image_top_left"
  let region: Motion3DROIRegion
  let pixelWidth: Int
  let pixelHeight: Int
  let cameraModelSpace = "inference_camera"
  let transformVersion = "motion-inference-roi-1"
}

struct Motion3DFixedROI: Equatable, Sendable {
  let sourceWidth: Int
  let sourceHeight: Int
  let pixelX: Int
  let pixelY: Int
  let pixelWidth: Int
  let pixelHeight: Int

  init(sourceWidth: Int, sourceHeight: Int, pixelX: Int, pixelY: Int, pixelWidth: Int, pixelHeight: Int) throws {
    guard (1...8192).contains(sourceWidth), (1...8192).contains(sourceHeight),
          pixelX >= 0, pixelY >= 0, pixelWidth > 0, pixelHeight > 0,
          pixelWidth <= sourceWidth, pixelHeight <= sourceHeight,
          pixelX <= sourceWidth - pixelWidth, pixelY <= sourceHeight - pixelHeight else { throw Motion3DFailure.invalidOptions }
    guard pixelWidth <= Motion3DROIParameters.maximumPixelSide, pixelHeight <= Motion3DROIParameters.maximumPixelSide,
          pixelWidth * pixelHeight <= Motion3DROIParameters.maximumPixels else { throw Motion3DFailure.exceedsLimits }
    self.sourceWidth = sourceWidth
    self.sourceHeight = sourceHeight
    self.pixelX = pixelX
    self.pixelY = pixelY
    self.pixelWidth = pixelWidth
    self.pixelHeight = pixelHeight
  }

  var inference: Motion3DInference {
    Motion3DInference(region: Motion3DROIRegion(
      x: Double(pixelX) / Double(sourceWidth), y: Double(pixelY) / Double(sourceHeight),
      width: Double(pixelWidth) / Double(sourceWidth), height: Double(pixelHeight) / Double(sourceHeight)
    ), pixelWidth: pixelWidth, pixelHeight: pixelHeight)
  }

  static func selectedPerson(_ person: Motion3DPerson2D, sourceWidth: Int, sourceHeight: Int) throws -> Motion3DFixedROI? {
    guard (1...8192).contains(sourceWidth), (1...8192).contains(sourceHeight) else { throw Motion3DFailure.invalidSource }
    let aspect = Double(sourceWidth) / Double(sourceHeight)
    guard let torso = person.torso(aspectRatio: aspect), person.point(.leftAnkle) != nil, person.point(.rightAnkle) != nil,
          Motion3DPerson2D.commonJoints.compactMap({ person.point($0) }).count >= Motion3DROIParameters.minimumInitialBodyJoints else { return nil }
    let points = person.points.values.filter(\.isSupported) + person.extentPoints.filter(\.isSupported)
    guard let minX = points.map(\.x).min(), let maxX = points.map(\.x).max(),
          let minY = points.map(\.y).min(), let maxY = points.map(\.y).max() else { return nil }
    let paddingY = torso.span * Motion3DROIParameters.paddingTorsoSpans
    let paddingX = paddingY / aspect
    let left = max(0, Int(floor((minX - paddingX) * Double(sourceWidth))))
    let top = max(0, Int(floor((minY - paddingY) * Double(sourceHeight))))
    let right = min(sourceWidth, Int(ceil((maxX + paddingX) * Double(sourceWidth))))
    let bottom = min(sourceHeight, Int(ceil((maxY + paddingY) * Double(sourceHeight))))
    guard right - left >= Motion3DROIParameters.minimumPixelSide, bottom - top >= Motion3DROIParameters.minimumPixelSide else { return nil }
    return try Motion3DFixedROI(sourceWidth: sourceWidth, sourceHeight: sourceHeight, pixelX: left, pixelY: top, pixelWidth: right - left, pixelHeight: bottom - top)
  }

  func fullImagePoint(x: Double, y: Double) -> CGPoint? {
    guard x.isFinite, y.isFinite, (0...1).contains(x), (0...1).contains(y) else { return nil }
    return CGPoint(x: (Double(pixelX) + x * Double(pixelWidth)) / Double(sourceWidth), y: (Double(pixelY) + y * Double(pixelHeight)) / Double(sourceHeight))
  }

  func contains(_ person: Motion3DPerson2D) -> Bool {
    let points = person.points.values.filter(\.isSupported) + person.extentPoints.filter(\.isSupported)
    let region = inference.region
    return !points.isEmpty && points.allSatisfy {
      $0.x >= region.x && $0.x <= region.x + region.width && $0.y >= region.y && $0.y <= region.y + region.height
    }
  }

  func mapped(_ sample: Motion3DObservationSample) -> Motion3DObservationSample {
    guard sample.status == .estimated else { return sample }
    let joints = sample.joints.compactMap { joint -> Motion3DJoint? in
      guard let point = fullImagePoint(x: joint.imageX, y: joint.imageY) else { return nil }
      return Motion3DJoint(name: joint.name, x: joint.x, y: joint.y, z: joint.z, imageX: point.x, imageY: point.y, visibility2D: joint.visibility2D)
    }
    guard joints.contains(where: { $0.name == .root }) else { return .missing(.unavailable) }
    return Motion3DObservationSample(status: sample.status, observationConfidence: sample.observationConfidence, height: sample.height, cameraOriginMatrix: sample.cameraOriginMatrix, joints: joints)
  }
}

final class Motion3DROIRenderer {
  let roi: Motion3DFixedROI
  private let pool: CVPixelBufferPool
  private let context = CIContext(options: [.cacheIntermediates: false])
  private let colorSpace = CGColorSpaceCreateDeviceRGB()

  init(roi: Motion3DFixedROI) throws {
    self.roi = roi
    var pool: CVPixelBufferPool?
    let status = CVPixelBufferPoolCreate(kCFAllocatorDefault, [kCVPixelBufferPoolMinimumBufferCountKey: 1] as CFDictionary, [
      kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_32BGRA,
      kCVPixelBufferWidthKey: roi.pixelWidth, kCVPixelBufferHeightKey: roi.pixelHeight,
      kCVPixelBufferIOSurfacePropertiesKey: [:],
    ] as CFDictionary, &pool)
    guard status == kCVReturnSuccess, let pool else { throw Motion3DFailure.decodingFailed }
    self.pool = pool
  }

  func render(sampleBuffer: CMSampleBuffer, orientation: CGImagePropertyOrientation) throws -> CMSampleBuffer {
    guard CMSampleBufferDataIsReady(sampleBuffer), CMSampleBufferGetNumSamples(sampleBuffer) == 1,
          let pixels = CMSampleBufferGetImageBuffer(sampleBuffer) else { throw Motion3DFailure.decodingFailed }
    let oriented = CIImage(cvPixelBuffer: pixels).oriented(orientation)
    let extent = oriented.extent
    guard extent.width == CGFloat(roi.sourceWidth), extent.height == CGFloat(roi.sourceHeight) else { throw Motion3DFailure.invalidSource }
    let upright = oriented.transformed(by: CGAffineTransform(translationX: -extent.minX, y: -extent.minY))
    let rect = CGRect(x: roi.pixelX, y: roi.sourceHeight - roi.pixelY - roi.pixelHeight, width: roi.pixelWidth, height: roi.pixelHeight)
    let cropped = upright.cropped(to: rect).transformed(by: CGAffineTransform(translationX: -rect.minX, y: -rect.minY))
    var output: CVPixelBuffer?
    let allocation = CVPixelBufferPoolCreatePixelBufferWithAuxAttributes(kCFAllocatorDefault, pool, [
      kCVPixelBufferPoolAllocationThresholdKey: Motion3DROIParameters.maximumBuffers,
    ] as CFDictionary, &output)
    guard allocation != kCVReturnWouldExceedAllocationThreshold else { throw Motion3DFailure.exceedsLimits }
    guard allocation == kCVReturnSuccess, let output else { throw Motion3DFailure.decodingFailed }
    context.render(cropped, to: output, bounds: CGRect(x: 0, y: 0, width: roi.pixelWidth, height: roi.pixelHeight), colorSpace: colorSpace)
    var format: CMVideoFormatDescription?
    guard CMVideoFormatDescriptionCreateForImageBuffer(allocator: kCFAllocatorDefault, imageBuffer: output, formatDescriptionOut: &format) == noErr,
          let format else { throw Motion3DFailure.decodingFailed }
    var timing = CMSampleTimingInfo()
    guard CMSampleBufferGetSampleTimingInfo(sampleBuffer, at: 0, timingInfoOut: &timing) == noErr,
          timing.presentationTimeStamp.isNumeric, timing.presentationTimeStamp.epoch == 0 else { throw Motion3DFailure.invalidSource }
    var sample: CMSampleBuffer?
    guard CMSampleBufferCreateReadyWithImageBuffer(allocator: kCFAllocatorDefault, imageBuffer: output, formatDescription: format, sampleTiming: &timing, sampleBufferOut: &sample) == noErr,
          let sample else { throw Motion3DFailure.decodingFailed }
    return sample
  }
}

@available(iOS 17.0, macOS 14.0, tvOS 17.0, *)
public final class ApplePose3DROIProvider {
  private var tracker: Motion3DROITargetTracker
  private var renderer: Motion3DROIRenderer?
  private var selectionAttempted = false
  private(set) var request3D = ApplePose3DROIProvider.makeRequest()
  var inference: Motion3DInference? { renderer?.roi.inference }

  public init(targetSeed: Motion3DTargetSeed? = nil) { tracker = Motion3DROITargetTracker(seed: targetSeed) }

  private static func makeRequest() -> VNDetectHumanBodyPose3DRequest {
    let request = VNDetectHumanBodyPose3DRequest()
    request.revision = VNDetectHumanBodyPose3DRequestRevision1
    return request
  }

  public func breakContinuity() {
    tracker.breakContinuity()
    request3D = Self.makeRequest()
  }

  static func people(_ observations: [VNHumanBodyPoseObservation]) -> [Motion3DPerson2D] {
    observations.map { observation in
      var points: [Motion3DJointName: Motion3DImagePoint] = [:]
      for (_, name, vision) in ApplePose3DProvider.jointMap {
        guard let vision, let point = try? observation.recognizedPoint(vision) else { continue }
        points[name] = Motion3DImagePoint(x: point.x, y: 1 - point.y, visibility: Double(point.confidence))
      }
      let head: [VNHumanBodyPoseObservation.JointName] = [.nose, .leftEye, .rightEye, .leftEar, .rightEar]
      return Motion3DPerson2D(points: points, extentPoints: head.compactMap { name in
        guard let point = try? observation.recognizedPoint(name) else { return nil }
        return Motion3DImagePoint(x: point.x, y: 1 - point.y, visibility: Double(point.confidence))
      })
    }
  }

  public func extract(sampleBuffer: CMSampleBuffer, orientation: CGImagePropertyOrientation, cancellation: Motion3DCancellation) throws -> Motion3DObservationSample {
    try cancellation.check()
    guard let pixels = CMSampleBufferGetImageBuffer(sampleBuffer) else { throw Motion3DFailure.decodingFailed }
    let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
    guard pts.isNumeric, pts.epoch == 0, pts.timescale > 0 else { throw Motion3DFailure.invalidSource }
    let timestampMs = Double(pts.value) * 1000 / Double(pts.timescale)
    let aspect = try ApplePose3DAssociatedProvider.aspectRatio(width: CVPixelBufferGetWidth(pixels), height: CVPixelBufferGetHeight(pixels), orientation: orientation)
    let request2D = VNDetectHumanBodyPoseRequest()
    request2D.revision = VNDetectHumanBodyPoseRequestRevision1
    let handler = VNImageRequestHandler(cmSampleBuffer: sampleBuffer, orientation: orientation, options: [:])
    do { try perform(request2D, handler: handler, cancellation: cancellation) }
    catch {
      request3D = Self.makeRequest()
      try cancellation.check()
      let selection = try tracker.select(people: [], timestampMs: timestampMs, aspectRatio: aspect)
      return selection.rejected(selection.trackId == nil ? .insufficientSupport : .targetLost)
    }
    let selection = try tracker.select(people: Self.people(request2D.results ?? []), timestampMs: timestampMs, aspectRatio: aspect)
    if let failure = selection.failure { request3D = Self.makeRequest(); return selection.rejected(failure) }
    guard let selected = selection.selectedCandidate else { throw Motion3DFailure.decodingFailed }
    if !selectionAttempted {
      selectionAttempted = true
      let extent = CIImage(cvPixelBuffer: pixels).oriented(orientation).extent
      if let roi = try Motion3DFixedROI.selectedPerson(selection.people[selected], sourceWidth: Int(extent.width), sourceHeight: Int(extent.height)) {
        renderer = try Motion3DROIRenderer(roi: roi)
      }
    }
    guard let renderer, renderer.roi.contains(selection.people[selected]) else {
      request3D = Self.makeRequest()
      return selection.rejected(.insufficientSupport)
    }
    do {
      let roiSample = try renderer.render(sampleBuffer: sampleBuffer, orientation: orientation)
      guard CMSampleBufferGetPresentationTimeStamp(roiSample) == pts else { throw Motion3DFailure.invalidSource }
      let roiHandler = VNImageRequestHandler(cmSampleBuffer: roiSample, orientation: .up, options: [:])
      try perform(request3D, handler: roiHandler, cancellation: cancellation)
      let observations = request3D.results ?? []
      guard observations.count <= Motion3DAssociationParameters.maximumCandidates else { throw Motion3DFailure.exceedsLimits }
      let estimates = try observations.map { renderer.roi.mapped(try ApplePose3DAssociatedProvider.sample($0, cancellation: cancellation)) }
      let associated = Motion3DProjectionAssociation.associate(selection: selection, estimates: estimates)
      if associated.status != .estimated { request3D = Self.makeRequest() }
      return associated
    } catch {
      request3D = Self.makeRequest()
      try cancellation.check()
      if let failure = error as? Motion3DFailure { throw failure }
      return selection.rejected(.insufficientSupport)
    }
  }

  private func perform(_ request: VNRequest, handler: VNImageRequestHandler, cancellation: Motion3DCancellation) throws {
    let registration = try cancellation.onCancel { request.cancel() }
    defer { cancellation.removeHandler(registration) }
    try cancellation.check()
    try handler.perform([request])
    try cancellation.check()
  }
}

public enum Motion3DSourceSecurity {
  public static func resolve(
    storedURI: String,
    capturesDirectory: URL,
    resolveCaptureURL: (String) -> URL?
  ) throws -> URL {
    guard Motion3DLimits.validStoredURI(storedURI),
          let relocated = resolveCaptureURL(storedURI),
          Motion3DLimits.validStoredURI(relocated.absoluteString), capturesDirectory.isFileURL else {
      throw Motion3DFailure.invalidSource
    }
    let root = capturesDirectory.standardizedFileURL
    let canonicalRoot = root.resolvingSymlinksInPath()
    let resolved = relocated.standardizedFileURL.resolvingSymlinksInPath()
    guard root.path == canonicalRoot.path,
          resolved.deletingLastPathComponent().path == canonicalRoot.path else {
      throw Motion3DFailure.invalidSource
    }
    _ = try Motion3DFileSnapshot(url: resolved)
    return resolved
  }
}

struct Motion3DFileSnapshot: Equatable {
  let byteLength: Int
  let fileNumber: UInt64
  let deviceNumber: UInt64
  let modifiedAt: Date

  init(url: URL) throws {
    guard Motion3DLimits.validStoredURI(url.absoluteString) else { throw Motion3DFailure.invalidSource }
    let attributes: [FileAttributeKey: Any]
    do { attributes = try FileManager.default.attributesOfItem(atPath: url.path) }
    catch { throw Motion3DFailure.invalidSource }
    guard attributes[.type] as? FileAttributeType == .typeRegular,
          let size = attributes[.size] as? NSNumber, size.int64Value > 0,
          let fileNumber = attributes[.systemFileNumber] as? NSNumber,
          let deviceNumber = attributes[.systemNumber] as? NSNumber,
          let modifiedAt = attributes[.modificationDate] as? Date else { throw Motion3DFailure.invalidSource }
    guard size.int64Value <= Motion3DLimits.maxVideoBytes else { throw Motion3DFailure.exceedsLimits }
    byteLength = size.intValue
    self.fileNumber = fileNumber.uint64Value
    self.deviceNumber = deviceNumber.uint64Value
    self.modifiedAt = modifiedAt
  }
}

struct Motion3DVideoFingerprint {
  let sha256: String
  let snapshot: Motion3DFileSnapshot

  static func read(url: URL, cancellation: Motion3DCancellation) throws -> Motion3DVideoFingerprint {
    try cancellation.check()
    let snapshot = try Motion3DFileSnapshot(url: url)
    let handle: FileHandle
    do { handle = try FileHandle(forReadingFrom: url) }
    catch { throw Motion3DFailure.invalidSource }
    defer { try? handle.close() }
    var hasher = SHA256()
    var byteLength = 0
    while true {
      try cancellation.check()
      let chunk: Data
      do { chunk = try handle.read(upToCount: Motion3DLimits.hashChunkBytes) ?? Data() }
      catch { throw Motion3DFailure.invalidSource }
      if chunk.isEmpty { break }
      guard chunk.count <= Motion3DLimits.maxVideoBytes - byteLength else { throw Motion3DFailure.exceedsLimits }
      byteLength += chunk.count
      hasher.update(data: chunk)
    }
    try cancellation.check()
    guard byteLength == snapshot.byteLength, try Motion3DFileSnapshot(url: url) == snapshot else {
      throw Motion3DFailure.invalidSource
    }
    return Motion3DVideoFingerprint(sha256: hasher.finalize().map { String(format: "%02x", $0) }.joined(), snapshot: snapshot)
  }
}

struct Motion3DSource: Encodable {
  let captureId: String
  let videoSha256: String
  let videoByteLength: Int
  let width: Int
  let height: Int
  let durationMs: Double
  let nominalFrameRate: Double
  let preferredTransform: [Double]
  let orientationPolicy = "preferred_track_transform_applied"
  let mirroring = "as_encoded"
}

private struct Motion3DJSONNull: Encodable {
  func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    try container.encodeNil()
  }
}

private struct Motion3DEstimator: Encodable {
  let providerId = "pose.apple-vision-3d"
  let revision = 1
  let osVersion: String
  let modelAsset = "os_managed"
  let modelAssetSha256 = Motion3DJSONNull()
  let configurationVersion: String
  let maxSampleRate = 30

  init(osVersion: String, configurationVersion: String = "apple-vision-3d-raw-1") {
    self.osVersion = osVersion
    self.configurationVersion = configurationVersion
  }
}

private struct Motion3DArtifactHeader: Encodable {
  let schemaVersion = 1
  let format = "pickle.motion-3d.v1"
  let role = "reconstructed_estimate"
  let coordinateSystem = "vision_root_relative"
  let axes = "right_handed_y_up"
  let units = "vision_estimated_meters"
  let imageCoordinates = "normalized_image_top_left"
  let uncertainty = "uncalibrated"
  let temporalProcessing = "none"
  let source: Motion3DSource
  let estimator: Motion3DEstimator
}

private struct Motion3DAssociatedArtifactHeader: Encodable {
  let schemaVersion = 2
  let format = "pickle.motion-3d.v2"
  let role = "reconstructed_estimate"
  let coordinateSystem = "vision_root_relative"
  let axes = "right_handed_y_up"
  let units = "vision_estimated_meters"
  let imageCoordinates = "normalized_image_top_left"
  let uncertainty = "uncalibrated"
  let temporalProcessing = "none"
  let source: Motion3DSource
  let estimator: Motion3DEstimator
  let identityPolicy: Motion3DIdentityPolicy
}

public struct Motion3DReceipt: Sendable {
  public let json: String
  public let sha256: String
}

struct Motion3DJSONBuilder {
  private let encoder: JSONEncoder
  private let requiresInference: Bool
  private var data = Data()
  private var hasher = SHA256()
  private(set) var frameCount = 0

  init(
    source: Motion3DSource, osVersion: String = ProcessInfo.processInfo.operatingSystemVersionString,
    identityPolicy: Motion3DIdentityPolicy? = nil
  ) throws {
    guard !osVersion.isEmpty, osVersion.utf8.count <= 128 else { throw Motion3DFailure.unavailable }
    requiresInference = identityPolicy?.version == "motion-target-association-2"
    encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    var encoded: Data
    if let identityPolicy {
      encoded = try encoder.encode(Motion3DAssociatedArtifactHeader(
        source: source, estimator: Motion3DEstimator(osVersion: osVersion, configurationVersion: requiresInference ? "apple-vision-3d-associated-roi-3" : "apple-vision-3d-associated-2"),
        identityPolicy: identityPolicy
      ))
    } else {
      let header = Motion3DArtifactHeader(source: source, estimator: Motion3DEstimator(osVersion: osVersion))
      encoded = try encoder.encode(header)
    }
    guard encoded.last == 125 else { throw Motion3DFailure.decodingFailed }
    encoded.removeLast()
    try appendBytes(encoded)
    try appendBytes(Data(",\"frames\":[".utf8))
  }

  mutating func append(_ frame: Motion3DFrame) throws {
    guard frameCount < Motion3DLimits.maxFrames else { throw Motion3DFailure.exceedsLimits }
    let encoded = try encoder.encode(frame)
    guard encoded.count + (frameCount == 0 ? 0 : 1) + 2 <= Motion3DLimits.maxJSONBytes - data.count else {
      throw Motion3DFailure.exceedsLimits
    }
    if frameCount > 0 { try appendBytes(Data([44])) }
    try appendBytes(encoded)
    frameCount += 1
  }

  mutating func finish(inference: Motion3DInference? = nil) throws -> Motion3DReceipt {
    guard frameCount > 0 else { throw Motion3DFailure.decodingFailed }
    guard requiresInference == (inference != nil) else { throw requiresInference ? Motion3DFailure.unavailable : .decodingFailed }
    if let inference {
      try appendBytes(Data("],\"inference\":".utf8))
      try appendBytes(encoder.encode(inference))
      try appendBytes(Data("}".utf8))
    } else { try appendBytes(Data("]}".utf8)) }
    guard let json = String(data: data, encoding: .utf8) else { throw Motion3DFailure.decodingFailed }
    return Motion3DReceipt(json: json, sha256: hasher.finalize().map { String(format: "%02x", $0) }.joined())
  }

  private mutating func appendBytes(_ bytes: Data) throws {
    guard bytes.count <= Motion3DLimits.maxJSONBytes - data.count else { throw Motion3DFailure.exceedsLimits }
    data.append(bytes)
    hasher.update(data: bytes)
  }
}

public struct Motion3DProgress: Sendable {
  public let processedFrames: Int
  public let timestampMs: Double
  public let durationMs: Double
}

struct Motion3DProgressThrottle {
  private var lastEmission: UInt64?

  mutating func shouldEmit(at uptimeNanoseconds: UInt64 = DispatchTime.now().uptimeNanoseconds) -> Bool {
    if let lastEmission,
       uptimeNanoseconds < lastEmission || uptimeNanoseconds - lastEmission < 100_000_000 { return false }
    lastEmission = uptimeNanoseconds
    return true
  }
}

@available(iOS 17.0, macOS 14.0, tvOS 17.0, *)
public enum AppleMotion3DReconstructor {
  private static let gate = Motion3DExclusiveGate()

  public static func reconstruct(
    videoURL: URL,
    captureId: String,
    policy: Motion3DPolicy = .rawV1,
    targetSeed: Motion3DTargetSeed? = nil,
    cancellation: Motion3DCancellation,
    progress: (Motion3DProgress) -> Void = { _ in }
  ) throws -> Motion3DReceipt {
    guard !Thread.isMainThread, Motion3DLimits.validIdentifier(captureId),
          targetSeed == nil || policy != .rawV1 else { throw Motion3DFailure.invalidOptions }
    try cancellation.check()
    let job = try gate.acquire()
    defer { gate.release(job) }
    guard Motion3DCapability.available else { throw Motion3DFailure.unavailable }
    if policy == .associatedROIV3 {
      let provider = ApplePose3DROIProvider(targetSeed: targetSeed)
      return try Motion3DVideoReconstruction.run(
        videoURL: videoURL, captureId: captureId, cancellation: cancellation,
        identityPolicy: Motion3DIdentityPolicy(seed: targetSeed, roi: true), inference: { provider.inference }, progress: progress,
        reset: { provider.breakContinuity() },
        estimate: { sampleBuffer, orientation in
          try provider.extract(sampleBuffer: sampleBuffer, orientation: orientation, cancellation: cancellation)
        }
      )
    }
    if policy == .associatedV2 {
      let provider = ApplePose3DAssociatedProvider(targetSeed: targetSeed)
      return try Motion3DVideoReconstruction.run(
        videoURL: videoURL, captureId: captureId, cancellation: cancellation,
        identityPolicy: Motion3DIdentityPolicy(seed: targetSeed), progress: progress,
        reset: { provider.breakContinuity() },
        estimate: { sampleBuffer, orientation in
          try provider.extract(sampleBuffer: sampleBuffer, orientation: orientation, cancellation: cancellation)
        }
      )
    }
    let provider = ApplePose3DProvider()
    return try Motion3DVideoReconstruction.run(
      videoURL: videoURL, captureId: captureId, cancellation: cancellation, progress: progress,
      reset: { provider.reset() },
      estimate: { sampleBuffer, orientation in
        try provider.extract(sampleBuffer: sampleBuffer, orientation: orientation, cancellation: cancellation)
      }
    )
  }
}

enum Motion3DVideoReconstruction {
  static func run(
    videoURL: URL,
    captureId: String,
    cancellation: Motion3DCancellation,
    identityPolicy: Motion3DIdentityPolicy? = nil,
    inference: () -> Motion3DInference? = { nil },
    progress: (Motion3DProgress) -> Void,
    reset: () -> Void,
    estimate: (CMSampleBuffer, CGImagePropertyOrientation) throws -> Motion3DObservationSample
  ) throws -> Motion3DReceipt {
    guard Motion3DLimits.validIdentifier(captureId) else { throw Motion3DFailure.invalidOptions }
    let fingerprint = try Motion3DVideoFingerprint.read(url: videoURL, cancellation: cancellation)
    let asset = AVURLAsset(url: videoURL, options: [
      AVURLAssetPreferPreciseDurationAndTimingKey: true,
      AVURLAssetReferenceRestrictionsKey: AVAssetReferenceRestrictions.forbidAll.rawValue,
    ])
    let assetRegistration = try cancellation.onCancel { asset.cancelLoading() }
    defer { cancellation.removeHandler(assetRegistration) }
    try load(asset, keys: ["tracks", "duration", "playable", "hasProtectedContent"], cancellation: cancellation)
    let tracks = asset.tracks(withMediaType: .video)
    guard tracks.count == 1, asset.isPlayable, !asset.hasProtectedContent else { throw Motion3DFailure.invalidSource }
    let track = tracks[0]
    try load(track, keys: ["naturalSize", "preferredTransform", "nominalFrameRate"], cancellation: cancellation)
    let duration = asset.duration
    let durationMs = Double(duration.value) * 1000 / Double(duration.timescale)
    guard duration.isNumeric, duration.epoch == 0, durationMs.isFinite, durationMs >= 1 else {
      throw Motion3DFailure.invalidSource
    }
    guard durationMs <= Motion3DLimits.maxDurationMs else { throw Motion3DFailure.exceedsLimits }
    if let seed = identityPolicy?.seed, seed.timestampMs > durationMs { throw Motion3DFailure.invalidOptions }
    let frameRate = Double(track.nominalFrameRate)
    guard frameRate.isFinite, (0.1...240).contains(frameRate) else { throw Motion3DFailure.invalidSource }
    let transform = track.preferredTransform
    let orientation = try Motion3DTrackGeometry.orientation(for: transform)
    let dimensions = try Motion3DTrackGeometry.dimensions(naturalSize: track.naturalSize, transform: transform)
    let source = Motion3DSource(
      captureId: captureId, videoSha256: fingerprint.sha256, videoByteLength: fingerprint.snapshot.byteLength,
      width: dimensions.width, height: dimensions.height, durationMs: durationMs, nominalFrameRate: frameRate,
      preferredTransform: [transform.a, transform.b, transform.c, transform.d, transform.tx, transform.ty].map { Double($0) }
    )
    let reader: AVAssetReader
    do { reader = try AVAssetReader(asset: asset) }
    catch { throw Motion3DFailure.decodingFailed }
    let output = AVAssetReaderTrackOutput(track: track, outputSettings: [
      kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarFullRange,
    ])
    output.alwaysCopiesSampleData = false
    guard reader.canAdd(output) else { throw Motion3DFailure.decodingFailed }
    reader.add(output)
    let readerRegistration = try cancellation.onCancel { reader.cancelReading() }
    defer {
      reader.cancelReading()
      cancellation.removeHandler(readerRegistration)
    }
    try cancellation.check()
    guard reader.startReading() else {
      try cancellation.check()
      throw Motion3DFailure.decodingFailed
    }
    var timeline = Motion3DSamplingTimeline()
    var segments = Motion3DSegments()
    var throttle = Motion3DProgressThrottle()
    var builder = try Motion3DJSONBuilder(source: source, identityPolicy: identityPolicy)
    var seedFrameSeen = identityPolicy?.seed == nil
    while true {
      try cancellation.check()
      let decoded: Bool = try autoreleasepool {
        guard let sampleBuffer = output.copyNextSampleBuffer() else { return false }
        try cancellation.check()
        guard CMSampleBufferDataIsReady(sampleBuffer), CMSampleBufferGetNumSamples(sampleBuffer) == 1,
              CMSampleBufferGetImageBuffer(sampleBuffer) != nil else { throw Motion3DFailure.decodingFailed }
        let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        if let stamp = try timeline.consume(pts: pts, durationMs: durationMs) {
          if let seed = identityPolicy?.seed, stamp.timestampMs == seed.timestampMs { seedFrameSeen = true }
          if stamp.resetsContinuity {
            reset()
            segments.breakContinuity()
          }
          let sample = try estimate(sampleBuffer, orientation)
          try cancellation.check()
          guard (identityPolicy == nil) == (sample.association == nil) else { throw Motion3DFailure.decodingFailed }
          if let seed = identityPolicy?.seed, sample.status == .estimated, stamp.timestampMs < seed.timestampMs {
            throw Motion3DFailure.invalidOptions
          }
          let frame = Motion3DFrame(stamp: stamp, segmentId: segments.consume(sample.status), sample: sample)
          try builder.append(frame)
        }
        if throttle.shouldEmit() {
          progress(Motion3DProgress(
            processedFrames: timeline.decodedFrames,
            timestampMs: Double(pts.value) * 1000 / Double(pts.timescale), durationMs: durationMs
          ))
        }
        return true
      }
      if !decoded { break }
    }
    try cancellation.check()
    guard reader.status == .completed else { throw Motion3DFailure.decodingFailed }
    guard try Motion3DFileSnapshot(url: videoURL) == fingerprint.snapshot else { throw Motion3DFailure.invalidSource }
    guard seedFrameSeen else { throw Motion3DFailure.invalidOptions }
    let receipt = try builder.finish(inference: inference())
    try cancellation.check()
    return receipt
  }

  private static func load(
    _ object: AVAsynchronousKeyValueLoading,
    keys: [String],
    cancellation: Motion3DCancellation
  ) throws {
    try cancellation.check()
    let ready = DispatchSemaphore(value: 0)
    object.loadValuesAsynchronously(forKeys: keys) { ready.signal() }
    while ready.wait(timeout: .now() + 0.05) == .timedOut { try cancellation.check() }
    try cancellation.check()
    for key in keys {
      guard object.statusOfValue(forKey: key, error: nil) == .loaded else { throw Motion3DFailure.invalidSource }
    }
  }
}
