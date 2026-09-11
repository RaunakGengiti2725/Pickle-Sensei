import Foundation

/// Temporal stroke detector (spec p. 28): velocity-feature state machine over
/// wrist/paddle motion with minimum-confidence trigger and a refractory period
/// so paddle twirls and ball pickup never register as strokes. This is the
/// heuristic v0 the learned temporal classifier will replace behind the same
/// StrokeDetecting protocol.
///
/// UNITS (since heuristic-3): every speed in this detector is in BODY-HEIGHTS
/// PER SECOND — displacement in normalized-image units per second divided by
/// the observed body scale (see `updateBodyScale(with:)`), so the thresholds
/// describe the athlete's motion rather than the camera placement.
///
/// HEURISTIC-4 — motion is measured RELATIVE TO THE BODY and a stroke has to
/// start from a still wrist. Two field failures drove it:
///
/// 1. WALKING false-triggered. Heuristic-3 measured absolute image motion, so
///    a walking athlete's wrist (body translation ≈ 0.8 bh/s + arm swing
///    ≈ 0.5 bh/s) crossed the 1.15 trigger and then "settled" at the arm-swing
///    reversal. Now the hip-midpoint displacement over the same interval is
///    subtracted from the wrist/paddle displacement before dividing by dt and
///    body scale, so walking contributes only the arm swing (≈ 0.4–0.6) and a
///    camera bump (the whole frame moves) reads ≈ 0. A frame without a
///    visible hip yields NO sample — never an absolute-speed fallback.
/// 2. Continuous fidgeting / walking never rests. A real swing starts from a
///    relatively still wrist (ready position; backswing then forward swing).
///    A candidate may only open if a QUIET RUN — consecutive samples at or
///    below `quietWristSpeed` lasting ≥ `minQuietBeforeMs` — ended within the
///    last `maxOnsetToTriggerMs`. The last quiet sample is the MOTION ONSET
///    and becomes the event's `startMs`. Walking arm swing dips under the
///    quiet speed only ~150–250 ms around each reversal, so it never qualifies.
///
/// EVENT WINDOW. `startMs` = the onset (last quiet sample before the motion),
/// `endMs` = the sample at which the relative speed has stayed ≤
/// `endWristSpeed` continuously for `settledWindowMs` (a settled TAIL), so the
/// window carries the still start, the backswing, the swing and its tail: the
/// downstream phase segmenter, which rejects windows whose speed peak is under
/// 2× the window's median ("no distinct stroke peak"), sees a clear peak.
/// `minStrokeMs` / `maxStrokeMs` are measured from the TRIGGER crossing, and
/// the swinging wrist must cover ≥ `minWristPathBodyHeights` between the
/// trigger and the close or the candidate is dropped silently (short flicks,
/// grip adjustments).
///
/// HEURISTIC-6 — a swing is never lost for lacking a textbook ready position
/// (2026-09-10 field failure: a full practice swing went undetected):
///
/// 1. STRONG MOTION opens a candidate without a qualified quiet onset. A
///    hip-relative wrist speed ≥ `strongTriggerWristSpeed` (2.5 bh/s ≈ a
///    4.4 m/s wrist) is a swing whatever preceded it — walking arm swing reads
///    0.4–0.6, fidgeting under 1 — so the athlete who steps in and swings at
///    once is captured. Its `startMs` is the most recent quiet sample of that
///    wrist inside `maxOnsetToTriggerMs` (any run length), else the trigger
///    interval's start; the analysis reads the capture's own pre-roll for the
///    ready position. Motion between the trigger and the strong threshold
///    still needs the quiet onset (heuristic-4 rules, unchanged).
/// 2. A STRONG candidate that never settles inside `maxStrokeMs` (the athlete
///    walks toward the phone after the swing) COMPLETES at the timeout with
///    `endMs` = the current frame, provided its path gate passed; a weak one
///    is still dropped as sustained motion.
public final class TemporalStrokeDetector: StrokeDetecting {
  public let modelVersion = "temporal-stroke-heuristic-6"

  public enum Handedness: String, Sendable { case left, right }

  private enum State { case idle, candidate }

