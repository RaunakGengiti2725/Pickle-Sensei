import Foundation

/// Movement-completion strategy for guided capture (D-029).
///
/// `fixed` is the SHIPPED default: the clip finalizes a fixed post-roll after
/// the detector's movement end. `adaptive` is a MEASURED CANDIDATE, not a
/// promotion: D-029 (EXP-2026-08-28-adaptive-completion) halved the median
/// end error on 5 gold events but the gate requires the LIVE trigger
/// instrumented and ≥20 gold events in agreement before default changes.
enum CaptureCompletionStrategy: String {
  case fixed
  case adaptive
}

/// Process-wide, default-off runtime switch for the completion strategy.
///
/// The app has no feature-flag system that reaches Swift (RN runtime config is
/// build-time TS only), so this is the D-029 instrumentation switch: settable
/// from the RN bridge (`PickleVideoCapture.setCompletionStrategy`), read once
/// per capture session at controller init, and ALWAYS `fixed` at process
/// start. Nothing persists it; a fresh launch is always the shipped behavior.
enum CaptureCompletionStrategyStore {
  private static let lock = NSLock()
  private static var storedStrategy: CaptureCompletionStrategy = .fixed

  static var strategy: CaptureCompletionStrategy {
    lock.lock()
    defer { lock.unlock() }
    return storedStrategy
  }

  /// Returns the effective strategy after the update (echoed to the bridge).
  @discardableResult
  static func set(_ strategy: CaptureCompletionStrategy) -> CaptureCompletionStrategy {
    lock.lock()
    defer { lock.unlock() }
    storedStrategy = strategy
    return storedStrategy
  }
}

/// D-029 live instrumentation: observes the SAME wrist-motion series the live
/// trigger computes and evaluates the benched adaptive-completion rules on it.
///
/// Runs for BOTH strategies on every automatic capture. Under the shipped
/// `fixed` strategy it is a pure shadow instrument — it never affects timing;
/// its decisions and the post-completion motion series are recorded into the
/// clip's capture metadata so offline replay can compare FIXED vs ADAPTIVE on
/// real live captures. Under the flagged `adaptive` strategy the same decision
/// finalizes the recording.
///
/// SERIES — mirrors `TemporalStrokeDetector.ingest` (what `peakMotionMs` is
/// computed from): per frame, each wrist with visibility ≥ 0.35 is compared
/// against its own prior observation (elapsed > 0 and ≤ 250 ms), speed is
/// normalized-image units/second, the fastest wrist wins the frame, and frames
/// with pose confidence < 0.5 are skipped. The live capture passes no paddle
/// frames, so the paddle-preference branch of the detector has no live
/// counterpart. Known bounded divergence, disclosed: the detector clears its
/// wrist priors on `reset()` (disarm/pose-loss) while this monitor relies on
/// the 250 ms gap gate alone, so reset-adjacent PRE-trigger samples can differ
/// slightly; the post-completion decision window is fed identically.
///
/// DECISIONS — mirror `packages/swing-lab/src/eventCompletionBench.ts`
/// (D-029, EXP-2026-08-28-adaptive-completion) EXACTLY, anchored at the
/// trigger's `peakMotionMs` (the bench's trigger = peak wrist speed inside the
/// event):
///   settle  — speed < max(0.15, 25% of peak) sustained 400 ms → end at the
///             sample completing the quiet run
///   valley  — speed dips below 60% of peak, then rises ≥ max(2× settle
///             threshold, 1.5× valley) at least 80 ms after the valley → the
///             next stroke began; end at the valley
///   safety  — hard max at anchor + 2500 ms (by camera clock, so a lost pose
///             stream can never stall an adaptive finalize). Disclosed
///             divergence from the offline bench: the bench's loop still
///             evaluates the single sample that overshoots the safety bound
///             before breaking, so its settle end can exceed the bound by one
///             sample interval; live, the camera-clock safety fires first.
///             Bounded to one frame at the safety edge, and the recorded
///             series lets replay quantify it per capture.
///   min follow-through — samples earlier than anchor + 300 ms are ignored
final class StrokeCompletionMonitor {
  /// Constants copied verbatim from the D-029 bench so the live instrument and
  /// the offline replay cannot drift apart silently. Version any change.
  enum Params {
    static let settleFloorPerSecond = 0.15
    static let settlePeakFraction = 0.25
    static let settleHoldMs = 400
    static let minFollowThroughMs = 300
    static let safetyMaxMs = 2500
    static let valleyDipFraction = 0.6
    static let valleyRiseRatio = 1.5
    static let valleyRiseMinGapMs = 80
  }

