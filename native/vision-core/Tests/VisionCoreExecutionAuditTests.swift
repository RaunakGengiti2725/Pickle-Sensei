import CoreGraphics
import CoreVideo
import Foundation
import XCTest

@testable import PickleVisionCore

/// Execution-audit coverage for the package's documented runtime contracts:
/// the provider's anchor lock under concurrent access, the Vision request
/// lifecycle on a frame with nobody in it, and the bounded state machines fed
/// non-monotonic or very long frame streams. Nothing here retunes a threshold;
/// each expectation restates a property the production code already promises.
final class VisionCoreExecutionAuditTests: XCTestCase {
  // MARK: - ApplePoseProvider: anchor lock

  /// `setPrimaryPersonSeed` is called from the main thread while the vision
  /// queue reads and rewrites the anchor. Hammer all three accessors from many
  /// threads at once: every value read back must be a real seeded point (or
  /// nil after a reset), never a torn or non-finite one.
  func testAnchorSeedResetAndReadAreSafeUnderConcurrentAccess() {
    let provider = ApplePoseProvider()
    let seeds: [(x: Double, y: Double)] = [(0.10, 0.20), (0.35, 0.65), (0.80, 0.90)]
    let expectedAnchors = seeds.map { CGPoint(x: $0.x, y: 1.0 - $0.y) }

    let bookkeeping = NSLock()
    var reads = 0
    var invalidReads = 0

    DispatchQueue.concurrentPerform(iterations: 30_000) { index in
      switch index % 4 {
      case 0, 1:
        let seed = seeds[index % seeds.count]
        provider.setPrimaryPersonSeed(x: seed.x, y: seed.y)
      case 2:
        provider.resetPrimaryPersonAnchor()
      default:
        let observed = provider.primaryPersonAnchorForTesting
        let valid: Bool
        if let observed {
          valid = expectedAnchors.contains {
            abs(Double($0.x - observed.x)) < 1e-9 && abs(Double($0.y - observed.y)) < 1e-9
          }
        } else {
          valid = true
        }
        bookkeeping.lock()
        reads += 1
        if !valid { invalidReads += 1 }
        bookkeeping.unlock()
      }
    }

    XCTAssertGreaterThan(reads, 0)
    XCTAssertEqual(invalidReads, 0, "every read must observe a whole seed or nil, never a torn anchor")

    provider.setPrimaryPersonSeed(x: 0.3, y: 0.6)
    guard let settled = provider.primaryPersonAnchorForTesting else {
      return XCTFail("the provider must still accept a seed after the concurrent run")
    }
    XCTAssertEqual(Double(settled.x), 0.3, accuracy: 1e-9)
    XCTAssertEqual(Double(settled.y), 0.4, accuracy: 1e-9)
  }

  // MARK: - ApplePoseProvider: request lifecycle on an empty frame

  /// A frame with nobody in it must never produce a trusted pose, and a
  /// dropout must not disturb the temporal anchor — stickiness exists so the
  /// athlete is re-acquired after occlusion. Requests and handlers are created
  /// per call, so repeating the call on the same buffer also exercises that
  /// nothing is retained between frames.
  func testEmptyFrameNeverYieldsATrustedPoseAndPreservesTheAnchor() throws {
    #if targetEnvironment(simulator)
    throw XCTSkip(
      "Vision inference is asserted on macOS and device; the iOS Simulator is not a product inference surface."
    )
    #else
    let provider = ApplePoseProvider()
    provider.setPrimaryPersonSeed(x: 0.4, y: 0.6)
    let anchorBefore = try XCTUnwrap(provider.primaryPersonAnchorForTesting)

    let buffer = try makeBlankPixelBuffer(width: 256, height: 256)
    for timestampMs in stride(from: 0, through: 33 * 4, by: 33) {
      do {
        let pose = try provider.extractPose(pixelBuffer: buffer, timestampMs: timestampMs)
        XCTAssertLessThan(
          pose.confidence, TemporalStrokeDetector.Config().minPoseConfidence,
          "a blank frame must not yield a pose the detectors would trust"
        )
        XCTAssertEqual(pose.timestampMs, timestampMs)
      } catch VisionFailure.lowConfidence {
        // The documented outcome for a frame without a person.
      } catch {
        XCTFail("unexpected failure on a blank frame: \(error)")
      }
    }

    let anchorAfter = try XCTUnwrap(provider.primaryPersonAnchorForTesting)
    XCTAssertEqual(Double(anchorAfter.x), Double(anchorBefore.x), accuracy: 1e-9)
    XCTAssertEqual(Double(anchorAfter.y), Double(anchorBefore.y), accuracy: 1e-9)
    #endif
  }

  // MARK: - SessionMotionStream: non-monotonic camera timestamps

