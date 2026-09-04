import AVFoundation
import CoreGraphics
import CoreMedia
import CoreVideo
import Foundation
import Vision
import XCTest

@testable import PickleVisionCore

/// Adversarial media probes for the native Apple Vision pipeline using only
/// fixtures rendered at runtime (no committed media): empty file, garbage
/// bytes, seeded byte corruption, truncation, a single-frame clip,
/// landscape / portrait / rotated-portrait tracks, person-free frames at
/// degenerate and huge resolutions, cancellation between frames, a Vision
/// request cancelled mid-perform, and concurrent callers on one provider.
///
/// Assertions cover hard contracts only (typed failures instead of crashes,
/// landmark ranges, geometry, cancellation stopping the loop); everything
/// else is recorded in the JSON report for the run artifacts.
final class AdversarialSyntheticMediaTests: XCTestCase {
  static let report = AdversarialReport(suite: "synthetic-media")
  static var scratch: URL = FileManager.default.temporaryDirectory

  /// One Vision probe per process on a plain 320x240 person-free frame. If
  /// the Vision body-pose network cannot run on this host, tests that need
  /// it are skipped with the recorded error rather than misreported.
  static let visionProbe: Result<Int, Error> = {
    do {
      let buffer = try AdversarialSupport.makeSceneBuffer(width: 320, height: 240)
      let people = try ApplePoseProvider().extractAllPoses(pixelBuffer: buffer, timestampMs: 0)
      return .success(people.count)
    } catch {
      return .failure(error)
    }
  }()

  override class func setUp() {
    super.setUp()
    if let directory = try? AdversarialSupport.makeScratchDirectory("synthetic") {
      scratch = directory
    }
    switch visionProbe {
    case .success(let count):
      report.record("visionProbe", ["ok": true, "peopleOn320x240Scene": count])
    case .failure(let error):
      report.record("visionProbe", ["ok": false, "error": AdversarialSupport.describe(error)])
    }
  }

  override class func tearDown() {
    report.flush()
    super.tearDown()
  }

  private func requireVision() throws {
    if case .failure(let error) = Self.visionProbe {
      #if targetEnvironment(simulator)
      throw XCTSkip("Apple Vision body pose unavailable in this simulator process: \(error)")
      #else
      XCTFail("Apple Vision body pose failed on a plain 320x240 frame: \(error)")
      throw error
      #endif
    }
  }

  private func record(_ fields: [String: Any], function: String = #function) {
    Self.report.record(function, fields)
  }

  @available(macOS 13.0, iOS 16.0, *)
  private func readerFailure(opening url: URL) async -> Error? {
    do {
      _ = try await UprightFrameReaderMirror(url: url)
      return nil
    } catch {
      return error
    }
  }

  private func baseClip(_ name: String, width: Int = 640, height: Int = 360, frames: Int = 48, fps: Int32 = 24, transform: CGAffineTransform = .identity) throws -> (AdversarialSupport.WrittenClip, AdversarialSupport.ClipSpec) {
    let spec = AdversarialSupport.ClipSpec(width: width, height: height, frames: frames, fps: fps, transform: transform)
    let clip = try AdversarialSupport.writeClip(spec, named: name, in: Self.scratch)
    return (clip, spec)
  }

  // MARK: Malformed containers

  func testEmptyFileIsRejectedWithATypedError() async throws {
    guard #available(macOS 13.0, iOS 16.0, *) else { throw XCTSkip("reader mirror needs macOS 13 / iOS 16") }
    let url = Self.scratch.appendingPathComponent("empty.mp4")
    let recipe = try AdversarialSupport.emptyFile(to: url)
    let error = await readerFailure(opening: url)
    record(["fixture": recipe, "rejected": error != nil, "error": AdversarialSupport.describeOrNull(error)])
    XCTAssertNotNil(error, "a zero-byte .mp4 must be rejected by the reader, not decoded as a clip")
  }