  static let algorithmVersion = "completion-monitor-1"

  /// Series constants mirrored from `TemporalStrokeDetector`.
  private static let minWristVisibility = 0.35
  private static let maximumSampleGapMs = 250
  private static let minPoseConfidence = 0.5

  /// Rolling buffer bound: generous enough to cover the longest stroke the
  /// detector can emit (2200 ms) plus the full safety window (2500 ms) at
  /// 60 fps, with headroom. Bounded evidence, never an unbounded stream.
  private static let bufferWindowMs = 8_000
  private static let bufferMaxSamples = 512

  /// Downsample bound for the recorded post-completion series (task/D-023
  /// bounded-evidence pattern).
  static let recordedSampleCap = 50

  struct MotionSample {
    let timestampMs: Int
    let value: Double
  }

  enum AdaptiveReason: String {
    case settle
    case valley
    case safetyMax = "safety_max"
  }

  struct AdaptiveDecision {
    /// The decided movement end (settle sample, valley sample, or
    /// anchor + safetyMaxMs). May precede the frame that confirmed it.
    let endMs: Int
    /// Camera-clock timestamp of the frame on which the decision was made.
    let decidedAtMs: Int
    let reason: AdaptiveReason
  }

  /// Snapshot of everything the instrument observed, for capture metadata.
  struct Telemetry {
    let strategy: CaptureCompletionStrategy
    let movementCompleteMs: Int
    let anchorMs: Int
    let finalizeMs: Int
    let peakMotionValue: Double
    let settleDetectedMs: Int?
    let valleyDetectedMs: Int?
    let safetyMaxHit: Bool
    /// Latest camera-clock timestamp the monitor saw while armed. Lets replay
    /// distinguish "adaptive never fired" from "observation window ended".
    let observedUntilMs: Int
    let observedSampleCount: Int
    let samples: [MotionSample]
  }

  private let lock = NSLock()
  private var buffer: [MotionSample] = []
  private var lastPoints: [String: (x: Double, y: Double, tMs: Int)] = [:]

  // Armed (post stroke-event) state.
  private var armed = false
  private var anchorMs = 0
  private var movementEndMs = 0
  private var peakMotionValue = 0.0
  private var settleThreshold = 0.0
  private var quietSinceMs: Int?
  private var valleyCandidate: MotionSample?
  private var decision: AdaptiveDecision?
  private var latestObservedMs = 0

  /// Feed one pose frame. Called on the vision queue both before the stroke
  /// event (so the in-event peak is measurable, as the bench measures it) and
  /// during the post-completion window.
  func ingest(pose: PoseFrame) {
    guard pose.confidence >= Self.minPoseConfidence else { return }
    let wrists = pose.landmarks.filter {
      ($0.name == "right_wrist" || $0.name == "left_wrist")
        && $0.visibility >= Self.minWristVisibility
    }
    guard !wrists.isEmpty else { return }

    lock.lock()
    defer { lock.unlock() }
    var fastest: Double?
    for wrist in wrists {
      if let previous = lastPoints[wrist.name], pose.timestampMs > previous.tMs {
        let elapsedMs = pose.timestampMs - previous.tMs
        if elapsedMs <= Self.maximumSampleGapMs {
          let dt = Double(elapsedMs) / 1_000.0
          let dx = wrist.x - previous.x
          let dy = wrist.y - previous.y
          let speed = (dx * dx + dy * dy).squareRoot() / dt
          fastest = max(fastest ?? 0, speed)
        }
      }
      lastPoints[wrist.name] = (wrist.x, wrist.y, pose.timestampMs)
    }
    guard let speed = fastest else { return }
    let sample = MotionSample(timestampMs: pose.timestampMs, value: speed)
    append(sample)
    if armed, decision == nil {
      evaluateLocked(sample)
    }
  }

