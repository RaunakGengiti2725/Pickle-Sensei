import AVFoundation
import CryptoKit
import Foundation
import React
import RealityKit
import UIKit
import simd

private enum MotionReviewFailure: String, Error {
  case invalidArtifact = "invalid_artifact"
  case artifactDigest = "artifact_digest_mismatch"
  case invalidURI = "invalid_source_uri"
  case sourceDigest = "source_digest_mismatch"
  case sourceUnreadable = "source_unreadable"
  case sourceTiming = "source_timing_mismatch"
  case cancelled
}

private final class MotionReviewLoadTicket {
  private let lock = NSLock()
  private var cancelled = false

  func cancel() {
    lock.lock()
    cancelled = true
    lock.unlock()
  }

  func check() throws {
    lock.lock()
    let value = cancelled
    lock.unlock()
    if value { throw MotionReviewFailure.cancelled }
  }
}

private struct MotionReviewFrame {
  let frameIndex: Int
  let timestampMs: Double
  let pts: CMTime
  let segmentId: Int
  let status: String
  let joints: [String: SIMD3<Float>]
}

private struct MotionReviewDocument {
  let durationMs: Double
  let nominalFrameRate: Double
  let videoSha256: String
  let videoByteLength: Int
  let width: Int
  let height: Int
  let frames: [MotionReviewFrame]
  let scaleBasis: String

  func sampleIndex(at positionMs: Double) -> Int? {
    guard positionMs.isFinite, positionMs >= 0, positionMs <= durationMs else { return nil }
    var low = 0
    var high = frames.count
    while low < high {
      let mid = (low + high) / 2
      if frames[mid].timestampMs <= positionMs + 0.001 { low = mid + 1 }
      else { high = mid }
    }
    guard low > 0 else { return nil }
    let index = low - 1
    let frame = frames[index]
    let age = positionMs - frame.timestampMs
    if age <= 0.001 { return index }
    let holdMs: Double
    if index + 1 < frames.count {
      let next = frames[index + 1]
      if frame.status == "estimated" {
        guard next.status == "estimated", next.segmentId == frame.segmentId else { return nil }
      }
      holdMs = min(100, next.timestampMs - frame.timestampMs)
    } else {
      holdMs = min(100, 1000 / min(30, nominalFrameRate))
    }
    return age <= holdMs + 0.001 ? index : nil
  }
}

private struct MotionReviewSourceTimeline {
  static let maximumBuffers = 60_000
  static let maximumFrames = 14_401
  let durationMs: Double
  private(set) var times: [CMTime] = []
  private var bufferCount = 0

  init(durationMs: Double) { self.durationMs = durationMs }

  mutating func consume(sampleCount: Int, pts: CMTime) throws {
    guard bufferCount < Self.maximumBuffers else { throw MotionReviewFailure.sourceTiming }
    bufferCount += 1
    if sampleCount == 0 { return }
    guard sampleCount == 1, times.count < Self.maximumFrames,
      pts.isNumeric, pts.seconds.isFinite, pts.seconds >= 0,
      pts.seconds * 1000 <= durationMs + 0.001
    else { throw MotionReviewFailure.sourceTiming }
    times.append(pts)
  }
}

private struct MotionReviewSeekQueue {
  private(set) var active: CMTime?
  private(set) var pending: CMTime?

  mutating func offer(_ time: CMTime) {
    pending = active.map { CMTimeCompare($0, time) == 0 } == true ? nil : time
  }

  mutating func begin() -> CMTime? {
    guard active == nil, let pending else { return nil }
    active = pending
    self.pending = nil
    return pending
  }

  mutating func finish() { active = nil }
}

private enum MotionReviewDecoder {
  private static let jointNames: Set<String> = [
    "root", "spine", "center_shoulder", "center_head", "top_head",
    "left_shoulder", "left_elbow", "left_wrist", "right_shoulder", "right_elbow", "right_wrist",
    "left_hip", "left_knee", "left_ankle", "right_hip", "right_knee", "right_ankle",
  ]
  private static let statuses: Set<String> = ["estimated", "no_person", "multiple_people", "unavailable"]

  private static func object(_ value: Any?, _ keys: [String]) throws -> [String: Any] {
    guard let value = value as? [String: Any], Set(value.keys) == Set(keys) else {
      throw MotionReviewFailure.invalidArtifact
    }
    return value
  }

  static func number(_ value: Any?, _ min: Double, _ max: Double, integer: Bool = false) throws -> Double {
    guard let value = value as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID() else {
      throw MotionReviewFailure.invalidArtifact
    }
    let result = value.doubleValue
    guard result.isFinite, result >= min, result <= max, !integer || result.rounded() == result else {
      throw MotionReviewFailure.invalidArtifact
    }
    return result
  }

  private static func matrix(_ value: Any?, _ count: Int) throws {
    guard let values = value as? [Any], values.count == count else {
      throw MotionReviewFailure.invalidArtifact
    }
    for value in values { _ = try number(value, -1e6, 1e6) }
  }

  private static func matches(_ value: Any?, _ pattern: String) -> Bool {
    guard let string = value as? String else { return false }
    return string.range(of: pattern, options: .regularExpression) != nil
  }

