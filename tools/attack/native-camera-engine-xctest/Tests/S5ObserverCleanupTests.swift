// Scenario 5 — AVCaptureSession notification observers must die with the
// engine.
//
// CameraEngine.swift:610-637 installs three NotificationCenter observers
// (`WasInterrupted`, `InterruptionEnded`, `RuntimeError`) scoped to the
// engine's own `session`; 638-642 (`removeObservers`) runs from `deinit`
// (CameraEngine.swift:130-132). Observers are installed only from
// `configureAuthorizedSession` (line 289), so an UNCONFIGURED engine must
// ignore the notifications too. The attack keeps the AVCaptureSession alive
// through a preview layer (the layer retains the session, not the engine),
// lets the engine deinit, and then posts the notifications the session would
// emit.
import AVFoundation
import Foundation
import XCTest

@testable import PickleCameraEngineUnderTest

final class S5ObserverCleanupTests: XCTestCase {
  private func post(_ name: Notification.Name, on session: AVCaptureSession, userInfo: [AnyHashable: Any]? = nil) {
    NotificationCenter.default.post(name: name, object: session, userInfo: userInfo)
  }

  private func interruption(_ reason: AVCaptureSession.InterruptionReason) -> [AnyHashable: Any] {
    [AVCaptureSessionInterruptionReasonKey: NSNumber(value: reason.rawValue)]
  }

  private func runtimeError() -> [AnyHashable: Any] {
    [AVCaptureSessionErrorKey: NSError(domain: AVFoundationErrorDomain, code: AVError.Code.mediaServicesWereReset.rawValue)]
  }

  /// ANY destination. An unconfigured engine has no observers: nothing may be
  /// emitted while it is alive, and nothing after it is gone. Also proves
  /// `makePreviewLayer()` hands out the engine's real session object.
  func testUnconfiguredEngineIgnoresSessionNotificationsAliveAndAfterDeinit() {
    let recorder = EngineCallbackRecorder()
    weak var weakEngine: CameraEngine?
    var layer: AVCaptureVideoPreviewLayer!

    autoreleasepool {
      let engine = CameraEngine()
      recorder.attach(to: engine)
      weakEngine = engine
      layer = engine.makePreviewLayer()
      XCTAssertNotNil(layer.session)
      XCTAssertTrue(engine.makePreviewLayer().session === layer.session, "every preview layer shares the engine's one session")

      post(.AVCaptureSessionWasInterrupted, on: layer.session!, userInfo: interruption(.videoDeviceInUseByAnotherClient))
      post(.AVCaptureSessionInterruptionEnded, on: layer.session!)
      post(.AVCaptureSessionRuntimeError, on: layer.session!, userInfo: runtimeError())
      engine.attackDrainSessionQueue()
      XCTAssertEqual(recorder.eventLabels, [], "an unconfigured engine must not observe its session yet")
    }

    XCTAssertNil(weakEngine, "nothing may retain the engine once its owner lets go (the layer retains only the session)")
    let session = layer.session!
    for _ in 0..<50 {
      post(.AVCaptureSessionWasInterrupted, on: session, userInfo: interruption(.audioDeviceInUseByAnotherClient))
      post(.AVCaptureSessionInterruptionEnded, on: session)
      post(.AVCaptureSessionRuntimeError, on: session, userInfo: runtimeError())
    }
    RunLoop.current.run(until: Date().addingTimeInterval(0.2))
    XCTAssertEqual(recorder.eventLabels, [], "no callback may fire after the engine is gone")
  }

  private final class WeakEngineBox {
    weak var engine: CameraEngine?
  }

  /// Configures an engine, proves its observers are live, and returns only
  /// the preview layer (which retains the session) — the engine itself goes
  /// out of scope when this returns.
  private func configureProbeAndRelease(
    recorder: EngineCallbackRecorder,
    box: WeakEngineBox
  ) async throws -> AVCaptureVideoPreviewLayer {
    let engine = try await CameraPlane.configuredEngine(recorder: recorder)
    box.engine = engine
    let layer = engine.makePreviewLayer()
    engine.attackDrainSessionQueue()
    XCTAssertEqual(recorder.eventLabels.first, "configured")

    let interrupted = expectation(description: "interruption observed while alive")
    interrupted.assertForOverFulfill = false
    recorder.onAnySessionEvent = { interrupted.fulfill() }
    post(.AVCaptureSessionWasInterrupted, on: layer.session!, userInfo: interruption(.videoDeviceNotAvailableInBackground))
    _ = await XCTWaiter().fulfillment(of: [interrupted], timeout: 2)
    engine.attackDrainSessionQueue()
    XCTAssertTrue(
      recorder.eventLabels.contains { $0.hasPrefix("interrupted(") && $0 != "interrupted(unknown)" },
      "precondition: a live configured engine observes its session and decodes the reason: \(recorder.eventLabels)"
    )
    recorder.onAnySessionEvent = nil
    return layer
  }

  /// DEVICE PLANE (skips on the Simulator): configure the engine (observers
  /// installed), prove they are wired by posting one interruption while
  /// alive, then release the engine while the layer keeps the session alive
  /// and post again — nothing may arrive and nothing may crash.
  func testConfiguredEngineObserversAreRemovedInDeinit() async throws {
    let recorder = EngineCallbackRecorder()
    let box = WeakEngineBox()
    let layer = try await configureProbeAndRelease(recorder: recorder, box: box)
    let labelsWhileAlive = recorder.eventLabels

    XCTAssertNil(box.engine, "the engine must deinit while the layer still holds its AVCaptureSession")
    let session = layer.session!
    for _ in 0..<20 {
      post(.AVCaptureSessionWasInterrupted, on: session, userInfo: interruption(.videoDeviceInUseByAnotherClient))
      post(.AVCaptureSessionInterruptionEnded, on: session)
      post(.AVCaptureSessionRuntimeError, on: session, userInfo: runtimeError())
    }
    try await Task.sleep(nanoseconds: 300_000_000)
    XCTAssertEqual(recorder.eventLabels, labelsWhileAlive, "no observer may outlive the engine")
  }
}
