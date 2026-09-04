import AVFoundation
import CoreGraphics
import CoreImage
import Foundation
import PickleVisionCore
import Vision

/// swing-lab — the desktop research harness for the perception pipeline.
///
/// `extract`  Runs the SAME ApplePoseProvider the phone uses over every frame
///            of a video file and writes the canonical pose-sequence wire
///            format (`pickle.pose-sequence.v1`) plus Apple Vision trajectory
///            ball candidates. No scoring happens here; this is measurement.
/// `overlay`  Renders a debug video: skeleton, wrist trail, ball candidates,
///            stroke window, contact marker, and phase band from an analysis
///            debug JSON, so every claim the pipeline makes can be checked
///            against the actual footage frame by frame.
///
/// Honesty notes, encoded in the artifacts rather than prose:
/// - Trajectory points are timed by linear interpolation across the
///   observation's time range (`pointTiming` field says so); Apple does not
///   expose per-point timestamps.
/// - Trajectories assume a mostly stationary camera; the JSON records that
///   assumption (`cameraAssumption`) so downstream fusion can gate on it.

// MARK: - Entry

let arguments = Array(CommandLine.arguments.dropFirst())

func usage() -> Never {
  FileHandle.standardError.write(Data("""
  usage:
    swing-lab extract <video> --out <dir>
    swing-lab overlay <video> --pose <pose.json> [--analysis <debug.json>] --out <file.mp4>
    swing-lab frame <video> --ms <timestamp> --out <file.png>

  """.utf8))
  exit(2)
}

func flagValue(_ name: String, in args: [String]) -> String? {
  guard let index = args.firstIndex(of: name), index + 1 < args.count else { return nil }
  return args[index + 1]
}

// NOTE: the actual command dispatch lives at the BOTTOM of this file. In a
// main.swift, top-level statements run in file order and globals declared
// below the executing statement are still uninitialized — dispatching from
// here once crashed the overlay renderer by reading `skeletonEdges` before
// its initialization.

// MARK: - Upright frame reader

/// Reads video frames with the track's preferredTransform applied, so both
/// pose extraction and overlay rendering operate on upright pixels — the same
/// orientation contract the phone capture path guarantees.
struct UprightVideoReader {
  let reader: AVAssetReader
  let output: AVAssetReaderVideoCompositionOutput
  let width: Int
  let height: Int
  let fps: Double
  let durationMs: Int

