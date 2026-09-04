// Scenario 2 — PickleSessionPreviewView attach/detach against the
// SessionCaptureCoordinator weak registry.
//
// PickleSessionPreview.swift:62-89 (`attach`): an empty/unknown id reports
// `onPreviewState(["attached": false])` and installs no layer; a live id
// inserts `active.makePreviewLayer()` at sublayer index 0, subscribes
// `active.onPoseFrame`, and reports attached: true. The view holds the
// coordinator `weak` (line 18); the registry holds coordinators weakly too
// (SessionCaptureCoordinator.swift:78-90). None of this needs a camera: the
// coordinator's engine is created but never configured, so every test here
// runs on the Simulator. XCTest invokes these on the main thread, which the
// production `attach()` asserts.
import AVFoundation
import UIKit
import XCTest

@testable import PickleCameraEngineUnderTest

final class S2PreviewAttachDetachTests: XCTestCase {
  private let frame = CGRect(x: 0, y: 0, width: 390, height: 844)

  private func previewLayers(in view: UIView) -> [AVCaptureVideoPreviewLayer] {
    (view.layer.sublayers ?? []).compactMap { $0 as? AVCaptureVideoPreviewLayer }
  }

  private final class StateLog {
    var states: [[AnyHashable: Any]?] = []
    var attachedFlags: [Bool?] { states.map { $0?["attached"] as? Bool } }
    func bind(_ view: PickleSessionPreviewView) {
      view.onPreviewState = { [weak self] body in self?.states.append(body) }
    }
  }

  func testEmptyAndUnknownIdsReportDetachedWithNoPreviewLayer() {
    let view = PickleSessionPreviewView(frame: frame)
    let log = StateLog()
    log.bind(view)

    view.sessionCaptureId = ""
    XCTAssertEqual(log.attachedFlags, [false], "empty id → exactly one attached:false")
    XCTAssertTrue(previewLayers(in: view).isEmpty, "empty id must not install a preview layer")
    XCTAssertEqual(log.states.last??.count, 1, "payload carries only the attached flag")

    view.sessionCaptureId = "no-such-capture-id"
    XCTAssertEqual(log.attachedFlags, [false, false])
    XCTAssertTrue(previewLayers(in: view).isEmpty)

    // Same value again: the didSet guard must not re-emit.
    view.sessionCaptureId = "no-such-capture-id"
    XCTAssertEqual(log.attachedFlags.count, 2, "re-setting the same id must not re-attach")

    // Hostile ids: unicode, combining marks, a 1 MB id, NUL, lookalikes of a
    // real live id (upper-cased; the registry is case-sensitive).
    let live = SessionCaptureCoordinator()
    var rng = SeededGenerator()
    let alphabet: [Character] = ["🥒", "🎾", "\u{0301}", "\u{200B}", "a", "-", "\u{0000}", "ß", "İ"]
    let hostile: [String] = [
      String((0..<64).map { _ in alphabet.randomElement(using: &rng)! }),
      String(repeating: "x", count: 1_000_000),
      live.captureId.uppercased(),
      live.captureId + "\u{0000}",
      " " + live.captureId,
      "\u{202E}" + live.captureId,
    ]
    let before = log.attachedFlags.count
    for id in hostile {
      view.sessionCaptureId = id as NSString
      XCTAssertEqual(log.attachedFlags.last ?? nil, false, "hostile id \(id.prefix(24))… must not attach")
      XCTAssertTrue(previewLayers(in: view).isEmpty)
    }
    XCTAssertEqual(log.attachedFlags.count, before + hostile.count, "one state event per distinct id")
    XCTAssertNotNil(SessionCaptureCoordinator.active(withId: live.captureId), "the live coordinator itself stays registered")
  }

  func testLiveIdAttachesThenDetachRemovesLayerAndCoordinatorDeinits() {
    let view = PickleSessionPreviewView(frame: frame)
    let log = StateLog()
    log.bind(view)
    weak var weakCoordinator: SessionCaptureCoordinator?
    weak var weakLayer: AVCaptureVideoPreviewLayer?
    var captureId = ""

    autoreleasepool {
      let coordinator = SessionCaptureCoordinator()
      weakCoordinator = coordinator
      captureId = coordinator.captureId
      XCTAssertNil(coordinator.onPoseFrame, "precondition: nobody subscribed yet")

      view.sessionCaptureId = captureId as NSString
      XCTAssertEqual(log.attachedFlags, [true], "a live id attaches")
      let layers = previewLayers(in: view)
      XCTAssertEqual(layers.count, 1, "exactly one preview layer for a live id")
      XCTAssertNotNil(layers.first?.session, "the layer renders the coordinator's real AVCaptureSession")
      XCTAssertTrue(view.layer.sublayers?.first === layers.first, "preview layer sits below the overlay (index 0)")
      XCTAssertNotNil(coordinator.onPoseFrame, "the view subscribes to measured poses")
      weakLayer = layers.first

      view.sessionCaptureId = nil
      XCTAssertEqual(log.attachedFlags, [true, false], "detaching reports attached:false")
      XCTAssertTrue(previewLayers(in: view).isEmpty, "detaching removes the preview layer")
      XCTAssertNil(coordinator.onPoseFrame, "detaching drops the pose subscription")
      XCTAssertNotNil(
        SessionCaptureCoordinator.active(withId: captureId),
        "detaching a preview surface must not stop or unregister the session"
      )
    }

    XCTAssertNil(weakCoordinator, "the view must not retain the coordinator (weak reference)")
    XCTAssertNil(weakLayer, "no dangling preview layer after detach")
    XCTAssertNil(SessionCaptureCoordinator.active(withId: captureId), "a released coordinator can never be resurrected by lookup")
    XCTAssertTrue(previewLayers(in: view).isEmpty)
  }