  static func decode(json: String, digest: String, ticket: MotionReviewLoadTicket) throws -> MotionReviewDocument {
    guard json.utf8.count <= 8 * 1024 * 1024, matches(digest, "^[a-f0-9]{64}$") else {
      throw MotionReviewFailure.invalidArtifact
    }
    let data = Data(json.utf8)
    guard SHA256.hash(data: data).map({ String(format: "%02x", $0) }).joined() == digest else {
      throw MotionReviewFailure.artifactDigest
    }
    try ticket.check()
    let raw: Any
    do { raw = try JSONSerialization.jsonObject(with: data) }
    catch { throw MotionReviewFailure.invalidArtifact }
    let document = try object(raw, [
      "schemaVersion", "format", "role", "coordinateSystem", "axes", "units", "imageCoordinates",
      "uncertainty", "temporalProcessing", "source", "estimator", "frames",
    ])
    guard try number(document["schemaVersion"], 1, 1, integer: true) == 1,
      document["format"] as? String == "pickle.motion-3d.v1",
      document["role"] as? String == "reconstructed_estimate",
      document["coordinateSystem"] as? String == "vision_root_relative",
      document["axes"] as? String == "right_handed_y_up",
      document["units"] as? String == "vision_estimated_meters",
      document["imageCoordinates"] as? String == "normalized_image_top_left",
      document["uncertainty"] as? String == "uncalibrated",
      document["temporalProcessing"] as? String == "none"
    else { throw MotionReviewFailure.invalidArtifact }
    let source = try object(document["source"], [
      "captureId", "videoSha256", "videoByteLength", "width", "height", "durationMs", "nominalFrameRate",
      "preferredTransform", "orientationPolicy", "mirroring",
    ])
    guard matches(source["captureId"], "^[a-zA-Z0-9._:-]{1,128}$"),
      matches(source["videoSha256"], "^[a-f0-9]{64}$"),
      source["orientationPolicy"] as? String == "preferred_track_transform_applied",
      source["mirroring"] as? String == "as_encoded"
    else { throw MotionReviewFailure.invalidArtifact }
    let byteLength = try number(source["videoByteLength"], 1, 512 * 1024 * 1024, integer: true)
    let width = try number(source["width"], 1, 8192, integer: true)
    let height = try number(source["height"], 1, 8192, integer: true)
    let duration = try number(source["durationMs"], 1, 60_000)
    let fps = try number(source["nominalFrameRate"], 0.1, 240)
    try matrix(source["preferredTransform"], 6)
    let estimator = try object(document["estimator"], [
      "providerId", "revision", "osVersion", "modelAsset", "modelAssetSha256", "configurationVersion", "maxSampleRate",
    ])
    guard estimator["providerId"] as? String == "pose.apple-vision-3d",
      try number(estimator["revision"], 1, 1, integer: true) == 1,
      let osVersion = estimator["osVersion"] as? String, !osVersion.isEmpty, osVersion.utf16.count <= 128,
      estimator["modelAsset"] as? String == "os_managed", estimator["modelAssetSha256"] is NSNull,
      estimator["configurationVersion"] as? String == "apple-vision-3d-raw-1",
      try number(estimator["maxSampleRate"], 30, 30, integer: true) == 30,
      let rawFrames = document["frames"] as? [Any], !rawFrames.isEmpty, rawFrames.count <= 1800
    else { throw MotionReviewFailure.invalidArtifact }
    var frames: [MotionReviewFrame] = []
    frames.reserveCapacity(rawFrames.count)
    var lastEstimatedSegment = -1
    var gap = false
    var scales = Set<String>()
    for value in rawFrames {
      try ticket.check()
      let frame = try object(value, [
        "frameIndex", "timestampMs", "ptsValue", "ptsTimescale", "segmentId", "status", "observationConfidence",
        "height", "cameraOriginMatrix", "joints",
      ])
      let frameIndex = Int(try number(frame["frameIndex"], 0, 1_000_000, integer: true))
      let timestamp = try number(frame["timestampMs"], 0, duration)
      let ptsValue = try number(frame["ptsValue"], 0, 9_007_199_254_740_991, integer: true)
      let ptsTimescale = try number(frame["ptsTimescale"], 1, 1_000_000_000, integer: true)
      let segment = Int(try number(frame["segmentId"], 0, 1800, integer: true))
      guard abs(timestamp - ptsValue * 1000 / ptsTimescale) <= 0.0001,
        let status = frame["status"] as? String, statuses.contains(status),
        let rawJoints = frame["joints"] as? [Any], rawJoints.count <= jointNames.count
      else { throw MotionReviewFailure.invalidArtifact }
      if let previous = frames.last {
        guard timestamp > previous.timestampMs, frameIndex > previous.frameIndex, segment >= previous.segmentId else {
          throw MotionReviewFailure.invalidArtifact
        }
      }
      var joints: [String: SIMD3<Float>] = [:]
      for value in rawJoints {
        let joint = try object(value, ["name", "x", "y", "z", "imageX", "imageY", "confidence", "visibility2D"])
        guard let name = joint["name"] as? String, jointNames.contains(name), joints[name] == nil,
          joint["confidence"] is NSNull
        else { throw MotionReviewFailure.invalidArtifact }
        let x = try number(joint["x"], -100, 100)
        let y = try number(joint["y"], -100, 100)
        let z = try number(joint["z"], -100, 100)
        _ = try number(joint["imageX"], 0, 1)
        _ = try number(joint["imageY"], 0, 1)
        if !(joint["visibility2D"] is NSNull) { _ = try number(joint["visibility2D"], 0, 1) }
        joints[name] = SIMD3(Float(x), Float(y), Float(z))
      }
      if status == "estimated" {
        guard joints["root"] != nil, !gap || segment > lastEstimatedSegment else {
          throw MotionReviewFailure.invalidArtifact
        }
        _ = try number(frame["observationConfidence"], 0, 1)
        try matrix(frame["cameraOriginMatrix"], 16)
        let height = try object(frame["height"], ["meters", "source"])
        let meters = try number(height["meters"], 0.01, 100)
        guard let basis = height["source"] as? String,
          basis == "measured" || (basis == "reference" && abs(meters - 1.8) < 0.0001)
        else { throw MotionReviewFailure.invalidArtifact }
        scales.insert(basis)
        gap = false
        lastEstimatedSegment = segment
      } else {
        guard joints.isEmpty, frame["height"] is NSNull, frame["cameraOriginMatrix"] is NSNull,
          frame["observationConfidence"] is NSNull
        else { throw MotionReviewFailure.invalidArtifact }
        gap = true
      }
      frames.append(MotionReviewFrame(
        frameIndex: frameIndex, timestampMs: timestamp,
        pts: CMTime(value: Int64(ptsValue), timescale: Int32(ptsTimescale)),
        segmentId: segment, status: status, joints: joints
      ))
    }
    return MotionReviewDocument(
      durationMs: duration, nominalFrameRate: fps, videoSha256: source["videoSha256"] as! String,
      videoByteLength: Int(byteLength), width: Int(width), height: Int(height), frames: frames,
      scaleBasis: scales.count > 1 ? "mixed" : (scales.first ?? "unavailable")
    )
  }
}

