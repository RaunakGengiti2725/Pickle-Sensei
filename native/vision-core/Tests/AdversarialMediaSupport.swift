import AVFoundation
import CoreGraphics
import CoreMedia
import CoreVideo
import Foundation
import Vision
import XCTest

@testable import PickleVisionCore

// Test-only support for the adversarial media suites
// (AdversarialSyntheticMediaTests, AdversarialRealClipTests,
// SwingLabBinaryAdversarialTests). Everything here is deterministic: clips
// are rendered at runtime with AVAssetWriter from a fixed paint function,
// byte corruption uses a recorded xorshift64 seed, and every suite writes a
// JSON observation report next to the other Mac CI artifacts so failures can
// be replayed from the recorded inputs.

struct AdversarialFailure: Error, CustomStringConvertible {
  let description: String
  init(_ description: String) { self.description = description }
}

/// Deterministic PRNG (xorshift64*) so corrupted fixtures are byte-identical
/// on every run for a recorded seed.
struct AdversarialXorShift64 {
  private var state: UInt64

  init(seed: UInt64) {
    state = seed == 0 ? 0x9E37_79B9_7F4A_7C15 : seed
  }

  mutating func next() -> UInt64 {
    state ^= state >> 12
    state ^= state << 25
    state ^= state >> 27
    return state &* 0x2545_F491_4F6C_DD1D
  }

  mutating func nextByte() -> UInt8 {
    UInt8(truncatingIfNeeded: next() >> 56)
  }

  mutating func nextIndex(below bound: Int) -> Int {
    guard bound > 0 else { return 0 }
    return Int(next() % UInt64(bound))
  }
}

