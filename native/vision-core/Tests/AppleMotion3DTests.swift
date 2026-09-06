import AVFoundation
import CryptoKit
import ImageIO
import Vision
import XCTest
import simd

@testable import PickleVisionCore

final class AppleMotion3DTests: XCTestCase {
  private var directory: URL!

  override func setUpWithError() throws {
    directory = FileManager.default.temporaryDirectory.resolvingSymlinksInPath()
      .appendingPathComponent("motion3d-software-tests-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
  }

  override func tearDownWithError() throws {
    if let directory { try FileManager.default.removeItem(at: directory) }
    directory = nil
  }

  func testJointNamesExactlyMatchTheSeventeenJointContract() throws {
    let expected = [
      "root", "spine", "center_shoulder", "center_head", "top_head",
      "left_shoulder", "left_elbow", "left_wrist", "right_shoulder", "right_elbow", "right_wrist",
      "left_hip", "left_knee", "left_ankle", "right_hip", "right_knee", "right_ankle",
    ]
    XCTAssertEqual(Motion3DJointName.allCases.map(\.rawValue), expected)
    if #available(macOS 14.0, iOS 17.0, *) {
      XCTAssertEqual(ApplePose3DProvider.jointMap.map { $0.1.rawValue }, expected)
      XCTAssertEqual(Set(ApplePose3DProvider.jointMap.map { $0.0 }).count, 17)
      XCTAssertNil(ApplePose3DProvider.jointMap.first { $0.1 == .topHead }?.2)
    }
  }

  func testProjectionUsesRawMatrixTranslationAndFlipsOnlyImageY() throws {
    var position = simd_float4x4(diagonal: SIMD4<Float>(2, 3, 4, 1))
    position.columns.3 = SIMD4<Float>(-0.25, 0.5, 0.75, 1)
    let joint = try XCTUnwrap(Motion3DJoint.projected(
      name: .leftShoulder, position: position, imagePoint: CGPoint(x: 0.2, y: 0.7), visibility2D: 0.81
    ))
    XCTAssertEqual(joint.x, -0.25)
    XCTAssertEqual(joint.y, 0.5)
    XCTAssertEqual(joint.z, 0.75)
    XCTAssertEqual(joint.imageX, 0.2)
    XCTAssertEqual(joint.imageY, 0.3, accuracy: 1e-12)
    XCTAssertEqual(joint.visibility2D, 0.81)
    let json = try object(joint)
    XCTAssertEqual(Set(json.keys), Set(["name", "x", "y", "z", "imageX", "imageY", "confidence", "visibility2D"]))
    XCTAssertTrue(json["confidence"] is NSNull)
    XCTAssertEqual(json["visibility2D"] as? Double, 0.81)
  }

  func testProjectionDoesNotClampOrFabricateUnavailablePoints() throws {
    let position = matrix_identity_float4x4
    for image in [nil, CGPoint(x: -0.1, y: 0.5), CGPoint(x: 0.5, y: 1.1), CGPoint(x: .nan, y: 0.5)] {
      XCTAssertNil(Motion3DJoint.projected(name: .root, position: position, imagePoint: image, visibility2D: 1))
    }
    for value in [Float.nan, .infinity, -.infinity, 101, -101] {
      var invalid = position
      invalid.columns.3.z = value
      XCTAssertNil(Motion3DJoint.projected(
        name: .root, position: invalid, imagePoint: CGPoint(x: 0.5, y: 0.5), visibility2D: 1
      ))
    }
    for visibility in [nil, Double.nan, .infinity, -0.1, 1.1] {
      let joint = try XCTUnwrap(Motion3DJoint.projected(
        name: .root, position: position, imagePoint: CGPoint(x: 0, y: 1), visibility2D: visibility
      ))
      XCTAssertEqual(joint.imageX, 0)
      XCTAssertEqual(joint.imageY, 0)
      XCTAssertNil(joint.visibility2D)
      XCTAssertTrue(try object(joint)["visibility2D"] is NSNull)
      XCTAssertTrue(try object(joint)["confidence"] is NSNull)
    }
  }

  func testReferenceHeightRemainsUncalibratedAndMeasuredHeightIsNotRelabelled() throws {
    let reference = try XCTUnwrap(Motion3DHeight.validated(meters: Double(Float(1.8)), source: .reference))
    XCTAssertEqual(reference.meters, Double(Float(1.8)))
    XCTAssertEqual(try object(reference)["source"] as? String, "reference")
    XCTAssertNil(Motion3DHeight.validated(meters: 1.7, source: .reference))
    XCTAssertNil(Motion3DHeight.validated(meters: .nan, source: .measured))
    XCTAssertNil(Motion3DHeight.validated(meters: 0, source: .measured))
    let measured = try XCTUnwrap(Motion3DHeight.validated(meters: 1.67, source: .measured))
    XCTAssertEqual(measured.meters, 1.67)
    XCTAssertEqual(try object(measured)["source"] as? String, "measured")
  }

  func testSameFramePersonGuardDoesNotRun3DForZeroOrMultiplePeople() {
    var estimates = 0
    for people in [[], [1, 2], [1, 2, 3]] {
      let sample = Motion3DSinglePersonGuard.evaluate(people: people) { _ in
        estimates += 1
        return self.softwareEstimate()
      }
      XCTAssertEqual(sample.status, people.isEmpty ? .noPerson : .multiplePeople)
      XCTAssertTrue(sample.joints.isEmpty)
      XCTAssertNil(sample.observationConfidence)
      XCTAssertNil(sample.height)
      XCTAssertNil(sample.cameraOriginMatrix)
    }
    XCTAssertEqual(estimates, 0)
    let single = Motion3DSinglePersonGuard.evaluate(people: [42]) { person in
      XCTAssertEqual(person, 42)
      estimates += 1
      return self.softwareEstimate()
    }
    XCTAssertEqual(single.status, .estimated)
    XCTAssertEqual(estimates, 1)
  }

  func testMissingFramesEncodeEveryRequiredNullAndNoJoints() throws {
    for status in [Motion3DFrameStatus.noPerson, .multiplePeople, .unavailable] {
      let frame = Motion3DFrame(
        stamp: Motion3DFrameStamp(frameIndex: 4, pts: CMTime(value: 4001, timescale: 30_000)),
        segmentId: 2, sample: .missing(status)
      )
      let json = try object(frame)
      XCTAssertEqual(Set(json.keys), Set([
        "frameIndex", "timestampMs", "ptsValue", "ptsTimescale", "segmentId", "status",
        "observationConfidence", "height", "cameraOriginMatrix", "joints",
      ]))
      XCTAssertEqual(json["status"] as? String, status.rawValue)
      for key in ["observationConfidence", "height", "cameraOriginMatrix"] { XCTAssertTrue(json[key] is NSNull) }
      XCTAssertEqual((json["joints"] as? [Any])?.count, 0)
      XCTAssertEqual(json["ptsValue"] as? Int64, 4001)
      XCTAssertEqual(json["ptsTimescale"] as? Int32, 30_000)
    }
    XCTAssertEqual(Motion3DObservationSample.missing(.estimated).status, .unavailable)
  }

  func testSamplingCountsAllDecodedFramesAndPreservesOriginalPTS() throws {
    var timeline = Motion3DSamplingTimeline()
    var stamps: [Motion3DFrameStamp] = []
    for index in 0..<120 {
      let pts = CMTime(value: Int64(index * 1500 + 1), timescale: 90_000)
      if let stamp = try timeline.consume(pts: pts, durationMs: 2000) { stamps.append(stamp) }
    }
    XCTAssertEqual(timeline.decodedFrames, 120)
    XCTAssertEqual(timeline.sampledFrames, 60)
    XCTAssertEqual(stamps.map(\.frameIndex), Array(stride(from: 0, to: 120, by: 2)))
    for stamp in stamps {
      XCTAssertEqual(stamp.pts.value, Int64(stamp.frameIndex * 1500 + 1))
      XCTAssertEqual(stamp.pts.timescale, 90_000)
      XCTAssertEqual(stamp.timestampMs, Double(stamp.pts.value) * 1000 / 90_000)
    }
  }

  func testVariableFrameRatesKeepOriginalTimescalesInsteadOfResampling() throws {
    var timeline = Motion3DSamplingTimeline()
    let pts = [
      CMTime(value: 101, timescale: 1000),
      CMTime(value: 102_000, timescale: 1_000_000),
      CMTime(value: 4099, timescale: 30_000),
      CMTime(value: 173_123, timescale: 1_000_000),
    ]
    let stamps = try pts.compactMap { try timeline.consume(pts: $0, durationMs: 1000) }
    XCTAssertEqual(stamps.map(\.frameIndex), [0, 2, 3])
    XCTAssertEqual(stamps.map { $0.pts.value }, [101, 4099, 173_123])
    XCTAssertEqual(stamps.map { $0.pts.timescale }, [1000, 30_000, 1_000_000])
    XCTAssertEqual(stamps[0].timestampMs, 101)
  }

  func testRateLimitUsesExactRationalComparisonEvenWithWideProducts() throws {
    var timeline = Motion3DSamplingTimeline()
    XCTAssertNotNil(try timeline.consume(pts: CMTime(value: 50_000_000_000, timescale: 1_000_000_000), durationMs: 60_000))
    let below = CMTime(value: 50 * 999_999_999 + 33_333_333, timescale: 999_999_999)
    XCTAssertNil(try timeline.consume(pts: below, durationMs: 60_000))
    let above = CMTime(value: below.value + 1, timescale: below.timescale)
    let stamp = try XCTUnwrap(timeline.consume(pts: above, durationMs: 60_000))
    XCTAssertEqual(stamp.frameIndex, 2)
    XCTAssertEqual(stamp.pts.value, above.value)
    XCTAssertEqual(stamp.pts.timescale, above.timescale)
  }

  func testInvalidUnsafeOrNonzeroEpochPTSIsRejectedWithoutRebasing() {
    let invalid = [
      CMTime.invalid, .indefinite, .positiveInfinity, .negativeInfinity,
      CMTime(value: -1, timescale: 30), CMTime(value: 1, timescale: 0),
      CMTime(value: 1, timescale: 1_000_000_001),
      CMTime(value: 1, timescale: 30, flags: .valid, epoch: 1),
      CMTime(value: 1, timescale: 30, flags: .valid, epoch: -1),
      CMTime(value: 9_007_199_254_740_992, timescale: 1_000_000_000),
      CMTime(value: Int64.max, timescale: 1_000_000_000),
      CMTime(value: 1001, timescale: 1000),
    ]
    for pts in invalid {
      var timeline = Motion3DSamplingTimeline()
      assertFailure(.invalidSource) { try timeline.consume(pts: pts, durationMs: 1000) }
    }
  }

  func testDuplicateAndReorderedPTSFailEvenOnOtherwiseSkippedFrames() throws {
    for pts in [CMTime(value: 1, timescale: 60), CMTime.zero] {
      var timeline = Motion3DSamplingTimeline()
      _ = try timeline.consume(pts: .zero, durationMs: 1000)
      XCTAssertNil(try timeline.consume(pts: CMTime(value: 1, timescale: 60), durationMs: 1000))
      assertFailure(.invalidSource) { try timeline.consume(pts: pts, durationMs: 1000) }
    }
  }

  func testDurationOutputCountAndDecodedCountBoundsAreExplicit() throws {
    XCTAssertEqual(Motion3DLimits.maxDurationMs, 60_000)
    XCTAssertEqual(Motion3DLimits.maxVideoBytes, 512 * 1024 * 1024)
    XCTAssertEqual(Motion3DLimits.maxFrames, 1800)
    XCTAssertEqual(Motion3DLimits.maxJSONBytes, 8 * 1024 * 1024)
    XCTAssertEqual(Motion3DLimits.maxSampleRate, 30)
    XCTAssertLessThan(Motion3DLimits.maxWallTimeSeconds, 90)
    for duration in [0, Double.nan, .infinity, 60_000.01] {
      var timeline = Motion3DSamplingTimeline()
      assertFailure(.invalidSource) { try timeline.consume(pts: .zero, durationMs: duration) }
    }
    var output = Motion3DSamplingTimeline()
    for index in 0..<1800 {
      XCTAssertNotNil(try output.consume(pts: CMTime(value: Int64(index), timescale: 30), durationMs: 60_000))
    }
    assertFailure(.exceedsLimits) { try output.consume(pts: CMTime(value: 1800, timescale: 30), durationMs: 60_000) }
    var decoded = Motion3DSamplingTimeline()
    for index in 0..<Motion3DLimits.maxDecodedFrames {
      _ = try decoded.consume(pts: CMTime(value: Int64(index), timescale: 1_000_000), durationMs: 1000)
    }
    assertFailure(.exceedsLimits) {
      try decoded.consume(pts: CMTime(value: Int64(Motion3DLimits.maxDecodedFrames), timescale: 1_000_000), durationMs: 1000)
    }
  }