  func testGarbageBytesAreRejectedWithATypedError() async throws {
    guard #available(macOS 13.0, iOS 16.0, *) else { throw XCTSkip("reader mirror needs macOS 13 / iOS 16") }
    let url = Self.scratch.appendingPathComponent("garbage.mp4")
    let recipe = try AdversarialSupport.garbageFile(bytes: 65536, seed: 7, to: url)
    let error = await readerFailure(opening: url)
    record(["fixture": recipe, "rejected": error != nil, "error": AdversarialSupport.describeOrNull(error)])
    XCTAssertNotNil(error, "64 KiB of seeded random bytes must be rejected by the reader")
  }

  func testTruncatedClipIsRejectedOrDecodesABoundedPrefix() async throws {
    guard #available(macOS 13.0, iOS 16.0, *) else { throw XCTSkip("reader mirror needs macOS 13 / iOS 16") }
    let (clip, spec) = try baseClip("truncated-source")
    let url = Self.scratch.appendingPathComponent("truncated.mp4")
    let recipe = try AdversarialSupport.truncatedCopy(of: clip.url, keepFraction: 0.6, to: url)
    if let error = await readerFailure(opening: url) {
      record(["fixture": recipe, "source": spec.recipe, "codec": clip.codec, "outcome": "rejected", "error": AdversarialSupport.describe(error)])
      return
    }
    let (reader, stats) = try await AdversarialExtraction.run(url: url, includeTrajectories: false)
    record(["fixture": recipe, "source": spec.recipe, "codec": clip.codec, "outcome": "decoded", "readerStatus": reader.reader.status.rawValue, "readerError": AdversarialSupport.describeOrNull(reader.reader.error), "stats": stats.json])
    XCTAssertLessThanOrEqual(stats.framesDecoded, spec.frames, "a truncated clip cannot yield more frames than were encoded")
    XCTAssertEqual(stats.landmarksNonFinite, 0)
    XCTAssertEqual(stats.landmarksOutOfUnitRange, 0)
  }

  func testSeededByteCorruptionIsRejectedOrDecodesWithinContract() async throws {
    guard #available(macOS 13.0, iOS 16.0, *) else { throw XCTSkip("reader mirror needs macOS 13 / iOS 16") }
    let (clip, spec) = try baseClip("corrupt-source")
    let url = Self.scratch.appendingPathComponent("corrupt-seed42.mp4")
    let recipe = try AdversarialSupport.corruptedCopy(of: clip.url, seed: 42, fraction: 0.01, protectPrefix: 64, to: url)
    if let error = await readerFailure(opening: url) {
      record(["fixture": recipe, "source": spec.recipe, "codec": clip.codec, "outcome": "rejected", "error": AdversarialSupport.describe(error)])
      return
    }
    let started = Date()
    let (reader, stats) = try await AdversarialExtraction.run(url: url, includeTrajectories: false)
    let wallMs = Int(Date().timeIntervalSince(started) * 1000)
    record(["fixture": recipe, "source": spec.recipe, "codec": clip.codec, "outcome": "decoded", "readerStatus": reader.reader.status.rawValue, "readerError": AdversarialSupport.describeOrNull(reader.reader.error), "stats": stats.json, "wallMs": wallMs])
    XCTAssertLessThanOrEqual(stats.framesDecoded, spec.frames)
    XCTAssertEqual(stats.landmarksNonFinite, 0, "corrupted pixels must never leak non-finite landmarks")
    XCTAssertEqual(stats.landmarksOutOfUnitRange, 0, "landmarks must stay inside the unit square")
    XCTAssertEqual(stats.confidenceOutOfRange, 0)
    XCTAssertLessThan(wallMs, 60_000, "a 48-frame corrupted clip must not hang the reader")
  }

  // MARK: Clip geometry