  /// Tunables. Every speed is in BODY-HEIGHTS PER SECOND, relative to the hip
  /// midpoint (heuristic-4); heuristic-3 used absolute image motion in the
  /// same units and heuristic-2 normalized-image units per second.
  public struct Config {
    /// Relative wrist/paddle speed that opens a stroke candidate,
    /// body-heights/second. 1.15 ≈ a 2 m/s wrist for a 1.75 m player — catches
    /// dinks, resets and drops as well as every drive and serve, while staying
    /// above walking arm-swing (≈ 0.4–0.6 once the body's own translation is
    /// removed) and paddle fidgeting.
    public var triggerWristSpeed: Double
    /// Relative speed at or below which the wrist counts as settled,
    /// body-heights/second. 0.5 lets the event close even when the player
    /// walks off right after the swing: walking arm swing spends ≥ 160 ms
    /// runs below 0.5 around every reversal.
    public var endWristSpeed: Double
    /// Shortest candidate window (trigger crossing → close) that completes as
    /// a stroke.
    public var minStrokeMs: Int
    /// Longest candidate window (from the trigger crossing); past this the
    /// motion is sustained (rally scramble, walking) and the candidate is
    /// dropped, not emitted.
    public var maxStrokeMs: Int
    /// Quiet period after a completed stroke during which nothing re-triggers.
    public var refractoryMs: Int
    /// Pose frames below this confidence are ignored entirely.
    public var minPoseConfidence: Double
    /// Relative speed at or below which a sample counts as QUIET (the ready
    /// position), body-heights/second. Walking arm swing (≈ 0.5–0.6 at its
    /// steady stretches) sits above it.
    public var quietWristSpeed: Double
    /// A quiet run must last at least this long before its end can serve as a
    /// stroke's motion onset. Walking arm swing only dips under the quiet
    /// speed for ~150–250 ms around each reversal, so it never qualifies.
    public var minQuietBeforeMs: Int
    /// The trigger crossing must come within this long after the quiet run
    /// ended (the onset). Longer means sustained non-still motion before the
    /// fast sample — fidgeting or walking, not a swing from the ready position.
    public var maxOnsetToTriggerMs: Int
    /// Minimum path the swinging wrist must cover between the trigger crossing
    /// and the close, in body-heights relative to the hips. A dink covers
    /// ≈ 0.4–0.6, a drive ≈ 0.7–1.0; a grip adjustment or a flick ≈ 0.1.
    public var minWristPathBodyHeights: Double
    public var handedness: Handedness?
    /// Relative wrist speed at or above which a sample opens a candidate
    /// WITHOUT a qualified quiet onset, body-heights/second (heuristic-6).
    /// 2.5 ≈ a 4.4 m/s wrist: drives, serves and overheads reach it, walking
    /// arm swing (0.4–0.6) and fidgeting (< 1) never do. A candidate that
    /// peaked here also completes at `maxStrokeMs` instead of being dropped.
    public var strongTriggerWristSpeed: Double

    public init(
      triggerWristSpeed: Double = 1.15,
      endWristSpeed: Double = 0.5,
      minStrokeMs: Int = 250,
      maxStrokeMs: Int = 2200,
      refractoryMs: Int = 700,
      minPoseConfidence: Double = 0.5,
      quietWristSpeed: Double = 0.45,
      minQuietBeforeMs: Int = 350,
      maxOnsetToTriggerMs: Int = 1200,
      minWristPathBodyHeights: Double = 0.3,
      handedness: Handedness? = nil,
      strongTriggerWristSpeed: Double = 2.5
    ) {
      self.triggerWristSpeed = triggerWristSpeed
      self.endWristSpeed = endWristSpeed
      self.minStrokeMs = minStrokeMs
      self.maxStrokeMs = maxStrokeMs
      self.refractoryMs = refractoryMs
      self.minPoseConfidence = minPoseConfidence
      self.quietWristSpeed = quietWristSpeed
      self.minQuietBeforeMs = minQuietBeforeMs
      self.maxOnsetToTriggerMs = maxOnsetToTriggerMs
      self.minWristPathBodyHeights = minWristPathBodyHeights
      self.handedness = handedness
      self.strongTriggerWristSpeed = strongTriggerWristSpeed
    }
  }

