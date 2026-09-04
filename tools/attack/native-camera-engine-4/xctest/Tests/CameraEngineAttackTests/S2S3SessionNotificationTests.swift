import AVFoundation
import Foundation
import XCTest

@testable import CameraEngineUnderTest

/// Scenarios 2 + 3 — AVCaptureSession notification handling.
///
/// Observers are installed ONLY inside `configureLocked()`
/// (CameraEngine.swift:263 → installObservers 610-631) and are scoped to
/// `object: session`. Consequences under test:
///   [sim]    before configuration NOTHING is observed — a runtime error /
///            interruption posted on the engine's own session yields no event;
///   [device] after configuration: nil-error fallback text, reason mapping,
///            `object: nil` and foreign-session notifications ignored.
final class S2S3SessionNotificationTests: XCTestCase {
  private func post(_ name: Notification.Name, object: Any?, userInfo: [AnyHashable: Any]? = nil) {
    NotificationCenter.default.post(name: name, object: object, userInfo: userInfo)
  }

  private func interruptionUserInfo(_ reason: AVCaptureSession.InterruptionReason) -> [AnyHashable: Any] {
    [AVCaptureSessionInterruptionReasonKey: NSNumber(value: reason.rawValue)]
  }

  // MARK: [sim]

  func test_sim_unconfiguredEngine_ignoresRuntimeErrorAndInterruption() throws {
    let engine = CameraEngine()
    let recorder = SessionEventRecorder()
    recorder.attach(to: engine)
    let session = try AttackSupport.session(of: engine)

    post(.AVCaptureSessionRuntimeError, object: session)
    post(.AVCaptureSessionWasInterrupted, object: session,
         userInfo: interruptionUserInfo(.videoDeviceNotAvailableWithMultipleForegroundApps))
    post(.AVCaptureSessionInterruptionEnded, object: session)
    post(.AVCaptureSessionRuntimeError, object: nil)

    AttackSupport.waitUntil(0.5) { false }
    XCTAssertEqual(
      recorder.descriptions, [],
      "observers are installed at configure time (CameraEngine.swift:263); before that no session notification is observed"
    )
  }

  /// Posting a runtime error carrying a real NSError on a session that is NOT
  /// the engine's must never leak into the engine's event stream, configured
  /// or not.
  func test_sim_foreignSessionNotifications_areIgnored() throws {
    let engine = CameraEngine()
    let recorder = SessionEventRecorder()
    recorder.attach(to: engine)
    let foreign = AVCaptureSession()
    let error = NSError(domain: AVFoundationErrorDomain, code: AVError.Code.unknown.rawValue,
                        userInfo: [NSLocalizedDescriptionKey: "foreign"])
    post(.AVCaptureSessionRuntimeError, object: foreign, userInfo: [AVCaptureSessionErrorKey: error])
    post(.AVCaptureSessionWasInterrupted, object: foreign,
         userInfo: interruptionUserInfo(.videoDeviceInUseByAnotherClient))
    AttackSupport.waitUntil(0.3) { false }
    XCTAssertEqual(recorder.descriptions, [])
  }

  // MARK: [device] scenario 2 — runtime error

  private func configuredEngine() async throws -> (CameraEngine, SessionEventRecorder, AVCaptureSession) {
    let engine = CameraEngine()
    let recorder = SessionEventRecorder()
    recorder.attach(to: engine)
    try await AttackSupport.requireCamera(engine)
    let session = try AttackSupport.session(of: engine)
    XCTAssertTrue(
      AttackSupport.waitUntil(2) { recorder.descriptions.contains("configured") },
      "configure must emit .configured; got \(recorder.descriptions)"
    )
    return (engine, recorder, session)
  }

  private func eventsAfterConfigured(_ recorder: SessionEventRecorder) -> [String] {
    let all = recorder.descriptions
    guard let index = all.firstIndex(of: "configured") else { return all }
    return Array(all[(index + 1)...])
  }

  func test_device_runtimeError_withoutErrorKey_fallsBackToGenericMessage() async throws {
    let (engine, recorder, session) = try await configuredEngine()
    defer { withExtendedLifetime(engine) {} }
    post(.AVCaptureSessionRuntimeError, object: session, userInfo: nil)
    XCTAssertTrue(AttackSupport.waitUntil(2) { !eventsAfterConfigured(recorder).isEmpty })
    XCTAssertEqual(eventsAfterConfigured(recorder), ["failed(The camera session failed.)"])
  }

  func test_device_runtimeError_withNonErrorValueUnderErrorKey_fallsBackToGenericMessage() async throws {
    let (engine, recorder, session) = try await configuredEngine()
    defer { withExtendedLifetime(engine) {} }
    // A String under AVCaptureSessionErrorKey is not an Error → `as? Error` fails → fallback.
    post(.AVCaptureSessionRuntimeError, object: session, userInfo: [AVCaptureSessionErrorKey: "not an error"])
    XCTAssertTrue(AttackSupport.waitUntil(2) { !eventsAfterConfigured(recorder).isEmpty })
    XCTAssertEqual(eventsAfterConfigured(recorder), ["failed(The camera session failed.)"])
  }

