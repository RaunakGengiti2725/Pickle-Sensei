import Foundation
@testable import PickleNativeStressCore

/// A `PoseProviding` witness driven by a script: each call either returns the
/// scripted frame, throws the scripted `VisionFailure`, or blocks on a gate so
/// a caller can tear the pipeline down while an extraction is in flight.
public final class ScriptedPoseProvider: PoseProviding, @unchecked Sendable {
  public enum Step: Sendable {
    case pose(PoseFrame)
    case failure(VisionFailure)
  }

  public let modelVersion = "scripted-pose-1"
  private let lock = NSLock()
  private let steps: [Step]
  private var cursor = 0
  public private(set) var calls = 0
  /// While non-nil, every call waits on the semaphore before consuming a step.
  public var gate: DispatchSemaphore?

  public init(steps: [Step]) {
    self.steps = steps
  }

  public func extractPose(pixelBuffer: CVPixelBuffer, timestampMs: Int) throws -> PoseFrame {
    gate?.wait()
    lock.lock()
    calls += 1
    defer { cursor += 1; lock.unlock() }
    guard cursor < steps.count else { throw VisionFailure.corruptedMedia("script exhausted") }
    switch steps[cursor] {
    case .pose(let frame):
      return PoseFrame(timestampMs: timestampMs, landmarks: frame.landmarks, confidence: frame.confidence)
    case .failure(let failure):
      throw failure
    }
  }
}

/// MODEL (not production code) of the imported-video extraction loop in
/// `apps/mobile/ios/LocalPods/PickleNative/Sources/PickleVideoCapture.swift`
/// (`extractImportedPoseSequence`, the `while let sample = copyNextSampleBuffer()`
/// loop): first-PTS anchoring, rewind skipping, the 60 s cap, ≤61 fps
/// decimation, `try?` gap semantics and 10 % progress emission. AVFoundation is
/// unavailable on Linux, so the decode is replaced by an explicit sample list;
/// every other rule is transcribed line-for-line so the seeded campaign can
/// probe the arithmetic and the error-swallowing contract. Apple truth for the
/// real loop is UNVERIFIED-on-Linux.
public struct ImportExtractionModel {
  public static let importedPoseMaxDurationSeconds = 60.0
  public static let minimumIntervalMs = 1000.0 / 61.0 - 0.51

  public struct Sample: Sendable {
    /// nil models a non-numeric PTS or a sample without an image buffer.
    public let presentationSeconds: Double?
    public init(presentationSeconds: Double?) { self.presentationSeconds = presentationSeconds }
  }

  public enum Result: Equatable {
    case invalidMedia
    case noPerson
    case sequence(framesWithPose: Int, framesTotal: Int, lastKeptTimestampMs: Int, reachedCap: Bool)
  }

  public struct Trace {
    public var progress: [Double] = []
    public var poses: [PoseFrame] = []
    /// Rebased timestamp handed to the provider for every kept frame,
    /// whether or not it yielded a pose.
    public var keptTimestampsMs: [Int] = []
    public var providerCalls = 0
    /// Set when the caller flipped `cancelled` while the loop was running —
    /// the production loop has no cancellation check, so this only records
    /// that the loop kept going.
    public var ranPastCancellation = false
  }

  /// `cancelled` is polled every frame purely to RECORD that production
  /// ignores it; it never changes control flow (matching the source).
  public static func run(
    samples: [Sample],
    durationSeconds: Double,
    provider: PoseProviding,
    cancelled: () -> Bool = { false }
  ) -> (Result, Trace) {
    var trace = Trace()
    let durationMs = durationSeconds * 1000
    var firstFramePTS: Double?
    var lastKeptElapsedMs = -Double.infinity
    var lastKeptTimestampMs = 0
    var framesProcessed = 0
    var nextProgressEmission = 0.1
    var reachedCap = false
    trace.progress.append(0)

    var index = 0
    while !reachedCap, index < samples.count {
      let sample = samples[index]
      index += 1
      if cancelled() { trace.ranPastCancellation = true }
      guard let pts = sample.presentationSeconds, pts.isFinite else { continue }
      let anchor: Double
      if let existing = firstFramePTS {
        anchor = existing
      } else {
        firstFramePTS = pts
        anchor = pts
      }
      let elapsedMs = (pts - anchor) * 1000
      guard elapsedMs.isFinite, elapsedMs >= 0 else { continue }
      if elapsedMs > importedPoseMaxDurationSeconds * 1000 {
        reachedCap = true
        continue
      }
      guard elapsedMs - lastKeptElapsedMs >= minimumIntervalMs else { continue }
      lastKeptElapsedMs = elapsedMs
      let timestampMs = Int(elapsedMs.rounded())
      lastKeptTimestampMs = timestampMs
      framesProcessed += 1
      trace.providerCalls += 1
      trace.keptTimestampsMs.append(timestampMs)
      if let pose = try? provider.extractPose(pixelBuffer: StressPixelBuffer.blank(), timestampMs: timestampMs) {
        trace.poses.append(pose)
      }
      let progress = min(1.0, elapsedMs / max(durationMs, 1.0))
      if progress >= nextProgressEmission {
        nextProgressEmission = progress + 0.1
        trace.progress.append(progress)
      }
    }

    guard framesProcessed > 0 else { return (.invalidMedia, trace) }
    guard !trace.poses.isEmpty else { return (.noPerson, trace) }
    trace.progress.append(1)
    return (
      .sequence(
        framesWithPose: trace.poses.count,
        framesTotal: framesProcessed,
        lastKeptTimestampMs: lastKeptTimestampMs,
        reachedCap: reachedCap
      ),
      trace
    )
  }
}
