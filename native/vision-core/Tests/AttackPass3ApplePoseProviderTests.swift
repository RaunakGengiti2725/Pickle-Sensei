import AVFoundation
import CoreGraphics
import CoreVideo
import Foundation
import Vision
import XCTest

@testable import PickleVisionCore

// PASS 3 adversarial suite against ApplePoseProvider (native/vision-core).
// Scenarios S22–S27 from the production-readiness review. Every test records
// what it observed into the attack-pass3 JSON report (see
// AttackPass3VisionSupport.swift) so the classification BROKEN / HELD is made
// from Mac artifacts, never from Linux.
//
// Requires Apple Vision: runs under `swift test`, `xcodebuild test`
// (macOS) and `xcodebuild test` (iOS Simulator) in
// scripts/mac-full-verify.sh. Clip-backed tests skip with XCTSkip when the
// committed clip is absent so they never turn a missing dataset into a pass.
final class AttackPass3ApplePoseProviderTests: XCTestCase {
  static let report = AttackPass3Report(suite: "AttackPass3ApplePoseProvider")

  override class func tearDown() {
    report.flush()
    super.tearDown()
  }

  /// `#function` yields "testFoo()"; the report keys tests by bare name.
  private func record(_ fields: [String: Any], function: String = #function) {
    let name = function.hasSuffix("()") ? String(function.dropLast(2)) : function
    Self.report.record(name, fields)
  }

  private func requireClip() throws {
    if !AttackPass3.clipExists() {
      record(["skipped": true, "reason": "committed clip missing", "path": AttackPass3.committedClip.path])
      throw XCTSkip("committed clip missing at \(AttackPass3.committedClip.path)")
    }
  }

  // MARK: S22 — empty scene must map to the typed no-person error

  func testS22_blackFrameThrowsTypedNoPersonDetected() throws {
    let provider = ApplePoseProvider()
    let buffer = try AttackPass3.makeSolidBGRA(width: 64, height: 64, blue: 0, green: 0, red: 0)
    var thrown: Error?
    var returned: PoseFrame?
    do {
      returned = try provider.extractPose(pixelBuffer: buffer, timestampMs: 0)
    } catch {
      thrown = error
    }
    record([
      "size": "64x64", "format": "BGRA", "fill": "black",
      "threw": thrown != nil,
      "error": AttackPass3.orNull(thrown.map(AttackPass3.describe)),
      "returnedLandmarks": returned?.landmarks.count ?? -1,
      "anchorAfter": AttackPass3.orNull(provider.primaryPersonAnchorForTesting.map { [Double($0.x), Double($0.y)] }),
    ])
    XCTAssertNil(returned, "black frame must not yield a PoseFrame (got \(returned?.landmarks.count ?? 0) landmarks)")
    guard let error = thrown else { return }
    XCTAssertTrue(
      AttackPass3.isNoPersonDetected(error),
      "expected VisionFailure.lowConfidence(\"no person detected\"), got \(AttackPass3.describe(error))"
    )
    XCTAssertNil(provider.primaryPersonAnchorForTesting, "a miss must not write the temporal anchor")
  }

  /// Same attack across the other empty scenes the phone can vend: white,
  /// mid-grey, a saturated single colour, a larger 640x480 black frame, and
  /// the extractAllPoses sibling (which must return [] rather than throw).
  func testS22_otherEmptyScenesStayTyped() throws {
    let provider = ApplePoseProvider()
    let scenes: [(String, Int, Int, UInt8, UInt8, UInt8)] = [
      ("white-64", 64, 64, 255, 255, 255),
      ("grey-64", 64, 64, 128, 128, 128),
      ("red-64", 64, 64, 0, 0, 255),
      ("black-640x480", 640, 480, 0, 0, 0),
      ("black-1080x1920", 1080, 1920, 0, 0, 0),
      ("black-16x16", 16, 16, 0, 0, 0),
    ]
    var rows: [[String: Any]] = []
    for (label, width, height, blue, green, red) in scenes {
      let buffer = try AttackPass3.makeSolidBGRA(width: width, height: height, blue: blue, green: green, red: red)
      var thrown: Error?
      var frame: PoseFrame?
      do { frame = try provider.extractPose(pixelBuffer: buffer, timestampMs: 1) } catch { thrown = error }
      let everyone = try? provider.extractAllPoses(pixelBuffer: buffer, timestampMs: 1)
      rows.append([
        "scene": label,
        "threw": thrown != nil,
        "typedNoPerson": thrown.map(AttackPass3.isNoPersonDetected) ?? false,
        "error": AttackPass3.orNull(thrown.map(AttackPass3.describe)),
        "frameLandmarks": frame?.landmarks.count ?? -1,
        "extractAllPosesCount": everyone?.count ?? -1,
      ])
      XCTAssertNil(frame, "\(label): empty scene returned a PoseFrame")
      if let thrown {
        XCTAssertTrue(AttackPass3.isNoPersonDetected(thrown), "\(label): \(AttackPass3.describe(thrown))")
      }
      XCTAssertEqual(everyone?.count, 0, "\(label): extractAllPoses must return [] for an empty scene")
    }
    record(["scenes": rows])
  }

  // MARK: S23 — degenerate buffers: throw (never trap); Vision errors escape the typed set

  func testS23_onePixelBufferThrowsWithoutTrapping() throws {
    let provider = ApplePoseProvider()
    let buffer = try AttackPass3.makeSolidBGRA(width: 1, height: 1, blue: 0, green: 0, red: 0)
    var thrown: Error?
    var returned: PoseFrame?
    do { returned = try provider.extractPose(pixelBuffer: buffer, timestampMs: 0) } catch { thrown = error }
    let described = AttackPass3.orNull(thrown.map(AttackPass3.describe))
    record([
      "size": "1x1", "format": "BGRA",
      "threw": thrown != nil,
      "returnedLandmarks": returned?.landmarks.count ?? -1,
      "error": described,
      "escapesTypedErrorSet": thrown.map { !($0 is VisionFailure) } ?? false,
    ])
    XCTAssertNil(returned, "1x1 buffer must not produce a PoseFrame")
    XCTAssertNotNil(thrown, "1x1 buffer must throw")
    guard let thrown else { return }
    // The scenario's documented expectation: Vision rejects the image with
    // a VNErrorDomain error and ApplePoseProvider rethrows it untyped. If
    // Vision instead runs and finds nobody, the typed lowConfidence surfaces
    // — record which one happened; both are "throws, no trap".
    if !(thrown is VisionFailure) {
      XCTAssertEqual((thrown as NSError).domain, VNErrorDomain, "untyped error should come from Vision: \(described)")
    }
  }