enum AdversarialSupport {
  /// Four levels above native/vision-core/Tests/<file>.swift.
  static let repoRoot: URL = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent()
    .deletingLastPathComponent()
    .deletingLastPathComponent()
    .deletingLastPathComponent()

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
    Bundle(for: AdversarialReport.self).bundleURL.deletingPathExtension().lastPathComponent
  }

  static func repoFile(_ relativePath: String) -> URL {
    repoRoot.appendingPathComponent(relativePath)
  }

  static func fileExists(_ url: URL) -> Bool {
    FileManager.default.fileExists(atPath: url.path)
  }

  static func makeScratchDirectory(_ label: String) throws -> URL {
    let url = FileManager.default.temporaryDirectory
      .appendingPathComponent("pickle-adversarial-\(label)-\(ProcessInfo.processInfo.processIdentifier)-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
  }

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

  static func describe(_ error: Error) -> [String: Any] {
    let nsError = error as NSError
    var fields: [String: Any] = [
      "type": String(describing: type(of: error)),
      "description": String(describing: error),
      "domain": nsError.domain,
      "code": nsError.code,
    ]
    if let failure = error as? VisionFailure {
      fields["visionFailure"] = String(describing: failure)
    }
    return fields
  }

  static func describeOrNull(_ error: Error?) -> Any {
    if let error { return describe(error) }
    return NSNull()
  }

  static func isVisionFailureLowConfidence(_ error: Error) -> Bool {
    guard let failure = error as? VisionFailure else { return false }
    if case .lowConfidence = failure { return true }
    return false
  }

  // MARK: Synthetic pixels

  /// Deterministic person-free scene: a blue "wall" over a green "floor",
  /// a white court line, and an orange square that moves with the frame
  /// index so consecutive frames differ (keeps encoders and the swing-lab
  /// scene-cut histogram honest). BGRA, top-left origin.
  static func paintScene(base: UnsafeMutablePointer<UInt8>, bytesPerRow: Int, width: Int, height: Int, frameIndex: Int) {
    let horizon = max(1, height * 2 / 5)
    let lineY = max(0, min(height - 1, height * 3 / 4))
    let squareSize = max(1, min(width, height) / 8)
    let squareX = width <= squareSize ? 0 : (frameIndex * max(1, width / 32)) % max(1, width - squareSize)
    let squareY = max(0, horizon + squareSize / 2)
    for y in 0..<height {
      let row = base + y * bytesPerRow
      let isFloor = y >= horizon
      let isLine = y == lineY
      for x in 0..<width {
        let pixel = row + x * 4
        var blue: UInt8 = isFloor ? 40 : 200
        var green: UInt8 = isFloor ? 140 : 120
        var red: UInt8 = isFloor ? 30 : 30
        if isLine {
          blue = 245; green = 245; red = 245
        }
        if x >= squareX, x < squareX + squareSize, y >= squareY, y < squareY + squareSize {
          blue = 20; green = 110; red = 240
        }
        pixel[0] = blue
        pixel[1] = green
        pixel[2] = red
        pixel[3] = 255
      }
    }
  }

  static func makeSceneBuffer(width: Int, height: Int, frameIndex: Int = 0) throws -> CVPixelBuffer {
    var created: CVPixelBuffer?
    let status = CVPixelBufferCreate(kCFAllocatorDefault, width, height, kCVPixelFormatType_32BGRA, nil, &created)
    guard status == kCVReturnSuccess, let buffer = created else {
      throw AdversarialFailure("CVPixelBufferCreate(\(width)x\(height)) failed with status \(status)")
    }
    CVPixelBufferLockBaseAddress(buffer, [])
    defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
    guard let base = CVPixelBufferGetBaseAddress(buffer) else {
      throw AdversarialFailure("CVPixelBufferGetBaseAddress returned nil for \(width)x\(height)")
    }
    paintScene(
      base: base.assumingMemoryBound(to: UInt8.self),
      bytesPerRow: CVPixelBufferGetBytesPerRow(buffer),
      width: width,
      height: height,
      frameIndex: frameIndex
    )
    return buffer
  }

  // MARK: Synthetic clips

  struct ClipSpec {
    var width: Int
    var height: Int
    var frames: Int
    var fps: Int32
    /// Applied as the track's preferredTransform (AVAssetWriterInput.transform).
    var transform: CGAffineTransform = .identity

    var recipe: [String: Any] {
      [
        "width": width, "height": height, "frames": frames, "fps": Int(fps),
        "transform": [Double(transform.a), Double(transform.b), Double(transform.c), Double(transform.d), Double(transform.tx), Double(transform.ty)],
        "paint": "AdversarialSupport.paintScene (deterministic, person-free)",
      ]
    }
  }

  struct WrittenClip {
    let url: URL
    let codec: String
    let bytes: Int
  }

  /// Renders `spec` with AVAssetWriter. H.264/.mp4 first (what the phone
  /// records); if the encoder is unavailable on this host the same frames are
  /// written as Motion-JPEG/.mov so the reader-level tests still run, and the
  /// codec actually used is recorded in the report.
  static func writeClip(_ spec: ClipSpec, named name: String, in directory: URL) throws -> WrittenClip {
    do {
      let url = directory.appendingPathComponent("\(name).mp4")
      try writeClip(spec, to: url, codec: .h264, fileType: .mp4)
      return WrittenClip(url: url, codec: "h264/mp4", bytes: fileSize(url))
    } catch let primary {
      let url = directory.appendingPathComponent("\(name).mov")
      do {
        try writeClip(spec, to: url, codec: .jpeg, fileType: .mov)
        return WrittenClip(url: url, codec: "jpeg/mov (h264 fallback: \(primary))", bytes: fileSize(url))
      } catch {
        throw AdversarialFailure("clip encode failed: h264 -> \(primary); jpeg -> \(error)")
      }
    }
  }

  static func fileSize(_ url: URL) -> Int {
    let attributes = try? FileManager.default.attributesOfItem(atPath: url.path)
    return (attributes?[.size] as? NSNumber)?.intValue ?? -1
  }

  private static func writeClip(_ spec: ClipSpec, to url: URL, codec: AVVideoCodecType, fileType: AVFileType) throws {
    try? FileManager.default.removeItem(at: url)
    let writer = try AVAssetWriter(outputURL: url, fileType: fileType)
    let settings: [String: Any] = [
      AVVideoCodecKey: codec,
      AVVideoWidthKey: spec.width,
      AVVideoHeightKey: spec.height,
    ]
    let input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
    input.expectsMediaDataInRealTime = false
    input.transform = spec.transform
    let adaptor = AVAssetWriterInputPixelBufferAdaptor(
      assetWriterInput: input,
      sourcePixelBufferAttributes: [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
        kCVPixelBufferWidthKey as String: spec.width,
        kCVPixelBufferHeightKey as String: spec.height,
      ]
    )
    guard writer.canAdd(input) else { throw AdversarialFailure("AVAssetWriter.canAdd rejected the video input") }
    writer.add(input)
    guard writer.startWriting() else {
      throw writer.error ?? AdversarialFailure("AVAssetWriter.startWriting failed without an error")
    }
    writer.startSession(atSourceTime: .zero)

    for index in 0..<spec.frames {
      let deadline = Date().addingTimeInterval(10)
      while !input.isReadyForMoreMediaData {
        if Date() > deadline { throw AdversarialFailure("AVAssetWriterInput never became ready (frame \(index))") }
        Thread.sleep(forTimeInterval: 0.002)
      }
      let buffer: CVPixelBuffer
      if let pool = adaptor.pixelBufferPool {
        var pooled: CVPixelBuffer?
        let status = CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, pool, &pooled)
        guard status == kCVReturnSuccess, let pooledBuffer = pooled else {
          throw AdversarialFailure("CVPixelBufferPoolCreatePixelBuffer failed with status \(status)")
        }
        CVPixelBufferLockBaseAddress(pooledBuffer, [])
        if let base = CVPixelBufferGetBaseAddress(pooledBuffer) {
          paintScene(
            base: base.assumingMemoryBound(to: UInt8.self),
            bytesPerRow: CVPixelBufferGetBytesPerRow(pooledBuffer),
            width: spec.width,
            height: spec.height,
            frameIndex: index
          )
        }
        CVPixelBufferUnlockBaseAddress(pooledBuffer, [])
        buffer = pooledBuffer
      } else {
        buffer = try makeSceneBuffer(width: spec.width, height: spec.height, frameIndex: index)
      }
      let time = CMTime(value: CMTimeValue(index), timescale: spec.fps)
      guard adaptor.append(buffer, withPresentationTime: time) else {
        throw writer.error ?? AdversarialFailure("AVAssetWriterInputPixelBufferAdaptor.append failed at frame \(index)")
      }
    }

    input.markAsFinished()
    let finished = DispatchSemaphore(value: 0)
    writer.finishWriting { finished.signal() }
    if finished.wait(timeout: .now() + 60) == .timedOut {
      throw AdversarialFailure("AVAssetWriter.finishWriting did not complete within 60s")
    }
    guard writer.status == .completed else {
      throw writer.error ?? AdversarialFailure("AVAssetWriter finished with status \(writer.status.rawValue)")
    }
  }

  // MARK: Byte-level corruption (recorded seeds)

  static func corruptedCopy(of source: URL, seed: UInt64, fraction: Double, protectPrefix: Int, to destination: URL) throws -> [String: Any] {
    var data = try Data(contentsOf: source)
    var rng = AdversarialXorShift64(seed: seed)
    let editable = max(0, data.count - protectPrefix)
    let edits = max(1, Int(Double(editable) * fraction))
    for _ in 0..<edits where editable > 0 {
      let index = protectPrefix + rng.nextIndex(below: editable)
      data[index] = rng.nextByte()
    }
    try data.write(to: destination)
    return ["recipe": "xorshift64 byte overwrite", "seed": Int(seed), "fraction": fraction, "protectPrefix": protectPrefix, "edits": edits, "bytes": data.count]
  }

  static func truncatedCopy(of source: URL, keepFraction: Double, to destination: URL) throws -> [String: Any] {
    let data = try Data(contentsOf: source)
    let keep = max(0, min(data.count, Int(Double(data.count) * keepFraction)))
    try data.prefix(keep).write(to: destination)
    return ["recipe": "prefix truncation", "keepFraction": keepFraction, "bytes": keep, "sourceBytes": data.count]
  }

  static func garbageFile(bytes: Int, seed: UInt64, to destination: URL) throws -> [String: Any] {
    var rng = AdversarialXorShift64(seed: seed)
    var data = Data(count: bytes)
    for index in 0..<bytes { data[index] = rng.nextByte() }
    try data.write(to: destination)
    return ["recipe": "xorshift64 random bytes", "seed": Int(seed), "bytes": bytes]
  }

  static func emptyFile(to destination: URL) throws -> [String: Any] {
    try Data().write(to: destination)
    return ["recipe": "zero-byte file", "bytes": 0]
  }
}

