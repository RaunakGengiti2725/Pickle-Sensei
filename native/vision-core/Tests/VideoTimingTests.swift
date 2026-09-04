import XCTest

@testable import PickleVisionCore

/// REGRESSION (xc-cv::XC-CV-4): `video.fps` / `durationMs` were copied from
/// `AVAssetTrack.nominalFrameRate` / `AVAsset.duration`. For the AV1
/// fresh-candidate clip (24 fps, 60.875 s by ffprobe) the container declared
/// 12 fps and 121.75 s, the sidecar inherited both, and every consumer that
/// scaled a threshold by the declared fps (playerTracker's gap rule) was
/// silently wrong. The extractors now resolve timing from the sample
/// timestamps the decoder delivered and only RECORD the declared values.
final class VideoTimingTests: XCTestCase {
  /// A synthetic asset in the shape of the real defect: the decoder delivers
  /// 1461 samples on a 24 fps cadence (integer-ms presentation stamps, as the
  /// extractors round them) while the container declares 12 fps and twice
  /// the real duration.
  private func av1FreshCandidateSamples() -> [Int] {
    (0..<1461).map { Int((Double($0) * 1000 / 24).rounded()) }
  }

  func testDeclaredTwelveFpsAgainstTwentyFourFpsCadenceWritesTheCadenceDerivedFps() {
    let samples = av1FreshCandidateSamples()
    let timing = VideoTiming.resolve(nominalFps: 12, sampleTimestampsMs: samples, assetDurationMs: 121_750)

    XCTAssertEqual(timing.fpsSource, .observedSampleCadence)
    XCTAssertEqual(timing.fps, 24, accuracy: 0.1, "fps follows the observed cadence, not the declared 12")
    XCTAssertEqual(timing.nominalFps, 12, "the declared rate is kept for the record")
    XCTAssertTrue(timing.fpsMismatch)
    // 1461 frames at 24 fps = 60.875 s; the declared 121.75 s is contradicted.
    XCTAssertEqual(timing.durationMs, 60_875, accuracy: 100)
    XCTAssertTrue(timing.durationMismatch)
    XCTAssertEqual(timing.assetDurationMs, 121_750)

    let video = timing.videoMetadata(width: 608, height: 1080)
    XCTAssertEqual(video["fps"] as? Double ?? 0, 24, accuracy: 0.5)
    XCTAssertEqual(video["nominalFps"] as? Double, 12)
    XCTAssertEqual(video["fpsSource"] as? String, "observed_sample_cadence")
    XCTAssertEqual(video["fpsMismatch"] as? Bool, true)
  }

  func testAgreeingDeclarationIsNotAMismatchAndKeepsTheDeclaredDuration() {
    // 59.94 fps capture stamped in integer ms (16/17 ms alternation) declared as 59.94.
    let samples = (0..<600).map { Int((Double($0) * 1000 / 59.94).rounded()) }
    let declaredDurationMs = Int((600.0 * 1000 / 59.94).rounded())
    let timing = VideoTiming.resolve(
      nominalFps: 59.94, sampleTimestampsMs: samples, assetDurationMs: declaredDurationMs)

    XCTAssertEqual(timing.fpsSource, .observedSampleCadence)
    // Integer-ms stamps alternate 16/17 ms; their mean recovers 16.68 ms.
    XCTAssertEqual(timing.fps, 59.94, accuracy: 0.5)
    XCTAssertFalse(timing.fpsMismatch)
    XCTAssertEqual(timing.durationMs, declaredDurationMs, "a consistent declaration is authoritative")
    XCTAssertFalse(timing.durationMismatch)
  }

  func testPoseDropoutsDoNotSkewTheCadence() {
    // Pose history at 30 fps with detection gaps of 5–12 frames: the median
    // still measures the camera cadence, the gaps are not "slow frames".
    var samples: [Int] = []
    var t = 0
    for index in 0..<400 {
      if index % 37 == 0 { t += 33 * 9 } else { t += 33 }
      samples.append(t)
    }
    let timing = VideoTiming.resolve(nominalFps: 30, sampleTimestampsMs: samples, assetDurationMs: nil)
    XCTAssertEqual(timing.fps, 1000.0 / 33, accuracy: 1e-9)
    XCTAssertFalse(timing.fpsMismatch)
    XCTAssertEqual(timing.fpsSource, .observedSampleCadence)
  }

  func testTooFewSamplesFallBackToTheDeclaredRateWithoutProvenance() {
    let timing = VideoTiming.resolve(nominalFps: 30, sampleTimestampsMs: [0, 33, 67, 100], assetDurationMs: 4_000)
    XCTAssertEqual(timing.fps, 30)
    XCTAssertEqual(timing.fpsSource, .nominalFrameRate)
    XCTAssertFalse(timing.fpsMismatch)
    XCTAssertEqual(timing.durationMs, 4_000)
    XCTAssertNil(timing.cadence)
    let video = timing.videoMetadata(width: 1080, height: 1920)
    XCTAssertEqual(Set(video.keys), ["w", "h", "fps"], "no measured cadence → no provenance keys")
  }

  func testNoDeclaredRateIsNeverReportedAsAMismatch() {
    let samples = (0..<200).map { $0 * 40 }
    let timing = VideoTiming.resolve(nominalFps: 0, sampleTimestampsMs: samples, assetDurationMs: nil)
    XCTAssertEqual(timing.fps, 25)
    XCTAssertEqual(timing.nominalFps, 0)
    XCTAssertFalse(timing.fpsMismatch)
    XCTAssertEqual(timing.durationMs, 199 * 40 + 40)
    XCTAssertFalse(timing.durationMismatch)
  }
}