  func testSegmentsResetAfterMissingObservationsAndDoNotClaimCrossRecordingIdentity() {
    var segments = Motion3DSegments()
    let statuses: [Motion3DFrameStatus] = [.estimated, .noPerson, .multiplePeople, .unavailable, .estimated, .estimated, .noPerson, .estimated]
    XCTAssertEqual(statuses.map { segments.consume($0) }, [0, 0, 0, 0, 1, 1, 1, 2])
    segments.breakContinuity()
    XCTAssertEqual(segments.consume(.estimated), 3)
    var nextRecording = Motion3DSegments()
    XCTAssertEqual(nextRecording.consume(.estimated), 0)
  }

  func testTimestampGapsBreakContinuityWithoutInventingFrames() throws {
    var timeline = Motion3DSamplingTimeline()
    let first = try XCTUnwrap(timeline.consume(pts: .zero, durationMs: 2000))
    let second = try XCTUnwrap(timeline.consume(pts: CMTime(value: 1, timescale: 30), durationMs: 2000))
    let afterGap = try XCTUnwrap(timeline.consume(pts: CMTime(value: 1, timescale: 1), durationMs: 2000))
    XCTAssertFalse(first.resetsContinuity)
    XCTAssertFalse(second.resetsContinuity)
    XCTAssertTrue(afterGap.resetsContinuity)
    XCTAssertEqual(afterGap.frameIndex, 2)
    XCTAssertEqual(afterGap.timestampMs, 1000)
    XCTAssertEqual(timeline.sampledFrames, 3)
  }

  func testProviderRetainsStatefulRevisionOneRequestUntilExplicitReset() throws {
    guard #available(macOS 14.0, iOS 17.0, *) else { throw XCTSkip("Vision 3D requires iOS 17 or macOS 14.") }
    let provider = ApplePose3DProvider()
    let request = provider.request3D
    XCTAssertTrue(provider.request3D === request)
    XCTAssertTrue((request as VNRequest) is VNStatefulRequest)
    XCTAssertEqual(request.revision, VNDetectHumanBodyPose3DRequestRevision1)
    provider.reset()
    XCTAssertFalse(provider.request3D === request)
    XCTAssertEqual(provider.request3D.revision, VNDetectHumanBodyPose3DRequestRevision1)
    XCTAssertFalse(ApplePose3DProvider().request3D === provider.request3D)
  }

  func testAllEightEncodedOrientationsAndDisplayDimensionsArePreserved() throws {
    let cases: [(CGAffineTransform, CGImagePropertyOrientation, Int, Int)] = [
      (.identity, .up, 640, 480),
      (CGAffineTransform(a: -1, b: 0, c: 0, d: 1, tx: 640, ty: 0), .upMirrored, 640, 480),
      (CGAffineTransform(a: -1, b: 0, c: 0, d: -1, tx: 640, ty: 480), .down, 640, 480),
      (CGAffineTransform(a: 1, b: 0, c: 0, d: -1, tx: 0, ty: 480), .downMirrored, 640, 480),
      (CGAffineTransform(a: 0, b: 1, c: 1, d: 0, tx: 0, ty: 0), .leftMirrored, 480, 640),
      (CGAffineTransform(a: 0, b: 1, c: -1, d: 0, tx: 480, ty: 0), .right, 480, 640),
      (CGAffineTransform(a: 0, b: -1, c: -1, d: 0, tx: 480, ty: 640), .rightMirrored, 480, 640),
      (CGAffineTransform(a: 0, b: -1, c: 1, d: 0, tx: 0, ty: 640), .left, 480, 640),
    ]
    for (transform, orientation, width, height) in cases {
      XCTAssertEqual(try Motion3DTrackGeometry.orientation(for: transform), orientation)
      let size = try Motion3DTrackGeometry.dimensions(naturalSize: CGSize(width: 640, height: 480), transform: transform)
      XCTAssertEqual(size.width, width)
      XCTAssertEqual(size.height, height)
    }
  }

  func testUnsupportedAffineTransformsAndInvalidDimensionsFailInsteadOfGuessing() {
    for transform in [
      CGAffineTransform(scaleX: 2, y: 2), CGAffineTransform(rotationAngle: 0.2),
      CGAffineTransform(a: 1, b: 0.1, c: 0, d: 1, tx: 0, ty: 0),
      CGAffineTransform(translationX: .infinity, y: 0),
    ] {
      assertFailure(.invalidSource) { try Motion3DTrackGeometry.orientation(for: transform) }
    }
    for size in [CGSize.zero, CGSize(width: 8193, height: 480), CGSize(width: 640.1, height: 480), CGSize(width: CGFloat.nan, height: 480)] {
      assertFailure(.invalidSource) { try Motion3DTrackGeometry.dimensions(naturalSize: size, transform: .identity) }
    }
  }

  func testCancellationIsIdempotentReentrantAndRemovesHandlers() throws {
    let cancellation = Motion3DCancellation()
    var calls = 0
    let removed = try cancellation.onCancel { XCTFail("Removed handler must not run.") }
    cancellation.removeHandler(removed)
    _ = try cancellation.onCancel {
      calls += 1
      XCTAssertTrue(cancellation.isCancelled)
      self.assertFailure(.cancelled) { try cancellation.check() }
    }
    cancellation.cancel()
    cancellation.cancel()
    XCTAssertEqual(calls, 1)
    assertFailure(.cancelled) { try cancellation.check() }
    assertFailure(.cancelled) { try cancellation.onCancel { calls += 1 } }
    XCTAssertEqual(calls, 2)
  }

  func testWallClockDeadlineCancelsBlockedWorkAndRetainsTimeoutReason() throws {
    let cancellation = Motion3DCancellation(timeoutSeconds: 0.02)
    let cancelled = expectation(description: "Native deadline invokes cancellation without a frame polling it.")
    _ = try cancellation.onCancel { cancelled.fulfill() }
    wait(for: [cancelled], timeout: 1)
    cancellation.cancel()
    assertFailure(.timeout) { try cancellation.check() }
    let immediate = Motion3DCancellation(timeoutSeconds: 0)
    assertFailure(.timeout) { try immediate.check() }
  }

  func testExclusiveGateDoesNotReleaseAnotherJob() throws {
    let gate = Motion3DExclusiveGate()
    let job = try gate.acquire()
    assertFailure(.busy) { try gate.acquire() }
    gate.release(UUID())
    assertFailure(.busy) { try gate.acquire() }
    gate.release(job)
    let next = try gate.acquire()
    XCTAssertNotEqual(job, next)
    gate.release(job)
    assertFailure(.busy) { try gate.acquire() }
    gate.release(next)
  }

  func testProgressNeverExceedsTenHertzAndIgnoresClockRegression() {
    var throttle = Motion3DProgressThrottle()
    XCTAssertTrue(throttle.shouldEmit(at: 0))
    XCTAssertFalse(throttle.shouldEmit(at: 99_999_999))
    XCTAssertTrue(throttle.shouldEmit(at: 100_000_000))
    XCTAssertFalse(throttle.shouldEmit(at: 99_999_999))
    XCTAssertFalse(throttle.shouldEmit(at: 199_999_999))
    XCTAssertTrue(throttle.shouldEmit(at: 200_000_000))
  }

  func testIdentifiersAndStoredURIsAreStrictlyLocalAndBounded() {
    for id in ["a", "capture-12_3.4:run", String(repeating: "a", count: 128)] { XCTAssertTrue(Motion3DLimits.validIdentifier(id)) }
    for id in ["", "../recording", "a b", "é", String(repeating: "a", count: 129)] { XCTAssertFalse(Motion3DLimits.validIdentifier(id)) }
    for uri in ["file:///private/Captures/movie.mov", "file://localhost/private/Captures/movie.mov"] { XCTAssertTrue(Motion3DLimits.validStoredURI(uri)) }
    for uri in [
      "", "/private/Captures/movie.mov", "file:movie.mov", "https://example.invalid/movie.mov",
      "file://remote.invalid/Captures/movie.mov", "file://user@localhost/Captures/movie.mov",
      "file://localhost:80/Captures/movie.mov", "file:///Captures/movie.mov?x=1",
      "file:///Captures/movie.mov#fragment", "file:///Captures/%00.mov",
      "file:///" + String(repeating: "a", count: 4096),
    ] { XCTAssertFalse(Motion3DLimits.validStoredURI(uri), uri) }
  }