  func testOneFrameClipYieldsExactlyOneFrameAndNoPose() async throws {
    guard #available(macOS 13.0, iOS 16.0, *) else { throw XCTSkip("reader mirror needs macOS 13 / iOS 16") }
    try requireVision()
    let (clip, spec) = try baseClip("one-frame", frames: 1, fps: 30)
    let (reader, stats) = try await AdversarialExtraction.run(url: clip.url)
    record(["fixture": spec.recipe, "codec": clip.codec, "bytes": clip.bytes, "geometry": reader.geometry, "stats": stats.json])
    XCTAssertEqual(stats.framesDecoded, 1, "a one-frame clip must decode exactly one frame")
    XCTAssertEqual(stats.framesAnalyzed, 1)
    XCTAssertEqual(stats.framesWithPose, 0, "the person-free frame must not produce a pose")
    XCTAssertEqual(stats.poseMisses, 1)
    XCTAssertEqual(stats.poseErrorsOtherThanLowConfidence, 0, "the only acceptable failure is VisionFailure.lowConfidence; got \(stats.lastError ?? [:])")
    XCTAssertEqual(reader.width, 640)
    XCTAssertEqual(reader.height, 360)
    XCTAssertGreaterThan(reader.durationMs, 0, "a one-frame clip still has a positive duration")
  }

  func testLandscapeAndPortraitClipsKeepTheirGeometry() async throws {
    guard #available(macOS 13.0, iOS 16.0, *) else { throw XCTSkip("reader mirror needs macOS 13 / iOS 16") }
    for (name, width, height) in [("landscape", 640, 360), ("portrait", 360, 640)] {
      let (clip, spec) = try baseClip(name, width: width, height: height, frames: 6)
      let reader = try await UprightFrameReaderMirror(url: clip.url)
      let frame = reader.next()
      record(["fixture": spec.recipe, "codec": clip.codec, "geometry": reader.geometry, "bufferWidth": frame.map { CVPixelBufferGetWidth($0.buffer) } ?? -1, "bufferHeight": frame.map { CVPixelBufferGetHeight($0.buffer) } ?? -1], function: "\(#function)[\(name)]")
      XCTAssertEqual(reader.width, width, "\(name) render width")
      XCTAssertEqual(reader.height, height, "\(name) render height")
      XCTAssertEqual(frame.map { CVPixelBufferGetWidth($0.buffer) }, width, "\(name) buffer width")
      XCTAssertEqual(frame.map { CVPixelBufferGetHeight($0.buffer) }, height, "\(name) buffer height")
      reader.cancel()
    }
  }

  /// A phone held upright records LANDSCAPE pixels with a 90° preferredTransform.
  /// The upright reader must hand Vision portrait pixels (360x640), otherwise
  /// `.up` landmarks would be rotated relative to the display space.
  func testRotatedPortraitTrackIsReadUpright() async throws {
    guard #available(macOS 13.0, iOS 16.0, *) else { throw XCTSkip("reader mirror needs macOS 13 / iOS 16") }
    let portraitTransform = CGAffineTransform(a: 0, b: 1, c: -1, d: 0, tx: 360, ty: 0)
    let (clip, spec) = try baseClip("rotated-portrait", width: 640, height: 360, frames: 6, transform: portraitTransform)
    let reader = try await UprightFrameReaderMirror(url: clip.url)
    let frame = reader.next()
    record(["fixture": spec.recipe, "codec": clip.codec, "geometry": reader.geometry, "bufferWidth": frame.map { CVPixelBufferGetWidth($0.buffer) } ?? -1, "bufferHeight": frame.map { CVPixelBufferGetHeight($0.buffer) } ?? -1])
    XCTAssertEqual(Double(reader.naturalSize.width), 640, "the encoded pixels are landscape")
    XCTAssertEqual(reader.width, 360, "render width must be the rotated (portrait) width")
    XCTAssertEqual(reader.height, 640, "render height must be the rotated (portrait) height")
    XCTAssertEqual(frame.map { CVPixelBufferGetWidth($0.buffer) }, 360)
    XCTAssertEqual(frame.map { CVPixelBufferGetHeight($0.buffer) }, 640)
    reader.cancel()
  }

