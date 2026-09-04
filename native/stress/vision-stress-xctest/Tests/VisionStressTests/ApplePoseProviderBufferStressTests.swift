import CoreVideo
import Foundation
import PickleVisionCore
import StressSupport
import XCTest

/// Feeds ApplePoseProvider the buffer shapes CameraEngine/UprightVideoReader
/// can never guarantee against: degenerate sizes, huge frames, foreign pixel
/// formats, and garbage contents. Invariant under stress: the provider either
/// throws or returns a finite, in-bounds PoseFrame — it never traps and never
/// leaks the buffer (checked via the memory-pressure loop).
final class ApplePoseProviderBufferStressTests: XCTestCase {
  private static let table = StressResultTable(suite: "ApplePoseProviderBufferStress")

  override class func tearDown() {
    if let url = table.flush() { print("STRESS_RESULTS \(url.path)") }
    super.tearDown()
  }

  private func assertWellFormed(_ pose: PoseFrame, _ context: String) {
    XCTAssertTrue(pose.confidence.isFinite, "\(context): confidence not finite")
    XCTAssertTrue((0...1).contains(pose.confidence), "\(context): confidence out of range")
    XCTAssertFalse(pose.landmarks.isEmpty, "\(context): empty landmark list")
    for landmark in pose.landmarks {
      XCTAssertTrue(landmark.x.isFinite && landmark.y.isFinite && landmark.visibility.isFinite,
                    "\(context): non-finite landmark \(landmark.name)")
      XCTAssertTrue((0...1).contains(landmark.visibility), "\(context): visibility out of range")
      XCTAssertTrue(SyntheticPose.jointNames.contains(landmark.name),
                    "\(context): unknown joint name \(landmark.name)")
    }
  }

  /// Returns a short outcome label after running both extraction entry points.
  private func exercise(
    _ provider: ApplePoseProvider,
    _ buffer: CVPixelBuffer,
    timestampMs: Int,
    context: String
  ) -> String {
    var label = ""
    do {
      let pose = try provider.extractPose(pixelBuffer: buffer, timestampMs: timestampMs)
      assertWellFormed(pose, context)
      XCTAssertEqual(pose.timestampMs, timestampMs, "\(context): timestamp not echoed")
      label += "pose"
    } catch let failure as VisionFailure {
      label += "throw(\(failure))"
    } catch {
      label += "throw(\(type(of: error)))"
    }
    do {
      let everyone = try provider.extractAllPoses(pixelBuffer: buffer, timestampMs: timestampMs)
      for pose in everyone { assertWellFormed(pose, context) }
      label += "/all=\(everyone.count)"
    } catch {
      label += "/all-throw"
    }
    return label
  }