// MARK: - Observation report

/// Collects per-test observations and writes them as JSON under
/// macos-ci-artifacts/adversarial-xctest/ (uploaded by the Mac workflow) or,
/// outside the CI checkout, under the temporary directory. The path is
/// printed so it appears in the swift-test / xcodebuild logs.
final class AdversarialReport {
  let suite: String
  private var records: [[String: Any]] = []
  private let lock = NSLock()
  private let startedAt = Date()

  init(suite: String) {
    self.suite = suite
  }

  func record(_ test: String, _ fields: [String: Any]) {
    var entry: [String: Any] = ["test": test, "platform": AdversarialSupport.platformTag, "host": AdversarialSupport.hostTag]
    for (key, value) in fields { entry[key] = value }
    lock.lock()
    records.append(entry)
    lock.unlock()
    print("[adversarial] \(suite).\(test): \(AdversarialReport.oneLine(fields))")
  }

  @discardableResult
  func flush() -> URL? {
    lock.lock()
    let snapshot = records
    lock.unlock()
    let ciArtifacts = AdversarialSupport.repoRoot.appendingPathComponent("macos-ci-artifacts")
    var isDirectory: ObjCBool = false
    let base: URL
    if FileManager.default.fileExists(atPath: ciArtifacts.path, isDirectory: &isDirectory), isDirectory.boolValue {
      base = ciArtifacts.appendingPathComponent("adversarial-xctest")
    } else {
      base = FileManager.default.temporaryDirectory.appendingPathComponent("adversarial-xctest")
    }
    let payload: [String: Any] = [
      "suite": suite,
      "platform": AdversarialSupport.platformTag,
      "host": AdversarialSupport.hostTag,
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
      // `swift test --parallel` spreads one suite over several worker
      // processes; each writes its own file.
      let url = base.appendingPathComponent(
        "\(AdversarialSupport.platformTag)-\(AdversarialSupport.hostTag)-\(suite)-pid\(ProcessInfo.processInfo.processIdentifier).json"
      )
      let data = try JSONSerialization.data(withJSONObject: AdversarialReport.sanitize(payload), options: [.prettyPrinted, .sortedKeys])
      try data.write(to: url)
      print("[adversarial] \(suite): report written to \(url.path) (\(snapshot.count) records)")
      return url
    } catch {
      print("[adversarial] \(suite): report write failed: \(error)")
      return nil
    }
  }