  func test_device_runtimeError_withNSError_forwardsLocalizedDescription() async throws {
    let (engine, recorder, session) = try await configuredEngine()
    defer { withExtendedLifetime(engine) {} }
    let error = NSError(domain: AVFoundationErrorDomain, code: AVError.Code.mediaServicesWereReset.rawValue,
                        userInfo: [NSLocalizedDescriptionKey: "Media services were reset — 日本語 ✓"])
    post(.AVCaptureSessionRuntimeError, object: session, userInfo: [AVCaptureSessionErrorKey: error])
    XCTAssertTrue(AttackSupport.waitUntil(2) { !eventsAfterConfigured(recorder).isEmpty })
    XCTAssertEqual(eventsAfterConfigured(recorder), ["failed(Media services were reset — 日本語 ✓)"])
  }

  // MARK: [device] scenario 3 — interruption

  func test_device_interruption_multipleForegroundApps_thenEnded_objectNilIgnored() async throws {
    let (engine, recorder, session) = try await configuredEngine()
    defer { withExtendedLifetime(engine) {} }

    // object: nil is NOT delivered to observers scoped to object: session.
    post(.AVCaptureSessionWasInterrupted, object: nil,
         userInfo: interruptionUserInfo(.videoDeviceNotAvailableWithMultipleForegroundApps))
    AttackSupport.waitUntil(0.3) { false }
    XCTAssertEqual(eventsAfterConfigured(recorder), [], "object: nil notification must be ignored")

    post(.AVCaptureSessionWasInterrupted, object: session,
         userInfo: interruptionUserInfo(.videoDeviceNotAvailableWithMultipleForegroundApps))
    XCTAssertTrue(AttackSupport.waitUntil(2) { eventsAfterConfigured(recorder).count >= 1 })
    post(.AVCaptureSessionInterruptionEnded, object: session)
    XCTAssertTrue(AttackSupport.waitUntil(2) { eventsAfterConfigured(recorder).count >= 2 })

    XCTAssertEqual(
      eventsAfterConfigured(recorder),
      ["interrupted(videoDeviceNotAvailableWithMultipleForegroundApps)", "interruptionEnded"]
    )
    print("S3 String(describing:) of the reason on this SDK: "
      + String(describing: AVCaptureSession.InterruptionReason.videoDeviceNotAvailableWithMultipleForegroundApps))
  }

  func test_device_interruption_unknownRawReason_mapsToUnknown() async throws {
    let (engine, recorder, session) = try await configuredEngine()
    defer { withExtendedLifetime(engine) {} }
    post(.AVCaptureSessionWasInterrupted, object: session,
         userInfo: [AVCaptureSessionInterruptionReasonKey: NSNumber(value: 999)])
    post(.AVCaptureSessionWasInterrupted, object: session,
         userInfo: [AVCaptureSessionInterruptionReasonKey: "videoDeviceNotAvailableWithMultipleForegroundApps"])
    post(.AVCaptureSessionWasInterrupted, object: session, userInfo: nil)
    XCTAssertTrue(AttackSupport.waitUntil(2) { eventsAfterConfigured(recorder).count >= 3 })
    XCTAssertEqual(
      eventsAfterConfigured(recorder),
      ["interrupted(unknown)", "interrupted(unknown)", "interrupted(unknown)"]
    )
  }

  /// Interleaving: 50 interrupted/ended pairs posted back-to-back from a
  /// background queue must arrive complete and in order (the handlers emit
  /// synchronously on the posting thread; nothing coalesces).
  func test_device_rapidInterruptionPairs_preserveOrder() async throws {
    let (engine, recorder, session) = try await configuredEngine()
    defer { withExtendedLifetime(engine) {} }
    let reasons: [AVCaptureSession.InterruptionReason] = [
      .videoDeviceNotAvailableInBackground,
      .audioDeviceInUseByAnotherClient,
      .videoDeviceInUseByAnotherClient,
      .videoDeviceNotAvailableWithMultipleForegroundApps,
    ]
    var expected: [String] = []
    for index in 0..<50 {
      let reason = reasons[index % reasons.count]
      expected.append("interrupted(\(String(describing: reason)))")
      expected.append("interruptionEnded")
    }
    DispatchQueue.global(qos: .userInitiated).async {
      for index in 0..<50 {
        let reason = reasons[index % reasons.count]
        self.post(.AVCaptureSessionWasInterrupted, object: session, userInfo: self.interruptionUserInfo(reason))
        self.post(.AVCaptureSessionInterruptionEnded, object: session)
      }
    }
    XCTAssertTrue(AttackSupport.waitUntil(5) { eventsAfterConfigured(recorder).count >= 100 })
    XCTAssertEqual(eventsAfterConfigured(recorder), expected)
  }
}