  func testZeroSizedBufferCannotBeConstructed() {
    // CoreVideo refuses 0×N and N×0; document the boundary the provider
    // relies on (CameraEngine can therefore never hand over an empty frame).
    XCTAssertNil(PixelBufferFactory.make(width: 0, height: 0, fill: .constant(0)))
    XCTAssertNil(PixelBufferFactory.make(width: 0, height: 16, fill: .constant(0)))
    XCTAssertNil(PixelBufferFactory.make(width: 16, height: 0, fill: .constant(0)))
    Self.table.record(test: #function, seed: nil, outcome: "HELD", detail: "0-sized buffers refused by CoreVideo")
  }

  func testOnePixelBufferNeverTraps() {
    let provider = ApplePoseProvider()
    for seed in StressCampaign.seeds() {
      guard let buffer = PixelBufferFactory.make(width: 1, height: 1, fill: .noise(seed: seed)) else {
        XCTFail("seed \(seed): could not allocate 1×1 buffer")
        Self.table.record(test: #function, seed: seed, outcome: "ALLOC_FAIL", detail: "")
        continue
      }
      let label = exercise(provider, buffer, timestampMs: Int(seed % 100_000), context: "seed \(seed) 1×1")
      Self.table.record(test: #function, seed: seed, outcome: "HELD", detail: label)
    }
  }

  func testTinyAndOddSizedBuffersNeverTrap() {
    let provider = ApplePoseProvider()
    let sizes = [(2, 2), (3, 7), (17, 1), (1, 640), (33, 33), (63, 127)]
    for seed in StressCampaign.seeds() {
      var rng = SeededRNG(seed: seed)
      let (width, height) = sizes[rng.int(in: 0...(sizes.count - 1))]
      guard let buffer = PixelBufferFactory.make(width: width, height: height, fill: .noise(seed: seed)) else {
        XCTFail("seed \(seed): could not allocate \(width)×\(height)")
        continue
      }
      let label = exercise(provider, buffer, timestampMs: 1_000, context: "seed \(seed) \(width)×\(height)")
      Self.table.record(test: #function, seed: seed, outcome: "HELD", detail: "\(width)x\(height) \(label)")
    }
  }

  func testHugeBufferCompletesWithinBudget() throws {
    let provider = ApplePoseProvider()
    // 4096×4096 BGRA = 64 MiB; larger than any camera format the engine
    // selects, so this is strictly a robustness bound.
    let seed = StressCampaign.seeds(count: 1)[0]
    try autoreleasepool {
      guard let buffer = PixelBufferFactory.make(width: 4_096, height: 4_096, fill: .noise(seed: seed)) else {
        throw XCTSkip("host could not allocate a 64 MiB pixel buffer")
      }
      let started = Date()
      let label = exercise(provider, buffer, timestampMs: 0, context: "huge")
      let elapsed = Date().timeIntervalSince(started)
      XCTAssertLessThan(elapsed, 60, "huge frame took \(elapsed)s")
      Self.table.record(test: #function, seed: seed, outcome: "HELD", detail: "\(label) in \(Int(elapsed * 1000))ms")
    }
  }

  func testForeignPixelFormatsThrowOrReturnWellFormed() {
    let provider = ApplePoseProvider()
    let formats: [(String, OSType)] = [
      ("420f", kCVPixelFormatType_420YpCbCr8BiPlanarFullRange),  // CameraEngine's output format
      ("420v", kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange),
      ("BGRA", kCVPixelFormatType_32BGRA),                        // UprightVideoReader's format
      ("ARGB", kCVPixelFormatType_32ARGB),
      ("RGBA", kCVPixelFormatType_32RGBA),
      ("24RGB", kCVPixelFormatType_24RGB),
      ("L008", kCVPixelFormatType_OneComponent8),
      ("L016", kCVPixelFormatType_16Gray),
      ("2vuy", kCVPixelFormatType_422YpCbCr8),
      ("yuvs", kCVPixelFormatType_422YpCbCr8_yuvs),
      ("2C08", kCVPixelFormatType_TwoComponent8),
      ("RGhA", kCVPixelFormatType_64RGBAHalf),
    ]
    for seed in StressCampaign.seeds() {
      for (name, format) in formats {
        autoreleasepool {
          guard let buffer = PixelBufferFactory.make(width: 256, height: 192, format: format, fill: .noise(seed: seed)) else {
            Self.table.record(test: #function, seed: seed, outcome: "SKIPPED", detail: "\(name): CoreVideo refused format")
            return
          }
          let label = exercise(provider, buffer, timestampMs: 500, context: "seed \(seed) \(name)")
          Self.table.record(test: #function, seed: seed, outcome: "HELD", detail: "\(name): \(label)")
        }
      }
    }
  }

  func testCorruptContentsAreNeverReportedAsConfidentPeople() {
    // Pure noise / constant fills contain no human; a confident multi-joint
    // pose from them would be a false positive the coordinator would trigger
    // on. We accept throws and low-visibility poses, and record any pose with
    // >= 8 joints above 0.5 visibility as a finding row (not a hard failure —
    // Vision is a black box; the Linux harness aggregates these rows).
    let provider = ApplePoseProvider()
    for seed in StressCampaign.seeds() {
      var rng = SeededRNG(seed: seed)
      let fills: [PixelBufferFactory.Fill] = [.noise(seed: seed), .constant(0), .constant(255), .gradient]
      let fill = fills[rng.int(in: 0...(fills.count - 1))]
      autoreleasepool {
        guard let buffer = PixelBufferFactory.make(width: 720, height: 1_280, format: kCVPixelFormatType_420YpCbCr8BiPlanarFullRange, fill: fill) else {
          XCTFail("seed \(seed): allocation failed")
          return
        }
        do {
          let pose = try provider.extractPose(pixelBuffer: buffer, timestampMs: 0)
          assertWellFormed(pose, "seed \(seed)")
          let confident = pose.landmarks.filter { $0.visibility >= 0.5 }.count
          Self.table.record(
            test: #function, seed: seed,
            outcome: confident >= 8 ? "FALSE_POSITIVE" : "HELD",
            detail: "pose from \(fill) confidence=\(pose.confidence) confidentJoints=\(confident)"
          )
        } catch {
          Self.table.record(test: #function, seed: seed, outcome: "HELD", detail: "throw from \(fill)")
        }
      }
      provider.resetPrimaryPersonAnchor()
    }
  }

  func testMemoryPressureLoopKeepsProviderUsable() {
    // Allocates and discards full-HD camera-format frames in a tight loop;
    // per-iteration wall time is recorded so a leak/regression shows up as a
    // monotonic slowdown in the table (RSS is not asserted — the simulator
    // shares the host).
    let provider = ApplePoseProvider()
    let iterations = StressCampaign.iterations * 10
    var rng = SeededRNG(seed: StressCampaign.baseSeed)
    var firstMs: Double?
    var lastMs = 0.0
    for index in 0..<iterations {
      let seed = rng.next()
      autoreleasepool {
        let started = Date()
        guard let buffer = PixelBufferFactory.make(width: 1_920, height: 1_080, format: kCVPixelFormatType_420YpCbCr8BiPlanarFullRange, fill: .noise(seed: seed)) else {
          XCTFail("iteration \(index): allocation failed")
          return
        }
        _ = exercise(provider, buffer, timestampMs: index * 16, context: "loop \(index)")
        lastMs = Date().timeIntervalSince(started) * 1_000
        if firstMs == nil { firstMs = lastMs }
      }
    }
    // Sanity gradient: last iteration must not be >20× the first.
    if let firstMs, firstMs > 1 {
      XCTAssertLessThan(lastMs, firstMs * 20, "iteration time grew from \(firstMs)ms to \(lastMs)ms")
    }
    guard let buffer = PixelBufferFactory.make(width: 640, height: 480, fill: .gradient) else { return XCTFail("alloc") }
    _ = exercise(provider, buffer, timestampMs: 0, context: "post-loop")
    Self.table.record(test: #function, seed: StressCampaign.baseSeed, outcome: "HELD",
                      detail: "\(iterations) iterations first=\(Int(firstMs ?? 0))ms last=\(Int(lastMs))ms")
  }

  func testConcurrentExtractionAndAnchorResetsDoNotRace() {
    // ApplePoseProvider is `@unchecked Sendable`; the coordinator calls it from
    // visionQueue while the bridge calls setPrimaryPersonSeed/reset from the
    // main thread. Hammer both from several queues at once.
    let provider = ApplePoseProvider()
    let workers = 4
    let perWorker = StressCampaign.iterations * 5
    let group = DispatchGroup()
    let seeds = StressCampaign.seeds(count: workers)
    for (workerIndex, seed) in seeds.enumerated() {
      let queue = DispatchQueue(label: "stress.vision.\(workerIndex)")
      group.enter()
      queue.async {
        defer { group.leave() }
        var rng = SeededRNG(seed: seed)
        for iteration in 0..<perWorker {
          autoreleasepool {
            if workerIndex == 0, rng.bool() {
              provider.setPrimaryPersonSeed(x: rng.double(), y: rng.double())
            } else if workerIndex == 0 {
              provider.resetPrimaryPersonAnchor()
            }
            guard let buffer = PixelBufferFactory.make(width: 320, height: 240, fill: .noise(seed: rng.next())) else { return }
            _ = try? provider.extractPose(pixelBuffer: buffer, timestampMs: iteration)
            _ = try? provider.extractAllPoses(pixelBuffer: buffer, timestampMs: iteration)
          }
        }
      }
    }
    XCTAssertEqual(group.wait(timeout: .now() + 300), .success, "concurrent extraction did not finish in 300s")
    Self.table.record(test: #function, seed: seeds.first, outcome: "HELD",
                      detail: "\(workers) queues × \(perWorker) iterations with concurrent anchor mutation")
  }
}
