import AVFoundation
import Foundation
import XCTest

@testable import CameraEngineUnderTest

/// Scenario 5 — the weak active-coordinator registry
/// (SessionCaptureCoordinator.swift:78-112) plus lifecycle attacks on the
/// coordinator that need no camera. All `[sim]`.
final class S5CoordinatorRegistryTests: XCTestCase {
  func test_sim_releaseOne_activeIsNilForIt_anyActiveStaysTrueForOther() {
    var released: SessionCaptureCoordinator? = SessionCaptureCoordinator()
    let kept = SessionCaptureCoordinator()
    let releasedId = released!.captureId
    XCTAssertNotNil(SessionCaptureCoordinator.active(withId: releasedId))
    XCTAssertNotNil(SessionCaptureCoordinator.active(withId: kept.captureId))
    XCTAssertTrue(SessionCaptureCoordinator.anyActive())

    released = nil

    XCTAssertNil(SessionCaptureCoordinator.active(withId: releasedId), "weak entry must never resurrect a released coordinator")
    XCTAssertTrue(SessionCaptureCoordinator.active(withId: kept.captureId) === kept)
    XCTAssertTrue(SessionCaptureCoordinator.anyActive(), "the surviving coordinator keeps anyActive() true")
    withExtendedLifetime(kept) {}
  }

  func test_sim_releaseBoth_anyActiveFalse() {
    var a: SessionCaptureCoordinator? = SessionCaptureCoordinator()
    var b: SessionCaptureCoordinator? = SessionCaptureCoordinator()
    let ids = [a!.captureId, b!.captureId]
    XCTAssertTrue(SessionCaptureCoordinator.anyActive())
    a = nil
    b = nil
    XCTAssertFalse(SessionCaptureCoordinator.anyActive())
    for id in ids { XCTAssertNil(SessionCaptureCoordinator.active(withId: id)) }
  }

  /// `stop()` unregisters eagerly (line 175) even though the object is alive:
  /// a stopped-but-retained coordinator is invisible to lookups and does not
  /// keep the keep-awake owner alive.
  func test_sim_stopUnregistersWhileStillRetained() {
    let coordinator = SessionCaptureCoordinator()
    XCTAssertNotNil(SessionCaptureCoordinator.active(withId: coordinator.captureId))
    coordinator.stop()
    XCTAssertNil(SessionCaptureCoordinator.active(withId: coordinator.captureId))
    XCTAssertFalse(SessionCaptureCoordinator.anyActive())
    coordinator.stop() // idempotent
    XCTAssertFalse(SessionCaptureCoordinator.anyActive())
    withExtendedLifetime(coordinator) {}
  }

  func test_sim_lookupOfUnknownOrHostileIds_isNil() {
    let coordinator = SessionCaptureCoordinator()
    for id in ["", coordinator.captureId.uppercased(), "日本語", String(repeating: "x", count: 100_000), "\u{0}"] {
      XCTAssertNil(SessionCaptureCoordinator.active(withId: id), "id \(id.prefix(20))…")
    }
    XCTAssertTrue(SessionCaptureCoordinator.active(withId: coordinator.captureId) === coordinator)
    withExtendedLifetime(coordinator) {}
  }

  /// Seeded churn: create/release/stop in a random order across 300
  /// coordinators (some from background threads) and check the registry
  /// against a model after every step. Seed printed for replay.
  func test_sim_seededChurn_registryMatchesModel() {
    let seed: UInt64 = 0x4D81_2E1A_0000_0005
    var rng = AttackSupport.SeededGenerator(seed: seed)
    print("S5 churn seed: 0x\(String(seed, radix: 16))")
    var live: [String: SessionCaptureCoordinator] = [:]
    var stoppedButRetained: [String: SessionCaptureCoordinator] = [:]
    var releasedIds: [String] = []

    for step in 0..<300 {
      switch Int.random(in: 0..<10, using: &rng) {
      case 0..<5:
        let coordinator: SessionCaptureCoordinator = Bool.random(using: &rng)
          ? SessionCaptureCoordinator()
          : DispatchQueue.global(qos: .userInitiated).sync { SessionCaptureCoordinator() }
        live[coordinator.captureId] = coordinator
      case 5..<8:
        if let id = live.keys.sorted().randomElement(using: &rng) {
          live[id] = nil
          releasedIds.append(id)
        }
      default:
        if let id = live.keys.sorted().randomElement(using: &rng), let coordinator = live.removeValue(forKey: id) {
          coordinator.stop()
          stoppedButRetained[id] = coordinator
        }
      }
      for id in live.keys {
        XCTAssertTrue(SessionCaptureCoordinator.active(withId: id) === live[id], "step \(step): live \(id) missing")
      }
      for id in stoppedButRetained.keys {
        XCTAssertNil(SessionCaptureCoordinator.active(withId: id), "step \(step): stopped \(id) still active")
      }
      for id in releasedIds {
        XCTAssertNil(SessionCaptureCoordinator.active(withId: id), "step \(step): released \(id) resurrected")
      }
      XCTAssertEqual(SessionCaptureCoordinator.anyActive(), !live.isEmpty, "step \(step)")
    }
    withExtendedLifetime(stoppedButRetained) {}
    live.removeAll()
    XCTAssertFalse(SessionCaptureCoordinator.anyActive())
  }

