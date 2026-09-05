import Foundation

/// Evidence-based framing gate for guided capture. `ready` is emitted only
/// after a real pose has complete, visible joints, usable scale/margins, and a
/// stable center for a sustained period. Missing inference always clears the
/// stability window; there is no timer-only or fixture path to readiness.
///
/// Retune (with temporal-stroke-heuristic-3): the stillness window dropped
/// from 700 ms to 450 ms so the shutter arms sooner — 450 ms of a stable
/// centre still cannot be satisfied mid-walk, which is what the gate exists to
/// prevent — and the centre-travel tolerance widened from 0.045 to 0.055 of
/// the frame so breathing, weight shifts and paddle-tapping no longer restart
/// the window endlessly. Everything else is unchanged.
public final class PoseReadinessEvaluator {
  public enum State: String, Sendable {
    case noPerson = "no_person"
    case fullBodyRequired = "full_body_required"
    case moveCloser = "move_closer"
    case moveFarther = "move_farther"
    case holdStill = "hold_still"
    case ready
  }

  public struct Config: Sendable {
    public var minimumJointVisibility: Double
    public var minimumPoseConfidence: Double
    public var minimumBodyHeight: Double
    public var maximumBodyHeight: Double
    public var maximumBodyWidth: Double
    public var frameMargin: Double
    /// How long the framed body must hold a stable centre and scale before
    /// `ready`. 450 ms (was 700): arms sooner while still rejecting a walking
    /// athlete, whose centre cannot stay within `maximumCenterTravel` that long.
    public var stableDurationMs: Int
    /// Largest centre displacement (normalized-image units, any pair of
    /// samples in the window) that still counts as still. 0.055 (was 0.045):
    /// natural sway and paddle-tapping fit; a step does not.
    public var maximumCenterTravel: Double
    public var maximumScaleChange: Double
    /// Longest silence between two framed poses that still counts as one
    /// continuous observation. A wider gap (the app was suspended, inference
    /// stalled, the clock jumped) restarts the window: stillness is proven by
    /// watching the athlete, not by two frames that happen to agree. Defaults
    /// to the window itself, so a pair of frames can never span more than one
    /// window's worth of unobserved time.
    public var maximumSampleGapMs: Int

    public init(
      minimumJointVisibility: Double = 0.35,
      minimumPoseConfidence: Double = 0.50,
      minimumBodyHeight: Double = 0.32,
      maximumBodyHeight: Double = 0.88,
      maximumBodyWidth: Double = 0.80,
      frameMargin: Double = 0.025,
      stableDurationMs: Int = 450,
      maximumCenterTravel: Double = 0.055,
      maximumScaleChange: Double = 0.08,
      maximumSampleGapMs: Int = 450
    ) {
      self.minimumJointVisibility = minimumJointVisibility
      self.minimumPoseConfidence = minimumPoseConfidence
      self.minimumBodyHeight = minimumBodyHeight
      self.maximumBodyHeight = maximumBodyHeight
      self.maximumBodyWidth = maximumBodyWidth
      self.frameMargin = frameMargin
      self.stableDurationMs = stableDurationMs
      self.maximumCenterTravel = maximumCenterTravel
      self.maximumScaleChange = maximumScaleChange
      self.maximumSampleGapMs = max(1, maximumSampleGapMs)
    }
  }

  public struct Snapshot: Sendable {
    public let state: State
    public let timestampMs: Int
    public let poseConfidence: Double
    public let jointCoverage: Double
    public let stableForMs: Int
    public let missingJoints: [String]
    public let landmarks: [PoseLandmark]

    public var isReady: Bool { state == .ready }
  }

  private struct StableSample {
    let timestampMs: Int
    let centerX: Double
    let centerY: Double
    let height: Double
  }

  private static let requiredJoints = [
    "left_shoulder", "right_shoulder",
    "left_elbow", "right_elbow",
    "left_wrist", "right_wrist",
    "left_hip", "right_hip",
    "left_knee", "right_knee",
    "left_ankle", "right_ankle",
  ]

  /// Torso and legs: the joints framing requires on every frame. Stillness is
  /// measured on their box, so an extended arm whose wrist flickers in and out
  /// of visibility (or taps a paddle) cannot restart the window.
  private static let coreJoints = [
    "left_shoulder", "right_shoulder", "left_hip", "right_hip",
    "left_knee", "right_knee", "left_ankle", "right_ankle",
  ]

  /// Hard ceiling on retained samples so a pathological cadence (hundreds of
  /// frames per window) keeps the pairwise scan bounded; the anchor and the
  /// newest sample are always kept.
  private static let maximumRetainedSamples = 256

  private let config: Config
  private var stableSamples: [StableSample] = []

  public init(config: Config = Config()) {
    self.config = config
  }

  public func ingestMissing(timestampMs: Int) -> Snapshot {
    stableSamples.removeAll(keepingCapacity: true)
    return Snapshot(
      state: .noPerson,
      timestampMs: timestampMs,
      poseConfidence: 0,
      jointCoverage: 0,
      stableForMs: 0,
      missingJoints: Self.requiredJoints,
      landmarks: []
    )
  }