  /// Every pixel format Vision does not accept must surface as a thrown
  /// error (never a trap, never a PoseFrame). Formats are visited in a
  /// seeded order and the buffer is zero-filled. At least one format must
  /// produce a non-VisionFailure error, documenting that raw Vision errors
  /// escape the package's typed error set.
  func testS23_unsupportedPixelFormatsThrowUntypedVisionErrors() throws {
    let provider = ApplePoseProvider()
    var candidates: [(String, OSType)] = [
      ("16LE555", kCVPixelFormatType_16LE555),
      ("16BE565", kCVPixelFormatType_16BE565),
      ("24RGB", kCVPixelFormatType_24RGB),
      ("24BGR", kCVPixelFormatType_24BGR),
      ("422YpCbCr8", kCVPixelFormatType_422YpCbCr8),
      ("4444YpCbCrA8", kCVPixelFormatType_4444YpCbCrA8),
      ("444YpCbCr8", kCVPixelFormatType_444YpCbCr8),
      ("422YpCbCr16", kCVPixelFormatType_422YpCbCr16),
      ("OneComponent16Half", kCVPixelFormatType_OneComponent16Half),
      ("OneComponent32Float", kCVPixelFormatType_OneComponent32Float),
      ("TwoComponent8", kCVPixelFormatType_TwoComponent8),
      ("64RGBAHalf", kCVPixelFormatType_64RGBAHalf),
      ("128RGBAFloat", kCVPixelFormatType_128RGBAFloat),
      ("DepthFloat32", kCVPixelFormatType_DepthFloat32),
      ("DisparityFloat16", kCVPixelFormatType_DisparityFloat16),
      ("1Monochrome", kCVPixelFormatType_1Monochrome),
      ("8Indexed", kCVPixelFormatType_8Indexed),
    ]
    var rng = AttackPass3Rng(seed: AttackPass3.seed)
    // Fisher–Yates with the recorded seed so the visit order is replayable.
    for index in stride(from: candidates.count - 1, to: 0, by: -1) {
      candidates.swapAt(index, rng.nextIndex(below: index + 1))
    }
    var rows: [[String: Any]] = []
    var untypedErrors = 0
    var typedErrors = 0
    var accepted = 0
    var uncreatable = 0
    for (label, format) in candidates {
      let (created, status) = AttackPass3.makeBuffer(width: 64, height: 64, format: format)
      guard let buffer = created, status == kCVReturnSuccess else {
        uncreatable += 1
        rows.append(["format": label, "fourcc": AttackPass3.fourCC(format), "cvReturn": Int(status), "outcome": "CVPixelBufferCreate failed"])
        continue
      }
      AttackPass3.zeroFill(buffer)
      var thrown: Error?
      var returned: PoseFrame?
      do { returned = try provider.extractPose(pixelBuffer: buffer, timestampMs: 0) } catch { thrown = error }
      var row: [String: Any] = ["format": label, "fourcc": AttackPass3.fourCC(format), "cvReturn": 0]
      if let thrown {
        row["error"] = AttackPass3.describe(thrown)
        if thrown is VisionFailure {
          typedErrors += 1
          row["outcome"] = "typed VisionFailure"
        } else {
          untypedErrors += 1
          row["outcome"] = "untyped error escaped"
        }
      } else {
        accepted += 1
        row["outcome"] = "PoseFrame returned"
        row["returnedLandmarks"] = returned?.landmarks.count ?? -1
      }
      rows.append(row)
      XCTAssertNil(returned, "\(label): zero-filled buffer produced a PoseFrame with \(returned?.landmarks.count ?? 0) landmarks")
    }
    record([
      "formats": rows, "untypedErrors": untypedErrors, "typedErrors": typedErrors,
      "accepted": accepted, "uncreatable": uncreatable, "visitOrder": candidates.map { $0.0 },
    ])
    XCTAssertGreaterThan(
      candidates.count - uncreatable, 0, "no candidate format could be allocated — scenario not exercised"
    )
    XCTAssertGreaterThan(
      untypedErrors, 0,
      "expected at least one raw Vision error to escape ApplePoseProvider's typed VisionFailure set; observed none (formats: \(rows))"
    )
  }

  /// Zero-area buffers and a very large (4096x4096) black buffer: allocation
  /// may fail (recorded), but whatever Vision receives must throw or return
  /// nobody — never trap.
  func testS23_zeroAreaAndHugeBuffersDoNotTrap() throws {
    let provider = ApplePoseProvider()
    var rows: [[String: Any]] = []
    for (label, width, height) in [("0x0", 0, 0), ("0x64", 0, 64), ("64x0", 64, 0), ("4096x4096", 4096, 4096), ("2x2", 2, 2), ("7x3", 7, 3)] {
      let (created, status) = AttackPass3.makeBuffer(width: width, height: height, format: kCVPixelFormatType_32BGRA)
      guard let buffer = created, status == kCVReturnSuccess else {
        rows.append(["size": label, "cvReturn": Int(status), "outcome": "CVPixelBufferCreate failed"])
        continue
      }
      AttackPass3.zeroFill(buffer)
      var thrown: Error?
      var returned: PoseFrame?
      let start = Date()
      do { returned = try provider.extractPose(pixelBuffer: buffer, timestampMs: 0) } catch { thrown = error }
      rows.append([
        "size": label, "cvReturn": 0, "wallMs": Int(Date().timeIntervalSince(start) * 1000),
        "threw": thrown != nil, "error": AttackPass3.orNull(thrown.map(AttackPass3.describe)),
        "returnedLandmarks": returned?.landmarks.count ?? -1,
      ])
      XCTAssertNil(returned, "\(label): degenerate black buffer produced a PoseFrame")
      XCTAssertNotNil(thrown, "\(label): degenerate black buffer must throw")
    }
    record(["buffers": rows])
  }

  // MARK: S24 — extractPose vs extractAllPoses(maxPeople: 1) on the committed clip

  @available(macOS 13.0, iOS 16.0, *)
  private func sampledClipFrames(count: Int, stride: Int) async throws -> [(index: Int, timestampMs: Int, buffer: CVPixelBuffer)] {
    let reader = try await AttackPass3ClipReader(url: AttackPass3.committedClip)
    defer { reader.cancel() }
    var frames: [(index: Int, timestampMs: Int, buffer: CVPixelBuffer)] = []
    var index = 0
    while frames.count < count, let frame = reader.next() {
      if index % stride == 0 {
        let copy = try AttackPass3.copyBGRA(frame.buffer)
        frames.append((index: index, timestampMs: frame.timestampMs, buffer: copy))
      }
      index += 1
    }
    return frames
  }