  /// Arm the decision window when the live trigger fires. Mirrors the bench:
  /// anchor = peak-motion timestamp, peak value = max series value inside the
  /// detected event window.
  func arm(eventStartMs: Int, eventEndMs: Int, peakMotionMs: Int?) {
    lock.lock()
    defer { lock.unlock() }
    guard !armed else { return }
    armed = true
    anchorMs = peakMotionMs ?? eventEndMs
    movementEndMs = eventEndMs
    let inEvent = buffer.filter { $0.timestampMs >= eventStartMs && $0.timestampMs <= eventEndMs }
    peakMotionValue = inEvent.map(\.value).max() ?? 0
    // eventCompletionBench.ts: max(0.15, 0.25 * peak.value)
    settleThreshold = max(Params.settleFloorPerSecond, Params.settlePeakFraction * peakMotionValue)
    quietSinceMs = nil
    valleyCandidate = nil
    decision = nil
    latestObservedMs = eventEndMs
    // Samples between the anchor (peak) and the event's end arrived before the
    // event fired; the bench evaluates from the anchor, so replay them now.
    for sample in buffer where sample.timestampMs >= anchorMs {
      if decision == nil { evaluateLocked(sample) }
    }
  }

  /// Camera-clock tick, called for every frame in the post-completion window
  /// regardless of pose availability. Enforces the bench's hard safety max so
  /// adaptive finalize can never stall on a lost pose stream, and gives the
  /// fixed-strategy shadow an honest "observed past the safety max" bound.
  func observeFrame(timestampMs: Int) {
    lock.lock()
    defer { lock.unlock() }
    guard armed else { return }
    latestObservedMs = max(latestObservedMs, timestampMs)
    if decision == nil, timestampMs >= anchorMs + Params.safetyMaxMs {
      // eventCompletionBench.ts: adaptiveEnd defaults to trigger + 2500.
      decision = AdaptiveDecision(
        endMs: anchorMs + Params.safetyMaxMs,
        decidedAtMs: timestampMs,
        reason: .safetyMax
      )
    }
  }

  /// The adaptive decision, if one has been reached. The flagged adaptive
  /// strategy finalizes on this; the fixed strategy only records it.
  func adaptiveDecision() -> AdaptiveDecision? {
    lock.lock()
    defer { lock.unlock() }
    return decision
  }

  /// Telemetry snapshot for the clip's capture metadata (session-relative
  /// timestamps; `ClipMediaStore` rebases them to clip-relative).
  func telemetry(strategy: CaptureCompletionStrategy, finalizeMs: Int) -> Telemetry {
    lock.lock()
    defer { lock.unlock() }
    let post = buffer.filter { $0.timestampMs >= anchorMs }
    return Telemetry(
      strategy: strategy,
      movementCompleteMs: movementEndMs,
      anchorMs: anchorMs,
      finalizeMs: finalizeMs,
      peakMotionValue: peakMotionValue,
      settleDetectedMs: decision?.reason == .settle ? decision?.endMs : nil,
      valleyDetectedMs: decision?.reason == .valley ? decision?.endMs : nil,
      safetyMaxHit: decision?.reason == .safetyMax,
      observedUntilMs: max(latestObservedMs, post.last?.timestampMs ?? latestObservedMs),
      observedSampleCount: post.count,
      samples: Self.downsample(post, cap: Self.recordedSampleCap)
    )
  }

  // MARK: - Private

  /// One iteration of the bench's decision loop (eventCompletionBench.ts,
  /// D-029) over a post-anchor sample. Caller holds `lock`.
  private func evaluateLocked(_ sample: MotionSample) {
    guard armed, decision == nil, sample.timestampMs >= anchorMs else { return }
    // Bench: `if (sample.timestampMs > trigger + 2500) break;`
    guard sample.timestampMs <= anchorMs + Params.safetyMaxMs else {
      decision = AdaptiveDecision(
        endMs: anchorMs + Params.safetyMaxMs,
        decidedAtMs: sample.timestampMs,
        reason: .safetyMax
      )
      return
    }
    // Bench: `if (sample.timestampMs < trigger + 300) continue;`
    guard sample.timestampMs >= anchorMs + Params.minFollowThroughMs else { return }

    // SETTLE: speed < max(0.15, 25% peak) sustained 400 ms.
    if sample.value < settleThreshold {
      if quietSinceMs == nil { quietSinceMs = sample.timestampMs }
      if let quietSince = quietSinceMs, sample.timestampMs - quietSince >= Params.settleHoldMs {
        decision = AdaptiveDecision(
          endMs: sample.timestampMs,
          decidedAtMs: sample.timestampMs,
          reason: .settle
        )
        return
      }
    } else {
      quietSinceMs = nil
    }

    // NEXT-STROKE VALLEY: dip < 60% peak, then rise ≥ max(2× settle
    // threshold, 1.5× valley) at ≥ 80 ms after the valley → end at valley.
    if sample.value < Params.valleyDipFraction * peakMotionValue,
       valleyCandidate == nil || sample.value < valleyCandidate!.value {
      valleyCandidate = sample
    }
    if let valley = valleyCandidate,
       sample.value >= max(settleThreshold * 2, Params.valleyRiseRatio * valley.value),
       sample.timestampMs > valley.timestampMs + Params.valleyRiseMinGapMs {
      decision = AdaptiveDecision(
        endMs: valley.timestampMs,
        decidedAtMs: sample.timestampMs,
        reason: .valley
      )
    }
  }