  // MARK: Person-free frames

  func testPersonFreeFrameThrowsLowConfidenceAndReturnsNoPeople() throws {
    try requireVision()
    let provider = ApplePoseProvider()
    let buffer = try AdversarialSupport.makeSceneBuffer(width: 640, height: 360)
    var thrown: Error?
    do {
      _ = try provider.extractPose(pixelBuffer: buffer, timestampMs: 0)
    } catch {
      thrown = error
    }
    let everyone = try provider.extractAllPoses(pixelBuffer: buffer, timestampMs: 0)
    record(["extractPoseError": AdversarialSupport.describeOrNull(thrown), "extractAllPosesCount": everyone.count])
    XCTAssertNotNil(thrown, "extractPose must throw on a person-free frame")
    XCTAssertTrue(thrown.map(AdversarialSupport.isVisionFailureLowConfidence) ?? false, "expected VisionFailure.lowConfidence, got \(String(describing: thrown))")
    XCTAssertEqual(everyone.count, 0, "extractAllPoses must return no people on a person-free frame")
    XCTAssertNil(provider.primaryPersonAnchorForTesting, "a miss must not plant a primary-person anchor")
  }

  func testEveryOrientationOnAPersonFreeFrameThrowsLowConfidence() throws {
    try requireVision()
    let provider = ApplePoseProvider()
    let buffer = try AdversarialSupport.makeSceneBuffer(width: 640, height: 360)
    let orientations: [(String, CGImagePropertyOrientation)] = [
      ("up", .up), ("upMirrored", .upMirrored), ("down", .down), ("downMirrored", .downMirrored),
      ("left", .left), ("leftMirrored", .leftMirrored), ("right", .right), ("rightMirrored", .rightMirrored),
    ]
    var outcomes: [String: Any] = [:]
    for (name, orientation) in orientations {
      do {
        let pose = try provider.extractPose(pixelBuffer: buffer, timestampMs: 0, orientation: orientation)
        outcomes[name] = ["pose": true, "confidence": pose.confidence, "landmarks": pose.landmarks.count] as [String: Any]
        XCTFail("orientation \(name) produced a pose on a person-free frame")
      } catch {
        outcomes[name] = AdversarialSupport.describe(error)
        XCTAssertTrue(AdversarialSupport.isVisionFailureLowConfidence(error), "orientation \(name): expected lowConfidence, got \(error)")
      }
    }
    record(["outcomes": outcomes])
  }

  func testHugeResolutionPersonFreeFrameTerminatesWithinBudget() throws {
    try requireVision()
    let provider = ApplePoseProvider()
    let before = AdversarialSupport.residentMemoryBytes()
    let allocationStarted = Date()
    let buffer = try AdversarialSupport.makeSceneBuffer(width: 7680, height: 4320)
    let allocationMs = Int(Date().timeIntervalSince(allocationStarted) * 1000)
    let afterAllocation = AdversarialSupport.residentMemoryBytes()

    let singleStarted = Date()
    var singleError: Error?
    do { _ = try provider.extractPose(pixelBuffer: buffer, timestampMs: 0) } catch { singleError = error }
    let singleMs = Int(Date().timeIntervalSince(singleStarted) * 1000)

    let allStarted = Date()
    var allError: Error?
    var people = -1
    do { people = try provider.extractAllPoses(pixelBuffer: buffer, timestampMs: 0).count } catch { allError = error }
    let allMs = Int(Date().timeIntervalSince(allStarted) * 1000)
    let peak = AdversarialSupport.residentMemoryBytes()

    record([
      "frame": "7680x4320 BGRA person-free scene",
      "bufferBytes": CVPixelBufferGetBytesPerRow(buffer) * 4320,
      "allocationMs": allocationMs,
      "extractPoseMs": singleMs,
      "extractPoseError": AdversarialSupport.describeOrNull(singleError),
      "extractAllPosesMs": allMs,
      "extractAllPosesCount": people,
      "extractAllPosesError": AdversarialSupport.describeOrNull(allError),
      "residentBytesBefore": Int(before),
      "residentBytesAfterAllocation": Int(afterAllocation),
      "residentBytesPeak": Int(peak),
    ])
    XCTAssertNotNil(singleError, "a person-free 8K frame must not yield a pose")
    XCTAssertTrue(singleError.map(AdversarialSupport.isVisionFailureLowConfidence) ?? false, "8K extractPose: expected lowConfidence, got \(String(describing: singleError))")
    XCTAssertNil(allError, "8K extractAllPoses threw \(String(describing: allError))")
    XCTAssertEqual(people, 0)
    XCTAssertLessThan(singleMs, 30_000, "8K extractPose took \(singleMs) ms")
    XCTAssertLessThan(allMs, 30_000, "8K extractAllPoses took \(allMs) ms")
  }