  func testS24_extractPoseMatchesExtractAllPosesTopPersonOnCommittedClip() async throws {
    try requireClip()
    guard #available(macOS 13.0, iOS 16.0, *) else { throw XCTSkip("AVAssetReaderVideoCompositionOutput async API unavailable") }
    let provider = ApplePoseProvider()
    // 40 frames spread over the first 480 decoded frames (12 fps → 40 s).
    let frames = try await sampledClipFrames(count: 40, stride: 12)
    XCTAssertGreaterThanOrEqual(frames.count, 20, "clip yielded too few frames")
    var compared = 0
    var exact = 0
    var mismatchedLandmarkSets = 0
    var maxCoord = 0.0
    var maxVisibility = 0.0
    var maxConfidence = 0.0
    var singleMisses = 0
    var everyoneEmpty = 0
    var spanTies = 0
    var rows: [[String: Any]] = []
    for frame in frames {
      provider.resetPrimaryPersonAnchor()
      let single = try? provider.extractPose(pixelBuffer: frame.buffer, timestampMs: frame.timestampMs)
      let everyone = try provider.extractAllPoses(pixelBuffer: frame.buffer, timestampMs: frame.timestampMs, maxPeople: 1)
      if single == nil { singleMisses += 1 }
      if everyone.isEmpty { everyoneEmpty += 1 }
      // With no anchor, primaryPerson picks the max torso span and
      // extractAllPoses sorts by the same span — the top entry must be the
      // same observation, hence bit-identical landmarks.
      XCTAssertEqual(single == nil, everyone.isEmpty, "frame \(frame.index): one API found a person, the other did not")
      guard let single, var top = everyone.first else { continue }
      compared += 1
      var row: [String: Any] = ["index": frame.index, "t": frame.timestampMs]
      if AttackPass3.maxDelta(single, top).map({ $0.coord > 0 || $0.visibility > 0 }) ?? true {
        // Torso-less fragments all score 1e-6; `max(by:)` keeps the first
        // tie while `sorted` may not. Only an EQUAL-span sibling excuses a
        // mismatch — anything else is a real divergence.
        let all = try provider.extractAllPoses(pixelBuffer: frame.buffer, timestampMs: frame.timestampMs, maxPeople: 6)
        if let twin = all.first(where: { AttackPass3.maxDelta(single, $0).map { $0.coord == 0 && $0.visibility == 0 } ?? false }),
           (AttackPass3.torsoSpan(twin) ?? -1) == (AttackPass3.torsoSpan(top) ?? -2) {
          spanTies += 1
          row["spanTieResolvedViaSibling"] = true
          top = twin
        }
      }
      if let delta = AttackPass3.maxDelta(single, top) {
        let confidenceDelta = abs(single.confidence - top.confidence)
        maxCoord = max(maxCoord, delta.coord)
        maxVisibility = max(maxVisibility, delta.visibility)
        maxConfidence = max(maxConfidence, confidenceDelta)
        if delta.coord == 0, delta.visibility == 0, confidenceDelta == 0 { exact += 1 }
        row["maxCoordDelta"] = delta.coord
        row["maxVisibilityDelta"] = delta.visibility
        row["confidenceDelta"] = confidenceDelta
        XCTAssertEqual(delta.coord, 0, accuracy: 1e-9, "frame \(frame.index): landmark coordinates diverge")
        XCTAssertEqual(delta.visibility, 0, accuracy: 1e-9, "frame \(frame.index): landmark visibility diverges")
      } else {
        mismatchedLandmarkSets += 1
        row["landmarkSetMismatch"] = true
        XCTFail("frame \(frame.index): landmark sets differ (\(single.landmarks.count) vs \(top.landmarks.count))")
      }
      rows.append(row)
    }
    record([
      "framesSampled": frames.count, "compared": compared, "exact": exact,
      "singleMisses": singleMisses, "everyoneEmpty": everyoneEmpty, "spanTies": spanTies,
      "mismatchedLandmarkSets": mismatchedLandmarkSets,
      "maxCoordDelta": maxCoord, "maxVisibilityDelta": maxVisibility, "maxConfidenceDelta": maxConfidence,
      "frames": rows,
    ])
    XCTAssertGreaterThan(compared, 0, "no frame had a person in both APIs — scenario not exercised")
  }

  /// The parenthetical in S24: extractAllPoses hard-codes `.up`. Feed a 90°
  /// rotated copy of a real person frame. extractPose(orientation: .right)
  /// must still find the person near the upright landmarks; extractAllPoses
  /// has no orientation parameter, so it either misses or lands the
  /// landmarks in the wrong place. The test records the divergence.
  func testS24_rotatedInputDivergesBecauseExtractAllPosesHardcodesUp() async throws {
    try requireClip()
    guard #available(macOS 13.0, iOS 16.0, *) else { throw XCTSkip("async AVFoundation API unavailable") }
    let provider = ApplePoseProvider()
    guard let person = try await AttackPass3ClipReader.firstPersonFrame(url: AttackPass3.committedClip, provider: provider) else {
      throw XCTSkip("no person frame within the first 240 frames of the committed clip")
    }
    let rotated = try AttackPass3.rotateQuarterTurn(person.buffer)
    provider.resetPrimaryPersonAnchor()
    let upright = try provider.extractPose(pixelBuffer: person.buffer, timestampMs: person.timestampMs, orientation: .up)
    let uprightMid = AttackPass3.torsoMidDisplay(upright)
    // The rotated buffer needs exactly one of .right / .left to read
    // upright; try both and keep the one whose torso lands on the upright
    // detection so the assertion never hinges on the sign convention.
    var orientedError: Error?
    var oriented: PoseFrame?
    var orientedTag = "none"
    var orientedBestDistance = Double.infinity
    var orientationTrials: [[String: Any]] = []
    for (tag, orientation) in [("right", CGImagePropertyOrientation.right), ("left", CGImagePropertyOrientation.left)] {
      provider.resetPrimaryPersonAnchor()
      do {
        let candidate = try provider.extractPose(pixelBuffer: rotated, timestampMs: person.timestampMs, orientation: orientation)
        let mid = AttackPass3.torsoMidDisplay(candidate)
        let d: Double
        if let mid, let uprightMid { d = Double(hypot(mid.x - uprightMid.x, mid.y - uprightMid.y)) } else { d = .infinity }
        orientationTrials.append(["orientation": tag, "torsoMidDistanceToUpright": d.isFinite ? d : -1, "confidence": candidate.confidence])
        if oriented == nil || d < orientedBestDistance {
          oriented = candidate
          orientedTag = tag
          orientedBestDistance = d
        }
      } catch {
        orientationTrials.append(["orientation": tag, "error": AttackPass3.describe(error)])
        if orientedError == nil { orientedError = error }
      }
    }
    let everyoneRotated = try provider.extractAllPoses(pixelBuffer: rotated, timestampMs: person.timestampMs, maxPeople: 1)
    provider.resetPrimaryPersonAnchor()
    var naiveError: Error?
    var naive: PoseFrame?
    do {
      naive = try provider.extractPose(pixelBuffer: rotated, timestampMs: person.timestampMs, orientation: .up)
    } catch { naiveError = error }

    let orientedMid = oriented.flatMap(AttackPass3.torsoMidDisplay)
    let allMid = everyoneRotated.first.flatMap(AttackPass3.torsoMidDisplay)
    func distance(_ a: CGPoint?, _ b: CGPoint?) -> Double {
      guard let a, let b else { return -1 }
      return Double(hypot(a.x - b.x, a.y - b.y))
    }
    let orientedDistance = distance(uprightMid, orientedMid)
    let allDistance = distance(uprightMid, allMid)
    record([
      "frameIndex": person.index, "t": person.timestampMs,
      "sourceSize": "\(CVPixelBufferGetWidth(person.buffer))x\(CVPixelBufferGetHeight(person.buffer))",
      "rotatedSize": "\(CVPixelBufferGetWidth(rotated))x\(CVPixelBufferGetHeight(rotated))",
      "upright": AttackPass3.serialize(upright),
      "orientedBest": AttackPass3.orNull(oriented.map(AttackPass3.serialize)),
      "orientedBestOrientation": orientedTag,
      "orientationTrials": orientationTrials,
      "orientedError": AttackPass3.orNull(orientedError.map(AttackPass3.describe)),
      "extractAllPosesOnRotated": AttackPass3.orNull(everyoneRotated.first.map(AttackPass3.serialize)),
      "extractAllPosesOnRotatedCount": everyoneRotated.count,
      "naiveUpOnRotated": AttackPass3.orNull(naive.map(AttackPass3.serialize)),
      "naiveUpOnRotatedError": AttackPass3.orNull(naiveError.map(AttackPass3.describe)),
      "torsoMidDistance_oriented_vs_upright": orientedDistance,
      "torsoMidDistance_extractAllPoses_vs_upright": allDistance,
    ])
    // The orientation-aware path must land the torso within ~0.06 image
    // units of the upright detection (rotation is lossless, so only
    // detector jitter separates them).
    XCTAssertNotNil(oriented, "extractPose(orientation:) lost the person on the rotated frame for both .right and .left: \(orientedError.map(AttackPass3.describe) ?? [:])")
    if orientedDistance >= 0 {
      XCTAssertLessThan(orientedDistance, 0.06, "orientation-aware extractPose drifted from the upright landmarks")
    }
    // extractAllPoses has no orientation parameter: either it finds nobody
    // or the torso lands somewhere else. Both prove the divergence.
    if let allMid, let uprightMid {
      XCTAssertGreaterThan(
        Double(hypot(allMid.x - uprightMid.x, allMid.y - uprightMid.y)), 0.06,
        "extractAllPoses on the rotated frame unexpectedly matched the upright landmarks — .up hard-code would be harmless"
      )
    }
  }