  func testSessionMotionStreamIgnoresRepeatedAndRegressedTimestamps() throws {
    let stream = SessionMotionStream()
    XCTAssertNil(stream.ingest(pose: wristPose(at: 0, rightWristX: 0.50)))
    // Repeated presentation timestamp: no interval, so no speed (and no
    // division by zero).
    XCTAssertNil(stream.ingest(pose: wristPose(at: 0, rightWristX: 0.60)))
    // Regressed timestamp: no speed either; the point becomes the reference.
    XCTAssertNil(stream.ingest(pose: wristPose(at: -40, rightWristX: 0.70)))
    // Forward again: measured against the last retained point (t = -40).
    let sample = try XCTUnwrap(stream.ingest(pose: wristPose(at: 60, rightWristX: 0.80)))
    XCTAssertEqual(sample.timestampMs, 60)
    XCTAssertTrue(sample.value.isFinite)
    XCTAssertEqual(sample.value, 1.0, accuracy: 1e-9)
  }

  // MARK: - TemporalStrokeDetector: non-monotonic frames inside the ready position

  /// A duplicated and a regressed frame inside the ready position must be
  /// ignored, not fabricated into motion: the drive that follows is detected
  /// with exactly the same window as on the clean stream.
  func testDuplicateAndRegressedFramesDoNotDisturbStrokeDetection() throws {
    let clean = poses(bodySpan: 0.5, path: ready(then: driveDeltas))
    var noisy = clean
    // After the frame at t = 200 (index 5): the same frame again, then one
    // stamped 30 ms in the past.
    let duplicate = clean[5]
    let regressed = fullBodyPose(at: clean[5].timestampMs - 30, bodySpan: 0.5)
    noisy.insert(contentsOf: [duplicate, regressed], at: 6)

    let cleanEvents = run(TemporalStrokeDetector(), clean)
    let noisyEvents = run(TemporalStrokeDetector(), noisy)

    XCTAssertEqual(cleanEvents.count, 1)
    XCTAssertEqual(noisyEvents.count, 1)
    let expected = try XCTUnwrap(cleanEvents.first)
    let observed = try XCTUnwrap(noisyEvents.first)
    XCTAssertEqual(observed.tMs, expected.tMs)
    XCTAssertEqual(observed.event.startMs, expected.event.startMs)
    XCTAssertEqual(observed.event.endMs, expected.event.endMs)
    XCTAssertEqual(observed.event.peakMotionMs, expected.event.peakMotionMs)
    XCTAssertEqual(observed.event.confidence, expected.event.confidence, accuracy: 1e-9)
    // Pin the documented window so the fixture cannot silently drift.
    XCTAssertEqual(expected.event.startMs, 400)
    XCTAssertEqual(expected.event.endMs, 840)
    XCTAssertEqual(expected.event.peakMotionMs, 480)
  }

  // MARK: - PoseMotionTrailBuffer: long session, unknown joints

  /// Twenty minutes of 30 fps frames, every frame also carrying an untracked
  /// joint and a never-repeating unknown joint name: storage must never exceed
  /// tracked joints × samples per joint, and must sit exactly at that bound in
  /// steady state.
  func testTrailBufferStaysBoundedAcrossALongSessionWithUnknownJoints() {
    let config = PoseMotionTrailBuffer.Config()
    var trails = PoseMotionTrailBuffer(config: config)
    let bound = config.trackedJoints.count * config.maximumSamplesPerJoint
    var peakStored = 0

    for frame in 0 ..< 36_000 {
      let timestampMs = frame * 33
      let phase = Double(frame % 60) / 60
      var landmarks = config.trackedJoints.map {
        PoseLandmark(name: $0, x: 0.2 + 0.6 * phase, y: 0.5, visibility: 0.9)
      }
      landmarks.append(PoseLandmark(name: "head", x: 0.5, y: 0.1, visibility: 0.9))
      landmarks.append(PoseLandmark(name: "unknown_\(frame)", x: 0.5, y: 0.5, visibility: 0.9))
      trails.ingest(landmarks: landmarks, timestampMs: timestampMs)
      peakStored = max(peakStored, trails.storedSampleCount)
    }

    XCTAssertLessThanOrEqual(peakStored, bound)
    XCTAssertEqual(trails.storedSampleCount, bound)
    let segments = trails.segments(at: 35_999 * 33)
    XCTAssertEqual(segments.count, config.trackedJoints.count * (config.maximumSamplesPerJoint - 1))
    XCTAssertTrue(segments.allSatisfy { config.trackedJoints.contains($0.joint) })
  }

  // MARK: - CaptureEvidenceAccumulator: retention over a long stream

