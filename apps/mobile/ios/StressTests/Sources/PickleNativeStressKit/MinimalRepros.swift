import Foundation
@testable import PickleNativeStressCore

/// Hand-minimized inputs for every failure the seeded campaigns reproduced.
/// Each case is the smallest input that still fails; `stress-runner repro
/// <name>` executes one in a fresh process (two of them trap the process).
public enum MinimalRepro: String, CaseIterable {
  /// `readinessDuplicateLandmark` — a single pose with two visible
  /// `right_hip` landmarks: `PoseReadinessEvaluator.ingest` builds
  /// `Dictionary(uniqueKeysWithValues:)` → Swift runtime trap.
  case duplicateVisibleLandmarkName
  /// `timestampExtremes` — arm at `Int.max - 10`, then `observeFrame`:
  /// `anchorMs + Params.safetyMaxMs` overflows → Swift runtime trap.
  case observeFrameNearIntMax
  /// `hugeAndCorruptInputs` seed 14 — two frames, second wrist `x = +inf`:
  /// `SessionMotionStream` emits an infinite speed, the completion payload
  /// fails `JSONSerialization.isValidJSONObject`.
  case infiniteWristCoordinateInPayload
  /// `hugeAndCorruptInputs` seed 33 (flaky 6/10) — a scripted two-wrist
  /// swing in which the OFF hand reports `x = NaN` for one frame while the
  /// candidate is open. `wristPaths[off] += NaN` poisons that entry and the
  /// close gate reads `wristPaths.values.max()`: `Sequence.max` over a
  /// Dictionary whose iteration order is per-process hash-seeded returns
  /// either the finite path (stroke completes) or NaN (candidate dropped).
  /// Stdout is `event`/`none` so a caller can compare runs; run it under
  /// `SWIFT_DETERMINISTIC_HASHING=1` and the answer stops changing.
  case nanWristPathMakesStrokeCompletionOrderDependent

  public var trapsProcess: Bool {
    self == .duplicateVisibleLandmarkName || self == .observeFrameNearIntMax
  }

  /// Runs the repro. Returns `true` when the documented failure did NOT
  /// happen (i.e. the invariant held); trapping repros never return.
  public func invariantHeld() -> Bool {
    switch self {
    case .duplicateVisibleLandmarkName:
      let hip = PoseLandmark(name: "right_hip", x: 0.55, y: 0.5, visibility: 0.9)
      let frame = PoseFrame(timestampMs: 16, landmarks: [hip, hip], confidence: 0.9)
      return PoseReadinessEvaluator().ingest(pose: frame).jointCoverage <= 1
    case .observeFrameNearIntMax:
      let monitor = StrokeCompletionMonitor()
      monitor.arm(eventStartMs: Int.max - 10, eventEndMs: Int.max - 10, peakMotionMs: nil)
      monitor.observeFrame(timestampMs: Int.max - 10)
      return monitor.adaptiveDecision() == nil
    case .infiniteWristCoordinateInPayload:
      let stream = SessionMotionStream()
      let monitor = StrokeCompletionMonitor()
      func frame(_ ts: Int, wristX: Double) -> PoseFrame {
        PoseFrame(
          timestampMs: ts,
          landmarks: [PoseLandmark(name: "right_wrist", x: wristX, y: 0.5, visibility: 0.9)],
          confidence: 0.9
        )
      }
      _ = stream.ingest(pose: frame(1_000, wristX: 0.5))
      monitor.ingest(pose: frame(1_000, wristX: 0.5))
      let sample = stream.ingest(pose: frame(1_016, wristX: .infinity))
      monitor.ingest(pose: frame(1_016, wristX: .infinity))
      let payload = StrokeCompletionMonitor.payload(for: monitor.telemetry(strategy: .fixed, finalizeMs: 1_016), rebasedTo: 0)
      return (sample?.value.isFinite ?? true) && JSONSerialization.isValidJSONObject(payload)
    case .nanWristPathMakesStrokeCompletionOrderDependent:
      // Control: the same swing with a finite off hand must complete, or the
      // script is wrong rather than the detector.
      guard Self.twoWristSwing(offHandNaNAt: nil) else { return false }
      let completed = Self.twoWristSwing(offHandNaNAt: 726)
      print(completed ? "event" : "none")
      return completed
    }
  }

  /// A 30 fps ready-position → swing → settle script with both wrists visible;
  /// the swinging wrist covers ≈ 0.36 body-heights (gate: 0.3). Returns whether
  /// `TemporalStrokeDetector` emitted the stroke.
  static func twoWristSwing(offHandNaNAt nanTimestampMs: Int?) -> Bool {
    let detector = TemporalStrokeDetector(config: TemporalStrokeDetector.Config())
    func frame(_ ts: Int, swingX: Double, offX: Double) -> PoseFrame {
      PoseFrame(
        timestampMs: ts,
        landmarks: [
          PoseLandmark(name: "left_shoulder", x: 0.45, y: 0.2, visibility: 0.9),
          PoseLandmark(name: "right_shoulder", x: 0.55, y: 0.2, visibility: 0.9),
          PoseLandmark(name: "left_hip", x: 0.46, y: 0.5, visibility: 0.9),
          PoseLandmark(name: "right_hip", x: 0.54, y: 0.5, visibility: 0.9),
          PoseLandmark(name: "left_ankle", x: 0.46, y: 0.9, visibility: 0.9),
          PoseLandmark(name: "right_ankle", x: 0.54, y: 0.9, visibility: 0.9),
          PoseLandmark(name: "right_wrist", x: swingX, y: 0.45, visibility: 0.9),
          PoseLandmark(name: "left_wrist", x: offX, y: 0.45, visibility: 0.9),
        ],
        confidence: 0.9
      )
    }
    var emitted = false
    var swingX = 0.6
    var ts = 0
    while ts <= 1_200 {
      // 0–528 ms ready position, 561–693 ms swing (+0.05/frame ≈ 2.1 bh/s,
      // 5 frames ≈ 0.36 bh of path), 726 ms → settled.
      if (561 ... 693).contains(ts) { swingX += 0.05 }
      let offX = ts == nanTimestampMs ? Double.nan : 0.35
      if detector.ingest(pose: frame(ts, swingX: swingX, offX: offX), paddle: nil) != nil { emitted = true }
      ts += 33
    }
    return emitted
  }
}