  /// JSONSerialization traps on NaN/inf and rejects non-property-list types;
  /// everything is coerced to plain JSON values first.
  static func sanitize(_ value: Any) -> Any {
    switch value {
    case let dictionary as [String: Any]:
      var out: [String: Any] = [:]
      for (key, inner) in dictionary { out[key] = sanitize(inner) }
      return out
    case let array as [Any]:
      return array.map { sanitize($0) }
    case let string as String:
      return string
    case is NSNull:
      return NSNull()
    default:
      break
    }
    // Numeric casts on `Any` bridge through NSNumber on Darwin (Bool <-> Int
    // <-> Double), so the concrete type decides, not `as?`.
    let concrete = type(of: value)
    if concrete == Double.self, let double = value as? Double {
      return double.isFinite ? double : String(describing: double)
    }
    if concrete == Float.self, let float = value as? Float {
      return float.isFinite ? Double(float) : String(describing: float)
    }
    if concrete == CGFloat.self, let cgFloat = value as? CGFloat {
      return cgFloat.isFinite ? Double(cgFloat) : String(describing: cgFloat)
    }
    if concrete == UInt64.self, let uint = value as? UInt64 {
      return uint <= UInt64(Int.max) ? Int(uint) : String(uint)
    }
    if concrete == Bool.self || concrete == Int.self || concrete == Int32.self || concrete == Int64.self || value is NSNumber {
      return value
    }
    return String(describing: value)
  }

