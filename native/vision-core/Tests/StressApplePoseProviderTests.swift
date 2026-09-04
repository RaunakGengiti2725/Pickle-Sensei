#if canImport(Vision)
import CoreGraphics
import CoreVideo
import Foundation
import ImageIO
import Vision
import XCTest

@testable import PickleVisionCore

/// Apple-runtime stress tests for ApplePoseProvider: degenerate / huge /
/// odd-format pixel buffers, concurrent extraction while the anchor is
/// mutated from another thread, rapid seed/reset cycles, and an allocation
/// loop. Only compiled where `Vision` exists (macOS / iOS Simulator); on the
/// Linux plane this file is authored but UNVERIFIED — its results exist only
/// in a Mac run.
///
/// Every assertion is a "must not crash / must stay well-formed" contract:
/// synthetic buffers contain no person, so extraction is expected to throw
/// `VisionFailure.lowConfidence` (or a Vision error for unsupported input),
/// never to trap, hang, or return landmarks outside the unit square.
final class StressApplePoseProviderTests: XCTestCase {
  private static let iterations = StressCampaign.iterations

  // MARK: - Buffers

  private func makeBuffer(width: Int, height: Int, format: OSType = kCVPixelFormatType_32BGRA, fill: UInt8 = 0) throws -> CVPixelBuffer {
    var buffer: CVPixelBuffer?
    let status = CVPixelBufferCreate(kCFAllocatorDefault, width, height, format, nil, &buffer)
    guard status == kCVReturnSuccess, let buffer else {
      throw XCTSkip("CVPixelBufferCreate(\(width)x\(height), \(format)) failed with \(status)")
    }
    CVPixelBufferLockBaseAddress(buffer, [])
    if let base = CVPixelBufferGetBaseAddress(buffer) {
      memset(base, Int32(fill), CVPixelBufferGetDataSize(buffer))
    }
    CVPixelBufferUnlockBaseAddress(buffer, [])
    return buffer
  }

  /// Every landmark of a frame Vision does return must be inside [0,1] with a
  /// finite visibility, and the frame confidence must be finite.
  private func checkFrame(_ frame: PoseFrame) -> [String] {
    var violations: [String] = []
    if !frame.confidence.isFinite { violations.append("confidence \(frame.confidence)") }
    if frame.landmarks.isEmpty { violations.append("frame without landmarks") }
    for landmark in frame.landmarks {
      if !(landmark.x.isFinite && landmark.y.isFinite && landmark.visibility.isFinite) {
        violations.append("non-finite landmark \(landmark.name)")
      }
      if landmark.x < -0.01 || landmark.x > 1.01 || landmark.y < -0.01 || landmark.y > 1.01 {
        violations.append("landmark \(landmark.name) outside unit square: \(landmark.x),\(landmark.y)")
      }
    }
    return violations
  }

  // MARK: - Empty / one-pixel / huge / odd-format buffers

  func testOnePixelBufferThrowsInsteadOfCrashing() throws {
    let provider = ApplePoseProvider()
    let buffer = try makeBuffer(width: 1, height: 1)
    XCTAssertThrowsError(try provider.extractPose(pixelBuffer: buffer, timestampMs: 0))
    XCTAssertNil(provider.primaryPersonAnchorForTesting, "a failed extraction must not move the anchor")
  }

  func testBlackFrameThrowsLowConfidenceAndLeavesAnchorUntouched() throws {
    let provider = ApplePoseProvider()
    provider.setPrimaryPersonSeed(x: 0.25, y: 0.70)
    let buffer = try makeBuffer(width: 640, height: 480)
    XCTAssertThrowsError(try provider.extractPose(pixelBuffer: buffer, timestampMs: 0)) { error in
      guard let failure = error as? VisionFailure, case .lowConfidence = failure else {
        return XCTFail("expected VisionFailure.lowConfidence for an empty scene, got \(error)")
      }
    }
    let anchor = provider.primaryPersonAnchorForTesting
    XCTAssertEqual(anchor.map { Double($0.x) } ?? -1, 0.25, accuracy: 1e-9)
    XCTAssertEqual(anchor.map { Double($0.y) } ?? -1, 0.30, accuracy: 1e-9)
  }