  /// Landmarks below this visibility do not contribute to speed, anchor or
  /// scale.
  public static let minimumLandmarkVisibility = 0.35
  /// Consecutive samples of one point further apart than this yield no speed
  /// (a dropped pose stream must never manufacture a giant velocity).
  public static let maximumSampleGapMs = 250
  /// A candidate closes once the relative speed has stayed at or below
  /// `endWristSpeed` continuously for this long after `minStrokeMs`; the
  /// sample completing the run is the event's `endMs`, so every emitted window
  /// ends with this much settled tail.
  public static let settledWindowMs = 160
  /// EMA weight applied to each new body-scale measurement, so a single noisy
  /// frame moves the scale by at most 30% of the error and cannot spike speed.
  public static let bodyScaleSmoothing = 0.3
  /// Shoulder-mid → hip-mid vertical span × this ≈ shoulder-mid → ankle-mid
  /// span; used only while the ankles are not visible.
  public static let hipSpanToBodyScale = 2.2
  /// Body scale assumed until the first measurement. 0.5 keeps behaviour in
  /// the neighbourhood of the heuristic-2 image-unit thresholds instead of
  /// dividing by zero or refusing to detect.
  public static let fallbackBodyScale = 0.5
  /// A strong crossing needs the previous sample this far (body-heights/s)
  /// under `strongTriggerWristSpeed`: 0.05 bh/s ≈ 9 cm/s for a 1.75 m
  /// player, well inside any real acceleration and far above float noise.
  public static let strongCrossingMargin = 0.05
  /// Spans smaller than this (normalized-image units) are not a standing body
  /// (lying down, a collapsed detection) and are ignored for scale.
  private static let minimumMeasurableBodyScale = 0.05
  private static let maximumStillnessGapMs = 125
  private static let minimumStillnessIntervals = 2
  private static let cadenceWindowIntervals = 8
  private static let limitedCadenceIntervals = 3
  private static let cadenceRecoveryMs = 750

  /// The visible hips of one frame: the body anchor wrist motion is measured
  /// against.
  private struct HipAnchor {
    var left: (x: Double, y: Double)?
    var right: (x: Double, y: Double)?

    /// Hip-midpoint displacement from `previous` to this frame, using only the
    /// hips visible in BOTH frames: with both it is exactly the midpoint's
    /// displacement; with one it is that hip's, which keeps a hip flickering
    /// across the visibility threshold from reading as a half-hip-width jump.
    /// nil when the two frames share no hip.
    func displacement(since previous: HipAnchor) -> (x: Double, y: Double)? {
      var dx = 0.0, dy = 0.0, shared = 0
      if let now = left, let then = previous.left {
        dx += now.x - then.x; dy += now.y - then.y; shared += 1
      }
      if let now = right, let then = previous.right {
        dx += now.x - then.x; dy += now.y - then.y; shared += 1
      }
      guard shared > 0 else { return nil }
      return (dx / Double(shared), dy / Double(shared))
    }
  }

  /// A wrist/paddle point as last observed, together with the body anchor of
  /// the same frame so the next observation can be measured relative to it.
  private struct Observation {
    let x: Double
    let y: Double
    let tMs: Int
    let hips: HipAnchor
  }

  /// One point's body-relative motion over the interval since its previous
  /// observation.
  private struct Sample {
    let key: String
    /// Body-heights per second.
    let speed: Double
    /// Body-heights covered over the interval.
    let distance: Double
    /// Start of the interval that produced this sample.
    let previousTimestampMs: Int
    let isContinuous: Bool
  }

  private let config: Config
  private var state: State = .idle
  private var lastPoints: [String: Observation] = [:]
  private var lastFrameTimestampMs: Int?
  private var recentCadenceSupport: [Bool] = []
  private var supportedCadenceSinceMs: Int?
  private var candidateKeys: Set<String> = []
  private var settlingKey: String?
  private var settledRunEndMs: Int?
  private var settledRunIntervals = 0
  /// Emitted `startMs`: the motion onset (last quiet sample) the candidate
  /// grew out of.
  private var strokeStartMs = 0
  /// Start of the interval whose speed crossed the trigger; `minStrokeMs`,
  /// `maxStrokeMs` and the wrist path are measured from here.
  private var triggerMs = 0
  private var peakSpeedMs = 0
  private var peakSpeed = 0.0
  private var refractoryUntilMs = 0
  /// Timestamp of the sample that began the current run of settled
  /// (≤ `endWristSpeed`) samples inside a candidate; nil while moving.
  private var settledSinceMs: Int?
  /// Body-relative path each tracked point has covered since the trigger
  /// crossing, body-heights; the path gate reads the longest.
  private var wristPaths: [String: Double] = [:]
  /// Start of the current run of quiet (≤ `quietWristSpeed`) samples — the
  /// interval start of its first sample — and the timestamp of its latest
  /// sample. nil while moving or when no evidence of stillness exists.
  private var quietRunSinceMs: [String: Int] = [:]
  private var quietRunEndMs: [String: Int] = [:]
  private var quietRunIntervals: [String: Int] = [:]
  /// Last sample of the most recent quiet run that lasted ≥ `minQuietBeforeMs`
  /// — the motion onset a trigger may grow out of. Consumed by a trigger and
  /// cleared when a candidate ends, so every stroke needs a fresh quiet run.
  private var onsetMs: [String: Int] = [:]
  /// Most recent sample of each point at or below `quietWristSpeed`, whatever
  /// its run length or continuity: the best available start for a STRONG
  /// candidate that has no qualified onset (heuristic-6).
  private var lastQuietSampleMs: [String: Int] = [:]
  /// Speed of each point's most recent sample, so a strong sample can be told
  /// apart as a CROSSING of the strong threshold rather than sustained speed.
  private var lastSpeed: [String: Double] = [:]