  /// The weak reference in the OTHER direction: a still-attached view (never
  /// detached, still alive) must not keep the coordinator alive once the
  /// owner (PickleVideoCapture) releases it.
  func testAttachedViewDoesNotKeepCoordinatorAlive() {
    let view = PickleSessionPreviewView(frame: frame)
    let log = StateLog()
    log.bind(view)
    weak var weakCoordinator: SessionCaptureCoordinator?
    var captureId = ""

    autoreleasepool {
      let coordinator = SessionCaptureCoordinator()
      weakCoordinator = coordinator
      captureId = coordinator.captureId
      view.sessionCaptureId = captureId as NSString
      XCTAssertEqual(log.attachedFlags, [true])
    }

    XCTAssertNil(weakCoordinator, "an attached preview must hold the coordinator weakly")
    XCTAssertNil(SessionCaptureCoordinator.active(withId: captureId))
    // Documented behaviour: the layer (which retains only the AVCaptureSession,
    // not the coordinator) stays installed until the id changes.
    XCTAssertEqual(previewLayers(in: view).count, 1)
    view.sessionCaptureId = nil
    XCTAssertTrue(previewLayers(in: view).isEmpty)
    XCTAssertEqual(log.attachedFlags, [true, false])
  }

  /// A stopped coordinator unregisters itself (SessionCaptureCoordinator.swift:171-178)
  /// even while still alive, so a preview attached afterwards must report
  /// attached:false — the surface never pretends a stopped camera is live.
  func testStoppedCoordinatorIsNotAttachableWhileStillAlive() {
    let coordinator = SessionCaptureCoordinator()
    let id = coordinator.captureId
    XCTAssertNotNil(SessionCaptureCoordinator.active(withId: id))
    coordinator.stop()
    coordinator.stop()  // idempotent
    XCTAssertNil(SessionCaptureCoordinator.active(withId: id), "stop() unregisters")

    let view = PickleSessionPreviewView(frame: frame)
    let log = StateLog()
    log.bind(view)
    view.sessionCaptureId = id as NSString
    XCTAssertEqual(log.attachedFlags, [false])
    XCTAssertTrue(previewLayers(in: view).isEmpty)
    withExtendedLifetime(coordinator) {}
  }

  /// Extra probe — a window round trip. `willMove(toWindow: nil)`
  /// (PickleSessionPreview.swift:57-60) drops the pose subscription but keeps
  /// the preview layer, and nothing re-subscribes when the view is added back
  /// to a window with the SAME id (the didSet guard at line 28 short-circuits
  /// and `attach()` is never called again). A full-screen modal presented over
  /// the host takes the presenting view out of the window and puts it back;
  /// after that the surface still shows live video but the heat-map overlay is
  /// frozen for the rest of the session. Expected RED on 4d812e1a. Impact
  /// note: at 4d812e1a no JS component mounts `PickleSessionPreviewView`
  /// (no requireNativeComponent for it under apps/mobile/src), so this is
  /// latent.
  func testWindowRoundTripKeepsPoseSubscriptionAlive() {
    let window = UIWindow(frame: frame)
    let view = PickleSessionPreviewView(frame: frame)
    let log = StateLog()
    log.bind(view)
    window.addSubview(view)

    let coordinator = SessionCaptureCoordinator()
    view.sessionCaptureId = coordinator.captureId as NSString
    XCTAssertEqual(log.attachedFlags, [true])
    XCTAssertNotNil(coordinator.onPoseFrame, "precondition: subscribed while on screen")

    view.removeFromSuperview()  // → willMove(toWindow: nil)
    XCTAssertNil(coordinator.onPoseFrame, "leaving the window detaches the pose subscription (documented)")
    XCTAssertEqual(previewLayers(in: view).count, 1, "the preview layer is left installed while off-window")

    window.addSubview(view)  // back on screen, same id
    XCTAssertEqual(previewLayers(in: view).count, 1, "live video is still rendered…")
    XCTAssertNotNil(
      coordinator.onPoseFrame,
      "…but the overlay is no longer fed: returning to a window with the same id never re-subscribes"
    )
    XCTAssertEqual(log.attachedFlags, [true], "no state event tells JS the overlay went dark either")
    withExtendedLifetime(coordinator) {}
  }
}
