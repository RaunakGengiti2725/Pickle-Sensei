import Foundation
import XCTest
@testable import PickleVisionCore

/// Adversarial pass 3 (S17 / S20) against `ApplePoseProvider`'s primary-person
/// anchor. Apple plane only (the provider imports Vision).
///
/// S17 — out-of-range seeds. `setPrimaryPersonSeed` performs only the y-flip:
///       (1.5, -0.3) is stored as (1.5, 1.3) and `resetPrimaryPersonAnchor()`
///       clears it. Nothing validates the seed: non-finite values are stored
///       too. The JS bridge (`apps/mobile/src/camera/capture.ts`
///       `extractImportedPoseSequence`) rejects seeds outside [0,1] before they
///       reach `PickleVideoCapture`, so the shipping UI cannot produce one; the
///       native boundary itself has no guard.
/// S20 — two queues hammer `setPrimaryPersonSeed` / `resetPrimaryPersonAnchor`
///       10 000 times each while a third reads the anchor. Every access goes
///       through `stateLock`, so a Thread Sanitizer run must be silent:
///
///   xcodebuild test -scheme PickleVisionCore -destination 'platform=macOS,arch=arm64' \
///     -enableThreadSanitizer YES \
///     -only-testing:PickleVisionCoreTests/AdversarialPass3ApplePoseProviderTests
final class AdversarialPass3ApplePoseProviderTests: XCTestCase {
  // MARK: - S17

  func testS17OutOfRangeSeedIsStoredFlippedAndResetClearsIt() {
    let provider = ApplePoseProvider()
    provider.setPrimaryPersonSeed(x: 1.5, y: -0.3)
    let anchor = provider.primaryPersonAnchorForTesting
    XCTAssertNotNil(anchor)
    XCTAssertEqual(anchor?.x ?? .nan, 1.5, accuracy: 1e-12)
    XCTAssertEqual(anchor?.y ?? .nan, 1.3, accuracy: 1e-12)

    provider.resetPrimaryPersonAnchor()
    XCTAssertNil(provider.primaryPersonAnchorForTesting)
  }

  /// Every out-of-range / degenerate seed is accepted verbatim (after the
  /// flip). Pinned so a future validation shows up as an intentional change.
  func testS17NoSeedIsRejectedAtTheNativeBoundary() {
    let provider = ApplePoseProvider()
    let seeds: [(x: Double, y: Double)] = [
      (-1, -1), (2, 2), (1e9, -1e9), (0, 0), (1, 1),
      (Double.greatestFiniteMagnitude, -Double.greatestFiniteMagnitude),
    ]
    for seed in seeds {
      provider.setPrimaryPersonSeed(x: seed.x, y: seed.y)
      let anchor = provider.primaryPersonAnchorForTesting
      XCTAssertEqual(anchor?.x ?? .nan, seed.x, "seed \(seed) x")
      XCTAssertEqual(anchor?.y ?? .nan, 1 - seed.y, "seed \(seed) y")
    }
    provider.setPrimaryPersonSeed(x: .nan, y: .nan)
    XCTAssertTrue(provider.primaryPersonAnchorForTesting?.x.isNaN == true, "NaN seed is stored")
    provider.setPrimaryPersonSeed(x: .infinity, y: -.infinity)
    XCTAssertEqual(provider.primaryPersonAnchorForTesting?.x, .infinity)
    XCTAssertEqual(provider.primaryPersonAnchorForTesting?.y, .infinity)
    provider.resetPrimaryPersonAnchor()
    XCTAssertNil(provider.primaryPersonAnchorForTesting)
  }

  /// With no people detected the anchor plays no role; `primaryPerson` must
  /// tolerate any anchor, including one far outside the image or non-finite,
  /// without trapping.
  func testS17PrimaryPersonWithNoObservationsIsNilForAnyAnchor() {
    XCTAssertNil(ApplePoseProvider.primaryPerson(in: [], anchor: CGPoint(x: 1.5, y: 1.3)))
    XCTAssertNil(ApplePoseProvider.primaryPerson(in: [], anchor: CGPoint(x: Double.nan, y: Double.nan)))
    XCTAssertNil(ApplePoseProvider.primaryPerson(in: [], anchor: CGPoint(x: Double.infinity, y: -Double.infinity)))
    XCTAssertNil(ApplePoseProvider.primaryPerson(in: [], anchor: nil))
  }

