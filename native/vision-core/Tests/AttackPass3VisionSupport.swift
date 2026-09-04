import AVFoundation
import CoreGraphics
import CoreMedia
import CoreVideo
import Foundation
import Vision
import XCTest

@testable import PickleVisionCore

// Test-only support for the PASS 3 adversarial suite against
// ApplePoseProvider (AttackPass3ApplePoseProviderTests, scenarios S22–S27).
//
// Everything here is deterministic: synthetic buffers are painted from fixed
// functions, the committed clip is decoded upright through the same
// AVAssetReaderVideoCompositionOutput path swing-lab uses, the two-person
// composites are built from crops of a real frame at fixed scale factors, and
// the only randomness (S26 sampling jitter, S23 corrupt-format order) comes
// from a recorded xorshift64* seed. Every test appends a JSON record to a
// report that lands next to the other Mac CI artifacts so the coordinator can
// diff macOS vs iOS Simulator output offline (tools/attack-pass3/compare_s27.py).

struct AttackPass3Failure: Error, CustomStringConvertible {
  let description: String
  init(_ description: String) { self.description = description }
}

/// xorshift64* — same generator family the other adversarial suites record.
struct AttackPass3Rng {
  private var state: UInt64
  let seed: UInt64

  init(seed: UInt64) {
    self.seed = seed
    state = seed == 0 ? 0x9E37_79B9_7F4A_7C15 : seed
  }

  mutating func next() -> UInt64 {
    state ^= state >> 12
    state ^= state << 25
    state ^= state >> 27
    return state &* 0x2545_F491_4F6C_DD1D
  }

  mutating func nextIndex(below bound: Int) -> Int {
    guard bound > 0 else { return 0 }
    return Int(next() % UInt64(bound))
  }

  mutating func nextUnit() -> Double {
    Double(next() >> 11) / Double(1 << 53)
  }
}

enum AttackPass3 {
  /// Recorded seed for every seeded decision in the suite.
  static let seed: UInt64 = 0x5EED_0000_0000_0004

  /// Four levels above native/vision-core/Tests/<file>.swift.
  static let repoRoot: URL = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent()
    .deletingLastPathComponent()
    .deletingLastPathComponent()
    .deletingLastPathComponent()

  /// The clip swing-lab extracts in scripts/mac-full-verify.sh.
  static let committedClip = repoRoot.appendingPathComponent(
    "datasets/pickleball/fresh-candidates/va-O1dLhGGPErc.mp4"
  )

  static var platformTag: String {
    #if os(macOS)
    return "macos"
    #elseif targetEnvironment(simulator)
    return "ios-simulator"
    #else
    return "ios-device"
    #endif
  }

  /// "PickleVisionCorePackageTests" under `swift test`,
  /// "PickleVisionCoreTests" under `xcodebuild test`.
  static var hostTag: String {
    Bundle(for: AttackPass3Report.self).bundleURL.deletingPathExtension().lastPathComponent
  }

  static func clipExists() -> Bool {
    FileManager.default.fileExists(atPath: committedClip.path)
  }

  // MARK: Resident memory (mach task_info)

  static func residentMemoryBytes() -> UInt64 {
    var info = mach_task_basic_info()
    var count = mach_msg_type_number_t(MemoryLayout<mach_task_basic_info>.size / MemoryLayout<natural_t>.size)
    let result = withUnsafeMutablePointer(to: &info) { pointer in
      pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { rebound in
        task_info(mach_task_self_, task_flavor_t(MACH_TASK_BASIC_INFO), rebound, &count)
      }
    }
    return result == KERN_SUCCESS ? UInt64(info.resident_size) : 0
  }