  // MARK: S25 — incumbent hysteresis on a synthetic two-person frame

  private struct CompositeScene {
    let scale: Double
    let buffer: CVPixelBuffer
    let expectedSmallMidDisplay: CGPoint
    let expectedLargeMidDisplay: CGPoint
  }

  /// Two copies of the same person crop side by side: the incumbent at 1×
  /// on the left, the challenger at `scale`× on the right, on a flat green
  /// floor with a grey wall. Coordinates are computed from the source pose
  /// so the anchor seed never depends on a second detection.
  private func makeComposite(source: CVPixelBuffer, pose: PoseFrame, scale: Double) throws -> CompositeScene {
    let sourceWidth = CVPixelBufferGetWidth(source)
    let sourceHeight = CVPixelBufferGetHeight(source)
    guard let bodyRect = AttackPass3.bodyRectPixels(pose, width: sourceWidth, height: sourceHeight, padFraction: 0.18),
          bodyRect.width > 20, bodyRect.height > 40
    else { throw AttackPass3Failure("cannot derive a body crop from the source pose") }
    let image = try AttackPass3.makeCGImage(source)
    guard let crop = image.cropping(to: bodyRect.integral) else { throw AttackPass3Failure("cropping failed") }
    let cropWidth = Double(crop.width)
    let cropHeight = Double(crop.height)
    let gap = cropWidth * 0.6
    let margin = cropWidth * 0.4
    let canvasWidth = Int((margin + cropWidth + gap + cropWidth * scale + margin).rounded(.up))
    let canvasHeight = Int((cropHeight * max(1.0, scale) + margin * 2).rounded(.up))
    let smallRectTopLeft = CGRect(x: margin, y: Double(canvasHeight) - margin - cropHeight, width: cropWidth, height: cropHeight)
    let largeRectTopLeft = CGRect(
      x: margin + cropWidth + gap,
      y: Double(canvasHeight) - margin - cropHeight * scale,
      width: cropWidth * scale,
      height: cropHeight * scale
    )
    let buffer = try AttackPass3.renderBGRA(width: canvasWidth, height: canvasHeight, background: (0.55, 0.55, 0.55)) { context in
      let h = CGFloat(canvasHeight)
      context.setFillColor(red: 0.22, green: 0.55, blue: 0.25, alpha: 1)
      context.fill(CGRect(x: 0, y: 0, width: CGFloat(canvasWidth), height: h * 0.35))
      for rect in [smallRectTopLeft, largeRectTopLeft] {
        // CoreGraphics origin is bottom-left; flip the top-left rect.
        let cgRect = CGRect(x: rect.minX, y: h - rect.maxY, width: rect.width, height: rect.height)
        context.draw(crop, in: cgRect)
      }
    }
    guard let sourceMid = AttackPass3.torsoMidDisplay(pose) else { throw AttackPass3Failure("source pose has no torso") }
    func map(_ rect: CGRect) -> CGPoint {
      // source display-normalized → source pixels → crop-relative → canvas pixels → canvas normalized
      let px = sourceMid.x * Double(sourceWidth) - bodyRect.integral.minX
      let py = sourceMid.y * Double(sourceHeight) - bodyRect.integral.minY
      let x = (rect.minX + px / cropWidth * rect.width) / Double(canvasWidth)
      let y = (rect.minY + py / cropHeight * rect.height) / Double(canvasHeight)
      return CGPoint(x: x, y: y)
    }
    return CompositeScene(
      scale: scale, buffer: buffer,
      expectedSmallMidDisplay: map(smallRectTopLeft),
      expectedLargeMidDisplay: map(largeRectTopLeft)
    )
  }

  private func runBodyPose(_ buffer: CVPixelBuffer) throws -> [VNHumanBodyPoseObservation] {
    let request = VNDetectHumanBodyPoseRequest()
    try VNImageRequestHandler(cvPixelBuffer: buffer, orientation: .up, options: [:]).perform([request])
    return request.results ?? []
  }