  /// Body scale (normalized-image units) that the most recent speeds were
  /// normalized by: the EMA-smoothed vertical span from the shoulder midpoint
  /// to the ankle midpoint. nil until a scale has been measured (speeds then
  /// use `fallbackBodyScale`) and after `reset()`. Diagnostics only — read it
  /// on the queue that calls `ingest`.
  public private(set) var lastBodyScale: Double?
  public private(set) var isTrackingLimited: Bool = false

  public init(config: Config = Config()) {
    self.config = config
  }

  public func ingest(pose: PoseFrame, paddle: PaddleFrame?) -> StrokeEvent? {
    if let previous = lastFrameTimestampMs, pose.timestampMs <= previous { return nil }
    let previousFrameMs = lastFrameTimestampMs
    lastFrameTimestampMs = pose.timestampMs
    if let previousFrameMs { trackCadence(from: previousFrameMs, to: pose.timestampMs) }
    guard pose.confidence >= config.minPoseConfidence else { return nil }
    // Scale is scene information: refresh it from every trusted pose frame,
    // even one whose wrists or hips are hidden, so a later sample divides by
    // the freshest estimate.
    let bodyScale = updateBodyScale(with: pose)

    // Prefer a validated paddle center when available. Until then, evaluate
    // each wrist against its own prior location and use the faster wrist. This
    // avoids assuming handedness and avoids false speed spikes when the chosen
    // point switches sides.
    let points: [(key: String, x: Double, y: Double)]
    if let center = paddle?.center, (paddle?.confidence ?? 0) > 0.5 {
      points = [("paddle", Double(center.x), Double(center.y))]
    } else {
      let selectedWrist = config.handedness.map { "\($0.rawValue)_wrist" }
      points = pose.landmarks
        .filter {
          ($0.name == "right_wrist" || $0.name == "left_wrist")
            && (selectedWrist == nil || $0.name == selectedWrist)
            && $0.visibility >= Self.minimumLandmarkVisibility
        }
        .map { ($0.name, $0.x, $0.y) }
    }
    guard !points.isEmpty else { return nil }
    // Without a visible hip the points cannot be placed relative to the body:
    // this frame observes nothing (the next anchored frame measures against
    // the last anchored one, subject to the gap rule). Absolute image motion
    // is never a fallback — it is exactly what walking looked like.
    guard let hips = Self.hipAnchor(pose) else { return nil }

    var samples: [Sample] = []
    for point in points {
      if let previous = lastPoints[point.key], pose.timestampMs > previous.tMs {
        let elapsedMs = pose.timestampMs - previous.tMs
        if elapsedMs <= Self.maximumSampleGapMs,
           let shift = hips.displacement(since: previous.hips) {
          let dt = Double(elapsedMs) / 1000.0
          // Body-relative displacement: the wrist's image motion minus the
          // hips' over the same interval, in body-heights.
          let dx = point.x - previous.x - shift.x
          let dy = point.y - previous.y - shift.y
          let distance = (dx * dx + dy * dy).squareRoot() / bodyScale
          samples.append(Sample(
            key: point.key,
            speed: distance / dt,
            distance: distance,
            previousTimestampMs: previous.tMs,
            isContinuous: previous.tMs == previousFrameMs && elapsedMs <= Self.maximumStillnessGapMs
          ))
        }
      }
      lastPoints[point.key] = Observation(x: point.x, y: point.y, tMs: pose.timestampMs, hips: hips)
    }
    guard let fastest = samples.max(by: { $0.speed < $1.speed }) else { return nil }
    let speed = fastest.speed

    for sample in samples { trackQuietRun(sample, at: pose.timestampMs) }
    // A sample opens (or joins) a candidate through the quiet onset, or —
    // heuristic-6 — through STRONG motion alone, when that wrist's speed
    // CROSSES the strong threshold from an observed slower sample: a swing
    // accelerates into it; a hand already waving at that speed (its previous
    // sample was as fast, or was never observed) is sustained motion.
    let previousSpeeds = lastSpeed
    for sample in samples { lastSpeed[sample.key] = sample.speed }
    let triggering = samples.filter { sample in
      // The previous sample must sit measurably under the threshold: a hand
      // holding exactly the threshold speed (float noise either side of it)
      // is not accelerating into a swing.
      if sample.speed >= config.strongTriggerWristSpeed,
         let previous = previousSpeeds[sample.key],
         previous < config.strongTriggerWristSpeed - Self.strongCrossingMargin {
        return true
      }
      guard sample.speed >= config.triggerWristSpeed, let onset = onsetMs[sample.key] else { return false }
      return pose.timestampMs - onset <= config.maxOnsetToTriggerMs
    }
    /// The window start a triggering sample supplies: its qualified onset,
    /// else (strong motion) its latest quiet sample inside the onset horizon,
    /// else the interval that crossed the trigger.
    func startMs(for sample: Sample) -> Int {
      if let onset = onsetMs[sample.key], pose.timestampMs - onset <= config.maxOnsetToTriggerMs {
        return onset
      }
      if let quiet = lastQuietSampleMs[sample.key], pose.timestampMs - quiet <= config.maxOnsetToTriggerMs {
        return quiet
      }
      return sample.previousTimestampMs
    }

    switch state {
    case .idle:
      // Stillness is tracked through the refractory period too, so the next
      // stroke's quiet run can build while re-triggering is still blocked.
      guard pose.timestampMs >= refractoryUntilMs, speed >= config.triggerWristSpeed else { return nil }
      guard let fastest = triggering.max(by: { $0.speed < $1.speed }) else {
        // Fast without a recent still start and not strong enough to be a
        // swing on its own: walking, fidgeting, a scramble.
        return nil
      }
      state = .candidate
      strokeStartMs = triggering.map(startMs(for:)).min() ?? startMs(for: fastest)
      triggerMs = fastest.previousTimestampMs
      peakSpeed = fastest.speed
      peakSpeedMs = pose.timestampMs
      clearSettledRun()
      candidateKeys = Set(triggering.map(\.key))
      settlingKey = fastest.key
      wristPaths = Dictionary(uniqueKeysWithValues: samples.map { ($0.key, $0.distance) })
      // The onset is consumed: whatever follows this candidate needs a new
      // quiet run of its own.
      for key in candidateKeys { clearQuietRun(for: key) }
      return nil

    case .candidate:
      for sample in triggering where !candidateKeys.contains(sample.key) {
        candidateKeys.insert(sample.key)
        strokeStartMs = min(strokeStartMs, startMs(for: sample))
        clearQuietRun(for: sample.key)
      }
      if let motion = samples.filter({ candidateKeys.contains($0.key) }).max(by: { $0.speed < $1.speed }),
         motion.speed > peakSpeed {
        peakSpeed = motion.speed
        peakSpeedMs = pose.timestampMs
      }
      // Every tracked point accumulates its own path; the gate reads the
      // longest one. The wrist that crossed the trigger is not necessarily
      // the swinging hand — a serve's ball toss can open the candidate with
      // the off hand a beat before the paddle hand travels.
      for sample in samples {
        wristPaths[sample.key, default: 0] += sample.distance
      }
      let elapsed = pose.timestampMs - triggerMs
      if elapsed > config.maxStrokeMs {
        // A STRONG swing that never settled (the athlete walked off toward
        // the phone) is still a swing: it completes here, ending on the
        // current frame. Anything weaker that ran this long is sustained
        // motion (rally scramble, walking) — not a discrete stroke.
        if peakSpeed >= config.strongTriggerWristSpeed,
           (wristPaths.values.max() ?? 0) >= config.minWristPathBodyHeights {
          return complete(endMs: pose.timestampMs)
        }
        drop()
        return nil
      }
      for key in candidateKeys {
        if (wristPaths[key] ?? 0) > (wristPaths[settlingKey ?? ""] ?? 0) {
          settlingKey = key
          clearSettledRun()
        }
      }
      guard let key = settlingKey else { return nil }
      guard let sample = samples.first(where: { $0.key == key }),
            sample.isContinuous, sample.speed <= config.endWristSpeed else {
        // Still moving: any settled run so far was a pause, not the end.
        clearSettledRun()
        return nil
      }
      if let end = settledRunEndMs, sample.previousTimestampMs != end { clearSettledRun() }
      // The settled run began with the interval that produced this sample.
      let settledSince = settledSinceMs ?? sample.previousTimestampMs
      settledSinceMs = settledSince
      settledRunEndMs = pose.timestampMs
      settledRunIntervals = min(Self.minimumStillnessIntervals, settledRunIntervals + 1)
      guard elapsed >= config.minStrokeMs,
            settledRunIntervals >= Self.minimumStillnessIntervals,
            pose.timestampMs - settledSince >= Self.settledWindowMs else { return nil }
      guard (wristPaths[key] ?? 0) >= config.minWristPathBodyHeights else {
        // Fast but tiny: a flick or a grip adjustment, not a swing.
        drop()
        return nil
      }
      return complete(endMs: pose.timestampMs)
    }
  }