  /// Physical footprint (what Xcode's memory gauge and jetsam use). Falls back
  /// to 0 when the flavor is unavailable so the caller can still record RSS.
  static func physFootprintBytes() -> UInt64 {
    var info = task_vm_info_data_t()
    var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
    let result = withUnsafeMutablePointer(to: &info) { pointer in
      pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { rebound in
        task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), rebound, &count)
      }
    }
    return result == KERN_SUCCESS ? UInt64(info.phys_footprint) : 0
  }

  // MARK: Error description

  static func describe(_ error: Error) -> [String: Any] {
    let nsError = error as NSError
    var fields: [String: Any] = [
      "swiftType": String(describing: type(of: error)),
      "description": String(describing: error),
      "domain": nsError.domain,
      "code": nsError.code,
      "isVisionFailure": error is VisionFailure,
      "isVNErrorDomain": nsError.domain == VNErrorDomain,
    ]
    if let failure = error as? VisionFailure {
      fields["visionFailure"] = String(describing: failure)
    }
    return fields
  }

  static func orNull(_ value: Any?) -> Any {
    value ?? NSNull()
  }

  static func isNoPersonDetected(_ error: Error) -> Bool {
    guard let failure = error as? VisionFailure else { return false }
    if case .lowConfidence(let reason) = failure { return reason == "no person detected" }
    return false
  }

  // MARK: Pixel buffers

  static func fourCC(_ format: OSType) -> String {
    let bytes = [
      UInt8((format >> 24) & 0xFF), UInt8((format >> 16) & 0xFF),
      UInt8((format >> 8) & 0xFF), UInt8(format & 0xFF),
    ]
    if bytes.allSatisfy({ $0 >= 0x20 && $0 < 0x7F }) {
      return String(bytes: bytes, encoding: .ascii) ?? String(format)
    }
    return String(format)
  }

  static func makeBuffer(width: Int, height: Int, format: OSType) -> (CVPixelBuffer?, CVReturn) {
    var buffer: CVPixelBuffer?
    let attrs: [CFString: Any] = [
      kCVPixelBufferCGImageCompatibilityKey: true,
      kCVPixelBufferCGBitmapContextCompatibilityKey: true,
    ]
    let status = CVPixelBufferCreate(kCFAllocatorDefault, width, height, format, attrs as CFDictionary, &buffer)
    return (buffer, status)
  }

  /// 32BGRA buffer filled with one colour (B,G,R,A order in memory).
  static func makeSolidBGRA(width: Int, height: Int, blue: UInt8, green: UInt8, red: UInt8) throws -> CVPixelBuffer {
    let (created, status) = makeBuffer(width: width, height: height, format: kCVPixelFormatType_32BGRA)
    guard let buffer = created, status == kCVReturnSuccess else {
      throw AttackPass3Failure("CVPixelBufferCreate(\(width)x\(height), BGRA) failed: \(status)")
    }
    CVPixelBufferLockBaseAddress(buffer, [])
    defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
    guard let base = CVPixelBufferGetBaseAddress(buffer) else {
      throw AttackPass3Failure("no base address")
    }
    let bytesPerRow = CVPixelBufferGetBytesPerRow(buffer)
    let bytes = base.assumingMemoryBound(to: UInt8.self)
    for y in 0..<height {
      let row = bytes + y * bytesPerRow
      for x in 0..<width {
        row[x * 4] = blue
        row[x * 4 + 1] = green
        row[x * 4 + 2] = red
        row[x * 4 + 3] = 255
      }
    }
    return buffer
  }

  /// Fills a buffer of any format with zero bytes plane by plane so the test
  /// never reads uninitialised memory.
  static func zeroFill(_ buffer: CVPixelBuffer) {
    CVPixelBufferLockBaseAddress(buffer, [])
    defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
    if CVPixelBufferIsPlanar(buffer) {
      for plane in 0..<CVPixelBufferGetPlaneCount(buffer) {
        guard let base = CVPixelBufferGetBaseAddressOfPlane(buffer, plane) else { continue }
        let size = CVPixelBufferGetBytesPerRowOfPlane(buffer, plane) * CVPixelBufferGetHeightOfPlane(buffer, plane)
        memset(base, 0, size)
      }
    } else if let base = CVPixelBufferGetBaseAddress(buffer) {
      memset(base, 0, CVPixelBufferGetDataSize(buffer))
    }
  }

  /// Deep copy of a 32BGRA buffer so tests can hold a frame after the
  /// AVAssetReader that produced it is torn down.
  static func copyBGRA(_ source: CVPixelBuffer) throws -> CVPixelBuffer {
    let width = CVPixelBufferGetWidth(source)
    let height = CVPixelBufferGetHeight(source)
    guard CVPixelBufferGetPixelFormatType(source) == kCVPixelFormatType_32BGRA else {
      throw AttackPass3Failure("copyBGRA expects 32BGRA, got \(fourCC(CVPixelBufferGetPixelFormatType(source)))")
    }
    let (created, status) = makeBuffer(width: width, height: height, format: kCVPixelFormatType_32BGRA)
    guard let destination = created, status == kCVReturnSuccess else {
      throw AttackPass3Failure("CVPixelBufferCreate copy failed: \(status)")
    }
    CVPixelBufferLockBaseAddress(source, .readOnly)
    CVPixelBufferLockBaseAddress(destination, [])
    defer {
      CVPixelBufferUnlockBaseAddress(destination, [])
      CVPixelBufferUnlockBaseAddress(source, .readOnly)
    }
    guard let sourceBase = CVPixelBufferGetBaseAddress(source),
          let destinationBase = CVPixelBufferGetBaseAddress(destination)
    else { throw AttackPass3Failure("copyBGRA: missing base address") }
    let sourceStride = CVPixelBufferGetBytesPerRow(source)
    let destinationStride = CVPixelBufferGetBytesPerRow(destination)
    let rowBytes = width * 4
    for y in 0..<height {
      memcpy(destinationBase + y * destinationStride, sourceBase + y * sourceStride, rowBytes)
    }
    return destination
  }

  // MARK: CoreGraphics bridging (32BGRA, top-left rows)

  static let bgraBitmapInfo = CGBitmapInfo(
    rawValue: CGBitmapInfo.byteOrder32Little.rawValue | CGImageAlphaInfo.premultipliedFirst.rawValue
  )

  static func makeCGImage(_ buffer: CVPixelBuffer) throws -> CGImage {
    CVPixelBufferLockBaseAddress(buffer, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
    guard let base = CVPixelBufferGetBaseAddress(buffer),
          let context = CGContext(
            data: base,
            width: CVPixelBufferGetWidth(buffer),
            height: CVPixelBufferGetHeight(buffer),
            bitsPerComponent: 8,
            bytesPerRow: CVPixelBufferGetBytesPerRow(buffer),
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: bgraBitmapInfo.rawValue
          ),
          let image = context.makeImage()
    else { throw AttackPass3Failure("cannot wrap pixel buffer in CGContext") }
    return image
  }

  /// Renders `draw` into a fresh 32BGRA buffer. The context origin is
  /// bottom-left (CoreGraphics); memory row 0 is the top scanline, which is
  /// what Vision reads with orientation `.up`.
  static func renderBGRA(width: Int, height: Int, background: (CGFloat, CGFloat, CGFloat), draw: (CGContext) -> Void) throws -> CVPixelBuffer {
    let (created, status) = makeBuffer(width: width, height: height, format: kCVPixelFormatType_32BGRA)
    guard let buffer = created, status == kCVReturnSuccess else {
      throw AttackPass3Failure("CVPixelBufferCreate(\(width)x\(height)) failed: \(status)")
    }
    CVPixelBufferLockBaseAddress(buffer, [])
    defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
    guard let base = CVPixelBufferGetBaseAddress(buffer),
          let context = CGContext(
            data: base,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: CVPixelBufferGetBytesPerRow(buffer),
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: bgraBitmapInfo.rawValue
          )
    else { throw AttackPass3Failure("cannot create CGContext over pixel buffer") }
    context.setFillColor(red: background.0, green: background.1, blue: background.2, alpha: 1)
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    context.interpolationQuality = .high
    draw(context)
    return buffer
  }

  /// Rotates a 32BGRA frame by 90° (the top of the content ends up on one
  /// side; exactly one of CGImagePropertyOrientation.right / .left reads it
  /// upright), mimicking a portrait clip stored as a landscape track with a
  /// preferredTransform.
  static func rotateQuarterTurn(_ source: CVPixelBuffer) throws -> CVPixelBuffer {
    let image = try makeCGImage(source)
    let width = image.height
    let height = image.width
    return try renderBGRA(width: width, height: height, background: (0, 0, 0)) { context in
      context.translateBy(x: CGFloat(width), y: 0)
      context.rotate(by: .pi / 2)
      context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
    }
  }

  // MARK: Landmark helpers

  static func landmark(_ frame: PoseFrame, _ name: String) -> PoseLandmark? {
    frame.landmarks.first { $0.name == name }
  }

  /// Display-space torso midpoint (top-left origin) from a PoseFrame, using
  /// the same 0.2 visibility floor ApplePoseProvider.point applies.
  static func torsoMidDisplay(_ frame: PoseFrame) -> CGPoint? {
    let names = ["left_shoulder", "right_shoulder", "left_hip", "right_hip"]
    var points: [PoseLandmark] = []
    for name in names {
      guard let point = landmark(frame, name), point.visibility >= 0.2 else { return nil }
      points.append(point)
    }
    let x = points.reduce(0.0) { $0 + $1.x } / 4
    let y = points.reduce(0.0) { $0 + $1.y } / 4
    return CGPoint(x: x, y: y)
  }

  static func torsoSpan(_ frame: PoseFrame) -> Double? {
    guard let ls = landmark(frame, "left_shoulder"), let rs = landmark(frame, "right_shoulder"),
          let lh = landmark(frame, "left_hip"), let rh = landmark(frame, "right_hip"),
          [ls, rs, lh, rh].allSatisfy({ $0.visibility >= 0.2 })
    else { return nil }
    let shoulderMid = CGPoint(x: (ls.x + rs.x) / 2, y: (ls.y + rs.y) / 2)
    let hipMid = CGPoint(x: (lh.x + rh.x) / 2, y: (lh.y + rh.y) / 2)
    return Double(hypot(shoulderMid.x - hipMid.x, shoulderMid.y - hipMid.y))
  }

  /// Pixel bounding box (top-left origin) of the visible landmarks with
  /// padding so hands/feet/head are inside the crop.
  static func bodyRectPixels(_ frame: PoseFrame, width: Int, height: Int, padFraction: Double) -> CGRect? {
    let visible = frame.landmarks.filter { $0.visibility >= 0.2 }
    guard visible.count >= 8,
          let minX = visible.map(\.x).min(), let maxX = visible.map(\.x).max(),
          let minY = visible.map(\.y).min(), let maxY = visible.map(\.y).max()
    else { return nil }
    let w = Double(width)
    let h = Double(height)
    let padX = (maxX - minX) * padFraction * w
    let padY = (maxY - minY) * padFraction * h
    let rect = CGRect(
      x: max(0, minX * w - padX),
      y: max(0, minY * h - padY),
      width: min(w, (maxX - minX) * w + 2 * padX),
      height: min(h, (maxY - minY) * h + 2 * padY)
    )
    return rect.intersection(CGRect(x: 0, y: 0, width: w, height: h))
  }

  static func serialize(_ frame: PoseFrame) -> [String: Any] {
    [
      "t": frame.timestampMs,
      "c": frame.confidence,
      "l": frame.landmarks.map { ["n": $0.name, "x": $0.x, "y": $0.y, "v": $0.visibility] },
    ]
  }

  /// Max absolute coordinate / visibility deltas between two frames matched
  /// by landmark name; nil when the landmark sets differ.
  static func maxDelta(_ a: PoseFrame, _ b: PoseFrame) -> (coord: Double, visibility: Double)? {
    let byName = Dictionary(b.landmarks.map { ($0.name, $0) }, uniquingKeysWith: { first, _ in first })
    guard a.landmarks.count == b.landmarks.count else { return nil }
    var coord = 0.0
    var visibility = 0.0
    for landmark in a.landmarks {
      guard let other = byName[landmark.name] else { return nil }
      coord = max(coord, abs(landmark.x - other.x), abs(landmark.y - other.y))
      visibility = max(visibility, abs(landmark.visibility - other.visibility))
    }
    return (coord, visibility)
  }
}