  private static func oneLine(_ fields: [String: Any]) -> String {
    fields.keys.sorted().map { "\($0)=\(fields[$0].map { String(describing: $0) } ?? "nil")" }.joined(separator: " ")
  }
}

// MARK: - swing-lab reader / extract mirror

/// Test-side copy of swing-lab's `UprightVideoReader`
/// (native/swing-lab/Sources/main.swift, "Upright frame reader"): frames are
/// read through an AVAssetReaderVideoCompositionOutput built from the
/// track's preferredTransform, so pixels arrive upright. swing-lab is an
/// executable package that vision-core's test target cannot import; the
/// SwingLabBinaryAdversarialTests suite exercises the real binary on macOS.
@available(macOS 13.0, iOS 16.0, *)
final class UprightFrameReaderMirror {
  let reader: AVAssetReader
  let output: AVAssetReaderVideoCompositionOutput
  let width: Int
  let height: Int
  let fps: Double
  let durationMs: Int
  let naturalSize: CGSize
  let preferredTransform: CGAffineTransform

  init(url: URL) async throws {
    let asset = AVURLAsset(url: url)
    guard let track = try await asset.loadTracks(withMediaType: .video).first else {
      throw NSError(domain: "swing-lab-mirror", code: 1, userInfo: [NSLocalizedDescriptionKey: "no video track in \(url.path)"])
    }
    let composition = try await AVMutableVideoComposition.videoComposition(withPropertiesOf: asset)
    let renderSize = composition.renderSize
    let duration = try await asset.load(.duration)
    let nominalFps = try await track.load(.nominalFrameRate)
    naturalSize = try await track.load(.naturalSize)
    preferredTransform = try await track.load(.preferredTransform)

    let reader = try AVAssetReader(asset: asset)
    let output = AVAssetReaderVideoCompositionOutput(
      videoTracks: [track],
      videoSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
    )
    output.videoComposition = composition
    output.alwaysCopiesSampleData = false
    guard reader.canAdd(output) else {
      throw NSError(domain: "swing-lab-mirror", code: 2, userInfo: [NSLocalizedDescriptionKey: "cannot read \(url.path)"])
    }
    reader.add(output)
    guard reader.startReading() else {
      throw reader.error ?? NSError(domain: "swing-lab-mirror", code: 3, userInfo: [NSLocalizedDescriptionKey: "startReading failed"])
    }
    self.reader = reader
    self.output = output
    self.width = Int(renderSize.width.rounded())
    self.height = Int(renderSize.height.rounded())
    self.fps = Double(nominalFps)
    self.durationMs = Int((CMTimeGetSeconds(duration) * 1000).rounded())
  }

  func next() -> (buffer: CVPixelBuffer, sample: CMSampleBuffer, timestampMs: Int)? {
    guard let sample = output.copyNextSampleBuffer(),
          let buffer = CMSampleBufferGetImageBuffer(sample)
    else { return nil }
    let pts = CMSampleBufferGetPresentationTimeStamp(sample)
    return (buffer, sample, Int((CMTimeGetSeconds(pts) * 1000).rounded()))
  }

  func cancel() {
    reader.cancelReading()
  }