  func testCaptureResolutionRelocatesBeforeRestrictingToTodaysPrivateDirectory() throws {
    let root = directory.appendingPathComponent("Captures", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    let video = root.appendingPathComponent("movie.mov")
    try Data("software-only".utf8).write(to: video)
    let stored = "file:///old-container/Library/Application%20Support/PickleSensei/Captures/movie.mov"
    var resolutions = 0
    let actual = try Motion3DSourceSecurity.resolve(storedURI: stored, capturesDirectory: root) { uri in
      XCTAssertEqual(uri, stored)
      resolutions += 1
      return video
    }
    XCTAssertEqual(actual, video)
    XCTAssertEqual(resolutions, 1)
    assertFailure(.invalidSource) {
      try Motion3DSourceSecurity.resolve(storedURI: "https://example.invalid/movie.mov", capturesDirectory: root) { _ in
        XCTFail("Remote input must never reach the relocation helper.")
        return video
      }
    }
  }

  func testCaptureResolutionRejectsTraversalSiblingDirectoriesAndSymlinkEscapes() throws {
    let root = directory.appendingPathComponent("Captures", isDirectory: true)
    let sibling = directory.appendingPathComponent("Captures-other", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    try FileManager.default.createDirectory(at: sibling, withIntermediateDirectories: true)
    let outside = sibling.appendingPathComponent("movie.mov")
    try Data("software-only".utf8).write(to: outside)
    let link = root.appendingPathComponent("escape.mov")
    try FileManager.default.createSymbolicLink(at: link, withDestinationURL: outside)
    for url in [outside, link, root.appendingPathComponent("../Captures-other/movie.mov"), root] {
      assertFailure(.invalidSource) {
        try Motion3DSourceSecurity.resolve(storedURI: url.absoluteString, capturesDirectory: root) { _ in url }
      }
    }
    let rootLink = directory.appendingPathComponent("Captures-link", isDirectory: true)
    try FileManager.default.createSymbolicLink(at: rootLink, withDestinationURL: sibling)
    assertFailure(.invalidSource) {
      try Motion3DSourceSecurity.resolve(storedURI: outside.absoluteString, capturesDirectory: rootLink) { _ in outside }
    }
  }

  func testStreamingSourceHashMatchesExactBytesAcrossMultipleChunks() throws {
    let bytes = Data(repeating: 0xa7, count: Motion3DLimits.hashChunkBytes * 2 + 37)
    let url = directory.appendingPathComponent("source.mov")
    try bytes.write(to: url)
    let actual = try Motion3DVideoFingerprint.read(url: url, cancellation: Motion3DCancellation())
    XCTAssertEqual(actual.snapshot.byteLength, bytes.count)
    XCTAssertEqual(actual.sha256, digest(bytes))
    let cancelled = Motion3DCancellation()
    cancelled.cancel()
    assertFailure(.cancelled) { try Motion3DVideoFingerprint.read(url: url, cancellation: cancelled) }
  }

  func testEmptyMissingAndOversizedSourcesFailBeforeHashing() throws {
    let url = directory.appendingPathComponent("source.mov")
    assertFailure(.invalidSource) { try Motion3DFileSnapshot(url: url) }
    try Data().write(to: url)
    assertFailure(.invalidSource) { try Motion3DFileSnapshot(url: url) }
    let handle = try FileHandle(forWritingTo: url)
    try handle.truncate(atOffset: UInt64(Motion3DLimits.maxVideoBytes) + 1)
    try handle.close()
    assertFailure(.exceedsLimits) { try Motion3DVideoFingerprint.read(url: url, cancellation: Motion3DCancellation()) }
  }

  func testArtifactUsesExactSharedSchemaAndHashesOnlyTheReturnedJSONBytes() throws {
    var builder = try Motion3DJSONBuilder(source: softwareSource(), osVersion: "software-test-only")
    var segments = Motion3DSegments()
    for (index, sample) in [softwareEstimate(), .missing(.multiplePeople), softwareEstimate()].enumerated() {
      try builder.append(Motion3DFrame(
        stamp: Motion3DFrameStamp(frameIndex: index * 2, pts: CMTime(value: Int64(index * 2001), timescale: 30_000)),
        segmentId: segments.consume(sample.status), sample: sample
      ))
    }
    let receipt = try builder.finish()
    XCTAssertEqual(receipt.sha256, digest(Data(receipt.json.utf8)))
    let json = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(receipt.json.utf8)) as? [String: Any])
    XCTAssertEqual(Set(json.keys), Set([
      "schemaVersion", "format", "role", "coordinateSystem", "axes", "units", "imageCoordinates",
      "uncertainty", "temporalProcessing", "source", "estimator", "frames",
    ]))
    XCTAssertEqual(json["schemaVersion"] as? Int, 1)
    XCTAssertEqual(json["format"] as? String, "pickle.motion-3d.v1")
    XCTAssertEqual(json["role"] as? String, "reconstructed_estimate")
    XCTAssertEqual(json["coordinateSystem"] as? String, "vision_root_relative")
    XCTAssertEqual(json["axes"] as? String, "right_handed_y_up")
    XCTAssertEqual(json["units"] as? String, "vision_estimated_meters")
    XCTAssertEqual(json["imageCoordinates"] as? String, "normalized_image_top_left")
    XCTAssertEqual(json["uncertainty"] as? String, "uncalibrated")
    XCTAssertEqual(json["temporalProcessing"] as? String, "none")
    let source = try XCTUnwrap(json["source"] as? [String: Any])
    XCTAssertEqual(Set(source.keys), Set([
      "captureId", "videoSha256", "videoByteLength", "width", "height", "durationMs",
      "nominalFrameRate", "preferredTransform", "orientationPolicy", "mirroring",
    ]))
    XCTAssertEqual(source["orientationPolicy"] as? String, "preferred_track_transform_applied")
    XCTAssertEqual(source["mirroring"] as? String, "as_encoded")
    let estimator = try XCTUnwrap(json["estimator"] as? [String: Any])
    XCTAssertEqual(Set(estimator.keys), Set([
      "providerId", "revision", "osVersion", "modelAsset", "modelAssetSha256", "configurationVersion", "maxSampleRate",
    ]))
    XCTAssertEqual(estimator["providerId"] as? String, "pose.apple-vision-3d")
    XCTAssertEqual(estimator["revision"] as? Int, 1)
    XCTAssertEqual(estimator["modelAsset"] as? String, "os_managed")
    XCTAssertTrue(estimator["modelAssetSha256"] is NSNull)
    XCTAssertEqual(estimator["configurationVersion"] as? String, "apple-vision-3d-raw-1")
    XCTAssertEqual(estimator["maxSampleRate"] as? Int, 30)
    let frames = try XCTUnwrap(json["frames"] as? [[String: Any]])
    XCTAssertEqual(frames.map { $0["segmentId"] as? Int }, [0, 0, 1])
    XCTAssertEqual(frames[0]["observationConfidence"] as? Double, 0.91)
    XCTAssertEqual(frames[0]["cameraOriginMatrix"] as? [Double], softwareEstimate().cameraOriginMatrix)
    XCTAssertEqual((frames[0]["height"] as? [String: Any])?["source"] as? String, "reference")
  }

  func testArtifactBuilderRejectsEmptyFrameOverflowAndUTF8ByteOverflow() throws {
    var empty = try Motion3DJSONBuilder(source: softwareSource())
    assertFailure(.decodingFailed) { try empty.finish() }
    var builder = try Motion3DJSONBuilder(source: softwareSource())
    for index in 0..<Motion3DLimits.maxFrames {
      try builder.append(Motion3DFrame(
        stamp: Motion3DFrameStamp(frameIndex: index, pts: CMTime(value: Int64(index), timescale: 30)),
        segmentId: 0, sample: .missing(.noPerson)
      ))
    }
    assertFailure(.exceedsLimits) {
      try builder.append(Motion3DFrame(stamp: Motion3DFrameStamp(frameIndex: 1800, pts: .zero), segmentId: 0, sample: .missing(.noPerson)))
    }
    let oversized = softwareSource(captureId: String(repeating: "é", count: Motion3DLimits.maxJSONBytes / 2))
    assertFailure(.exceedsLimits) { try Motion3DJSONBuilder(source: oversized) }
  }

