import Foundation
import XCTest

/// XCTest surface for the swing-lab adversarial pass.
///
/// The single source of truth for the attacks is `run_mac_attacks.sh`
/// (fixtures, CLI invocations, `check_extract.py` assertions). This suite runs
/// it once, then turns every scenario row in `results.jsonl` into its own
/// XCTest assertion so Xcode / `swift test` report HELD and BROKEN scenarios
/// individually with the checker's detail string as the failure message.
///
/// Requirements: macOS with Xcode toolchain, ffmpeg + ffprobe on PATH
/// (`brew install ffmpeg`), python3. The Release swing-lab binary is built by
/// the driver unless `SWING_LAB_BIN` is set.
final class SwingLabExtractAttackTests: XCTestCase {
  struct Row: Decodable {
    let scenario: String
    let status: String
    let detail: String
    let artifact: String
  }

  static var rows: [Row] = []
  static var driverExit: Int32 = -1
  static var outDir: URL!
  static var driverLog: String = ""

  override class func setUp() {
    super.setUp()
    let here = URL(fileURLWithPath: #filePath)
    // …/attack-tests/SwingLabAttackTests/Tests/SwingLabAttackTests/<file>
    let attackTests = here.deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent().deletingLastPathComponent()
    let driver = attackTests.appendingPathComponent("run_mac_attacks.sh")
    let out = ProcessInfo.processInfo.environment["SWING_LAB_ATTACK_OUT"].map(URL.init(fileURLWithPath:))
      ?? FileManager.default.temporaryDirectory.appendingPathComponent("swing-lab-attacks-\(Int(Date().timeIntervalSince1970))")
    outDir = out
    var args = ["bash", driver.path, "--out", out.path]
    if let bin = ProcessInfo.processInfo.environment["SWING_LAB_BIN"], !bin.isEmpty {
      args += ["--bin", bin]
    }
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    process.arguments = args
    let pipe = Pipe()
    process.standardOutput = pipe
    process.standardError = pipe
    do {
      try process.run()
    } catch {
      driverLog = "could not launch driver: \(error)"
      return
    }
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    driverExit = process.terminationStatus
    driverLog = String(decoding: data, as: UTF8.self)
    let results = out.appendingPathComponent("results.jsonl")
    guard let text = try? String(contentsOf: results, encoding: .utf8) else { return }
    rows = text.split(separator: "\n").compactMap { line in
      try? JSONDecoder().decode(Row.self, from: Data(line.utf8))
    }
  }

  private func row(_ id: String) -> Row? {
    Self.rows.first { $0.scenario == id }
  }

  private func assertHeld(_ id: String, file: StaticString = #filePath, line: UInt = #line) {
    guard let row = row(id) else {
      XCTFail("scenario \(id) was never recorded (driver exit \(Self.driverExit)); log tail:\n\(Self.driverLog.suffix(1500))", file: file, line: line)
      return
    }
    XCTAssertEqual(row.status, "HELD", "\(id) BROKEN — \(row.detail) [artifact: \(row.artifact)]", file: file, line: line)
  }

  func testDriverProducedResults() {
    XCTAssertFalse(Self.rows.isEmpty, "no results.jsonl rows; driver exit \(Self.driverExit); log tail:\n\(Self.driverLog.suffix(3000))")
    XCTAssertNil(row("build"), "swing-lab release build failed: \(row("build")?.detail ?? "")")
    XCTAssertNil(row("fixtures"), "fixture generation failed: \(row("fixtures")?.detail ?? "")")
  }

  // Coordinator scenarios
  func testS1_RotatedPortraitReportsUprightSizeAndUnitLandmarks() { assertHeld("S1-rotated"); assertHeld("S1-control") }
  func testS2_VfrFpsTracksDecodedCadence() { assertHeld("S2-vfr-half-visible"); assertHeld("S2-vfr-alternate-frames") }
  func testS3_PtsRewindKeepsTimestampsStrictlyIncreasing() { assertHeld("S3-pts-rewind-elst"); assertHeld("S3-pts-rewind-ctts") }
  func testS4_HardCutsEvery500msPartitionExactly() { assertHeld("S4-cuts") }
  func testS5_PanningClipStillEmitsStationaryVerbatim() { assertHeld("S5-panning") }
  func testS6_AudioOnlyFailsWithNoVideoTrackExit1() { assertHeld("S6-audio") }
  func testS7_SecondExtractOverwritesAllFiveFiles() { assertHeld("S7-overwrite"); assertHeld("S7-overwrite-unrelated-file-kept") }

  // Extra adversarial coverage
  func testX1_BadInputsExit1WithoutPartialOutput() {
    assertHeld("X1-corrupt-seeded.mp4"); assertHeld("X1-empty.mp4"); assertHeld("X1-does-not-exist.mp4")
  }
  func testX2_OneFrameClipProducesValidOutput() { assertHeld("X2-one-frame") }
  func testX3_HostileOutPaths() { assertHeld("X3-out-is-file"); assertHeld("X3-out-readonly"); assertHeld("X3-unicode-paths") }
  func testX4_ConcurrentRepeatsAreDeterministic() { assertHeld("X4-concurrent-repeats") }
  func testX5_InterleavedSameOutLeavesCoherentSet() { assertHeld("X5-same-out-interleave") }
  func testX6_CancelMidFlightLeavesNoTornJson() { assertHeld("X6-cancel-mid-flight") }

  func testDriverExitCodeMatchesRows() {
    let broken = Self.rows.filter { $0.status == "BROKEN" }
    XCTAssertEqual(Self.driverExit, broken.isEmpty ? 0 : 1,
                   "driver exit \(Self.driverExit) disagrees with \(broken.count) BROKEN rows")
  }
}