  var geometry: [String: Any] {
    [
      "renderWidth": width, "renderHeight": height, "fps": fps, "durationMs": durationMs,
      "naturalWidth": Double(naturalSize.width), "naturalHeight": Double(naturalSize.height),
      "preferredTransform": [
        Double(preferredTransform.a), Double(preferredTransform.b), Double(preferredTransform.c),
        Double(preferredTransform.d), Double(preferredTransform.tx), Double(preferredTransform.ty),
      ],
    ]
  }
}

/// Lock-guarded byte box for pipe readers running on Dispatch queues.
final class AdversarialDataBox: @unchecked Sendable {
  private var data = Data()
  private let lock = NSLock()

  func set(_ value: Data) {
    lock.lock()
    data = value
    lock.unlock()
  }

  func get() -> Data {
    lock.lock()
    defer { lock.unlock() }
    return data
  }
}

/// Lock-guarded counters / error list for tests that hammer the provider
/// from several threads at once.
final class AdversarialTally: @unchecked Sendable {
  private var counts: [String: Int] = [:]
  private var errors: [[String: Any]] = []
  private let lock = NSLock()

  func bump(_ key: String, by amount: Int = 1) {
    lock.lock()
    counts[key, default: 0] += amount
    lock.unlock()
  }

  func addError(_ error: Error) {
    lock.lock()
    errors.append(AdversarialSupport.describe(error))
    lock.unlock()
  }

  func count(_ key: String) -> Int {
    lock.lock()
    defer { lock.unlock() }
    return counts[key] ?? 0
  }

  var recordedErrors: [[String: Any]] {
    lock.lock()
    defer { lock.unlock() }
    return errors
  }
}

/// Thread-safe cancellation flag shared between the extraction loop and the
/// test that cancels it.
final class AdversarialCancelToken: @unchecked Sendable {
  private var flag = false
  private let lock = NSLock()

  var isCancelled: Bool {
    lock.lock()
    defer { lock.unlock() }
    return flag
  }

  func cancel() {
    lock.lock()
    flag = true
    lock.unlock()
  }
}

struct AdversarialExtractionStats {
  var framesDecoded = 0
  var framesAnalyzed = 0
  var framesWithPose = 0
  var poseMisses = 0
  var poseErrorsOtherThanLowConfidence = 0
  var framesWithPeople = 0
  var maxPeopleInFrame = 0
  var peopleHistogram: [Int: Int] = [:]
  var primarySwitches = 0
  var landmarksOutOfUnitRange = 0
  var maxLandmarkOvershoot = 0.0
  var landmarksNonFinite = 0
  var confidenceOutOfRange = 0
  var timestampsNonMonotonic = 0
  var trajectoryErrors = 0
  var trajectoryCount = 0
  var minPoseConfidence = Double.infinity
  var maxPoseConfidence = -Double.infinity
  var firstTimestampMs: Int?
  var lastTimestampMs: Int?
  var cancelledAfterFrames: Int?
  var wallMs = 0
  var perFrameVisionMs: [Int] = []
  var residentBytesBefore: UInt64 = 0
  var residentBytesPeak: UInt64 = 0
  var lastError: [String: Any]?

