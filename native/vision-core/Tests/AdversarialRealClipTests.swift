import AVFoundation
import CoreGraphics
import CoreMedia
import CoreVideo
import Foundation
import Vision
import XCTest

@testable import PickleVisionCore

/// Adversarial probes on COMMITTED real footage from datasets/ (all < 10 MB,
/// rights recorded in datasets/ood/registry.json and
/// datasets/pickleball/registry.json): a two-player squash rally (multi-person
/// primary selection), an empty court (no person), a 608x1080 portrait
/// pickleball highlight (upright portrait geometry + orientation overloads),
/// and the OOD derived corrupt / truncated / garbage / extreme-aspect probes.
/// Frames are sampled deterministically (stride + cap recorded per test) so
/// every number in the report is replayable.
final class AdversarialRealClipTests: XCTestCase {
  static let report = AdversarialReport(suite: "real-clips")

  enum Clip {
    static let squashTwoPlayers = "datasets/ood/negatives/yt-x8T5I4YAKNw-squash.mp4"
    static let emptyCourt = "datasets/ood/negatives/yt-zWQs7kTKcEY-emptycourt.mp4"
    static let portraitPickleball = "datasets/pickleball/fresh-candidates/va-O1dLhGGPErc.mp4"
    static let derivedCorruptBytes = "datasets/ood/derived/derived-corrupt-bytes.mp4"
    static let derivedTruncated = "datasets/ood/derived/derived-truncated.mp4"
    static let derivedGarbage = "datasets/ood/derived/derived-garbage.mp4"
    static let derivedExtremeTall = "datasets/ood/derived/derived-extreme-tall.mp4"
    static let derivedExtremeWide = "datasets/ood/derived/derived-extreme-wide.mp4"
    static let derivedStillVideo = "datasets/ood/derived/derived-still-image-video.mp4"
  }

  override class func tearDown() {
    report.flush()
    super.tearDown()
  }

  private func record(_ fields: [String: Any], function: String = #function) {
    Self.report.record(function, fields)
  }

  private func requireVision() throws {
    if case .failure(let error) = AdversarialSyntheticMediaTests.visionProbe {
      #if targetEnvironment(simulator)
      throw XCTSkip("Apple Vision body pose unavailable in this simulator process: \(error)")
      #else
      XCTFail("Apple Vision body pose failed on a plain 320x240 frame: \(error)")
      throw error
      #endif
    }
  }

  private func clipURL(_ relativePath: String) throws -> URL {
    let url = AdversarialSupport.repoFile(relativePath)
    guard AdversarialSupport.fileExists(url) else {
      record(["skipped": "missing committed clip", "path": relativePath], function: "clipURL")
      throw XCTSkip("committed clip missing from this checkout: \(relativePath)")
    }
    return url
  }

  @available(macOS 13.0, iOS 16.0, *)
  private func openOrRecordFailure(_ url: URL) async -> Result<UprightFrameReaderMirror, Error> {
    do {
      let reader = try await UprightFrameReaderMirror(url: url)
      return .success(reader)
    } catch {
      return .failure(error)
    }
  }

  // MARK: Two people