private struct MotionReviewSource {
  let url: URL?
  let times: [CMTime]
  var state: String { url == nil ? "missing" : "verified" }
  var clock: String { url == nil ? "pose_only" : "video" }

  static func asset(at url: URL) -> AVURLAsset {
    AVURLAsset(url: url, options: [
      AVURLAssetPreferPreciseDurationAndTimingKey: true,
      AVURLAssetReferenceRestrictionsKey: AVAssetReferenceRestrictions.forbidAll.rawValue,
    ])
  }

  static func verify(uri: String, document: MotionReviewDocument, ticket: MotionReviewLoadTicket) throws -> MotionReviewSource {
    if uri.isEmpty { return MotionReviewSource(url: nil, times: document.frames.map(\.pts)) }
    guard let incoming = ClipMediaStore.fileURL(from: uri), incoming.isFileURL,
      incoming.host == nil || incoming.host == "" || incoming.host == "localhost",
      incoming.query == nil, incoming.fragment == nil,
      incoming.deletingLastPathComponent().lastPathComponent == "Captures",
      incoming.deletingLastPathComponent().deletingLastPathComponent().lastPathComponent == "PickleSensei",
      let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first,
      let resolved = ClipMediaStore.resolveCaptureURL(fromStoredUri: uri), resolved.isFileURL
    else { throw MotionReviewFailure.invalidURI }
    let root = support.appendingPathComponent("PickleSensei/Captures", isDirectory: true)
      .standardizedFileURL.resolvingSymlinksInPath()
    let url = resolved.standardizedFileURL.resolvingSymlinksInPath()
    guard url.deletingLastPathComponent() == root else {
      let privateSuffix = "/Library/Application Support/PickleSensei/Captures/"
      if incoming.path.contains(privateSuffix), !FileManager.default.fileExists(atPath: resolved.path) {
        return MotionReviewSource(url: nil, times: document.frames.map(\.pts))
      }
      throw MotionReviewFailure.invalidURI
    }
    guard FileManager.default.fileExists(atPath: url.path) else {
      return MotionReviewSource(url: nil, times: document.frames.map(\.pts))
    }
    let before: [FileAttributeKey: Any]
    do { before = try FileManager.default.attributesOfItem(atPath: url.path) }
    catch { throw MotionReviewFailure.sourceUnreadable }
    guard before[.type] as? FileAttributeType == .typeRegular,
      (before[.size] as? NSNumber)?.intValue == document.videoByteLength
    else { throw MotionReviewFailure.sourceDigest }
    let handle: FileHandle
    do { handle = try FileHandle(forReadingFrom: url) }
    catch { throw MotionReviewFailure.sourceUnreadable }
    defer { try? handle.close() }
    var hasher = SHA256()
    var total = 0
    while true {
      try ticket.check()
      let chunk: Data
      do { chunk = try handle.read(upToCount: 256 * 1024) ?? Data() }
      catch { throw MotionReviewFailure.sourceUnreadable }
      if chunk.isEmpty { break }
      total += chunk.count
      guard total <= document.videoByteLength else { throw MotionReviewFailure.sourceDigest }
      hasher.update(data: chunk)
    }
    guard total == document.videoByteLength,
      hasher.finalize().map({ String(format: "%02x", $0) }).joined() == document.videoSha256,
      let after = try? FileManager.default.attributesOfItem(atPath: url.path),
      (before[.modificationDate] as? Date) == (after[.modificationDate] as? Date),
      (before[.systemFileNumber] as? NSNumber) == (after[.systemFileNumber] as? NSNumber),
      (after[.size] as? NSNumber)?.intValue == total
    else { throw MotionReviewFailure.sourceDigest }
    try ticket.check()
    let asset = asset(at: url)
    let tracks = asset.tracks(withMediaType: .video)
    guard tracks.count == 1, asset.isPlayable, !asset.hasProtectedContent,
      asset.duration.seconds.isFinite,
      abs(asset.duration.seconds * 1000 - document.durationMs) <= 1
    else { throw MotionReviewFailure.sourceTiming }
    let track = tracks[0]
    let size = track.naturalSize.applying(track.preferredTransform)
    guard size.width.isFinite, size.height.isFinite,
      (1...8192).contains(abs(size.width)), (1...8192).contains(abs(size.height)),
      Int(abs(size.width).rounded()) == document.width, Int(abs(size.height).rounded()) == document.height else {
      throw MotionReviewFailure.sourceTiming
    }
    let reader: AVAssetReader
    do { reader = try AVAssetReader(asset: asset) }
    catch { throw MotionReviewFailure.sourceUnreadable }
    defer { reader.cancelReading() }
    let output = AVAssetReaderTrackOutput(track: track, outputSettings: nil)
    output.alwaysCopiesSampleData = false
    guard reader.canAdd(output) else { throw MotionReviewFailure.sourceUnreadable }
    reader.add(output)
    guard reader.startReading() else { throw MotionReviewFailure.sourceUnreadable }
    var timeline = MotionReviewSourceTimeline(durationMs: document.durationMs)
    while let sample = output.copyNextSampleBuffer() {
      try ticket.check()
      try timeline.consume(
        sampleCount: CMSampleBufferGetNumSamples(sample),
        pts: CMSampleBufferGetPresentationTimeStamp(sample)
      )
    }
    var times = timeline.times
    guard reader.status == .completed, !times.isEmpty else { throw MotionReviewFailure.sourceUnreadable }
    times.sort { CMTimeCompare($0, $1) < 0 }
    for index in times.indices where index > 0 {
      guard CMTimeCompare(times[index], times[index - 1]) > 0 else { throw MotionReviewFailure.sourceTiming }
    }
    for frame in document.frames {
      guard frame.frameIndex < times.count,
        abs(times[frame.frameIndex].seconds * 1000 - frame.timestampMs) <= 0.001
      else { throw MotionReviewFailure.sourceTiming }
    }
    return MotionReviewSource(url: url, times: times)
  }