  init(url: URL) async throws {
    let asset = AVURLAsset(url: url)
    guard let track = try await asset.loadTracks(withMediaType: .video).first else {
      throw NSError(domain: "swing-lab", code: 1, userInfo: [NSLocalizedDescriptionKey: "no video track in \(url.path)"])
    }
    let composition = try await AVMutableVideoComposition.videoComposition(withPropertiesOf: asset)
    let renderSize = composition.renderSize
    let duration = try await asset.load(.duration)
    let nominalFps = try await track.load(.nominalFrameRate)

    let reader = try AVAssetReader(asset: asset)
    let output = AVAssetReaderVideoCompositionOutput(
      videoTracks: [track],
      videoSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
    )
    output.videoComposition = composition
    output.alwaysCopiesSampleData = false
    guard reader.canAdd(output) else {
      throw NSError(domain: "swing-lab", code: 2, userInfo: [NSLocalizedDescriptionKey: "cannot read \(url.path)"])
    }
    reader.add(output)
    guard reader.startReading() else {
      throw reader.error ?? NSError(domain: "swing-lab", code: 3, userInfo: [NSLocalizedDescriptionKey: "startReading failed"])
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
}

/// Frame timing measured from the presentation timestamps the reader actually
/// delivered. `AVAssetTrack.nominalFrameRate` and `AVAsset.duration` are
/// container claims; for some containers (the committed fragmented AV1 CI clip)
/// AVFoundation reports both at half the decoded cadence. Downstream code
/// sizes its gap thresholds from `video.fps` and its clip end from
/// `durationMs`, so the artifacts must describe the decoded frames.
struct DecodedTiming {
  private(set) var timestampsMs: [Int] = []

  mutating func record(_ timestampMs: Int) {
    timestampsMs.append(timestampMs)
  }

  var frameCount: Int { timestampsMs.count }
  var firstPtsMs: Int? { timestampsMs.min() }
  var lastPtsMs: Int? { timestampsMs.max() }

  /// Median inter-frame interval; nil with fewer than two frames.
  var medianFrameMs: Int? {
    let sorted = timestampsMs.sorted()
    guard sorted.count >= 2 else { return nil }
    let deltas = zip(sorted, sorted.dropFirst()).map { $0.1 - $0.0 }.sorted()
    let middle = deltas.count / 2
    return deltas.count % 2 == 0 ? (deltas[middle - 1] + deltas[middle]) / 2 : deltas[middle]
  }

  /// Mean cadence over the decoded span, (n - 1) / (last - first); nil when
  /// fewer than two distinct timestamps were decoded.
  var fps: Double? {
    guard let first = firstPtsMs, let last = lastPtsMs, last > first, frameCount >= 2 else { return nil }
    return Double(frameCount - 1) * 1000 / Double(last - first)
  }

  /// End of the last decoded frame: its PTS plus one median frame interval.
  var durationMs: Int? {
    guard let last = lastPtsMs, let frame = medianFrameMs else { return nil }
    return last + frame
  }
}

/// Relative disagreement between a container claim and a decoded measurement.
func relativeError(_ claimed: Double, _ measured: Double) -> Double {
  guard measured != 0 else { return claimed == 0 ? 0 : .infinity }
  return abs(claimed - measured) / abs(measured)
}

func roundedFps(_ fps: Double) -> Double {
  (fps * 1000).rounded() / 1000
}

// MARK: - extract

func runExtract(videoPath: String, outDir: String) async throws {
  let started = Date()
  let videoURL = URL(fileURLWithPath: videoPath)
  try FileManager.default.createDirectory(atPath: outDir, withIntermediateDirectories: true)

  let readerBox = try await UprightVideoReader(url: videoURL)
  let pose = ApplePoseProvider()

  // Ball candidates: Apple Vision trajectory detection, tuned for a small
  // ball (max radius excludes people/paddles). Stateful request fed with the
  // reader's own timed sample buffers.
  var trajectories: [UUID: VNTrajectoryObservation] = [:]
  let trajectoryRequest = VNDetectTrajectoriesRequest(
    frameAnalysisSpacing: .zero,
    trajectoryLength: 6
  ) { request, _ in
    for case let observation as VNTrajectoryObservation in request.results ?? [] {
      trajectories[observation.uuid] = observation // keep latest (longest) per id
    }
  }
  trajectoryRequest.objectMinimumNormalizedRadius = 0.001
  trajectoryRequest.objectMaximumNormalizedRadius = 0.05

  var frames: [[String: Any]] = []
  var peopleFrames: [[String: Any]] = []
  var frameIndex = 0
  var framesSeen = 0
  var poseMisses = 0
  var lastTimestampMs = Int.min
  var decoded = DecodedTiming()

  // SCENE VALIDITY: a coarse luma histogram per frame; large chi-square
  // distance between consecutive frames = shot boundary. Analysis must never
  // cross a cut (regression: SCENE_CUT_UNDETECTED-afn-vic-rally1, where a
  // whiteboard interview scene produced a "ball track" and a "contact").
  var previousHistogram: [Double]? = nil
  var sceneCuts: [Int] = []
  var sceneScores: [[String: Any]] = []

  while let frame = readerBox.next() {
    framesSeen += 1
    decoded.record(frame.timestampMs)
    if let histogram = lumaHistogram(frame.buffer) {
      if let previous = previousHistogram {
        var distance = 0.0
        for index in 0..<histogram.count {
          let sum = histogram[index] + previous[index]
          if sum > 1e-9 {
            let difference = histogram[index] - previous[index]
            distance += (difference * difference) / sum
          }
        }
        sceneScores.append(["t": frame.timestampMs, "d": Double(round(1000 * distance) / 1000)])
        if distance > 0.35 { sceneCuts.append(frame.timestampMs) }
      }
      previousHistogram = histogram
    }
    let handler = VNImageRequestHandler(cmSampleBuffer: frame.sample, orientation: .up, options: [:])
    try? handler.perform([trajectoryRequest])

    // Guard strict monotonicity — the canonical parser rejects violations.
    guard frame.timestampMs > lastTimestampMs else { continue }
    // ALL people in frame (largest torso first) — research player tracking.
    let everyone = (try? pose.extractAllPoses(pixelBuffer: frame.buffer, timestampMs: frame.timestampMs)) ?? []
    if !everyone.isEmpty {
      peopleFrames.append([
        "t": frame.timestampMs,
        "p": everyone.map { person in
          [
            "c": person.confidence,
            "l": person.landmarks.map { ["n": $0.name, "x": $0.x, "y": $0.y, "v": $0.visibility] },
          ] as [String: Any]
        },
      ])
    }
    do {
      let poseFrame = try pose.extractPose(pixelBuffer: frame.buffer, timestampMs: frame.timestampMs)
      frames.append([
        "i": frameIndex,
        "t": poseFrame.timestampMs,
        "c": poseFrame.confidence,
        "l": poseFrame.landmarks.map { ["n": $0.name, "x": $0.x, "y": $0.y, "v": $0.visibility] },
      ])
      frameIndex += 1
      lastTimestampMs = frame.timestampMs
    } catch {
      poseMisses += 1
    }
  }

  // Video timing comes from the decoded frames; the container's claims are
  // only the fallback when fewer than two frames were decoded, and are kept
  // in extract-meta.json under `container` so disagreements stay visible.
  let videoFps: Double
  let videoDurationMs: Int
  let timingSource: String
  if let measuredFps = decoded.fps, let measuredDurationMs = decoded.durationMs {
    videoFps = roundedFps(measuredFps)
    videoDurationMs = measuredDurationMs
    timingSource = "decoded_pts"
    let fpsError = relativeError(readerBox.fps, measuredFps)
    let durationError = relativeError(Double(readerBox.durationMs), Double(measuredDurationMs))
    if fpsError > 0.10 || durationError > 0.10 {
      let warning = "extract: container timing disagrees with decoded frames: "
        + "nominalFrameRate \(readerBox.fps) vs decoded \(videoFps) fps, "
        + "duration \(readerBox.durationMs) ms vs decoded \(measuredDurationMs) ms; "
        + "artifacts carry the decoded values\n"
      FileHandle.standardError.write(Data(warning.utf8))
    }
  } else {
    videoFps = readerBox.fps
    videoDurationMs = readerBox.durationMs
    timingSource = "container"
  }

  let poseWire: [String: Any] = [
    "schemaVersion": 1,
    "format": "pickle.pose-sequence.v1",
    "coordinateSystem": "normalized_image_top_left",
    "poseModelVersion": pose.modelVersion,
    "video": ["w": readerBox.width, "h": readerBox.height, "fps": videoFps],
    "frames": frames,
  ]
  // Segment the clip into shots from the detected cuts.
  var segments: [[String: Any]] = []
  var segmentStart = 0
  for cut in sceneCuts {
    segments.append(["startMs": segmentStart, "endMs": cut])
    segmentStart = cut
  }
  segments.append(["startMs": segmentStart, "endMs": videoDurationMs])
  try writeJSON(
    [
      "schemaVersion": 1,
      "detector": "luma-histogram-chi2-1 (threshold 0.35, deterministic)",
      "cuts": sceneCuts,
      "segments": segments,
      "scores": sceneScores,
    ],
    to: "\(outDir)/scenes.json"
  )
  try writeJSON(poseWire, to: "\(outDir)/pose.json")
  try writeJSON(
    [
      "schemaVersion": 1,
      "poseModelVersion": pose.modelVersion,
      "video": ["w": readerBox.width, "h": readerBox.height, "fps": videoFps],
      "frames": peopleFrames,
    ],
    to: "\(outDir)/people.json"
  )

  // Ball candidates with y flipped to top-left to match the pose contract.
  let trajectoryJSON: [[String: Any]] = trajectories.values
    .sorted { $0.timeRange.start.seconds < $1.timeRange.start.seconds }
    .map { observation in
      let startMs = Int((observation.timeRange.start.seconds * 1000).rounded())
      let endMs = Int((observation.timeRange.end.seconds * 1000).rounded())
      let points = observation.detectedPoints
      let span = max(1, points.count - 1)
      return [
        "id": observation.uuid.uuidString,
        "startMs": startMs,
        "endMs": endMs,
        "confidence": Double(observation.confidence),
        "points": points.enumerated().map { index, point in
          [
            "t": startMs + (endMs - startMs) * index / span,
            "x": Double(point.x),
            "y": 1.0 - Double(point.y),
          ] as [String: Any]
        },
      ]
    }
  try writeJSON(
    [
      "source": "apple-vision-trajectories-1",
      "cameraAssumption": "stationary",
      "pointTiming": "linear_over_time_range",
      "trajectories": trajectoryJSON,
    ],
    to: "\(outDir)/ball.json"
  )

  var decodedJSON: [String: Any] = ["frames": decoded.frameCount]
  if let first = decoded.firstPtsMs { decodedJSON["firstPtsMs"] = first }
  if let last = decoded.lastPtsMs { decodedJSON["lastPtsMs"] = last }
  if let frame = decoded.medianFrameMs { decodedJSON["medianFrameMs"] = frame }
  try writeJSON(
    [
      "video": ["path": videoPath, "w": readerBox.width, "h": readerBox.height,
                "nominalFps": videoFps, "durationMs": videoDurationMs, "timingSource": timingSource],
      "container": ["nominalFps": readerBox.fps, "durationMs": readerBox.durationMs],
      "decoded": decodedJSON,
      "framesSeen": framesSeen,
      "framesWithPose": frames.count,
      "poseMisses": poseMisses,
      "trajectoryCount": trajectoryJSON.count,
      "poseModelVersion": pose.modelVersion,
      "wallTimeMs": Int(Date().timeIntervalSince(started) * 1000),
    ],
    to: "\(outDir)/extract-meta.json"
  )
  print("extract: \(frames.count)/\(framesSeen) frames with pose, \(trajectoryJSON.count) ball trajectories -> \(outDir)")
}

func writeJSON(_ object: [String: Any], to path: String) throws {
  let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
  try data.write(to: URL(fileURLWithPath: path))
}

// MARK: - frame (debug still)

/// 32-bin normalized luma histogram from a subsampled BGRA buffer.
func lumaHistogram(_ buffer: CVPixelBuffer) -> [Double]? {
  CVPixelBufferLockBaseAddress(buffer, .readOnly)
  defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
  guard let base = CVPixelBufferGetBaseAddress(buffer) else { return nil }
  let width = CVPixelBufferGetWidth(buffer)
  let height = CVPixelBufferGetHeight(buffer)
  let bytesPerRow = CVPixelBufferGetBytesPerRow(buffer)
  let pointer = base.assumingMemoryBound(to: UInt8.self)
  var histogram = [Double](repeating: 0, count: 32)
  var samples = 0.0
  let step = max(1, min(width, height) / 96)
  for y in stride(from: 0, to: height, by: step) {
    for x in stride(from: 0, to: width, by: step) {
      let offset = y * bytesPerRow + x * 4
      let blue = Double(pointer[offset])
      let green = Double(pointer[offset + 1])
      let red = Double(pointer[offset + 2])
      let luma = 0.299 * red + 0.587 * green + 0.114 * blue
      histogram[min(31, Int(luma / 8))] += 1
      samples += 1
    }
  }
  guard samples > 0 else { return nil }
  return histogram.map { $0 / samples }
}

func runFrame(videoPath: String, ms: Int, outPath: String) async throws {
  let readerBox = try await UprightVideoReader(url: URL(fileURLWithPath: videoPath))
  let ciContext = CIContext()
  while let frame = readerBox.next() {
    guard frame.timestampMs >= ms else { continue }
    let image = CIImage(cvPixelBuffer: frame.buffer)
    guard let cg = ciContext.createCGImage(image, from: image.extent) else { break }
    let url = URL(fileURLWithPath: outPath) as CFURL
    guard let destination = CGImageDestinationCreateWithURL(url, "public.png" as CFString, 1, nil) else { break }
    CGImageDestinationAddImage(destination, cg, nil)
    CGImageDestinationFinalize(destination)
    print("frame @\(frame.timestampMs)ms -> \(outPath)")
    return
  }
  throw NSError(domain: "swing-lab", code: 5, userInfo: [NSLocalizedDescriptionKey: "no frame at \(ms)ms"])
}

// MARK: - overlay

struct PaddleOverlayObservation {
  let t: Int
  let x: Double
  let y: Double
  let w: Double
  let h: Double
  let conf: Double
}

struct BallOverlayObservation {
  let t: Int
  let x: Double
  let y: Double
  let conf: Double
}

struct ContactOverlayInfo {
  let tMs: Int
  let confidence: Double
  let ballConfirmed: Bool
  let paddleConfirmed: Bool
  let evidence: [String]
}

struct OverlayData {
  var frames: [(t: Int, confidence: Double, joints: [String: (x: Double, y: Double, v: Double)])] = []
  var ballPoints: [(t: Int, x: Double, y: Double)] = []
  var windowStartMs: Int?
  var windowEndMs: Int?
  var contactMs: Int?
  var phases: [(name: String, startMs: Int, endMs: Int)] = []
  var qualityReasons: [String] = []
  var analyzable: Bool?
  var scoreLabel: String?
  var paddleTrackId: Int?
  var paddleObservations: [PaddleOverlayObservation] = []
  var ballTrackId: Int?
  var ballObservations: [BallOverlayObservation] = []
  var contactInfo: ContactOverlayInfo?
  var strokeLabel: String?
  var strokeConfidence: Double?
  var strokeDepth: Int?
  var targetPlayerId: Int?
  var playerTracks: [(id: Int, points: [(t: Int, x: Double, y: Double)])] = []
  var ballStates: [(state: String, fromMs: Int, toMs: Int)] = []
  var ballBridge: [(t: Int, x: Double, y: Double)] = []
  var strokeEvents: [(id: String, startMs: Int, endMs: Int, peakMs: Int)] = []
  var targetEventId: String?
}

let skeletonEdges: [(String, String)] = [
  ("head", "left_shoulder"), ("head", "right_shoulder"),
  ("left_shoulder", "right_shoulder"),
  ("left_shoulder", "left_elbow"), ("left_elbow", "left_wrist"),
  ("right_shoulder", "right_elbow"), ("right_elbow", "right_wrist"),
  ("left_shoulder", "left_hip"), ("right_shoulder", "right_hip"),
  ("left_hip", "right_hip"),
  ("left_hip", "left_knee"), ("left_knee", "left_ankle"),
  ("right_hip", "right_knee"), ("right_knee", "right_ankle"),
]

func loadOverlayData(posePath: String, analysisPath: String?) throws -> OverlayData {
  var data = OverlayData()
  let poseRaw = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: posePath))) as? [String: Any]
  for frame in poseRaw?["frames"] as? [[String: Any]] ?? [] {
    guard let t = frame["t"] as? Int else { continue }
    var joints: [String: (x: Double, y: Double, v: Double)] = [:]
    for mark in frame["l"] as? [[String: Any]] ?? [] {
      guard let name = mark["n"] as? String,
            let x = mark["x"] as? Double, let y = mark["y"] as? Double
      else { continue }
      joints[name] = (x, y, mark["v"] as? Double ?? 0)
    }
    data.frames.append((t, frame["c"] as? Double ?? 0, joints))
  }
  guard let analysisPath else { return data }
  let analysis = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: analysisPath))) as? [String: Any]
  if let window = analysis?["window"] as? [String: Any] {
    data.windowStartMs = window["startMs"] as? Int
    data.windowEndMs = window["endMs"] as? Int
    data.contactMs = window["contactMs"] as? Int
  }
  for phase in analysis?["phases"] as? [[String: Any]] ?? [] {
    if let name = phase["phase"] as? String, let start = phase["startMs"] as? Int, let end = phase["endMs"] as? Int {
      data.phases.append((name, start, end))
    }
  }
  if let quality = analysis?["quality"] as? [String: Any] {
    data.analyzable = quality["analyzable"] as? Bool
    data.qualityReasons = quality["reasons"] as? [String] ?? []
  }
  data.scoreLabel = analysis?["scoreLabel"] as? String
  for point in analysis?["ballPoints"] as? [[String: Any]] ?? [] {
    if let t = point["t"] as? Int, let x = point["x"] as? Double, let y = point["y"] as? Double {
      data.ballPoints.append((t, x, y))
    }
  }
  if let paddle = analysis?["paddle"] as? [String: Any] {
    data.paddleTrackId = paddle["trackId"] as? Int
    for observation in paddle["observations"] as? [[String: Any]] ?? [] {
      guard let t = observation["t"] as? Int,
            let x = observation["x"] as? Double,
            let y = observation["y"] as? Double,
            let w = observation["w"] as? Double,
            let h = observation["h"] as? Double
      else { continue }
      data.paddleObservations.append(
        PaddleOverlayObservation(t: t, x: x, y: y, w: w, h: h, conf: observation["conf"] as? Double ?? 0)
      )
    }
  }
  if let ball = analysis?["ballTrack"] as? [String: Any] {
    data.ballTrackId = ball["trackId"] as? Int
    for observation in ball["observations"] as? [[String: Any]] ?? [] {
      guard let t = observation["t"] as? Int,
            let x = observation["x"] as? Double,
            let y = observation["y"] as? Double
      else { continue }
      data.ballObservations.append(
        BallOverlayObservation(t: t, x: x, y: y, conf: observation["conf"] as? Double ?? 0)
      )
    }
  }
  if let contact = analysis?["contactInfo"] as? [String: Any],
     let tMs = contact["tMs"] as? Int {
    data.contactInfo = ContactOverlayInfo(
      tMs: tMs,
      confidence: contact["confidence"] as? Double ?? 0,
      ballConfirmed: contact["ballConfirmed"] as? Bool ?? false,
      paddleConfirmed: contact["paddleConfirmed"] as? Bool ?? false,
      evidence: contact["evidence"] as? [String] ?? []
    )
  }
  if let stroke = analysis?["strokePrediction"] as? [String: Any] {
    data.strokeLabel = stroke["label"] as? String
    data.strokeConfidence = stroke["confidence"] as? Double
    data.strokeDepth = stroke["depth"] as? Int
  }
  if let players = analysis?["players"] as? [String: Any] {
    data.targetPlayerId = players["targetId"] as? Int
    for track in players["tracks"] as? [[String: Any]] ?? [] {
      guard let id = track["id"] as? Int else { continue }
      let points = (track["points"] as? [[String: Any]] ?? []).compactMap {
        point -> (t: Int, x: Double, y: Double)? in
        guard let t = point["t"] as? Int, let x = point["x"] as? Double, let y = point["y"] as? Double
        else { return nil }
        return (t, x, y)
      }
      data.playerTracks.append((id, points))
    }
  }
  if let events = analysis?["events"] as? [String: Any] {
    data.targetEventId = events["target"] as? String
    for event in events["list"] as? [[String: Any]] ?? [] {
      guard let id = event["id"] as? String,
            let startMs = event["startMs"] as? Int,
            let endMs = event["endMs"] as? Int,
            let peakMs = event["peakMs"] as? Int else { continue }
      data.strokeEvents.append((id, startMs, endMs, peakMs))
    }
  }
  if let timeline = analysis?["ballTimeline"] as? [String: Any] {
    for span in timeline["states"] as? [[String: Any]] ?? [] {
      guard let state = span["state"] as? String,
            let fromMs = span["fromMs"] as? Int,
            let toMs = span["toMs"] as? Int else { continue }
      data.ballStates.append((state, fromMs, toMs))
    }
    for point in timeline["bridge"] as? [[String: Any]] ?? [] {
      guard let t = point["t"] as? Int, let x = point["x"] as? Double, let y = point["y"] as? Double
      else { continue }
      data.ballBridge.append((t, x, y))
    }
  }
  return data
}