  /// Reset is idempotent and a reset provider behaves like a fresh one.
  func testS17ResetIsIdempotent() {
    let provider = ApplePoseProvider()
    for _ in 0 ..< 1_000 { provider.resetPrimaryPersonAnchor() }
    XCTAssertNil(provider.primaryPersonAnchorForTesting)
    provider.setPrimaryPersonSeed(x: 0.5, y: 0.5)
    provider.resetPrimaryPersonAnchor()
    provider.resetPrimaryPersonAnchor()
    XCTAssertNil(provider.primaryPersonAnchorForTesting)
  }

  // MARK: - S20

  func testS20ConcurrentSeedAndResetFromTwoQueuesHasNoDataRace() {
    let provider = ApplePoseProvider()
    let iterations = 10_000
    let seedQueue = DispatchQueue(label: "pickle.attack.seed", qos: .userInteractive)
    let resetQueue = DispatchQueue(label: "pickle.attack.reset", qos: .userInteractive)
    let readQueue = DispatchQueue(label: "pickle.attack.read", qos: .userInitiated)
    let group = DispatchGroup()

    group.enter()
    seedQueue.async {
      for index in 0 ..< iterations {
        let value = Double(index) / Double(iterations)
        provider.setPrimaryPersonSeed(x: value, y: 1 - value)
      }
      group.leave()
    }
    group.enter()
    resetQueue.async {
      for _ in 0 ..< iterations { provider.resetPrimaryPersonAnchor() }
      group.leave()
    }
    let observed = ReadTally()
    group.enter()
    readQueue.async {
      for _ in 0 ..< iterations {
        guard let anchor = provider.primaryPersonAnchorForTesting else {
          observed.record(.nilAnchor)
          continue
        }
        // Every stored anchor is (v, v): a torn read would break the invariant.
        observed.record(abs(anchor.x - anchor.y) > 1e-12 ? .torn : .value)
      }
      group.leave()
    }
    XCTAssertEqual(group.wait(timeout: .now() + 60), .success, "20 000 lock-protected writes did not finish in 60 s")
    XCTAssertEqual(observed.count(of: .torn), 0, "read a torn anchor: writes are not atomic under stateLock")
    XCTAssertEqual(observed.count(of: .nilAnchor) + observed.count(of: .value), iterations)

    // Deterministic tail: the last word wins, whatever the interleaving was.
    provider.resetPrimaryPersonAnchor()
    XCTAssertNil(provider.primaryPersonAnchorForTesting)
    provider.setPrimaryPersonSeed(x: 0.25, y: 0.75)
    XCTAssertEqual(provider.primaryPersonAnchorForTesting?.x ?? .nan, 0.25, accuracy: 1e-12)
    XCTAssertEqual(provider.primaryPersonAnchorForTesting?.y ?? .nan, 0.25, accuracy: 1e-12)
  }

  /// `concurrentPerform` variant: N-way contention on the same lock, every
  /// iteration both seeds and resets.
  func testS20ConcurrentPerformSeedResetStorm() {
    let provider = ApplePoseProvider()
    DispatchQueue.concurrentPerform(iterations: 20_000) { index in
      if index % 2 == 0 {
        provider.setPrimaryPersonSeed(x: 0.5, y: 0.5)
      } else {
        provider.resetPrimaryPersonAnchor()
      }
      _ = provider.primaryPersonAnchorForTesting
    }
    provider.resetPrimaryPersonAnchor()
    XCTAssertNil(provider.primaryPersonAnchorForTesting)
  }
}

/// Lock-protected tally so the S20 harness introduces no race of its own —
/// any TSan report must originate in `ApplePoseProvider`.
private final class ReadTally: @unchecked Sendable {
  enum Outcome: Hashable { case nilAnchor, value, torn }
  private let lock = NSLock()
  private var counts: [Outcome: Int] = [:]
  func record(_ outcome: Outcome) {
    lock.lock(); counts[outcome, default: 0] += 1; lock.unlock()
  }
  func count(of outcome: Outcome) -> Int {
    lock.lock(); defer { lock.unlock() }; return counts[outcome] ?? 0
  }
}