  var json: [String: Any] {
    var out: [String: Any] = [
      "framesDecoded": framesDecoded,
      "framesAnalyzed": framesAnalyzed,
      "framesWithPose": framesWithPose,
      "poseMisses": poseMisses,
      "poseErrorsOtherThanLowConfidence": poseErrorsOtherThanLowConfidence,
      "framesWithPeople": framesWithPeople,
      "maxPeopleInFrame": maxPeopleInFrame,
      "peopleHistogram": Dictionary(uniqueKeysWithValues: peopleHistogram.map { (String($0.key), $0.value) }),
      "primarySwitches": primarySwitches,
      "landmarksOutOfUnitRange": landmarksOutOfUnitRange,
      "maxLandmarkOvershoot": maxLandmarkOvershoot,
      "landmarksNonFinite": landmarksNonFinite,
      "confidenceOutOfRange": confidenceOutOfRange,
      "timestampsNonMonotonic": timestampsNonMonotonic,
      "trajectoryErrors": trajectoryErrors,
      "trajectoryCount": trajectoryCount,
      "wallMs": wallMs,
      "visionMsMin": perFrameVisionMs.min() ?? 0,
      "visionMsMax": perFrameVisionMs.max() ?? 0,
      "visionMsMean": perFrameVisionMs.isEmpty ? 0 : perFrameVisionMs.reduce(0, +) / perFrameVisionMs.count,
      "residentBytesBefore": Int(residentBytesBefore),
      "residentBytesPeak": Int(residentBytesPeak),
      "residentBytesGrowth": Int(residentBytesPeak) - Int(residentBytesBefore),
    ]
    if minPoseConfidence.isFinite { out["minPoseConfidence"] = minPoseConfidence }
    if maxPoseConfidence.isFinite { out["maxPoseConfidence"] = maxPoseConfidence }
    if let firstTimestampMs { out["firstTimestampMs"] = firstTimestampMs }
    if let lastTimestampMs { out["lastTimestampMs"] = lastTimestampMs }
    if let cancelledAfterFrames { out["cancelledAfterFrames"] = cancelledAfterFrames }
    if let lastError { out["lastError"] = lastError }
    return out
  }
}

enum AdversarialExtraction {
  /// Mirrors the per-frame loop of swing-lab `runExtract` (trajectory request
  /// on the sample buffer, `extractAllPoses`, then `extractPose` with the
  /// same monotonic-timestamp guard), with a frame stride / cap so real
  /// clips stay within a test budget, and a cancel token checked between
  /// frames — the only cancellation granularity the native pipeline offers.
  @available(macOS 13.0, iOS 16.0, *)
  static func run(
    url: URL,
    provider: ApplePoseProvider = ApplePoseProvider(),
    frameStride: Int = 1,
    maxAnalyzedFrames: Int = Int.max,
    includeTrajectories: Bool = true,
    cancelToken: AdversarialCancelToken? = nil,
    onFrameAnalyzed: ((Int) -> Void)? = nil
  ) async throws -> (reader: UprightFrameReaderMirror, stats: AdversarialExtractionStats) {
    let started = Date()
    var stats = AdversarialExtractionStats()
    stats.residentBytesBefore = AdversarialSupport.residentMemoryBytes()
    stats.residentBytesPeak = stats.residentBytesBefore
    let reader = try await UprightFrameReaderMirror(url: url)

    var trajectories = Set<UUID>()
    let trajectoryRequest = VNDetectTrajectoriesRequest(frameAnalysisSpacing: .zero, trajectoryLength: 6) { request, _ in
      for case let observation as VNTrajectoryObservation in request.results ?? [] {
        trajectories.insert(observation.uuid)
      }
    }
    trajectoryRequest.objectMinimumNormalizedRadius = 0.001
    trajectoryRequest.objectMaximumNormalizedRadius = 0.05

    var lastTimestampMs = Int.min
    var previousPrimaryMid: (x: Double, y: Double)?
    var decodedIndex = -1
    while let frame = reader.next() {
      decodedIndex += 1
      stats.framesDecoded += 1
      if let cancelToken, cancelToken.isCancelled {
        stats.cancelledAfterFrames = stats.framesAnalyzed
        reader.cancel()
        break
      }
      if stats.framesAnalyzed >= maxAnalyzedFrames {
        reader.cancel()
        break
      }
      if decodedIndex % max(1, frameStride) != 0 { continue }
      stats.framesAnalyzed += 1
      if frame.timestampMs <= lastTimestampMs { stats.timestampsNonMonotonic += 1 }
      if stats.firstTimestampMs == nil { stats.firstTimestampMs = frame.timestampMs }
      stats.lastTimestampMs = frame.timestampMs
      lastTimestampMs = max(lastTimestampMs, frame.timestampMs)

      let frameStarted = Date()
      if includeTrajectories {
        let handler = VNImageRequestHandler(cmSampleBuffer: frame.sample, orientation: .up, options: [:])
        do { try handler.perform([trajectoryRequest]) } catch { stats.trajectoryErrors += 1; stats.lastError = AdversarialSupport.describe(error) }
      }

      do {
        let everyone = try provider.extractAllPoses(pixelBuffer: frame.buffer, timestampMs: frame.timestampMs)
        stats.peopleHistogram[everyone.count, default: 0] += 1
        if !everyone.isEmpty { stats.framesWithPeople += 1 }
        stats.maxPeopleInFrame = max(stats.maxPeopleInFrame, everyone.count)
        for person in everyone { audit(person, into: &stats) }
      } catch {
        stats.poseErrorsOtherThanLowConfidence += 1
        stats.lastError = AdversarialSupport.describe(error)
      }

      do {
        let pose = try provider.extractPose(pixelBuffer: frame.buffer, timestampMs: frame.timestampMs)
        stats.framesWithPose += 1
        audit(pose, into: &stats)
        if let mid = torsoMid(pose) {
          if let previous = previousPrimaryMid, hypot(mid.x - previous.x, mid.y - previous.y) > 0.25 {
            stats.primarySwitches += 1
          }
          previousPrimaryMid = mid
        }
      } catch {
        stats.poseMisses += 1
        if !AdversarialSupport.isVisionFailureLowConfidence(error) {
          stats.poseErrorsOtherThanLowConfidence += 1
          stats.lastError = AdversarialSupport.describe(error)
        }
      }
      stats.perFrameVisionMs.append(Int(Date().timeIntervalSince(frameStarted) * 1000))
      stats.residentBytesPeak = max(stats.residentBytesPeak, AdversarialSupport.residentMemoryBytes())
      onFrameAnalyzed?(stats.framesAnalyzed)
    }
    stats.trajectoryCount = trajectories.count
    stats.wallMs = Int(Date().timeIntervalSince(started) * 1000)
    return (reader, stats)
  }

