// PROXY-ONLY (Linux). `VNHumanBodyPoseObservation` has no public initializer
// on Apple platforms, so this file cannot live in native/vision-core/Tests; on
// the proxy the Vision stub lets us hand the PRODUCTION `primaryPerson(in:anchor:)`
// synthetic observations and probe what a non-finite seed does to selection.
//
// S17 follow-up (adversarial pass 3): `setPrimaryPersonSeed` stores whatever it
// is given. A finite out-of-range seed is harmless (scores stay ordered). A
// NaN or ±inf seed makes every `score` NaN/0, so `max(by:)` degrades to the
// FIRST observation — detection order — and the incumbent filter is empty.
// Unreachable from the shipping UI (capture.ts rejects non-unit seeds; the
// live tap is normalized in-view), hence a P3 note, not a product bug.
import XCTest
@testable import PickleVisionCore

final class ProxyOnlyPrimaryPersonAnchorTests: XCTestCase {
  private func person(centerX: Double, centerY: Double, span: Double) -> VNHumanBodyPoseObservation {
    let half = span / 2
    func point(_ x: Double, _ y: Double) -> VNRecognizedPoint {
      VNRecognizedPoint(location: CGPoint(x: x, y: y), confidence: 0.9)
    }
    return VNHumanBodyPoseObservation(points: [
      .leftShoulder: point(centerX - 0.05, centerY + half),
      .rightShoulder: point(centerX + 0.05, centerY + half),
      .leftHip: point(centerX - 0.05, centerY - half),
      .rightHip: point(centerX + 0.05, centerY - half),
    ])
  }

  /// Detection order is deliberately small-first so a fallback to `.first`
  /// is distinguishable from largest-torso selection.
  private var smallFirst: VNHumanBodyPoseObservation { person(centerX: 0.2, centerY: 0.5, span: 0.10) }
  private var largeSecond: VNHumanBodyPoseObservation { person(centerX: 0.7, centerY: 0.5, span: 0.30) }

  func testNoAnchorPicksTheLargestTorsoRegardlessOfDetectionOrder() {
    let small = smallFirst, large = largeSecond
    XCTAssertTrue(ApplePoseProvider.primaryPerson(in: [small, large], anchor: nil) === large)
    XCTAssertTrue(ApplePoseProvider.primaryPerson(in: [large, small], anchor: nil) === large)
  }

  func testFiniteOutOfRangeAnchorStillPicksTheLargestTorso() {
    let small = smallFirst, large = largeSecond
    // The S17 seed (1.5, -0.3) after the y flip.
    let anchor = CGPoint(x: 1.5, y: 1.3)
    XCTAssertTrue(ApplePoseProvider.primaryPerson(in: [small, large], anchor: anchor) === large)
    XCTAssertTrue(ApplePoseProvider.primaryPerson(in: [large, small], anchor: anchor) === large)
  }

  /// FINDING (P3): a NaN anchor collapses selection to detection order.
  func testNaNAnchorDegradesSelectionToDetectionOrder() {
    let small = smallFirst, large = largeSecond
    let anchor = CGPoint(x: Double.nan, y: Double.nan)
    let picked = ApplePoseProvider.primaryPerson(in: [small, large], anchor: anchor)
    XCTAssertTrue(picked === small, "NaN anchor: expected detection-order fallback (first = small) — got \(picked === large ? "large" : "other")")
    XCTAssertTrue(ApplePoseProvider.primaryPerson(in: [large, small], anchor: anchor) === large)
  }

  /// FINDING (P3): an infinite anchor zeroes every score; same collapse.
  func testInfiniteAnchorDegradesSelectionToDetectionOrder() {
    let small = smallFirst, large = largeSecond
    let anchor = CGPoint(x: Double.infinity, y: Double.infinity)
    XCTAssertTrue(ApplePoseProvider.primaryPerson(in: [small, large], anchor: anchor) === small)
    XCTAssertTrue(ApplePoseProvider.primaryPerson(in: [large, small], anchor: anchor) === large)
  }

  /// End-to-end through the public seed API: the stored anchor is exactly the
  /// non-finite value, so the degraded selection above is what the next frame
  /// would use.
  func testSeedAPIStoresNaNVerbatim() {
    let provider = ApplePoseProvider()
    provider.setPrimaryPersonSeed(x: Double.nan, y: 0.5)
    XCTAssertTrue(provider.primaryPersonAnchorForTesting?.x.isNaN == true)
    provider.resetPrimaryPersonAnchor()
    XCTAssertNil(provider.primaryPersonAnchorForTesting)
  }
}
