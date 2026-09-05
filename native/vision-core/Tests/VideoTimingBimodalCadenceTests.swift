import XCTest

@testable import PickleVisionCore

/// ADVERSARIAL (candidate 8193d372, xc-cv::XC-CV-4): `VideoTiming.observedCadence`
/// keeps only the intervals within ±1 ms of the MEDIAN interval. A stream whose
/// intervals alternate between two values — a 60 fps camera whose kept frames sit
/// 2, 3, 2, 3 source frames apart (33, 50, 33, 50 ms: 60→24 decimation, or Vision
/// sustaining ~24 fps on a 60 fps feed, the shipping ClipMediaStore sidecar path
/// feeds pose-frame stamps into this function) — has NO interval near its median:
///   - with an even number of intervals the median is 41.5, zero intervals are
///     kept, and `intervalMs` is 0/0 = NaN (`fps` = NaN; `resolve` then evaluates
///     `Int(cadence.intervalMs.rounded())` — a Swift runtime trap on NaN — so the
///     extractor crashes instead of writing a sidecar);
///   - with an odd number the median is one of the two modes and the reported
///     rate is 30 or 20 fps for a stream whose effective rate is 24 fps, i.e. the
///     nominal 24 is flagged `fpsMismatch` and `video.fps` is written 25 % off.
///
/// These tests only call `observedCadence` (never `resolve` on the even-count
/// set) so the failure is an assertion, not a process trap. Written on the Linux
/// plane from a faithful port of the arithmetic; not yet executed on the Mac
/// plane.
final class VideoTimingBimodalCadenceTests: XCTestCase {
  private func alternatingStamps(first: Int, second: Int, count: Int) -> [Int] {
    var stamps = [1000]
    stamps.reserveCapacity(count)
    for index in 1..<count {
      stamps.append(stamps[index - 1] + (index % 2 == 1 ? first : second))
    }
    return stamps
  }

  func testAlternating33And50MsCadenceHasAFiniteInterval() {
    // 51 stamps → 50 intervals (25 × 33, 25 × 50): median 41.5, nothing within ±1.
    let cadence = VideoTiming.observedCadence(
      sampleTimestampsMs: alternatingStamps(first: 33, second: 50, count: 51)
    )
    XCTAssertNotNil(cadence)
    XCTAssertTrue(cadence?.intervalMs.isFinite ?? false, "intervalMs is \(String(describing: cadence?.intervalMs))")
    XCTAssertTrue(cadence?.fps.isFinite ?? false, "fps is \(String(describing: cadence?.fps))")
  }

  func testAlternatingCadenceReportsTheEffectiveRateNotASubInterval() {
    // 50 stamps → 49 intervals: the median is the 33 ms mode → 30.3 fps reported.
    // The same stream starting on the 50 ms sub-interval reports 20 fps.
    for (first, second) in [(33, 50), (50, 33)] {
      let cadence = VideoTiming.observedCadence(
        sampleTimestampsMs: alternatingStamps(first: first, second: second, count: 50)
      )
      XCTAssertNotNil(cadence)
      XCTAssertEqual(
        cadence?.fps ?? 0, 24, accuracy: VideoTiming.fpsTolerance(observedFps: 24),
        "alternating \(first)/\(second) ms is a 24 fps stream; reported \(String(describing: cadence?.fps))"
      )
    }
  }
}