func runOverlay(videoPath: String, posePath: String, analysisPath: String?, outPath: String) async throws {
  let overlay = try loadOverlayData(posePath: posePath, analysisPath: analysisPath)
  let readerBox = try await UprightVideoReader(url: URL(fileURLWithPath: videoPath))
  let width = readerBox.width
  let height = readerBox.height

  let outURL = URL(fileURLWithPath: outPath)
  try? FileManager.default.removeItem(at: outURL)
  let writer = try AVAssetWriter(outputURL: outURL, fileType: .mp4)
  let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
    AVVideoCodecKey: AVVideoCodecType.h264,
    AVVideoWidthKey: width,
    AVVideoHeightKey: height,
  ])
  input.expectsMediaDataInRealTime = false
  let adaptor = AVAssetWriterInputPixelBufferAdaptor(
    assetWriterInput: input,
    sourcePixelBufferAttributes: [
      kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
      kCVPixelBufferWidthKey as String: width,
      kCVPixelBufferHeightKey as String: height,
    ]
  )
  writer.add(input)
  guard writer.startWriting() else { throw writer.error ?? NSError(domain: "swing-lab", code: 4) }
  writer.startSession(atSourceTime: .zero)

  let ciContext = CIContext(options: [.useSoftwareRenderer: false])
  var wristTrail: [(x: Double, y: Double)] = []
  var written = 0

  while let frame = readerBox.next() {
    while !input.isReadyForMoreMediaData {
      try await Task.sleep(nanoseconds: 2_000_000)
    }
    guard let pool = adaptor.pixelBufferPool else { break }
    var poolBuffer: CVPixelBuffer?
    CVPixelBufferPoolCreatePixelBuffer(nil, pool, &poolBuffer)
    guard let target = poolBuffer else { break }

    ciContext.render(CIImage(cvPixelBuffer: frame.buffer), to: target)

    CVPixelBufferLockBaseAddress(target, [])
    if let base = CVPixelBufferGetBaseAddress(target),
       let ctx = CGContext(
         data: base,
         width: width,
         height: height,
         bitsPerComponent: 8,
         bytesPerRow: CVPixelBufferGetBytesPerRow(target),
         space: CGColorSpaceCreateDeviceRGB(),
         bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue
       ) {
      // Flip so we can draw in top-left normalized coordinates directly.
      ctx.translateBy(x: 0, y: CGFloat(height))
      ctx.scaleBy(x: 1, y: -1)
      drawAnnotations(
        ctx: ctx, overlay: overlay, timestampMs: frame.timestampMs,
        width: CGFloat(width), height: CGFloat(height), wristTrail: &wristTrail
      )
    }
    CVPixelBufferUnlockBaseAddress(target, [])

    let pts = CMTime(value: CMTimeValue(frame.timestampMs), timescale: 1000)
    adaptor.append(target, withPresentationTime: pts)
    written += 1
  }

  input.markAsFinished()
  await writer.finishWriting()
  print("overlay: wrote \(written) frames -> \(outPath)")
}