  func testHugeBufferCompletesWithoutCrashing() throws {
    let provider = ApplePoseProvider()
    let buffer = try makeBuffer(width: 4_096, height: 4_096, fill: 0x80)
    let started = Date()
    XCTAssertThrowsError(try provider.extractPose(pixelBuffer: buffer, timestampMs: 0, orientation: .right))
    XCTAssertLessThan(Date().timeIntervalSince(started), 30, "4096² extraction must not hang")
  }

  func testOddPixelFormatsNeverCrash() throws {
    let provider = ApplePoseProvider()
    let formats: [OSType] = [
      kCVPixelFormatType_OneComponent8,
      kCVPixelFormatType_420YpCbCr8BiPlanarFullRange,
      kCVPixelFormatType_32ARGB,
      kCVPixelFormatType_16Gray,
    ]
    for format in formats {
      let buffer: CVPixelBuffer
      do {
        buffer = try makeBuffer(width: 320, height: 240, format: format, fill: 0x40)
      } catch {
        continue // format not creatable on this OS — nothing to stress
      }
      // Vision either rejects the format (throws) or finds nobody (throws);
      // any returned frame must still be well-formed.
      do {
        let frame = try provider.extractPose(pixelBuffer: buffer, timestampMs: 0)
        XCTAssertEqual(checkFrame(frame), [], "format \(format)")
      } catch {
        // expected
      }
    }
  }

  func testAllOrientationsOnEmptySceneThrowWithoutCrashing() throws {
    let provider = ApplePoseProvider()
    let buffer = try makeBuffer(width: 480, height: 640, fill: 0xC0)
    let orientations: [CGImagePropertyOrientation] = [.up, .upMirrored, .down, .downMirrored, .left, .leftMirrored, .right, .rightMirrored]
    for orientation in orientations {
      XCTAssertThrowsError(try provider.extractPose(pixelBuffer: buffer, timestampMs: 0, orientation: orientation), "\(orientation)")
    }
  }

  // MARK: - Two people / observation selection

  func testPrimaryPersonWithNoObservationsIsNilWithAndWithoutAnchor() {
    XCTAssertNil(ApplePoseProvider.primaryPerson(in: []))
    XCTAssertNil(ApplePoseProvider.primaryPerson(in: [], anchor: CGPoint(x: 0.5, y: 0.5)))
    XCTAssertNil(ApplePoseProvider.primaryPerson(in: [], anchor: CGPoint(x: .nan, y: .nan)))
  }

  func testExtractAllPosesWithZeroPeopleCapReturnsEmpty() throws {
    let provider = ApplePoseProvider()
    let buffer = try makeBuffer(width: 320, height: 240)
    XCTAssertEqual(try provider.extractAllPoses(pixelBuffer: buffer, timestampMs: 0, maxPeople: 0).count, 0)
    XCTAssertEqual(try provider.extractAllPoses(pixelBuffer: buffer, timestampMs: 0, maxPeople: 1_000_000).count, 0)
  }

  // MARK: - Rapid start/stop: seed / reset cycles

  func testRapidSeedResetCyclesKeepAnchorConsistent() {
    StressCampaign.run("apple.seed-reset-cycles", campaignIndex: 51) { rng, seed in
      let provider = ApplePoseProvider()
      var violations: [String] = []
      for _ in 0 ..< 200 {
        if rng.chance(0.5) {
          let x = rng.double(in: -1 ... 2), y = rng.double(in: -1 ... 2)
          provider.setPrimaryPersonSeed(x: x, y: y)
          guard let anchor = provider.primaryPersonAnchorForTesting else {
            violations.append("anchor nil right after seed"); break
          }
          if abs(Double(anchor.x) - x) > 1e-12 || abs(Double(anchor.y) - (1 - y)) > 1e-12 {
            violations.append("anchor \(anchor) != seed (\(x), \(1 - y))"); break
          }
        } else {
          provider.resetPrimaryPersonAnchor()
          if provider.primaryPersonAnchorForTesting != nil { violations.append("anchor survives reset"); break }
        }
      }
      return violations
    }
  }

  // MARK: - Concurrency: extraction racing anchor mutation