// MARK: - Report

/// One JSON report per suite per process, written next to the other Mac CI
/// artifacts (macos-ci-artifacts/attack-pass3-vision-core/) when the runner
/// created that directory, otherwise to the temporary directory. The S27 diff
/// (tools/attack-pass3/compare_s27.py) consumes the macOS and iOS Simulator files.
final class AttackPass3Report {
  let suite: String
  private var records: [[String: Any]] = []
  private let lock = NSLock()
  private let startedAt = Date()

  init(suite: String) {
    self.suite = suite
  }

  func record(_ test: String, _ fields: [String: Any]) {
    var entry: [String: Any] = [
      "test": test,
      "platform": AttackPass3.platformTag,
      "host": AttackPass3.hostTag,
      "seed": String(AttackPass3.seed, radix: 16),
    ]
    for (key, value) in fields { entry[key] = value }
    lock.lock()
    records.append(entry)
    lock.unlock()
    print("[attack-pass3] \(suite).\(test): \(AttackPass3Report.oneLine(fields))")
  }

  static var outputDirectory: URL {
    let ciArtifacts = AttackPass3.repoRoot.appendingPathComponent("macos-ci-artifacts")
    var isDirectory: ObjCBool = false
    if FileManager.default.fileExists(atPath: ciArtifacts.path, isDirectory: &isDirectory), isDirectory.boolValue {
      return ciArtifacts.appendingPathComponent("attack-pass3-vision-core")
    }
    return FileManager.default.temporaryDirectory.appendingPathComponent("attack-pass3-vision-core")
  }

