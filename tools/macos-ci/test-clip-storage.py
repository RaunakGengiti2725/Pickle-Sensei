#!/usr/bin/env python3
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "apps/mobile/ios/LocalPods/PickleNative/Sources/ClipMediaStore.swift"

HARNESS = r'''
import AVFoundation
import CryptoKit
import Darwin
import Foundation

struct TestFailure: Error, CustomStringConvertible {
  let description: String
}

func require(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
  if try !condition() { throw TestFailure(description: message) }
}

func refuses(_ body: () throws -> Void) throws {
  do { try body() } catch { return }
  throw TestFailure(description: "Unsafe file was accepted")
}

func rejects(_ code: String, _ body: () throws -> Void) throws {
  do { try body() } catch {
    try require((error as? ImportMediaFailure)?.code == code, "Expected \(code), received \(error)")
    return
  }
  throw TestFailure(description: "Expected \(code), operation succeeded")
}

setbuf(stdout, nil)
let home = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
let temp = URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true)
let manager = FileManager.default
try require(NSHomeDirectory() == home.path, "Refusing to test outside the disposable home")
let support = try manager.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: false)
try require(support.path.hasPrefix(home.path + "/"), "Application Support escaped the disposable home")
try require(temp.deletingLastPathComponent().resolvingSymlinksInPath().path == manager.temporaryDirectory.resolvingSymlinksInPath().path,
            "Fixture temp directory must be a direct child of the Foundation process temp directory")
var failures = 0
var total = 0

@_silgen_name("sandbox_init")
func restrictSandbox(_ profile: UnsafePointer<CChar>, _ flags: UInt64, _ error: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>) -> Int32

let profile = "(version 1) (allow default) (deny file-read-data (literal \"/\"))"
var sandboxError: UnsafeMutablePointer<CChar>?
let sandboxResult = profile.withCString { restrictSandbox($0, 0, &sandboxError) }
try require(sandboxResult == 0, "Could not enable the root-denying test sandbox")

func test(_ name: String, _ body: () throws -> Void) {
  total += 1
  do {
    try body()
    print("PASS \(name)")
  } catch {
    failures += 1
    print("FAIL \(name): \(error)")
  }
}

func fixture(_ name: String) -> URL { temp.appendingPathComponent(name) }

func captureFiles() throws -> [String] {
  let root = support.appendingPathComponent("PickleSensei/Captures", isDirectory: true)
  guard manager.fileExists(atPath: root.path) else { return [] }
  return try manager.contentsOfDirectory(atPath: root.path).sorted()
}

test("sandbox denies reading filesystem root") {
  let fd = Darwin.open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)
  if fd >= 0 { Darwin.close(fd) }
  try require(fd < 0, "Sandbox restriction was not exercised")
}

test("home and process temp children open without ancestor directory access") {
  for root in [home, temp] {
    let parent = root.appendingPathComponent("guarded/nested", isDirectory: true)
    try manager.createDirectory(at: parent, withIntermediateDirectories: true)
    let url = parent.appendingPathComponent("clip.mov")
    try Data("private-movie".utf8).write(to: url, options: .withoutOverwriting)
    let input = try GuardedClipFile(url: url)
    try require(try input.handle.readToEnd() == Data("private-movie".utf8), "Private bytes differ")
    try input.verifyUnchanged(input.snapshot())
  }
}

test("system var and private-var aliases select the same trusted temp root") {
  let url = temp.appendingPathComponent("guarded/nested/clip.mov")
  let path = url.path
  let alias: String
  if path.hasPrefix("/private/var/") { alias = String(path.dropFirst(8)) }
  else if path.hasPrefix("/var/") { alias = "/private" + path }
  else { throw TestFailure(description: "Fixture must exercise the system var alias") }
  let original = try GuardedClipFile(url: url).snapshot()
  try require(try GuardedClipFile(url: URL(fileURLWithPath: alias)).snapshot().isSameFile(as: original), "Alias changed file identity")
}

test("observation slot is creatable and cleanup retains inode ownership") {
  let url = try ClipMediaStore.makeObservationURL()
  try require(!manager.fileExists(atPath: url.path), "Camera requires an absent output slot")
  try Data("recording".utf8).write(to: url, options: .withoutOverwriting)
  let snapshot = try ClipFileSnapshot.at(url)
  ClipMediaStore.removeOwnedObservation(url, expected: snapshot)
  try require(!manager.fileExists(atPath: url.path), "Owned recording was not cleaned up")
}

test("symlinked intermediate and leaf, hard link and FIFO stay rejected") {
  let target = fixture("guarded/nested/clip.mov")
  let alias = fixture("guarded-alias")
  try manager.createSymbolicLink(at: alias, withDestinationURL: fixture("guarded"))
  try refuses { _ = try GuardedClipFile(url: alias.appendingPathComponent("nested/clip.mov")) }
  let leaf = fixture("leaf.mov")
  try manager.createSymbolicLink(at: leaf, withDestinationURL: target)
  try refuses { _ = try GuardedClipFile(url: leaf) }
  let hardlink = fixture("hardlink.mov")
  try manager.linkItem(at: target, to: hardlink)
  try refuses { _ = try GuardedClipFile(url: target) }
  try manager.removeItem(at: hardlink)
  let fifo = fixture("fifo.mov")
  try require(Darwin.mkfifo(fifo.path, 0o600) == 0, "Could not create FIFO fixture")
  try refuses { _ = try GuardedClipFile(url: fifo) }
  try require(try Data(contentsOf: target) == Data("private-movie".utf8), "Guard changed source bytes")
}

test("outside-root paths and sibling-prefix lookalikes stay rejected") {
  let sibling = URL(fileURLWithPath: home.path + "-sibling", isDirectory: true)
  try manager.createDirectory(at: sibling, withIntermediateDirectories: false)
  let url = sibling.appendingPathComponent("clip.mov")
  try Data("outside".utf8).write(to: url)
  try refuses { _ = try GuardedClipFile(url: url) }
  try refuses { _ = try GuardedClipFile(url: URL(fileURLWithPath: "/etc/hosts")) }
}

test("path replacement remains detectable and replacement is never removed") {
  let url = fixture("replacement.mov")
  try Data("original".utf8).write(to: url)
  let input = try GuardedClipFile(url: url)
  let snapshot = try input.snapshot()
  try manager.moveItem(at: url, to: fixture("original.mov"))
  try Data("replaced".utf8).write(to: url)
  try refuses { try input.verifyUnchanged(snapshot) }
  GuardedClipFile.removeOwned(url, identity: snapshot)
  try require(try Data(contentsOf: url) == Data("replaced".utf8), "Cleanup deleted a replacement")
}

test("provider copy survives callback expiry and keeps a sealed private identity") {
  let alias = fixture("provider-alias")
  try manager.createSymbolicLink(at: alias, withDestinationURL: fixture("provider"))
  let source = alias.appendingPathComponent("movie.mp4")
  let operation = ClipMediaOperation()
  defer { operation.cleanupOwnedOutputs() }
  let before = try captureFiles()
  let metadata = try ClipMediaStore.preflightImport(from: source, operation: operation, copying: true)
  try require(metadata.asset.url != source, "Metadata inspected the provider URL before a private copy")
  try require(ClipMediaStore.isPrivateCaptureURL(metadata.asset.url), "Metadata is not private")
  let destination = try ClipMediaStore.persistImportedVideo(from: source, metadata: metadata, operation: operation)
  try manager.removeItem(at: fixture("provider/movie.mp4"))
  let copied = try ClipMediaStore.preflightImport(from: destination, operation: operation)
  try require(copied.width == 64 && copied.height == 64 && copied.durationSeconds > 0, "Private movie metadata is wrong")
  let identity = try operation.videoIdentityPayload(for: destination)
  let digest = SHA256.hash(data: try Data(contentsOf: destination)).map { String(format: "%02x", $0) }.joined()
  try require(identity?["sha256"] as? String == digest, "Receipt does not hash private bytes")
  try require(identity?["origin"] as? String == "import_copy", "Wrong receipt origin")
  try operation.commitOwnedOutputs()
  operation.cleanupOwnedOutputs()
  try require(manager.fileExists(atPath: destination.path), "Committed clip was removed")
  GuardedClipFile.removeOwned(destination, identity: try ClipFileSnapshot.at(destination))
  try require(try captureFiles() == before, "Provider import leaked a staging artifact")
}

for (filename, code) in [
  ("too-long.mp4", "camera.import_too_long"),
  ("not-a-movie.txt", "camera.import_not_movie"),
  ("audio-only.mov", "camera.import_no_video_track"),
  ("missing.mp4", "camera.import_file_unavailable"),
] {
  test("honest failure and rollback: \(code)") {
    let operation = ClipMediaOperation()
    defer { operation.cleanupOwnedOutputs() }
    let before = try captureFiles()
    try rejects(code) {
      _ = try ClipMediaStore.preflightImport(from: fixture(filename), operation: operation, copying: true)
    }
    operation.cleanupOwnedOutputs()
    try require(try captureFiles() == before, "Failed import leaked owned files")
  }
}

test("deferred metadata and sealing use only the private copy after the provider callback expires") {
  let source = fixture("ephemeral-provider.mp4")
  try manager.copyItem(at: fixture("retry.mp4"), to: source)
  let operation = ClipMediaOperation()
  defer { operation.endWork(); operation.cleanupOwnedOutputs() }
  let before = try captureFiles()
  try require(operation.startWork(), "Provider worker did not start")
  let destination = try ClipMediaStore.copyProviderVideo(from: source, operation: operation)
  try manager.removeItem(at: source)
  let metadata = try ClipMediaStore.preflightImport(from: destination, operation: operation)
  let sealed = try ClipMediaStore.persistImportedVideo(from: source, metadata: metadata, operation: operation)
  try require(sealed == destination, "Deferred validation recopied the provider source")
  try require(try operation.videoIdentityPayload(for: sealed) != nil, "Deferred copy has no byte identity")
  operation.endWork()
  operation.cleanupOwnedOutputs()
  try require(try captureFiles() == before, "Deferred copy leaked an owned artifact")
}

test("cancellation before copy creates no private output") {
  let operation = ClipMediaOperation()
  operation.cancel()
  let before = try captureFiles()
  try rejects("camera.cancelled") {
    _ = try ClipMediaStore.preflightImport(from: fixture("too-long.mp4"), operation: operation, copying: true)
  }
  operation.cleanupOwnedOutputs()
  try require(try captureFiles() == before, "Canceled import wrote private files")
}

test("cancellation retains the busy barrier and cleans the private copy after drain") {
  let operation = ClipMediaOperation()
  defer { operation.endWork(); operation.cleanupOwnedOutputs() }
  let before = try captureFiles()
  try require(operation.startWork(), "Worker did not start")
  let metadata = try ClipMediaStore.preflightImport(from: fixture("retry.mp4"), operation: operation, copying: true)
  operation.cancel()
  operation.cleanupOwnedOutputs()
  try require(manager.fileExists(atPath: metadata.asset.url.path), "Cleanup raced an active worker")
  try rejects("camera.cancelled") { try operation.commitOwnedOutputs() }
  operation.endWork()
  operation.cleanupOwnedOutputs()
  try require(try captureFiles() == before, "Canceled copy survived worker drain")
  try require(manager.fileExists(atPath: fixture("retry.mp4").path), "Provider file was deleted")
}

test("oversized source is refused before any private copy") {
  let source = fixture("oversized.mp4")
  try Data([0]).write(to: source)
  let output = try FileHandle(forWritingTo: source)
  try output.truncate(atOffset: UInt64(ProvisionalImportBudget.maximumSourceBytes + 1))
  try output.close()
  let operation = ClipMediaOperation()
  let before = try captureFiles()
  try rejects("camera.import_resource_limit") {
    _ = try ClipMediaStore.preflightImport(from: source, operation: operation, copying: true)
  }
  operation.cleanupOwnedOutputs()
  try require(try captureFiles() == before, "Oversized source reached private copying")
}

test("unreadable provider file is a file failure rather than missing video") {
  let source = fixture("unreadable.mp4")
  try Data("unreadable".utf8).write(to: source)
  try manager.setAttributes([.posixPermissions: 0o000], ofItemAtPath: source.path)
  defer { try? manager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: source.path) }
  let operation = ClipMediaOperation()
  defer { operation.cleanupOwnedOutputs() }
  let before = try captureFiles()
  try rejects("camera.import_file_unavailable") {
    _ = try ClipMediaStore.preflightImport(from: source, operation: operation, copying: true)
  }
  operation.cleanupOwnedOutputs()
  try require(try captureFiles() == before, "Unreadable import leaked staging files")
}

test("private copy mutation between preflight and sealing stays rejected") {
  let source = fixture("retry.mp4")
  let operation = ClipMediaOperation()
  defer { operation.cleanupOwnedOutputs() }
  let metadata = try ClipMediaStore.preflightImport(from: source, operation: operation, copying: true)
  let output = try FileHandle(forWritingTo: metadata.asset.url)
  try output.write(contentsOf: Data("changed!".utf8))
  try output.close()
  try refuses {
    _ = try ClipMediaStore.persistImportedVideo(from: source, metadata: metadata, operation: operation)
  }
  try require(try operation.videoIdentityPayload(for: metadata.asset.url) == nil, "Mutated bytes were sealed")
}

test("observation symlink cannot bypass the private child guard") {
  let observation = temp.appendingPathComponent("PickleSensei-Observation", isDirectory: true)
  let saved = fixture("saved-observation")
  try manager.moveItem(at: observation, to: saved)
  try manager.createSymbolicLink(at: observation, withDestinationURL: saved)
  defer {
    try? manager.removeItem(at: observation)
    try? manager.moveItem(at: saved, to: observation)
  }
  try refuses { _ = try ClipMediaStore.makeObservationURL() }
  try require(try manager.contentsOfDirectory(atPath: saved.path).isEmpty, "Recording followed a substituted directory")
}

test("OS error classification keeps protected, storage and format failures distinct") {
  let cases: [(String, Int, String)] = [
    (AVFoundationErrorDomain, AVError.contentIsProtected.rawValue, "camera.import_protected_content"),
    (AVFoundationErrorDomain, AVError.contentIsNotAuthorized.rawValue, "camera.import_protected_content"),
    (AVFoundationErrorDomain, AVError.fileFormatNotRecognized.rawValue, "camera.import_not_movie"),
    (AVFoundationErrorDomain, AVError.fileFailedToParse.rawValue, "camera.import_not_movie"),
    (NSCocoaErrorDomain, NSFileWriteOutOfSpaceError, "camera.import_low_storage"),
    (NSPOSIXErrorDomain, Int(EACCES), "camera.import_file_unavailable"),
    (NSPOSIXErrorDomain, Int.max, "camera.import_failed"),
  ]
  for (domain, code, expected) in cases {
    let result = ImportMediaFailure.classify(NSError(domain: domain, code: code), fallbackCode: "camera.import_failed")
    try require(result.code == expected, "Wrong error mapping for \(domain) \(code)")
    try require(!result.message.contains("does not contain a video track"), "Failure masqueraded as missing video")
  }
  let guarded = ImportMediaFailure.classify(ClipMediaStoreError.fileAccessFailed, fallbackCode: "camera.import_failed")
  try require(guarded.code == "camera.file_access_failed", "Filesystem guard failure was mislabeled")
}

print("RESULT \(total - failures)/\(total) passed")
exit(failures == 0 ? 0 : 1)
'''