  private func append(_ sample: MotionSample) {
    if let last = buffer.last, sample.timestampMs <= last.timestampMs { return }
    buffer.append(sample)
    let cutoff = sample.timestampMs - Self.bufferWindowMs
    if let firstKept = buffer.firstIndex(where: { $0.timestampMs >= cutoff }), firstKept > 0 {
      buffer.removeFirst(firstKept)
    }
    if buffer.count > Self.bufferMaxSamples {
      buffer.removeFirst(buffer.count - Self.bufferMaxSamples)
    }
  }

  /// Evenly strided downsample that always keeps the final sample; the tail is
  /// where completion decisions live.
  static func downsample(_ samples: [MotionSample], cap: Int) -> [MotionSample] {
    guard cap > 0 else { return [] }
    guard samples.count > cap else { return samples }
    let stride = (samples.count + cap - 1) / cap
    var picked: [MotionSample] = []
    picked.reserveCapacity(cap)
    var index = 0
    while index < samples.count, picked.count < cap {
      picked.append(samples[index])
      index += stride
    }
    if let last = samples.last, picked.last?.timestampMs != last.timestampMs, !picked.isEmpty {
      picked[picked.count - 1] = last
    }
    return picked
  }

  /// JSON payload for the clip's capture metadata. Point-in-time fields and
  /// sample timestamps are rebased from session-relative to CLIP-relative
  /// (`rebasedTo` = the exported window's start), exactly like the trigger
  /// block, so replay lines up with the pose sidecar. `params` are durations
  /// and ratios — never rebased.
  static func payload(for telemetry: Telemetry, rebasedTo windowStartMs: Int) -> [String: Any] {
    func rebase(_ timestampMs: Int) -> Int { max(0, timestampMs - windowStartMs) }
    var payload: [String: Any] = [
      "schemaVersion": 1,
      "completionStrategy": telemetry.strategy.rawValue,
      "algorithmVersion": algorithmVersion,
      "motionUnit": "normalized_image_units_per_second",
      "movementCompleteMs": rebase(telemetry.movementCompleteMs),
      "anchorMs": rebase(telemetry.anchorMs),
      "finalizeMs": rebase(telemetry.finalizeMs),
      "peakMotionValue": telemetry.peakMotionValue,
      "safetyMaxHit": telemetry.safetyMaxHit,
      "observedUntilMs": rebase(telemetry.observedUntilMs),
      "observedSampleCount": telemetry.observedSampleCount,
      "params": [
        "settleFloorPerSecond": Params.settleFloorPerSecond,
        "settlePeakFraction": Params.settlePeakFraction,
        "settleHoldMs": Params.settleHoldMs,
        "minFollowThroughMs": Params.minFollowThroughMs,
        "safetyMaxMs": Params.safetyMaxMs,
        "valleyDipFraction": Params.valleyDipFraction,
        "valleyRiseRatio": Params.valleyRiseRatio,
        "valleyRiseMinGapMs": Params.valleyRiseMinGapMs,
      ] as [String: Any],
      "postCompletionMotion": telemetry.samples.map { sample in
        ["tMs": rebase(sample.timestampMs), "v": sample.value] as [String: Any]
      },
    ]
    if let settle = telemetry.settleDetectedMs { payload["settleDetectedMs"] = rebase(settle) }
    if let valley = telemetry.valleyDetectedMs { payload["valleyDetectedMs"] = rebase(valley) }
    return payload
  }
}