  public func reset() {
    state = .idle
    lastPoints.removeAll(keepingCapacity: true)
    lastSpeed.removeAll(keepingCapacity: true)
    lastFrameTimestampMs = nil
    recentCadenceSupport.removeAll(keepingCapacity: true)
    supportedCadenceSinceMs = nil
    isTrackingLimited = false
    refractoryUntilMs = 0
    clearSettledRun()
    candidateKeys.removeAll(keepingCapacity: true)
    settlingKey = nil
    wristPaths.removeAll(keepingCapacity: true)
    clearQuietRun()
    // Scale is re-seeded from the next trusted frame rather than blended with
    // wherever the athlete stood before the reset.
    lastBodyScale = nil
  }

  private func complete(endMs: Int) -> StrokeEvent {
    state = .idle
    clearSettledRun()
    candidateKeys.removeAll(keepingCapacity: true)
    settlingKey = nil
    clearQuietRun()
    refractoryUntilMs = endMs + config.refractoryMs
    return StrokeEvent(
      startMs: strokeStartMs,
      endMs: endMs,
      peakMotionMs: peakSpeedMs,
      confidence: min(0.95, 0.5 + peakSpeed / (config.triggerWristSpeed * 4))
    )
  }

  /// Abandons the candidate silently: no event, no refractory, but the next
  /// trigger needs a fresh quiet run.
  private func drop() {
    state = .idle
    clearSettledRun()
    for key in candidateKeys { onsetMs[key] = nil }
    candidateKeys.removeAll(keepingCapacity: true)
    settlingKey = nil
  }