  func testDegenerateFrameSizesNeverCrashTheProvider() throws {
    try requireVision()
    let provider = ApplePoseProvider()
    let sizes = [(1, 1), (2, 2), (8, 8), (16, 16), (64, 64), (4096, 16), (16, 4096), (1280, 72), (72, 1280), (3, 4095)]
    var outcomes: [[String: Any]] = []
    for (width, height) in sizes {
      var entry: [String: Any] = ["width": width, "height": height]
      do {
        let buffer = try AdversarialSupport.makeSceneBuffer(width: width, height: height)
        do {
          let pose = try provider.extractPose(pixelBuffer: buffer, timestampMs: 0)
          entry["extractPose"] = ["pose": true, "confidence": pose.confidence, "landmarks": pose.landmarks.count] as [String: Any]
        } catch {
          entry["extractPose"] = AdversarialSupport.describe(error)
          entry["extractPoseLowConfidence"] = AdversarialSupport.isVisionFailureLowConfidence(error)
        }
        do {
          entry["extractAllPoses"] = try provider.extractAllPoses(pixelBuffer: buffer, timestampMs: 0).count
        } catch {
          entry["extractAllPoses"] = AdversarialSupport.describe(error)
        }
      } catch {
        entry["bufferError"] = AdversarialSupport.describe(error)
      }
      outcomes.append(entry)
    }
    record(["outcomes": outcomes])
    XCTAssertEqual(outcomes.count, sizes.count)
    for entry in outcomes where entry["extractPose"] is [String: Any] {
      if let pose = entry["extractPose"] as? [String: Any], pose["pose"] as? Bool == true {
        XCTFail("a person-free \(entry["width"] as? Int ?? 0)x\(entry["height"] as? Int ?? 0) frame produced a pose")
      }
    }
  }

  // MARK: Cancellation

  func testCancelTokenStopsExtractionAtTheNextFrameBoundary() async throws {
    guard #available(macOS 13.0, iOS 16.0, *) else { throw XCTSkip("reader mirror needs macOS 13 / iOS 16") }
    try requireVision()
    let (clip, spec) = try baseClip("cancel-source", width: 320, height: 240, frames: 120, fps: 30)
    let token = AdversarialCancelToken()
    let started = Date()
    let (reader, stats) = try await AdversarialExtraction.run(url: clip.url, includeTrajectories: false, cancelToken: token) { analyzed in
      if analyzed == 3 { token.cancel() }
    }
    let wallMs = Int(Date().timeIntervalSince(started) * 1000)
    let afterCancel = reader.next()
    record(["fixture": spec.recipe, "codec": clip.codec, "stats": stats.json, "wallMs": wallMs, "readerStatusAfterCancel": reader.reader.status.rawValue, "nextAfterCancelIsNil": afterCancel == nil])
    XCTAssertEqual(stats.cancelledAfterFrames, 3, "cancellation must be honoured at the next frame boundary")
    XCTAssertEqual(stats.framesAnalyzed, 3, "no frame may be analyzed after the cancel")
    XCTAssertEqual(stats.framesDecoded, 4, "exactly one more frame is decoded to observe the cancel")
    XCTAssertEqual(reader.reader.status, .cancelled, "the AVAssetReader must be cancelled, not left reading")
    XCTAssertNil(afterCancel, "a cancelled reader must not hand out further frames")
    XCTAssertLessThan(stats.framesDecoded, spec.frames)
  }

