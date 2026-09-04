import CoreGraphics
import Foundation
import XCTest

@testable import PickleVisionCore

#if os(macOS)

/// Runs the REAL `swing-lab extract` binary (native/swing-lab, built here in
/// release mode with SwiftPM) against adversarial inputs and checks the
/// process-level contract: malformed media exits 1 with `swing-lab error:`
/// on stderr and writes no artifacts, valid clips exit 0 and write a
/// pose.json the canonical parser accepts (positive w/h/fps, strictly
/// increasing frame timestamps, finite landmarks), geometry follows the
/// track's preferredTransform, and SIGTERM mid-extraction leaves no partial
/// artifacts. macOS only: swing-lab is a macOS executable package.
///
/// If the swing-lab build cannot run from inside this test host the suite
/// is SKIPPED (recorded in the report) — a skip is not a pass.
final class SwingLabBinaryAdversarialTests: XCTestCase {
  static let report = AdversarialReport(suite: "swing-lab-binary")
  static var scratch: URL = FileManager.default.temporaryDirectory
  static var binary: Result<URL, Error> = .failure(AdversarialFailure("swing-lab not built yet"))

  struct ProcessOutcome {
    let status: Int32
    let reason: Process.TerminationReason
    let stdout: String
    let stderr: String
    let wallMs: Int
    let timedOut: Bool

    var json: [String: Any] {
      [
        "status": Int(status),
        "reason": reason == .exit ? "exit" : "uncaughtSignal",
        "wallMs": wallMs,
        "timedOut": timedOut,
        "stdoutTail": String(stdout.suffix(600)),
        "stderrTail": String(stderr.suffix(600)),
      ]
    }
  }

  override class func setUp() {
    super.setUp()
    if let directory = try? AdversarialSupport.makeScratchDirectory("swing-lab") {
      scratch = directory
    }
    binary = buildSwingLab()
    switch binary {
    case .success(let url):
      report.record("build", ["ok": true, "binary": url.path])
    case .failure(let error):
      report.record("build", ["ok": false, "error": String(describing: error)])
    }
  }

  override class func tearDown() {
    report.flush()
    super.tearDown()
  }

  private func record(_ fields: [String: Any], function: String = #function) {
    Self.report.record(function, fields)
  }

  // MARK: Process plumbing

  /// Minimal environment so `swift build` is not poisoned by the test host's
  /// DYLD_* / SDKROOT variables when running under xcodebuild.
  private static var childEnvironment: [String: String] {
    var environment: [String: String] = [
      "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
      "HOME": NSHomeDirectory(),
      "TMPDIR": FileManager.default.temporaryDirectory.path,
    ]
    if let developerDir = ProcessInfo.processInfo.environment["DEVELOPER_DIR"] {
      environment["DEVELOPER_DIR"] = developerDir
    }
    return environment
  }

  static func runProcess(_ executable: String, _ arguments: [String], timeout: TimeInterval, terminateAfter: TimeInterval? = nil) throws -> ProcessOutcome {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = arguments
    process.environment = childEnvironment
    process.currentDirectoryURL = AdversarialSupport.repoRoot
    let stdoutPipe = Pipe()
    let stderrPipe = Pipe()
    process.standardOutput = stdoutPipe
    process.standardError = stderrPipe

    let started = Date()
    try process.run()
    let stdoutBox = AdversarialDataBox()
    let stderrBox = AdversarialDataBox()
    let group = DispatchGroup()
    group.enter()
    DispatchQueue.global().async {
      stdoutBox.set(stdoutPipe.fileHandleForReading.readDataToEndOfFile())
      group.leave()
    }
    group.enter()
    DispatchQueue.global().async {
      stderrBox.set(stderrPipe.fileHandleForReading.readDataToEndOfFile())
      group.leave()
    }
    if let terminateAfter {
      let deadline = Date().addingTimeInterval(terminateAfter)
      while process.isRunning, Date() < deadline { Thread.sleep(forTimeInterval: 0.02) }
      if process.isRunning { process.terminate() }
    }
    var timedOut = false
    let hardDeadline = started.addingTimeInterval(timeout)
    while process.isRunning, Date() < hardDeadline { Thread.sleep(forTimeInterval: 0.05) }
    if process.isRunning {
      timedOut = true
      kill(process.processIdentifier, SIGKILL)
    }
    process.waitUntilExit()
    _ = group.wait(timeout: .now() + 10)
    return ProcessOutcome(
      status: process.terminationStatus,
      reason: process.terminationReason,
      stdout: String(decoding: stdoutBox.get(), as: UTF8.self),
      stderr: String(decoding: stderrBox.get(), as: UTF8.self),
      wallMs: Int(Date().timeIntervalSince(started) * 1000),
      timedOut: timedOut
    )
  }