  private func clearSettledRun() {
    settledSinceMs = nil
    settledRunEndMs = nil
    settledRunIntervals = 0
  }

  private func trackCadence(from previousMs: Int, to timestampMs: Int) {
    let supported = timestampMs - previousMs <= Self.maximumStillnessGapMs
    if recentCadenceSupport.count == Self.cadenceWindowIntervals { recentCadenceSupport.removeFirst() }
    recentCadenceSupport.append(supported)
    if supported {
      if supportedCadenceSinceMs == nil { supportedCadenceSinceMs = previousMs }
    } else {
      supportedCadenceSinceMs = nil
    }
    if recentCadenceSupport.filter({ !$0 }).count >= Self.limitedCadenceIntervals {
      isTrackingLimited = true
    } else if let since = supportedCadenceSinceMs,
              timestampMs - since >= Self.cadenceRecoveryMs,
              recentCadenceSupport.count == Self.cadenceWindowIntervals,
              recentCadenceSupport.allSatisfy({ $0 }) {
      isTrackingLimited = false
    }
  }

  // MARK: - Quiet onset

  /// Folds one idle-state sample into the quiet-run tracker.
  private func trackQuietRun(_ sample: Sample, at timestampMs: Int) {
    // Continuity: the interval behind this sample must touch the run. An
    // uncovered stretch (occlusion, dropped frames, a low-confidence pose) is
    // no evidence of stillness, so the run ends where the evidence did.
    let key = sample.key
    if sample.speed <= config.quietWristSpeed { lastQuietSampleMs[key] = timestampMs }
    if let end = quietRunEndMs[key], sample.previousTimestampMs != end {
      endQuietRun(for: key)
    }
    guard sample.isContinuous else {
      endQuietRun(for: key)
      return
    }
    if sample.speed <= config.quietWristSpeed {
      if quietRunSinceMs[key] == nil { quietRunSinceMs[key] = sample.previousTimestampMs }
      quietRunEndMs[key] = timestampMs
      quietRunIntervals[key] = min(Self.minimumStillnessIntervals, (quietRunIntervals[key] ?? 0) + 1)
    } else {
      endQuietRun(for: key)
    }
  }