  func testS25_incumbentHysteresisKeepsSeededPersonUntilChallengerExceeds1_43x() async throws {
    try requireClip()
    guard #available(macOS 13.0, iOS 16.0, *) else { throw XCTSkip("async AVFoundation API unavailable") }
    let provider = ApplePoseProvider()
    guard let person = try await AttackPass3ClipReader.firstPersonFrame(url: AttackPass3.committedClip, provider: provider) else {
      throw XCTSkip("no person frame within the first 240 frames of the committed clip")
    }
    var rows: [[String: Any]] = []
    var keptCount = 0
    var keptByHysteresis = 0
    var switchedCount = 0
    var formulaMismatches = 0
    var scenesWithTwoPeople = 0
    var composites: [Double: (CompositeScene, [VNHumanBodyPoseObservation])] = [:]
    // (challenger scale, seed offset from the small torso toward the large
    // one in image units). Side by side the torsos sit ~0.5 apart, so the
    // distance decay alone keeps a 1.5× or 2× challenger out; nudging the
    // seed 0.08 toward a 3× challenger (still inside incumbentRadius 0.12)
    // pushes its score past 1.43× and must flip the selection.
    let scenes: [(Double, Double)] = [(1.0, 0), (1.5, 0), (2.0, 0), (3.0, 0), (1.5, 0.08), (2.0, 0.08), (3.0, 0.08), (3.6, 0), (3.6, 0.08)]
    for (scale, offset) in scenes {
      let scene: CompositeScene
      let observations: [VNHumanBodyPoseObservation]
      if let cached = composites[scale] {
        scene = cached.0
        observations = cached.1
      } else {
        do {
          scene = try makeComposite(source: person.buffer, pose: person.pose, scale: scale)
        } catch {
          rows.append(["scale": scale, "offset": offset, "outcome": "composite failed: \(error)"])
          continue
        }
        observations = try runBodyPose(scene.buffer)
        composites[scale] = (scene, observations)
      }
      let toward = CGPoint(
        x: scene.expectedLargeMidDisplay.x - scene.expectedSmallMidDisplay.x,
        y: scene.expectedLargeMidDisplay.y - scene.expectedSmallMidDisplay.y
      )
      let towardLength = max(1e-9, Double(hypot(toward.x, toward.y)))
      let seedDisplay = CGPoint(
        x: scene.expectedSmallMidDisplay.x + toward.x / towardLength * offset,
        y: scene.expectedSmallMidDisplay.y + toward.y / towardLength * offset
      )
      let smallAnchor = CGPoint(x: seedDisplay.x, y: 1.0 - seedDisplay.y)
      func distanceToSmall(_ observation: VNHumanBodyPoseObservation) -> Double {
        guard let mid = ApplePoseProvider.torsoMid(observation) else { return .infinity }
        return Double(hypot(mid.x - smallAnchor.x, mid.y - smallAnchor.y))
      }
      let sorted = observations.sorted { distanceToSmall($0) < distanceToSmall($1) }
      var row: [String: Any] = [
        "scale": scale,
        "seedOffset": offset,
        "seedDisplay": [seedDisplay.x, seedDisplay.y],
        "canvas": "\(CVPixelBufferGetWidth(scene.buffer))x\(CVPixelBufferGetHeight(scene.buffer))",
        "people": observations.count,
        "expectedSmallMidDisplay": [scene.expectedSmallMidDisplay.x, scene.expectedSmallMidDisplay.y],
        "expectedLargeMidDisplay": [scene.expectedLargeMidDisplay.x, scene.expectedLargeMidDisplay.y],
      ]
      guard let small = sorted.first, distanceToSmall(small) <= ApplePoseProvider.incumbentRadius,
            observations.count >= 2, let large = sorted.dropFirst().first,
            let smallMid = ApplePoseProvider.torsoMid(small), let largeMid = ApplePoseProvider.torsoMid(large)
      else {
        row["outcome"] = "fewer than two torsos detected (small within radius: \(sorted.first.map { distanceToSmall($0) <= ApplePoseProvider.incumbentRadius } ?? false))"
        rows.append(row)
        continue
      }
      scenesWithTwoPeople += 1
      let smallSpan = ApplePoseProvider.torsoSpanPublic(small)
      let largeSpan = ApplePoseProvider.torsoSpanPublic(large)
      let smallDistance = Double(hypot(smallMid.x - smallAnchor.x, smallMid.y - smallAnchor.y))
      let largeDistance = Double(hypot(largeMid.x - smallAnchor.x, largeMid.y - smallAnchor.y))
      let smallScore = smallSpan / (1.0 + 3.0 * smallDistance)
      let largeScore = largeSpan / (1.0 + 3.0 * largeDistance)
      let ratio = largeScore / smallScore
      let threshold = 1.0 / ApplePoseProvider.incumbentAdvantage
      let expectSwitch = largeScore > smallScore / ApplePoseProvider.incumbentAdvantage

      // Unit: the selector itself on real observations.
      let selected = ApplePoseProvider.primaryPerson(in: observations, anchor: smallAnchor)
      let selectedIsSmall = selected.map { $0 === small } ?? false
      let selectedIsLarge = selected.map { $0 === large } ?? false

      // End to end: seed via the public tap API, then extractPose.
      provider.setPrimaryPersonSeed(x: seedDisplay.x, y: seedDisplay.y)
      let frame = try provider.extractPose(pixelBuffer: scene.buffer, timestampMs: 0)
      let frameMid = AttackPass3.torsoMidDisplay(frame)
      let smallMidDisplay = CGPoint(x: smallMid.x, y: 1.0 - smallMid.y)
      let largeMidDisplay = CGPoint(x: largeMid.x, y: 1.0 - largeMid.y)
      let e2eDistanceSmall = frameMid.map { Double(hypot($0.x - smallMidDisplay.x, $0.y - smallMidDisplay.y)) } ?? -1
      let e2eDistanceLarge = frameMid.map { Double(hypot($0.x - largeMidDisplay.x, $0.y - largeMidDisplay.y)) } ?? -1
      let e2ePickedLarge = e2eDistanceLarge >= 0 && e2eDistanceLarge < e2eDistanceSmall
      let anchorAfter = provider.primaryPersonAnchorForTesting

      row["smallSpan"] = smallSpan
      row["largeSpan"] = largeSpan
      row["spanRatio"] = largeSpan / smallSpan
      row["smallDistanceToAnchor"] = smallDistance
      row["largeDistanceToAnchor"] = largeDistance
      row["smallScore"] = smallScore
      row["largeScore"] = largeScore
      row["scoreRatio"] = ratio
      row["threshold"] = threshold
      row["expectSwitch"] = expectSwitch
      row["selectorPicked"] = selectedIsSmall ? "small" : (selectedIsLarge ? "large" : "other")
      row["extractPosePicked"] = e2ePickedLarge ? "large" : "small"
      row["e2eDistanceToSmall"] = e2eDistanceSmall
      row["e2eDistanceToLarge"] = e2eDistanceLarge
      row["anchorAfterDisplay"] = AttackPass3.orNull(anchorAfter.map { [Double($0.x), 1.0 - Double($0.y)] })
      row["keptByHysteresis"] = !expectSwitch && largeScore > smallScore
      rows.append(row)

      let label = "scale \(scale) offset \(offset)"
      if expectSwitch {
        switchedCount += 1
        XCTAssertTrue(selectedIsLarge, "\(label): challenger at \(ratio)× > \(threshold)× must take over (selector)")
        XCTAssertTrue(e2ePickedLarge, "\(label): challenger at \(ratio)× > \(threshold)× must take over (extractPose)")
      } else {
        keptCount += 1
        if largeScore > smallScore { keptByHysteresis += 1 }
        XCTAssertTrue(selectedIsSmall, "\(label): incumbent must be kept while challenger is \(ratio)× ≤ \(threshold)× (selector)")
        XCTAssertFalse(e2ePickedLarge, "\(label): incumbent must be kept while challenger is \(ratio)× ≤ \(threshold)× (extractPose)")
      }
      if (selectedIsLarge && !expectSwitch) || (selectedIsSmall && expectSwitch) { formulaMismatches += 1 }
      // Anchor must follow whoever was selected.
      if let anchorAfter, let selected, let selectedMid = ApplePoseProvider.torsoMid(selected) {
        XCTAssertEqual(Double(anchorAfter.x), Double(selectedMid.x), accuracy: 1e-9, "\(label): anchor x not updated to the selected person")
        XCTAssertEqual(Double(anchorAfter.y), Double(selectedMid.y), accuracy: 1e-9, "\(label): anchor y not updated to the selected person")
      }
    }
    record([
      "sourceFrameIndex": person.index, "sourceT": person.timestampMs,
      "scenesWithTwoPeople": scenesWithTwoPeople, "kept": keptCount, "keptByHysteresis": keptByHysteresis,
      "switched": switchedCount, "formulaMismatches": formulaMismatches, "scenes": rows,
    ])
    XCTAssertGreaterThanOrEqual(scenesWithTwoPeople, 2, "Vision found two torsos in fewer than two composites — hysteresis not exercised")
    XCTAssertGreaterThan(keptCount, 0, "no composite exercised the KEEP branch (challenger ≤ 1.43×)")
    XCTAssertGreaterThan(keptByHysteresis, 0, "no composite had a higher-scoring challenger held off by the 1.43× margin — hysteresis branch not exercised")
    XCTAssertGreaterThan(switchedCount, 0, "no composite exercised the SWITCH branch (challenger > 1.43×)")
  }