  @discardableResult
  func flush() -> URL? {
    lock.lock()
    let snapshot = records
    lock.unlock()
    let base = AttackPass3Report.outputDirectory
    let payload: [String: Any] = [
      "suite": suite,
      "platform": AttackPass3.platformTag,
      "host": AttackPass3.hostTag,
      "seed": String(AttackPass3.seed, radix: 16),
      "startedAtIso": ISO8601DateFormatter().string(from: startedAt),
      "finishedAtIso": ISO8601DateFormatter().string(from: Date()),
      "processInfo": [
        "osVersion": ProcessInfo.processInfo.operatingSystemVersionString,
        "physicalMemoryBytes": Int(ProcessInfo.processInfo.physicalMemory),
        "activeProcessorCount": ProcessInfo.processInfo.activeProcessorCount,
      ],
      "records": snapshot,
    ]
    do {
      try FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
      let url = base.appendingPathComponent(
        "\(AttackPass3.platformTag)-\(AttackPass3.hostTag)-\(suite)-pid\(ProcessInfo.processInfo.processIdentifier).json"
      )
      let data = try JSONSerialization.data(
        withJSONObject: AttackPass3Report.sanitize(payload), options: [.prettyPrinted, .sortedKeys]
      )
      try data.write(to: url)
      print("[attack-pass3] \(suite): report written to \(url.path) (\(snapshot.count) records)")
      return url
    } catch {
      print("[attack-pass3] \(suite): report write failed: \(error)")
      return nil
    }
  }

