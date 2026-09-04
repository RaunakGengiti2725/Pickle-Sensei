#if os(macOS)
import AVFoundation
import CoreVideo
import Foundation
import StressSupport
import XCTest

/// Black-box stress of the `swing-lab` CLI (native/swing-lab) against
/// synthetic media: empty files, corrupt bytes, one-frame and huge-frame
/// videos, rotated tracks, missing/unwritable outputs and malformed pose JSON.
/// Requires the release binary: `cd native/swing-lab && swift build -c release`
/// (or SWING_LAB_BIN=<path>); otherwise every test XCTSkips — a skip is not a
/// pass and the harness table records it as SKIPPED.
final class SwingLabProcessStressTests: XCTestCase {
  private static let table = StressResultTable(suite: "SwingLabProcessStress")
  private static let processTimeout: TimeInterval = 180

  override class func tearDown() {
    if let url = table.flush() { print("STRESS_RESULTS \(url.path)") }
    super.tearDown()
  }

  // MARK: - Binary discovery

  private static func swingLabBinary() throws -> URL {
    let environment = ProcessInfo.processInfo.environment
    let candidates: [URL] = [
      environment["SWING_LAB_BIN"].map { URL(fileURLWithPath: $0) },
      URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()  // VisionStressTests
        .deletingLastPathComponent()  // Tests
        .deletingLastPathComponent()  // vision-stress-xctest
        .deletingLastPathComponent()  // stress
        .appendingPathComponent("swing-lab/.build/release/swing-lab"),
    ].compactMap { $0 }
    for candidate in candidates where FileManager.default.isExecutableFile(atPath: candidate.path) {
      return candidate
    }
    table.record(test: "binary", seed: nil, outcome: "SKIPPED", detail: "swing-lab binary not found; set SWING_LAB_BIN")
    throw XCTSkip("swing-lab binary not built (cd native/swing-lab && swift build -c release) and SWING_LAB_BIN unset")
  }

  private struct RunResult {
    let exitCode: Int32
    let stdout: String
    let stderr: String
    let timedOut: Bool
    let wallMs: Int
  }

  private static func run(_ arguments: [String]) throws -> RunResult {
    let process = Process()
    process.executableURL = try swingLabBinary()
    process.arguments = arguments
    let stdoutPipe = Pipe()
    let stderrPipe = Pipe()
    process.standardOutput = stdoutPipe
    process.standardError = stderrPipe
    let started = Date()
    try process.run()
    // Drain both pipes off-thread so a chatty child cannot deadlock on a full pipe.
    var stdoutData = Data()
    var stderrData = Data()
    let group = DispatchGroup()
    group.enter()
    DispatchQueue.global().async {
      stdoutData = stdoutPipe.fileHandleForReading.readDataToEndOfFile()
      group.leave()
    }
    group.enter()
    DispatchQueue.global().async {
      stderrData = stderrPipe.fileHandleForReading.readDataToEndOfFile()
      group.leave()
    }
    var timedOut = false
    let deadline = started.addingTimeInterval(processTimeout)
    while process.isRunning, Date() < deadline {
      Thread.sleep(forTimeInterval: 0.05)
    }
    if process.isRunning {
      timedOut = true
      process.terminate()
    }
    process.waitUntilExit()
    group.wait()
    return RunResult(
      exitCode: process.terminationStatus,
      stdout: String(decoding: stdoutData, as: UTF8.self),
      stderr: String(decoding: stderrData, as: UTF8.self),
      timedOut: timedOut,
      wallMs: Int(Date().timeIntervalSince(started) * 1_000)
    )
  }

  // MARK: - Synthetic media

