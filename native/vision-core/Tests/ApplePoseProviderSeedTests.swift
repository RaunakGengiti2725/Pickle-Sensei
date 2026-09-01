import CoreGraphics
import XCTest

@testable import PickleVisionCore

/// REGRESSION: the "tap yourself" target seed was stored in the wrong
/// coordinate space.
///
/// `previousTorsoMid` is only ever written from `torsoMid(observation)`, which
/// reads Vision's raw `recognizedPoint().location` — BOTTOM-left origin.
/// `extractPose` flips y (`1.0 - y`) when it builds `PoseFrame.landmarks`, so
/// every caller of `setPrimaryPersonSeed` works in TOP-left display space:
/// `GuidedCaptureViewController.lockTarget` passes a torso midpoint derived
/// from `PoseFrame.landmarks`, and `PickleVideoCapture` documents `seedY` as
/// "normalized (0..1, top-left origin)".
///
/// Storing the tap verbatim put the anchor at the mirrored height. For an
/// athlete at top-left y=0.7 the anchor landed at Vision y=0.7 while their
/// real torso sat at Vision y=0.3 — a 0.4 gap, far outside
/// `incumbentRadius` (0.12). The tap that exists to choose WHICH person is
/// primary was therefore inert, or actively favored a bystander, on exactly
/// the frame it was supposed to control.
final class ApplePoseProviderSeedTests: XCTestCase {
  func testSeedConvertsTopLeftTapIntoVisionBottomLeftAnchor() {
    let provider = ApplePoseProvider()
    provider.setPrimaryPersonSeed(x: 0.25, y: 0.70)

    guard let anchor = provider.primaryPersonAnchorForTesting else {
      return XCTFail("anchor must be set by the seed")
    }
    XCTAssertEqual(Double(anchor.x), 0.25, accuracy: 1e-9, "x shares an origin in both spaces")
    XCTAssertEqual(
      Double(anchor.y), 0.30, accuracy: 1e-9,
      "y must be flipped into Vision's bottom-left space to match torsoMid"
    )
  }

  /// The flip must be an involution: seeding a point and flipping it back
  /// returns the original tap. Guards against a future "fix" that offsets or
  /// clamps instead of mirroring.
  func testSeedRoundTripsThroughTheFlip() {
    for tap in [0.0, 0.12, 0.5, 0.88, 1.0] {
      let provider = ApplePoseProvider()
      provider.setPrimaryPersonSeed(x: 0.5, y: tap)
      guard let anchor = provider.primaryPersonAnchorForTesting else {
        return XCTFail("anchor must be set for tap y=\(tap)")
      }
      XCTAssertEqual(1.0 - Double(anchor.y), tap, accuracy: 1e-9)
    }
  }

  /// A seeded athlete must fall INSIDE the incumbent radius of their own
  /// observed torso. This is the property the bug actually broke: with the
  /// unflipped seed, any tap off the vertical midline exceeded the radius.
  func testSeededAnchorLandsWithinIncumbentRadiusOfTheSameAthlete() {
    // Athlete observed by Vision (bottom-left) at y=0.30 ⇒ displayed
    // (top-left) at y=0.70, which is where the user taps.
    let observedVisionY = 0.30
    let provider = ApplePoseProvider()
    provider.setPrimaryPersonSeed(x: 0.25, y: 1.0 - observedVisionY)

    guard let anchor = provider.primaryPersonAnchorForTesting else {
      return XCTFail("anchor must be set")
    }
    let distance = hypot(Double(anchor.x) - 0.25, Double(anchor.y) - observedVisionY)
    XCTAssertLessThanOrEqual(
      distance, ApplePoseProvider.incumbentRadius,
      "the tapped athlete must be their own incumbent, else the tap cannot hold identity"
    )
  }

  func testResetClearsTheSeededAnchor() {
    let provider = ApplePoseProvider()
    provider.setPrimaryPersonSeed(x: 0.4, y: 0.4)
    XCTAssertNotNil(provider.primaryPersonAnchorForTesting)
    provider.resetPrimaryPersonAnchor()
    XCTAssertNil(
      provider.primaryPersonAnchorForTesting,
      "stickiness must never leak across clips or sessions"
    )
  }
}