  /// JSONSerialization rejects NaN/Inf and non-Foundation types.
  static func sanitize(_ value: Any) -> Any {
    switch value {
    case let dictionary as [String: Any]:
      var out: [String: Any] = [:]
      for (key, inner) in dictionary { out[key] = sanitize(inner) }
      return out
    case let array as [Any]:
      return array.map(sanitize)
    case let double as Double:
      return double.isFinite ? double : String(describing: double)
    case let float as Float:
      return float.isFinite ? Double(float) : String(describing: float)
    case let cgFloat as CGFloat:
      return cgFloat.isFinite ? Double(cgFloat) : String(describing: cgFloat)
    case is Int, is Int64, is UInt64, is UInt, is Bool, is String, is NSNull:
      return value
    default:
      return String(describing: value)
    }
  }

  static func oneLine(_ fields: [String: Any]) -> String {
    fields.keys.sorted().map { key in
      let value = fields[key].map { String(describing: $0) } ?? "nil"
      return "\(key)=\(value.count > 120 ? String(value.prefix(117)) + "..." : value)"
    }.joined(separator: " ")
  }
}

// MARK: - Upright clip reader (mirror of swing-lab's UprightVideoReader)

/// Decodes the committed clip upright (preferredTransform applied through
/// AVAssetReaderVideoCompositionOutput) into 32BGRA buffers — the same path
/// `swing-lab extract` uses, so per-frame comparisons against the run
/// 33841813597 pose.json artifact are like-for-like.
@available(macOS 13.0, iOS 16.0, *)
final class AttackPass3ClipReader {
  let reader: AVAssetReader
  let output: AVAssetReaderVideoCompositionOutput
  let width: Int
  let height: Int
  let preferredTransform: CGAffineTransform