  public func ingest(pose: PoseFrame) -> Snapshot {
    guard pose.confidence >= config.minimumPoseConfidence else {
      return ingestMissing(timestampMs: pose.timestampMs)
    }

    // `PoseFrame` already keeps one sample per joint; never trap on a duplicate
    // key regardless.
    let visible = Dictionary(
      pose.landmarks
        .filter { $0.visibility >= config.minimumJointVisibility }
        .map { ($0.name, $0) },
      uniquingKeysWith: { $1.visibility > $0.visibility ? $1 : $0 }
    )
    let missing = Self.requiredJoints.filter { visible[$0] == nil }
    let coverage = Double(Self.requiredJoints.count - missing.count) / Double(Self.requiredJoints.count)

    // One missing arm point can occur briefly during a valid swing, but a
    // complete lower body and both shoulders are mandatory for framing.
    let core = Self.coreJoints.compactMap { visible[$0] }
    guard coverage >= 0.83, core.count == Self.coreJoints.count else {
      stableSamples.removeAll(keepingCapacity: true)
      return snapshot(
        state: .fullBodyRequired,
        pose: pose,
        coverage: coverage,
        stableForMs: 0,
        missing: missing
      )
    }

    let points = Self.requiredJoints.compactMap { visible[$0] }
    guard
      let minX = points.map(\.x).min(), let maxX = points.map(\.x).max(),
      let minY = points.map(\.y).min(), let maxY = points.map(\.y).max()
    else {
      return ingestMissing(timestampMs: pose.timestampMs)
    }
    let width = maxX - minX
    let height = maxY - minY

    guard minX > config.frameMargin, maxX < 1 - config.frameMargin,
          minY > config.frameMargin, maxY < 1 - config.frameMargin else {
      stableSamples.removeAll(keepingCapacity: true)
      return snapshot(state: .fullBodyRequired, pose: pose, coverage: coverage, stableForMs: 0, missing: missing)
    }
    guard height >= config.minimumBodyHeight else {
      stableSamples.removeAll(keepingCapacity: true)
      return snapshot(state: .moveCloser, pose: pose, coverage: coverage, stableForMs: 0, missing: missing)
    }
    guard height <= config.maximumBodyHeight, width <= config.maximumBodyWidth else {
      stableSamples.removeAll(keepingCapacity: true)
      return snapshot(state: .moveFarther, pose: pose, coverage: coverage, stableForMs: 0, missing: missing)
    }

    let coreXs = core.map(\.x)
    let coreYs = core.map(\.y)
    let sample = StableSample(
      timestampMs: pose.timestampMs,
      centerX: (coreXs.min()! + coreXs.max()!) / 2,
      centerY: (coreYs.min()! + coreYs.max()!) / 2,
      height: coreYs.max()! - coreYs.min()!
    )
    if let last = stableSamples.last {
      if last.timestampMs == pose.timestampMs {
        // A stalled clock re-observes the same instant: replace, never grow.
        stableSamples.removeLast()
      } else if let gap = Self.elapsedMs(from: last.timestampMs, to: pose.timestampMs),
                gap <= config.maximumSampleGapMs {
        // Continuous observation: keep the window.
      } else {
        // Clock went backwards, or nothing was observed for too long.
        stableSamples.removeAll(keepingCapacity: true)
      }
    }
    stableSamples.append(sample)
    // The newest sample at or before the cutoff anchors the window, so its
    // measured span is at least `stableDurationMs` regardless of frame cadence
    // or dropped frames.
    let (cutoff, cutoffOverflowed) = pose.timestampMs.subtractingReportingOverflow(config.stableDurationMs)
    if !cutoffOverflowed, let anchor = stableSamples.lastIndex(where: { $0.timestampMs <= cutoff }) {
      stableSamples.removeFirst(anchor)
    }
    while stableSamples.count > Self.maximumRetainedSamples {
      stableSamples.remove(at: 1)
    }

    let stableForMs = stableSamples.first.flatMap { Self.elapsedMs(from: $0.timestampMs, to: pose.timestampMs) } ?? 0
    let centerTravel = maximumPairwiseTravel(in: stableSamples)
    let heights = stableSamples.map(\.height)
    let scaleChange = (heights.max() ?? sample.height) - (heights.min() ?? sample.height)
    let isStable = stableForMs >= config.stableDurationMs
      && centerTravel <= config.maximumCenterTravel
      && scaleChange <= config.maximumScaleChange

    if !isStable, centerTravel > config.maximumCenterTravel || scaleChange > config.maximumScaleChange {
      // Restart the stability window from the current real observation rather
      // than allowing older motion to hold the athlete in a permanent loop.
      stableSamples = [sample]
    }

    return snapshot(
      state: isStable ? .ready : .holdStill,
      pose: pose,
      coverage: coverage,
      stableForMs: isStable ? stableForMs : 0,
      missing: missing
    )
  }

  public func reset() {
    stableSamples.removeAll(keepingCapacity: true)
  }

  private func snapshot(
    state: State,
    pose: PoseFrame,
    coverage: Double,
    stableForMs: Int,
    missing: [String]
  ) -> Snapshot {
    Snapshot(
      state: state,
      timestampMs: pose.timestampMs,
      poseConfidence: pose.confidence,
      jointCoverage: coverage,
      stableForMs: stableForMs,
      missingJoints: missing,
      landmarks: pose.landmarks
    )
  }

  /// `to - from` when it is representable and non-negative; nil otherwise.
  private static func elapsedMs(from: Int, to: Int) -> Int? {
    let (elapsed, overflow) = to.subtractingReportingOverflow(from)
    return overflow || elapsed < 0 ? nil : elapsed
  }

  private func maximumPairwiseTravel(in samples: [StableSample]) -> Double {
    guard samples.count > 1 else { return 0 }
    var maximum = 0.0
    for first in samples {
      for second in samples {
        let dx = first.centerX - second.centerX
        let dy = first.centerY - second.centerY
        maximum = max(maximum, (dx * dx + dy * dy).squareRoot())
      }
    }
    return maximum
  }
}