/// Draws text into the flipped (top-left origin) context by locally
/// unflipping, so glyphs render upright.
func drawLabel(_ ctx: CGContext, _ text: String, at point: CGPoint, size: CGFloat, color: CGColor) {
  let font = CTFontCreateWithName("Menlo-Bold" as CFString, size, nil)
  let attributed = NSAttributedString(string: text, attributes: [
    NSAttributedString.Key(kCTFontAttributeName as String): font,
    NSAttributedString.Key(kCTForegroundColorAttributeName as String): color,
  ])
  let line = CTLineCreateWithAttributedString(attributed)
  ctx.saveGState()
  ctx.translateBy(x: point.x, y: point.y + size)
  ctx.scaleBy(x: 1, y: -1)
  ctx.textPosition = .zero
  CTLineDraw(line, ctx)
  ctx.restoreGState()
}

func nearestPoseFrame(
  _ overlay: OverlayData, timestampMs: Int
) -> (t: Int, confidence: Double, joints: [String: (x: Double, y: Double, v: Double)])? {
  guard !overlay.frames.isEmpty else { return nil }
  var best = overlay.frames[0]
  var bestDelta = abs(best.t - timestampMs)
  for frame in overlay.frames {
    let delta = abs(frame.t - timestampMs)
    if delta < bestDelta { best = frame; bestDelta = delta }
  }
  return bestDelta <= 50 ? best : nil
}