  /// Wire-contract audit shared by both pose paths: landmarks must be finite
  /// and inside the unit square (`normalized_image_top_left`), confidence in
  /// [0, 1] — the canonical pose-sequence parser rejects non-finite values.
  static func audit(_ pose: PoseFrame, into stats: inout AdversarialExtractionStats) {
    for landmark in pose.landmarks {
      if !landmark.x.isFinite || !landmark.y.isFinite || !landmark.visibility.isFinite {
        stats.landmarksNonFinite += 1
      } else if landmark.x < 0 || landmark.x > 1 || landmark.y < 0 || landmark.y > 1 {
        stats.landmarksOutOfUnitRange += 1
        let overshoot = max(max(-landmark.x, landmark.x - 1), max(-landmark.y, landmark.y - 1))
        stats.maxLandmarkOvershoot = max(stats.maxLandmarkOvershoot, overshoot)
      }
    }
    if !pose.confidence.isFinite || pose.confidence < 0 || pose.confidence > 1 {
      stats.confidenceOutOfRange += 1
    }
    if pose.confidence.isFinite {
      stats.minPoseConfidence = min(stats.minPoseConfidence, pose.confidence)
      stats.maxPoseConfidence = max(stats.maxPoseConfidence, pose.confidence)
    }
  }

  static func torsoMid(_ pose: PoseFrame) -> (x: Double, y: Double)? {
    func point(_ name: String) -> PoseLandmark? { pose.landmarks.first { $0.name == name } }
    guard let leftShoulder = point("left_shoulder"), let rightShoulder = point("right_shoulder"),
          let leftHip = point("left_hip"), let rightHip = point("right_hip")
    else { return nil }
    return (
      (leftShoulder.x + rightShoulder.x + leftHip.x + rightHip.x) / 4,
      (leftShoulder.y + rightShoulder.y + leftHip.y + rightHip.y) / 4
    )
  }
}