  func floorIndex(at positionMs: Double) -> Int? {
    var low = 0
    var high = times.count
    while low < high {
      let mid = (low + high) / 2
      if times[mid].seconds * 1000 <= positionMs + 0.001 { low = mid + 1 }
      else { high = mid }
    }
    return low > 0 ? low - 1 : nil
  }

  func stepTime(at positionMs: Double, direction: Int) -> CMTime? {
    let current = floorIndex(at: positionMs)
    if direction > 0 {
      let next = (current ?? -1) + 1
      return next < times.count ? times[next] : nil
    }
    guard let current else { return nil }
    let index = abs(times[current].seconds * 1000 - positionMs) <= 0.001 ? current - 1 : current
    return index >= 0 ? times[index] : nil
  }
}

@available(iOS 17.0, *)
private final class MotionReviewSurface: NSObject, UIGestureRecognizerDelegate {
  let view = ARView(frame: .zero, cameraMode: .nonAR, automaticallyConfigureSession: false)
  private let anchor = AnchorEntity(world: .zero)
  private let camera = PerspectiveCamera()
  private let links: [(String, String, Float)] = [
    ("root", "spine", 0.19), ("spine", "center_shoulder", 0.20),
    ("center_shoulder", "center_head", 0.18),
    ("center_shoulder", "left_shoulder", 0.22), ("center_shoulder", "right_shoulder", 0.22),
    ("left_shoulder", "left_elbow", 0.12), ("left_elbow", "left_wrist", 0.09),
    ("right_shoulder", "right_elbow", 0.12), ("right_elbow", "right_wrist", 0.09),
    ("left_hip", "right_hip", 0.25),
    ("left_hip", "left_knee", 0.15), ("left_knee", "left_ankle", 0.10),
    ("right_hip", "right_knee", 0.15), ("right_knee", "right_ankle", 0.10),
  ]
  private var limbs: [ModelEntity] = []
  private var joints: [String: ModelEntity] = [:]
  private let torso: ModelEntity
  private let head: ModelEntity
  private var center = SIMD3<Float>.zero
  private var radius: Float = 1
  private var yaw: Float = -0.2
  private var pitch: Float = 0.08
  private var zoom: Float = 1