def run(command, log, *, env=None):
    result = subprocess.run(
        command, capture_output=True, text=True, env=env, timeout=180
    )
    log.write_text(result.stdout + result.stderr)
    if result.returncode:
        print(result.stdout + result.stderr)
        raise subprocess.CalledProcessError(result.returncode, command)
    return result.stdout


def main():
    if sys.platform != "darwin":
        raise SystemExit("This regression requires macOS, Swift and AVFoundation.")
    if len(sys.argv) != 2:
        raise SystemExit("Usage: test-clip-storage.py <new-artifact-directory>")
    output = Path(sys.argv[1]).resolve()
    output.mkdir(parents=True, exist_ok=False)
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise SystemExit("Use the existing Mac verification host with FFmpeg installed.")
    cache = Path(os.environ.get(
        "PICKLE_CI_CACHE", Path.home() / "Library/Caches/PickleSensei-CI"
    ))
    cache.mkdir(parents=True, exist_ok=True)
    with (
        tempfile.TemporaryDirectory(prefix="clip-storage-", dir=cache) as scratch_name,
        tempfile.TemporaryDirectory(prefix="clip-storage-") as temp_name,
    ):
        scratch = Path(scratch_name)
        temp = Path(temp_name)
        home = scratch / "home"
        home.mkdir()
        (temp / "provider").mkdir()
        (temp / "not-a-movie.txt").write_text("Not a video file.")
        common = [ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin"]
        for name, duration, rate in [
            ("provider/movie.mp4", "1", "30"), ("too-long.mp4", "61", "1")
        ]:
            run(common + [
                "-f", "lavfi", "-i", f"color=c=black:s=64x64:r={rate}",
                "-t", duration, "-c:v", "libx264", "-threads", "1",
                "-pix_fmt", "yuv420p", str(temp / name),
            ], output / (Path(name).stem + "-fixture.log"))
        shutil.copyfile(temp / "provider/movie.mp4", temp / "retry.mp4")
        run(common + [
            "-f", "lavfi", "-i", "anullsrc=r=8000:cl=mono", "-t", "1",
            "-c:a", "aac", str(temp / "audio-only.mov"),
        ], output / "audio-fixture.log")
        source = SOURCE.read_text()
        storage = source[:source.index("  static func removeIfPresent(")]
        observation_name = '"PickleSensei-Observation"'
        if storage.count(observation_name) != 1:
            raise SystemExit("Could not isolate the observation directory fixture.")
        storage = storage.replace(
            observation_name, json.dumps(temp.name + "/PickleSensei-Observation")
        )
        storage = storage.replace("import UIKit\n", "") + "}\n"
        (scratch / "ClipMediaStore.swift").write_text(storage)
        (scratch / "main.swift").write_text(HARNESS)
        binary = scratch / "clip-storage-test"
        run([
            "xcrun", "swiftc", "-j", "2", "-lsandbox",
            str(scratch / "ClipMediaStore.swift"), str(scratch / "main.swift"),
            "-o", str(binary),
        ], output / "compile.log")
        env = dict(os.environ, CFFIXED_USER_HOME=str(home), TMPDIR=str(temp) + "/")
        result = run([str(binary), str(home), str(temp)], output / "tests.log", env=env)
        passed = [line[5:] for line in result.splitlines() if line.startswith("PASS ")]
        if not passed or not any(line.startswith("RESULT ") for line in result.splitlines()):
            raise SystemExit("The compiled regression did not report executed tests.")
        (output / "summary.json").write_text(json.dumps({
            "ok": True, "passed": len(passed), "failed": 0, "tests": passed,
            "scope": "shipping storage source in a root-denied macOS process, not physical iPhone acceptance",
        }, indent=2) + "\n")
        print(result, end="")


if __name__ == "__main__":
    main()