  /// Exact-threshold boundary of the selector, exercised with real
  /// observations by moving the anchor: the incumbent's score changes with
  /// anchor distance while the challenger's does too, so sweeping the seed
  /// between the two torsos finds the crossing. At every sampled anchor the
  /// selector must agree with the formula at :183-199.
  func testS25_selectorAgreesWithScoreFormulaAlongAnchorSweep() async throws {
    try requireClip()
    guard #available(macOS 13.0, iOS 16.0, *) else { throw XCTSkip("async AVFoundation API unavailable") }
    let provider = ApplePoseProvider()
    guard let person = try await AttackPass3ClipReader.firstPersonFrame(url: AttackPass3.committedClip, provider: provider) else {
      throw XCTSkip("no person frame within the first 240 frames of the committed clip")
    }
    let scene = try makeComposite(source: person.buffer, pose: person.pose, scale: 3.0)
    let observations = try runBodyPose(scene.buffer)
    let torsos = observations.compactMap { observation -> (VNHumanBodyPoseObservation, CGPoint)? in
      guard let mid = ApplePoseProvider.torsoMid(observation) else { return nil }
      return (observation, mid)
    }
    guard torsos.count >= 2 else {
      record(["people": observations.count, "torsos": torsos.count, "outcome": "not enough torsos"])
      throw XCTSkip("composite yielded \(torsos.count) torsos; need 2")
    }
    // a = smaller torso (the seeded incumbent), b = the 3× challenger.
    let ordered = torsos.sorted { ApplePoseProvider.torsoSpanPublic($0.0) < ApplePoseProvider.torsoSpanPublic($1.0) }
    let a = ordered[0]
    let b = ordered[ordered.count - 1]
    var rng = AttackPass3Rng(seed: AttackPass3.seed ^ 0x25)
    var disagreements = 0
    var heldByHysteresis = 0
    var overriddenByMargin = 0
    var noIncumbent = 0
    var samples: [[String: Any]] = []
    for step in 0...80 {
      let t = Double(step) / 80.0 + (rng.nextUnit() - 0.5) * 0.005
      let anchor = CGPoint(x: a.1.x + (b.1.x - a.1.x) * t, y: a.1.y + (b.1.y - a.1.y) * t)
      func score(_ observation: VNHumanBodyPoseObservation) -> Double {
        let span = ApplePoseProvider.torsoSpanPublic(observation)
        guard let mid = ApplePoseProvider.torsoMid(observation) else { return span }
        return span / (1.0 + 3.0 * Double(hypot(mid.x - anchor.x, mid.y - anchor.y)))
      }
      let best = observations.max { score($0) < score($1) }
      let incumbent = observations
        .filter { observation in
          guard let mid = ApplePoseProvider.torsoMid(observation) else { return false }
          return Double(hypot(mid.x - anchor.x, mid.y - anchor.y)) <= ApplePoseProvider.incumbentRadius
        }
        .max { score($0) < score($1) }
      let expected: VNHumanBodyPoseObservation?
      if let incumbent {
        if let best, score(best) > score(incumbent) / ApplePoseProvider.incumbentAdvantage { expected = best } else { expected = incumbent }
      } else {
        expected = best
      }
      let actual = ApplePoseProvider.primaryPerson(in: observations, anchor: anchor)
      let agree = actual === expected
      if !agree { disagreements += 1 }
      let branch: String
      if let incumbent, let best, best !== incumbent {
        if expected === incumbent { branch = "heldByHysteresis"; heldByHysteresis += 1 } else { branch = "overriddenByMargin"; overriddenByMargin += 1 }
      } else if incumbent == nil {
        branch = "noIncumbent"; noIncumbent += 1
      } else {
        branch = "incumbentIsBest"
      }
      samples.append([
        "t": t, "anchor": [anchor.x, anchor.y],
        "hasIncumbent": incumbent != nil,
        "branch": branch,
        "scoreRatioBestOverIncumbent": scoreRatio(best: best, incumbent: incumbent, score: score),
        "expected": expected.map { $0 === a.0 ? "a" : ($0 === b.0 ? "b" : "other") } ?? "nil",
        "actual": actual.map { $0 === a.0 ? "a" : ($0 === b.0 ? "b" : "other") } ?? "nil",
        "agree": agree,
      ])
      XCTAssertTrue(agree, "anchor sweep t=\(t): selector disagrees with the documented score formula")
    }
    record([
      "people": observations.count, "torsos": torsos.count, "disagreements": disagreements,
      "heldByHysteresis": heldByHysteresis, "overriddenByMargin": overriddenByMargin, "noIncumbent": noIncumbent,
      "spanA": ApplePoseProvider.torsoSpanPublic(a.0), "spanB": ApplePoseProvider.torsoSpanPublic(b.0),
      "torsoDistance": Double(hypot(a.1.x - b.1.x, a.1.y - b.1.y)),
      "samples": samples,
    ])
    XCTAssertGreaterThan(heldByHysteresis, 0, "sweep never reached the state where a higher-scoring challenger is held off by the 1.43× margin")
    XCTAssertGreaterThan(overriddenByMargin, 0, "sweep never reached the state where the challenger exceeds the 1.43× margin while the incumbent is in radius")
  }

