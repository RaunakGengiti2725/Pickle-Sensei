import Foundation
import PickleNativeStressCore

/// One camera tick as the vision queue sees it: a pose, or a frame on which
/// Vision found nobody (`ApplePoseProvider` throws → callers ingest "missing").
public enum StreamTick {
  case pose(PoseFrame)
  case missing(timestampMs: Int)

  public var timestampMs: Int {
    switch self {
    case .pose(let frame): return frame.timestampMs
    case .missing(let timestampMs): return timestampMs
    }
  }
}

/// Builds a seeded, realistic-shaped capture session: quiet stances, swings of
/// random amplitude/duration, walking, dropouts, low-confidence stretches,
/// corrupt landmark lists, timestamp jitter and (optionally) clock faults.
public struct StreamGenerator {
  public struct Options: Sendable {
    public var fps: Int
    public var durationMs: Int
    public var corruptionRate: Double
    public var allowDuplicateJointCorruption: Bool
    public var clockFaultRate: Double
    public var secondAthlete: Bool

    public init(
      fps: Int = 60,
      durationMs: Int = 10_000,
      corruptionRate: Double = 0.02,
      allowDuplicateJointCorruption: Bool = false,
      clockFaultRate: Double = 0.0,
      secondAthlete: Bool = false
    ) {
      self.fps = fps
      self.durationMs = durationMs
      self.corruptionRate = corruptionRate
      self.allowDuplicateJointCorruption = allowDuplicateJointCorruption
      self.clockFaultRate = clockFaultRate
      self.secondAthlete = secondAthlete
    }

    public static func random(_ rng: inout StressRNG, secondAthlete: Bool = false) -> Options {
      Options(
        fps: rng.pick([24, 30, 60, 120]),
        durationMs: rng.int(in: 2_000 ... 20_000),
        corruptionRate: rng.pick([0, 0.005, 0.02, 0.1]),
        allowDuplicateJointCorruption: false,
        clockFaultRate: rng.chance(0.3) ? 0.01 : 0,
        secondAthlete: secondAthlete
      )
    }
  }

  private enum Segment {
    case still(ms: Int)
    case swing(ms: Int, amplitude: Double)
    case walk(ms: Int, dx: Double)
    case dropout(ms: Int)
    case lowConfidence(ms: Int)
  }

  public let options: Options
  public let seed: UInt64
  public let athlete: PoseSynth.Athlete
  public let bystander: PoseSynth.Athlete

  public init(seed: UInt64, options: Options) {
    self.seed = seed
    self.options = options
    var rng = StressRNG(seed: seed ^ 0xA11E7E)
    athlete = PoseSynth.Athlete.readyFraming(&rng)
    bystander = PoseSynth.Athlete(
      centerX: athlete.centerX < 0.5 ? 0.8 : 0.2,
      centerY: rng.double(in: 0.4 ... 0.6),
      height: rng.double(in: 0.3 ... 0.6),
      mirrored: !athlete.mirrored
    )
  }

  /// Generates the whole session; `swings` counts swing segments emitted so
  /// scenarios can bound detector output.
  public func generate() -> (ticks: [StreamTick], swings: Int, corrupted: Int) {
    var rng = StressRNG(seed: seed)
    let frameMs = max(1, 1000 / options.fps)
    var ticks: [StreamTick] = []
    var timestampMs = rng.int(in: 0 ... 5_000_000)
    var swings = 0
    var corrupted = 0
    var elapsed = 0
    var athleteState = athlete

    while elapsed < options.durationMs {
      let segment: Segment
      switch rng.int(in: 0 ... 99) {
      case 0 ..< 40: segment = .still(ms: rng.int(in: 200 ... 1_500))
      case 40 ..< 70:
        segment = .swing(ms: rng.int(in: 150 ... 1_400), amplitude: rng.double(in: 0.1 ... 1.4))
        swings += 1
      case 70 ..< 80: segment = .walk(ms: rng.int(in: 300 ... 2_000), dx: rng.double(in: -0.2 ... 0.2))
      case 80 ..< 92: segment = .dropout(ms: rng.int(in: frameMs ... 900))
      default: segment = .lowConfidence(ms: rng.int(in: frameMs ... 600))
      }

      let segmentMs: Int
      switch segment {
      case .still(let ms), .swing(let ms, _), .walk(let ms, _), .dropout(let ms), .lowConfidence(let ms):
        segmentMs = ms
      }
      let frames = max(1, segmentMs / frameMs)
      for index in 0 ..< frames {
        let phase = Double(index) / Double(max(1, frames - 1))
        // Camera timestamps: frame period plus ±1 ms jitter.
        timestampMs += frameMs + (rng.chance(0.2) ? rng.int(in: -1 ... 1) : 0)
        if options.clockFaultRate > 0, rng.chance(options.clockFaultRate) {
          // A regressed or repeated timestamp: consumers must not fabricate speed.
          timestampMs -= rng.int(in: 0 ... 2 * frameMs)
        }
        elapsed += frameMs

        switch segment {
        case .dropout:
          ticks.append(.missing(timestampMs: timestampMs))
          continue
        case .walk(_, let dx):
          athleteState.centerX = min(0.95, max(0.05, athleteState.centerX + dx / Double(frames)))
        default:
          break
        }

        let arm: PoseSynth.Arm
        if case .swing(_, let amplitude) = segment {
          arm = .swing(phase: phase, amplitude: amplitude)
        } else {
          arm = .still
        }
        var confidence = rng.double(in: 0.6 ... 1.0)
        if case .lowConfidence = segment { confidence = rng.double(in: 0 ... 0.49) }

        let subject: PoseSynth.Athlete
        if options.secondAthlete, rng.chance(0.15) {
          subject = bystander
        } else {
          subject = athleteState
        }
        var frame = PoseSynth.frame(
          subject,
          arm: arm,
          timestampMs: timestampMs,
          confidence: confidence,
          visibility: rng.chance(0.1) ? rng.double(in: 0 ... 0.34) : rng.double(in: 0.35 ... 1),
          jitter: rng.pick([0, 0.001, 0.004]),
          rng: &rng
        )
        if options.corruptionRate > 0, rng.chance(options.corruptionRate) {
          let pool = options.allowDuplicateJointCorruption
            ? PoseSynth.Corruption.allCases
            : PoseSynth.nonDuplicatingCorruptions
          frame = PoseSynth.corrupt(frame, with: rng.pick(pool), rng: &rng)
          corrupted += 1
        }
        ticks.append(.pose(frame))
      }
    }
    return (ticks, swings, corrupted)
  }
}