  /// Two squash players fill a 1280x720 frame. `extractAllPoses` must see
  /// both at least once across the sampled frames, and the single-primary
  /// `extractPose` must keep its landmarks and confidence within contract.
  /// Primary flip-flops (torso mid jumping > 0.25 between consecutive
  /// analyzed frames) are recorded — the anchor stickiness in
  /// ApplePoseProvider.primaryPerson exists to keep that number low.
  func testTwoPlayerRallyExposesBothPeopleAndKeepsThePrimaryWithinContract() async throws {
    guard #available(macOS 13.0, iOS 16.0, *) else { throw XCTSkip("reader mirror needs macOS 13 / iOS 16") }
    try requireVision()
    let url = try clipURL(Clip.squashTwoPlayers)
    let stride = 5
    let cap = 30
    let (reader, stats) = try await AdversarialExtraction.run(url: url, frameStride: stride, maxAnalyzedFrames: cap, includeTrajectories: false)
    record(["clip": Clip.squashTwoPlayers, "frameStride": stride, "maxAnalyzedFrames": cap, "geometry": reader.geometry, "stats": stats.json])
    XCTAssertEqual(stats.framesAnalyzed, cap, "the clip has 899 frames; \(cap) analyzed frames at stride \(stride) must be available")
    XCTAssertGreaterThanOrEqual(stats.maxPeopleInFrame, 2, "Apple Vision must report both players in at least one sampled frame; histogram \(stats.peopleHistogram)")
    XCTAssertGreaterThan(stats.framesWithPose, 0, "the primary-person path must lock onto someone")
    XCTAssertEqual(stats.poseErrorsOtherThanLowConfidence, 0, "unexpected error: \(stats.lastError ?? [:])")
    XCTAssertEqual(stats.landmarksNonFinite, 0, "the canonical pose-sequence parser rejects non-finite landmarks")
    XCTAssertEqual(stats.confidenceOutOfRange, 0)
    XCTAssertEqual(stats.timestampsNonMonotonic, 0)
  }

  /// With `maxPeople: 1` the research path must collapse to the single
  /// largest person and never exceed the cap on a two-player frame.
  func testMaxPeopleCapIsHonouredOnATwoPlayerFrame() async throws {
    guard #available(macOS 13.0, iOS 16.0, *) else { throw XCTSkip("reader mirror needs macOS 13 / iOS 16") }
    try requireVision()
    let url = try clipURL(Clip.squashTwoPlayers)
    let reader = try await UprightFrameReaderMirror(url: url)
    defer { reader.cancel() }
    let provider = ApplePoseProvider()
    var checked = 0
    var twoPeopleFrames = 0
    var capViolations = 0
    var emptyCapResults = 0
    var decoded = 0
    while let frame = reader.next(), checked < 12 {
      decoded += 1
      if decoded % 10 != 1 { continue }
      checked += 1
      let everyone = try provider.extractAllPoses(pixelBuffer: frame.buffer, timestampMs: frame.timestampMs, maxPeople: 6)
      if everyone.count >= 2 { twoPeopleFrames += 1 }
      let capped = try provider.extractAllPoses(pixelBuffer: frame.buffer, timestampMs: frame.timestampMs, maxPeople: 1)
      if capped.count > 1 { capViolations += 1 }
      let none = try provider.extractAllPoses(pixelBuffer: frame.buffer, timestampMs: frame.timestampMs, maxPeople: 0)
      if none.isEmpty { emptyCapResults += 1 }
      if let largest = everyone.first.flatMap(AdversarialExtraction.torsoMid), let only = capped.first.flatMap(AdversarialExtraction.torsoMid) {
        XCTAssertEqual(only.x, largest.x, accuracy: 0.05, "maxPeople: 1 must return the largest person (head of the uncapped list)")
        XCTAssertEqual(only.y, largest.y, accuracy: 0.05, "maxPeople: 1 must return the largest person (head of the uncapped list)")
      }
    }
    record(["clip": Clip.squashTwoPlayers, "framesChecked": checked, "decoded": decoded, "twoPeopleFrames": twoPeopleFrames, "capViolations": capViolations, "maxPeopleZeroEmpty": emptyCapResults])
    XCTAssertEqual(checked, 12)
    XCTAssertEqual(capViolations, 0)
    XCTAssertEqual(emptyCapResults, checked, "maxPeople: 0 must return an empty list")
  }

  // MARK: No person