  init(url: URL) async throws {
    let asset = AVURLAsset(url: url)
    guard let track = try await asset.loadTracks(withMediaType: .video).first else {
      throw AttackPass3Failure("no video track in \(url.path)")
    }
    let composition = try await AVMutableVideoComposition.videoComposition(withPropertiesOf: asset)
    preferredTransform = try await track.load(.preferredTransform)
    let reader = try AVAssetReader(asset: asset)
    let output = AVAssetReaderVideoCompositionOutput(
      videoTracks: [track],
      videoSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
    )
    output.videoComposition = composition
    output.alwaysCopiesSampleData = false
    guard reader.canAdd(output) else { throw AttackPass3Failure("cannot add output for \(url.path)") }
    reader.add(output)
    guard reader.startReading() else {
      if let error = reader.error { throw error }
      throw AttackPass3Failure("startReading failed")
    }
    self.reader = reader
    self.output = output
    width = Int(composition.renderSize.width.rounded())
    height = Int(composition.renderSize.height.rounded())
  }

  func next() -> (buffer: CVPixelBuffer, timestampMs: Int)? {
    guard let sample = output.copyNextSampleBuffer(),
          let buffer = CMSampleBufferGetImageBuffer(sample)
    else { return nil }
    let pts = CMSampleBufferGetPresentationTimeStamp(sample)
    return (buffer: buffer, timestampMs: Int((CMTimeGetSeconds(pts) * 1000).rounded()))
  }

  func cancel() {
    reader.cancelReading()
  }

  /// First decoded frame (deep-copied) on which `provider.extractPose`
  /// resolves a full torso, plus its index and timestamp.
  static func firstPersonFrame(url: URL, provider: ApplePoseProvider, maxFrames: Int = 240) async throws -> (buffer: CVPixelBuffer, index: Int, timestampMs: Int, pose: PoseFrame)? {
    let reader = try await AttackPass3ClipReader(url: url)
    defer { reader.cancel() }
    var index = 0
    while index < maxFrames, let frame = reader.next() {
      defer { index += 1 }
      provider.resetPrimaryPersonAnchor()
      guard let pose = try? provider.extractPose(pixelBuffer: frame.buffer, timestampMs: frame.timestampMs),
            AttackPass3.torsoMidDisplay(pose) != nil,
            pose.confidence >= 0.5
      else { continue }
      let copy = try AttackPass3.copyBGRA(frame.buffer)
      return (buffer: copy, index: index, timestampMs: frame.timestampMs, pose: pose)
    }
    return nil
  }
}