  /// Ends the current quiet run; one that lasted long enough leaves its last
  /// sample as the motion onset (a shorter one leaves the previous onset in
  /// place — a brief paddle-set pause between backswing and swing does not
  /// erase the ready position it grew out of).
  private func endQuietRun(for key: String) {
    if let since = quietRunSinceMs[key], let end = quietRunEndMs[key],
       (quietRunIntervals[key] ?? 0) >= Self.minimumStillnessIntervals,
       end - since >= config.minQuietBeforeMs {
      onsetMs[key] = end
    }
    quietRunSinceMs[key] = nil
    quietRunEndMs[key] = nil
    quietRunIntervals[key] = nil
  }

  private func clearQuietRun(for key: String) {
    quietRunSinceMs[key] = nil
    quietRunEndMs[key] = nil
    quietRunIntervals[key] = nil
    onsetMs[key] = nil
  }

  private func clearQuietRun() {
    quietRunSinceMs.removeAll(keepingCapacity: true)
    quietRunEndMs.removeAll(keepingCapacity: true)
    quietRunIntervals.removeAll(keepingCapacity: true)
    onsetMs.removeAll(keepingCapacity: true)
    lastQuietSampleMs.removeAll(keepingCapacity: true)
  }

  /// The hips visible on this frame (visibility ≥ 0.35); nil when neither is.
  private static func hipAnchor(_ pose: PoseFrame) -> HipAnchor? {
    var anchor = HipAnchor()
    for landmark in pose.landmarks where landmark.visibility >= minimumLandmarkVisibility {
      if landmark.name == "left_hip" {
        anchor.left = (landmark.x, landmark.y)
      } else if landmark.name == "right_hip" {
        anchor.right = (landmark.x, landmark.y)
      }
    }
    return anchor.left == nil && anchor.right == nil ? nil : anchor
  }

  // MARK: - Body scale

  /// Folds this frame's body-scale measurement (if any) into the EMA and
  /// returns the scale to normalize this frame's speeds by.
  private func updateBodyScale(with pose: PoseFrame) -> Double {
    if let measured = Self.measureBodyScale(pose) {
      if let smoothed = lastBodyScale {
        lastBodyScale = smoothed + Self.bodyScaleSmoothing * (measured - smoothed)
      } else {
        lastBodyScale = measured // first measurement seeds the EMA directly
      }
    }
    // Neither ankles nor hips measurable this frame: keep the last known scale;
    // if none was ever measured, degrade to the constant.
    return lastBodyScale ?? Self.fallbackBodyScale
  }

  /// Raw body scale for one frame: the vertical span from the shoulder
  /// midpoint to the ankle midpoint (landmarks with visibility ≥ 0.35; one
  /// visible shoulder/ankle is enough for its midpoint). When the ankles are
  /// missing, shoulder-mid → hip-mid × `hipSpanToBodyScale`. nil when neither
  /// span is measurable.
  private static func measureBodyScale(_ pose: PoseFrame) -> Double? {
    func midY(_ names: Set<String>) -> Double? {
      let ys = pose.landmarks
        .filter { names.contains($0.name) && $0.visibility >= minimumLandmarkVisibility }
        .map(\.y)
      guard !ys.isEmpty else { return nil }
      return ys.reduce(0, +) / Double(ys.count)
    }
    guard let shoulderY = midY(["left_shoulder", "right_shoulder"]) else { return nil }
    if let ankleY = midY(["left_ankle", "right_ankle"]) {
      let span = abs(ankleY - shoulderY)
      if span >= minimumMeasurableBodyScale { return span }
    }
    if let hipY = midY(["left_hip", "right_hip"]) {
      let span = abs(hipY - shoulderY) * hipSpanToBodyScale
      if span >= minimumMeasurableBodyScale { return span }
    }
    return nil
  }
}

// MARK: - Offline pass

extension TemporalStrokeDetector {
  /// The permissive configuration STOP & ANALYZE uses over already-recorded
  /// history. The athlete is asserting a swing happened, so the trigger drops
  /// to 0.8 body-heights/s — a deliberate arm movement (walking arm-swing sits
  /// near 0.5–0.6 relative to the body) — and the quiet onset, path and
  /// duration rules relax a little, while still keeping sustained motion from
  /// qualifying.
  public static let manualStopConfig = Config(
    triggerWristSpeed: 0.8,
    endWristSpeed: 0.5,
    minStrokeMs: 200,
    maxStrokeMs: 2_500,
    refractoryMs: 300,
    minPoseConfidence: 0.5,
    quietWristSpeed: 0.45,
    minQuietBeforeMs: 250,
    maxOnsetToTriggerMs: 1_500,
    minWristPathBodyHeights: 0.25
  )