  private func scoreRatio(
    best: VNHumanBodyPoseObservation?,
    incumbent: VNHumanBodyPoseObservation?,
    score: (VNHumanBodyPoseObservation) -> Double
  ) -> Double {
    guard let best, let incumbent else { return -1 }
    return score(best) / max(1e-12, score(incumbent))
  }

  // MARK: S26 — 1 000 extractPose calls, no autoreleasepool, RSS sampled via task_info

  func testS26_thousandExtractionsWithoutAutoreleasepoolHaveBoundedRSSGrowth() async throws {
    try requireClip()
    guard #available(macOS 13.0, iOS 16.0, *) else { throw XCTSkip("async AVFoundation API unavailable") }
    let provider = ApplePoseProvider()
    guard let person = try await AttackPass3ClipReader.firstPersonFrame(url: AttackPass3.committedClip, provider: provider) else {
      throw XCTSkip("no person frame within the first 240 frames of the committed clip")
    }
    let iterations = max(1, Int(ProcessInfo.processInfo.environment["PICKLE_ATTACK_S26_ITERATIONS"] ?? "") ?? 1000)
    let warmup = 50
    var rng = AttackPass3Rng(seed: AttackPass3.seed ^ 0x26)
    // Warm up so Vision's model load and caches are excluded from the slope.
    for _ in 0..<warmup { _ = try provider.extractPose(pixelBuffer: person.buffer, timestampMs: person.timestampMs) }
    let rssStart = AttackPass3.residentMemoryBytes()
    let footprintStart = AttackPass3.physFootprintBytes()
    var samples: [[String: Any]] = [["i": 0, "rss": Int(rssStart), "footprint": Int(footprintStart)]]
    var peakRss = rssStart
    var failures = 0
    var landmarkCounts = Set<Int>()
    let started = Date()
    var nextSample = 50 + rng.nextIndex(below: 25)
    for i in 1...iterations {
      // Deliberately NO autoreleasepool: this is the caller pattern the
      // scenario attacks (swing-lab's extract loop; XCTest's own method
      // body). PickleVideoCapture wraps its loop, GuidedCapture runs per
      // dispatch block.
      do {
        let frame = try provider.extractPose(pixelBuffer: person.buffer, timestampMs: person.timestampMs + i)
        landmarkCounts.insert(frame.landmarks.count)
      } catch {
        failures += 1
      }
      if i >= nextSample || i == iterations {
        let rss = AttackPass3.residentMemoryBytes()
        peakRss = max(peakRss, rss)
        samples.append(["i": i, "rss": Int(rss), "footprint": Int(AttackPass3.physFootprintBytes())])
        nextSample = i + 50 + rng.nextIndex(below: 25)
      }
    }
    let wallMs = Int(Date().timeIntervalSince(started) * 1000)
    let rssEnd = AttackPass3.residentMemoryBytes()
    let footprintEnd = AttackPass3.physFootprintBytes()
    let growth = Int64(rssEnd) - Int64(rssStart)
    let peakGrowth = Int64(peakRss) - Int64(rssStart)
    let perIteration = Double(growth) / Double(iterations)
    let boundBytes: Int64 = 256 * 1024 * 1024

    // Control: the same loop with a per-iteration pool, so the report shows
    // how much of any growth the missing pool accounts for.
    let controlIterations = min(iterations, 300)
    let controlStart = AttackPass3.residentMemoryBytes()
    for i in 0..<controlIterations {
      autoreleasepool {
        _ = try? provider.extractPose(pixelBuffer: person.buffer, timestampMs: i)
      }
    }
    let controlGrowth = Int64(AttackPass3.residentMemoryBytes()) - Int64(controlStart)

    record([
      "iterations": iterations, "warmup": warmup, "wallMs": wallMs,
      "msPerExtraction": Double(wallMs) / Double(iterations),
      "rssStart": Int(rssStart), "rssEnd": Int(rssEnd), "rssPeak": Int(peakRss),
      "rssGrowthBytes": Int(growth), "rssPeakGrowthBytes": Int(peakGrowth),
      "rssGrowthPerIterationBytes": perIteration,
      "footprintStart": Int(footprintStart), "footprintEnd": Int(footprintEnd),
      "footprintGrowthBytes": Int(Int64(footprintEnd) - Int64(footprintStart)),
      "controlIterations": controlIterations, "controlPooledGrowthBytes": Int(controlGrowth),
      "boundBytes": Int(boundBytes),
      "failures": failures, "landmarkCounts": Array(landmarkCounts).sorted(),
      "samples": samples,
    ])
    XCTAssertEqual(failures, 0, "extractPose failed \(failures)/\(iterations) times on a frame that resolves a person")
    XCTAssertLessThan(
      growth, boundBytes,
      "RSS grew \(growth / (1024 * 1024)) MiB over \(iterations) extractions without an autoreleasepool (\(Int(perIteration)) B/iteration)"
    )
    XCTAssertLessThan(peakGrowth, boundBytes, "peak RSS growth exceeded bound")
  }