  init(document: MotionReviewDocument) {
    let mesh = MeshResource.generateSphere(radius: 1)
    let material = SimpleMaterial(
      color: UIColor(red: 248 / 255, green: 250 / 255, blue: 245 / 255, alpha: 1),
      roughness: 0.82, isMetallic: false
    )
    torso = ModelEntity(mesh: mesh, materials: [material])
    head = ModelEntity(mesh: mesh, materials: [material])
    super.init()
    view.environment.background = .color(UIColor(red: 7 / 255, green: 23 / 255, blue: 16 / 255, alpha: 1))
    view.renderOptions = [.disableMotionBlur, .disableDepthOfField, .disableCameraGrain, .disableAREnvironmentLighting]
    view.isAccessibilityElement = false
    view.accessibilityElementsHidden = true
    view.scene.addAnchor(anchor)
    anchor.addChild(camera)
    anchor.addChild(torso)
    anchor.addChild(head)
    for link in links {
      let model = ModelEntity(mesh: mesh, materials: [material])
      limbs.append(model)
      anchor.addChild(model)
      for name in [link.0, link.1] where joints[name] == nil {
        let joint = ModelEntity(mesh: mesh, materials: [material])
        joints[name] = joint
        anchor.addChild(joint)
      }
    }
    let key = DirectionalLight()
    key.light.intensity = 2400
    anchor.addChild(key)
    key.look(at: .zero, from: SIMD3(2, 3, 4), relativeTo: nil)
    let fill = DirectionalLight()
    fill.light.intensity = 700
    anchor.addChild(fill)
    fill.look(at: .zero, from: SIMD3(-3, 1, -2), relativeTo: nil)
    var minimum = SIMD3<Float>(repeating: .greatestFiniteMagnitude)
    var maximum = SIMD3<Float>(repeating: -.greatestFiniteMagnitude)
    var found = false
    for frame in document.frames where frame.status == "estimated" {
      for point in frame.joints.values {
        minimum = simd_min(minimum, point)
        maximum = simd_max(maximum, point)
        found = true
      }
    }
    if found {
      center = (minimum + maximum) / 2
      radius = max(0.05, simd_length(maximum - minimum) / 2) * 1.2
    }
    camera.camera.fieldOfViewInDegrees = 42
    let pan = UIPanGestureRecognizer(target: self, action: #selector(orbit(_:)))
    pan.maximumNumberOfTouches = 1
    pan.delegate = self
    let pinch = UIPinchGestureRecognizer(target: self, action: #selector(pinch(_:)))
    pinch.delegate = self
    view.addGestureRecognizer(pan)
    view.addGestureRecognizer(pinch)
    _ = render(nil)
    frameCamera()
  }

  func frameCamera() {
    let aspect = Float(max(1, view.bounds.width) / max(1, view.bounds.height))
    let vertical = Float.pi * 42 / 360
    let horizontal = atan(tan(vertical) * aspect)
    let distance = radius / max(0.05, sin(min(vertical, horizontal))) / zoom
    let direction = SIMD3<Float>(sin(yaw) * cos(pitch), sin(pitch), cos(yaw) * cos(pitch))
    camera.camera.near = max(0.001, distance * 0.001)
    camera.camera.far = max(10, distance + radius * 5)
    camera.look(at: center, from: center + direction * distance, relativeTo: nil)
  }

  func adjust(_ action: String) {
    switch action {
    case "turnLeft": yaw -= .pi / 8
    case "turnRight": yaw += .pi / 8
    case "zoomIn": zoom = min(2.5, zoom * 1.2)
    case "zoomOut": zoom = max(0.65, zoom / 1.2)
    case "reset": yaw = -0.2; pitch = 0.08; zoom = 1
    default: return
    }
    frameCamera()
  }

  @objc private func orbit(_ recognizer: UIPanGestureRecognizer) {
    let translation = recognizer.translation(in: view)
    recognizer.setTranslation(.zero, in: view)
    yaw -= Float(translation.x) * 0.008
    pitch = max(-1.2, min(1.2, pitch + Float(translation.y) * 0.008))
    frameCamera()
  }

  @objc private func pinch(_ recognizer: UIPinchGestureRecognizer) {
    guard recognizer.scale.isFinite, recognizer.scale > 0 else { return }
    zoom = max(0.65, min(2.5, zoom * Float(recognizer.scale)))
    recognizer.scale = 1
    frameCamera()
  }

  func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer) -> Bool {
    gestureRecognizer.view === view && otherGestureRecognizer.view === view
  }

  func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldBeRequiredToFailBy otherGestureRecognizer: UIGestureRecognizer) -> Bool {
    gestureRecognizer.view === view && otherGestureRecognizer.view is UIScrollView
  }