func drawAnnotations(
  ctx: CGContext,
  overlay: OverlayData,
  timestampMs: Int,
  width: CGFloat,
  height: CGFloat,
  wristTrail: inout [(x: Double, y: Double)]
) {
  let accent = CGColor(red: 0.75, green: 0.95, blue: 0.3, alpha: 1)
  let bone = CGColor(red: 0.2, green: 0.9, blue: 0.9, alpha: 0.9)
  let ballColor = CGColor(red: 1.0, green: 0.75, blue: 0.1, alpha: 0.95)

  if let frame = nearestPoseFrame(overlay, timestampMs: timestampMs) {
    ctx.setLineWidth(max(2, width / 400))
    ctx.setStrokeColor(bone)
    for (from, to) in skeletonEdges {
      guard let a = frame.joints[from], let b = frame.joints[to], a.v >= 0.2, b.v >= 0.2 else { continue }
      ctx.move(to: CGPoint(x: a.x * width, y: a.y * height))
      ctx.addLine(to: CGPoint(x: b.x * width, y: b.y * height))
      ctx.strokePath()
    }
    for (_, joint) in frame.joints where joint.v >= 0.2 {
      let radius = max(3, width / 250)
      ctx.setFillColor(joint.v >= 0.5 ? accent : CGColor(red: 1, green: 0.6, blue: 0.2, alpha: 0.9))
      ctx.fillEllipse(in: CGRect(
        x: joint.x * width - radius, y: joint.y * height - radius,
        width: radius * 2, height: radius * 2
      ))
    }
    // Wrist trail (dominant = higher-motion wrist handled upstream; draw both).
    for wristName in ["right_wrist", "left_wrist"] {
      if let wrist = frame.joints[wristName], wrist.v >= 0.2, wristName == "right_wrist" {
        wristTrail.append((wrist.x, wrist.y))
        if wristTrail.count > 24 { wristTrail.removeFirst(wristTrail.count - 24) }
      }
    }
    ctx.setStrokeColor(CGColor(red: 0.75, green: 0.95, blue: 0.3, alpha: 0.55))
    ctx.setLineWidth(max(1.5, width / 600))
    for (index, point) in wristTrail.enumerated() where index > 0 {
      ctx.move(to: CGPoint(x: wristTrail[index - 1].x * width, y: wristTrail[index - 1].y * height))
      ctx.addLine(to: CGPoint(x: point.x * width, y: point.y * height))
      ctx.strokePath()
    }
  }

  // Paddle track: box + center + confidence + trail. Misses are visually
  // obvious — the trail freezes and a hollow "lost" marker appears at the
  // last known center while inside the stroke window.
  if !overlay.paddleObservations.isEmpty {
    let paddleColor = CGColor(red: 1.0, green: 0.3, blue: 0.9, alpha: 0.95)
    let trail = overlay.paddleObservations
      .filter { $0.t <= timestampMs && $0.t >= timestampMs - 700 }
    ctx.setStrokeColor(CGColor(red: 1.0, green: 0.3, blue: 0.9, alpha: 0.5))
    ctx.setLineWidth(max(1.5, width / 640))
    for (index, observation) in trail.enumerated() where index > 0 {
      let previous = trail[index - 1]
      if observation.t - previous.t > 200 { continue } // gaps stay visible
      ctx.move(to: CGPoint(x: (previous.x + previous.w / 2) * width, y: (previous.y + previous.h / 2) * height))
      ctx.addLine(to: CGPoint(x: (observation.x + observation.w / 2) * width, y: (observation.y + observation.h / 2) * height))
      ctx.strokePath()
    }
    if let current = overlay.paddleObservations.min(by: { abs($0.t - timestampMs) < abs($1.t - timestampMs) }),
       abs(current.t - timestampMs) <= 40 {
      let rect = CGRect(x: current.x * width, y: current.y * height,
                        width: current.w * width, height: current.h * height)
      let alpha = current.conf >= 0.4 ? 1.0 : 0.45
      ctx.setStrokeColor(CGColor(red: 1.0, green: 0.3, blue: 0.9, alpha: alpha))
      ctx.setLineWidth(max(2.5, width / 380))
      ctx.stroke(rect)
      ctx.setFillColor(paddleColor)
      let dot = max(3, width / 300)
      ctx.fillEllipse(in: CGRect(x: rect.midX - dot / 2, y: rect.midY - dot / 2, width: dot, height: dot))
      drawLabel(
        ctx,
        "P\(overlay.paddleTrackId ?? 0) \(String(format: "%.2f", current.conf))",
        at: CGPoint(x: rect.minX, y: rect.minY - max(14, height / 60)),
        size: max(11, height / 60),
        color: paddleColor
      )
    } else if let windowStart = overlay.windowStartMs, let windowEnd = overlay.windowEndMs,
              timestampMs >= windowStart, timestampMs <= windowEnd,
              let last = overlay.paddleObservations.last(where: { $0.t <= timestampMs }) {
      // In-window miss: hollow gray marker at last known center.
      let cx = (last.x + last.w / 2) * width
      let cy = (last.y + last.h / 2) * height
      let radius = max(7, width / 140)
      ctx.setStrokeColor(CGColor(gray: 0.75, alpha: 0.85))
      ctx.setLineWidth(max(1.5, width / 640))
      ctx.strokeEllipse(in: CGRect(x: cx - radius, y: cy - radius, width: radius * 2, height: radius * 2))
      ctx.move(to: CGPoint(x: cx - radius, y: cy - radius))
      ctx.addLine(to: CGPoint(x: cx + radius, y: cy + radius))
      ctx.strokePath()
      drawLabel(ctx, "paddle lost", at: CGPoint(x: cx + radius + 3, y: cy - radius),
                size: max(10, height / 70), color: CGColor(gray: 0.85, alpha: 0.9))
    }
  }

  // Apple-trajectory CANDIDATES (ungated) draw hollow — visibly weaker than
  // the measured ball track below.
  for point in overlay.ballPoints where abs(point.t - timestampMs) <= 40 {
    let radius = max(4, width / 220)
    ctx.setStrokeColor(ballColor)
    ctx.setLineWidth(max(2, width / 500))
    ctx.strokeEllipse(in: CGRect(
      x: point.x * width - radius, y: point.y * height - radius,
      width: radius * 2, height: radius * 2
    ))
  }

  // PLAYER IDENTITY: every candidate player carries an ID; the target is
  // highlighted so identity failures are visible at a glance.
  for track in overlay.playerTracks {
    guard let nearest = track.points.min(by: { abs($0.t - timestampMs) < abs($1.t - timestampMs) }),
          abs(nearest.t - timestampMs) <= 200 else { continue }
    let isTarget = track.id == overlay.targetPlayerId
    let color = isTarget
      ? CGColor(red: 0.3, green: 0.95, blue: 0.5, alpha: 0.95)
      : CGColor(gray: 0.8, alpha: 0.75)
    drawLabel(
      ctx,
      isTarget ? "P\(track.id) TARGET" : "P\(track.id)",
      at: CGPoint(x: nearest.x * width - 14, y: nearest.y * height - max(20, height / 45)),
      size: max(11, height / 62),
      color: color
    )
  }

  // Ball occlusion bridge: PREDICTED positions drawn hollow — visually
  // distinct from observed (filled) so predictions can never read as
  // measurements.
  if !overlay.ballBridge.isEmpty {
    ctx.setStrokeColor(CGColor(red: 1.0, green: 0.85, blue: 0.1, alpha: 0.5))
    ctx.setLineWidth(max(1, width / 900))
    for point in overlay.ballBridge where point.t <= timestampMs && point.t >= timestampMs - 600 {
      let radius = max(3, width / 320)
      ctx.strokeEllipse(in: CGRect(
        x: point.x * width - radius, y: point.y * height - radius,
        width: radius * 2, height: radius * 2
      ))
    }
  }

  // MEASURED ball track: filled yellow dots + trail; every drawn point is an
  // observation that survived association + physics + context gates. Gaps in
  // the trail are real gaps — nothing is interpolated.
  if !overlay.ballObservations.isEmpty {
    let trail = overlay.ballObservations.filter { $0.t <= timestampMs && $0.t >= timestampMs - 600 }
    ctx.setStrokeColor(CGColor(red: 1.0, green: 0.85, blue: 0.1, alpha: 0.6))
    ctx.setLineWidth(max(1.5, width / 640))
    for (index, observation) in trail.enumerated() where index > 0 {
      let previous = trail[index - 1]
      if observation.t - previous.t > 140 { continue } // gaps stay visible
      ctx.move(to: CGPoint(x: previous.x * width, y: previous.y * height))
      ctx.addLine(to: CGPoint(x: observation.x * width, y: observation.y * height))
      ctx.strokePath()
    }
    if let current = overlay.ballObservations.min(by: { abs($0.t - timestampMs) < abs($1.t - timestampMs) }),
       abs(current.t - timestampMs) <= 40 {
      let radius = max(5, width / 190)
      ctx.setFillColor(CGColor(red: 1.0, green: 0.85, blue: 0.1, alpha: current.conf >= 0.4 ? 0.95 : 0.5))
      ctx.fillEllipse(in: CGRect(
        x: current.x * width - radius, y: current.y * height - radius,
        width: radius * 2, height: radius * 2
      ))
      let state = overlay.ballStates.first(where: { timestampMs >= $0.fromMs && timestampMs <= $0.toMs })?.state
      drawLabel(
        ctx,
        "B\(overlay.ballTrackId ?? 0) \(String(format: "%.2f", current.conf))\(state.map { " \($0)" } ?? "")",
        at: CGPoint(x: current.x * width + radius + 2, y: current.y * height - radius),
        size: max(10, height / 70),
        color: state == "REACQUIRED"
          ? CGColor(red: 0.4, green: 1.0, blue: 0.6, alpha: 0.95)
          : CGColor(red: 1.0, green: 0.85, blue: 0.1, alpha: 0.95)
      )
    } else if let state = overlay.ballStates.first(where: { timestampMs >= $0.fromMs && timestampMs <= $0.toMs }),
              state.state == "OCCLUDED" || state.state == "LOST" {
      drawLabel(
        ctx,
        "ball: \(state.state)",
        at: CGPoint(x: 12, y: max(30, height / 24) + 3 * max(16, height / 50)),
        size: max(11, height / 62),
        color: CGColor(gray: 0.85, alpha: 0.9)
      )
    }
  }

  // Phase + contact status text (top-left, under the quality chip).
  if let phase = overlay.phases.first(where: { timestampMs >= $0.startMs && timestampMs <= $0.endMs }) {
    drawLabel(
      ctx, "phase: \(phase.name)",
      at: CGPoint(x: 12, y: max(30, height / 24)),
      size: max(12, height / 55), color: CGColor(gray: 0.95, alpha: 0.95)
    )
  }
  if let contact = overlay.contactInfo {
    let tags = [
      contact.ballConfirmed ? "ball" : nil,
      contact.paddleConfirmed ? "paddle" : nil,
    ].compactMap { $0 }
    let suffix = tags.isEmpty ? "motion-only" : tags.joined(separator: "+")
    drawLabel(
      ctx,
      "contact \(contact.tMs)ms · conf \(String(format: "%.2f", contact.confidence)) · \(suffix)",
      at: CGPoint(x: 12, y: max(30, height / 24) + max(16, height / 50)),
      size: max(11, height / 62),
      color: abs(timestampMs - contact.tMs) <= 60
        ? CGColor(red: 1, green: 0.25, blue: 0.35, alpha: 1)
        : CGColor(gray: 0.8, alpha: 0.9)
    )
  }
  if let stroke = overlay.strokeLabel {
    let conf = overlay.strokeConfidence ?? 0
    let depth = overlay.strokeDepth ?? 0
    drawLabel(
      ctx,
      "stroke: \(stroke) \(Int(conf * 100))% (depth \(depth)/3, heuristic)",
      at: CGPoint(x: 12, y: max(30, height / 24) + 2 * max(16, height / 50)),
      size: max(11, height / 62),
      color: CGColor(red: 0.75, green: 0.95, blue: 0.3, alpha: 0.95)
    )
  }

  // Timeline band: stroke window, contact, phases.
  let barY = height - max(24, height / 30)
  let barHeight = max(10, height / 80)
  guard let firstT = overlay.frames.first?.t, let lastT = overlay.frames.last?.t, lastT > firstT else { return }
  let toX = { (t: Int) -> CGFloat in CGFloat(t - firstT) / CGFloat(lastT - firstT) * width }
  ctx.setFillColor(CGColor(gray: 0, alpha: 0.45))
  ctx.fill(CGRect(x: 0, y: barY, width: width, height: barHeight))
  let phaseColors: [String: CGColor] = [
    "preparation": CGColor(red: 0.35, green: 0.55, blue: 0.95, alpha: 0.85),
    "backswing": CGColor(red: 0.55, green: 0.4, blue: 0.95, alpha: 0.85),
    "acceleration": CGColor(red: 0.95, green: 0.55, blue: 0.25, alpha: 0.9),
    "contact_zone": CGColor(red: 0.95, green: 0.25, blue: 0.35, alpha: 0.95),
    "follow_through": CGColor(red: 0.3, green: 0.85, blue: 0.5, alpha: 0.85),
    "recovery": CGColor(red: 0.4, green: 0.75, blue: 0.75, alpha: 0.8),
  ]
  for phase in overlay.phases {
    ctx.setFillColor(phaseColors[phase.name] ?? CGColor(gray: 0.7, alpha: 0.8))
    ctx.fill(CGRect(x: toX(phase.startMs), y: barY, width: toX(phase.endMs) - toX(phase.startMs), height: barHeight))
  }
  if let start = overlay.windowStartMs, let end = overlay.windowEndMs {
    ctx.setStrokeColor(accent)
    ctx.setLineWidth(2)
    ctx.stroke(CGRect(x: toX(start), y: barY - 2, width: toX(end) - toX(start), height: barHeight + 4))
  }
  if let contact = overlay.contactMs {
    ctx.setStrokeColor(CGColor(red: 1, green: 0.2, blue: 0.3, alpha: 1))
    ctx.setLineWidth(max(2, width / 500))
    ctx.move(to: CGPoint(x: toX(contact), y: barY - max(8, height / 90)))
    ctx.addLine(to: CGPoint(x: toX(contact), y: barY + barHeight + max(8, height / 90)))
    ctx.strokePath()
  }
  // STROKE EVENT windows: labeled boxes above the timeline; the target event
  // is highlighted so multi-swing separation is visually checkable.
  if !overlay.strokeEvents.isEmpty {
    let eventY = barY - max(26, height / 34)
    let eventHeight = max(8, barHeight * 0.8)
    for event in overlay.strokeEvents {
      let isTarget = event.id == overlay.targetEventId
      let color = isTarget
        ? CGColor(red: 1.0, green: 0.55, blue: 0.1, alpha: 0.95)
        : CGColor(gray: 0.75, alpha: 0.7)
      ctx.setStrokeColor(color)
      ctx.setLineWidth(isTarget ? 2.5 : 1.2)
      ctx.stroke(CGRect(
        x: toX(event.startMs), y: eventY,
        width: max(2, toX(event.endMs) - toX(event.startMs)), height: eventHeight
      ))
      drawLabel(
        ctx,
        isTarget ? "\(event.id)*" : event.id,
        at: CGPoint(x: toX(event.startMs), y: eventY - max(13, height / 68)),
        size: max(10, height / 72),
        color: color
      )
    }
  }
  if let targetEvent = overlay.targetEventId {
    drawLabel(
      ctx,
      "target event: \(targetEvent)",
      at: CGPoint(x: 12, y: max(30, height / 24) + 4 * max(16, height / 50)),
      size: max(11, height / 62),
      color: CGColor(red: 1.0, green: 0.55, blue: 0.1, alpha: 0.95)
    )
  }
  // Paddle coverage strip above the phase bar: magenta where tracked, gaps
  // where the paddle was missed — misses are visible at a glance.
  if !overlay.paddleObservations.isEmpty {
    let stripHeight = max(3, barHeight / 3)
    ctx.setFillColor(CGColor(red: 1.0, green: 0.3, blue: 0.9, alpha: 0.9))
    for (index, observation) in overlay.paddleObservations.enumerated() where index > 0 {
      let previous = overlay.paddleObservations[index - 1]
      if observation.t - previous.t > 200 { continue }
      ctx.fill(CGRect(
        x: toX(previous.t), y: barY - stripHeight - 2,
        width: max(1, toX(observation.t) - toX(previous.t)), height: stripHeight
      ))
    }
  }
  // Playhead.
  ctx.setFillColor(CGColor(gray: 1, alpha: 0.95))
  let playheadX = toX(min(max(timestampMs, firstT), lastT))
  ctx.fill(CGRect(x: playheadX - 1.5, y: barY - 4, width: 3, height: barHeight + 8))

  // Status text (quality + score), drawn with Core Text-free simple boxes:
  // colored chip conveys analyzability; text rendering kept minimal.
  if let analyzable = overlay.analyzable {
    let chip = CGRect(x: 12, y: 12, width: max(16, width / 60), height: max(16, width / 60))
    ctx.setFillColor(analyzable
      ? CGColor(red: 0.3, green: 0.85, blue: 0.4, alpha: 0.95)
      : CGColor(red: 0.95, green: 0.3, blue: 0.3, alpha: 0.95))
    ctx.fillEllipse(in: chip)
  }
}

// MARK: - Dispatch (must be last: see note at top)

guard let command = arguments.first else { usage() }

do {
  switch command {
  case "extract":
    guard arguments.count >= 2, let outDir = flagValue("--out", in: arguments) else { usage() }
    try await runExtract(videoPath: arguments[1], outDir: outDir)
  case "overlay":
    guard arguments.count >= 2,
          let posePath = flagValue("--pose", in: arguments),
          let outPath = flagValue("--out", in: arguments)
    else { usage() }
    try await runOverlay(
      videoPath: arguments[1],
      posePath: posePath,
      analysisPath: flagValue("--analysis", in: arguments),
      outPath: outPath
    )
  case "frame":
    guard arguments.count >= 2,
          let ms = flagValue("--ms", in: arguments).flatMap({ Int($0) }),
          let outPath = flagValue("--out", in: arguments)
    else { usage() }
    try await runFrame(videoPath: arguments[1], ms: ms, outPath: outPath)
  default:
    usage()
  }
} catch {
  FileHandle.standardError.write(Data("swing-lab error: \(error)\n".utf8))
  exit(1)
}