  /// Rapid repeats and interleavings: 8 threads share ONE provider, mixing
  /// extractPose with seed writes and resets while the anchor is read. No
  /// crash, every call either returns a frame or throws a typed error, and
  /// the anchor afterwards is either nil or a finite in-range point.
  func testS26_concurrentExtractionSeedAndResetOnSharedProviderIsSafe() async throws {
    try requireClip()
    guard #available(macOS 13.0, iOS 16.0, *) else { throw XCTSkip("async AVFoundation API unavailable") }
    let provider = ApplePoseProvider()
    guard let person = try await AttackPass3ClipReader.firstPersonFrame(url: AttackPass3.committedClip, provider: provider) else {
      throw XCTSkip("no person frame within the first 240 frames of the committed clip")
    }
    let black = try AttackPass3.makeSolidBGRA(width: 64, height: 64, blue: 0, green: 0, red: 0)
    let threads = 8
    let perThread = 40
    let counters = AttackPass3Counters()
    let group = DispatchGroup()
    let queue = DispatchQueue(label: "attack-pass3.s26", attributes: .concurrent)
    let started = Date()
    for thread in 0..<threads {
      group.enter()
      queue.async {
        var rng = AttackPass3Rng(seed: AttackPass3.seed ^ UInt64(0x2600 + thread))
        for i in 0..<perThread {
          switch rng.nextIndex(below: 6) {
          case 0:
            provider.setPrimaryPersonSeed(x: rng.nextUnit(), y: rng.nextUnit())
            counters.add("seed")
          case 1:
            provider.resetPrimaryPersonAnchor()
            counters.add("reset")
          case 2:
            do {
              _ = try provider.extractPose(pixelBuffer: black, timestampMs: i)
              counters.add("blackFrame")
            } catch {
              counters.add(AttackPass3.isNoPersonDetected(error) ? "blackTyped" : "blackUntyped")
            }
          default:
            do {
              let frame = try provider.extractPose(pixelBuffer: person.buffer, timestampMs: i)
              counters.add(frame.landmarks.isEmpty ? "personEmpty" : "personFrame")
              if !frame.landmarks.allSatisfy({ $0.x.isFinite && $0.y.isFinite && $0.visibility.isFinite }) {
                counters.add("nonFinite")
              }
            } catch {
              counters.add(error is VisionFailure ? "personTyped" : "personUntyped")
            }
          }
        }
        group.leave()
      }
    }
    let waited = group.wait(timeout: .now() + 240)
    let anchor = provider.primaryPersonAnchorForTesting
    let snapshot = counters.snapshot()
    record([
      "threads": threads, "perThread": perThread, "completed": waited == .success,
      "wallMs": Int(Date().timeIntervalSince(started) * 1000),
      "counts": snapshot,
      "anchorAfter": AttackPass3.orNull(anchor.map { [Double($0.x), Double($0.y)] }),
    ])
    XCTAssertEqual(waited, .success, "concurrent extraction did not finish within 240 s")
    XCTAssertEqual(snapshot["blackFrame"] ?? 0, 0, "black frame yielded a PoseFrame under contention")
    XCTAssertEqual(snapshot["blackUntyped"] ?? 0, 0, "black frame produced an untyped error under contention")
    XCTAssertEqual(snapshot["personUntyped"] ?? 0, 0, "person frame produced an untyped error under contention")
    XCTAssertEqual(snapshot["personEmpty"] ?? 0, 0, "person frame produced an empty PoseFrame under contention")
    XCTAssertEqual(snapshot["nonFinite"] ?? 0, 0, "non-finite landmark under contention")
    if let anchor {
      XCTAssertTrue(anchor.x.isFinite && anchor.y.isFinite, "anchor is non-finite after contention")
      XCTAssertTrue((0...1).contains(Double(anchor.x)) && (0...1).contains(Double(anchor.y)), "anchor out of range: \(anchor)")
    }
  }

  // MARK: S27 — per-frame dump for macOS vs iOS Simulator diff

  /// Extracts the first 90 upright frames of the committed clip and dumps
  /// every landmark (x, y, visibility) and frame confidence, tagged with the
  /// platform and `modelVersion`. tools/attack-pass3/compare_s27.py diffs the
  /// macOS and iOS Simulator reports offline. The only in-process assertion
  /// is the model version string and that at least one frame has a person.
  func testS27_dumpPerFrameLandmarksForCrossPlatformDiff() async throws {
    try requireClip()
    guard #available(macOS 13.0, iOS 16.0, *) else { throw XCTSkip("async AVFoundation API unavailable") }
    let provider = ApplePoseProvider()
    XCTAssertEqual(provider.modelVersion, "apple-vision-bodypose-1")
    let reader = try await AttackPass3ClipReader(url: AttackPass3.committedClip)
    defer { reader.cancel() }
    let frameLimit = max(1, Int(ProcessInfo.processInfo.environment["PICKLE_ATTACK_S27_FRAMES"] ?? "") ?? 90)
    var frames: [[String: Any]] = []
    var misses = 0
    var index = 0
    let started = Date()
    while index < frameLimit, let frame = reader.next() {
      defer { index += 1 }
      do {
        let pose = try provider.extractPose(pixelBuffer: frame.buffer, timestampMs: frame.timestampMs)
        var entry = AttackPass3.serialize(pose)
        entry["i"] = index
        frames.append(entry)
      } catch {
        misses += 1
        frames.append(["i": index, "t": frame.timestampMs, "miss": AttackPass3.describe(error)])
      }
    }
    record([
      "modelVersion": provider.modelVersion,
      "clip": "datasets/pickleball/fresh-candidates/va-O1dLhGGPErc.mp4",
      "renderSize": "\(reader.width)x\(reader.height)",
      "framesProcessed": index, "misses": misses,
      "wallMs": Int(Date().timeIntervalSince(started) * 1000),
      "osVersion": ProcessInfo.processInfo.operatingSystemVersionString,
      "frames": frames,
    ])
    XCTAssertGreaterThan(index, 0, "no frames decoded")
    XCTAssertLessThan(misses, index, "no frame produced a pose on this platform")
  }

  /// Determinism on the same platform: the same buffer through two fresh
  /// providers must give bit-identical landmarks (run-to-run on the Mac is
  /// already known to be exact from artifacts 33829297073 vs 33841813597;
  /// this pins in-process repeatability on the Simulator too).
  func testS27_sameFrameTwiceIsBitIdenticalInProcess() async throws {
    try requireClip()
    guard #available(macOS 13.0, iOS 16.0, *) else { throw XCTSkip("async AVFoundation API unavailable") }
    let probe = ApplePoseProvider()
    guard let person = try await AttackPass3ClipReader.firstPersonFrame(url: AttackPass3.committedClip, provider: probe) else {
      throw XCTSkip("no person frame within the first 240 frames of the committed clip")
    }
    let first = try ApplePoseProvider().extractPose(pixelBuffer: person.buffer, timestampMs: person.timestampMs)
    let second = try ApplePoseProvider().extractPose(pixelBuffer: person.buffer, timestampMs: person.timestampMs)
    let delta = AttackPass3.maxDelta(first, second)
    record([
      "frameIndex": person.index,
      "maxCoordDelta": delta?.coord ?? -1, "maxVisibilityDelta": delta?.visibility ?? -1,
      "confidenceDelta": abs(first.confidence - second.confidence),
      "landmarkSetMismatch": delta == nil,
    ])
    XCTAssertNotNil(delta, "landmark sets differ between two identical extractions")
    XCTAssertEqual(delta?.coord ?? 1, 0, "same frame, two providers: coordinates differ")
    XCTAssertEqual(delta?.visibility ?? 1, 0, "same frame, two providers: visibility differs")
  }
}

/// Lock-guarded counters for the concurrency test.
final class AttackPass3Counters: @unchecked Sendable {
  private var counts: [String: Int] = [:]
  private let lock = NSLock()

  func add(_ key: String) {
    lock.lock()
    counts[key, default: 0] += 1
    lock.unlock()
  }

  func snapshot() -> [String: Int] {
    lock.lock()
    defer { lock.unlock() }
    return counts
  }
}