  /// An empty court must not produce a CONFIDENT phantom pose: either
  /// `extractPose` misses, or whatever Vision hallucinates stays under the
  /// 0.5 confidence floor the stroke detector applies (TemporalStrokeDetector
  /// minPoseConfidence). A confident pose here would flow into analysis.
  func testEmptyCourtYieldsNoConfidentPose() async throws {
    guard #available(macOS 13.0, iOS 16.0, *) else { throw XCTSkip("reader mirror needs macOS 13 / iOS 16") }
    try requireVision()
    let url = try clipURL(Clip.emptyCourt)
    let stride = 10
    let cap = 24
    let (reader, stats) = try await AdversarialExtraction.run(url: url, frameStride: stride, maxAnalyzedFrames: cap, includeTrajectories: false)
    record(["clip": Clip.emptyCourt, "frameStride": stride, "maxAnalyzedFrames": cap, "geometry": reader.geometry, "stats": stats.json])
    XCTAssertEqual(stats.framesAnalyzed, cap)
    XCTAssertEqual(stats.poseErrorsOtherThanLowConfidence, 0, "unexpected error: \(stats.lastError ?? [:])")
    if stats.framesWithPose > 0 {
      XCTAssertLessThan(stats.maxPoseConfidence, 0.5, "an empty court produced a pose with confidence \(stats.maxPoseConfidence) on \(stats.framesWithPose)/\(cap) frames")
    }
    XCTAssertEqual(stats.landmarksNonFinite, 0)
  }

  // MARK: Portrait real footage + orientation overloads

  /// 608x1080 upright portrait footage with people: the reader must keep
  /// portrait geometry, `.up` must find poses within contract, and the
  /// rotated orientations must not crash — their outcomes are recorded.
  func testPortraitPickleballFootageKeepsPortraitGeometryAndYieldsPoses() async throws {
    guard #available(macOS 13.0, iOS 16.0, *) else { throw XCTSkip("reader mirror needs macOS 13 / iOS 16") }
    try requireVision()
    let url = try clipURL(Clip.portraitPickleball)
    let opened = await openOrRecordFailure(url)
    let reader: UprightFrameReaderMirror
    switch opened {
    case .failure(let error):
      record(["clip": Clip.portraitPickleball, "outcome": "reader rejected the AV1 clip", "error": AdversarialSupport.describe(error)])
      throw XCTSkip("AV1 clip not decodable on this platform: \(error)")
    case .success(let value):
      reader = value
    }
    defer { reader.cancel() }
    XCTAssertLessThan(reader.width, reader.height, "portrait footage must stay portrait after the upright transform: \(reader.geometry)")

    let provider = ApplePoseProvider()
    var decoded = 0
    var analyzed = 0
    var upPoses = 0
    var upOutOfRange = 0
    var upNonFinite = 0
    var orientationOutcomes: [String: [String: Int]] = [:]
    let rotated: [(String, CGImagePropertyOrientation)] = [("right", .right), ("left", .left), ("down", .down)]
    var firstBuffer: (Int, Int)?
    while let frame = reader.next(), analyzed < 20 {
      decoded += 1
      if decoded % 6 != 1 { continue }
      analyzed += 1
      if firstBuffer == nil { firstBuffer = (CVPixelBufferGetWidth(frame.buffer), CVPixelBufferGetHeight(frame.buffer)) }
      if let pose = try? provider.extractPose(pixelBuffer: frame.buffer, timestampMs: frame.timestampMs, orientation: .up) {
        upPoses += 1
        for landmark in pose.landmarks {
          if !landmark.x.isFinite || !landmark.y.isFinite {
            upNonFinite += 1
          } else if landmark.x < 0 || landmark.x > 1 || landmark.y < 0 || landmark.y > 1 {
            upOutOfRange += 1
          }
        }
      }
      for (name, orientation) in rotated {
        var outcome = orientationOutcomes[name] ?? ["pose": 0, "lowConfidence": 0, "otherError": 0]
        do {
          _ = try provider.extractPose(pixelBuffer: frame.buffer, timestampMs: frame.timestampMs, orientation: orientation)
          outcome["pose", default: 0] += 1
        } catch {
          if AdversarialSupport.isVisionFailureLowConfidence(error) { outcome["lowConfidence", default: 0] += 1 } else { outcome["otherError", default: 0] += 1 }
        }
        orientationOutcomes[name] = outcome
      }
    }
    let readerFailed = reader.reader.status == .failed
    record([
      "clip": Clip.portraitPickleball, "geometry": reader.geometry, "decoded": decoded, "analyzed": analyzed,
      "firstBufferWidth": firstBuffer?.0 ?? -1, "firstBufferHeight": firstBuffer?.1 ?? -1,
      "upPoses": upPoses, "upLandmarksOutOfRange": upOutOfRange, "upLandmarksNonFinite": upNonFinite, "rotatedOrientationOutcomes": orientationOutcomes,
      "readerStatus": reader.reader.status.rawValue, "readerError": AdversarialSupport.describeOrNull(reader.reader.error),
    ])
    if analyzed == 0 {
      throw XCTSkip("no frames decoded from the AV1 clip on this platform (reader failed: \(readerFailed))")
    }
    XCTAssertEqual(firstBuffer?.0, reader.width)
    XCTAssertEqual(firstBuffer?.1, reader.height)
    XCTAssertGreaterThan(upPoses, 0, "upright portrait footage with players must yield at least one pose in \(analyzed) frames")
    XCTAssertEqual(upNonFinite, 0, "landmarks must be finite")
    XCTAssertEqual(orientationOutcomes.values.reduce(0) { $0 + ($1["otherError"] ?? 0) }, 0, "rotated orientations must miss with lowConfidence, never another error: \(orientationOutcomes)")
  }