  public static func completedEvents(in poses: [PoseFrame], config: Config = Config()) -> [StrokeEvent] {
    let pass = TemporalStrokeDetector(config: config)
    return poses.compactMap { pass.ingest(pose: $0, paddle: nil) }
  }

  /// Runs a FRESH detector over `poses` (ascending timestamps) and returns the
  /// highest-confidence event — i.e. the strongest swing-like window — or nil
  /// when nothing in the history moved like a stroke. Pure: the live detector
  /// is untouched.
  public static func strongestEvent(
    in poses: [PoseFrame], config: Config = manualStopConfig, handedness: Handedness? = nil
  ) -> StrokeEvent? {
    var passConfig = config
    if let handedness { passConfig.handedness = handedness }
    var best: StrokeEvent?
    for event in completedEvents(in: poses, config: passConfig) {
      if let current = best, current.confidence >= event.confidence { continue }
      best = event
    }
    return best
  }

  /// Hip-relative wrist speed at or above which the fastest interval of a
  /// recording counts as a deliberate movement for `fallbackMotionWindow`,
  /// body-heights/second. Walking arm swing reads 0.4–0.6 relative to the
  /// hips; a soft shadow swing 0.8 and up.
  public static let fallbackMotionFloor = 0.7
  /// Window the fallback cuts around the fastest interval: enough lead for
  /// the ready position and backswing, enough tail for the follow-through.
  public static let fallbackPreMs = 1_000
  public static let fallbackPostMs = 800

  /// Last resort for STOP & ANALYZE when `strongestEvent` finds no completed
  /// candidate (the athlete never settled, the swing straddled a dropped
  /// frame, the ready position was never still): the window around the
  /// fastest hip-relative wrist interval in `poses`, provided that interval
  /// was a deliberate movement (≥ `fallbackMotionFloor`). The athlete pressed
  /// STOP because a swing happened; discarding the recording is the failure
  /// this prevents. Pure, handedness-aware like the detector, nil when the
  /// history holds no such movement or fewer than two usable wrist samples.
  public static func fallbackMotionWindow(in poses: [PoseFrame], handedness: Handedness? = nil) -> StrokeEvent? {
    guard let first = poses.first, let last = poses.last, poses.count >= 2 else { return nil }
    let selectedWrist = handedness.map { "\($0.rawValue)_wrist" }
    var lastPoints: [String: Observation] = [:]
    var bodyScale: Double?
    var peakSpeed = 0.0
    var peakStartMs: Int?
    var peakEndMs: Int?
    var previousTimestampMs: Int?
    for pose in poses {
      if let previous = previousTimestampMs, pose.timestampMs <= previous { continue }
      previousTimestampMs = pose.timestampMs
      guard pose.confidence >= manualStopConfig.minPoseConfidence else { continue }
      if let measured = measureBodyScale(pose) {
        bodyScale = bodyScale.map { $0 + bodyScaleSmoothing * (measured - $0) } ?? measured
      }
      let scale = bodyScale ?? fallbackBodyScale
      guard let hips = hipAnchor(pose) else { continue }
      for landmark in pose.landmarks
      where (landmark.name == "right_wrist" || landmark.name == "left_wrist")
        && (selectedWrist == nil || landmark.name == selectedWrist)
        && landmark.visibility >= minimumLandmarkVisibility {
        if let previous = lastPoints[landmark.name], pose.timestampMs > previous.tMs,
           pose.timestampMs - previous.tMs <= maximumSampleGapMs,
           let shift = hips.displacement(since: previous.hips) {
          let dt = Double(pose.timestampMs - previous.tMs) / 1000.0
          let dx = landmark.x - previous.x - shift.x
          let dy = landmark.y - previous.y - shift.y
          let speed = (dx * dx + dy * dy).squareRoot() / scale / dt
          if speed > peakSpeed {
            peakSpeed = speed
            peakStartMs = previous.tMs
            peakEndMs = pose.timestampMs
          }
        }
        lastPoints[landmark.name] = Observation(x: landmark.x, y: landmark.y, tMs: pose.timestampMs, hips: hips)
      }
    }
    guard peakSpeed >= fallbackMotionFloor, let peakStartMs, let peakEndMs else { return nil }
    let startMs = max(first.timestampMs, peakStartMs - fallbackPreMs)
    let endMs = min(last.timestampMs, peakEndMs + fallbackPostMs)
    guard endMs > startMs else { return nil }
    return StrokeEvent(
      startMs: startMs,
      endMs: endMs,
      peakMotionMs: peakEndMs,
      confidence: min(0.95, 0.5 + peakSpeed / (manualStopConfig.triggerWristSpeed * 4))
    )
  }
}