  /// The vision queue extracts while the main thread seeds/resets the anchor
  /// (exactly the production interleaving described at
  /// ApplePoseProvider.setPrimaryPersonSeed). The class is `@unchecked
  /// Sendable` with an NSLock around `previousTorsoMid`; this hammers that
  /// lock from several threads. Any crash or non-finite anchor is a failure.
  func testConcurrentExtractionWhileSeedingAndResettingDoesNotCrash() throws {
    let provider = ApplePoseProvider()
    let buffer = try makeBuffer(width: 320, height: 240, fill: 0x60)
    let threads = 6
    let perThread = max(20, Self.iterations)
    let group = DispatchGroup()
    let violations = NSLock()
    var collected: [String] = []

    for threadIndex in 0 ..< threads {
      group.enter()
      DispatchQueue.global(qos: .userInitiated).async {
        defer { group.leave() }
        var rng = SeededRNG(seed: StressCampaign.baseSeed &+ UInt64(threadIndex))
        for _ in 0 ..< perThread {
          switch rng.int(in: 0 ... 3) {
          case 0:
            provider.setPrimaryPersonSeed(x: rng.double(in: 0 ... 1), y: rng.double(in: 0 ... 1))
          case 1:
            provider.resetPrimaryPersonAnchor()
          case 2:
            if let anchor = provider.primaryPersonAnchorForTesting, !(anchor.x.isFinite && anchor.y.isFinite) {
              violations.lock(); collected.append("non-finite anchor \(anchor)"); violations.unlock()
            }
          default:
            do {
              let frame = try provider.extractPose(pixelBuffer: buffer, timestampMs: rng.int(in: 0 ... 100_000))
              let problems = self.checkFrame(frame)
              if !problems.isEmpty { violations.lock(); collected.append(contentsOf: problems); violations.unlock() }
            } catch {
              // expected: no person in a flat buffer
            }
          }
        }
      }
    }
    XCTAssertEqual(group.wait(timeout: .now() + 120), .success, "concurrent campaign must finish")
    XCTAssertEqual(collected, [])
  }

  /// "Cancellation mid-extraction": the provider has no cancel API
  /// (`VisionFailure.cancelled` is never thrown anywhere in the package), so
  /// the only thing a caller can do is stop consuming results and reset the
  /// anchor. This verifies that resetting while extractions are in flight
  /// leaves the provider usable and the anchor nil once everything drains.
  func testResetDuringInFlightExtractionsLeavesProviderUsable() throws {
    let provider = ApplePoseProvider()
    let buffer = try makeBuffer(width: 640, height: 480, fill: 0x20)
    let group = DispatchGroup()
    for _ in 0 ..< 8 {
      group.enter()
      DispatchQueue.global().async {
        defer { group.leave() }
        for t in 0 ..< max(5, Self.iterations / 4) {
          _ = try? provider.extractPose(pixelBuffer: buffer, timestampMs: t)
        }
      }
    }
    for _ in 0 ..< 50 {
      provider.setPrimaryPersonSeed(x: 0.5, y: 0.5)
      provider.resetPrimaryPersonAnchor()
    }
    XCTAssertEqual(group.wait(timeout: .now() + 120), .success)
    provider.resetPrimaryPersonAnchor()
    XCTAssertNil(provider.primaryPersonAnchorForTesting)
    XCTAssertThrowsError(try provider.extractPose(pixelBuffer: buffer, timestampMs: 1))
  }

  // MARK: - Memory pressure loop

  /// Allocates a fresh pixel buffer per iteration inside an autoreleasepool
  /// (the imported-video path's shape) and extracts from it. Vision must not
  /// retain the buffers: the loop must finish and the provider must stay
  /// responsive. Iteration count follows STRESS_ITER.
  func testAllocationLoopStaysResponsive() throws {
    let provider = ApplePoseProvider()
    let iterations = max(10, Self.iterations)
    var rng = SeededRNG(seed: StressCampaign.baseSeed &+ 61)
    let started = Date()
    for index in 0 ..< iterations {
      try autoreleasepool {
        let size = rng.pick([(64, 64), (320, 240), (1_280, 720), (1_920, 1_080)])
        let buffer = try makeBuffer(width: size.0, height: size.1, fill: UInt8(truncatingIfNeeded: rng.next()))
        _ = try? provider.extractPose(pixelBuffer: buffer, timestampMs: index * 33)
      }
    }
    let elapsed = Date().timeIntervalSince(started)
    XCTAssertLessThan(elapsed / Double(iterations), 2.0, "mean extraction latency per synthetic frame")
    XCTAssertThrowsError(try provider.extractPose(pixelBuffer: try makeBuffer(width: 320, height: 240), timestampMs: 0))
  }
}
#endif