  // MARK: OOD derived probes (committed, deterministic recipes in datasets/ood/registry.json)

  func testDerivedCorruptAndGarbageProbesAreRejectedOrBounded() async throws {
    guard #available(macOS 13.0, iOS 16.0, *) else { throw XCTSkip("reader mirror needs macOS 13 / iOS 16") }
    for relativePath in [Clip.derivedCorruptBytes, Clip.derivedGarbage, Clip.derivedTruncated] {
      let url = try clipURL(relativePath)
      switch await openOrRecordFailure(url) {
      case .failure(let error):
        record(["clip": relativePath, "outcome": "rejected", "error": AdversarialSupport.describe(error)], function: "\(#function)[\(url.lastPathComponent)]")
      case .success(let reader):
        reader.cancel()
        let (reopened, stats) = try await AdversarialExtraction.run(url: url, frameStride: 8, maxAnalyzedFrames: 30, includeTrajectories: false)
        record(["clip": relativePath, "outcome": "decoded", "geometry": reopened.geometry, "readerStatus": reopened.reader.status.rawValue, "readerError": AdversarialSupport.describeOrNull(reopened.reader.error), "stats": stats.json], function: "\(#function)[\(url.lastPathComponent)]")
        XCTAssertEqual(stats.landmarksNonFinite, 0, relativePath)
        XCTAssertLessThan(stats.wallMs, 60_000, "\(relativePath) must not hang")
      }
    }
  }

  func testExtremeAspectAndStillVideoProbesStayWithinContract() async throws {
    guard #available(macOS 13.0, iOS 16.0, *) else { throw XCTSkip("reader mirror needs macOS 13 / iOS 16") }
    try requireVision()
    for relativePath in [Clip.derivedExtremeTall, Clip.derivedExtremeWide, Clip.derivedStillVideo] {
      let url = try clipURL(relativePath)
      let (reader, stats) = try await AdversarialExtraction.run(url: url, frameStride: 12, maxAnalyzedFrames: 10, includeTrajectories: true)
      record(["clip": relativePath, "geometry": reader.geometry, "stats": stats.json], function: "\(#function)[\(url.lastPathComponent)]")
      XCTAssertGreaterThan(stats.framesAnalyzed, 0, "\(relativePath) must decode")
      XCTAssertEqual(stats.landmarksNonFinite, 0, relativePath)
      XCTAssertEqual(stats.confidenceOutOfRange, 0, relativePath)
      XCTAssertEqual(stats.timestampsNonMonotonic, 0, relativePath)
    }
  }
}
