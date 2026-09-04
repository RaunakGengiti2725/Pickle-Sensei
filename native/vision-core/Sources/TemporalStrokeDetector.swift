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
public final class TemporalStrokeDetector: StrokeDetecting {
  public let modelVersion = "temporal-stroke-heuristic-4"

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
      minWristPathBodyHeights: Double = 0.3
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
    }
  }

  /// Landmarks below this visibility, or with a non-finite x/y/visibility, do
  /// not contribute to speed, anchor or scale (see `trustedLandmarks`).
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
  /// Spans smaller than this (normalized-image units) are not a standing body
  /// (lying down, a collapsed detection) and are ignored for scale.
  private static let minimumMeasurableBodyScale = 0.05

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
  }

  private let config: Config
  private var state: State = .idle
  private var lastPoints: [String: Observation] = [:]
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
  private var quietRunSinceMs: Int?
  private var quietRunEndMs: Int?
  /// Last sample of the most recent quiet run that lasted ≥ `minQuietBeforeMs`
  /// — the motion onset a trigger may grow out of. Consumed by a trigger and
  /// cleared when a candidate ends, so every stroke needs a fresh quiet run.
  private var onsetMs: Int?

  /// Body scale (normalized-image units) that the most recent speeds were
  /// normalized by: the EMA-smoothed vertical span from the shoulder midpoint
  /// to the ankle midpoint. nil until a scale has been measured (speeds then
  /// use `fallbackBodyScale`) and after `reset()`. Diagnostics only — read it
  /// on the queue that calls `ingest`.
  public private(set) var lastBodyScale: Double?

  public init(config: Config = Config()) {
    self.config = config
  }

  public func ingest(pose: PoseFrame, paddle: PaddleFrame?) -> StrokeEvent? {
    guard pose.confidence.isFinite, pose.confidence >= config.minPoseConfidence else { return nil }
    // Scale is scene information: refresh it from every trusted pose frame,
    // even one whose wrists or hips are hidden, so a later sample divides by
    // the freshest estimate.
    let landmarks = Self.trustedLandmarks(pose)
    let bodyScale = updateBodyScale(with: landmarks)

    // Prefer a validated paddle center when available. Until then, evaluate
    // each wrist against its own prior location and use the faster wrist. This
    // avoids assuming handedness and avoids false speed spikes when the chosen
    // point switches sides.
    let points: [(key: String, x: Double, y: Double)]
    if let center = paddle?.center, (paddle?.confidence ?? 0) > 0.5,
       center.x.isFinite, center.y.isFinite {
      points = [("paddle", Double(center.x), Double(center.y))]
    } else {
      points = landmarks
        .filter { $0.name == "right_wrist" || $0.name == "left_wrist" }
        .map { ($0.name, $0.x, $0.y) }
    }
    guard !points.isEmpty else { return nil }
    // Without a visible hip the points cannot be placed relative to the body:
    // this frame observes nothing (the next anchored frame measures against
    // the last anchored one, subject to the gap rule). Absolute image motion
    // is never a fallback — it is exactly what walking looked like.
    guard let hips = Self.hipAnchor(landmarks) else { return nil }

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
            previousTimestampMs: previous.tMs
          ))
        }
      }
      lastPoints[point.key] = Observation(x: point.x, y: point.y, tMs: pose.timestampMs, hips: hips)
    }
    guard let fastest = samples.max(by: { $0.speed < $1.speed }) else { return nil }
    let speed = fastest.speed

    switch state {
    case .idle:
      // Stillness is tracked through the refractory period too, so the next
      // stroke's quiet run can build while re-triggering is still blocked.
      trackQuietRun(fastest, at: pose.timestampMs)
      guard pose.timestampMs >= refractoryUntilMs, speed >= config.triggerWristSpeed else { return nil }
      guard let onset = onsetMs, pose.timestampMs - onset <= config.maxOnsetToTriggerMs else {
        // Fast without a recent still start: walking, fidgeting, a scramble.
        return nil
      }
      state = .candidate
      strokeStartMs = onset
      triggerMs = fastest.previousTimestampMs
      peakSpeed = speed
      peakSpeedMs = pose.timestampMs
      settledSinceMs = nil
      wristPaths = [fastest.key: fastest.distance]
      // The onset is consumed: whatever follows this candidate needs a new
      // quiet run of its own.
      clearQuietRun()
      return nil

    case .candidate:
      if speed > peakSpeed {
        peakSpeed = speed
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
        // Sustained motion (rally scramble, walking) — not a discrete stroke.
        drop()
        return nil
      }
      guard speed <= config.endWristSpeed else {
        // Still moving: any settled run so far was a pause, not the end.
        settledSinceMs = nil
        return nil
      }
      // The settled run began with the interval that produced this sample.
      let settledSince = settledSinceMs ?? fastest.previousTimestampMs
      settledSinceMs = settledSince
      guard elapsed >= config.minStrokeMs,
            pose.timestampMs - settledSince >= Self.settledWindowMs else { return nil }
      guard (wristPaths.values.max() ?? 0) >= config.minWristPathBodyHeights else {
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
    refractoryUntilMs = 0
    settledSinceMs = nil
    wristPaths.removeAll(keepingCapacity: true)
    clearQuietRun()
    // Scale is re-seeded from the next trusted frame rather than blended with
    // wherever the athlete stood before the reset.
    lastBodyScale = nil
  }

  private func complete(endMs: Int) -> StrokeEvent {
    state = .idle
    settledSinceMs = nil
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
    settledSinceMs = nil
    clearQuietRun()
  }

  // MARK: - Quiet onset

  /// Folds one idle-state sample into the quiet-run tracker.
  private func trackQuietRun(_ sample: Sample, at timestampMs: Int) {
    // Continuity: the interval behind this sample must touch the run. An
    // uncovered stretch (occlusion, dropped frames, a low-confidence pose) is
    // no evidence of stillness, so the run ends where the evidence did.
    if let end = quietRunEndMs, sample.previousTimestampMs > end {
      endQuietRun()
    }
    if sample.speed <= config.quietWristSpeed {
      if quietRunSinceMs == nil { quietRunSinceMs = sample.previousTimestampMs }
      quietRunEndMs = timestampMs
    } else {
      endQuietRun()
    }
  }

  /// Ends the current quiet run; one that lasted long enough leaves its last
  /// sample as the motion onset (a shorter one leaves the previous onset in
  /// place — a brief paddle-set pause between backswing and swing does not
  /// erase the ready position it grew out of).
  private func endQuietRun() {
    if let since = quietRunSinceMs, let end = quietRunEndMs, end - since >= config.minQuietBeforeMs {
      onsetMs = end
    }
    quietRunSinceMs = nil
    quietRunEndMs = nil
  }

  private func clearQuietRun() {
    quietRunSinceMs = nil
    quietRunEndMs = nil
    onsetMs = nil
  }

  /// The landmarks of one frame this detector may measure: finite x, y and
  /// visibility, with visibility ≥ 0.35. Everything else on the frame is
  /// treated exactly like a hidden landmark.
  private static func trustedLandmarks(_ pose: PoseFrame) -> [PoseLandmark] {
    pose.landmarks.filter {
      $0.x.isFinite && $0.y.isFinite && $0.visibility.isFinite
        && $0.visibility >= minimumLandmarkVisibility
    }
  }

  /// The hips among the trusted landmarks; nil when neither is present.
  private static func hipAnchor(_ landmarks: [PoseLandmark]) -> HipAnchor? {
    var anchor = HipAnchor()
    for landmark in landmarks {
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
  private func updateBodyScale(with landmarks: [PoseLandmark]) -> Double {
    if let measured = Self.measureBodyScale(landmarks) {
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
  /// midpoint to the ankle midpoint over the trusted landmarks (one
  /// shoulder/ankle is enough for its midpoint). When the ankles are missing,
  /// shoulder-mid → hip-mid × `hipSpanToBodyScale`. nil when neither span is
  /// measurable.
  private static func measureBodyScale(_ landmarks: [PoseLandmark]) -> Double? {
    func midY(_ names: Set<String>) -> Double? {
      let ys = landmarks
        .filter { names.contains($0.name) }
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

  /// Runs a FRESH detector over `poses` (ascending timestamps) and returns the
  /// highest-confidence event — i.e. the strongest swing-like window — or nil
  /// when nothing in the history moved like a stroke. Pure: the live detector
  /// is untouched.
  public static func strongestEvent(in poses: [PoseFrame], config: Config = manualStopConfig) -> StrokeEvent? {
    let pass = TemporalStrokeDetector(config: config)
    var best: StrokeEvent?
    for pose in poses {
      guard let event = pass.ingest(pose: pose, paddle: nil) else { continue }
      if let current = best, current.confidence >= event.confidence { continue }
      best = event
    }
    return best
  }
}