  @discardableResult
  func render(_ frame: MotionReviewFrame?) -> Bool {
    for model in limbs { model.isEnabled = false }
    for model in joints.values { model.isEnabled = false }
    torso.isEnabled = false
    head.isEnabled = false
    guard let frame, frame.status == "estimated" else { return false }
    let points = frame.joints
    var rendered = false
    for (index, link) in links.enumerated() {
      guard let a = points[link.0], let b = points[link.1] else { continue }
      let delta = b - a
      let length = simd_length(delta)
      guard length > 0.0001 else { continue }
      let thickness = length * link.2
      let model = limbs[index]
      model.position = (a + b) / 2
      model.orientation = simd_quatf(from: SIMD3(0, 1, 0), to: delta / length)
      model.scale = SIMD3(thickness, length / 2, thickness)
      model.isEnabled = true
      for (name, point) in [(link.0, a), (link.1, b)] {
        if let joint = joints[name] {
          let size = joint.isEnabled ? max(joint.scale.x, thickness * 0.72) : thickness * 0.72
          joint.position = point
          joint.scale = SIMD3(repeating: size)
          joint.isEnabled = true
        }
      }
      rendered = true
    }
    if let leftShoulder = points["left_shoulder"], let rightShoulder = points["right_shoulder"],
      let leftHip = points["left_hip"], let rightHip = points["right_hip"] {
      let top = (leftShoulder + rightShoulder) / 2
      let bottom = (leftHip + rightHip) / 2
      let delta = top - bottom
      let length = simd_length(delta)
      let width = max(simd_length(leftShoulder - rightShoulder), simd_length(leftHip - rightHip))
      if length > 0.0001, width > 0.0001 {
        let y = delta / length
        let across = leftShoulder - rightShoulder
        let projected = across - simd_dot(across, y) * y
        if simd_length(projected) > 0.0001 {
          let x = simd_normalize(projected)
          let z = simd_normalize(simd_cross(x, y))
          torso.orientation = simd_quatf(simd_float3x3(columns: (x, y, z)))
          torso.position = (top + bottom) / 2
          torso.scale = SIMD3(width * 0.57, length * 0.62, width * 0.31)
          torso.isEnabled = true
          rendered = true
        }
      }
    }
    if let center = points["center_head"], let top = points["top_head"] {
      let delta = top - center
      let length = simd_length(delta)
      if length > 0.0001 {
        head.position = center
        head.orientation = simd_quatf(from: SIMD3(0, 1, 0), to: delta / length)
        head.scale = SIMD3(length * 0.75, length, length * 0.85)
        head.isEnabled = true
        rendered = true
      }
    }
    return rendered
  }
}

private final class MotionReviewRecordingView: UIView {
  override static var layerClass: AnyClass { AVPlayerLayer.self }
  var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }
}

@available(iOS 17.0, *)
private final class MotionReviewDisplayTarget: NSObject {
  weak var owner: PickleMotionReviewView?
  @objc func tick(_ link: CADisplayLink) { owner?.tick(link) }
}

@available(iOS 17.0, *)
@objc(PickleMotionReviewView)
final class PickleMotionReviewView: UIView {
  @objc var artifactJson: NSString? { didSet { scheduleLoad() } }
  @objc var artifactSha256: NSString? { didSet { scheduleLoad() } }
  @objc var videoUri: NSString? { didSet { scheduleLoad() } }
  @objc var command: NSDictionary? { didSet { applyCommand() } }
  @objc var onReviewReady: RCTDirectEventBlock?
  @objc var onReviewProgress: RCTDirectEventBlock?
  @objc var onReviewError: RCTDirectEventBlock?

  private let player = AVPlayer()
  private let recording = MotionReviewRecordingView()
  private var surface: MotionReviewSurface?
  private var document: MotionReviewDocument?
  private var source: MotionReviewSource?
  private var displayLink: CADisplayLink?
  private var statusObservation: NSKeyValueObservation?
  private var observers: [NSObjectProtocol] = []
  private var ticket: MotionReviewLoadTicket?
  private var loadScheduled = false
  private var generation = 0
  private var activeJSON: String?
  private var activeDigest = ""
  private var activeURI: String?
  private var ready = false
  private var playing = false
  private var mode = "motion"
  private var rate: Double = 1
  private var positionMs: Double = 0
  private var basePositionMs: Double = 0
  private var baseHostTime: CFTimeInterval = 0
  private var lastEmission: CFTimeInterval = -.infinity
  private var progressPending = false
  private var lastCommandID: Double = -1
  private var seekGeneration = 0
  private var seeking = false
  private var resumeAfterSeek = false
  private var pendingSeekPositionMs: Double?
  private var seekQueue = MotionReviewSeekQueue()
  private var sampleIndex: Int?
  private var frameStatus = "gap"
  private var active = UIApplication.shared.applicationState == .active