  // MARK: Coordinator ↔ engine wiring

  /// The coordinator never assigns `engine.onSessionEvent`
  /// (SessionCaptureCoordinator.swift:150-169 sets only onFrame and
  /// onRecordingFinished). A runtime error, an interruption or a failed
  /// `startRunning` on the ROLLING session therefore has no listener; JS keeps
  /// receiving nothing and `extract` reports `recordingNotStarted` ("has not
  /// produced any frames yet") for a session that is dead. Pinned here so a
  /// future wiring change flips the test.
  func test_sim_coordinatorLeavesEngineSessionEventsUnobserved() throws {
    let coordinator = SessionCaptureCoordinator()
    let engine = try AttackSupport.engine(of: coordinator)
    XCTAssertNil(engine.onSessionEvent, "no session-event listener is installed at init")
    XCTAssertNil(engine.onFrame, "onFrame is only wired inside start()")
    XCTAssertNil(engine.onRecordingFinished, "onRecordingFinished is only wired inside start()")
    withExtendedLifetime(coordinator) {}
  }

  /// On a camera-less destination `start()` must throw `configurationFailed`
  /// and leave the coordinator registered (the caller owns cleanup) with no
  /// recording URL claimed on disk.
  func test_sim_startWithoutCamera_throwsConfigurationFailed_andLeavesNoObservationFile() async throws {
    guard !AttackSupport.hasAnyVideoDevice() else {
      throw XCTSkip("[sim-only] this destination has a camera; the camera-less start path cannot be exercised here")
    }
    // start() asks for permission BEFORE it discovers there is no camera
    // (CameraEngine.swift:134-149); an undetermined status would prompt.
    try AttackSupport.guardCameraPermissionPrompt()
    let coordinator = SessionCaptureCoordinator()
    let observationDirectory = FileManager.default.temporaryDirectory
      .appendingPathComponent("PickleSensei-Observation", isDirectory: true)
    let before = Set((try? FileManager.default.contentsOfDirectory(atPath: observationDirectory.path)) ?? [])
    do {
      try await coordinator.start()
      XCTFail("start() must throw without a camera")
    } catch let error as CameraEngine.EngineError {
      switch error {
      case .configurationFailed, .permissionDenied:
        break
      default:
        XCTFail("unexpected \(error)")
      }
    }
    let after = Set((try? FileManager.default.contentsOfDirectory(atPath: observationDirectory.path)) ?? [])
    XCTAssertEqual(after.subtracting(before), [], "a failed start must not leave an observation file behind")
    XCTAssertNotNil(SessionCaptureCoordinator.active(withId: coordinator.captureId))
    coordinator.stop()
    XCTAssertNil(SessionCaptureCoordinator.active(withId: coordinator.captureId))
  }

  /// `stop()` on a never-started coordinator must be harmless: the engine
  /// emits nothing the coordinator listens to, and no recording callbacks fire.
  func test_sim_stopBeforeStart_isHarmless_andExtractReportsAlreadyStopped() throws {
    let coordinator = SessionCaptureCoordinator()
    coordinator.stop()
    let recorder = ExtractCompletionRecorder()
    coordinator.extract(eventStartMs: 0, eventEndMs: 1_000, peakMs: 500, confidence: 1,
                        detectionModelVersion: "attack-4", completion: recorder.completion)
    recorder.markCallReturned()
    XCTAssertTrue(recorder.arrivedSynchronously)
    XCTAssertTrue(recorder.coordinatorError?.isAlreadyStopped == true)
  }
}