  /// ApplePoseProvider exposes no cancellation; the only handle is Vision's
  /// own `VNRequest.cancel()`. Cancelling a body-pose request from another
  /// thread while `perform` runs must end in a thrown error or a completed
  /// request — never a crash or a hang.
  func testVisionRequestCancelledMidPerformEitherThrowsOrCompletes() throws {
    try requireVision()
    let buffer = try AdversarialSupport.makeSceneBuffer(width: 3840, height: 2160)
    var outcomes: [[String: Any]] = []
    for delayMicroseconds in [0, 500, 5_000] {
      let request = VNDetectHumanBodyPoseRequest()
      let handler = VNImageRequestHandler(cvPixelBuffer: buffer, orientation: .up, options: [:])
      let cancelled = DispatchSemaphore(value: 0)
      DispatchQueue.global(qos: .userInitiated).async {
        if delayMicroseconds > 0 { usleep(useconds_t(delayMicroseconds)) }
        request.cancel()
        cancelled.signal()
      }
      let started = Date()
      var entry: [String: Any] = ["cancelDelayMicroseconds": delayMicroseconds]
      do {
        try handler.perform([request])
        entry["outcome"] = "completed"
        entry["results"] = request.results?.count ?? 0
      } catch {
        entry["outcome"] = "threw"
        entry["error"] = AdversarialSupport.describe(error)
      }
      entry["performMs"] = Int(Date().timeIntervalSince(started) * 1000)
      XCTAssertEqual(cancelled.wait(timeout: .now() + 10), .success, "the cancelling thread must finish")
      outcomes.append(entry)
    }
    record(["frame": "3840x2160 person-free", "outcomes": outcomes])
    XCTAssertEqual(outcomes.count, 3)
  }

  // MARK: Concurrency

  /// The provider is `@unchecked Sendable` with a lock around the anchor;
  /// eight threads hammering both entry points on one instance must all get
  /// typed misses and leave no anchor behind.
  func testConcurrentCallersOnOneProviderGetTypedMisses() throws {
    try requireVision()
    let provider = ApplePoseProvider()
    let buffer = try AdversarialSupport.makeSceneBuffer(width: 640, height: 360)
    let tally = AdversarialTally()
    let iterations = 5
    let threads = 8
    DispatchQueue.concurrentPerform(iterations: threads * iterations) { index in
      do {
        _ = try provider.extractPose(pixelBuffer: buffer, timestampMs: index)
        tally.bump("unexpectedPoses")
      } catch {
        if AdversarialSupport.isVisionFailureLowConfidence(error) { tally.bump("lowConfidence") } else { tally.addError(error) }
      }
      do {
        let people = try provider.extractAllPoses(pixelBuffer: buffer, timestampMs: index)
        tally.bump("peopleTotal", by: people.count)
      } catch {
        tally.addError(error)
      }
    }
    let otherErrors = tally.recordedErrors
    record(["calls": threads * iterations, "lowConfidence": tally.count("lowConfidence"), "otherErrors": otherErrors, "unexpectedPoses": tally.count("unexpectedPoses"), "peopleTotal": tally.count("peopleTotal")])
    XCTAssertEqual(tally.count("lowConfidence"), threads * iterations, "every concurrent call must miss with lowConfidence; other errors: \(otherErrors)")
    XCTAssertEqual(tally.count("unexpectedPoses"), 0)
    XCTAssertEqual(tally.count("peopleTotal"), 0)
    XCTAssertEqual(otherErrors.count, 0)
    XCTAssertNil(provider.primaryPersonAnchorForTesting)
  }
}