  static func buildSwingLab() -> Result<URL, Error> {
    let packagePath = AdversarialSupport.repoFile("native/swing-lab").path
    guard AdversarialSupport.fileExists(URL(fileURLWithPath: packagePath).appendingPathComponent("Package.swift")) else {
      return .failure(AdversarialFailure("native/swing-lab/Package.swift not found under \(AdversarialSupport.repoRoot.path)"))
    }
    do {
      let build = try runProcess("/usr/bin/xcrun", ["swift", "build", "-c", "release", "--package-path", packagePath], timeout: 25 * 60)
      guard build.status == 0, !build.timedOut else {
        return .failure(AdversarialFailure("swift build -c release failed (status \(build.status), timedOut \(build.timedOut)): \(build.stderr.suffix(1500))"))
      }
      let binPath = try runProcess("/usr/bin/xcrun", ["swift", "build", "-c", "release", "--package-path", packagePath, "--show-bin-path"], timeout: 5 * 60)
      guard binPath.status == 0 else {
        return .failure(AdversarialFailure("--show-bin-path failed: \(binPath.stderr.suffix(500))"))
      }
      let directory = binPath.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
      let binary = URL(fileURLWithPath: directory).appendingPathComponent("swing-lab")
      guard AdversarialSupport.fileExists(binary) else {
        return .failure(AdversarialFailure("swing-lab binary missing at \(binary.path)"))
      }
      return .success(binary)
    } catch {
      return .failure(error)
    }
  }

  private func swingLab() throws -> URL {
    switch Self.binary {
    case .success(let url):
      return url
    case .failure(let error):
      throw XCTSkip("swing-lab could not be built from the test host: \(error)")
    }
  }

  private func extract(_ clip: URL, label: String, timeout: TimeInterval = 600, terminateAfter: TimeInterval? = nil) throws -> (outcome: ProcessOutcome, outDir: URL) {
    let binary = try swingLab()
    let outDir = Self.scratch.appendingPathComponent("out-\(label)")
    try? FileManager.default.removeItem(at: outDir)
    let outcome = try Self.runProcess(binary.path, ["extract", clip.path, "--out", outDir.path], timeout: timeout, terminateAfter: terminateAfter)
    return (outcome, outDir)
  }

  private func artifacts(in outDir: URL) -> [String] {
    ((try? FileManager.default.contentsOfDirectory(atPath: outDir.path)) ?? []).sorted()
  }