  override init(frame: CGRect) {
    super.init(frame: frame)
    backgroundColor = UIColor(red: 7 / 255, green: 23 / 255, blue: 16 / 255, alpha: 1)
    clipsToBounds = true
    player.isMuted = true
    player.actionAtItemEnd = .pause
    recording.playerLayer.player = player
    recording.playerLayer.videoGravity = .resizeAspect
    recording.isHidden = true
    recording.isUserInteractionEnabled = false
    addSubview(recording)
    let target = MotionReviewDisplayTarget()
    target.owner = self
    let link = CADisplayLink(target: target, selector: #selector(MotionReviewDisplayTarget.tick(_:)))
    link.preferredFrameRateRange = CAFrameRateRange(minimum: 10, maximum: 60, preferred: 60)
    link.isPaused = true
    link.add(to: .main, forMode: .common)
    displayLink = link
    let center = NotificationCenter.default
    for name in [UIApplication.willResignActiveNotification, UIApplication.didEnterBackgroundNotification] {
      observers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
        guard let self else { return }
        self.pause()
        self.active = false
        self.updateTicker()
      })
    }
    observers.append(center.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
      guard let self else { return }
      self.active = true
      self.progressPending = true
      self.updateTicker()
    })
    observers.append(center.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: nil, queue: .main) { [weak self] notification in
      guard let self, let item = notification.object as? AVPlayerItem, item === self.player.currentItem else { return }
      self.pause()
    })
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

  deinit {
    ticket?.cancel()
    displayLink?.invalidate()
    statusObservation?.invalidate()
    for observer in observers { NotificationCenter.default.removeObserver(observer) }
    player.pause()
    player.replaceCurrentItem(with: nil)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    recording.frame = bounds
    surface?.view.frame = bounds
    surface?.frameCamera()
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window == nil { pause() }
    updateTicker()
  }

  private func scheduleLoad() {
    guard !loadScheduled else { return }
    loadScheduled = true
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      self.loadScheduled = false
      self.load()
    }
  }

  private func load() {
    guard let json = artifactJson as String?, let digest = artifactSha256 as String?, let uri = videoUri as String? else { return }
    guard activeJSON != json || activeDigest != digest || activeURI != uri else { return }
    ticket?.cancel()
    let loadTicket = MotionReviewLoadTicket()
    ticket = loadTicket
    generation += 1
    let currentGeneration = generation
    activeJSON = json
    activeDigest = digest
    activeURI = uri
    ready = false
    pause()
    seekGeneration += 1
    seeking = false
    pendingSeekPositionMs = nil
    seekQueue = MotionReviewSeekQueue()
    statusObservation?.invalidate()
    statusObservation = nil
    player.replaceCurrentItem(with: nil)
    surface?.view.removeFromSuperview()
    surface = nil
    recording.isHidden = true
    source = nil
    document = nil
    sampleIndex = nil
    frameStatus = "gap"
    positionMs = 0
    basePositionMs = 0
    rate = 1
    mode = "motion"
    lastCommandID = -1
    updateTicker()
    DispatchQueue.global(qos: .userInitiated).async { [weak self] in
      do {
        let document = try MotionReviewDecoder.decode(json: json, digest: digest, ticket: loadTicket)
        let source = try MotionReviewSource.verify(uri: uri, document: document, ticket: loadTicket)
        try loadTicket.check()
        DispatchQueue.main.async { [weak self] in
          guard let self, self.generation == currentGeneration else { return }
          self.install(document: document, source: source)
        }
      } catch {
        let failure = (error as? MotionReviewFailure) ?? .invalidArtifact
        guard failure != .cancelled else { return }
        DispatchQueue.main.async { [weak self] in
          guard let self, self.generation == currentGeneration else { return }
          self.fail(failure)
        }
      }
    }
  }

  private func install(document: MotionReviewDocument, source: MotionReviewSource) {
    self.document = document
    self.source = source
    let surface = MotionReviewSurface(document: document)
    self.surface = surface
    insertSubview(surface.view, belowSubview: recording)
    setNeedsLayout()
    if let url = source.url {
      let item = AVPlayerItem(asset: MotionReviewSource.asset(at: url))
      statusObservation = item.observe(\.status, options: [.initial, .new]) { [weak self] item, _ in
        DispatchQueue.main.async { [weak self, weak item] in
          guard let self, let item, item === self.player.currentItem else { return }
          switch item.status {
          case .readyToPlay: self.finishLoading()
          case .failed: self.fail(.sourceUnreadable)
          default: break
          }
        }
      }
      player.replaceCurrentItem(with: item)
    } else {
      finishLoading()
    }
  }

  private func finishLoading() {
    guard !ready, let document, let source else { return }
    ready = true
    onReviewReady?([
      "artifactSha256": activeDigest, "durationMs": document.durationMs, "frameCount": document.frames.count,
      "sourceState": source.state, "clock": source.clock, "scaleBasis": document.scaleBasis,
    ])
    refreshPosition()
    progressPending = true
    updateTicker()
  }

  private func fail(_ failure: MotionReviewFailure) {
    pause()
    ready = false
    seeking = false
    pendingSeekPositionMs = nil
    seekQueue = MotionReviewSeekQueue()
    seekGeneration += 1
    statusObservation?.invalidate()
    statusObservation = nil
    player.replaceCurrentItem(with: nil)
    _ = surface?.render(nil)
    recording.isHidden = true
    updateTicker()
    onReviewError?(["artifactSha256": activeDigest, "code": failure.rawValue])
  }

  private func applyCommand() {
    guard ready, let command, let id = try? MotionReviewDecoder.number(command["id"], 0, 9_007_199_254_740_991, integer: true),
      id > lastCommandID, let action = command["action"] as? String
    else { return }
    lastCommandID = id
    defer {
      progressPending = true
      updateTicker()
    }
    switch action {
    case "play":
      guard active, window != nil, let document else { pause(); return }
      if !seeking, positionMs >= document.durationMs - 0.001 { seek(to: .zero, resume: true) }
      else { startPlaying() }
    case "pause": pause()
    case "seek":
      guard let document, let value = try? MotionReviewDecoder.number(command["value"], 0, document.durationMs) else { return }
      let target: CMTime
      if let source, source.url != nil, let index = source.floorIndex(at: value) { target = source.times[index] }
      else { target = CMTime(seconds: value / 1000, preferredTimescale: 1_000_000) }
      seek(to: target)
    case "step":
      guard let direction = try? MotionReviewDecoder.number(command["value"], -1, 1, integer: true), direction != 0 else { return }
      pause()
      if let target = source?.stepTime(at: pendingSeekPositionMs ?? positionMs, direction: Int(direction)) { seek(to: target) }
    case "rate":
      guard let value = try? MotionReviewDecoder.number(command["value"], 0.25, 1), [0.25, 0.5, 1].contains(value) else { return }
      refreshPosition()
      basePositionMs = positionMs
      baseHostTime = CACurrentMediaTime()
      rate = value
      if playing, !seeking, source?.url != nil { player.rate = Float(rate) }
    case "motion":
      mode = "motion"
      surface?.view.isHidden = false
      recording.isHidden = true
    case "recording":
      guard source?.url != nil else { return }
      mode = "recording"
      surface?.view.isHidden = true
      recording.isHidden = seeking
    case "turnLeft", "turnRight", "zoomIn", "zoomOut", "reset":
      guard mode == "motion" else { return }
      surface?.adjust(action)
    default: return
    }
  }

  private func startPlaying() {
    guard ready, active, window != nil else { return }
    if seeking { playing = true; resumeAfterSeek = true; return }
    resumeAfterSeek = false
    basePositionMs = positionMs
    baseHostTime = CACurrentMediaTime()
    playing = true
    if source?.url != nil { player.rate = Float(rate) }
    progressPending = true
    updateTicker()
  }

  private func pause() {
    if ready { refreshPosition() }
    resumeAfterSeek = false
    playing = false
    player.pause()
    basePositionMs = positionMs
    progressPending = true
    updateTicker()
  }

  private func seek(to time: CMTime, resume: Bool = false) {
    pause()
    guard source?.url != nil else {
      positionMs = time.seconds * 1000
      basePositionMs = positionMs
      renderPosition()
      if resume { startPlaying() }
      return
    }
    seeking = true
    playing = resume
    resumeAfterSeek = resume
    pendingSeekPositionMs = time.seconds * 1000
    seekQueue.offer(time)
    _ = surface?.render(nil)
    recording.isHidden = true
    sampleIndex = nil
    frameStatus = "seeking"
    performPendingSeek()
    updateTicker()
  }

  private func performPendingSeek() {
    guard let time = seekQueue.begin() else { return }
    let currentSeek = seekGeneration
    player.seek(to: time, toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] finished in
      DispatchQueue.main.async { [weak self] in
        guard let self, self.ready, currentSeek == self.seekGeneration else { return }
        self.seekQueue.finish()
        guard finished else { self.fail(.sourceUnreadable); return }
        if self.seekQueue.pending != nil {
          self.performPendingSeek()
        } else {
          self.seeking = false
          self.pendingSeekPositionMs = nil
          self.refreshPosition()
          self.recording.isHidden = self.mode != "recording"
          if self.resumeAfterSeek { self.startPlaying() }
        }
        self.progressPending = true
        self.updateTicker()
      }
    }
  }

  private func refreshPosition() {
    guard let document, !seeking else { return }
    let value: Double
    if source?.url != nil {
      value = player.currentTime().seconds * 1000
    } else {
      value = playing ? basePositionMs + (CACurrentMediaTime() - baseHostTime) * 1000 * rate : basePositionMs
    }
    if value.isFinite { positionMs = max(0, min(document.durationMs, value)) }
    if positionMs >= document.durationMs {
      playing = false
      basePositionMs = positionMs
      player.pause()
    }
    renderPosition()
  }

  private func renderPosition() {
    guard let document else { return }
    let next = document.sampleIndex(at: positionMs)
    guard next != sampleIndex || frameStatus == "gap" || frameStatus == "seeking" else { return }
    sampleIndex = next
    let frame = next.map { document.frames[$0] }
    let visible = surface?.render(frame) ?? false
    frameStatus = frame?.status ?? "gap"
    if frameStatus == "estimated", !visible { frameStatus = "insufficient_joints" }
  }

  fileprivate func tick(_ link: CADisplayLink) {
    guard ready, active, window != nil else { updateTicker(); return }
    let wasPlaying = playing
    refreshPosition()
    if wasPlaying || playing || seeking { progressPending = true }
    let now = CACurrentMediaTime()
    if progressPending, now - lastEmission >= 0.1, let document, let source {
      lastEmission = now
      progressPending = false
      let frame = seeking ? nil : sampleIndex.map { document.frames[$0] }
      let sourceIndex = source.url == nil || seeking ? nil : source.floorIndex(at: positionMs)
      let requestedPosition = pendingSeekPositionMs ?? positionMs
      onReviewProgress?([
        "artifactSha256": activeDigest, "positionMs": requestedPosition, "durationMs": document.durationMs,
        "actualPositionMs": positionMs, "seeking": seeking, "commandId": lastCommandID,
        "jointCount": frame?.joints.count ?? 0,
        "playing": playing, "rate": rate, "mode": mode, "sourceState": source.state, "clock": source.clock,
        "canStepBackward": source.stepTime(at: requestedPosition, direction: -1) != nil,
        "canStepForward": source.stepTime(at: requestedPosition, direction: 1) != nil,
        "frameIndex": frame.map { $0.frameIndex as Any } ?? NSNull(),
        "poseTimestampMs": frame.map { $0.timestampMs as Any } ?? NSNull(),
        "sourceFrameIndex": sourceIndex.map { $0 as Any } ?? NSNull(), "frameStatus": frameStatus,
      ])
    }
    updateTicker()
  }

  private func updateTicker() {
    displayLink?.isPaused = !ready || !active || window == nil || (!playing && !seeking && !progressPending)
  }
}

@objc(PickleMotionReviewViewManager)
final class PickleMotionReviewViewManager: RCTViewManager {
  override func view() -> UIView! {
    if #available(iOS 17.0, *) { return PickleMotionReviewView() }
    return UIView()
  }

  override static func requiresMainQueueSetup() -> Bool { true }
}