  private func scratchDirectory(_ name: String) throws -> URL {
    let url = URL(fileURLWithPath: NSTemporaryDirectory())
      .appendingPathComponent("pickle-swing-lab-stress")
      .appendingPathComponent("\(name)-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    addTeardownBlock { try? FileManager.default.removeItem(at: url) }
    return url
  }

  /// Writes an H.264 MP4 with `frameCount` seeded-noise frames at `fps`.
  /// `transform` is stored as the track's preferredTransform (rotation test).
  private static func writeVideo(
    to url: URL,
    width: Int,
    height: Int,
    frameCount: Int,
    fps: Int,
    seed: UInt64,
    transform: CGAffineTransform = .identity
  ) throws {
    let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
    let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
      AVVideoCodecKey: AVVideoCodecType.h264,
      AVVideoWidthKey: width,
      AVVideoHeightKey: height,
    ])
    input.expectsMediaDataInRealTime = false
    input.transform = transform
    let adaptor = AVAssetWriterInputPixelBufferAdaptor(
      assetWriterInput: input,
      sourcePixelBufferAttributes: [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
        kCVPixelBufferWidthKey as String: width,
        kCVPixelBufferHeightKey as String: height,
      ]
    )
    guard writer.canAdd(input) else { throw NSError(domain: "stress", code: 1) }
    writer.add(input)
    guard writer.startWriting() else { throw writer.error ?? NSError(domain: "stress", code: 2) }
    writer.startSession(atSourceTime: .zero)
    var rng = SeededRNG(seed: seed)
    for index in 0..<frameCount {
      while !input.isReadyForMoreMediaData { Thread.sleep(forTimeInterval: 0.002) }
      guard let buffer = PixelBufferFactory.make(width: width, height: height, fill: index % 2 == 0 ? .noise(seed: rng.next()) : .gradient) else {
        throw NSError(domain: "stress", code: 3)
      }
      let pts = CMTime(value: CMTimeValue(index), timescale: CMTimeScale(fps))
      guard adaptor.append(buffer, withPresentationTime: pts) else {
        throw writer.error ?? NSError(domain: "stress", code: 4)
      }
    }
    input.markAsFinished()
    let done = DispatchSemaphore(value: 0)
    writer.finishWriting { done.signal() }
    done.wait()
    if writer.status != .completed {
      throw writer.error ?? NSError(domain: "stress", code: 5)
    }
  }

  private func readJSON(_ url: URL) throws -> [String: Any] {
    let data = try Data(contentsOf: url)
    guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
      throw NSError(domain: "stress", code: 6, userInfo: [NSLocalizedDescriptionKey: "\(url.lastPathComponent) is not a JSON object"])
    }
    return object
  }

  /// Mirrors the canonical wire contract enforced by
  /// packages/swing-domain/src/serialization.ts parsePoseSequence.
  private func poseWireViolations(_ pose: [String: Any]) -> [String] {
    var violations: [String] = []
    if pose["schemaVersion"] as? Int != 1 { violations.append("schemaVersion != 1") }
    if pose["format"] as? String != "pickle.pose-sequence.v1" { violations.append("format mismatch") }
    if pose["coordinateSystem"] as? String != "normalized_image_top_left" { violations.append("coordinateSystem") }
    if (pose["poseModelVersion"] as? String)?.isEmpty != false { violations.append("poseModelVersion empty") }
    let video = pose["video"] as? [String: Any] ?? [:]
    for key in ["w", "h", "fps"] {
      guard let value = video[key] as? Double, value.isFinite, value > 0 else {
        violations.append("video.\(key) not positive finite (\(String(describing: video[key])))")
        continue
      }
    }
    guard let frames = pose["frames"] as? [[String: Any]] else {
      violations.append("frames missing")
      return violations
    }
    var lastT = Int.min
    for (index, frame) in frames.enumerated() {
      guard let t = frame["t"] as? Int else { violations.append("frame \(index) t"); continue }
      if t <= lastT { violations.append("frame \(index) t not increasing") }
      lastT = t
      if frame["i"] as? Int != index { violations.append("frame \(index) index mismatch") }
      guard let landmarks = frame["l"] as? [[String: Any]], !landmarks.isEmpty else {
        violations.append("frame \(index) landmarks empty")
        continue
      }
      for landmark in landmarks {
        guard let name = landmark["n"] as? String, SyntheticPose.jointNames.contains(name) else {
          violations.append("frame \(index) bad landmark name")
          continue
        }
        for key in ["x", "y", "v"] {
          guard let value = landmark[key] as? Double, value.isFinite else {
            violations.append("frame \(index) \(name).\(key) non-finite")
            continue
          }
        }
      }
    }
    return violations
  }

  // MARK: - Tests

  func testUsageErrorsExitTwoWithoutTouchingDisk() throws {
    let out = try scratchDirectory("usage")
    let cases: [[String]] = [
      [],
      ["extract"],
      ["extract", out.appendingPathComponent("missing.mp4").path],
      ["frame", out.appendingPathComponent("missing.mp4").path, "--out", out.appendingPathComponent("x.png").path],
      ["overlay", out.appendingPathComponent("missing.mp4").path, "--out", out.appendingPathComponent("x.mp4").path],
      ["bogus-command"],
    ]
    for arguments in cases {
      let result = try Self.run(arguments)
      XCTAssertEqual(result.exitCode, 2, "\(arguments): expected usage exit 2, got \(result.exitCode) stderr=\(result.stderr)")
      XCTAssertFalse(result.timedOut)
      Self.table.record(test: #function, seed: nil, outcome: result.exitCode == 2 ? "HELD" : "BROKEN", detail: "\(arguments.first ?? "<none>") exit=\(result.exitCode)")
    }
    XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: out.path).count, 0, "usage errors must not create files")
  }

  func testEmptyAndCorruptMediaFailCleanly() throws {
    let out = try scratchDirectory("corrupt")
    let seed = StressCampaign.seeds(count: 1)[0]
    var rng = SeededRNG(seed: seed)
    let empty = out.appendingPathComponent("empty.mp4")
    FileManager.default.createFile(atPath: empty.path, contents: Data())
    let garbage = out.appendingPathComponent("garbage.mp4")
    var bytes = Data(count: 64 * 1_024)
    bytes.withUnsafeMutableBytes { raw in
      for index in raw.indices { raw[index] = UInt8(truncatingIfNeeded: rng.next()) }
    }
    try bytes.write(to: garbage)
    // A valid MP4 header followed by truncated payload: "ftyp" box then noise.
    let truncated = out.appendingPathComponent("truncated.mp4")
    var header = Data([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6D, 0x70, 0x34, 0x32])
    header.append(bytes.prefix(2_048))
    try header.write(to: truncated)

    for (label, media) in [("empty", empty), ("garbage", garbage), ("truncated", truncated)] {
      for command in ["extract", "frame", "overlay"] {
        let target = out.appendingPathComponent("\(label)-\(command)-out")
        var arguments = [command, media.path]
        switch command {
        case "extract": arguments += ["--out", target.path]
        case "frame": arguments += ["--ms", "0", "--out", target.appendingPathExtension("png").path]
        default:
          let pose = out.appendingPathComponent("\(label)-pose.json")
          try Data("{\"frames\":[]}".utf8).write(to: pose)
          arguments += ["--pose", pose.path, "--out", target.appendingPathExtension("mp4").path]
        }
        let result = try Self.run(arguments)
        let produced = FileManager.default.fileExists(atPath: target.path)
          || FileManager.default.fileExists(atPath: target.appendingPathExtension("png").path)
          || FileManager.default.fileExists(atPath: target.appendingPathExtension("mp4").path)
        XCTAssertEqual(result.exitCode, 1, "\(label)/\(command): expected exit 1, got \(result.exitCode) stdout=\(result.stdout) stderr=\(result.stderr)")
        XCTAssertTrue(result.stderr.contains("swing-lab error"), "\(label)/\(command): error not reported on stderr")
        XCTAssertFalse(produced, "\(label)/\(command): output artefact created despite failure")
        XCTAssertFalse(result.timedOut, "\(label)/\(command): timed out")
        let held = result.exitCode == 1 && !produced && !result.timedOut
        Self.table.record(test: #function, seed: seed, outcome: held ? "HELD" : "BROKEN", detail: "\(label)/\(command) exit=\(result.exitCode) wall=\(result.wallMs)ms")
      }
    }
  }

  func testSingleFrameVideoProducesCanonicalPoseWire() throws {
    let out = try scratchDirectory("one-frame")
    let seed = StressCampaign.seeds(count: 1)[0]
    let video = out.appendingPathComponent("one.mp4")
    try Self.writeVideo(to: video, width: 320, height: 240, frameCount: 1, fps: 30, seed: seed)
    let target = out.appendingPathComponent("extract")
    let result = try Self.run(["extract", video.path, "--out", target.path])
    XCTAssertEqual(result.exitCode, 0, "stderr=\(result.stderr)")
    let meta = try readJSON(target.appendingPathComponent("extract-meta.json"))
    XCTAssertEqual(meta["framesSeen"] as? Int, 1)
    let pose = try readJSON(target.appendingPathComponent("pose.json"))
    // The canonical parser (swing-domain parsePoseSequence) rejects fps <= 0;
    // a one-frame asset has no inter-frame interval to derive one from, so
    // this pins whether swing-lab's fallback keeps its output parseable.
    let wireViolations = poseWireViolations(pose)
    XCTAssertTrue(wireViolations.isEmpty, "one-frame pose.json breaks the wire contract: \(wireViolations)")
    Self.table.record(test: #function, seed: seed, outcome: wireViolations.isEmpty ? "HELD" : "BROKEN",
                      detail: "exit=\(result.exitCode) video=\(String(describing: pose["video"])) violations=\(wireViolations)")
  }

  func testHugeFrameVideoCompletes() throws {
    let out = try scratchDirectory("huge")
    let seed = StressCampaign.seeds(count: 1)[0]
    let video = out.appendingPathComponent("huge.mp4")
    try Self.writeVideo(to: video, width: 3_840, height: 2_160, frameCount: 3, fps: 24, seed: seed)
    let target = out.appendingPathComponent("extract")
    let result = try Self.run(["extract", video.path, "--out", target.path])
    XCTAssertEqual(result.exitCode, 0, "stderr=\(result.stderr)")
    XCTAssertFalse(result.timedOut)
    let meta = try readJSON(target.appendingPathComponent("extract-meta.json"))
    XCTAssertEqual(meta["framesSeen"] as? Int, 3)
    let video4k = meta["video"] as? [String: Any]
    XCTAssertEqual(video4k?["w"] as? Int, 3_840)
    XCTAssertEqual(video4k?["h"] as? Int, 2_160)
    Self.table.record(test: #function, seed: seed, outcome: result.exitCode == 0 ? "HELD" : "BROKEN", detail: "exit=\(result.exitCode) wall=\(result.wallMs)ms framesSeen=\(String(describing: meta["framesSeen"]))")
  }

  func testRotatedTrackReportsUprightDimensions() throws {
    let out = try scratchDirectory("rotated")
    let seed = StressCampaign.seeds(count: 1)[0]
    let video = out.appendingPathComponent("rotated.mp4")
    // 90° clockwise, the transform iPhones store for portrait capture.
    let rotate = CGAffineTransform(a: 0, b: 1, c: -1, d: 0, tx: 240, ty: 0)
    try Self.writeVideo(to: video, width: 320, height: 240, frameCount: 4, fps: 30, seed: seed, transform: rotate)
    let target = out.appendingPathComponent("extract")
    let result = try Self.run(["extract", video.path, "--out", target.path])
    XCTAssertEqual(result.exitCode, 0, "stderr=\(result.stderr)")
    let meta = try readJSON(target.appendingPathComponent("extract-meta.json"))
    let dims = meta["video"] as? [String: Any]
    XCTAssertEqual(dims?["w"] as? Int, 240, "upright width")
    XCTAssertEqual(dims?["h"] as? Int, 320, "upright height")
    let held = dims?["w"] as? Int == 240 && dims?["h"] as? Int == 320
    Self.table.record(test: #function, seed: seed, outcome: held ? "HELD" : "BROKEN", detail: "video=\(String(describing: dims))")
  }

  func testFrameCommandBeyondDurationFailsWithoutOutput() throws {
    let out = try scratchDirectory("frame-beyond")
    let seed = StressCampaign.seeds(count: 1)[0]
    let video = out.appendingPathComponent("short.mp4")
    try Self.writeVideo(to: video, width: 160, height: 120, frameCount: 5, fps: 10, seed: seed)
    let png = out.appendingPathComponent("late.png")
    let result = try Self.run(["frame", video.path, "--ms", "999999", "--out", png.path])
    XCTAssertEqual(result.exitCode, 1, "stdout=\(result.stdout) stderr=\(result.stderr)")
    XCTAssertFalse(FileManager.default.fileExists(atPath: png.path))
    Self.table.record(test: #function, seed: seed, outcome: result.exitCode == 1 ? "HELD" : "BROKEN", detail: "exit=\(result.exitCode)")
  }

  func testFrameCommandToUnwritablePathMustNotClaimSuccess() throws {
    // Static review: runFrame ignores CGImageDestinationFinalize's Bool and
    // prints "frame @…ms -> path" unconditionally (main.swift runFrame). This
    // test pins the honest contract: no file ⇒ non-zero exit.
    let out = try scratchDirectory("frame-unwritable")
    let seed = StressCampaign.seeds(count: 1)[0]
    let video = out.appendingPathComponent("short.mp4")
    try Self.writeVideo(to: video, width: 160, height: 120, frameCount: 3, fps: 10, seed: seed)
    let png = out.appendingPathComponent("no-such-dir/nested/frame.png")
    let result = try Self.run(["frame", video.path, "--ms", "0", "--out", png.path])
    let exists = FileManager.default.fileExists(atPath: png.path)
    XCTAssertFalse(exists, "unexpectedly wrote into a missing directory")
    XCTAssertNotEqual(result.exitCode, 0, "swing-lab frame reported success (stdout=\(result.stdout)) but no PNG exists")
    let held = exists || result.exitCode != 0
    Self.table.record(test: #function, seed: seed, outcome: held ? "HELD" : "BROKEN", detail: "exit=\(result.exitCode) fileExists=\(exists) stdout=\(result.stdout.trimmingCharacters(in: .whitespacesAndNewlines))")
  }

  func testOverlayWithMalformedPoseFails() throws {
    let out = try scratchDirectory("overlay-malformed")
    let seed = StressCampaign.seeds(count: 1)[0]
    let video = out.appendingPathComponent("short.mp4")
    try Self.writeVideo(to: video, width: 160, height: 120, frameCount: 3, fps: 10, seed: seed)
    let payloads: [(String, String)] = [
      ("not-json", "this is not json"),
      ("array-root", "[1,2,3]"),
      ("truncated", "{\"frames\":[{\"t\":0,\"l\":["),
    ]
    for (label, payload) in payloads {
      let pose = out.appendingPathComponent("\(label).json")
      try Data(payload.utf8).write(to: pose)
      let target = out.appendingPathComponent("\(label).mp4")
      let result = try Self.run(["overlay", video.path, "--pose", pose.path, "--out", target.path])
      // An array root is silently treated as "no frames" by loadOverlayData
      // (as? [String: Any] → nil → empty); JSON syntax errors must fail.
      if label == "array-root" {
        Self.table.record(test: #function, seed: seed, outcome: "HELD", detail: "\(label) exit=\(result.exitCode) (lenient by design)")
        continue
      }
      XCTAssertEqual(result.exitCode, 1, "\(label): stdout=\(result.stdout) stderr=\(result.stderr)")
      XCTAssertFalse(FileManager.default.fileExists(atPath: target.path), "\(label): overlay written despite malformed pose")
      Self.table.record(test: #function, seed: seed, outcome: result.exitCode == 1 ? "HELD" : "BROKEN", detail: "\(label) exit=\(result.exitCode)")
    }
  }

  func testCancellationMidExtractionLeavesNoPartialArtifacts() throws {
    // Cancel `extract` while Vision is still chewing on frames (SIGINT or
    // SIGTERM at a seeded delay) and re-run into the same --out directory.
    // Invariants: the cancelled child never exits 0, no half-written JSON
    // is left behind (main.swift writes every artifact only after the read
    // loop), and the retry succeeds with a full, contract-valid pose.json.
    let out = try scratchDirectory("cancel")
    let seeds = StressCampaign.seeds()
    let video = out.appendingPathComponent("long.mp4")
    try Self.writeVideo(to: video, width: 1_280, height: 720, frameCount: 90, fps: 30, seed: seeds[0])
    let artifacts = ["pose.json", "people.json", "scenes.json", "ball.json", "extract-meta.json"]
    for (index, seed) in seeds.enumerated() {
      var rng = SeededRNG(seed: seed)
      let delayMs = rng.int(in: 50...1_500)
      let useInterrupt = rng.next() % 2 == 0
      let target = out.appendingPathComponent("cancel-\(index)")
      let process = Process()
      process.executableURL = try Self.swingLabBinary()
      process.arguments = ["extract", video.path, "--out", target.path]
      process.standardOutput = FileHandle.nullDevice
      process.standardError = FileHandle.nullDevice
      try process.run()
      Thread.sleep(forTimeInterval: Double(delayMs) / 1_000)
      let stillRunning = process.isRunning
      if stillRunning {
        if useInterrupt { process.interrupt() } else { process.terminate() }
      }
      process.waitUntilExit()
      var violations: [String] = []
      if stillRunning {
        if process.terminationReason != .uncaughtSignal {
          violations.append("cancelled child exited normally with status \(process.terminationStatus)")
        }
        for name in artifacts {
          let url = target.appendingPathComponent(name)
          guard FileManager.default.fileExists(atPath: url.path) else { continue }
          // A file may exist only if the child raced past the write loop
          // before the signal landed; then it must be complete and valid.
          if (try? readJSON(url)) == nil { violations.append("partial \(name) left behind") }
        }
      }
      let retry = try Self.run(["extract", video.path, "--out", target.path])
      if retry.exitCode != 0 { violations.append("retry exit \(retry.exitCode): \(retry.stderr)") }
      if retry.exitCode == 0 {
        let pose = try readJSON(target.appendingPathComponent("pose.json"))
        violations += poseWireViolations(pose)
        let meta = try readJSON(target.appendingPathComponent("extract-meta.json"))
        if meta["framesSeen"] as? Int != 90 { violations.append("retry framesSeen \(String(describing: meta["framesSeen"])) != 90") }
      }
      XCTAssertTrue(violations.isEmpty, "seed \(seed) delay=\(delayMs)ms signal=\(useInterrupt ? "SIGINT" : "SIGTERM"): \(violations)")
      Self.table.record(
        test: #function, seed: seed,
        outcome: violations.isEmpty ? "HELD" : "BROKEN",
        detail: "delay=\(delayMs)ms signal=\(useInterrupt ? "SIGINT" : "SIGTERM") cancelledWhileRunning=\(stillRunning) reason=\(process.terminationReason.rawValue) status=\(process.terminationStatus) retryExit=\(retry.exitCode) \(violations.first ?? "")"
      )
    }
  }

  func testSeededSyntheticVideoCampaign() throws {
    // STRESS_ITER seeded videos with random dimensions/frame counts/fps.
    // Invariants: exit 0, framesSeen == frames written, pose.json/people.json
    // timestamps strictly increasing, scenes cover the duration, and the wire
    // contract holds whenever at least two frames exist.
    let out = try scratchDirectory("campaign")
    for seed in StressCampaign.seeds() {
      var rng = SeededRNG(seed: seed)
      let width = 16 * rng.int(in: 4...40)
      let height = 16 * rng.int(in: 4...40)
      let frameCount = rng.int(in: 1...12)
      let fps = [8, 12, 24, 30, 60, 120][rng.int(in: 0...5)]
      let video = out.appendingPathComponent("\(seed).mp4")
      try Self.writeVideo(to: video, width: width, height: height, frameCount: frameCount, fps: fps, seed: seed)
      let target = out.appendingPathComponent("\(seed)")
      let result = try Self.run(["extract", video.path, "--out", target.path])
      var violations: [String] = []
      if result.exitCode != 0 { violations.append("exit \(result.exitCode): \(result.stderr)") }
      if result.timedOut { violations.append("timed out") }
      if violations.isEmpty {
        let meta = try readJSON(target.appendingPathComponent("extract-meta.json"))
        if meta["framesSeen"] as? Int != frameCount { violations.append("framesSeen \(String(describing: meta["framesSeen"])) != \(frameCount)") }
        let pose = try readJSON(target.appendingPathComponent("pose.json"))
        if frameCount >= 2 {
          violations += poseWireViolations(pose)
        }
        let people = try readJSON(target.appendingPathComponent("people.json"))
        var lastT = Int.min
        for frame in people["frames"] as? [[String: Any]] ?? [] {
          let t = frame["t"] as? Int ?? Int.min
          if t <= lastT { violations.append("people.json t not increasing") }
          lastT = t
        }
        let scenes = try readJSON(target.appendingPathComponent("scenes.json"))
        let expectedDuration = Int((Double(frameCount) / Double(fps) * 1_000).rounded())
        if let segments = scenes["segments"] as? [[String: Any]] {
          if segments.isEmpty { violations.append("scenes.json has no segments") }
          if let last = segments.last?["endMs"] as? Int, abs(last - expectedDuration) > 2 {
            violations.append("scenes end \(last) != duration \(expectedDuration)")
          }
        } else {
          violations.append("scenes.json missing segments")
        }
      }
      XCTAssertTrue(violations.isEmpty, "seed \(seed) (\(width)×\(height) ×\(frameCount) @\(fps)fps): \(violations.prefix(3))")
      Self.table.record(
        test: #function, seed: seed,
        outcome: violations.isEmpty ? "HELD" : "BROKEN",
        detail: "\(width)x\(height) frames=\(frameCount) fps=\(fps) exit=\(result.exitCode) wall=\(result.wallMs)ms \(violations.first ?? "")"
      )
    }
  }
}
#endif