  private func readJSON(_ url: URL) throws -> [String: Any] {
    let data = try Data(contentsOf: url)
    guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
      throw AdversarialFailure("\(url.lastPathComponent) is not a JSON object")
    }
    return object
  }

  /// The checks the canonical TypeScript parser (packages/swing-domain
  /// serialization.ts, pickle.pose-sequence.v1) applies to pose.json.
  private func auditPoseWire(_ pose: [String: Any]) -> [String: Any] {
    var problems: [String] = []
    if pose["format"] as? String != "pickle.pose-sequence.v1" { problems.append("format=\(String(describing: pose["format"]))") }
    if pose["coordinateSystem"] as? String != "normalized_image_top_left" { problems.append("coordinateSystem=\(String(describing: pose["coordinateSystem"]))") }
    let video = pose["video"] as? [String: Any] ?? [:]
    let width = (video["w"] as? NSNumber)?.doubleValue ?? -1
    let height = (video["h"] as? NSNumber)?.doubleValue ?? -1
    let fps = (video["fps"] as? NSNumber)?.doubleValue ?? -1
    if !(width > 0) { problems.append("video.w=\(width)") }
    if !(height > 0) { problems.append("video.h=\(height)") }
    if !(fps > 0 && fps.isFinite) { problems.append("video.fps=\(fps) (parser: pose_sequence.invalid_video)") }
    let frames = pose["frames"] as? [[String: Any]] ?? []
    var previous = -Double.infinity
    var nonMonotonic = 0
    var landmarkProblems = 0
    var emptyLandmarkFrames = 0
    for frame in frames {
      let t = (frame["t"] as? NSNumber)?.doubleValue ?? .nan
      if !(t > previous) { nonMonotonic += 1 }
      previous = t
      let landmarks = frame["l"] as? [[String: Any]] ?? []
      if landmarks.isEmpty { emptyLandmarkFrames += 1 }
      for landmark in landmarks {
        for key in ["x", "y", "v"] {
          guard let value = (landmark[key] as? NSNumber)?.doubleValue, value.isFinite else { landmarkProblems += 1; continue }
        }
      }
    }
    if nonMonotonic > 0 { problems.append("nonMonotonicFrames=\(nonMonotonic)") }
    if landmarkProblems > 0 { problems.append("nonFiniteLandmarkValues=\(landmarkProblems)") }
    if emptyLandmarkFrames > 0 { problems.append("framesWithoutLandmarks=\(emptyLandmarkFrames)") }
    return ["frames": frames.count, "w": width, "h": height, "fps": fps, "problems": problems]
  }

  private func clip(_ name: String, width: Int = 640, height: Int = 360, frames: Int = 48, fps: Int32 = 24, transform: CGAffineTransform = .identity) throws -> (AdversarialSupport.WrittenClip, AdversarialSupport.ClipSpec) {
    let spec = AdversarialSupport.ClipSpec(width: width, height: height, frames: frames, fps: fps, transform: transform)
    let written = try AdversarialSupport.writeClip(spec, named: name, in: Self.scratch)
    return (written, spec)
  }

  private func committedClip(_ relativePath: String) throws -> URL {
    let url = AdversarialSupport.repoFile(relativePath)
    guard AdversarialSupport.fileExists(url) else { throw XCTSkip("committed clip missing: \(relativePath)") }
    return url
  }

  private func assertRejected(_ outcome: ProcessOutcome, outDir: URL, _ label: String) {
    XCTAssertEqual(outcome.reason, .exit, "\(label): swing-lab must exit, not die from a signal (status \(outcome.status))")
    XCTAssertEqual(outcome.status, 1, "\(label): malformed media must exit 1")
    XCTAssertTrue(outcome.stderr.contains("swing-lab error:"), "\(label): stderr must carry the typed error line; got \(outcome.stderr.suffix(300))")
    XCTAssertFalse(outcome.timedOut, "\(label): must not hang")
    XCTAssertFalse(artifacts(in: outDir).contains("pose.json"), "\(label): no pose.json may be written for rejected media")
    XCTAssertFalse(artifacts(in: outDir).contains("extract-meta.json"), "\(label): no extract-meta.json may be written for rejected media")
  }

  // MARK: Malformed media

  func testEmptyFileExitsOneWithoutArtifacts() throws {
    let url = Self.scratch.appendingPathComponent("empty.mp4")
    let recipe = try AdversarialSupport.emptyFile(to: url)
    let (outcome, outDir) = try extract(url, label: "empty")
    record(["fixture": recipe, "process": outcome.json, "artifacts": artifacts(in: outDir)])
    assertRejected(outcome, outDir: outDir, "empty file")
  }

  func testGarbageBytesExitOneWithoutArtifacts() throws {
    let url = Self.scratch.appendingPathComponent("garbage.mp4")
    let recipe = try AdversarialSupport.garbageFile(bytes: 65536, seed: 7, to: url)
    let (outcome, outDir) = try extract(url, label: "garbage")
    record(["fixture": recipe, "process": outcome.json, "artifacts": artifacts(in: outDir)])
    assertRejected(outcome, outDir: outDir, "garbage bytes")
  }

  func testMissingFileExitsOneWithoutArtifacts() throws {
    let url = Self.scratch.appendingPathComponent("does-not-exist.mp4")
    let (outcome, outDir) = try extract(url, label: "missing")
    record(["process": outcome.json, "artifacts": artifacts(in: outDir)])
    assertRejected(outcome, outDir: outDir, "missing file")
  }

  func testSeededCorruptionAndTruncationNeverCrashAndNeverEmitInvalidWire() throws {
    let (source, spec) = try clip("corrupt-source")
    let corrupt = Self.scratch.appendingPathComponent("corrupt-seed42.mp4")
    let corruptRecipe = try AdversarialSupport.corruptedCopy(of: source.url, seed: 42, fraction: 0.01, protectPrefix: 64, to: corrupt)
    let truncated = Self.scratch.appendingPathComponent("truncated.mp4")
    let truncatedRecipe = try AdversarialSupport.truncatedCopy(of: source.url, keepFraction: 0.6, to: truncated)
    let committed = [AdversarialRealClipTests.Clip.derivedCorruptBytes, AdversarialRealClipTests.Clip.derivedTruncated, AdversarialRealClipTests.Clip.derivedGarbage]
      .map(AdversarialSupport.repoFile)
      .filter(AdversarialSupport.fileExists)
    var cases: [(String, URL, [String: Any])] = [
      ("corrupt-seed42", corrupt, corruptRecipe),
      ("truncated-60pct", truncated, truncatedRecipe),
    ]
    for url in committed {
      cases.append((url.deletingPathExtension().lastPathComponent, url, ["recipe": "committed datasets/ood/derived probe"]))
    }

    for (label, url, recipe) in cases {
      let (outcome, outDir) = try extract(url, label: label, timeout: 300)
      var fields: [String: Any] = ["fixture": recipe, "source": spec.recipe, "codec": source.codec, "process": outcome.json, "artifacts": artifacts(in: outDir)]
      XCTAssertEqual(outcome.reason, .exit, "\(label): swing-lab must not crash (status \(outcome.status), stderr \(outcome.stderr.suffix(300)))")
      XCTAssertFalse(outcome.timedOut, "\(label): must not hang")
      if outcome.status == 0 {
        let pose = try readJSON(outDir.appendingPathComponent("pose.json"))
        let audit = auditPoseWire(pose)
        fields["poseAudit"] = audit
        fields["extractMeta"] = try readJSON(outDir.appendingPathComponent("extract-meta.json"))
        XCTAssertEqual((audit["problems"] as? [String]) ?? ["unreadable"], [], "\(label): pose.json violates the canonical parser contract")
      } else {
        XCTAssertEqual(outcome.status, 1, "\(label): non-zero exit must be the typed error path")
        XCTAssertTrue(outcome.stderr.contains("swing-lab error:"), "\(label): stderr must carry the typed error line")
      }
      record(fields, function: "\(#function)[\(label)]")
    }
  }

  // MARK: Geometry / one frame / no person

  func testOneFrameClipWritesParserAcceptableWire() throws {
    let (source, spec) = try clip("one-frame", frames: 1, fps: 30)
    let (outcome, outDir) = try extract(source.url, label: "one-frame")
    var fields: [String: Any] = ["fixture": spec.recipe, "codec": source.codec, "process": outcome.json, "artifacts": artifacts(in: outDir)]
    XCTAssertEqual(outcome.reason, .exit)
    XCTAssertEqual(outcome.status, 0, "a one-frame clip is valid media; stderr \(outcome.stderr.suffix(300))")
    guard outcome.status == 0 else { record(fields); return }
    let meta = try readJSON(outDir.appendingPathComponent("extract-meta.json"))
    let pose = try readJSON(outDir.appendingPathComponent("pose.json"))
    let audit = auditPoseWire(pose)
    fields["extractMeta"] = meta
    fields["poseAudit"] = audit
    record(fields)
    XCTAssertEqual((meta["framesSeen"] as? NSNumber)?.intValue, 1)
    XCTAssertEqual((meta["framesWithPose"] as? NSNumber)?.intValue, 0, "person-free frame must not produce a pose")
    XCTAssertEqual((audit["problems"] as? [String]) ?? ["unreadable"], [], "pose.json for a one-frame clip must satisfy the canonical parser (video.fps > 0 is required)")
  }

  func testPersonFreeClipWritesEmptyPoseSequenceAndScenes() throws {
    let (source, spec) = try clip("no-person", frames: 48, fps: 24)
    let (outcome, outDir) = try extract(source.url, label: "no-person")
    var fields: [String: Any] = ["fixture": spec.recipe, "codec": source.codec, "process": outcome.json, "artifacts": artifacts(in: outDir)]
    XCTAssertEqual(outcome.reason, .exit)
    XCTAssertEqual(outcome.status, 0, "stderr \(outcome.stderr.suffix(300))")
    guard outcome.status == 0 else { record(fields); return }
    let meta = try readJSON(outDir.appendingPathComponent("extract-meta.json"))
    let pose = try readJSON(outDir.appendingPathComponent("pose.json"))
    let people = try readJSON(outDir.appendingPathComponent("people.json"))
    let scenes = try readJSON(outDir.appendingPathComponent("scenes.json"))
    let audit = auditPoseWire(pose)
    fields["extractMeta"] = meta
    fields["poseAudit"] = audit
    fields["peopleFrames"] = (people["frames"] as? [Any])?.count ?? -1
    fields["sceneCuts"] = (scenes["cuts"] as? [Any])?.count ?? -1
    record(fields)
    XCTAssertEqual((meta["framesSeen"] as? NSNumber)?.intValue, 48)
    XCTAssertEqual((meta["framesWithPose"] as? NSNumber)?.intValue, 0)
    XCTAssertEqual((meta["poseMisses"] as? NSNumber)?.intValue, 48)
    XCTAssertEqual((people["frames"] as? [Any])?.count, 0, "people.json must have no frames when nobody is in the clip")
    XCTAssertEqual((audit["problems"] as? [String]) ?? ["unreadable"], [])
    XCTAssertEqual(Set(artifacts(in: outDir)), ["ball.json", "extract-meta.json", "people.json", "pose.json", "scenes.json"])
  }

  func testLandscapePortraitAndRotatedTracksReportUprightGeometry() throws {
    let portraitTransform = CGAffineTransform(a: 0, b: 1, c: -1, d: 0, tx: 360, ty: 0)
    let cases: [(String, Int, Int, CGAffineTransform, Int, Int)] = [
      ("landscape", 640, 360, .identity, 640, 360),
      ("portrait", 360, 640, .identity, 360, 640),
      ("rotated-portrait", 640, 360, portraitTransform, 360, 640),
    ]
    for (label, width, height, transform, expectedWidth, expectedHeight) in cases {
      let (source, spec) = try clip(label, width: width, height: height, frames: 6, transform: transform)
      let (outcome, outDir) = try extract(source.url, label: label)
      var fields: [String: Any] = ["fixture": spec.recipe, "codec": source.codec, "process": outcome.json]
      XCTAssertEqual(outcome.status, 0, "\(label): stderr \(outcome.stderr.suffix(300))")
      guard outcome.status == 0 else { record(fields, function: "\(#function)[\(label)]"); continue }
      let meta = try readJSON(outDir.appendingPathComponent("extract-meta.json"))
      let video = meta["video"] as? [String: Any] ?? [:]
      fields["extractMeta"] = meta
      record(fields, function: "\(#function)[\(label)]")
      XCTAssertEqual((video["w"] as? NSNumber)?.intValue, expectedWidth, "\(label): extract-meta video.w")
      XCTAssertEqual((video["h"] as? NSNumber)?.intValue, expectedHeight, "\(label): extract-meta video.h")
      XCTAssertEqual((meta["framesSeen"] as? NSNumber)?.intValue, 6, label)
    }
  }

  func testHugeResolutionClipExtractsWithinBudget() throws {
    let (source, spec) = try clip("huge-4096x2304", width: 4096, height: 2304, frames: 12, fps: 24)
    let (outcome, outDir) = try extract(source.url, label: "huge", timeout: 600)
    var fields: [String: Any] = ["fixture": spec.recipe, "codec": source.codec, "bytes": source.bytes, "process": outcome.json]
    XCTAssertEqual(outcome.reason, .exit)
    XCTAssertEqual(outcome.status, 0, "stderr \(outcome.stderr.suffix(300))")
    guard outcome.status == 0 else { record(fields); return }
    let meta = try readJSON(outDir.appendingPathComponent("extract-meta.json"))
    fields["extractMeta"] = meta
    record(fields)
    let video = meta["video"] as? [String: Any] ?? [:]
    XCTAssertEqual((video["w"] as? NSNumber)?.intValue, 4096)
    XCTAssertEqual((video["h"] as? NSNumber)?.intValue, 2304)
    XCTAssertEqual((meta["framesSeen"] as? NSNumber)?.intValue, 12)
    XCTAssertEqual((meta["framesWithPose"] as? NSNumber)?.intValue, 0)
    XCTAssertLessThan(outcome.wallMs, 120_000, "12 frames at 4096x2304 took \(outcome.wallMs) ms")
  }

  // MARK: Two people (committed squash rally)

  func testTwoPlayerRallyProducesMultiPersonPeopleJSONAndValidWire() throws {
    let url = try committedClip(AdversarialRealClipTests.Clip.squashTwoPlayers)
    let (outcome, outDir) = try extract(url, label: "squash", timeout: 900)
    var fields: [String: Any] = ["clip": AdversarialRealClipTests.Clip.squashTwoPlayers, "process": outcome.json]
    XCTAssertEqual(outcome.reason, .exit)
    XCTAssertEqual(outcome.status, 0, "stderr \(outcome.stderr.suffix(300))")
    guard outcome.status == 0 else { record(fields); return }
    let meta = try readJSON(outDir.appendingPathComponent("extract-meta.json"))
    let pose = try readJSON(outDir.appendingPathComponent("pose.json"))
    let people = try readJSON(outDir.appendingPathComponent("people.json"))
    let peopleFrames = people["frames"] as? [[String: Any]] ?? []
    var histogram: [String: Int] = [:]
    var maxPeople = 0
    for frame in peopleFrames {
      let count = (frame["p"] as? [Any])?.count ?? 0
      histogram[String(count), default: 0] += 1
      maxPeople = max(maxPeople, count)
    }
    let audit = auditPoseWire(pose)
    fields["extractMeta"] = meta
    fields["poseAudit"] = audit
    fields["peopleHistogram"] = histogram
    fields["maxPeopleInFrame"] = maxPeople
    record(fields)
    XCTAssertGreaterThanOrEqual(maxPeople, 2, "people.json must show both squash players in at least one frame; histogram \(histogram)")
    XCTAssertGreaterThan((meta["framesWithPose"] as? NSNumber)?.intValue ?? 0, 0)
    XCTAssertEqual((audit["problems"] as? [String]) ?? ["unreadable"], [], "pose.json must satisfy the canonical parser")
  }

  // MARK: Cancellation mid-extraction

  /// SIGTERM 1.5 s into a 30 s extraction: the process must stop promptly
  /// and, because swing-lab writes every artifact only after the loop, the
  /// out dir must hold no partial JSON that a downstream step could mistake
  /// for a complete extraction.
  func testSigtermMidExtractionLeavesNoPartialArtifacts() throws {
    let url = try committedClip(AdversarialRealClipTests.Clip.squashTwoPlayers)
    let (outcome, outDir) = try extract(url, label: "sigterm", timeout: 30, terminateAfter: 1.5)
    let leftovers = artifacts(in: outDir)
    record(["clip": AdversarialRealClipTests.Clip.squashTwoPlayers, "terminateAfterMs": 1500, "process": outcome.json, "artifacts": leftovers])
    XCTAssertFalse(outcome.timedOut, "swing-lab must die within the 30 s budget after SIGTERM")
    XCTAssertEqual(outcome.reason, .uncaughtSignal, "the process should have been terminated by SIGTERM, got status \(outcome.status)")
    XCTAssertLessThan(outcome.wallMs, 15_000, "took \(outcome.wallMs) ms to stop after SIGTERM at 1.5 s")
    XCTAssertFalse(leftovers.contains("pose.json"), "partial pose.json left behind: \(leftovers)")
    XCTAssertFalse(leftovers.contains("extract-meta.json"), "partial extract-meta.json left behind: \(leftovers)")
  }
}

#endif