  /// Ten minutes of alternating usable and missing attempts: only the
  /// retention window survives, and a summary over the whole session can see
  /// exactly that window — nothing older is silently kept.
  func testEvidenceAccumulatorKeepsOnlyTheRetentionWindowAcrossALongStream() throws {
    let retentionMs = 4_000
    let cadenceMs = 40
    let accumulator = CaptureEvidenceAccumulator(retentionMs: retentionMs)
    let frames = 15_000
    for frame in 0 ..< frames {
      let timestampMs = frame * cadenceMs
      if frame % 5 == 4 {
        accumulator.ingestMissing(timestampMs: timestampMs)
      } else {
        accumulator.ingest(pose: fullBodyPose(at: timestampMs, bodySpan: 0.5))
      }
    }
    let latestMs = (frames - 1) * cadenceMs
    let summary = try XCTUnwrap(
      accumulator.summary(
        startMs: 0,
        endMs: latestMs,
        poseSource: "fixture",
        poseModelVersion: "fixture-1",
        triggerAlgorithmVersion: "audit"
      )
    )
    // Attempts stamped ≥ latest − retention survive: retention / cadence + 1.
    XCTAssertEqual(summary.analysisInputFrameCount, retentionMs / cadenceMs + 1)
    XCTAssertEqual(summary.poseFrameCount + summary.poseMissingFrameCount, summary.analysisInputFrameCount)
    XCTAssertLessThanOrEqual(summary.trackedDurationMs, retentionMs)

    // Everything before the window is gone: a summary over it has no evidence.
    XCTAssertNil(
      accumulator.summary(
        startMs: 0,
        endMs: latestMs - retentionMs - cadenceMs,
        poseSource: "fixture",
        poseModelVersion: "fixture-1",
        triggerAlgorithmVersion: "audit"
      )
    )
  }

  // MARK: - Fixtures

  private let cadenceMs = 40
  private let readyFrames = 11
  private let driveDeltas: [Double] = [0.06, 0.08, 0.07, 0.06, 0.05, 0.04, 0.03, 0.016, 0.008, 0.004, 0.004]

  private func ready(then deltas: [Double]) -> [Double] {
    var offset = 0.0
    return Array(repeating: 0.0, count: readyFrames) + deltas.map { delta in
      offset += delta
      return offset
    }
  }

  private func run(_ detector: TemporalStrokeDetector, _ frames: [PoseFrame]) -> [(tMs: Int, event: StrokeEvent)] {
    var events: [(tMs: Int, event: StrokeEvent)] = []
    for frame in frames {
      if let event = detector.ingest(pose: frame, paddle: nil) {
        events.append((frame.timestampMs, event))
      }
    }
    return events
  }

  private func poses(bodySpan: Double, path: [Double]) -> [PoseFrame] {
    path.enumerated().map { index, offset in
      fullBodyPose(at: index * cadenceMs, bodySpan: bodySpan, wristOffset: offset)
    }
  }

  /// Same body template as `TemporalStrokeDetectorTests`: shoulder line at 0,
  /// ankles at 1 body-height, scaled by `bodySpan` and centred in the frame.
  private func fullBodyPose(at timestampMs: Int, bodySpan: Double, wristOffset: Double = 0) -> PoseFrame {
    let template: [(name: String, x: Double, y: Double)] = [
      ("left_shoulder", -0.12, 0.0), ("right_shoulder", 0.12, 0.0),
      ("left_elbow", -0.16, 0.22), ("right_elbow", 0.16, 0.22),
      ("left_wrist", -0.18, 0.42), ("right_wrist", 0.18 - wristOffset, 0.42),
      ("left_hip", -0.08, 0.42), ("right_hip", 0.08, 0.42),
      ("left_knee", -0.08, 0.72), ("right_knee", 0.08, 0.72),
      ("left_ankle", -0.09, 1.0), ("right_ankle", 0.09, 1.0),
    ]
    let shoulderY = 0.5 - bodySpan / 2
    return PoseFrame(
      timestampMs: timestampMs,
      landmarks: template.map { name, x, y in
        PoseLandmark(name: name, x: 0.5 + x * bodySpan, y: shoulderY + y * bodySpan, visibility: 0.95)
      },
      confidence: 0.95
    )
  }

  private func wristPose(at timestampMs: Int, rightWristX: Double) -> PoseFrame {
    PoseFrame(
      timestampMs: timestampMs,
      landmarks: [
        PoseLandmark(name: "right_wrist", x: rightWristX, y: 0.5, visibility: 0.9),
        PoseLandmark(name: "left_wrist", x: 0.30, y: 0.5, visibility: 0.9),
      ],
      confidence: 0.9
    )
  }

  private func makeBlankPixelBuffer(width: Int, height: Int) throws -> CVPixelBuffer {
    var buffer: CVPixelBuffer?
    let attributes: [CFString: Any] = [
      kCVPixelBufferCGImageCompatibilityKey: true,
      kCVPixelBufferCGBitmapContextCompatibilityKey: true,
    ]
    let status = CVPixelBufferCreate(
      kCFAllocatorDefault, width, height, kCVPixelFormatType_32BGRA, attributes as CFDictionary, &buffer
    )
    guard status == kCVReturnSuccess, let pixelBuffer = buffer else {
      throw VisionFailure.corruptedMedia("CVPixelBufferCreate failed: \(status)")
    }
    CVPixelBufferLockBaseAddress(pixelBuffer, [])
    if let base = CVPixelBufferGetBaseAddress(pixelBuffer) {
      memset(base, 0, CVPixelBufferGetBytesPerRow(pixelBuffer) * height)
    }
    CVPixelBufferUnlockBaseAddress(pixelBuffer, [])
    return pixelBuffer
  }
}