  func testActualDecoderSoftwareFixtureKeepsSourcePTSFrameIndicesAndRotationWithoutDerivativeFiles() throws {
    let url = try writeSoftwareVideo()
    let filesBefore = try FileManager.default.contentsOfDirectory(atPath: directory.path)
    var seenPTS: [CMTime] = []
    let receipt = try Motion3DVideoReconstruction.run(
      videoURL: url, captureId: "software-decoder-test", cancellation: Motion3DCancellation(),
      progress: { progress in
        XCTAssertGreaterThan(progress.processedFrames, 0)
        XCTAssertLessThanOrEqual(progress.timestampMs, progress.durationMs)
      }, reset: {}, estimate: { buffer, orientation in
        XCTAssertEqual(orientation, .right)
        let pixels = try XCTUnwrap(CMSampleBufferGetImageBuffer(buffer))
        XCTAssertEqual(CVPixelBufferGetWidth(pixels), 64)
        XCTAssertEqual(CVPixelBufferGetHeight(pixels), 96)
        seenPTS.append(CMSampleBufferGetPresentationTimeStamp(buffer))
        return seenPTS.count == 2 ? .missing(.multiplePeople) : self.softwareEstimate()
      }
    )
    let json = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(receipt.json.utf8)) as? [String: Any])
    let source = try XCTUnwrap(json["source"] as? [String: Any])
    XCTAssertEqual(source["width"] as? Int, 96)
    XCTAssertEqual(source["height"] as? Int, 64)
    XCTAssertEqual(source["preferredTransform"] as? [Double], [0, 1, -1, 0, 96, 0])
    XCTAssertEqual(source["videoSha256"] as? String, digest(try Data(contentsOf: url)))
    let frames = try XCTUnwrap(json["frames"] as? [[String: Any]])
    XCTAssertEqual(frames.map { $0["frameIndex"] as? Int }, [0, 2, 4])
    XCTAssertEqual(frames.map { $0["segmentId"] as? Int }, [0, 0, 1])
    XCTAssertEqual(frames.count, seenPTS.count)
    for (frame, pts) in zip(frames, seenPTS) {
      XCTAssertEqual(frame["ptsValue"] as? Int64, pts.value)
      XCTAssertEqual(frame["ptsTimescale"] as? Int32, pts.timescale)
      XCTAssertEqual(frame["timestampMs"] as? Double, Double(pts.value) * 1000 / Double(pts.timescale))
    }
    XCTAssertEqual(receipt.sha256, digest(Data(receipt.json.utf8)))
    XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: directory.path), filesBefore)
  }

  func testActualDecoderCancellationDoesNotReturnAPartialArtifact() throws {
    let url = try writeSoftwareVideo()
    let cancellation = Motion3DCancellation()
    var estimates = 0
    assertFailure(.cancelled) {
      try Motion3DVideoReconstruction.run(
        videoURL: url, captureId: "software-cancellation-test", cancellation: cancellation,
        progress: { _ in }, reset: {}, estimate: { _, _ in
          estimates += 1
          cancellation.cancel()
          return self.softwareEstimate()
        }
      )
    }
    XCTAssertEqual(estimates, 1)
    XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: directory.path), [url.lastPathComponent])
  }

  func testAssociatedV2SchemaIsSeparateAndEncodesRequiredNullsAndVersionedParameters() throws {
    let person = softwarePerson(x: 0.4, y: 0.5, span: 0.2)
    var tracker = Motion3DTargetTracker()
    let selection = try tracker.select(people: [person], timestampMs: 0, aspectRatio: 1)
    let matched = Motion3DProjectionAssociation.associate(selection: selection, estimates: [softwareProjection(person)])
    var builder = try Motion3DJSONBuilder(source: softwareSource(), osVersion: "software-test-only", identityPolicy: Motion3DIdentityPolicy(seed: nil))
    try builder.append(Motion3DFrame(stamp: Motion3DFrameStamp(frameIndex: 0, pts: .zero), segmentId: 0, sample: matched))
    let lost = try tracker.select(people: [], timestampMs: 40, aspectRatio: 1)
    try builder.append(Motion3DFrame(stamp: Motion3DFrameStamp(frameIndex: 1, pts: CMTime(value: 1, timescale: 25)), segmentId: 0, sample: lost.rejected(.targetLost)))
    let receipt = try builder.finish()
    let json = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(receipt.json.utf8)) as? [String: Any])
    XCTAssertEqual(receipt.sha256, digest(Data(receipt.json.utf8)))
    XCTAssertEqual(Set(json.keys), Set([
      "schemaVersion", "format", "role", "coordinateSystem", "axes", "units", "imageCoordinates",
      "uncertainty", "temporalProcessing", "source", "estimator", "frames", "identityPolicy",
    ]))
    XCTAssertEqual(json["schemaVersion"] as? Int, 2)
    XCTAssertEqual(json["format"] as? String, "pickle.motion-3d.v2")
    XCTAssertEqual((json["estimator"] as? [String: Any])?["configurationVersion"] as? String, "apple-vision-3d-associated-2")
    let policy = try XCTUnwrap(json["identityPolicy"] as? [String: Any])
    XCTAssertEqual(Set(policy.keys), Set(["version", "selection", "seed", "crossRecordIdentity", "residualUnit", "parameters"]))
    XCTAssertEqual(policy["version"] as? String, "motion-target-association-1")
    XCTAssertEqual(policy["selection"] as? String, "automatic_prominence")
    XCTAssertTrue(policy["seed"] is NSNull)
    XCTAssertEqual(policy["crossRecordIdentity"] as? String, "unverified")
    XCTAssertEqual(policy["residualUnit"] as? String, "torso_spans")
    XCTAssertEqual(policy["parameters"] as? [String: Double], Motion3DAssociationParameters.values)
    XCTAssertEqual(Motion3DAssociationParameters.minimumCommonJoints, 4)
    XCTAssertEqual(Motion3DAssociationParameters.maximumReprojectionError, 0.35)
    XCTAssertEqual(Motion3DAssociationParameters.projectionMargin, 0.15)
    XCTAssertEqual(Motion3DAssociationParameters.maximumScaleRatio, 1.6)
    XCTAssertEqual(Motion3DAssociationParameters.prominenceRatio, 1 / 0.7)
    let frames = try XCTUnwrap(json["frames"] as? [[String: Any]])
    let association = try XCTUnwrap(frames[0]["association"] as? [String: Any])
    XCTAssertEqual(Set(association.keys), Set([
      "status", "trackId", "candidateCount", "selectedCandidate", "commonJoints", "reprojectionError", "runnerUpError", "continuity",
    ]))
    XCTAssertEqual(association["status"] as? String, "matched")
    XCTAssertEqual(association["commonJoints"] as? Int, 12)
    XCTAssertTrue(association["runnerUpError"] is NSNull)
    XCTAssertTrue((frames[1]["association"] as? [String: Any])?["selectedCandidate"] is NSNull)
    for key in ["observationConfidence", "height", "cameraOriginMatrix"] { XCTAssertTrue(frames[1][key] is NSNull) }
    XCTAssertEqual((frames[1]["joints"] as? [Any])?.count, 0)
  }

  func testAssociatedSelectionAndProjectionAreInvariantToCandidateAndJointOrder() throws {
    let target = softwarePerson(x: 0.3, y: 0.6, span: 0.2)
    let rival = softwarePerson(x: 0.8, y: 0.25, span: 0.08)
    let targetProjection = softwareProjection(target)
    let rivalProjection = softwareProjection(rival)
    var encoded: [Data] = []
    for people in [[target, rival], [rival, target]] {
      for estimates in [[targetProjection, rivalProjection], [rivalProjection, targetProjection]] {
        var tracker = Motion3DTargetTracker()
        let selection = try tracker.select(people: people, timestampMs: 0, aspectRatio: 1)
        let sample = Motion3DProjectionAssociation.associate(selection: selection, estimates: estimates)
        XCTAssertEqual(sample.status, .estimated)
        XCTAssertEqual(sample.association?.selectedCandidate, 0)
        XCTAssertEqual(sample.association?.trackId, 1)
        XCTAssertEqual(sample.association?.commonJoints, 12)
        XCTAssertEqual(sample.association?.reprojectionError, 0)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        encoded.append(try encoder.encode(Motion3DFrame(stamp: Motion3DFrameStamp(frameIndex: 0, pts: .zero), segmentId: 0, sample: sample)))
      }
    }
    XCTAssertTrue(encoded.dropFirst().allSatisfy { $0 == encoded[0] })
    var tracker = Motion3DTargetTracker()
    let selection = try tracker.select(people: [target, rival], timestampMs: 0, aspectRatio: 1)
    let reversed = replacingJoints(targetProjection, Array(targetProjection.joints.reversed()))
    let sample = Motion3DProjectionAssociation.associate(selection: selection, estimates: [reversed])
    XCTAssertEqual(sample.association?.commonJoints, 12)
    XCTAssertEqual(sample.association?.reprojectionError, 0)
    XCTAssertEqual(sample.joints.map(\.name), reversed.joints.map(\.name))
  }

  func testAssociationAbstainsForDuplicatePeopleDuplicate3DCandidatesAndDuplicateJointSupport() throws {
    let target = softwarePerson(x: 0.4, y: 0.5, span: 0.2)
    var duplicateTracker = Motion3DTargetTracker()
    let duplicate = try duplicateTracker.select(people: [target, target], timestampMs: 0, aspectRatio: 1)
    XCTAssertEqual(duplicate.failure, .ambiguous)
    XCTAssertNil(duplicate.trackId)
    var tracker = Motion3DTargetTracker()
    let selection = try tracker.select(people: [target], timestampMs: 0, aspectRatio: 1)
    let projection = softwareProjection(target)
    let tie = Motion3DProjectionAssociation.associate(selection: selection, estimates: [projection, projection])
    XCTAssertEqual(tie.association?.status, .ambiguous)
    XCTAssertEqual(tie.association?.runnerUpError, 0)
    XCTAssertTrue(tie.joints.isEmpty)
    let repeated = replacingJoints(projection, projection.joints + [projection.joints[0]])
    let invalid = Motion3DProjectionAssociation.associate(selection: selection, estimates: [repeated])
    XCTAssertEqual(invalid.association?.status, .insufficientSupport)
    XCTAssertEqual(invalid.association?.commonJoints, 0)
    XCTAssertTrue(invalid.joints.isEmpty)
  }

  func testWrongPersonProjectionIsRejectedEvenWhenTheIntendedTargetIsProminent() throws {
    let target = softwarePerson(x: 0.3, y: 0.6, span: 0.2)
    let rival = softwarePerson(x: 0.8, y: 0.25, span: 0.08)
    var tracker = Motion3DTargetTracker()
    let selection = try tracker.select(people: [rival, target], timestampMs: 0, aspectRatio: 1)
    let sample = Motion3DProjectionAssociation.associate(selection: selection, estimates: [softwareProjection(rival)])
    XCTAssertEqual(sample.association?.status, .wrongPlayer)
    XCTAssertEqual(sample.association?.trackId, 1)
    XCTAssertEqual(sample.association?.selectedCandidate, 0)
    XCTAssertEqual(sample.association?.runnerUpError, 0)
    XCTAssertGreaterThan(try XCTUnwrap(sample.association?.reprojectionError), 0.35)
    XCTAssertEqual(sample.association?.continuity, .broken)
    XCTAssertEqual(sample.status, .multiplePeople)
    XCTAssertTrue(sample.joints.isEmpty)
    XCTAssertNil(sample.height)
    XCTAssertNil(sample.cameraOriginMatrix)
    XCTAssertNil(sample.observationConfidence)
  }

  func testProjectionRequiresASeparateRunnerUpMarginAndSupportedDistinctCommonJoints() throws {
    let target = softwarePerson(x: 0.4, y: 0.5, span: 0.2)
    let adjacent = softwarePerson(x: 0.42, y: 0.5, span: 0.2)
    let selection = Motion3DTargetSelection(people: [target, adjacent], selectedCandidate: 0, trackId: 1, continuity: .initial, failure: nil, aspectRatio: 1)
    let projection = softwareProjection(target)
    let ambiguous = Motion3DProjectionAssociation.associate(selection: selection, estimates: [projection])
    XCTAssertEqual(ambiguous.association?.status, .ambiguous)
    XCTAssertEqual(try XCTUnwrap(ambiguous.association?.runnerUpError), 0.1, accuracy: 1e-12)
    XCTAssertTrue(ambiguous.joints.isEmpty)
    var tracker = Motion3DTargetTracker()
    let unique = try tracker.select(people: [target], timestampMs: 0, aspectRatio: 1)
    let partial = replacingJoints(projection, projection.joints.filter { [.root, .leftShoulder, .rightShoulder, .leftHip].contains($0.name) })
    let rejected = Motion3DProjectionAssociation.associate(selection: unique, estimates: [partial])
    XCTAssertEqual(rejected.association?.status, .insufficientSupport)
    XCTAssertEqual(rejected.association?.commonJoints, 3)
    XCTAssertNil(rejected.association?.reprojectionError)
    let unsupported = Motion3DProjectionAssociation.associate(selection: unique, estimates: [])
    XCTAssertEqual(unsupported.association?.status, .insufficientSupport)
  }

  func testNoInitialChoiceWithoutUnambiguousProminenceOrTorsoSupport() throws {
    let left = softwarePerson(x: 0.3, y: 0.5, span: 0.2)
    let right = softwarePerson(x: 0.7, y: 0.5, span: 0.18)
    var tracker = Motion3DTargetTracker()
    XCTAssertEqual(try tracker.select(people: [], timestampMs: 0, aspectRatio: 1).failure, .noPerson)
    XCTAssertEqual(try tracker.select(people: [left, right], timestampMs: 40, aspectRatio: 1).failure, .ambiguous)
    var partial = left.points
    partial.removeValue(forKey: .leftHip)
    XCTAssertEqual(try tracker.select(people: [Motion3DPerson2D(points: partial)], timestampMs: 80, aspectRatio: 1).failure, .insufficientSupport)
    let initial = try tracker.select(people: [left], timestampMs: 120, aspectRatio: 1)
    XCTAssertNil(initial.failure)
    XCTAssertEqual(initial.continuity, .initial)
    XCTAssertEqual(initial.trackId, 1)
  }

  func testIncumbentIsNotReplacedByANewLargestPersonOrArrayReordering() throws {
    let target = softwarePerson(x: 0.3, y: 0.55, span: 0.15, visibility: 0.83)
    let newcomer = softwarePerson(x: 0.75, y: 0.5, span: 0.28, visibility: 0.92)
    var tracker = Motion3DTargetTracker()
    _ = try tracker.select(people: [target], timestampMs: 0, aspectRatio: 1)
    let selection = try tracker.select(people: [target, newcomer], timestampMs: 40, aspectRatio: 1)
    XCTAssertNil(selection.failure)
    XCTAssertEqual(selection.selectedCandidate, 1)
    let sample = Motion3DProjectionAssociation.associate(selection: selection, estimates: [softwareProjection(target)])
    XCTAssertEqual(sample.status, .estimated)
    XCTAssertEqual(sample.association?.trackId, 1)
    XCTAssertEqual(sample.association?.continuity, .continuous)
    XCTAssertTrue(sample.joints.allSatisfy { $0.visibility2D == 0.83 })
  }

  func testTargetLossLatchesAndNeverSilentlyReacquiresEvenAtTheOldPosition() throws {
    let target = softwarePerson(x: 0.4, y: 0.5, span: 0.2)
    for missing in [[], [softwarePerson(x: 0.8, y: 0.5, span: 0.3)]] {
      var tracker = Motion3DTargetTracker()
      _ = try tracker.select(people: [target], timestampMs: 0, aspectRatio: 1)
      let lost = try tracker.select(people: missing, timestampMs: 40, aspectRatio: 1)
      XCTAssertEqual(lost.failure, .targetLost)
      XCTAssertEqual(lost.trackId, 1)
      let back = try tracker.select(people: [target], timestampMs: 80, aspectRatio: 1)
      XCTAssertEqual(back.failure, .targetLost)
      XCTAssertNil(back.selectedCandidate)
      XCTAssertTrue(Motion3DProjectionAssociation.associate(selection: back, estimates: [softwareProjection(target)]).joints.isEmpty)
    }
  }

  func testCurrentAndPreviousRivalsRejectCrossingsAndOcclusionHandoffs() throws {
    let target = softwarePerson(x: 0.4, y: 0.5, span: 0.2)
    var tracker = Motion3DTargetTracker()
    _ = try tracker.select(people: [target], timestampMs: 0, aspectRatio: 1)
    let contested = try tracker.select(people: [target, softwarePerson(x: 0.42, y: 0.5, span: 0.2)], timestampMs: 40, aspectRatio: 1)
    XCTAssertEqual(contested.failure, .ambiguous)
    XCTAssertEqual(try tracker.select(people: [target], timestampMs: 80, aspectRatio: 1).failure, .targetLost)
    var seeded = Motion3DTargetTracker(seed: try Motion3DTargetSeed(x: 0.4, y: 0.5, timestampMs: 0))
    let initial = try seeded.select(people: [target, softwarePerson(x: 0.5, y: 0.5, span: 0.2)], timestampMs: 0, aspectRatio: 1)
    XCTAssertNil(initial.failure)
    let handoff = try seeded.select(people: [softwarePerson(x: 0.455, y: 0.5, span: 0.2)], timestampMs: 40, aspectRatio: 1)
    XCTAssertEqual(handoff.failure, .ambiguous)
    XCTAssertEqual(handoff.trackId, 1)
  }

  func testScaleJumpMissingTorsoAndSourceTimeGapsBreakIdentityRatherThanChooseAgain() throws {
    let target = softwarePerson(x: 0.4, y: 0.5, span: 0.15)
    var partial = target.points
    partial[.leftHip] = Motion3DImagePoint(x: 0.36, y: 0.575, visibility: 0.1)
    for next in [softwarePerson(x: 0.4, y: 0.5, span: 0.27), Motion3DPerson2D(points: partial)] {
      var tracker = Motion3DTargetTracker()
      _ = try tracker.select(people: [target], timestampMs: 0, aspectRatio: 1)
      XCTAssertEqual(try tracker.select(people: [next], timestampMs: 40, aspectRatio: 1).failure, .targetLost)
      XCTAssertEqual(try tracker.select(people: [target], timestampMs: 80, aspectRatio: 1).failure, .targetLost)
    }
    var tracker = Motion3DTargetTracker()
    _ = try tracker.select(people: [target], timestampMs: 0, aspectRatio: 1)
    XCTAssertEqual(try tracker.select(people: [target], timestampMs: 251, aspectRatio: 1).failure, .targetLost)
    var reset = Motion3DTargetTracker()
    _ = try reset.select(people: [target], timestampMs: 0, aspectRatio: 1)
    reset.breakContinuity()
    XCTAssertEqual(try reset.select(people: [target], timestampMs: 40, aspectRatio: 1).failure, .targetLost)
  }

  func testExplicitSeedUsesOnlyItsSourceFrameAndNeverProducesEarlierMotion() throws {
    let target = softwarePerson(x: 0.3, y: 0.6, span: 0.12)
    let other = softwarePerson(x: 0.8, y: 0.4, span: 0.2)
    let seed = try Motion3DTargetSeed(x: 0.3, y: 0.6, timestampMs: 80)
    var tracker = Motion3DTargetTracker(seed: seed)
    for time in [0.0, 40] {
      let selection = try tracker.select(people: [other, target], timestampMs: time, aspectRatio: 1)
      XCTAssertEqual(selection.failure, .notSelected)
      XCTAssertNil(selection.trackId)
      XCTAssertTrue(Motion3DProjectionAssociation.associate(selection: selection, estimates: [softwareProjection(other)]).joints.isEmpty)
    }
    let selected = try tracker.select(people: [other, target], timestampMs: 80, aspectRatio: 1)
    XCTAssertNil(selected.failure)
    XCTAssertEqual(selected.selectedCandidate, 1)
    XCTAssertEqual(selected.trackId, 1)
    for index in 1...6 {
      let moving = softwarePerson(x: 0.3 + Double(index) * 0.04, y: 0.6, span: 0.12)
      let selection = try tracker.select(people: [other, moving], timestampMs: 80 + Double(index) * 40, aspectRatio: 1)
      XCTAssertNil(selection.failure)
      XCTAssertEqual(selection.trackId, 1)
    }
    let policy = try object(Motion3DIdentityPolicy(seed: seed))
    XCTAssertEqual(policy["selection"] as? String, "explicit_seed")
    XCTAssertEqual((policy["seed"] as? [String: Double])?["timestampMs"], 80)
  }

  func testAmbiguousOrAbsentExplicitSeedIsNeverRetriedAgainstLaterPeople() throws {
    let left = softwarePerson(x: 0.4, y: 0.5, span: 0.2)
    let right = softwarePerson(x: 0.6, y: 0.5, span: 0.2)
    for initial in [[], [left, right]] {
      var tracker = Motion3DTargetTracker(seed: try Motion3DTargetSeed(x: 0.5, y: 0.5, timestampMs: 0))
      XCTAssertNotNil(try tracker.select(people: initial, timestampMs: 0, aspectRatio: 1).failure)
      let later = try tracker.select(people: [left], timestampMs: 40, aspectRatio: 1)
      XCTAssertEqual(later.failure, .notSelected)
      XCTAssertNil(later.trackId)
    }
  }

  func testSeedValidationRejectsWallClockNonNumbersBooleansAndUnknownKeys() throws {
    let good: [String: Any] = ["x": 0.4, "y": 0.6, "timestampMs": 80]
    XCTAssertEqual(try Motion3DTargetSeed.parse(good), try Motion3DTargetSeed(x: 0.4, y: 0.6, timestampMs: 80))
    for (key, value) in [("x", true as Any), ("x", "0.4" as Any), ("y", Double.nan as Any), ("timestampMs", Date().timeIntervalSince1970 * 1000 as Any), ("timestampMs", -1 as Any)] {
      var invalid = good
      invalid[key] = value
      assertFailure(.invalidOptions) { try Motion3DTargetSeed.parse(invalid) }
    }
    var extra = good
    extra["mode"] = "tap"
    assertFailure(.invalidOptions) { try Motion3DTargetSeed.parse(extra) }
    assertFailure(.invalidOptions) { try Motion3DTargetSeed.parse(NSNull()) }
  }

  func testProjectionAbstentionBreaksMotionSegmentsButContinuous2DTargetKeepsOneTrack() throws {
    let target = softwarePerson(x: 0.3, y: 0.6, span: 0.2)
    let other = softwarePerson(x: 0.8, y: 0.25, span: 0.08)
    var tracker = Motion3DTargetTracker()
    var segments = Motion3DSegments()
    var frames: [Motion3DFrame] = []
    for (index, projection) in [softwareProjection(target), softwareProjection(other), softwareProjection(target)].enumerated() {
      let selection = try tracker.select(people: [target, other], timestampMs: Double(index * 40), aspectRatio: 1)
      let sample = Motion3DProjectionAssociation.associate(selection: selection, estimates: [projection])
      frames.append(Motion3DFrame(stamp: Motion3DFrameStamp(frameIndex: index, pts: CMTime(value: Int64(index), timescale: 25)), segmentId: segments.consume(sample.status), sample: sample))
    }
    XCTAssertEqual(frames.map(\.status), [.estimated, .multiplePeople, .estimated])
    XCTAssertEqual(frames.map(\.segmentId), [0, 0, 1])
    XCTAssertEqual(frames.map { $0.association?.trackId }, [1, 1, 1])
    XCTAssertEqual(frames.map { $0.association?.continuity }, [.initial, .broken, .continuous])
    XCTAssertTrue(frames[1].joints.isEmpty)
    XCTAssertEqual(frames[0].joints.map(\.x), frames[2].joints.map(\.x))
  }

  func testAssociatedRequestPersistsOnlyForAcceptedSegmentsAndResetsOnEveryAbstention() throws {
    guard #available(macOS 14.0, iOS 17.0, *) else { throw XCTSkip("Vision 3D requires iOS 17 or macOS 14.") }
    let provider = ApplePose3DAssociatedProvider()
    let request = provider.request3D
    XCTAssertEqual(request.revision, VNDetectHumanBodyPose3DRequestRevision1)
    XCTAssertTrue((request as VNRequest) is VNStatefulRequest)
    let person = softwarePerson(x: 0.4, y: 0.5, span: 0.2)
    var tracker = Motion3DTargetTracker()
    let selection = try tracker.select(people: [person], timestampMs: 0, aspectRatio: 1)
    XCTAssertEqual(provider.complete(selection: selection, estimates: [softwareProjection(person)]).status, .estimated)
    XCTAssertTrue(request === provider.request3D)
    XCTAssertNotEqual(provider.complete(selection: selection, estimates: []).status, .estimated)
    XCTAssertFalse(request === provider.request3D)
    let reset = provider.request3D
    provider.breakContinuity()
    XCTAssertFalse(reset === provider.request3D)
    XCTAssertEqual(provider.request3D.revision, VNDetectHumanBodyPose3DRequestRevision1)
  }

  func testAssociationResidualUsesDisplayAspectForAllEightOrientations() throws {
    guard #available(macOS 14.0, iOS 17.0, *) else { throw XCTSkip("Vision 3D requires iOS 17 or macOS 14.") }
    let person = softwarePerson(x: 0.4, y: 0.5, span: 0.2)
    for orientation in [CGImagePropertyOrientation.up, .upMirrored, .down, .downMirrored, .left, .leftMirrored, .right, .rightMirrored] {
      let swapped = [CGImagePropertyOrientation.left, .leftMirrored, .right, .rightMirrored].contains(orientation)
      let aspect = try ApplePose3DAssociatedProvider.aspectRatio(width: 640, height: 480, orientation: orientation)
      XCTAssertEqual(aspect, swapped ? 480.0 / 640 : 640.0 / 480)
      var tracker = Motion3DTargetTracker()
      let selection = try tracker.select(people: [person], timestampMs: 0, aspectRatio: aspect)
      let result = Motion3DProjectionAssociation.associate(selection: selection, estimates: [softwareProjection(person, dx: 0.02)])
      XCTAssertEqual(result.status, .estimated)
      XCTAssertEqual(try XCTUnwrap(result.association?.reprojectionError), 0.02 * aspect / 0.2, accuracy: 1e-12)
    }
    assertFailure(.invalidSource) { try ApplePose3DAssociatedProvider.aspectRatio(width: 0, height: 480, orientation: .up) }
  }

  func testAssociatedCandidateLimitsAndTimeRegressionsCannotSilentlyDropEvidence() throws {
    let person = softwarePerson(x: 0.4, y: 0.5, span: 0.2)
    var overflow = Motion3DTargetTracker()
    assertFailure(.exceedsLimits) { try overflow.select(people: Array(repeating: person, count: 65), timestampMs: 0, aspectRatio: 1) }
    for time in [0.0, -1, .nan] {
      var tracker = Motion3DTargetTracker()
      _ = try tracker.select(people: [person], timestampMs: 0, aspectRatio: 1)
      assertFailure(.invalidSource) { try tracker.select(people: [person], timestampMs: time, aspectRatio: 1) }
    }
    let broken = Motion3DTargetSelection(people: [person], selectedCandidate: 0, trackId: 1, continuity: .broken, failure: nil, aspectRatio: 1)
    XCTAssertNotEqual(Motion3DProjectionAssociation.associate(selection: broken, estimates: [softwareProjection(person)]).status, .estimated)
  }

  func testAssociatedActualDecoderPreservesRawSourceHashFrameIndicesPTSAndRotation() throws {
    let url = try writeSoftwareVideo()
    let sourceBytes = try Data(contentsOf: url)
    var rawPixelHashes: [String] = []
    var associatedPixelHashes: [String] = []
    let raw = try Motion3DVideoReconstruction.run(
      videoURL: url, captureId: "software-associated-decoder", cancellation: Motion3DCancellation(), progress: { _ in }, reset: {},
      estimate: { buffer, _ in
        rawPixelHashes.append(try self.pixelDigest(buffer))
        return self.softwareEstimate()
      }
    )
    let seed = try Motion3DTargetSeed(x: 0.4, y: 0.5, timestampMs: 1000.0 / 30)
    var tracker = Motion3DTargetTracker(seed: seed)
    let person = softwarePerson(x: 0.4, y: 0.5, span: 0.2)
    let receipt = try Motion3DVideoReconstruction.run(
      videoURL: url, captureId: "software-associated-decoder", cancellation: Motion3DCancellation(), identityPolicy: Motion3DIdentityPolicy(seed: seed),
      progress: { _ in }, reset: { tracker.breakContinuity() }, estimate: { buffer, orientation in
        XCTAssertEqual(orientation, .right)
        associatedPixelHashes.append(try self.pixelDigest(buffer))
        let pts = CMSampleBufferGetPresentationTimeStamp(buffer)
        let selection = try tracker.select(people: [person], timestampMs: Double(pts.value) * 1000 / Double(pts.timescale), aspectRatio: 1.5)
        return Motion3DProjectionAssociation.associate(selection: selection, estimates: [self.softwareProjection(person)])
      }
    )
    let rawJSON = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(raw.json.utf8)) as? [String: Any])
    let json = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(receipt.json.utf8)) as? [String: Any])
    XCTAssertTrue(try XCTUnwrap(rawJSON["source"] as? NSDictionary).isEqual(to: try XCTUnwrap(json["source"] as? [AnyHashable: Any])))
    let frames = try XCTUnwrap(json["frames"] as? [[String: Any]])
    let rawFrames = try XCTUnwrap(rawJSON["frames"] as? [[String: Any]])
    for (frame, rawFrame) in zip(frames, rawFrames) {
      for key in ["frameIndex", "ptsValue", "ptsTimescale", "timestampMs"] { XCTAssertEqual(frame[key] as? NSNumber, rawFrame[key] as? NSNumber) }
    }
    XCTAssertEqual(frames.count, 3)
    XCTAssertEqual(associatedPixelHashes, rawPixelHashes)
    XCTAssertEqual(rawPixelHashes.count, frames.count)
    XCTAssertEqual(frames.map { $0["status"] as? String }, ["unavailable", "estimated", "estimated"])
    XCTAssertEqual(frames.map { $0["segmentId"] as? Int }, [0, 1, 1])
    XCTAssertEqual((json["source"] as? [String: Any])?["videoSha256"] as? String, digest(sourceBytes))
    XCTAssertEqual(receipt.sha256, digest(Data(receipt.json.utf8)))
    XCTAssertEqual(try Data(contentsOf: url), sourceBytes)
    XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: directory.path), [url.lastPathComponent])
  }

  func testSeedMustNameAnActuallySampledPTSOrNoArtifactIsReturned() throws {
    let url = try writeSoftwareVideo()
    for timestamp in [50.0, 1, 1000.0 / 60, 101] {
      let seed = try Motion3DTargetSeed(x: 0.4, y: 0.5, timestampMs: timestamp)
      var tracker = Motion3DTargetTracker(seed: seed)
      let person = softwarePerson(x: 0.4, y: 0.5, span: 0.2)
      assertFailure(.invalidOptions) {
        try Motion3DVideoReconstruction.run(
          videoURL: url, captureId: "software-invalid-seed", cancellation: Motion3DCancellation(), identityPolicy: Motion3DIdentityPolicy(seed: seed),
          progress: { _ in }, reset: { tracker.breakContinuity() }, estimate: { buffer, _ in
            let pts = CMSampleBufferGetPresentationTimeStamp(buffer)
            let selection = try tracker.select(people: [person], timestampMs: Double(pts.value) * 1000 / Double(pts.timescale), aspectRatio: 1.5)
            return Motion3DProjectionAssociation.associate(selection: selection, estimates: [self.softwareProjection(person)])
          }
        )
      }
    }
  }

  func testROIPartialHipContinuityReproducesTheMeasuredCropFrameThreeWithoutLoweringVisibility() throws {
    let before = measuredCropPerson(frameThree: false)
    let after = measuredCropPerson(frameThree: true)
    let aspect = 480.0 / 620
    XCTAssertEqual(before.points[.leftHip]?.visibility, 0.226318359375)
    XCTAssertEqual(after.points[.leftHip]?.visibility, 0.193603515625)
    XCTAssertNil(after.point(.leftHip))
    XCTAssertNil(after.torso(aspectRatio: aspect))
    XCTAssertEqual(Motion3DAssociationParameters.minimumVisibility, 0.2)
    var legacy = Motion3DTargetTracker()
    _ = try legacy.select(people: [before], timestampMs: 80, aspectRatio: aspect)
    XCTAssertEqual(try legacy.select(people: [after], timestampMs: 120, aspectRatio: aspect).failure, .targetLost)
    var current = Motion3DROITargetTracker()
    let initial = try current.select(people: [before], timestampMs: 80, aspectRatio: aspect)
    let selection = try current.select(people: [after], timestampMs: 120, aspectRatio: aspect)
    XCTAssertNil(selection.failure)
    XCTAssertEqual(selection.trackId, 1)
    let evidence = try XCTUnwrap(Motion3DCommonContinuity.compare(from: before, to: after, aspectRatio: aspect, normalizationSpan: try XCTUnwrap(initial.torsoNormalizationSpan)))
    XCTAssertEqual(evidence.commonJoints, 10)
    XCTAssertEqual(evidence.commonHips, 1)
    XCTAssertLessThan(evidence.hipDisplacement, 0.005)
    XCTAssertLessThan(evidence.jointResidual, 0.1)
    XCTAssertGreaterThan(evidence.scaleFactor, 0.95)
    XCTAssertLessThan(evidence.scaleFactor, 1.05)
  }

  func testROIPartialShouldersUseOnlyObservedCommonJointsAndNeverFillVisibility() throws {
    let person = softwarePerson(x: 0.4, y: 0.5, span: 0.2)
    var points = person.points
    points.removeValue(forKey: .leftShoulder)
    points.removeValue(forKey: .rightShoulder)
    let partial = Motion3DPerson2D(points: points)
    var tracker = Motion3DROITargetTracker()
    _ = try tracker.select(people: [person], timestampMs: 0, aspectRatio: 1)
    let selection = try tracker.select(people: [partial], timestampMs: 40, aspectRatio: 1)
    XCTAssertNil(selection.failure)
    XCTAssertNotNil(selection.torsoNormalizationSpan)
    let estimate = Motion3DProjectionAssociation.associate(selection: selection, estimates: [softwareProjection(person)])
    XCTAssertEqual(estimate.status, .estimated)
    XCTAssertEqual(estimate.association?.commonJoints, 10)
    XCTAssertNil(estimate.joints.first { $0.name == .leftShoulder }?.visibility2D)
    XCTAssertNil(estimate.joints.first { $0.name == .rightShoulder }?.visibility2D)
  }

  func testROINamedHipAnchorCannotSwitchSidesWithoutSharedObservedSupport() throws {
    let person = softwarePerson(x: 0.4, y: 0.5, span: 0.2)
    var rightOnly = person.points
    rightOnly.removeValue(forKey: .leftHip)
    var leftOnly = person.points
    leftOnly.removeValue(forKey: .rightHip)
    var tracker = Motion3DROITargetTracker()
    _ = try tracker.select(people: [person], timestampMs: 0, aspectRatio: 1)
    XCTAssertNil(try tracker.select(people: [Motion3DPerson2D(points: rightOnly)], timestampMs: 40, aspectRatio: 1).failure)
    XCTAssertEqual(try tracker.select(people: [Motion3DPerson2D(points: leftOnly)], timestampMs: 80, aspectRatio: 1).failure, .targetLost)
    XCTAssertEqual(try tracker.select(people: [person], timestampMs: 120, aspectRatio: 1).failure, .targetLost)
  }

  func testROIScaleExcludedRivalIsNotMisclassifiedAsUnknownNearbySupport() throws {
    let person = softwarePerson(x: 0.3, y: 0.6, span: 0.2)
    let distantSmallBody = softwarePerson(x: 0.3, y: 0.58, span: 0.07)
    XCTAssertGreaterThan(1 / (try XCTUnwrap(Motion3DCommonContinuity.scale(from: person, to: distantSmallBody, aspectRatio: 1))), 1.6)
    var tracker = Motion3DROITargetTracker()
    _ = try tracker.select(people: [person], timestampMs: 0, aspectRatio: 1)
    let selection = try tracker.select(people: [distantSmallBody, person], timestampMs: 40, aspectRatio: 1)
    XCTAssertNil(selection.failure)
    XCTAssertEqual(selection.selectedCandidate, 0)
  }

  func testROICrossingsPreviousRivalHandoffsAndLostTargetsRemainTerminal() throws {
    let person = softwarePerson(x: 0.4, y: 0.5, span: 0.2)
    var crossing = Motion3DROITargetTracker()
    _ = try crossing.select(people: [person], timestampMs: 0, aspectRatio: 1)
    XCTAssertEqual(try crossing.select(people: [person, softwarePerson(x: 0.42, y: 0.5, span: 0.2)], timestampMs: 40, aspectRatio: 1).failure, .ambiguous)
    XCTAssertEqual(try crossing.select(people: [person], timestampMs: 80, aspectRatio: 1).failure, .targetLost)
    var handoff = Motion3DROITargetTracker(seed: try Motion3DTargetSeed(x: 0.4, y: 0.5, timestampMs: 0))
    _ = try handoff.select(people: [person, softwarePerson(x: 0.5, y: 0.5, span: 0.2)], timestampMs: 0, aspectRatio: 1)
    XCTAssertEqual(try handoff.select(people: [softwarePerson(x: 0.455, y: 0.5, span: 0.2)], timestampMs: 40, aspectRatio: 1).failure, .ambiguous)
    var lost = Motion3DROITargetTracker()
    _ = try lost.select(people: [person], timestampMs: 0, aspectRatio: 1)
    XCTAssertEqual(try lost.select(people: [], timestampMs: 40, aspectRatio: 1).failure, .targetLost)
    XCTAssertEqual(try lost.select(people: [person], timestampMs: 80, aspectRatio: 1).failure, .targetLost)
  }

  func testROIScaleAndSourceGapGatesStayStrongAndCannotRebind() throws {
    let person = softwarePerson(x: 0.4, y: 0.5, span: 0.15)
    var scale = Motion3DROITargetTracker()
    _ = try scale.select(people: [person], timestampMs: 0, aspectRatio: 1)
    XCTAssertEqual(try scale.select(people: [softwarePerson(x: 0.4, y: 0.5, span: 0.28)], timestampMs: 40, aspectRatio: 1).failure, .targetLost)
    XCTAssertEqual(try scale.select(people: [person], timestampMs: 80, aspectRatio: 1).failure, .targetLost)
    var gap = Motion3DROITargetTracker()
    _ = try gap.select(people: [person], timestampMs: 0, aspectRatio: 1)
    XCTAssertEqual(try gap.select(people: [person], timestampMs: 251, aspectRatio: 1).failure, .targetLost)
    var explicitReset = Motion3DROITargetTracker()
    _ = try explicitReset.select(people: [person], timestampMs: 0, aspectRatio: 1)
    explicitReset.breakContinuity()
    XCTAssertEqual(try explicitReset.select(people: [person], timestampMs: 40, aspectRatio: 1).failure, .targetLost)
  }

  func testROITargetAndInitialBoundsAreCandidateOrderInvariantAndNotLargestOnEveryFrame() throws {
    let person = softwarePerson(x: 0.3, y: 0.55, span: 0.15)
    let smaller = softwarePerson(x: 0.8, y: 0.3, span: 0.08)
    var regions: [Motion3DFixedROI] = []
    for people in [[person, smaller], [smaller, person]] {
      var tracker = Motion3DROITargetTracker()
      let first = try tracker.select(people: people, timestampMs: 0, aspectRatio: 1)
      let selected = try XCTUnwrap(first.selectedCandidate)
      regions.append(try XCTUnwrap(Motion3DFixedROI.selectedPerson(first.people[selected], sourceWidth: 1000, sourceHeight: 1000)))
      let next = try tracker.select(people: [softwarePerson(x: 0.75, y: 0.5, span: 0.28), person], timestampMs: 40, aspectRatio: 1)
      XCTAssertNil(next.failure)
      XCTAssertEqual(next.selectedCandidate, 1)
      XCTAssertEqual(next.trackId, 1)
    }
    XCTAssertEqual(regions[0], regions[1])
  }

  func testFixedROIUsesInitialObservedBodyPaddedIntegerPixelBoundsAndNeverExpands() throws {
    var person = softwarePerson(x: 0.4, y: 0.5, span: 0.2)
    person.extentPoints = [Motion3DImagePoint(x: 0.4, y: 0.3, visibility: 0.9)]
    let roi = try XCTUnwrap(Motion3DFixedROI.selectedPerson(person, sourceWidth: 1000, sourceHeight: 800))
    XCTAssertTrue(roi.contains(person))
    XCTAssertEqual(roi.inference.region.x * 1000, Double(roi.pixelX), accuracy: 1e-10)
    XCTAssertEqual(roi.inference.region.y * 800, Double(roi.pixelY), accuracy: 1e-10)
    XCTAssertEqual(roi.inference.region.width * 1000, Double(roi.pixelWidth), accuracy: 1e-10)
    XCTAssertEqual(roi.inference.region.height * 800, Double(roi.pixelHeight), accuracy: 1e-10)
    let frozen = roi.inference
    XCTAssertFalse(roi.contains(softwarePerson(x: 0.85, y: 0.5, span: 0.2)))
    XCTAssertEqual(roi.inference, frozen)
    let upper = try XCTUnwrap(roi.fullImagePoint(x: 0, y: 0))
    let lower = try XCTUnwrap(roi.fullImagePoint(x: 1, y: 1))
    XCTAssertEqual(upper.x, Double(roi.pixelX) / 1000)
    XCTAssertEqual(lower.y, Double(roi.pixelY + roi.pixelHeight) / 800)
    XCTAssertNil(roi.fullImagePoint(x: -0.1, y: 0.5))
    XCTAssertNil(roi.fullImagePoint(x: .nan, y: 0.5))
  }

  func testROIRequiresInitialBodySupportAndEnforcesPixelMemoryBounds() throws {
    var missingAnkle = softwarePerson(x: 0.4, y: 0.5, span: 0.2).points
    missingAnkle.removeValue(forKey: .leftAnkle)
    XCTAssertNil(try Motion3DFixedROI.selectedPerson(Motion3DPerson2D(points: missingAnkle), sourceWidth: 1000, sourceHeight: 800))
    assertFailure(.invalidOptions) { try Motion3DFixedROI(sourceWidth: 100, sourceHeight: 100, pixelX: -1, pixelY: 0, pixelWidth: 20, pixelHeight: 20) }
    assertFailure(.invalidOptions) { try Motion3DFixedROI(sourceWidth: 100, sourceHeight: 100, pixelX: 90, pixelY: 0, pixelWidth: 20, pixelHeight: 20) }
    assertFailure(.exceedsLimits) { try Motion3DFixedROI(sourceWidth: 4096, sourceHeight: 4096, pixelX: 0, pixelY: 0, pixelWidth: 2049, pixelHeight: 20) }
    assertFailure(.exceedsLimits) { try Motion3DFixedROI(sourceWidth: 4096, sourceHeight: 4096, pixelX: 0, pixelY: 0, pixelWidth: 2048, pixelHeight: 2048) }
  }

  func testROIRenderingMatchesEverySourcePixelForAllEightOrientationsAndReflectionsWithOriginalPTS() throws {
    let pts = CMTime(value: 12345, timescale: 90000)
    let sample = try softwareColorSample(pts: pts)
    let source = try XCTUnwrap(CMSampleBufferGetImageBuffer(sample))
    let before = try bgraBytes(source)
    let orientations: [CGImagePropertyOrientation] = [.up, .upMirrored, .down, .downMirrored, .leftMirrored, .right, .rightMirrored, .left]
    for orientation in orientations {
      let swapped = [CGImagePropertyOrientation.leftMirrored, .right, .rightMirrored, .left].contains(orientation)
      let roi = try Motion3DFixedROI(sourceWidth: swapped ? 96 : 64, sourceHeight: swapped ? 64 : 96, pixelX: 7, pixelY: 11, pixelWidth: 32, pixelHeight: 40)
      let rendered = try Motion3DROIRenderer(roi: roi).render(sampleBuffer: sample, orientation: orientation)
      let actualPTS = CMSampleBufferGetPresentationTimeStamp(rendered)
      XCTAssertEqual(actualPTS.value, pts.value)
      XCTAssertEqual(actualPTS.timescale, pts.timescale)
      XCTAssertEqual(CMSampleBufferGetDuration(rendered), CMSampleBufferGetDuration(sample))
      let pixels = try XCTUnwrap(CMSampleBufferGetImageBuffer(rendered))
      XCTAssertEqual(CVPixelBufferGetWidth(pixels), 32)
      XCTAssertEqual(CVPixelBufferGetHeight(pixels), 40)
      XCTAssertNil(CMGetAttachment(rendered, key: kCMSampleBufferAttachmentKey_CameraIntrinsicMatrix, attachmentModeOut: nil))
      let bytes = try bgraBytes(pixels)
      for y in 0..<40 {
        for x in 0..<32 {
          let dx = x + roi.pixelX
          let dy = y + roi.pixelY
          let sensor: (Int, Int)
          switch orientation {
          case .up: sensor = (dx, dy)
          case .upMirrored: sensor = (63 - dx, dy)
          case .down: sensor = (63 - dx, 95 - dy)
          case .downMirrored: sensor = (dx, 95 - dy)
          case .leftMirrored: sensor = (dy, dx)
          case .right: sensor = (dy, 95 - dx)
          case .rightMirrored: sensor = (63 - dy, 95 - dx)
          case .left: sensor = (63 - dy, dx)
          @unknown default: throw Motion3DFailure.invalidSource
          }
          let expected = [sensor.0 * 3, sensor.1 * 2, (sensor.0 + 2 * sensor.1) % 256, 255]
          for channel in 0..<4 { XCTAssertLessThanOrEqual(abs(Int(bytes[(y * 32 + x) * 4 + channel]) - expected[channel]), 1) }
        }
      }
    }
    XCTAssertEqual(try bgraBytes(source), before)
  }

  func testROIPixelPoolHasABoundedNumberOfRetainedBuffers() throws {
    let sample = try softwareColorSample(pts: .zero)
    let roi = try Motion3DFixedROI(sourceWidth: 64, sourceHeight: 96, pixelX: 0, pixelY: 0, pixelWidth: 32, pixelHeight: 40)
    let renderer = try Motion3DROIRenderer(roi: roi)
    let first = try renderer.render(sampleBuffer: sample, orientation: .up)
    let second = try renderer.render(sampleBuffer: sample, orientation: .up)
    withExtendedLifetime([first, second]) {
      assertFailure(.exceedsLimits) { try renderer.render(sampleBuffer: sample, orientation: .up) }
    }
  }

  func testROIProjectionMappingRetainsRawXYZAndInferenceCameraButAssociatesInFullSource() throws {
    let target = softwarePerson(x: 0.35, y: 0.5, span: 0.15)
    let rival = softwarePerson(x: 0.65, y: 0.45, span: 0.1)
    let roi = try Motion3DFixedROI(sourceWidth: 1000, sourceHeight: 800, pixelX: 100, pixelY: 100, pixelWidth: 800, pixelHeight: 680)
    var tracker = Motion3DROITargetTracker()
    let selection = try tracker.select(people: [rival, target], timestampMs: 0, aspectRatio: 1.25)
    let local = projectionInROI(target, roi: roi)
    let mapped = roi.mapped(local)
    XCTAssertEqual(mapped.joints.map(\.x), local.joints.map(\.x))
    XCTAssertEqual(mapped.joints.map(\.y), local.joints.map(\.y))
    XCTAssertEqual(mapped.joints.map(\.z), local.joints.map(\.z))
    XCTAssertEqual(mapped.cameraOriginMatrix, local.cameraOriginMatrix)
    let match = Motion3DProjectionAssociation.associate(selection: selection, estimates: [mapped])
    XCTAssertEqual(match.status, .estimated)
    XCTAssertLessThan(try XCTUnwrap(match.association?.reprojectionError), 1e-12)
    let wrong = Motion3DProjectionAssociation.associate(selection: selection, estimates: [roi.mapped(projectionInROI(rival, roi: roi))])
    XCTAssertEqual(wrong.association?.status, .wrongPlayer)
    XCTAssertTrue(wrong.joints.isEmpty)
    XCTAssertNil(wrong.cameraOriginMatrix)
  }

  func testROIHeaderIsOnlyAdmittedForTheNewConfigurationAndNeverInventedWhenUnselected() throws {
    let person = softwarePerson(x: 0.4, y: 0.5, span: 0.2)
    let roi = try XCTUnwrap(Motion3DFixedROI.selectedPerson(person, sourceWidth: 1080, sourceHeight: 1920))
    var tracker = Motion3DROITargetTracker()
    let selected = try tracker.select(people: [person], timestampMs: 0, aspectRatio: 1080.0 / 1920)
    let sample = Motion3DProjectionAssociation.associate(selection: selected, estimates: [softwareProjection(person)])
    let frame = Motion3DFrame(stamp: Motion3DFrameStamp(frameIndex: 0, pts: .zero), segmentId: 0, sample: sample)
    let identity = Motion3DIdentityPolicy(seed: nil, roi: true)
    XCTAssertLessThanOrEqual(identity.parameters.count, 32)
    XCTAssertTrue(identity.parameters.values.allSatisfy { $0.isFinite && $0 >= 0 && $0 <= 1_000_000 })
    var builder = try Motion3DJSONBuilder(source: softwareSource(), osVersion: "software-test-only", identityPolicy: identity)
    try builder.append(frame)
    let receipt = try builder.finish(inference: roi.inference)
    XCTAssertEqual(receipt.sha256, digest(Data(receipt.json.utf8)))
    let json = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(receipt.json.utf8)) as? [String: Any])
    XCTAssertEqual(json["schemaVersion"] as? Int, 2)
    XCTAssertEqual(json["format"] as? String, "pickle.motion-3d.v2")
    XCTAssertEqual((json["estimator"] as? [String: Any])?["configurationVersion"] as? String, "apple-vision-3d-associated-roi-3")
    XCTAssertEqual((json["identityPolicy"] as? [String: Any])?["version"] as? String, "motion-target-association-2")
    let inference = try XCTUnwrap(json["inference"] as? [String: Any])
    XCTAssertEqual(Set(inference.keys), Set(["mode", "coordinateSystem", "region", "pixelWidth", "pixelHeight", "cameraModelSpace", "transformVersion"]))
    XCTAssertEqual(inference["mode"] as? String, "fixed_roi")
    XCTAssertEqual(inference["cameraModelSpace"] as? String, "inference_camera")
    XCTAssertEqual(inference["transformVersion"] as? String, "motion-inference-roi-1")
    var missing = try Motion3DJSONBuilder(source: softwareSource(), identityPolicy: identity)
    try missing.append(frame)
    assertFailure(.unavailable) { try missing.finish() }
    var legacy = try Motion3DJSONBuilder(source: softwareSource(), identityPolicy: Motion3DIdentityPolicy(seed: nil))
    try legacy.append(frame)
    assertFailure(.decodingFailed) { try legacy.finish(inference: roi.inference) }
    let legacyReceipt = try legacy.finish()
    let legacyJSON = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(legacyReceipt.json.utf8)) as? [String: Any])
    XCTAssertNil(legacyJSON["inference"])
    XCTAssertEqual((legacyJSON["estimator"] as? [String: Any])?["configurationVersion"] as? String, "apple-vision-3d-associated-2")
    XCTAssertEqual((legacyJSON["identityPolicy"] as? [String: Any])?["version"] as? String, "motion-target-association-1")
  }

  func testROIActualDecoderKeepsSourceHashOriginalRationalPTSAndFullOrientedDimensions() throws {
    let url = try writeSoftwareVideo()
    let bytes = try Data(contentsOf: url)
    let person = softwarePerson(x: 0.4, y: 0.5, span: 0.2)
    let seed = try Motion3DTargetSeed(x: 0.4, y: 0.5, timestampMs: 1000.0 / 30)
    var tracker = Motion3DROITargetTracker(seed: seed)
    var renderer: Motion3DROIRenderer?
    var seen: [CMTime] = []
    let receipt = try Motion3DVideoReconstruction.run(
      videoURL: url, captureId: "software-roi-decoder", cancellation: Motion3DCancellation(), identityPolicy: Motion3DIdentityPolicy(seed: seed, roi: true),
      inference: { renderer?.roi.inference }, progress: { _ in }, reset: { tracker.breakContinuity() }, estimate: { source, orientation in
        XCTAssertEqual(orientation, .right)
        let pts = CMSampleBufferGetPresentationTimeStamp(source)
        seen.append(pts)
        let selection = try tracker.select(people: [person], timestampMs: Double(pts.value) * 1000 / Double(pts.timescale), aspectRatio: 1.5)
        if let failure = selection.failure { return selection.rejected(failure) }
        if renderer == nil { renderer = try Motion3DROIRenderer(roi: XCTUnwrap(Motion3DFixedROI.selectedPerson(person, sourceWidth: 96, sourceHeight: 64))) }
        let renderer = try XCTUnwrap(renderer)
        let cropped = try renderer.render(sampleBuffer: source, orientation: orientation)
        let croppedPTS = CMSampleBufferGetPresentationTimeStamp(cropped)
        XCTAssertEqual(croppedPTS.value, pts.value)
        XCTAssertEqual(croppedPTS.timescale, pts.timescale)
        return Motion3DProjectionAssociation.associate(selection: selection, estimates: [renderer.roi.mapped(self.projectionInROI(person, roi: renderer.roi))])
      }
    )
    let json = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(receipt.json.utf8)) as? [String: Any])
    let source = try XCTUnwrap(json["source"] as? [String: Any])
    XCTAssertEqual(source["videoSha256"] as? String, digest(bytes))
    XCTAssertEqual(source["width"] as? Int, 96)
    XCTAssertEqual(source["height"] as? Int, 64)
    XCTAssertEqual(source["preferredTransform"] as? [Double], [0, 1, -1, 0, 96, 0])
    let frames = try XCTUnwrap(json["frames"] as? [[String: Any]])
    XCTAssertEqual(frames.map { $0["frameIndex"] as? Int }, [0, 2, 4])
    XCTAssertEqual(frames.map { $0["status"] as? String }, ["unavailable", "estimated", "estimated"])
    for (frame, pts) in zip(frames, seen) {
      XCTAssertEqual(frame["ptsValue"] as? Int64, pts.value)
      XCTAssertEqual(frame["ptsTimescale"] as? Int32, pts.timescale)
    }
    XCTAssertEqual(try Data(contentsOf: url), bytes)
    XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: directory.path), [url.lastPathComponent])
  }

  private func measuredCropPerson(frameThree: Bool) -> Motion3DPerson2D {
    let names: [Motion3DJointName] = [.leftShoulder, .rightShoulder, .leftElbow, .rightElbow, .leftWrist, .rightWrist, .leftHip, .rightHip, .leftKnee, .rightKnee, .leftAnkle, .rightAnkle]
    let before: [[Double]] = [
      [0.31046298146247864, 0.24837100505828857, 0.53515625], [0.54844015836715698, 0.23388266563415527, 0.485595703125],
      [0.27705880999565125, 0.41420996189117432, 0.58642578125], [0.67960715293884277, 0.38344573974609375, 0.748046875],
      [0.24871747195720673, 0.41264474391937256, 0.462890625], [0, 0, 0],
      [0.4049299955368042, 0.50532925128936768, 0.226318359375], [0.63379788398742676, 0.47732597589492798, 0.357666015625],
      [0.21293914318084717, 0.614693284034729, 0.6865234375], [0.70852667093276978, 0.63268524408340454, 0.5537109375],
      [0.13482272624969482, 0.86939841508865356, 0.642578125], [0.84072601795196533, 0.86121112108230591, 0.67138671875],
    ]
    let after: [[Double]] = [
      [0.29159656167030334, 0.25317978858947754, 0.55224609375], [0.53582316637039185, 0.24103224277496338, 0.53857421875],
      [0.26728883385658264, 0.41830641031265259, 0.634765625], [0.66231685876846313, 0.38894915580749512, 0.734375],
      [0.22913864254951477, 0.42089879512786865, 0.53125], [0, 0, 0],
      [0.38764074444770813, 0.50657427310943604, 0.193603515625], [0.63106197118759155, 0.48131412267684937, 0.39697265625],
      [0.20940949022769928, 0.60947024822235107, 0.6611328125], [0.70326977968215942, 0.63644379377365112, 0.57421875],
      [0.13186798989772797, 0.86646360158920288, 0.66015625], [0.84128046035766602, 0.86106455326080322, 0.65576171875],
    ]
    return Motion3DPerson2D(points: Dictionary(uniqueKeysWithValues: zip(names, frameThree ? after : before).map { name, p in
      (name, Motion3DImagePoint(x: p[0], y: p[1], visibility: p[2]))
    }))
  }

  private func projectionInROI(_ person: Motion3DPerson2D, roi: Motion3DFixedROI) -> Motion3DObservationSample {
    let full = softwareProjection(person)
    let region = roi.inference.region
    return replacingJoints(full, full.joints.map {
      Motion3DJoint(name: $0.name, x: $0.x, y: $0.y, z: $0.z, imageX: ($0.imageX - region.x) / region.width, imageY: ($0.imageY - region.y) / region.height, visibility2D: nil)
    })
  }

  private func softwareColorSample(pts: CMTime) throws -> CMSampleBuffer {
    var pixels: CVPixelBuffer?
    XCTAssertEqual(CVPixelBufferCreate(kCFAllocatorDefault, 64, 96, kCVPixelFormatType_32BGRA, [kCVPixelBufferIOSurfacePropertiesKey: [:]] as CFDictionary, &pixels), kCVReturnSuccess)
    let buffer = try XCTUnwrap(pixels)
    CVBufferSetAttachment(buffer, kCVImageBufferCGColorSpaceKey, CGColorSpaceCreateDeviceRGB(), .shouldPropagate)
    CVPixelBufferLockBaseAddress(buffer, [])
    let base = try XCTUnwrap(CVPixelBufferGetBaseAddress(buffer)).assumingMemoryBound(to: UInt8.self)
    let stride = CVPixelBufferGetBytesPerRow(buffer)
    for y in 0..<96 {
      for x in 0..<64 {
        let offset = y * stride + x * 4
        base[offset] = UInt8(x * 3)
        base[offset + 1] = UInt8(y * 2)
        base[offset + 2] = UInt8((x + 2 * y) % 256)
        base[offset + 3] = 255
      }
    }
    CVPixelBufferUnlockBaseAddress(buffer, [])
    var format: CMVideoFormatDescription?
    XCTAssertEqual(CMVideoFormatDescriptionCreateForImageBuffer(allocator: kCFAllocatorDefault, imageBuffer: buffer, formatDescriptionOut: &format), noErr)
    var timing = CMSampleTimingInfo(duration: CMTime(value: 1, timescale: 25), presentationTimeStamp: pts, decodeTimeStamp: .invalid)
    var sample: CMSampleBuffer?
    XCTAssertEqual(CMSampleBufferCreateReadyWithImageBuffer(allocator: kCFAllocatorDefault, imageBuffer: buffer, formatDescription: try XCTUnwrap(format), sampleTiming: &timing, sampleBufferOut: &sample), noErr)
    let result = try XCTUnwrap(sample)
    CMSetAttachment(result, key: kCMSampleBufferAttachmentKey_CameraIntrinsicMatrix, value: Data(repeating: 7, count: 36) as CFData, attachmentMode: kCMAttachmentMode_ShouldPropagate)
    return result
  }

  private func bgraBytes(_ pixels: CVPixelBuffer) throws -> [UInt8] {
    XCTAssertEqual(CVPixelBufferGetPixelFormatType(pixels), kCVPixelFormatType_32BGRA)
    CVPixelBufferLockBaseAddress(pixels, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(pixels, .readOnly) }
    let base = try XCTUnwrap(CVPixelBufferGetBaseAddress(pixels))
    var result = Data()
    for row in 0..<CVPixelBufferGetHeight(pixels) {
      result.append(Data(bytes: base.advanced(by: row * CVPixelBufferGetBytesPerRow(pixels)), count: CVPixelBufferGetWidth(pixels) * 4))
    }
    return Array(result)
  }

  private func pixelDigest(_ sample: CMSampleBuffer) throws -> String {
    let pixels = try XCTUnwrap(CMSampleBufferGetImageBuffer(sample))
    XCTAssertEqual(CVPixelBufferGetPixelFormatType(pixels), kCVPixelFormatType_420YpCbCr8BiPlanarFullRange)
    XCTAssertEqual(CVPixelBufferLockBaseAddress(pixels, .readOnly), kCVReturnSuccess)
    defer { CVPixelBufferUnlockBaseAddress(pixels, .readOnly) }
    XCTAssertEqual(CVPixelBufferGetPlaneCount(pixels), 2)
    var hasher = SHA256()
    for plane in 0..<CVPixelBufferGetPlaneCount(pixels) {
      let base = try XCTUnwrap(CVPixelBufferGetBaseAddressOfPlane(pixels, plane))
      let stride = CVPixelBufferGetBytesPerRowOfPlane(pixels, plane)
      let rowBytes = CVPixelBufferGetWidthOfPlane(pixels, plane) * (plane == 0 ? 1 : 2)
      for row in 0..<CVPixelBufferGetHeightOfPlane(pixels, plane) {
        hasher.update(data: Data(bytes: base.advanced(by: row * stride), count: rowBytes))
      }
    }
    return hasher.finalize().map { String(format: "%02x", $0) }.joined()
  }

  private func softwarePerson(x: Double, y: Double, span: Double, visibility: Double = 0.9) -> Motion3DPerson2D {
    let offsets: [(Motion3DJointName, Double, Double)] = [
      (.leftShoulder, -0.25, -0.5), (.rightShoulder, 0.25, -0.5),
      (.leftElbow, -0.4, -0.1), (.rightElbow, 0.4, -0.1), (.leftWrist, -0.5, 0.2), (.rightWrist, 0.5, 0.2),
      (.leftHip, -0.2, 0.5), (.rightHip, 0.2, 0.5), (.leftKnee, -0.2, 1), (.rightKnee, 0.2, 1),
      (.leftAnkle, -0.2, 1.4), (.rightAnkle, 0.2, 1.4), (.root, 0, 0.5),
    ]
    return Motion3DPerson2D(points: Dictionary(uniqueKeysWithValues: offsets.map { name, dx, dy in
      (name, Motion3DImagePoint(x: x + dx * span, y: y + dy * span, visibility: visibility))
    }))
  }

  private func softwareProjection(_ person: Motion3DPerson2D, dx: Double = 0) -> Motion3DObservationSample {
    let joints = Motion3DJointName.allCases.compactMap { name -> Motion3DJoint? in
      guard let point = person.points[name] else { return nil }
      return Motion3DJoint(name: name, x: 0.1, y: 0.2, z: -0.3, imageX: point.x + dx, imageY: point.y, visibility2D: nil)
    }
    return replacingJoints(softwareEstimate(), joints)
  }

  private func replacingJoints(_ sample: Motion3DObservationSample, _ joints: [Motion3DJoint]) -> Motion3DObservationSample {
    Motion3DObservationSample(status: sample.status, observationConfidence: sample.observationConfidence, height: sample.height, cameraOriginMatrix: sample.cameraOriginMatrix, joints: joints)
  }

  private func softwareEstimate() -> Motion3DObservationSample {
    Motion3DObservationSample(
      status: .estimated, observationConfidence: 0.91,
      height: Motion3DHeight(meters: 1.8, source: .reference),
      cameraOriginMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 2, 1],
      joints: [Motion3DJoint(name: .root, x: 0, y: 0, z: 0, imageX: 0.5, imageY: 0.5, visibility2D: nil)]
    )
  }

  private func softwareSource(captureId: String = "software-only-capture") -> Motion3DSource {
    Motion3DSource(
      captureId: captureId, videoSha256: String(repeating: "a", count: 64), videoByteLength: 1000,
      width: 1080, height: 1920, durationMs: 60_000, nominalFrameRate: 30,
      preferredTransform: [1, 0, 0, 1, 0, 0]
    )
  }

  private func object<T: Encodable>(_ value: T) throws -> [String: Any] {
    try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(value)) as? [String: Any])
  }

  private func digest(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
  }

  private func assertFailure<T>(
    _ failure: Motion3DFailure, file: StaticString = #filePath, line: UInt = #line, _ operation: () throws -> T
  ) {
    do {
      _ = try operation()
      XCTFail("Expected \(failure.rawValue).", file: file, line: line)
    } catch { XCTAssertEqual(error as? Motion3DFailure, failure, file: file, line: line) }
  }

  private func writeSoftwareVideo() throws -> URL {
    let url = directory.appendingPathComponent("software-video.mov")
    let writer = try AVAssetWriter(outputURL: url, fileType: .mov)
    let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
      AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: 64, AVVideoHeightKey: 96,
      AVVideoCompressionPropertiesKey: [AVVideoAllowFrameReorderingKey: false, AVVideoExpectedSourceFrameRateKey: 60],
    ])
    input.expectsMediaDataInRealTime = false
    input.transform = CGAffineTransform(a: 0, b: 1, c: -1, d: 0, tx: 96, ty: 0)
    let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
      kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
      kCVPixelBufferWidthKey as String: 64, kCVPixelBufferHeightKey as String: 96,
    ])
    XCTAssertTrue(writer.canAdd(input))
    writer.add(input)
    XCTAssertTrue(writer.startWriting())
    writer.startSession(atSourceTime: .zero)
    var pixels: CVPixelBuffer?
    XCTAssertEqual(CVPixelBufferCreate(kCFAllocatorDefault, 64, 96, kCVPixelFormatType_32BGRA, nil, &pixels), kCVReturnSuccess)
    let buffer = try XCTUnwrap(pixels)
    CVPixelBufferLockBaseAddress(buffer, [])
    memset(CVPixelBufferGetBaseAddress(buffer), 0, CVPixelBufferGetDataSize(buffer))
    CVPixelBufferUnlockBaseAddress(buffer, [])
    let deadline = ProcessInfo.processInfo.systemUptime + 5
    for index in 0..<6 {
      while !input.isReadyForMoreMediaData, ProcessInfo.processInfo.systemUptime < deadline { Thread.sleep(forTimeInterval: 0.001) }
      XCTAssertTrue(input.isReadyForMoreMediaData)
      XCTAssertTrue(adaptor.append(buffer, withPresentationTime: CMTime(value: Int64(index), timescale: 60)))
    }
    input.markAsFinished()
    let finished = DispatchSemaphore(value: 0)
    writer.finishWriting { finished.signal() }
    XCTAssertEqual(finished.wait(timeout: .now() + 5), .success)
    XCTAssertEqual(writer.status, .completed)
    return url
  }
}
